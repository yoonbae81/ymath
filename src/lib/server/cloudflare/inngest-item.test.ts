import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createRequire as requireFor } from 'node:module';
import { POST as uploadRoute } from '../../../routes/api/upload/+server';
import { GET as getItem } from '../../../routes/api/items/[id]/+server';
import { POST as retryItem } from '../../../routes/api/items/[id]/retry/+server';
import { DELETE as deleteItem } from '../../../routes/api/items/[id]/+server';
import { validAnalysis } from '../analysis.fixture';
import { makeSliceApp } from '../inngest-slice/app';
import { claimCloudJob, cloudItemBackend, type CloudflareEnv } from './runtime';
import { runnerClaimableKind } from './jobs';
import { claimInngestItem, loadInngestItemSnapshot, markInngestItemFailed, persistCloudOcr, publishPendingItemOutbox } from './inngest-item';
import { cleanOcrMarkdown, markdownFromOcrResponse } from '../ocr-core';
import { normalizeCloudImage } from './item-normalize';
import { buildPrompt as workerBuildPrompt, promptVersionAsync } from '../analyze-prompt';
import { buildPrompt as nodeBuildPrompt, promptVersion } from '../analyze';
import { checkClassification, parseTaxonomy } from '../taxonomy-core';
import curriculum from '../../../../user/prompts/curriculum.md?raw';

const config = {
	INNGEST_EVENT_KEY: 'synthetic-event-key', INNGEST_SIGNING_KEY: 'signkey-test-1234567890abcdef',
	LLM_API_KEY: 'synthetic-provider-key', LLM_BASE_URL: 'https://llm.example.test/v1', LLM_MODEL: 'synthetic-model',
	ITEM_ANALYSIS_BACKEND: 'inngest'
};
const workbooks = { workbooks: [{ id: 'wb-test', name: '테스트 중3-2', publisher: '테스트', grade: '중3', semester: 2 }] };
const require = createRequire(import.meta.url);
const { signDataWithKey } = require('../../../../node_modules/inngest/helpers/net.js');
const sharp = requireFor(import.meta.url)('sharp');

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
			};
			return wrapped;
		},
		async batch(statements: Array<{ run(): Promise<{ meta?: { changes?: number } }>}>) {
			sql.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sql.exec('COMMIT'); return results; } catch (cause) { sql.exec('ROLLBACK'); throw cause; }
		}
	};
	const objects = new Map<string, { value: Uint8Array; options?: { httpMetadata?: { contentType?: string } } }>();
	const OBJECTS = {
		async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) { objects.set(key, { value: new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value)), options }); },
		async get(key: string) { const entry = objects.get(key); return entry ? { body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(entry.value); controller.close(); } }), httpMetadata: entry.options?.httpMetadata } : null; },
		async delete(key: string) { if (process.env.DEBUG_ITEM_R2) console.error('[r2 delete]', key, new Error().stack?.split('\n').slice(1, 5).join(' | ')); objects.delete(key); }
	};
	return { sql, DB, OBJECTS, objects };
}

function migrate(db: { prepare(q: string): { run(): Promise<unknown> } }) {
	for (const name of ['0001_initial.sql', '0003_item_ocr.sql', '0007_item_outbox.sql']) {
		const text = readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), 'utf8');
		for (const statement of text.replace(/--[^\n]*/g, '').split(';').map((v) => v.trim()).filter(Boolean)) void db.prepare(statement).run();
	}
}

const analysisResponse = (marker = 'TESTONLY') => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...validAnalysis(), problem: { ...validAnalysis().problem, text_md: `$${marker}$` } }) } }] });

function driver(app: ReturnType<typeof makeSliceApp>, event: Record<string, unknown>, fnId: string) {
	const steps: Record<string, unknown> = {};
	const runId = `synthetic-item-${crypto.randomUUID()}`;
	async function call(stepId = 'step', attempt = 0) {
		const body = { version: 2, event, events: [event], steps, ctx: { run_id: runId, attempt, disable_immediate_execution: true, use_api: false } };
		const time = String(Math.floor(Date.now() / 1000));
		const signature = await signDataWithKey(body, config.INNGEST_SIGNING_KEY, time, { debug() {} });
		const url = new URL(`https://math.test/math/api/inngest?fnId=${fnId}&stepId=${stepId}`);
		const request = new Request(url, { method: 'POST', headers: { host: 'math.test', 'content-type': 'application/json', 'x-inngest-signature': `t=${time}&s=${signature}` }, body: JSON.stringify(body) });
		const response = await app.handler.POST({ request, url } as never);
		const parsed = await response.json() as unknown;
		if (response.status >= 500) console.error('[driver 500 body]', JSON.stringify(parsed));
		return { status: response.status, headers: response.headers, body: parsed as Array<{ op: string; id: string; data?: unknown; opts?: { type?: string; url?: string; body?: { model?: string; messages?: unknown[]; max_tokens?: number; temperature?: number; stream?: boolean } } }> | Record<string, unknown>, call, steps, runId };
	}
	return { call, steps, runId };
}

async function advance(run: ReturnType<typeof driver>, completions: unknown[], onGateway?: (gateway: NonNullable<ReturnType<typeof run.call> extends never ? never : { op: string; id: string; opts: { type?: string; url?: string; body?: { model?: string; messages?: unknown[]; max_tokens?: number; temperature?: number; stream?: boolean } } }>, index: number) => void) {
	let result = await run.call();
	let gatewayIndex = 0;
	const gateways: Array<{ op: string; id: string; opts: { type?: string; url?: string; body?: { model?: string; messages?: unknown[]; max_tokens?: number; temperature?: number; stream?: boolean } } }> = [];
	if (process.env.DEBUG_ITEM_R2) console.error('[call]', result.status, JSON.stringify(result.body).slice(0, 200));
	for (let i = 0; i < 25 && result.status === 206; i++) {
		const ops = result.body as Array<{ op: string; id: string; data?: unknown; opts?: { type?: string; url?: string; body?: { model?: string; messages?: unknown[]; max_tokens?: number; temperature?: number; stream?: boolean } } }>;
		const op = ops[0];
		if (process.env.DEBUG_ITEM_R2) console.error('[op]', op.op, op.id);
		if (op.op === 'StepPlanned') result = await run.call(op.id);
		else if (op.op === 'StepRun') { run.steps[op.id] = { type: 'data', data: op.data }; result = await run.call(); }
		else if (op.op === 'AIGateway') {
			gateways.push(op as typeof gateways[number]);
			onGateway?.(op as typeof gateways[number], gatewayIndex);
			const completion = completions[gatewayIndex];
			if (completion === undefined) return { result, gateways, gatewayIndex, resume: async (data: unknown) => { run.steps[op.id] = { type: 'data', data }; let r = await run.call(); for (let j = 0; j < 25 && r.status === 206; j++) { const next = (r.body as Array<{ op: string; id: string; data?: unknown }>)[0]; if (next.op === 'StepPlanned') r = await run.call(next.id); else if (next.op === 'StepRun') { run.steps[next.id] = { type: 'data', data: next.data }; r = await run.call(); } else if (next.op === 'AIGateway') { gatewayIndex++; run.steps[next.id] = { type: 'data', data: completions[gatewayIndex] }; r = await run.call(); } else if (next.op === 'StepError') r = await run.call(next.id); else throw new Error(`unexpected op ${next.op}`); } return { result: r, gateways }; } };
			gatewayIndex++;
			run.steps[op.id] = { type: 'data', data: completion };
			result = await run.call();
		}
		else if (op.op === 'StepError') return { result, gateways, gatewayIndex, resume: undefined, failedStep: op.id };
		else throw new Error(`Unexpected op ${JSON.stringify(op)}`);
	}
	return { result, gateways, gatewayIndex, resume: undefined };
}

