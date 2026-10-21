import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createItemAnalysisHandler } from './inngest-item';
import type { CloudflareEnv } from './runtime';

const storage = new Map<string, Uint8Array>();
vi.mock('./s3-store', () => ({
	requireS3Store: () => ({
		async put(key: string, bytes: Uint8Array, _type?: string) { storage.set(key, bytes); },
		async get(key: string) { return storage.get(key) ?? null; },
		async delete(key: string) { storage.delete(key); }
	})
}));

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(ocrText?: string) {
	const sql = new DatabaseSync(':memory:');
	databases.push(sql);
	for (const name of ['0001_initial.sql', '0003_item_ocr.sql']) {
		sql.exec(readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), 'utf8'));
	}
	const DB = {
		prepare(query: string) {
			const statement = sql.prepare(query);
			let values: SQLInputValue[] = [];
			const wrapped = {
				bind(...args: unknown[]) { values = args as SQLInputValue[]; return wrapped; },
				async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
				async all<T>() { return { results: statement.all(...values) as T[] }; },
				async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; }
			};
			return wrapped;
		}
	};
	const record = { schema_version: 1, id: 'i1', status: 'queued', attempts: 0, error: null,
		workbook: { id: 'w', name: '문제집', publisher: 'p', grade: '중3', semester: 2 },
		image: 'image.jpg', analysis: null, meta: null, flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] },
		requested_provider: undefined as string | undefined };
	sql.prepare(`INSERT INTO entities(id,kind,created_at,status,generation,record_json,image_key,ocr_key,updated_at)
		VALUES('20260101-010000-0001','item','2026-01-01','queued',1,?,'image.jpg',?,'2026-01-01')`).run(JSON.stringify(record), ocrText ? 'ocr.txt' : null);
	sql.exec(`INSERT INTO jobs(id,entity_id,kind,entity_generation,state,created_at,updated_at)
		VALUES('550e8400-e29b-41d4-a716-446655440000','20260101-010000-0001','item',1,'queued','2026-01-01','2026-01-01')`);
	const objects = new Map<string, Uint8Array>([['image.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9])]]);
	if (ocrText) objects.set('ocr.txt', new TextEncoder().encode(ocrText));
	const env = { DB, S3: {
		async get(key: string) { return objects.get(key) ?? null; },
		async put(key: string, bytes: Uint8Array, type?: string) { objects.set(key, bytes); },
		async delete(key: string) { objects.delete(key); }
	}, INNGEST_EVENT_KEY: 'local-event', INNGEST_SIGNING_KEY: 'local-signing', OMLX_API_KEY: 'local-test', OMLX_BASE_URL: 'https://example.test/v1', OMLX_MODEL: 'local-test' } as unknown as CloudflareEnv;
	const handler = createItemAnalysisHandler(env, {
		guidelineRaw: '# 테스트',
		curriculumRaw: readFileSync(new URL('../../../../user/prompts/curriculum.md', import.meta.url), 'utf8'),
		batonSend: async (_event: { name: string; id: string; data: Record<string, unknown> }) => { throw new Error('should not reach batonSend in status fixture'); }
	});
	const state = () => {
		const row = sql.prepare("SELECT status, record_json, updated_at FROM entities WHERE id='20260101-010000-0001'").get() as { status: string; record_json: string; updated_at: string };
		return { ...row, record: JSON.parse(row.record_json) };
	};
	const eventPayload = { jobId: '550e8400-e29b-41d4-a716-446655440000', entityId: '20260101-010000-0001', entityGeneration: 1 };
	async function run(beforeStep?: (id: string) => void) {
		return handler({ event: { data: eventPayload }, runId: 'run1', step: {
			async run<T>(id: string, callback: () => T | Promise<T>) { beforeStep?.(id); return callback(); },
			async sleep() { throw new Error('status-only fixture must not sleep'); },
			async waitForEvent() { throw new Error('status-only fixture must not waitForEvent'); },
			ai: { infer: (async () => { throw new Error('inference must not run'); }) }
		} });
	}
	return { sql, state, run, eventPayload, env };
}

const stop = new Error('local test stop');

describe('Inngest item API-visible stages', () => {
	it.each(['fresh', 'cached', 'failed'] as const)('rejects analysis step with INPUT_INVALID after %s OCR when batonSend throws', async (mode) => {
		const f = fixture(mode === 'cached' ? 'cached OCR' : undefined);
		const handler = createItemAnalysisHandler(f.env, {
			guidelineRaw: '# 테스트',
			curriculumRaw: readFileSync(new URL('../../../../user/prompts/curriculum.md', import.meta.url), 'utf8'),
			batonSend: async (_event: { name: string; id: string; data: Record<string, unknown> }) => { throw new Error('batonSend not available'); }
		});
		// The handler proceeds through claim-item-job, mark-item-ocr, load-item-snapshot,
		// normalize-item-image, then runBatonAnalysis. Inside runBatonAnalysis, build-baton-request
		// uploads to S3 (works), publish-baton-request-0 calls batonSend (throws).
		// The step callback throws "batonSend not available" which bubbles up.
		await expect(handler({ event: { data: f.eventPayload }, runId: 'run1', step: {
			async run<T>(id: string, callback: () => T | Promise<T>) { return callback(); },
			async sleep() { throw new Error('no sleep'); },
			async waitForEvent() { throw new Error('no wait'); },
			ai: { infer: (async () => { throw new Error('no infer'); }) }
		}})).rejects.toThrow('batonSend not available');
	});

	const fences = [
		['entity generation', "UPDATE entities SET generation=generation+1"],
		['deleted entity', "UPDATE entities SET deleted_at='2026-01-02'"],
		['job generation', 'UPDATE jobs SET generation=generation+1'],
		['lease token', "UPDATE jobs SET lease_token='new-owner-token'"],
		['expired lease', "UPDATE jobs SET lease_until='2000-01-01'"],
		['completed job', "UPDATE jobs SET state='done'"],
		['job entity generation', 'UPDATE jobs SET entity_generation=entity_generation+1'],
		['job entity identity', "INSERT INTO entities(id,kind,created_at,status,updated_at) VALUES('20260101-010000-0002','item','2026-01-01','queued','2026-01-01'); UPDATE jobs SET entity_id='20260101-010000-0002'"]
	] as const;

	it.each(fences)('rejects mark-item-ocr after stale %s without changing entity status', async (_name, mutation) => {
		const f = fixture('cached OCR');
		let before: ReturnType<typeof f.state> | undefined;
		let reachedFence = false;
		const result = await f.run((id) => {
			if (id === 'mark-item-ocr') {
				reachedFence = true;
				f.sql.exec(mutation);
				before = f.state();
			}
		});
		expect(reachedFence).toBe(true);
		expect(result).toEqual({ status: 'stale_result_rejected' });
		expect(f.state()).toEqual(before);
	});
});
