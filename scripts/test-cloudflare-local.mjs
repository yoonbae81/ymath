import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { getPlatformProxy } from 'wrangler';

const scratch = '/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical';
if (!scratch.startsWith('/Users/y/.hermes/profiles/plan/cache/scratch/')) throw new Error('scratch must remain in the isolated scratch root');
await mkdir(scratch, { recursive: true });
const logPath = resolve(scratch, 'wrangler-e2e.log');
const statePath = resolve(scratch, `wrangler-state-${process.pid}`);
const base = 'http://127.0.0.1:8879/math';
const token = `local-test-${crypto.randomUUID()}`;
const workbook = { id: 'local-fixture', name: 'Local fixture', publisher: 'Fixture', grade: 'Grade 1', semester: 1 };
const env = { ...process.env, RUNNER_TOKEN: token, TEST_ONLY_FIXTURES: '1', WORKBOOKS_JSON: JSON.stringify({ workbooks: [workbook] }) };
const log = await import('node:fs/promises').then((fs) => fs.open(logPath, 'w'));
const migration = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'ymath', '--local', '--persist-to', statePath], { cwd: process.cwd(), env, encoding: 'utf8' });
await log.write(migration.stdout ?? ''); await log.write(migration.stderr ?? '');
if (migration.status !== 0) throw new Error(`Wrangler local migration failed; see ${logPath}`);
const server = spawn('npx', ['wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', '8879', '--persist-to', statePath, '--var', `RUNNER_TOKEN:${token}`, '--var', 'TEST_ONLY_FIXTURES:1', '--var', `WORKBOOKS_JSON:${JSON.stringify({ workbooks: [workbook] })}`], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', (chunk) => log.write(chunk));
server.stderr.on('data', (chunk) => log.write(chunk));

async function waitForServer() {
	const end = Date.now() + 90_000;
	while (Date.now() < end) {
		try { const response = await fetch(`${base}/api/items`); if (response.ok) return; } catch { /* wait for Wrangler local startup */ }
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(`Wrangler did not start; see ${logPath}`);
}

async function request(path, init) {
	const response = await fetch(`${base}${path}`, init);
	const text = await response.text();
	if (!response.ok) throw new Error(`${init?.method ?? 'GET'} ${path}: ${response.status} ${text}`);
	return { response, text };
}

async function runLocalRunner(failAfterNormalized = false) {
	const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/lib/server/cloudflare/runner.ts', '--once', '--fixture-only'], {
		cwd: process.cwd(), env: { ...env, RUNNER_URL: base, RUNNER_WORK_DIR: resolve(scratch, 'runner-work'), RUNNER_ALLOW_TEST_FIXTURES: '1', ...(failAfterNormalized ? { RUNNER_TEST_FAIL_AFTER_NORMALIZE: '1' } : {}) }, stdio: ['ignore', 'pipe', 'pipe']
	});
	let output = '';
	child.stdout.on('data', (chunk) => { output += chunk.toString(); });
	child.stderr.on('data', (chunk) => { output += chunk.toString(); });
	return new Promise((resolveExit, reject) => {
		child.on('error', reject);
		child.on('exit', (code) => resolveExit({ code, output }));
	});
}
function localSql(sql) {
	const result = spawnSync('npx', ['wrangler', 'd1', 'execute', 'ymath', '--local', '--persist-to', statePath, '--command', sql, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
	if (result.status !== 0) throw new Error(`Local fixture SQL failed: ${result.stderr}`);
	return JSON.parse(result.stdout);
}
function localRows(sql) {
	const value = localSql(sql);
	return Array.isArray(value) ? value.flatMap((result) => result.results ?? []) : value.results ?? [];
}

try {
	await waitForServer();
	for (const path of ['/items', '/api/items']) await request(path);
	const pageResponse = await fetch(`${base}/login`);
	if (pageResponse.status !== 410) throw new Error(`legacy login returned ${pageResponse.status}, expected 410`);
	const image = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 220, g: 80, b: 30 } } }).png().toBuffer();
	const filePath = resolve(scratch, 'fixture.png');
	await writeFile(filePath, image);
	const key = crypto.randomUUID();
	const headers = { 'content-type': 'image/png', 'x-requested-with': 'ymath', 'idempotency-key': key, origin: new URL(base).origin };
	const first = await request(`/api/upload?workbookId=${workbook.id}`, { method: 'POST', headers, body: image });
	const accepted = JSON.parse(first.text);
	const repeat = await request(`/api/upload?workbookId=${workbook.id}`, { method: 'POST', headers, body: image });
	if (JSON.parse(repeat.text).id !== accepted.id) throw new Error('idempotency retry returned a different entity');
	const initialRunner = await runLocalRunner();
	if (initialRunner.code !== 0) throw new Error(`fixture runner exit ${initialRunner.code}: ${initialRunner.output}`);
	const runnerLog = initialRunner.output;
	const runnerExit = runnerLog.trim().split('\n').at(-1);
	const end = Date.now() + 20_000;
	let item;
	while (Date.now() < end) {
		const detail = await request(`/api/items/${accepted.id}`);
		item = JSON.parse(detail.text);
		if (item?.status === 'done') break;
		await new Promise((r) => setTimeout(r, 250));
	}
	if (item?.status !== 'done') throw new Error(`runner result did not commit: ${JSON.stringify(item)}`);
	const ocrRow = localRows(`SELECT ocr_key FROM entities WHERE id='${accepted.id}'`)[0];
	if (!ocrRow?.ocr_key) throw new Error(`fixture runner did not persist its TEST-ONLY OCR artifact: ${runnerLog}`);
	const readLocalR2 = (key) => spawnSync('npx', ['wrangler', 'r2', 'object', 'get', `ymath-private/${key}`, '--local', '--persist-to', statePath, '--pipe'], { cwd: process.cwd(), env, encoding: 'utf8' });
	const committedOcr = readLocalR2(ocrRow.ocr_key);
	if (committedOcr.status !== 0 || committedOcr.stdout !== 'TEST-ONLY fixture OCR text') throw new Error(`committed OCR artifact missing/wrong in local R2: ${committedOcr.stderr}`);
	const list = JSON.parse((await request('/api/items')).text).items;
	if (!list.some((entry) => entry.id === accepted.id && entry.status === 'done')) throw new Error('committed item missing from list');
	const imageResponse = await fetch(`${base}/api/items/${accepted.id}/image`);
	if (!imageResponse.ok || imageResponse.headers.get('content-type') !== 'image/jpeg') throw new Error(`normalized image unavailable: ${imageResponse.status}`);
	const normalized = Buffer.from(await imageResponse.arrayBuffer());
	const metadata = await sharp(normalized).metadata();
	if (metadata.format !== 'jpeg' || Math.max(metadata.width ?? 0, metadata.height ?? 0) > 1600) throw new Error('normalized JPEG policy check failed');
	const failureRecoveryUpload = JSON.parse(await (await fetch(`${base}/api/upload?workbookId=${workbook.id}`, { method:'POST',headers:{ ...headers,'idempotency-key':crypto.randomUUID() },body:image })).text());
	const rawBeforeNormalize = localRows(`SELECT raw_key FROM entities WHERE id='${failureRecoveryUpload.id}'`)[0]?.raw_key;
	const failedRunner = await runLocalRunner(true);
	if (failedRunner.code === 0 || !failedRunner.output.includes('TEST-ONLY injected failure after normalized image persistence')) throw new Error(`failure-after-normalization fixture did not fail as injected: ${JSON.stringify(failedRunner)}`);
	const preservedResponse = await fetch(`${base}/api/items/${failureRecoveryUpload.id}/image`);
	if (!preservedResponse.ok) throw new Error(`normalized image unavailable after provider failure: ${preservedResponse.status}`);
	const preservedJpeg = Buffer.from(await preservedResponse.arrayBuffer());
	const preservedRefs = localRows(`SELECT image_key,raw_key FROM entities WHERE id='${failureRecoveryUpload.id}'`)[0];
	if (!preservedRefs?.image_key || preservedRefs.raw_key !== null) throw new Error(`normalized image was not committed before failure: ${JSON.stringify(preservedRefs)}`);
	localSql(`UPDATE jobs SET retry_at='2000-01-01T00:00:00.000Z' WHERE entity_id='${failureRecoveryUpload.id}' AND state='queued'`);
	const recoveredRunner = await runLocalRunner();
	if (recoveredRunner.code !== 0) throw new Error(`retry runner failed: ${recoveredRunner.output}`);
	const recoveredItem = JSON.parse((await request(`/api/items/${failureRecoveryUpload.id}`)).text);
	const recoveredImageResponse = await fetch(`${base}/api/items/${failureRecoveryUpload.id}/image`);
	const recoveredJpeg = Buffer.from(await recoveredImageResponse.arrayBuffer());
	if (recoveredItem.status !== 'done' || !preservedJpeg.equals(recoveredJpeg)) throw new Error('retry did not recover using byte-identical persisted JPEG');
	const verifyRawCleanup = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: statePath }, remoteBindings: false, envFiles: [] });
	try { if (rawBeforeNormalize && await verifyRawCleanup.env.OBJECTS.get(rawBeforeNormalize)) throw new Error('raw upload remained after normalized image persistence'); }
	finally { await verifyRawCleanup.dispose(); }
	const reportResponse = await fetch(`${base}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ymath', origin: new URL(base).origin }, body: JSON.stringify({ topic: '대수', period: '2026-10' }) });
	if (reportResponse.status !== 202) throw new Error(`report job acceptance returned ${reportResponse.status}: ${await reportResponse.text()}`);
	const acceptedReport = await reportResponse.json();
	const reportId = acceptedReport.report.id;
	await runLocalRunner();
	let report;
	const reportDeadline = Date.now() + 20_000;
	while (Date.now() < reportDeadline) {
		const detail = await request(`/api/reports/${reportId}`);
		report = JSON.parse(detail.text);
		if (report.status === 'done') break;
		await new Promise((r) => setTimeout(r, 250));
	}
	if (report?.status !== 'done' || !report.markdown?.includes('TEST-ONLY local report fixture')) throw new Error(`report fixture did not commit: ${JSON.stringify(report)}`);
	const listedReports = JSON.parse((await request('/api/reports')).text);
	if (!listedReports.some((entry) => entry.id === reportId && entry.status === 'done')) throw new Error('D1 report list omitted the completed report');
	const statusPage = await fetch(`${base}/status`);
	const areasPage = await fetch(`${base}/areas?id=${reportId}`);
	if (statusPage.status !== 200 || areasPage.status !== 200 || !(await areasPage.text()).includes('TEST-ONLY local report fixture')) throw new Error('report status/archive UI did not hydrate the durable report');
	const reportRows = localRows(`SELECT json_extract(report_json,'$.markdown') AS markdown, report_key FROM entities WHERE id='${reportId}'`);
	if (reportRows.length !== 1 || reportRows[0].markdown !== null || !reportRows[0].report_key?.startsWith(`reports/${reportId}/result-`)) throw new Error(`report artifact/metadata boundary is not correct: ${JSON.stringify(reportRows)}`);
	const cachedResponse = await fetch(`${base}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ymath', origin: new URL(base).origin }, body: JSON.stringify({ topic: '대수', period: '2026-10' }) });
	const cached = await cachedResponse.json();
	if (!cached.cached || cached.report.id !== reportId) throw new Error(`exact-period/fingerprint report cache missed: ${JSON.stringify(cached)}`);
	const retryResponse = await fetch(`${base}/api/reports/${reportId}/retry`, { method: 'POST', headers: { 'x-requested-with': 'ymath', origin: new URL(base).origin } });
	if (retryResponse.status !== 202) throw new Error(`report retry returned ${retryResponse.status}`);
	await runLocalRunner();
	const retriedReport = JSON.parse((await request(`/api/reports/${reportId}`)).text);
	if (retriedReport.status !== 'done' || retriedReport.markdown !== report.markdown) throw new Error('report retry did not preserve/rewrite the report artifact');
	const deleteCompletedReport = await fetch(`${base}/api/reports/${reportId}`, { method: 'DELETE', headers: { 'x-requested-with': 'ymath', origin: new URL(base).origin } });
	if (deleteCompletedReport.status !== 204 || (await fetch(`${base}/api/reports/${reportId}`)).status !== 404) throw new Error('completed report deletion did not tombstone its detail');
	const lateCreate = await fetch(`${base}/api/reports`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ymath', origin: new URL(base).origin }, body: JSON.stringify({ topic: '대수', period: '2026-10', force: true }) });
	if (lateCreate.status !== 202) throw new Error(`forced report acceptance returned ${lateCreate.status}`);
	const lateReport = (await lateCreate.json()).report;
	const claimReportRunner = (runner) => fetch(`${base}/api/runner/claim`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ runner }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
	const staleReportClaim = (await claimReportRunner('report-stale-a')).body.job;
	if (!staleReportClaim || staleReportClaim.kind !== 'report' || staleReportClaim.entity_id !== lateReport.id) throw new Error(`report runner claimed the wrong task: ${JSON.stringify(staleReportClaim)}`);
	const reportFailure = await fetch(`${base}/api/runner/jobs/${staleReportClaim.id}/fail`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-lease-token': staleReportClaim.lease_token }, body: JSON.stringify({ job: staleReportClaim, message: '429 TEST-ONLY report retry', retry_after: 60 }) });
	if (!reportFailure.ok) throw new Error(`report failure scheduling returned ${reportFailure.status}`);
	const queuedReport = JSON.parse((await request(`/api/reports/${lateReport.id}`)).text);
	if (queuedReport.status !== 'queued' || !queuedReport.error?.includes('429')) throw new Error(`report failure state did not persist: ${JSON.stringify(queuedReport)}`);
	localSql(`UPDATE jobs SET retry_at='2000-01-01T00:00:00.000Z' WHERE id='${staleReportClaim.id}'`);
	const retryReportClaim = (await claimReportRunner('report-failure-retry')).body.job;
	if (!retryReportClaim || retryReportClaim.id !== staleReportClaim.id || retryReportClaim.generation !== staleReportClaim.generation + 1) throw new Error('failed report job was not retried with a new generation');
	localSql(`UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id='${retryReportClaim.id}'`);
	const currentReportClaim = (await claimReportRunner('report-stale-b')).body.job;
	if (!currentReportClaim || currentReportClaim.id !== retryReportClaim.id || currentReportClaim.generation !== retryReportClaim.generation + 1) throw new Error('expired report lease was not reclaimed with a new generation');
	const lateResult = async (job) => fetch(`${base}/api/runner/jobs/${job.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-lease-token': job.lease_token, origin: new URL(base).origin }, body: JSON.stringify({ job, report: { ...job.report, status: 'done', markdown: 'TEST-ONLY stale report', meta: { model: 'TEST-ONLY fixture', prompt_version: 'TEST-ONLY', generated_at: new Date().toISOString() } } }) });
	if ((await lateResult(staleReportClaim)).status !== 409) throw new Error('stale report generation committed after lease reclaim');
	if ((await lateResult(retryReportClaim)).status !== 409) throw new Error('stale report retry committed after lease reclaim');
	const reportDeleted = await fetch(`${base}/api/reports/${lateReport.id}`, { method: 'DELETE', headers: { 'x-requested-with': 'ymath', origin: new URL(base).origin } });
	if (reportDeleted.status !== 204) throw new Error(`active report tombstone returned ${reportDeleted.status}`);
	if ((await lateResult(currentReportClaim)).status !== 409) throw new Error('late report result revived a tombstoned report');
	const permanentUpload = await fetch(`${base}/api/upload?workbookId=${workbook.id}`, { method: 'POST', headers: { ...headers, 'idempotency-key': crypto.randomUUID() }, body: image });
	if (!permanentUpload.ok) throw new Error(`permanent-failure upload returned ${permanentUpload.status}`);
	const permanent = await permanentUpload.json();
	const rawKey = localRows(`SELECT raw_key FROM entities WHERE id='${permanent.id}'`)[0]?.raw_key;
	if (!rawKey) throw new Error('permanent-failure fixture did not store a private raw object');
	let permanentJob;
	for (let attempt = 1; attempt <= 5; attempt++) {
		permanentJob = (await claimReportRunner(`permanent-failure-${attempt}`)).body.job;
		if (!permanentJob || permanentJob.entity_id !== permanent.id) throw new Error(`permanent-failure runner claimed unexpected work: ${JSON.stringify(permanentJob)}`);
		const failed = await fetch(`${base}/api/runner/jobs/${permanentJob.id}/fail`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-lease-token': permanentJob.lease_token }, body: JSON.stringify({ job: permanentJob, message: 'TEST-ONLY permanent normalization failure', retry_after: 1 }) });
		if (!failed.ok) throw new Error(`permanent-failure attempt ${attempt} returned ${failed.status}`);
		if (attempt < 5) localSql(`UPDATE jobs SET retry_at='2000-01-01T00:00:00.000Z' WHERE id='${permanentJob.id}'`);
	}
	const failedItem = JSON.parse((await request(`/api/items/${permanent.id}`)).text);
	if (failedItem.status !== 'failed' || failedItem.attempts !== 5 || localRows(`SELECT raw_key FROM entities WHERE id='${permanent.id}'`)[0]?.raw_key !== null) throw new Error(`permanent failure did not clear raw reference: ${JSON.stringify(failedItem)}`);
	const localProxy = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: statePath }, remoteBindings: false, envFiles: [] });
	try { if (await localProxy.env.OBJECTS.get(rawKey)) throw new Error('permanent failure left raw object in local R2'); }
	finally { await localProxy.dispose(); }
	const csfr = await fetch(`${base}/api/upload?workbookId=${workbook.id}`, { method: 'POST', headers: { 'content-type': 'image/png', origin: new URL(base).origin }, body: image });
	if (csfr.status !== 403) throw new Error(`mutation without CSRF header returned ${csfr.status}`);
	const noBearer = await fetch(`${base}/api/runner/claim`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	if (noBearer.status !== 401) throw new Error(`runner without bearer returned ${noBearer.status}`);
	const stale = await fetch(`${base}/api/runner/jobs/not-a-job/raw`, { headers: { authorization: `Bearer ${token}`, 'x-lease-token': 'stale' } });
	if (stale.status !== 404) throw new Error(`stale raw lease returned ${stale.status}`);
	const anonymousFeedback = await fetch(`${base}/api/items/${accepted.id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ymath', origin: new URL(base).origin }, body: JSON.stringify({ choice: 'accurate' }) });
	if (anonymousFeedback.status !== 200) throw new Error(`anonymous feedback access returned ${anonymousFeedback.status}`);
	const secondKey = crypto.randomUUID();
	const thirdKey = crypto.randomUUID();
	const upload = (idempotencyKey) => fetch(`${base}/api/upload?workbookId=${workbook.id}`, { method: 'POST', headers: { ...headers, 'idempotency-key': idempotencyKey }, body: image });
	const queuedA = JSON.parse(await (await upload(secondKey)).text());
	const queuedB = JSON.parse(await (await upload(thirdKey)).text());
	const claim = (runner) => fetch(`${base}/api/runner/claim`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ runner }) }).then(async (r) => ({ status: r.status, body: await r.json() }));
	const race = await Promise.all([claim('race-a'), claim('race-b')]);
	const received = race.map((r) => r.body.job).filter(Boolean);
	if (race.some((r) => r.status !== 200) || received.length !== 1 || race.filter((r) => !r.body.job).length !== 1) throw new Error(`same-provider claim race was not serialized: ${JSON.stringify(race)}`);
	const leased = received[0];
	const queuedFeedback = await fetch(`${base}/api/items/${queuedA.id}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'ymath', origin: new URL(base).origin }, body: JSON.stringify({ choice: 'accurate' }) });
	if (queuedFeedback.status !== 409) throw new Error(`feedback during analysis returned ${queuedFeedback.status}`);
	const fail = (job, message, retryAfter) => fetch(`${base}/api/runner/jobs/${job.id}/fail`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-lease-token': job.lease_token }, body: JSON.stringify({ job, message, retry_after: retryAfter }) });
	const failed429 = await fail(leased, '429 fixture rate limit', 60);
	if (!failed429.ok) throw new Error(`429 retry scheduling returned ${failed429.status}`);
	const other = await claim('other-provider-same-lane');
	if (!other.body.job || other.body.job.id === leased.id) throw new Error('retry delay did not allow the next queued same-provider job');
	if (!(await fail(other.body.job, 'fixture provider failure', 60)).ok) throw new Error('could not persist second retry delay');
	const parallelA = JSON.parse(await (await upload(crypto.randomUUID())).text());
	const parallelB = JSON.parse(await (await upload(crypto.randomUUID())).text());
	localSql(`UPDATE jobs SET provider='zai' WHERE entity_id='${parallelB.id}'`);
	const parallelClaims = await Promise.all([claim('parallel-a'), claim('parallel-b')]);
	if (parallelClaims.some((r) => r.status !== 200 || !r.body.job) || new Set(parallelClaims.map((r) => r.body.job.provider)).size !== 2) throw new Error(`different-provider D1 claims did not proceed concurrently: ${JSON.stringify(parallelClaims)}`);
	for (const result of parallelClaims) if (!(await fail(result.body.job, 'TEST-ONLY parallel claim cleanup', 60)).ok) throw new Error('could not release different-provider test claim');
	if ((await claim('too-early')).body.job !== null) throw new Error('delayed failed jobs were immediately reclaimed');
	const noCsrf = await fetch(`${base}/api/upload?workbookId=${workbook.id}`, { method: 'POST', headers: { 'content-type': 'image/png', origin: new URL(base).origin }, body: image });
	if (noCsrf.status !== 403) throw new Error(`mutation without CSRF header returned ${noCsrf.status}`);
	const claimOne = async () => {
		const result = await claim('scenario-runner');
		if (result.status !== 200 || !result.body.job) throw new Error(`expected an available scenario job, got ${JSON.stringify(result)}`);
		return result.body.job;
	};
	const submitResult = async (job) => {
		const form = new FormData();
		form.set('image', new Blob([new Uint8Array(normalized)], { type: 'image/jpeg' }), 'image.jpg');
		form.set('result', JSON.stringify({ job, analysis: {}, meta: { provider: 'test-only', model: 'fixture', prompt_version: 'fixture', analyzed_at: new Date().toISOString() }, flags: { ocr_missing: true, taxonomy_mismatch: [], guardrail: [] } }));
		return fetch(`${base}/api/runner/jobs/${job.id}/result`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'x-lease-token': job.lease_token, origin: new URL(base).origin }, body: form });
	};
	const recoveryUpload = JSON.parse(await (await upload(crypto.randomUUID())).text());
	const killedLease = await claimOne();
	if (killedLease.entity_id !== recoveryUpload.id) throw new Error('force-kill fixture claimed an unexpected job');
	const expiredSql = spawnSync('npx', ['wrangler', 'd1', 'execute', 'ymath', '--local', '--persist-to', statePath, '--command', `UPDATE jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE id='${killedLease.id}'`], { cwd: process.cwd(), env, encoding: 'utf8' });
	await log.write(expiredSql.stdout ?? ''); await log.write(expiredSql.stderr ?? '');
	if (expiredSql.status !== 0) throw new Error(`could not simulate a force-killed runner lease; see ${logPath}`);
	const staleCommit = await submitResult(killedLease);
	if (staleCommit.status !== 409) throw new Error(`expired runner result returned ${staleCommit.status}: ${await staleCommit.text()}`);
	const reclaimed = await claimOne();
	if (reclaimed.id !== killedLease.id || reclaimed.lease_token === killedLease.lease_token || reclaimed.generation !== killedLease.generation + 1) throw new Error('expired lease was not reclaimed with a new fencing generation');
	const deleted = await fetch(`${base}/api/items/${recoveryUpload.id}`, { method: 'DELETE', headers: { 'x-requested-with': 'ymath', origin: new URL(base).origin } });
	if (deleted.status !== 204) throw new Error(`fixture delete returned ${deleted.status}`);
	if ((await submitResult(reclaimed)).status !== 409) throw new Error('late result after delete was not fenced');
	const duplicateUpload = JSON.parse(await (await upload(crypto.randomUUID())).text());
	const duplicateJob = await claimOne();
	if (duplicateJob.entity_id !== duplicateUpload.id) throw new Error('duplicate-result fixture claimed an unexpected job');
	if (!(await submitResult(duplicateJob)).ok) throw new Error('first runner result did not commit');
	if ((await submitResult(duplicateJob)).status !== 409) throw new Error('duplicate runner result was not rejected');
	localSql(`INSERT INTO analyses(entity_id,provider,generation,analysis_key,meta_json,flags_json,created_at) VALUES('${duplicateUpload.id}','missing-fixture',1,'items/missing-analysis-fixture.json','{}','{}','2026-10-17T23:59:00.000Z')`);
	if ((await fetch(`${base}/api/items/${duplicateUpload.id}/analyses`)).status !== 503) throw new Error('missing referenced analysis object did not return storage 503');
	localSql(`DELETE FROM analyses WHERE entity_id='${duplicateUpload.id}' AND provider='missing-fixture'`);
	const corruptAnalysisKey = `items/${duplicateUpload.id}/corrupt-analysis-fixture.json`;
	const corruptObjects = await getPlatformProxy({ configPath:'wrangler.toml',persist:{path:statePath},remoteBindings:false,envFiles:[] });
	try { await corruptObjects.env.OBJECTS.put(corruptAnalysisKey,new TextEncoder().encode('not-json')); }
	finally { await corruptObjects.dispose(); }
	localSql(`INSERT INTO analyses(entity_id,provider,generation,analysis_key,meta_json,flags_json,created_at) VALUES('${duplicateUpload.id}','corrupt-fixture',1,'${corruptAnalysisKey}','{}','{}','2026-10-17T23:59:01.000Z')`);
	if ((await fetch(`${base}/api/items/${duplicateUpload.id}/analyses`)).status !== 503) throw new Error('corrupt referenced analysis object did not return storage 503');
	localSql(`UPDATE entities SET status='queued' WHERE id='${accepted.id}'`);
	localSql(`UPDATE jobs SET state='queued',retry_at=NULL WHERE entity_id='${accepted.id}'`);
	const cachedClaimResponse = await fetch(`${base}/api/runner/claim`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ runner: 'ocr-cache-reanalysis' }) });
	const cachedClaimValue = await cachedClaimResponse.json();
	if (cachedClaimValue.job?.entity_id !== accepted.id || cachedClaimValue.job?.ocrText !== 'TEST-ONLY fixture OCR text') throw new Error(`reanalysis claim missed cached OCR text: ${JSON.stringify(cachedClaimValue.job)}`);
	const removeCached = await fetch(`${base}/api/items/${accepted.id}`, { method: 'DELETE', headers: { 'x-requested-with': 'ymath', origin: new URL(base).origin } });
	if (removeCached.status !== 204) throw new Error(`OCR deletion fixture returned ${removeCached.status}`);
	if (readLocalR2(ocrRow.ocr_key).status === 0) throw new Error('item deletion left OCR object in local R2');
	const missingReportId = '20261017-235950-rep-f001';
	const badReport = { schema_version:1,id:missingReportId,created_at:new Date().toISOString(),topic:'TEST-ONLY',period:'',period_label:'TEST-ONLY',status:'done',error:null,attempts:1,item_ids:[],items_fingerprint:'fixture',summary:null,markdown:null,meta:null };
	localSql(`INSERT INTO entities(id,kind,created_at,status,generation,report_json,report_key,updated_at) VALUES('${missingReportId}','report','2026-10-17T23:59:50.000Z','done',1,'${JSON.stringify(badReport)}','reports/${missingReportId}/missing.json','2026-10-17T23:59:50.000Z')`);
	if ((await fetch(`${base}/api/reports/${missingReportId}`)).status !== 503 || (await fetch(`${base}/api/reports`)).status !== 503) throw new Error('missing completed report artifact did not return explicit storage 503');
	const corruptReportId = '20261017-235951-rep-f002';
	const localObjects = await getPlatformProxy({ configPath:'wrangler.toml',persist:{path:statePath},remoteBindings:false,envFiles:[] });
	try { await localObjects.env.OBJECTS.put(`reports/${corruptReportId}/corrupt.json`,new TextEncoder().encode('not-json')); }
	finally { await localObjects.dispose(); }
	const corruptReport = { ...badReport,id:corruptReportId };
	localSql(`INSERT INTO entities(id,kind,created_at,status,generation,report_json,report_key,updated_at) VALUES('${corruptReportId}','report','2026-10-17T23:59:51.000Z','done',1,'${JSON.stringify(corruptReport)}','reports/${corruptReportId}/corrupt.json','2026-10-17T23:59:51.000Z')`);
	if ((await fetch(`${base}/api/reports/${corruptReportId}`)).status !== 503) throw new Error('corrupt completed report artifact did not return explicit storage 503');
	const expiredReportId = '20261017-235952-rep-f003';
	const expiredMetadata = { ...badReport,id:expiredReportId,status:'generating',attempts:5 };
	localSql(`INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES('${expiredReportId}','report','2026-10-17T23:59:52.000Z','generating',1,'${JSON.stringify(expiredMetadata)}','2026-10-17T23:59:52.000Z')`);
	localSql(`INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,generation,attempts,lease_until,created_at,updated_at) VALUES('expired-fifth-report','${expiredReportId}','report',1,'leased','omlx','{}',5,5,'2000-01-01T00:00:00.000Z','2026-10-17T23:59:52.000Z','2026-10-17T23:59:52.000Z')`);
	await claim('report-expiry-reaper');
	const expiredState = localRows(`SELECT status,report_json FROM entities WHERE id='${expiredReportId}'`)[0];
	if (expiredState.status !== 'failed' || JSON.parse(expiredState.report_json).status !== 'failed') throw new Error(`fifth expired report lease remained stuck: ${JSON.stringify(expiredState)}`);
	console.log(JSON.stringify({ result: 'PASS', item: accepted.id, runner_exit: runnerExit, analysis_mode: 'TEST-ONLY fixture', normalized_failure_retry: 'TEST-ONLY runner failed after normalization; JPEG remained displayable, raw removed, retry recovered with byte-identical JPEG', report_expiry: 'fifth expired local D1 lease marked report and report_json failed', missing_corrupt_report_artifact: 'API list/detail return 503', missing_corrupt_analysis_artifact: 'analysis API returns 503', ocr_artifact: 'TEST-ONLY text persisted in local R2; exact text returned in reanalysis claim; deletion removed object', normalized: { width: metadata.width, height: metadata.height, format: metadata.format }, report_job: 'generated/retried from D1 snapshot with TEST-ONLY fixture', report_artifact: 'private R2, markdown absent from D1 report_json', report_cache: 'exact period/fingerprint hit', report_failure_retry: 'persisted 429 delay and generation', report_delete: 'completed and active reports tombstoned', report_stale_result: 409, report_delete_late_result: 409, permanent_item_failure: 'five attempts, raw D1 reference cleared, R2 raw object deleted', same_provider_claim_race: 'serialized', different_provider_claims: 'two distinct D1 providers leased concurrently', feedback_during_queue: 409, retry_429_delay: 'persisted', expired_lease_reclaim: 'generation fenced', stale_result: 409, delete_late_result: 409, duplicate_result: 409, csrf: 403, runner_without_bearer: 401, wrangler_log: logPath }));
} finally {
	server.kill('SIGTERM');
	await new Promise((r) => setTimeout(r, 1000));
	await log.close();
}
