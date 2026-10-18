import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSliceStore, type SliceDb, type SliceStatement } from './inngest-slice/store';
import { createSliceSubmission } from './inngest-slice/submit';
import { assertReportInngestConfigured, isReportInngestConfigured, makeSliceApp, validateInferenceConfig, validateOpenAiResponse, validateReportResponse } from './inngest-slice/app';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

function sqliteStore() {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(readFileSync(new URL('../../../migrations/0004_inngest_slice.sql', import.meta.url), 'utf8'));
	const db: SliceDb = { prepare(sql: string) {
		const statement = sqlite.prepare(sql); const values: unknown[] = [];
		const wrapped: SliceStatement = {
			bind(...args) { values.splice(0, values.length, ...args); return wrapped; },
			async first<T>() { return (statement.get(...values as never[]) as T | undefined) ?? null; },
			async run() { const out = statement.run(...values as never[]); return { meta: { changes: Number(out.changes) } }; }
		}; return wrapped;
	} };
	return { store: createSliceStore(db), db, close: () => sqlite.close() };
}
const config = { INNGEST_EVENT_KEY: 'synthetic-event-key', INNGEST_SIGNING_KEY: 'signkey-synthetic-signing-key', LLM_API_KEY: 'synthetic-provider-key', LLM_BASE_URL: 'https://llm.example.test/v1', LLM_MODEL: 'synthetic-model' };
const openAi = (content: string, finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }] });
afterEach(() => vi.unstubAllGlobals());