async function uploadFixture(env: CloudflareEnv, jpeg: Uint8Array, idempotencyKey: string) {
	const url = new URL('https://math.test/math/api/upload?workbookId=wb-test');
	const response = await uploadRoute({ platform: { env }, url, request: new Request(url, { method: 'POST', headers: { 'x-requested-with': 'ymath', 'content-type': 'image/jpeg', 'idempotency-key': idempotencyKey }, body: new Uint8Array(jpeg) }), getClientAddress: () => '127.0.0.80' } as never);
	return response;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

// Provider/network 금지: SDK execution과 실제 SQLite만 실행하고 이벤트 전송만 대체한다.
async function protocolFixture(overrides: Record<string, string> = {}) {
	vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
		expect(String(url)).toBe('https://inn.gs/e/synthetic-event-key');
		return new Response(JSON.stringify({ status: 200, ids: ['SYNTHETIC'] }), { status: 200 });
	}));
	const bindings = sqliteBindings(); migrate(bindings.DB);
	const env = { ...bindings, WORKBOOKS_JSON: JSON.stringify(workbooks), ...config, ...overrides } as unknown as CloudflareEnv;
	const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#335577' } }).jpeg().toBuffer();
	const created = await uploadFixture(env, new Uint8Array(jpeg), crypto.randomUUID());
	expect(created.status).toBe(201);
	const { id } = await created.json() as { id: string };
	const job = await bindings.DB.prepare('SELECT job_id FROM item_outbox WHERE entity_id=?').bind(id).first<{ job_id: string }>();
	const event = { name: 'ymath/item.requested', data: { jobId: job!.job_id, entityId: id, entityGeneration: 1 } };
	const app = makeSliceApp(env);
	return { ...bindings, env, id, jobId: job!.job_id, event, app, run: driver(app, event, 'ymath-synthetic-slice-item-analysis') };
}

const syntheticOcr = { choices: [{ finish_reason: 'stop', message: { content: 'SYNTHETIC OCR $x^2$' } }] };

// These are service-delivered terminal gateway errors, not real provider responses.
const gatewayErrors = [
	{ name: 'RateLimitError', message: 'SYNTHETIC HTTP 429 Too Many Requests' },
	{ name: 'TimeoutError', message: 'SYNTHETIC inference timed out after 2m' }
];

// Stop at externally completed operations; never invoke a provider or real scheduler.
async function untilExternal(run: ReturnType<typeof driver>) {
	let result = await run.call();
	for (let i = 0; i < 60 && result.status === 206; i++) {
		const op = (result.body as Array<{ op: string; id: string; data?: unknown; name?: string }>)[0];
		if (op.op === 'StepPlanned') result = await run.call(op.id);
		else if (op.op === 'StepRun') { run.steps[op.id] = { type: 'data', data: op.data }; result = await run.call(); }
		else return { result, op };
	}
	return { result, op: undefined };
}

