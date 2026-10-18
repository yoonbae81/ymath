/** Standalone Node poller. TEST-ONLY fixtures can only target loopback Wrangler. */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { processImage } from '../image';
import { validAnalysis } from '../analysis.fixture';
import type { ItemRecord, Provider, ReportRecord } from '$lib/types';
import { retryAfterSeconds, runPollerCycle } from './runner-poller';

const args = new Set(process.argv.slice(2));
const base = (process.env.RUNNER_URL ?? 'http://127.0.0.1:8791/math').replace(/\/$/, '');
const token = process.env.RUNNER_TOKEN;
const fixtureMode = args.has('--fixture-only');
const pollConcurrency = Math.max(1, Math.min(8, Number(process.env.RUNNER_POLL_CONCURRENCY ?? 4) || 4));
const host = new URL(base).hostname;
if (!token) throw new Error('RUNNER_TOKEN is required');
if (!process.env.RUNNER_WORK_DIR) throw new Error('RUNNER_WORK_DIR must point to an isolated writable directory');
if (fixtureMode && (!args.has('--once') || process.env.RUNNER_ALLOW_TEST_FIXTURES !== '1' || !['localhost', '127.0.0.1', '::1'].includes(host))) {
	throw new Error('TEST-ONLY fixture mode requires --once, RUNNER_ALLOW_TEST_FIXTURES=1, and a loopback RUNNER_URL');
}

