import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { acceptItem, consumeRateLimit, markViewed, saveFeedback, setFavorite, tombstoneEntity } from './repository';
import type { D1DatabaseLike, D1Statement } from './jobs';

function sqlite() {
	const sql = new DatabaseSync(':memory:');
	sql.exec(readFileSync(new URL('../../../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
	const statement = (query: string) => ({
		values: [] as SQLInputValue[], bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; },
		async first<T>() { return (sql.prepare(query).get(...this.values) as T | undefined) ?? null; },
		async all<T>() { return { results: sql.prepare(query).all(...this.values) as T[] }; },
		async run() { const result = sql.prepare(query).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
	});
	const db = {
		prepare: statement,
		async batch<T = unknown>(statements: D1Statement[]) {
			sql.exec('BEGIN IMMEDIATE');
			try {
				const out = [];
				for (const item of statements) out.push(await (item as ReturnType<typeof statement>).run());
				sql.exec('COMMIT'); return out as T[];
			} catch (e) { sql.exec('ROLLBACK'); throw e; }
		}
	} as unknown as D1DatabaseLike & { batch<T = unknown>(statements: D1Statement[]): Promise<T[]> };
	return { sql, db };
}

const record = (analyzedAt: string, status = 'done') => JSON.stringify({ status, meta: { analyzed_at: analyzedAt } });
const feedback = (analyzedAt: string, comment: string) => ({ choice: 'accurate' as const, comment, created_at: analyzedAt, analyzed_at: analyzedAt, prompt_version: 'v1', model: 'fixture' });

describe('D1 repository behavior on real SQLite', () => {
	it('preserves simultaneous favorite and viewed updates in independent columns', async () => {
		const { sql, db } = sqlite();
		sql.prepare("INSERT INTO entities(id,kind,created_at,status,record_json,updated_at) VALUES('e','item','now','done',?,'now')").run(record('a'));
		const results = await Promise.all([setFavorite(db, 'e', true, 'fav'), markViewed(db, 'e', 'view')]);
		expect(results).toEqual([true, true]);
		expect(sql.prepare('SELECT favorite,viewed_at FROM entities WHERE id=\'e\'').get()).toEqual({ favorite: 1, viewed_at: 'view' });
	});

	it('allows feedback only for the current completed analysis and atomically upserts it', async () => {
		const { sql, db } = sqlite();
		sql.prepare("INSERT INTO entities(id,kind,created_at,status,record_json,updated_at) VALUES('e','item','now','done',?,'now')").run(record('current'));
		expect(await saveFeedback(db, 'e', 'stale', feedback('stale', 'old'))).toBe(false);
		sql.prepare("UPDATE entities SET status='analyzing' WHERE id='e'").run();
		expect(await saveFeedback(db, 'e', 'current', feedback('current', 'during analysis'))).toBe(false);
		sql.prepare("UPDATE entities SET status='done' WHERE id='e'").run();
		const [first, second] = await Promise.all([saveFeedback(db, 'e', 'current', feedback('current', 'one')), saveFeedback(db, 'e', 'current', feedback('current', 'two'))]);
		expect(first && second).toBe(true);
		expect(sql.prepare('SELECT COUNT(*) AS count FROM feedback WHERE entity_id=\'e\'').get()).toEqual({ count: 1 });
	});

	it('accepts an uncertain upload retry with the same idempotency key as one item and one job', async () => {
		const { sql, db } = sqlite();
		const workbook = { id: 'w', name: 'Fixture', publisher: 'Local', grade: 'G1', semester: 1 } as never;
		const first = await acceptItem(db as never, { workbook, imageKey: '', rawKey: 'raw-1', idempotencyKey: 'same-key', now: '2026-01-01T00:00:00.000Z' });
		const retry = await acceptItem(db as never, { workbook, imageKey: '', rawKey: 'raw-2', idempotencyKey: 'same-key', now: '2026-01-01T00:00:01.000Z' });
		expect(first.created).toBe(true); expect(retry).toEqual({ id: first.id, created: false });
		expect(sql.prepare('SELECT COUNT(*) AS count FROM entities').get()).toEqual({ count: 1 });
		expect(sql.prepare('SELECT COUNT(*) AS count FROM jobs').get()).toEqual({ count: 1 });
	});

	it('tombstones the entity and cancels leases so late work cannot be accepted', async () => {
		const { sql, db } = sqlite();
		sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,updated_at) VALUES('e','item','now','queued',1,'now')").run();
		sql.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,payload,created_at,updated_at) VALUES('j','e','item',1,'leased','{}','now','now')").run();
		expect(await tombstoneEntity(db, 'e')).toBe(true);
		expect(sql.prepare('SELECT deleted_at,generation FROM entities WHERE id=\'e\'').get()).toMatchObject({ generation: 2 });
		expect(sql.prepare('SELECT state,lease_token FROM jobs WHERE id=\'j\'').get()).toMatchObject({ state: 'cancelled', lease_token: null });
	});

	it('uses shared atomic rate counter values', async () => {
		const { db } = sqlite();
		expect(await consumeRateLimit(db, 'client', 1000, 10_000, 2)).toBe(true);
		expect(await consumeRateLimit(db, 'client', 2000, 10_000, 2)).toBe(true);
		expect(await consumeRateLimit(db, 'client', 3000, 10_000, 2)).toBe(false);
	});
});