describe('queue retry parity via signed SDK (offline)', () => {
	it('renews fenced leases across five 10m quota waits without spending attempts', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const { run, DB, jobId } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		let gatewayId = pending.gateways[1].id;
		for (let index = 0; index < 5; index++) {
			run.steps[gatewayId] = { type: 'error', error: gatewayErrors[0] };
			const waiting = await untilExternal(run);
			expect(waiting.op).toMatchObject({ op: 'Sleep', name: '10m' });
			const leased = await DB.prepare('SELECT attempts,lease_until FROM jobs WHERE id=?').bind(jobId).first<{ attempts: number; lease_until: string }>();
			expect(leased!.attempts).toBe(0);
			expect(Date.parse(leased!.lease_until) - Date.now()).toBe(40 * 60_000);
			vi.setSystemTime(Date.now() + 10 * 60_000);
			run.steps[waiting.op!.id] = { type: 'data', data: null };
			const retry = await untilExternal(run);
			expect(retry.op?.op).toBe('AIGateway');
			expect(retry.op?.id).not.toBe(gatewayId);
			gatewayId = retry.op!.id;
		}
		run.steps[gatewayId] = { type: 'data', data: analysisResponse('LONG429') };
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'done' } });
		expect(await DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 1 });
	});

	const mutations = [
		['owner', "UPDATE jobs SET lease_owner='stolen'"],
		['token', "UPDATE jobs SET lease_token='stolen'"],
		['job generation', 'UPDATE jobs SET generation=generation+1'],
		['entity generation', 'UPDATE entities SET generation=generation+1'],
		['job entity generation', 'UPDATE jobs SET entity_generation=entity_generation+1'],
		['attempt', 'UPDATE jobs SET attempts=attempts+1'],
		['job status', "UPDATE jobs SET state='done'"],
		['entity status', "UPDATE entities SET status='done'"],
		['deleted entity', "UPDATE entities SET deleted_at='2026-01-01'"],
		['expired lease', "UPDATE jobs SET lease_until='2000-01-01'"]
	] as const;
	for (const boundary of ['quota wait', 'quota resume', 'timeout retry', 'timeout terminal'] as const) {
		it.each(mutations)(`${boundary} rejects stale %s without any writes or new gateway`, async (_name, mutation) => {
			const { run, DB, sql, jobId, id } = await protocolFixture();
			const pending = await advance(run, [syntheticOcr]);
			run.steps[pending.gateways[1].id] = { type: 'error', error: boundary.startsWith('quota') ? gatewayErrors[0] : gatewayErrors[1] };
			if (boundary === 'quota resume') {
				const waiting = await untilExternal(run);
				expect(waiting.op?.op).toBe('Sleep');
				run.steps[waiting.op!.id] = { type: 'data', data: null };
			} else if (boundary === 'timeout terminal') {
				const retry = await untilExternal(run);
				expect(retry.op?.op).toBe('AIGateway');
				run.steps[retry.op!.id] = { type: 'error', error: gatewayErrors[1] };
			}
			sql.exec(mutation);
			const before = { job: await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first(), entity: await DB.prepare('SELECT * FROM entities WHERE id=?').bind(id).first() };
			expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'stale_result_rejected' } });
			expect({ job: await DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first(), entity: await DB.prepare('SELECT * FROM entities WHERE id=?').bind(id).first() }).toEqual(before);
		});
	}

	it.each([
		{ completion: { type: 'error', error: { name: 'QuotaExceededError', message: 'SYNTHETIC allocation exhausted' } } },
		{ completion: { type: 'data', data: { error: { message: 'SYNTHETIC resource_exhausted' } } } }
	])('preserves queue quota classification across SDK serialization: $completion.type', async ({ completion }) => {
		const { run } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		run.steps[pending.gateways[1].id] = completion;
		expect((await untilExternal(run)).op).toMatchObject({ op: 'Sleep', name: '10m' });
	});

	it('honors the queue attempt/delay/timeout settings and resets the budget on quota reaccept', async () => {
		const { run, DB, jobId } = await protocolFixture({ ANALYZE_MAX_ATTEMPTS: '3', QUOTA_RETRY_DELAY_MS: '120000', ANALYZE_TIMEOUT_MS: '60000' });
		const pending = await advance(run, [syntheticOcr]);
		expect(pending.gateways[1].opts).toHaveProperty('timeout', '60000ms');
		run.steps[pending.gateways[1].id] = { type: 'error', error: gatewayErrors[1] };
		const retry = await untilExternal(run);
		run.steps[retry.op!.id] = { type: 'error', error: gatewayErrors[0] };
		const wait = await untilExternal(run);
		expect(wait.op).toMatchObject({ op: 'Sleep', name: '2m' });
		expect(await DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 1 });
		run.steps[wait.op!.id] = { type: 'data', data: null };
		for (let index = 0; index < 3; index++) {
			const next = await untilExternal(run);
			expect(next.op?.op).toBe('AIGateway');
			run.steps[next.op!.id] = { type: 'error', error: gatewayErrors[1] };
		}
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'failed' } });
		expect(await DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 4 });
	});

	it('timeout retry succeeds without rerunning OCR or object reads, and a lost retry-step response is idempotent', async () => {
		const { run, DB, jobId, OBJECTS } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		const get = vi.spyOn(OBJECTS, 'get');
		const beforeSteps = new Set(Object.keys(run.steps));
		run.steps[pending.gateways[1].id] = { type: 'error', error: gatewayErrors[1] };
		const retry = await untilExternal(run);
		expect(retry.op?.op).toBe('AIGateway');
		const retrySteps = Object.keys(run.steps).filter((id) => !beforeSteps.has(id) && id !== pending.gateways[1].id);
		expect(retrySteps).toHaveLength(1);
		delete run.steps[retrySteps[0]]; // DB committed; SDK did not receive the StepRun memo.
		const replay = await untilExternal(run);
		expect(replay.op?.id).toBe(retry.op!.id);
		expect(await DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 2 });
		expect(get).not.toHaveBeenCalled();
		run.steps[retry.op!.id] = { type: 'data', data: analysisResponse('AFTER_TIMEOUT') };
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'done' } });
	});

	it('quota refund remains idempotent after a lost transition-step response', async () => {
		const { run, DB, jobId } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		const beforeSteps = new Set(Object.keys(run.steps));
		run.steps[pending.gateways[1].id] = { type: 'error', error: gatewayErrors[0] };
		const waiting = await untilExternal(run);
		const waitSteps = Object.keys(run.steps).filter((id) => !beforeSteps.has(id) && id !== pending.gateways[1].id);
		expect(waitSteps).toHaveLength(1);
		delete run.steps[waitSteps[0]];
		expect((await untilExternal(run)).op?.id).toBe(waiting.op!.id);
		expect(await DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 0 });
	});

	it('permanent failure remains idempotent if its StepRun response was lost', async () => {
		const { run } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		run.steps[pending.gateways[1].id] = { type: 'error', error: gatewayErrors[1] };
		const retry = await untilExternal(run);
		run.steps[retry.op!.id] = { type: 'error', error: gatewayErrors[1] };
		const before = new Set(Object.keys(run.steps));
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'failed' } });
		const added = Object.keys(run.steps).filter((id) => !before.has(id));
		expect(added).toHaveLength(1);
		delete run.steps[added[0]];
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'failed' } });
	});

	it('analysis emits the queue default 15m timeout', async () => {
		const { run } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		expect(pending.gateways[1].opts).toHaveProperty('timeout', '15m');
	});

	it('invalid analysis is retried with the queue correction hint', async () => {
		const { run } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		run.steps[pending.gateways[1].id] = { type: 'data', data: { choices: [{ finish_reason: 'stop', message: { content: '{}' } }] } };
		const retry = await untilExternal(run);
		expect(retry.op?.op).toBe('AIGateway');
		expect(JSON.stringify(retry.result.body)).toContain('직전 시도의 문제점');
		run.steps[retry.op!.id] = { type: 'data', data: analysisResponse('FIXED') };
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'done' } });
	});
	it.each([
		gatewayErrors[1], { name: 'Error', message: 'SYNTHETIC unknown provider failure' }
	])('$name retries with a new gateway up to queue maxAttempts, then permanently fails', async (error) => {
		const { run, DB, jobId, id, env } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		run.steps[pending.gateways[1].id] = { type: 'error', error };
		const retry = await untilExternal(run);
		expect(retry.op?.op).toBe('AIGateway');
		expect(retry.op?.id).not.toBe(pending.gateways[1].id);
		expect(await DB.prepare('SELECT attempts FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 2 });
		run.steps[retry.op!.id] = { type: 'error', error };
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'failed' } });
		expect(await DB.prepare('SELECT attempts,state,lease_token FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 2, state: 'failed', lease_token: null });
		const got = await getItem({ platform: { env }, params: { id } } as never);
		expect(await got.json()).toMatchObject({ status: 'failed', attempts: 2, error: error.message });
	});

	it('429 refunds attempts, sleeps 10m, then emits a new gateway and completes', async () => {
		const { run, DB, jobId, id } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		run.steps[pending.gateways[1].id] = { type: 'error', error: gatewayErrors[0] };
		const waiting = await untilExternal(run);
		expect(waiting.op).toMatchObject({ op: 'Sleep', name: '10m' });
		expect(await DB.prepare('SELECT attempts, state FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 0, state: 'leased' });
		const queued = await DB.prepare('SELECT status,record_json FROM entities WHERE id=?').bind(id).first<{ status: string; record_json: string }>();
		expect(queued!.status).toBe('queued');
		expect(JSON.parse(queued!.record_json)).toMatchObject({ status: 'queued', attempts: 0 });
		run.steps[waiting.op!.id] = { type: 'data', data: null };
		const retry = await untilExternal(run);
		expect(retry.op?.op).toBe('AIGateway');
		expect(retry.op?.id).not.toBe(pending.gateways[1].id);
		run.steps[retry.op!.id] = { type: 'data', data: analysisResponse('AFTER429') };
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'done' } });
		expect(await DB.prepare('SELECT attempts,state FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 1, state: 'done' });
	});
});