const headers = { authorization: `Bearer ${token}` };
async function runReport(job: { id: string; entity_id: string; kind: 'report'; generation: number; entity_generation: number; lease_token: string; payload: string; provider?: string; report: ReportRecord | null; records: ItemRecord[] }) {
	if (!job.report) throw new Error('claimed report snapshot is missing');
	let busy = false;
	const heartbeat = setInterval(async () => {
		if (busy) return;
		busy = true;
		try {
			const response = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/heartbeat`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-lease-token': job.lease_token }, body: JSON.stringify({ job }) });
			if (!response.ok) console.error(`[runner] report heartbeat rejected: ${response.status}`);
		} catch (e) { console.error(`[runner] report heartbeat failed: ${e instanceof Error ? e.message : String(e)}`); }
		finally { busy = false; }
	}, 30_000);
	try {
		const { generateReportFromSnapshot } = await import('./report-runner');
		const fixture = fixtureMode ? {
			testOnly: true as const,
			guideline: '# TEST-ONLY fixture report',
			concepts: {},
			publishers: [],
			runner: async (_prompt: string, _provider: Provider) => ({ text: `# TEST-ONLY fixture report\n\n## ${job.report!.topic}\n\nTEST-ONLY local report fixture.`, model: 'TEST-ONLY fixture' })
		} : undefined;
		const report = await generateReportFromSnapshot({ report: job.report, records: job.records, provider: job.provider as Provider | undefined }, fixture);
		const response = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/result`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', origin: new URL(base).origin, 'x-lease-token': job.lease_token }, body: JSON.stringify({ job, report }) });
		if (!response.ok) throw new Error(`report result commit failed: ${response.status} ${await response.text()}`);
		console.log(JSON.stringify({ job: job.id, status: 'done', report: report.id, analysis_mode: fixtureMode ? 'TEST-ONLY fixture' : 'configured provider' }));
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/fail`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-lease-token': job.lease_token }, body: JSON.stringify({ job, message, retry_after: retryAfterSeconds(message) }) }).catch(() => undefined);
		throw e;
	} finally { clearInterval(heartbeat); }
}

async function runOnce() {
	const claimed = await fetch(`${base}/api/runner/claim`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ runner: `node-${process.pid}` }) });
	if (!claimed.ok) throw new Error(`claim failed: ${claimed.status}`);
	const { job } = await claimed.json() as { job: null | { id: string; entity_id: string; kind: 'item' | 'report'; generation: number; entity_generation: number; lease_token: string; payload: string; provider?: string; entity: ItemRecord | null; normalizedImage?: boolean; ocrText?: string | null; report?: ReportRecord | null; records?: ItemRecord[] } };
	if (!job) return false;
	if (job.kind === 'report') { await runReport({ ...job, kind: 'report', report: job.report ?? null, records: job.records ?? [] }); return true; }
	if (!job.entity) throw new Error('claimed item snapshot is missing');
	const dir = resolve(process.env.RUNNER_WORK_DIR!, job.id);
	await mkdir(dir, { recursive: true });
	let heartbeatBusy = false;
	const heartbeat = setInterval(async () => {
		if (heartbeatBusy) return;
		heartbeatBusy = true;
		try {
			const response = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/heartbeat`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-lease-token': job.lease_token }, body: JSON.stringify({ job }) });
			if (!response.ok) console.error(`[runner] heartbeat rejected: ${response.status}`);
		} catch (e) { console.error(`[runner] heartbeat failed: ${e instanceof Error ? e.message : String(e)}`); }
		finally { heartbeatBusy = false; }
	}, 30_000);
	const setStage = async (stage: 'ocr' | 'analyzing') => {
		const response = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/stage`, {
			method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-lease-token': job.lease_token }, body: JSON.stringify({ job, stage })
		});
		if (!response.ok) throw new Error(`stage update failed: ${response.status}`);
	};
	try {
		const rawResponse = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/raw`, { headers: { ...headers, 'x-lease-token': job.lease_token } });
		if (!rawResponse.ok) throw new Error(`raw download failed: ${rawResponse.status}`);
		const raw = Buffer.from(await rawResponse.arrayBuffer());
		const jpeg = job.normalizedImage ? raw : await processImage(raw);
		const imagePath = join(dir, 'image.jpg');
		await writeFile(imagePath, jpeg);
		const metadata = await sharp(jpeg).metadata();
		const pixels = await sharp(jpeg).raw().toBuffer({ resolveWithObject: true });
		let grayscale = pixels.info.channels >= 3;
		for (let i = 0; grayscale && i < pixels.data.length; i += pixels.info.channels) grayscale = pixels.data[i] === pixels.data[i + 1] && pixels.data[i + 1] === pixels.data[i + 2];
		if (!metadata.width || !metadata.height || Math.max(metadata.width, metadata.height) > 1600 || !grayscale) throw new Error('normalization policy check failed');
		if (!job.normalizedImage) {
			const form = new FormData();
			form.set('job', JSON.stringify(job));
			form.set('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'image.jpg');
			const persisted = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/normalized`, { method: 'POST', headers: { ...headers, origin: new URL(base).origin, 'x-lease-token': job.lease_token }, body: form });
			if (!persisted.ok) throw new Error(`normalized image persistence failed: ${persisted.status} ${await persisted.text()}`);
		}
		if (fixtureMode && process.env.RUNNER_TEST_FAIL_AFTER_NORMALIZE === '1') throw new Error('TEST-ONLY injected failure after normalized image persistence');
		let analysis: unknown;
		let meta: { provider: string; model: string; prompt_version: string; analyzed_at: string };
		let flags: ItemRecord['flags'];
		let ocrText = job.ocrText ?? '';
		if (fixtureMode) {
			await setStage('analyzing');
			if (!ocrText.trim()) ocrText = 'TEST-ONLY fixture OCR text';
			analysis = validAnalysis();
			const analyzeModule = await import('../analyze');
			const schema: object = JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../analysis.schema.json', import.meta.url), 'utf8'));
			const validate: (schema: object, value: unknown) => void = analyzeModule.validateAnalysis;
			validate(schema, analysis);
			const { checkGuardrail } = await import('../guardrail');
			const guard = checkGuardrail(analysis as never);
			if (guard.violations.length) throw new Error(`fixture guardrail failed: ${guard.violations.join(', ')}`);
			meta = { provider: 'test-only', model: 'TEST-ONLY fixture analysis', prompt_version: 'TEST-ONLY', analyzed_at: new Date().toISOString() };
			flags = { ocr_missing: !ocrText.trim(), taxonomy_mismatch: [], guardrail: guard.warnings };
			const form = new FormData();
			form.set('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'image.jpg');
			form.set('ocr_text', ocrText);
			form.set('ocr_mode', 'TEST-ONLY fixture');
			form.set('result', JSON.stringify({ job, analysis, meta, flags }));
			const committed = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/result`, { method: 'POST', headers: { ...headers, origin: new URL(base).origin, 'x-lease-token': job.lease_token }, body: form });
			if (!committed.ok) throw new Error(`result commit failed: ${committed.status} ${await committed.text()}`);
			console.log(JSON.stringify({ job: job.id, status: 'done', analysis_mode: 'TEST-ONLY fixture', ocr_mode: 'TEST-ONLY fixture' }));
			return true;
		} else {
			await setStage('ocr');
			if (!ocrText.trim()) {
				const { runOcr } = await import('../ocr');
				ocrText = await runOcr(dir).catch(() => '');
			}
			await setStage('analyzing');
			const { analyzeItem } = await import('../analyze');
			const result = await analyzeItem({ record: job.entity, dir, ocrText, feedback: job.entity.feedback?.find((f) => f.analyzed_at === job.entity?.meta?.analyzed_at), knownPatterns: (job as typeof job & { knownPatterns?: { id: string; count: number; example: string }[] }).knownPatterns });
			analysis = result.analysis;
			meta = { provider: result.provider, model: result.model, prompt_version: result.promptVersion, analyzed_at: new Date().toISOString() };
			flags = { ocr_missing: !ocrText.trim(), taxonomy_mismatch: result.taxonomyIssues, guardrail: result.guardrailWarnings };
		}
		const form = new FormData();
		form.set('image', new Blob([new Uint8Array(jpeg)], { type: 'image/jpeg' }), 'image.jpg');
		form.set('ocr_text', ocrText);
		form.set('result', JSON.stringify({ job, analysis, meta, flags }));
		const committed = await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/result`, {
			method: 'POST', headers: { ...headers, origin: new URL(base).origin, 'x-lease-token': job.lease_token }, body: form
		});
		if (!committed.ok) throw new Error(`result commit failed: ${committed.status} ${await committed.text()}`);
		console.log(JSON.stringify({ job: job.id, status: 'done', normalization: { width: metadata.width, height: metadata.height, space: metadata.space }, analysis_mode: fixtureMode ? 'TEST-ONLY fixture' : 'configured provider' }));
		return true;
	} catch (e) {
		const message = e instanceof Error ? e.message : String(e);
		const retryAfter = retryAfterSeconds(message);
		await fetch(`${base}/api/runner/jobs/${encodeURIComponent(job.id)}/fail`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-lease-token': job.lease_token }, body: JSON.stringify({ job, message, retry_after: retryAfter }) }).catch(() => undefined);
		throw e;
	} finally {
		clearInterval(heartbeat);
		await rm(dir, { recursive: true, force: true });
	}
}

if (args.has('--once')) await runOnce();
else {
	const delay = Number(process.env.RUNNER_POLL_MS ?? 5000);
	while (true) {
		const results = await runPollerCycle(pollConcurrency, async () => {
			try { return await runOnce(); }
			catch (e) { console.error(`[runner] ${e instanceof Error ? e.message : String(e)}`); return true; }
		});
		if (results.every((claimed) => !claimed)) await new Promise((resolveWait) => setTimeout(resolveWait, delay));
	}
}
