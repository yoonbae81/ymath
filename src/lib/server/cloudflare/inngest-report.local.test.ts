import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { validAnalysis } from '../analysis.fixture';
import { POST as createReport } from '../../../routes/api/reports/+server';
import { GET as getReport } from '../../../routes/api/reports/[id]/+server';
import { POST as retryReport } from '../../../routes/api/reports/[id]/retry/+server';
import { DELETE as deleteReport } from '../../../routes/api/reports/[id]/+server';
import { cloudReport, type CloudflareEnv } from './runtime';
import { claimInngestReport } from './inngest-report-store';
import { makeSliceApp } from '../inngest-slice/app';

const enabled = process.env.RUN_INNGEST_REPORT_LOCAL === '1';
const scratch = '/Users/y/.hermes/profiles/plan/cache/scratch';
const signingKey = 'signkey-local-report-123456789abcdef';
const testConfig = { INNGEST_EVENT_KEY: 'synthetic-event-key', INNGEST_SIGNING_KEY: signingKey, LLM_API_KEY: 'synthetic-provider-key', LLM_BASE_URL: 'https://llm.example.test/v1', LLM_MODEL: 'synthetic-model', REPORT_BACKEND: 'inngest', REPORT_INNGEST_EXECUTION_ENABLED: 'true', TEST_ONLY_FIXTURES: '1' };
const require = createRequire(import.meta.url);
const { signDataWithKey } = require('../../../../node_modules/inngest/helpers/net.js');
const success = (response: Response) => response.json() as Promise<Record<string, unknown>>;
let cleanup: () => Promise<void> = async () => {};
function sqliteBindings() {
	const sql = new DatabaseSync(':memory:');
	const DB = {
		prepare(query: string) {
			const statement = sql.prepare(query); let values: SQLInputValue[] = [];
			const wrapped = {
				bind(...args: unknown[]) { values = args as SQLInputValue[]; return wrapped; },
				async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
				async all<T>() { return { results: statement.all(...values) as T[] }; },
				async run() { const result = statement.run(...values); return { meta: { changes: Number(result.changes) } }; }
			}; return wrapped;
		},
		async batch(statements: Array<{ run(): Promise<{ meta?: { changes?: number } }> }>) {
			sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (cause) { sql.exec('ROLLBACK'); throw cause; }
		}
	};
	const objects = new Map<string, Uint8Array>();
	const OBJECTS = {
		async put(key: string, value: ArrayBuffer | Uint8Array) { objects.set(key, value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value.slice(0))); },
		async get(key: string) { const value = objects.get(key); return value ? { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(value)); controller.close(); } }) } : null; },
		async delete(key: string) { objects.delete(key); }
	};
	return { sql, DB, OBJECTS };
}

	describe.skipIf(!enabled)('local durable application report through signed Inngest SDK', () => {
	afterEach(async () => { vi.unstubAllGlobals(); await cleanup(); cleanup = async () => {}; });
	it('creates/retries an app report, offloads with step.ai.infer, normalizes and stores Markdown, and fences deleted generations', async () => {
		expect(resolve(process.env.TMPDIR ?? '')).toBe(scratch);
		const root = await mkdtemp(join(scratch, 'ymath-inngest-report-local-'));
		const configPath = join(root, 'wrangler.json');
		await writeFile(configPath, JSON.stringify({ name: 'ymath-report-local', compatibility_date: '2026-10-17', compatibility_flags: ['nodejs_compat'], d1_databases: [{ binding: 'DB', database_name: 'math-report-local', database_id: '00000000-0000-0000-0000-000000000001' }], r2_buckets: [{ binding: 'OBJECTS', bucket_name: 'math-report-local' }] }));
		process.env.WRANGLER_LOG_PATH = join(root, 'wrangler-logs');
		let proxy: Awaited<ReturnType<typeof getPlatformProxy>> | undefined;
		let sqlite: ReturnType<typeof sqliteBindings> | undefined;
		const { getPlatformProxy } = await import('wrangler');
		try { proxy = await getPlatformProxy({ configPath, persist: { path: join(root, 'state') }, remoteBindings: false }); }
		catch (cause) {
			if (process.env.RUN_INNGEST_REPORT_FIXTURE !== '1' || !(cause instanceof Error && cause.message.includes('listen EPERM'))) throw cause;
			sqlite = sqliteBindings();
			await writeFile(join(root, 'wrangler-blocker.json'), JSON.stringify({ status: 'BLOCKED', reason: 'Sandbox denies localhost listener creation (listen EPERM); continuing with actual local SQLite schema and an explicit R2 contract fixture.', requestedWranglerConfig: 'report integration config above' }, null, 2));
		}
		cleanup = async () => { if (proxy) await proxy.dispose(); sqlite?.sql.close(); };
		const realFetch = globalThis.fetch;
		const sent: Array<{ events: Array<{ name: string; id: string; data: { reportId: string; generation: number } }> }> = [];
		const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
			if (url.hostname === 'inn.gs' && url.pathname === `/e/${testConfig.INNGEST_EVENT_KEY}`) {
				const events = JSON.parse(String(init?.body)) as typeof sent[number]['events']; sent.push({ events });
				return new Response(JSON.stringify({ status: 200, ids: events.map((event) => event.id) }), { status: 200, headers: { 'content-type': 'application/json' } });
			}
			if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return realFetch(input, init);
			throw new Error(`External HTTP blocked in local report fixture: ${url.hostname}`);
		});
		vi.stubGlobal('fetch', network);
		const env = { ...(proxy?.env ?? sqlite), ...testConfig } as unknown as Parameters<typeof makeSliceApp>[0] & CloudflareEnv;
		const sql = await readFile(new URL('../../../../migrations/0001_initial.sql', import.meta.url), 'utf8');
		for (const statement of sql.replace(/--[^\n]*/g, '').split(';').map((value) => value.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
		for (const migration of ['0004_inngest_slice.sql', '0005_report_outbox.sql', '0006_inngest_report_owner.sql']) {
			const text = await readFile(new URL(`../../../../migrations/${migration}`, import.meta.url), 'utf8');
			for (const statement of text.replace(/--[^\n]*/g, '').split(';').map((value) => value.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
		}
		const analysis = validAnalysis(); analysis.classification.topic = '대수'; analysis.problem.number_guess = '0255';
		const itemId = '20261010-080000-abcd';
		const item = { schema_version: 1, id: itemId, created_at: '2026-10-10T08:00:00.000Z', status: 'done', error: null, attempts: 1, workbook: { id: 'ssen-m3-2', name: '쎈 중3-2', publisher: '쎈', grade: '중3', semester: 2 }, image: 'image.jpg', flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] }, analysis, meta: { provider: 'omlx', model: 'TEST-ONLY local synthetic analysis', prompt_version: 'TEST-ONLY', analyzed_at: '2026-10-10T08:00:00.000Z' } };
		await env.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,workbook_json,record_json,updated_at) VALUES(?,'item',?,'done',1,?,?,?)")
			.bind(itemId,item.created_at,JSON.stringify(item.workbook),JSON.stringify(item),item.created_at).run();
		// Faults surround the actual D1 binding; no SQL results are fabricated.
		let lostClaimResponse = true, failedSnapshotRead = true, failedSave = true;
		const faultEvidence: string[] = [];
		const realDb = env.DB;
		const sdkDb = {
			prepare(query: string) {
				let statement = realDb.prepare(query);
				const wrapped = {
					bind(...values: unknown[]) { statement = statement.bind(...(values as never[])); return wrapped; },
					async first<T>() {
						const result = await statement.first<T>();
						if (lostClaimResponse && query.includes("UPDATE entities SET status='generating'")) {
							lostClaimResponse = false; faultEvidence.push('committed-claim-response-lost');
							throw new Error('SYNTHETIC committed D1 claim response lost');
						}
						return result as T | null;
					},
					async all<T>() {
						if (failedSnapshotRead && query.includes('SELECT e.id,e.record_json')) {
							failedSnapshotRead = false; faultEvidence.push('post-claim-snapshot-read-failed');
							throw new Error('SYNTHETIC transient D1 report snapshot read failure');
						}
						const rows = await (statement as unknown as { all<X>(): Promise<{ results?: X[] }> }).all<T>();
						return { results: rows.results ?? [] };
					},
					async run() {
						if (failedSave && query.includes("UPDATE entities SET status='done',report_key=?")) {
							failedSave = false; faultEvidence.push('save-after-r2-put-failed');
							throw new Error('SYNTHETIC transient D1 save failure after R2 PUT');
						}
						return statement.run();
					}
				};
				return wrapped;
			}
		};
		const app = makeSliceApp({ ...env, DB: sdkDb as unknown as typeof env.DB });
		const create = (force = true) => createReport({ platform: { env }, request: new Request('https://math.test/math/api/reports', { method: 'POST', headers: { 'x-requested-with': 'ymath' }, body: JSON.stringify({ topic: '대수', period: '2026-10', force }) }), getClientAddress: () => '127.0.0.44' } as never);
		const created = await create(); expect(created.status).toBe(202);
		const createdBody = await success(created) as { report: { id: string; status: string } };
		const reportId = createdBody.report.id;
		expect(createdBody.report.status).toBe('queued');
		expect(sent[0].events[0]).toMatchObject({ name: 'ymath/report.requested', data: { reportId, generation: 1 } });
		expect(((await env.DB.prepare('SELECT state FROM report_outbox WHERE report_id=? AND generation=1').bind(reportId).first() as { state: string } | null)?.state)).toBe('sent');

		const drive = (event: { name: string; id?: string; data: Record<string, unknown> }, fnId: string) => {
			const steps: Record<string, unknown> = {};
			const runId = `synthetic-report-${crypto.randomUUID()}`;
			const call = async (stepId = 'step') => {
				const body = { version: 2, event, events: [event], steps, ctx: { run_id: runId, attempt: 0, disable_immediate_execution: true, use_api: false } };
				const time = String(Math.floor(Date.now() / 1000)); const signature = await signDataWithKey(body, signingKey, time, { debug() {} });
				const url = new URL(`https://math.test/math/api/inngest?fnId=${fnId}&stepId=${stepId}`);
				const request = new Request(url, { method: 'POST', headers: { host: 'math.test', 'content-type': 'application/json', 'x-inngest-signature': `t=${time}&s=${signature}` }, body: JSON.stringify(body) });
				const response = await app.handler.POST({ request, url } as never);
				return { status: response.status, body: await response.json() as unknown, call, steps };
			};
			return { call, steps };
		};
		const advance = async (run: ReturnType<typeof drive>, result: unknown, waitAtGateway = false) => {
			let response = await run.call(); let gateways = 0; let gateway: { op: string; id: string; opts: { type?: string; url?: string; auth_key?: string; body?: { model?: string; messages?: Array<{ content: string }> } } } | undefined;
			for (let i = 0; i < 20 && response.status === 206; i++) {
				const operation = (response.body as Array<{ op: string; id: string; data?: unknown; opts?: unknown }>)[0];
				if (operation.op === 'StepPlanned') response = await run.call(operation.id);
				else if (operation.op === 'StepRun') { run.steps[operation.id] = { type: 'data', data: operation.data }; response = await run.call(); }
				else if (operation.op === 'AIGateway') {
					gateways++; gateway = operation as typeof gateway;
					if (waitAtGateway) return { response, gateways, gateway, resume: async () => { run.steps[operation.id] = { type: 'data', data: result }; return run.call(); } };
					run.steps[operation.id] = { type: 'data', data: result }; response = await run.call();
				} else if (operation.op === 'StepError') {
					// The SDK retries the failed step on the same signed run; do not
					// supply a new result for it. Continue as Inngest would.
					response = await run.call(operation.id);
				} else throw new Error(`Unexpected Inngest report operation: ${JSON.stringify(operation)}`);
			}
			return { response, gateways, gateway };
		};
		const event1 = sent[0].events[0];
		const run1 = drive(event1, 'ymath-synthetic-slice-application-report-generation');
		const result1 = await advance(run1, { choices: [{ finish_reason: 'stop', message: { content: '# TEST-ONLY fixture title\n\n| 문제 | 진단 |\n|---|---|\n| 0255 · 쎈 중3-1 | TEST-ONLY local analysis |' } }] });
		expect(result1.response.status).toBe(200); expect(result1.response.body).toMatchObject({ status: 'done' }); expect(result1.gateways).toBe(1);
		expect(result1.gateway).toMatchObject({ opts: { type: 'step.ai.infer', url: 'https://llm.example.test/v1/chat/completions', body: { model: 'synthetic-model' } } });
		expect(result1.gateway?.opts.body?.messages?.[0].content).toContain('이번 오답 한눈에 돌아보기');
		const got = await getReport({ platform: { env }, params: { id: reportId } } as never);
		const stored = await success(got) as { status: string; summary: { total_items: number }; markdown: string; meta: { model: string } };
		expect(stored).toMatchObject({ status: 'done', summary: { total_items: 1 }, meta: { model: 'synthetic-model' } });
		expect(stored.markdown).toContain('쎈 중3-2<br/>0255'); expect(stored.markdown).not.toContain('TEST-ONLY fixture title');
		const committedKey = (await env.DB.prepare('SELECT report_key FROM entities WHERE id=?').bind(reportId).first() as {report_key:string}).report_key;
		expect(committedKey).toMatch(new RegExp(`^reports/${reportId}/result-inngest-1-.*\\.json$`));
		expect(await env.OBJECTS.get(committedKey)).not.toBeNull();

		const retried = await retryReport({ platform: { env }, params: { id: reportId }, request: new Request(`https://math.test/math/api/reports/${reportId}/retry`, { method: 'POST', headers: { 'x-requested-with': 'ymath' } }), getClientAddress: () => '127.0.0.45' } as never);
		expect(retried.status).toBe(202); expect(sent[1].events[0].data).toMatchObject({ reportId, generation: 2 });
		const staleRun = drive(sent[1].events[0], 'ymath-synthetic-slice-application-report-generation');
		const waiting = await advance(staleRun, { choices: [{ finish_reason: 'stop', message: { content: 'TEST-ONLY result after report deletion, must be fenced.' } }] }, true);
		expect(waiting.gateway).toMatchObject({ opts: { type: 'step.ai.infer' } });
		const deleted = await deleteReport({ platform: { env }, params: { id: reportId }, request: new Request(`https://math.test/math/api/reports/${reportId}`, { method: 'DELETE', headers: { 'x-requested-with': 'ymath' } }), getClientAddress: () => '127.0.0.46' } as never);
		expect(deleted.status).toBe(204);
		if (!waiting.resume) throw new Error('Expected the signed report run to pause at AIGateway');
		const resumed = await waiting.resume();
		let final = resumed;
		for (let i = 0; i < 8 && final.status === 206; i++) {
			const operation = (final.body as Array<{ op: string; id: string; data?: unknown }>)[0];
			if (operation.op === 'StepPlanned') final = await staleRun.call(operation.id);
			else if (operation.op === 'StepRun') { staleRun.steps[operation.id] = { type: 'data', data: operation.data }; final = await staleRun.call(); }
			else throw new Error(`Unexpected post-delete operation: ${JSON.stringify(operation)}`);
		}
		expect(final.status).toBe(200); expect(final.body).toMatchObject({ status: 'stale_result_rejected' });
		expect((await env.DB.prepare('SELECT report_key FROM entities WHERE id=?').bind(reportId).first() as {report_key:string|null}).report_key).toBeNull();
		expect(await cloudReport(env, reportId)).toBeNull();

		const terminalAccepted = await create(); expect(terminalAccepted.status).toBe(202);
		const terminalBody = await success(terminalAccepted) as { report: { id: string } };
		const terminalId = terminalBody.report.id;
		const terminalEvent = sent[2].events[0];
		const terminalRunId = 'synthetic-terminal-report-run';
		expect(await claimInngestReport(env.DB, terminalId, 1, terminalRunId)).toMatchObject({ status: 'generating' });
		const failureEvent = { name: 'inngest/function.failed', data: { event: terminalEvent, error: { name: 'Error', message: 'TEST-ONLY synthetic report storage failure' }, function_id: 'application-report-generation', run_id: terminalRunId } };
		const failureRun = drive(failureEvent, 'ymath-synthetic-slice-application-report-generation-failure');
		let failureResult = await failureRun.call();
		for (let i = 0; i < 8 && failureResult.status === 206; i++) {
			const operation = (failureResult.body as Array<{ op: string; id: string; data?: unknown }>)[0];
			if (operation.op === 'StepPlanned') failureResult = await failureRun.call(operation.id);
			else if (operation.op === 'StepRun') { failureRun.steps[operation.id] = { type: 'data', data: operation.data }; failureResult = await failureRun.call(); }
			else throw new Error(`Unexpected failure callback operation: ${JSON.stringify(operation)}`);
		}
		expect(failureResult.status).toBe(200);
		expect(await cloudReport(env, terminalId)).toMatchObject({ status: 'failed', error: 'Inngest report function exhausted its configured attempts' });
		const retryAfterFailure = await retryReport({ platform: { env }, params: { id: terminalId }, request: new Request(`https://math.test/math/api/reports/${terminalId}/retry`, { method: 'POST', headers: { 'x-requested-with': 'ymath' } }), getClientAddress: () => '127.0.0.47' } as never);
		expect(retryAfterFailure.status).toBe(202);
		expect(sent[3].events[0].data).toMatchObject({ reportId: terminalId, generation: 2 });
		expect(network.mock.calls.every(([input]) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); return url.hostname === 'inn.gs' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); })).toBe(true);

		await writeFile(join(root, 'report-result.json'), JSON.stringify({ status: 'PASS', storageBackend: proxy ? 'local Wrangler D1+R2' : 'actual SQLite schema + explicit R2 contract fixture (Wrangler listener blocked)', mode: 'actual installed Inngest serve/AIGateway protocol; synthetic event acceptance and provider output only', reportId, generation1: 'done-and-readable-via-existing-GET', generation2: 'retried-then-deleted-while-infer-pending; stale save fenced', injectedFaultsRecoveredOnSameSignedRun: faultEvidence, onFailure: 'signed SDK failure callback marks current generation failed and retry creates generation 2', outboxEventIds: sent.map((batch) => batch.events[0].id), sdkOperation: { type: result1.gateway?.opts.type, url: result1.gateway?.opts.url, model: result1.gateway?.opts.body?.model, auth: '[REDACTED]' } }, null, 2));
	});
});