describe('signed SDK protocol failure/taxonomy audit (offline)', () => {
	it.each(gatewayErrors)('OCR $name terminal gateway error falls back to image analysis', async (error) => {
		const { run, DB, id, OBJECTS } = await protocolFixture();
		const pending = await advance(run, []);
		expect(pending.gateways).toHaveLength(1);
		run.steps[pending.gateways[0].id] = { type: 'error', error };
		const finished = await advance(run, [analysisResponse('PHOTO_ONLY')], (gateway) => {
			const body = JSON.stringify(gateway.opts.body);
			expect(body).toContain('(OCR 결과 없음. 사진만 보고 분석하세요)');
			expect(body).toContain('data:image/jpeg;base64,');
		});
		expect(finished.result).toMatchObject({ status: 200, body: { status: 'done' } });
		const row = await DB.prepare('SELECT ocr_key, record_json FROM entities WHERE id=?').bind(id).first<{ ocr_key: string | null; record_json: string }>();
		expect(row!.ocr_key).toBeNull();
		expect(JSON.parse(row!.record_json)).toMatchObject({ status: 'done', flags: { ocr_missing: true } });
		const artifact = await DB.prepare('SELECT analysis_key, flags_json FROM analyses WHERE entity_id=?').bind(id).first<{ analysis_key: string; flags_json: string }>();
		expect(JSON.parse(artifact!.flags_json)).toMatchObject({ ocr_missing: true });
		expect(await new Response((await OBJECTS.get(artifact!.analysis_key))!.body).json()).toMatchObject({ flags: { ocr_missing: true } });
	});

	it('registers infrastructure retries and signed onFailure only finalizes its owner', async () => {
		const { run, DB, id, jobId, event, app, env } = await protocolFixture();
		const registration = app.item as unknown as { getConfig(input: { baseUrl: URL; appPrefix: string; isConnect: boolean }): Array<{ steps: { step: { retries: { attempts: number } } }; triggers: unknown }> };
		const registered = registration.getConfig({ baseUrl: new URL('https://math.test/math/api/inngest'), appPrefix: 'ymath-synthetic-slice', isConnect: false });
		expect(registered[0].steps.step.retries).toEqual({ attempts: 0 });
		expect(registered[1].triggers).toEqual([{ event: 'inngest/function.failed', expression: "event.data.function_id == 'ymath-synthetic-slice-item-analysis'" }]);
		await advance(run, [syntheticOcr]);
		const failure = (owner: string) => ({ name: 'inngest/function.failed', data: { event, run_id: owner, function_id: 'ymath-synthetic-slice-item-analysis', error: { name: 'Error', message: 'SYNTHETIC infrastructure exhaustion' } } });
		await advance(driver(app, failure('wrong-owner'), 'ymath-synthetic-slice-item-analysis-failure'), []);
		expect(await DB.prepare('SELECT state FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ state: 'leased' });
		const terminal = await advance(driver(app, failure(run.runId), 'ymath-synthetic-slice-item-analysis-failure'), []);
		expect(terminal.result.status).toBe(200);
		expect(await DB.prepare('SELECT state, lease_token FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ state: 'failed', lease_token: null });
		const after = await getItem({ platform: { env }, params: { id } } as never);
		expect(await after.json()).toMatchObject({ status: 'failed', error: 'Inngest item analysis function exhausted its configured attempts' });
	});

	it('preserves ocr_missing on permanent analysis failure after OCR fallback, like the legacy queue', async () => {
		const { run, env, id } = await protocolFixture();
		const ocr = await advance(run, []);
		run.steps[ocr.gateways[0].id] = { type: 'error', error: gatewayErrors[1] };
		for (let attempt = 0; attempt < 2; attempt++) {
			const analysis = await untilExternal(run);
			expect(analysis.op?.op).toBe('AIGateway');
			run.steps[analysis.op!.id] = { type: 'error', error: gatewayErrors[1] };
		}
		expect((await untilExternal(run)).result).toMatchObject({ status: 200, body: { status: 'failed' } });
		const got = await getItem({ platform: { env }, params: { id } } as never);
		expect(await got.json()).toMatchObject({ status: 'failed', flags: { ocr_missing: true } });
	});

	it('a replayed analysis gateway can recover without repeating OCR or claiming again', async () => {
		const { run, DB, id, jobId } = await protocolFixture();
		const pending = await advance(run, [syntheticOcr]);
		const gateway = pending.gateways[1];
		for (const attempt of [1, 2]) {
			const retry = await run.call('step', attempt);
			expect((retry.body as Array<{ op: string; id: string }>)[0]).toMatchObject({ op: 'AIGateway', id: gateway.id });
		}
		run.steps[gateway.id] = { type: 'data', data: analysisResponse('RECOVERED') };
		const finished = await advance(run, []);
		expect(finished.result).toMatchObject({ status: 200, body: { status: 'done' } });
		expect(finished.gateways).toHaveLength(0);
		expect(await DB.prepare('SELECT attempts, state FROM jobs WHERE id=?').bind(jobId).first()).toEqual({ attempts: 1, state: 'done' });
		expect((await DB.prepare('SELECT record_json FROM entities WHERE id=?').bind(id).first<{ record_json: string }>())!.record_json).toContain('RECOVERED');
	});

	it('stores valid-enum topic/unit mismatches as warnings, with canonical course in API/D1/R2', async () => {
		const { run, DB, OBJECTS, id, env } = await protocolFixture();
		const taxonomy = parseTaxonomy(curriculum);
		const out = validAnalysis();
		out.classification.topic = taxonomy.topics.find((topic) => topic !== taxonomy.unitByName.get(out.classification.unit_major)!.topic)!;
		const issues = checkClassification(taxonomy, out as import('$lib/types').Analysis);
		expect(issues).toHaveLength(1);
		const completed = await advance(run, [syntheticOcr, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(out) } }] }]);
		expect(completed.result).toMatchObject({ status: 200, body: { status: 'done' } });
		const got = await getItem({ platform: { env }, params: { id } } as never);
		const record = await got.json() as { analysis: { classification: { course: string } }; flags: unknown; meta: unknown };
		expect(record.analysis.classification.course).toBe(taxonomy.unitByName.get(out.classification.unit_major)!.course);
		expect(record.flags).toMatchObject({ taxonomy_mismatch: issues, ocr_missing: false });
		const row = await DB.prepare('SELECT analysis_key, flags_json, meta_json FROM analyses WHERE entity_id=?').bind(id).first<{ analysis_key: string; flags_json: string; meta_json: string }>();
		expect(JSON.parse(row!.flags_json)).toEqual(record.flags);
		expect(JSON.parse(row!.meta_json)).toEqual(record.meta);
		const artifact = await new Response((await OBJECTS.get(row!.analysis_key))!.body).json();
		expect(artifact).toEqual({ analysis: record.analysis, flags: record.flags, meta: record.meta });
	});
});