describe('Inngest runnable vertical slice', () => {
	it('requires a separately enabled report execution switch before create/retry may submit work', () => {
		const disabled = { ...config, REPORT_BACKEND: 'inngest', OBJECTS: {} as never };
		expect(isReportInngestConfigured(disabled)).toBe(false);
		expect(() => assertReportInngestConfigured(disabled)).toThrow('REPORT_INNGEST_EXECUTION_ENABLED');
		const enabled = { ...disabled, REPORT_INNGEST_EXECUTION_ENABLED: 'true' };
		expect(isReportInngestConfigured(enabled)).toBe(true);
		expect(() => assertReportInngestConfigured(enabled)).not.toThrow();
		const disabledStore = sqliteStore();
		const prepared = makeSliceApp({ DB: disabledStore.db, ...disabled });
		expect(prepared.report).toBeDefined();
		expect(prepared.reportOutboxPump).toBeUndefined();
		const activeStore = sqliteStore();
		const active = makeSliceApp({ DB: activeStore.db, ...enabled });
		expect(active.reportOutboxPump).toBeDefined();
		disabledStore.close(); activeStore.close();
	});
	it('validates complete configuration before creating a row and validates text/report submission kinds', async () => {
		const { store, close } = sqliteStore();
		let sends = 0;
		const handler = createSliceSubmission({ store, configured: false, send: async () => { sends++; } });
		const response = await handler(new Request('https://math.test/api/inngest/submit', { method: 'POST', body: JSON.stringify({ text: 'synthetic prompt' }) }));
		expect(response.status).toBe(503); expect(sends).toBe(0);
		const configured = createSliceSubmission({ store, configured: true, send: async (_id, generation) => { sends++; expect(generation).toBe(1); } });
		const report = await configured(new Request('https://math.test/api/inngest/submit', { method: 'POST', body: JSON.stringify({ kind: 'report', text: 'Synthetic report request' }) }));
		expect(report.status).toBe(202); expect(sends).toBe(1);
		const body = await report.json() as {jobId:string}; expect((await store.get(body.jobId)).status).toBe('queued');
		const failing = createSliceSubmission({store,configured:true,send:async()=>{throw new Error('SYNTHETIC event transport failure');}});
		const failure = await failing(new Request('https://math.test/api/inngest/submit',{method:'POST',body:JSON.stringify({text:'Synthetic publish failure.'})}));
		expect(failure.status).toBe(502);const failedBody=await failure.json();expect((await store.get(failedBody.jobId)).status).toBe('publish_failed');
		close();
	});

	it('uses the real SDK GET/POST/PUT handlers and rejects unsigned or tampered requests', async () => {
		const network = vi.fn(async () => { throw new Error('External HTTP prohibited by this local SDK test'); });
		vi.stubGlobal('fetch', network);
		const { db, close } = sqliteStore();
		const signingKey = config.INNGEST_SIGNING_KEY;
		const app = makeSliceApp({ DB: db, ...config });
		const event = (request: Request) => { const headers = new Headers(request.headers); headers.set('host','math.test'); return { request: new Request(request, { headers }), url: new URL(request.url), platform: undefined } as never; };
		const unsigned = await app.handler.POST(event(new Request('https://math.test/api/inngest?fnId=synthetic-text-analysis', { method: 'POST', body: '{}' })));
		expect(unsigned.status).toBe(401);
		const require = createRequire(import.meta.url);
		const { signDataWithKey } = require('../../../node_modules/inngest/helpers/net.js') as { signDataWithKey: (body: unknown, key: string, timestamp: string, logger: {debug: () => void}) => Promise<string> };
		const timestamp = String(Math.floor(Date.now() / 1000));
		const signature = await signDataWithKey({ hello: 'original' }, signingKey, timestamp, { debug: () => undefined });
		const tampered = await app.handler.POST(event(new Request('https://math.test/api/inngest?fnId=synthetic-text-analysis', { method: 'POST', headers: { 'x-inngest-signature': `t=${timestamp}&s=${signature}` }, body: '{"hello":"tampered"}' })));
		expect(tampered.status).toBe(401);
		const syncBody = { url: 'https://math.test/api/inngest' };
		const unsignedPut = await app.handler.PUT(event(new Request('https://math.test/api/inngest', { method: 'PUT', headers: { 'x-inngest-sync-kind': 'in_band' }, body: JSON.stringify(syncBody) })));
		expect(unsignedPut.status).toBe(401);
		const syncSignature = await signDataWithKey(syncBody, signingKey, timestamp, { debug: () => undefined });
		const tamperedPut = await app.handler.PUT(event(new Request('https://math.test/api/inngest', { method: 'PUT', headers: { 'x-inngest-sync-kind': 'in_band', 'x-inngest-signature': `t=${timestamp}&s=${syncSignature}` }, body: JSON.stringify({ url: 'https://tampered.example.test' }) })));
		expect(tamperedPut.status).toBe(401);
		const get = await app.handler.GET(event(new Request('https://math.test/api/inngest')));
		expect(get.status).toBe(401);
		expect(network).not.toHaveBeenCalled();
		close();
	});

	it('uses real OpenAI-shaped content and bounded report schema validation', () => {
		expect(validateInferenceConfig({ ...config }).model).toBe('synthetic-model');
		for (const bad of [{...config,LLM_BASE_URL:'http://llm.example.test'}, {...config,LLM_BASE_URL:'https://user:pass@llm.example.test'}, {...config,LLM_MODEL:''}, {...config,LLM_API_KEY:''}]) expect(() => validateInferenceConfig(bad)).toThrow();
		expect(validateOpenAiResponse(openAi('A synthetic answer with sufficient content.'))).toContain('synthetic answer');
		for (const bad of [ {error:{message:'no'},...openAi('A fake successful answer')}, openAi('truncated result','length'), openAi('filtered result','content_filter'), {choices:[{message:{content:'missing finish'}}]} ]) expect(() => validateOpenAiResponse(bad)).toThrow();
		const report = JSON.stringify({title:'Synthetic report',summary:'A sufficiently detailed synthetic summary.',findings:['Finding'],recommendations:['Recommendation']});
		expect(JSON.parse(validateReportResponse(openAi(report))).title).toBe('Synthetic report');
		expect(() => validateReportResponse(openAi('{"title":"bad"}'))).toThrow(/schema/);
	});

	it('fences concurrent claims, stale attempts, retry exhaustion, and reset generations in actual SQLite', async () => {
		const { store, close } = sqliteStore();
		const id = await store.create('Synthetic input');
		const first = await store.claim(id, 1); expect(first).not.toBeNull();
		expect(await store.claim(id, 1)).toBeNull();
		expect(await store.fail(first!, 'synthetic failed attempt')).toBe(true);
		const generation = await store.reanalyze(id); expect(generation).toBe(2);
		const current = await store.claim(id, generation); expect(current).not.toBeNull();
		expect(await store.fail(first!, 'stale attempt')).toBe(false);
		expect(await store.complete(first!, 'stale complete')).toBe(false);
		expect(await store.complete(current!, 'Synthetic validated completion.')).toBe(true);
		expect((await store.get(id)).status).toBe('done'); close();
	});

	it('records terminal failure and permits explicit reanalysis after exhaustion', async () => {
		const { store, close } = sqliteStore();
		const id = await store.create('Synthetic terminal failure');
		const claim = await store.claim(id, 1); expect(claim).not.toBeNull();
		expect(await store.failCurrentGeneration(id, 1, 'Synthetic terminal failure')).toBe(true);
		expect((await store.get(id)).status).toBe('failed');
		expect(await store.claim(id, 1)).toBeNull();
		expect(await store.reanalyze(id)).toBe(2);
		expect(await store.claim(id, 2)).not.toBeNull(); close();
	});
});
