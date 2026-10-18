import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { getPlatformProxy } from 'wrangler';
import { commitCloudReportResult, commitCloudResult, cloudAnalyses, cloudReport, cloudReports } from '../src/lib/server/cloudflare/runtime.ts';

const scratch = '/Users/y/.hermes/profiles/plan/cache/scratch/ymath-cloudflare-vertical';
await mkdir(scratch, { recursive: true });
const state = resolve(scratch, `storage-reliability-${process.pid}`);
const proxy = await getPlatformProxy({ configPath: 'wrangler.toml', persist: { path: state }, remoteBindings: false, envFiles: [] });
try {
	const original = proxy.env;
	for (const file of (await readdir('migrations')).filter((name) => name.endsWith('.sql')).sort()) {
		const sql = await readFile(resolve('migrations',file),'utf8');
		for (const statement of sql.split(';').map((value) => value.trim()).filter(Boolean)) await original.DB.prepare(statement).run();
	}
	const putKeys = [];
	const objects = {
		async put(key, value, options) { putKeys.push(key); return original.OBJECTS.put(key, value, options); },
		get: (...args) => original.OBJECTS.get(...args), delete: (...args) => original.OBJECTS.delete(...args)
	};
	const base = { ...original, OBJECTS: objects };
	const runAt = new Date(Date.now() + 300_000).toISOString();
	const itemId = '20261017-100001-test';
	const item = { id: itemId, created_at: runAt, status: 'analyzing', workbook: { id: 'fixture', name: 'TEST-ONLY' }, analysis: null, flags: null, meta: null, feedback: [] };
	await original.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,record_json,updated_at) VALUES(?,'item',?,'analyzing',1,?,?)").bind(itemId,runAt,JSON.stringify(item),runAt).run();
	await original.DB.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,generation,attempts,lease_token,lease_until,created_at,updated_at) VALUES('storage-item',?,'item',1,'leased','test-only','{}',1,1,'item-token',? ,?,?)").bind(itemId,runAt,runAt,runAt).run();
	const job = { id: 'storage-item', entity_id: itemId, kind: 'item', generation: 1, entity_generation: 1, lease_token: 'item-token', payload: '{}' };
	const meta = { provider: 'test-only', model: 'TEST-ONLY', prompt_version: 'TEST-ONLY', analyzed_at: runAt };
	const analysis = { fixture: 'TEST-ONLY' };
	const flags = { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] };
	base.DB = { ...original.DB, prepare: original.DB.prepare.bind(original.DB), batch: async () => { throw new Error('TEST-ONLY pre-commit D1 failure'); } };
	const precommitKeysStart = putKeys.length;
	await commitCloudResult(base,job,'item-token',new Uint8Array([0xff,0xd8,0xff,0]),analysis,meta,flags,'TEST-ONLY OCR').then(() => { throw new Error('pre-commit fault unexpectedly succeeded'); }, () => undefined);
	const precommitKeys = putKeys.slice(precommitKeysStart);
	if (!precommitKeys.length || (await Promise.all(precommitKeys.map((key) => objects.get(key)))).some(Boolean)) throw new Error('unreferenced item staging objects were not cleaned after pre-commit failure');
	const itemId2 = '20261017-100005-test';
	const item2 = { ...item,id:itemId2 };
	await original.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,record_json,updated_at) VALUES(?,'item',?,'analyzing',1,?,?)").bind(itemId2,runAt,JSON.stringify(item2),runAt).run();
	await original.DB.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,generation,attempts,lease_token,lease_until,created_at,updated_at) VALUES('storage-item-lost-response',?,'item',1,'leased','test-only','{}',1,1,'item-token-2',?,?,?)").bind(itemId2,runAt,runAt,runAt).run();
	const itemJob2 = { ...job,id:'storage-item-lost-response',entity_id:itemId2,lease_token:'item-token-2' };
	base.DB = { ...original.DB, prepare: original.DB.prepare.bind(original.DB), async batch(statements) { await original.DB.batch(statements); throw new Error('TEST-ONLY lost item D1 response after commit'); } };
	const itemLostStart = putKeys.length;
	await commitCloudResult(base,itemJob2,'item-token-2',new Uint8Array([0xff,0xd8,0xff,1]),analysis,meta,flags,'TEST-ONLY OCR').then(() => { throw new Error('lost item response unexpectedly returned success'); }, (e) => { if (!String(e).includes('lost item D1 response')) throw e; });
	const itemLostKeys = putKeys.slice(itemLostStart);
	if (itemLostKeys.length !== 3 || (await Promise.all(itemLostKeys.map((key) => objects.get(key)))).some((object) => !object)) throw new Error('item commit artifacts were deleted after lost D1 response');
	await original.DB.prepare("INSERT INTO analyses(entity_id,provider,generation,analysis_key,meta_json,flags_json,created_at) VALUES(?,'missing-analysis',1,'items/missing-analysis.json','{}','{}',?)").bind(itemId2,runAt).run();
	await cloudAnalyses(base,itemId2).then(() => { throw new Error('missing referenced analysis artifact was treated as empty success'); },(e) => { if (!String(e).includes('analysis artifact missing')) throw e; });
	await original.DB.prepare("DELETE FROM analyses WHERE entity_id=? AND provider='missing-analysis'").bind(itemId2).run();
	const corruptAnalysisKey = 'items/corrupt-analysis.json';
	await original.OBJECTS.put(corruptAnalysisKey,new TextEncoder().encode('not-json'));
	await original.DB.prepare("INSERT INTO analyses(entity_id,provider,generation,analysis_key,meta_json,flags_json,created_at) VALUES(?,'corrupt-analysis',1,?,'{}','{}',?)").bind(itemId2,corruptAnalysisKey,runAt).run();
	await cloudAnalyses(base,itemId2).then(() => { throw new Error('corrupt referenced analysis artifact was treated as empty success'); },(e) => { if (!String(e).includes('analysis artifact corrupt')) throw e; });

	const reportId = '20261017-100002-rep-abcd';
	const report = { schema_version: 1, id: reportId, created_at: runAt, topic: 'TEST-ONLY', period: '', period_label: 'TEST-ONLY', status: 'done', error: null, attempts: 1, item_ids: [], items_fingerprint: 'fixture', summary: null, markdown: '# TEST-ONLY report', meta: { generated_at: runAt } };
	await original.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES(?,'report',?,'generating',1,?,?)").bind(reportId,runAt,JSON.stringify({ ...report,status:'generating',markdown:null }),runAt).run();
	await original.DB.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,generation,attempts,lease_token,lease_until,created_at,updated_at) VALUES('storage-report',?,'report',1,'leased','test-only','{}',1,1,'report-token',?,?,?)").bind(reportId,runAt,runAt,runAt).run();
	const reportJob = { id:'storage-report',entity_id:reportId,kind:'report',generation:1,entity_generation:1,lease_token:'report-token',payload:'{}' };
	base.DB = { ...original.DB, prepare: original.DB.prepare.bind(original.DB), async batch(statements) { await original.DB.batch(statements); throw new Error('TEST-ONLY lost D1 response after commit'); } };
	const reportKeyStart = putKeys.length;
	await commitCloudReportResult(base,reportJob,'report-token',report).then(() => { throw new Error('lost response unexpectedly returned success'); }, (e) => { if (!String(e).includes('lost D1 response')) throw e; });
	const reportStaged = putKeys.slice(reportKeyStart);
	if (reportStaged.length !== 1 || !(await objects.get(reportStaged[0]))) throw new Error('committed report artifact was deleted after lost D1 response');
	const reportRow = await original.DB.prepare('SELECT report_key FROM entities WHERE id=?').bind(reportId).first();
	if (reportRow?.report_key !== reportStaged[0]) throw new Error('report commit did not retain authoritative D1 reference');

	const badId = '20261017-100003-rep-abce';
	await original.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,report_key,updated_at) VALUES(?,'report',?,'done',1,?,?,?)")
		.bind(badId,runAt,JSON.stringify({ ...report,id:badId }),`reports/${badId}/missing.json`,runAt).run();
	for (const read of [cloudReport(base,badId),cloudReports(base)]) {
		await read.then(() => { throw new Error('missing completed report artifact was treated as empty success'); }, (e) => { if (!String(e).includes('report artifact missing')) throw e; });
	}
	const corruptId = '20261017-100004-rep-abcf';
	const corruptKey = `reports/${corruptId}/corrupt.json`;
	await original.OBJECTS.put(corruptKey,new TextEncoder().encode('not-json'));
	await original.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,report_key,updated_at) VALUES(?,'report',?,'done',1,?,?,?)")
		.bind(corruptId,runAt,JSON.stringify({ ...report,id:corruptId }),corruptKey,runAt).run();
	await cloudReport(base,corruptId).then(() => { throw new Error('corrupt completed report artifact was treated as empty success'); }, (e) => { if (!String(e).includes('report artifact corrupt')) throw e; });
	console.log(JSON.stringify({ result:'PASS', db:'local Wrangler D1', objects:'local Wrangler R2', item_precommit:'staged image/analysis/OCR objects removed after verified no references', item_commit_response_lost:'committed image/analysis/OCR objects retained by authoritative D1 references', report_commit_response_lost:'committed R2 object retained by authoritative D1 reference', completed_report_missing:'explicit storage error from detail and list', completed_report_corrupt:'explicit storage error from detail', referenced_analysis_missing_corrupt:'explicit storage errors' }));
} finally { await proxy.dispose(); }