describe('ITEM_ANALYSIS_BACKEND switch', () => {
	it('defaults to the runner backend and only enables with the explicit inngest value', () => {
		expect(cloudItemBackend({})).toBe('runner');
		expect(cloudItemBackend({ ITEM_ANALYSIS_BACKEND: 'runner' })).toBe('runner');
		expect(cloudItemBackend({ ITEM_ANALYSIS_BACKEND: 'inngest' })).toBe('inngest');
	});
	it('prevents double execution across the report/item switch matrix', () => {
		expect(runnerClaimableKind({})).toBe('both');
		expect(runnerClaimableKind({ REPORT_BACKEND: 'inngest' })).toBe('item');
		expect(runnerClaimableKind({ ITEM_ANALYSIS_BACKEND: 'inngest' })).toBe('report');
		expect(runnerClaimableKind({ REPORT_BACKEND: 'inngest', ITEM_ANALYSIS_BACKEND: 'inngest' })).toBeNull();
	});
	it('claim filter gives the runner only the jobs it owns', async () => {
		const { DB } = sqliteBindings(); migrate(DB);
		const env = { DB, WORKBOOKS_JSON: JSON.stringify(workbooks), ...config } as unknown as CloudflareEnv;
		const recordJson = JSON.stringify({ schema_version: 1, flags: {}, status: 'queued' });
		await DB.prepare(`INSERT INTO entities(id,kind,created_at,status,generation,record_json,updated_at) VALUES('i1','item','2026-10-18T00:00:00Z','queued',1,?,'2026-10-18T00:00:00Z')`).bind(recordJson).run();
		await DB.prepare(`INSERT INTO jobs(id,entity_id,kind,entity_generation,state,payload,created_at,updated_at) VALUES('j1','i1','item',1,'queued','{}','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')`).run();
		await DB.prepare(`INSERT INTO entities(id,kind,created_at,status,generation,updated_at) VALUES('r1','report','2026-10-18T00:00:00Z','queued',1,'2026-10-18T00:00:00Z')`).run();
		await DB.prepare(`INSERT INTO jobs(id,entity_id,kind,entity_generation,state,payload,created_at,updated_at) VALUES('j2','r1','report',1,'queued','{}','2026-10-18T00:00:00Z','2026-10-18T00:00:00Z')`).run();
		// runner owns items only when ITEM_ANALYSIS_BACKEND=inngest, reports remain runner-owned
		const job = await claimCloudJob({ ...env, ITEM_ANALYSIS_BACKEND: 'inngest' } as CloudflareEnv, 'runner-x');
		expect(job?.kind).toBe('report');
		expect((await DB.prepare('SELECT state FROM jobs WHERE id=?').bind('j1').first<{ state: string }>())?.state).toBe('queued');
		// both inngest: runner claims nothing
		const none = await claimCloudJob({ ...env, ITEM_ANALYSIS_BACKEND: 'inngest', REPORT_BACKEND: 'inngest' } as CloudflareEnv, 'runner-y');
		expect(none).toBeNull();
		// expire the report lease so the provider lane is free, then default: runner owns everything again
		await DB.prepare(`UPDATE jobs SET state='queued', lease_owner=NULL, lease_token=NULL, lease_until=NULL WHERE id='j2'`).run();
		const legacy = await claimCloudJob({ ...env, ITEM_ANALYSIS_BACKEND: undefined } as unknown as CloudflareEnv, 'runner-z');
		expect(legacy?.kind).toBe('item');
	});
});

describe('OCR 계약(기존 runner와 동일)', () => {
	it('cleans LOC tokens and fails on empty or missing markdown', () => {
		// 기존 ocr.ts 정규식 계약: 토큰과 인접 공백을 함께 제거한다(단어 사이 공백이 사라질 수 있다)
		expect(cleanOcrMarkdown('  <|LOC_0|>다음 식을  <|LOC_12|>계산하면? ')).toBe('다음 식을계산하면?');
		expect(() => markdownFromOcrResponse({ choices: [{ message: { content: '   ' } }] })).toThrow();
		expect(() => markdownFromOcrResponse({ choices: [{ message: {} }] })).toThrow();
		expect(markdownFromOcrResponse({ choices: [{ message: { content: [{ type: 'text', text: '<|LOC_3|>가' }, { type: 'text', text: '나' }] } }] })).toBe('가나');
	});
});

