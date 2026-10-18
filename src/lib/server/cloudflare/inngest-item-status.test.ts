import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createItemAnalysisHandler } from './inngest-item';
import type { CloudflareEnv } from './runtime';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

// Same real-SQLite D1 seam as inngest-item.test.ts; inference never reaches a network.
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
		image: 'image.jpg', analysis: null, meta: null, flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] } };
	sql.prepare(`INSERT INTO entities(id,kind,created_at,status,generation,record_json,image_key,ocr_key,updated_at)
		VALUES('i1','item','2026-01-01','queued',1,?,'image.jpg',?,'2026-01-01')`).run(JSON.stringify(record), ocrText ? 'ocr.txt' : null);
	sql.exec(`INSERT INTO jobs(id,entity_id,kind,entity_generation,state,created_at,updated_at)
		VALUES('j1','i1','item',1,'queued','2026-01-01','2026-01-01')`);
	const objects = new Map<string, Uint8Array>([['image.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9])]]);
	if (ocrText) objects.set('ocr.txt', new TextEncoder().encode(ocrText));
	const env = { DB, OBJECTS: {
		async get(key: string) { const bytes = objects.get(key); return bytes ? { body: new Response(new Uint8Array(bytes)).body! } : null; },
		async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
		async delete(key: string) { objects.delete(key); }
	}, INNGEST_EVENT_KEY: 'local-event', INNGEST_SIGNING_KEY: 'local-signing', LLM_API_KEY: 'local-test', LLM_BASE_URL: 'https://example.test/v1', LLM_MODEL: 'local-test' } as unknown as CloudflareEnv;
	const handler = createItemAnalysisHandler(env, {
		guidelineRaw: '# 테스트',
		curriculumRaw: readFileSync(new URL('../../../../user/prompts/curriculum.md', import.meta.url), 'utf8')
	});
	const state = () => {
		const row = sql.prepare('SELECT status, record_json, updated_at FROM entities WHERE id=\'i1\'').get() as { status: string; record_json: string; updated_at: string };
		return { ...row, record: JSON.parse(row.record_json) };
	};
	async function run(beforeStep?: (id: string) => void, infer?: (id: string) => Promise<unknown>) {
		return handler({ event: { data: { jobId: 'j1', entityId: 'i1', entityGeneration: 1 } }, runId: 'run1', step: {
			async run<T>(id: string, callback: () => T | Promise<T>) { beforeStep?.(id); return callback(); },
			async sleep() { throw new Error('status-only fixture must not sleep'); },
			ai: { infer: infer ?? (async () => { throw new Error('inference must not run'); }) }
		} });
	}
	return { sql, state, run };
}

const stop = new Error('local test stop');
describe('Inngest item API-visible stages', () => {
	it.each(['fresh', 'cached', 'failed'] as const)('sets analyzing before analysis inference after %s OCR', async (mode) => {
		const f = fixture(mode === 'cached' ? 'cached OCR' : undefined);
		const observed: Array<{ id: string; status: string; recordStatus: string; attempts: number }> = [];
		await expect(f.run((id) => { if (id === 'retry-item-attempt-0') throw stop; }, async (id) => {
			const state = f.state();
			observed.push({ id, status: state.status, recordStatus: state.record.status, attempts: state.record.attempts });
			if (id === 'infer-item-ocr') return { choices: [{ message: { content: mode === 'failed' ? ' ' : 'local OCR' } }] };
			throw stop;
		})).rejects.toBe(stop);
		expect(observed).toEqual([
			...(mode === 'cached' ? [] : [{ id: 'infer-item-ocr', status: 'ocr', recordStatus: 'ocr', attempts: 1 }]),
			{ id: 'infer-item-analysis', status: 'analyzing', recordStatus: 'analyzing', attempts: 1 }
		]);
	});
	const fences = [
		['entity generation', "UPDATE entities SET generation=generation+1"],
		['deleted entity', "UPDATE entities SET deleted_at='2026-01-02'"],
		['job generation', 'UPDATE jobs SET generation=generation+1'],
		['lease token', "UPDATE jobs SET lease_token='new-owner-token'"],
		['expired lease', "UPDATE jobs SET lease_until='2000-01-01'"],
		['completed job', "UPDATE jobs SET state='done'"],
		['job entity generation', 'UPDATE jobs SET entity_generation=entity_generation+1'],
		['job entity identity', "INSERT INTO entities(id,kind,created_at,status,updated_at) VALUES('i2','item','2026-01-01','queued','2026-01-01'); UPDATE jobs SET entity_id='i2'"]
	] as const;
	for (const stage of ['ocr', 'analyzing'] as const) {
		it.each(fences)(`rejects ${stage} transition after stale %s without changing entity status`, async (_name, mutation) => {
			const f = fixture('cached OCR');
			let before: ReturnType<typeof f.state> | undefined;
			let reachedFence = false;
			const result = await f.run((id) => {
				if (id === `mark-item-${stage}`) {
					reachedFence = true;
					f.sql.exec(mutation);
					before = f.state();
				}
			});
			expect(reachedFence).toBe(true);
			expect(result).toEqual({ status: 'stale_result_rejected' });
			expect(f.state()).toEqual(before);
		});
	}
	it('sets both entity and record OCR status with durable attempts before normalization', async () => {
		const f = fixture();
		await expect(f.run((id) => {
			if (id === 'normalize-item-image') {
				expect(f.state()).toMatchObject({ status: 'ocr', record: { status: 'ocr', attempts: 1 } });
				throw stop;
			}
		})).rejects.toBe(stop);
	});
});