describe('Worker 이미지 정규화(합성 fixture)', () => {
	it('matches the legacy normalization policy: EXIF rotate, ≤1600, grayscale JPEG', async () => {
		const raw = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: { r: 200, g: 40, b: 90 } } }).jpeg().toBuffer();
		const { jpeg, width, height } = await normalizeCloudImage(new Uint8Array(raw));
		expect(Math.max(width, height)).toBeLessThanOrEqual(1600);
		const meta = await sharp(Buffer.from(jpeg)).metadata();
		expect(meta.format).toBe('jpeg');
		const { data, info } = await sharp(Buffer.from(jpeg)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
		let maxDelta = 0;
		for (let i = 0; i < data.length; i += info.channels) maxDelta = Math.max(maxDelta, Math.abs(data[i] - data[i + 1]), Math.abs(data[i] - data[i + 2]));
		expect(maxDelta).toBe(0);
	}, 60_000);
	it('applies EXIF orientation 6 like sharp .rotate()', async () => {
		const raw = await sharp({ create: { width: 400, height: 200, channels: 3, background: { r: 10, g: 220, b: 30 } } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
		const { width, height } = await normalizeCloudImage(new Uint8Array(raw));
		expect([width, height]).toEqual([200, 400]);
	}, 60_000);
	it('rejects disallowed formats, oversized images, and non-images before decode', async () => {
		const tiff = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#123456' } }).tiff().toBuffer();
		await expect(normalizeCloudImage(new Uint8Array(tiff))).rejects.toThrow(/JPEG\/PNG\/WebP/);
		const big = await sharp({ create: { width: 10001, height: 5000, channels: 3, background: '#ffffff' } }).jpeg().toBuffer();
		await expect(normalizeCloudImage(new Uint8Array(big))).rejects.toThrow(/너무 큽니다/);
		await expect(normalizeCloudImage(new Uint8Array(Buffer.from('not an image')))).rejects.toThrow(/지원되지 않는/);
	}, 120_000);
});

describe('프롬프트/버전 계약 동등성', () => {
	it('worker buildPrompt matches the Node analyze buildPrompt and promptVersion hashes agree', async () => {
		const record = { schema_version: 1, id: 'x', created_at: '', status: 'queued', error: null, attempts: 0, workbook: { id: 'w', name: '문제집', publisher: 'p', grade: '중3', semester: 2 }, image: 'image.jpg', flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] }, analysis: null, meta: null } as never;
		const args = { guideline: '# 지침 {{STUDENT_NAME}}', taxonomy: { topics: ['대수'], units: [{ name: '방정식', course: '중3', topic: '대수', concepts: [{ id: 'ALG-ROOT-COEFF', desc: '근과 계수', unit: '방정식', topic: '대수' }] }], unitByName: new Map([['방정식', { name: '방정식', course: '중3', topic: '대수', concepts: [] }]]), conceptById: new Map([['ALG-ROOT-COEFF', { id: 'ALG-ROOT-COEFF', desc: '근과 계수', unit: '방정식', topic: '대수' }]]) }, patterns: [], record, imagePath: 'image.jpg', ocrText: '', provider: 'omlx' } as never;
		expect(workerBuildPrompt(args)).toBe(nodeBuildPrompt(args));
		expect(await promptVersionAsync('가이드', '커리큘럼')).toBe(promptVersion('가이드', '커리큘럼'));
	});
});

describe('item outbox와 claim fencing', () => {
	it('accepts an upload with a durable outbox row, publishes with stable event IDs, and fences deleted entities', async () => {
		vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
			expect(String(url)).toBe('https://inn.gs/e/synthetic-event-key');
			return new Response(JSON.stringify({ status: 200, ids: ['SYNTHETIC'] }), { status: 200 });
		}));
		const { DB, OBJECTS } = sqliteBindings(); migrate(DB);
		const env = { DB, OBJECTS, WORKBOOKS_JSON: JSON.stringify(workbooks), ...config } as unknown as CloudflareEnv;
		const jpeg = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#446688' } }).jpeg().toBuffer();
		const accepted = await uploadFixture(env, new Uint8Array(jpeg), 'idem-1');
		expect(accepted.status).toBe(201);
		const { id } = await accepted.json() as { id: string };
		const outbox = await DB.prepare('SELECT state, job_id FROM item_outbox WHERE entity_id=?').bind(id).first<{ state: string; job_id: string }>();
		// 업로드 라우트가 즉시 발행하므로 이미 sent 다. 재발행 복구 경로는 상태를 pending 으로 되돌려 검증한다.
		expect(outbox?.state).toBe('sent');
		await DB.prepare(`UPDATE item_outbox SET state='pending', lease_token=NULL, lease_until=NULL WHERE entity_id=?`).bind(id).run();
		const sent: unknown[] = [];
		const published = await publishPendingItemOutbox(DB, async (event) => { sent.push(event); }, undefined, 20, 55);
		expect(published).toMatchObject({ sent: 1, failed: 0 });
		expect(sent[0]).toMatchObject({ name: 'ymath/item.requested', id: `item-${id}-1`, data: { entityId: id, entityGeneration: 1, jobId: outbox?.job_id } });
		// default backend writes no outbox rows
		const runnerEnv = { ...env, ITEM_ANALYSIS_BACKEND: 'runner' } as CloudflareEnv;
		const legacy = await uploadFixture(runnerEnv, new Uint8Array(jpeg), 'idem-2');
		expect(legacy.status).toBe(201);
		const rows = await DB.prepare('SELECT COUNT(*) AS n FROM item_outbox').first<{ n: number }>();
		expect(rows?.n).toBe(1);

		const jobId = outbox!.job_id;
		const runId = 'synthetic-run-owner';
		const claimed = await claimInngestItem(DB, jobId, id, 1, runId);
		expect(claimed).toMatchObject({ entity_id: id, kind: 'item' });
		const token = claimed!.lease_token;
		expect(await claimInngestItem(DB, jobId, id, 1, 'other-owner')).toBeNull();
		expect((await claimInngestItem(DB, jobId, id, 1, runId))?.lease_token).toBe(token);
		// idempotent OCR persist (재시도 때 같은 키 재사용)
		expect(await persistCloudOcr(env, claimed!, token, 'SYNTHETIC OCR TEXT')).toBe(true);
		expect(await persistCloudOcr(env, claimed!, token, 'SYNTHETIC OCR TEXT')).toBe(true);
		// deleted entity fences snapshot and terminal failure (엔티티 fencing; job 은 owner fence 로 실패 처리)
		await DB.prepare('UPDATE entities SET deleted_at=?, generation=generation+1 WHERE id=?').bind(new Date().toISOString(), id).run();
		expect(await loadInngestItemSnapshot(env, claimed!)).toBeNull();
		expect(await markInngestItemFailed(env, jobId, id, 1, runId, 'SYNTHETIC terminal failure')).toBe(true);
		const fencedRecord = JSON.parse(((await DB.prepare('SELECT record_json FROM entities WHERE id=?').bind(id).first<{ record_json: string }>())?.record_json ?? '{}') as string) as { status: string };
		expect(fencedRecord.status).not.toBe('failed');
	});
});

describe('signed SDK protocol: 멀티모달 image_url infer가 실제 AIGateway operation으로 통과', () => {
	it('runs OCR(모델 분리)→분석 infer를 통과해 기존 저장/API 계약으로 done이 된다', async () => {
		const events: Array<{ name: string; id: string; data: Record<string, unknown> }> = [];
		vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
			expect(String(url)).toBe('https://inn.gs/e/synthetic-event-key');
			events.push(...(JSON.parse(String(init?.body)) as typeof events));
			return new Response(JSON.stringify({ status: 200, ids: ['SYNTHETIC'] }), { status: 200 });
		}));
		const { DB, OBJECTS } = sqliteBindings(); migrate(DB);
		const env = { DB, OBJECTS, WORKBOOKS_JSON: JSON.stringify(workbooks), ...config } as unknown as CloudflareEnv;
		const jpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 140, b: 60 } } }).jpeg().toBuffer();
		const created = await uploadFixture(env, new Uint8Array(jpeg), 'idem-proto');
		expect(created.status).toBe(201);
		const { id } = await created.json() as { id: string };
		const app = makeSliceApp(env);
		const outbox = await DB.prepare('SELECT job_id FROM item_outbox WHERE entity_id=?').bind(id).first<{ job_id: string }>();
		const event = { name: 'ymath/item.requested', data: { jobId: outbox!.job_id, entityId: id, entityGeneration: 1 } };
		const run = driver(app, event, 'ymath-synthetic-slice-item-analysis');
		const ocrContent = '<|LOC_0|># 문제\n다음 중 OCRMARKER-X7 의 값은?';
		const result = await advance(run, [
			{ choices: [{ finish_reason: 'stop', message: { content: ocrContent } }] },
			analysisResponse('OCRMARKER-X7')
		], (gateway, index) => {
			if (index === 0) {
				expect(gateway.opts.type).toBe('step.ai.infer');
				expect(gateway.opts.url).toBe('https://llm.example.test/v1/chat/completions');
				expect(gateway.opts.body?.model).toBe('PaddleOCR-VL-1.6-mlx');
				expect(gateway.opts).toHaveProperty('timeout', '2m');
				expect(gateway.opts.body?.max_tokens).toBe(8192);
				expect(gateway.opts.body?.temperature).toBe(0);
				expect(gateway.opts.body?.stream).toBe(false);
				const messages = gateway.opts.body?.messages as Array<{ role: string; content: unknown }>;
				expect(messages[0].role).toBe('system');
				const parts = messages[1].content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
				expect(parts[0].type).toBe('image_url');
				expect(parts[0].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
				expect(parts[1].text).toContain('Markdown 본문만 출력하세요');
			} else if (index === 1) {
				expect(gateway.opts.body?.model).toBe('synthetic-model');
				const messages = gateway.opts.body?.messages as Array<{ role: string; content: unknown }>;
				expect(messages[0].role).toBe('system');
				expect(messages[0].content).toContain('JSON Schema를 엄격히 준수');
				const parts = messages[1].content as Array<{ type: string; image_url?: { url: string }; text?: string }>;
				expect(parts[0].type).toBe('image_url');
				expect(parts[0].image_url?.url).toMatch(/^data:image\/jpeg;base64,/);
				expect(parts[1].text).toContain('OCRMARKER-X7');
				expect(parts[1].text).toContain('준수해야 할 JSON Schema');
			}
		});
		expect(result.result.status).toBe(200);
		expect(result.result.body).toMatchObject({ status: 'done' });
		expect(result.gateways).toHaveLength(2);
		// OCR이 R2에 저장되고 기존 GET API로 읽힌다
		const entity = await DB.prepare('SELECT ocr_key, record_json FROM entities WHERE id=?').bind(id).first<{ ocr_key: string; record_json: string }>();
		expect(entity?.ocr_key).toBeTruthy();
		const ocrObject = await OBJECTS.get(entity!.ocr_key);
		expect(new TextDecoder().decode(new Uint8Array(await new Response(ocrObject!.body).arrayBuffer()))).toContain('OCRMARKER-X7');
		expect(entity!.record_json).toContain('"status":"done"');
		const got = await getItem({ platform: { env }, params: { id } } as never);
		expect(got.status).toBe(200);
		const stored = await got.json() as { status: string; analysis: { problem: { text_md: string } }; flags: { ocr_missing: boolean } };
		expect(stored.status).toBe('done');
		expect(stored.analysis.problem.text_md).toContain('OCRMARKER-X7');
		expect(stored.flags.ocr_missing).toBe(false);
	});

	it('falls back to photo-only analysis when OCR fails (ocr_missing), like the legacy queue', async () => {
		const events: Array<{ name: string; id: string; data: Record<string, unknown> }> = [];
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 200, ids: ['X'] }), { status: 200 })));
		const { DB, OBJECTS } = sqliteBindings(); migrate(DB);
		const env = { DB, OBJECTS, WORKBOOKS_JSON: JSON.stringify(workbooks), ...config } as unknown as CloudflareEnv;
		const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#224466' } }).jpeg().toBuffer();
		const created = await uploadFixture(env, new Uint8Array(jpeg), 'idem-fallback');
		const { id } = await created.json() as { id: string };
		const app = makeSliceApp(env);
		const outbox = await DB.prepare('SELECT job_id FROM item_outbox WHERE entity_id=?').bind(id).first<{ job_id: string }>();
		const run = driver(app, { name: 'ymath/item.requested', data: { jobId: outbox!.job_id, entityId: id, entityGeneration: 1 } }, 'ymath-synthetic-slice-item-analysis');
		let sawOcrMissingPrompt = false;
		const result = await advance(run, [
			{ choices: [{ finish_reason: 'stop', message: { content: '   ' } }] },
			analysisResponse('FALLBACK')
		], (gateway, index) => {
			if (index === 1) {
				const parts = (gateway.opts.body?.messages as Array<{ content: Array<{ text?: string }> }>)[1].content;
				sawOcrMissingPrompt = (parts[1].text ?? '').includes('(OCR 결과 없음. 사진만 보고 분석하세요)');
			}
		});
		expect(result.result.status).toBe(200);
		expect(result.result.body).toMatchObject({ status: 'done' });
		expect(sawOcrMissingPrompt).toBe(true);
		const row = await DB.prepare('SELECT record_json FROM entities WHERE id=?').bind(id).first<{ record_json: string }>();
		expect(row).not.toBeNull();
		const record = JSON.parse(row!.record_json) as { status: string; flags: { ocr_missing: boolean } };
		expect(record.status).toBe('done');
		expect(record.flags.ocr_missing).toBe(true);
	});

	it('fences a delete while analysis infer is pending and routes terminal failure through signed onFailure', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 200, ids: ['X'] }), { status: 200 })));
		const { DB, OBJECTS } = sqliteBindings(); migrate(DB);
		const env = { DB, OBJECTS, WORKBOOKS_JSON: JSON.stringify(workbooks), ...config } as unknown as CloudflareEnv;
		const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#876543' } }).jpeg().toBuffer();
		const created = await uploadFixture(env, new Uint8Array(jpeg), 'idem-fence');
		const { id } = await created.json() as { id: string };
		const app = makeSliceApp(env);
		const outbox = await DB.prepare('SELECT job_id FROM item_outbox WHERE entity_id=?').bind(id).first<{ job_id: string }>();
		const run = driver(app, { name: 'ymath/item.requested', data: { jobId: outbox!.job_id, entityId: id, entityGeneration: 1 } }, 'ymath-synthetic-slice-item-analysis');
		// advance through the OCR gateway and hold at the analysis gateway
		let firstCall = await run.call();
		let gatewayCount = 0;
		for (let i = 0; i < 20; i++) {
			const op = (firstCall.body as Array<{ op: string; id: string }>)[0];
			if (op.op === 'StepPlanned') firstCall = await run.call(op.id);
			else if (op.op === 'StepRun') { run.steps[op.id] = { type: 'data', data: (firstCall.body as Array<{ op: string; id: string; data?: unknown }>)[0].data }; firstCall = await run.call(); }
			else if (op.op === 'AIGateway') {
				gatewayCount++;
				if (gatewayCount === 1) { run.steps[op.id] = { type: 'data', data: { choices: [{ finish_reason: 'stop', message: { content: '<|LOC_1|>문제: LATE 마커가 포함된 OCR' } }] } }; firstCall = await run.call(); }
				else break;
			}
			else throw new Error(`unexpected ${op.op}`);
		}
		const gatewayOp = (firstCall.body as Array<{ op: string; id: string }>)[0];
		// OCR gateway completes (first), analysis gateway (second) reached: supply OCR result and continue to next gateway
		// delete while pending
		const deleted = await deleteItem({ platform: { env }, params: { id }, request: new Request(`https://math.test/math/api/items/${id}`, { method: 'DELETE', headers: { 'x-requested-with': 'ymath' } }) } as never);
		expect(deleted.status).toBe(204);
		run.steps[gatewayOp.id] = { type: 'data', data: analysisResponse('LATE') };
		let final = await run.call();
		for (let i = 0; i < 25 && final.status === 206; i++) {
			const op = (final.body as Array<{ op: string; id: string; data?: unknown }>)[0];
			if (op.op === 'StepPlanned') final = await run.call(op.id);
			else if (op.op === 'StepRun') { run.steps[op.id] = { type: 'data', data: op.data }; final = await run.call(); }
			else if (op.op === 'AIGateway') { run.steps[op.id] = { type: 'data', data: analysisResponse('LATE') }; final = await run.call(); }
			else { if (process.env.DEBUG_ITEM_R2) console.error('[final op]', JSON.stringify(op).slice(0, 300)); throw new Error(`unexpected ${op.op}`); }
		}
		expect(final.status).toBe(200);
		expect(final.body).toMatchObject({ status: 'stale_result_rejected' });
		const state = await DB.prepare('SELECT record_json, deleted_at FROM entities WHERE id=?').bind(id).first<{ record_json: string; deleted_at: string | null }>();
		expect(state?.deleted_at).toBeTruthy();
		// 핸들러 직접 호출이라 error(404) 가 예외로 던져진다
		await expect(getItem({ platform: { env }, params: { id } } as never)).rejects.toMatchObject({ status: 404 });

		// terminal failure path on a fresh item
		const created2 = await uploadFixture(env, new Uint8Array(jpeg), 'idem-fail');
		const { id: id2 } = await created2.json() as { id: string };
		const app2 = makeSliceApp(env);
		const outbox2 = await DB.prepare('SELECT job_id FROM item_outbox WHERE entity_id=?').bind(id2).first<{ job_id: string }>();
		const failing = driver(app2, { name: 'ymath/item.requested', data: { jobId: outbox2!.job_id, entityId: id2, entityGeneration: 1 } }, 'ymath-synthetic-slice-item-analysis');
		const stopped = await advance(failing, []);
		expect(stopped.failedStep || stopped.gateways.length).toBeTruthy();
		const original = { name: 'ymath/item.requested', data: { jobId: outbox2!.job_id, entityId: id2, entityGeneration: 1 } };
		const failureEvent = { name: 'inngest/function.failed', data: { event: original, error: { name: 'Error', message: 'SYNTHETIC provider exhaustion' }, function_id: 'item-analysis', run_id: failing.runId } };
		const terminal = await advance(driver(app2, failureEvent, 'ymath-synthetic-slice-item-analysis-failure'), []);
		expect(terminal.result.status).toBe(200);
		const failedRow = await DB.prepare('SELECT record_json FROM entities WHERE id=?').bind(id2).first<{ record_json: string }>();
		expect(failedRow).not.toBeNull();
		const failedRecord = JSON.parse(failedRow!.record_json) as { status: string; error: string | null };
		expect(failedRecord.status).toBe('failed');
		expect(failedRecord.error).toContain('exhausted its configured attempts');
		// retry after failure queues generation 2 with a fresh outbox row
		const retryUrl = new URL(`https://math.test/math/api/items/${id2}/retry`);
		const retried = await retryItem({ platform: { env }, params: { id: id2 }, url: retryUrl, request: new Request(retryUrl, { method: 'POST', headers: { 'x-requested-with': 'ymath' } }), getClientAddress: () => '127.0.0.81' } as never);
		expect(retried.status).toBe(202);
		const next = await DB.prepare('SELECT generation, job_id, state FROM item_outbox WHERE entity_id=? AND generation=2').bind(id2).first<{ generation: number; job_id: string; state: string }>();
		expect(next?.generation).toBe(2);
		// 재시도 라우트도 즉시 발행하므로 sent 다
		expect(next?.state).toBe('sent');
		expect(await OBJECTS.get(`items/${id2}/ocr-${next!.job_id}-2.txt`)).toBeNull();
	});
});
