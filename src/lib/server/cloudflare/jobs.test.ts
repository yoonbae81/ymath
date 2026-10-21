import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { claimJob, commitJobResult, failJob, heartbeatJob, type D1DatabaseLike } from './jobs';
import { claimCloudJob, type CloudflareEnv } from './runtime';

function sqlite() {
	const sql = new DatabaseSync(':memory:');
	sql.exec(readFileSync(new URL('../../../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
	const db = {
		prepare(query: string) {
			return {
				values: [] as SQLInputValue[], bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; },
				async first<T>() { return (sql.prepare(query).get(...this.values) as T | undefined) ?? null; },
				async all<T>() { return { results: sql.prepare(query).all(...this.values) as T[] }; },
				async run() { const result = sql.prepare(query).run(...this.values); return { meta: { changes: Number(result.changes) } }; }
			};
		}
	} as unknown as D1DatabaseLike;
	return { sql, db };
}

function seed(sql: DatabaseSync, id: string, provider: string, createdAt = '2026-01-01T00:00:00.000Z') {
	sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,updated_at) VALUES(?,'item',?,'queued',1,?)").run(`e-${id}`, createdAt, createdAt);
	sql.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at) VALUES(? ,?,'item',1,'queued',?,'{}',?,?)").run(id, `e-${id}`, provider, createdAt, createdAt);
}

describe('durable jobs against real SQLite', () => {
	let sql: DatabaseSync;
	let db: D1DatabaseLike;
	beforeEach(() => { ({ sql, db } = sqlite()); });

	it('keeps an ISO lease live and applies provider lanes to queued and expired jobs', async () => {
		seed(sql, 'a', 'omlx'); seed(sql, 'b', 'omlx'); seed(sql, 'c', 'agy');
		const a = await claimJob(db, 'runner-a', '2026-01-01T00:00:00.000Z', 120);
		expect(a).toMatchObject({ id: 'a', generation: 1 });
		expect(sql.prepare('SELECT lease_until FROM jobs WHERE id=?').get('a')).toMatchObject({ lease_until: '2026-01-01T00:02:00.000Z' });
		expect((await claimJob(db, 'runner-c', '2026-01-01T00:00:01.000Z', 120))?.id).toBe('c');
		expect(await claimJob(db, 'runner-b', '2026-01-01T00:00:01.000Z', 120)).toBeNull();
		const reclaimed = await claimJob(db, 'runner-b', '2026-01-01T00:02:01.000Z', 120);
		expect(reclaimed?.id).toBe('a');
		sql.prepare("UPDATE jobs SET state='done',lease_until=NULL WHERE id='a'").run();
		expect((await claimJob(db, 'runner-b', '2026-01-01T00:02:02.000Z', 120))?.id).toBe('b');
	});

	it('excludes concurrent same-provider claims but permits another provider', async () => {
		seed(sql, 'a', 'omlx'); seed(sql, 'b', 'omlx'); seed(sql, 'c', 'agy');
		const [first, second] = await Promise.all([claimJob(db, 'r1', '2026-01-01T00:00:00.000Z', 60), claimJob(db, 'r2', '2026-01-01T00:00:00.000Z', 60)]);
		expect([first?.id, second?.id].filter(Boolean)).toHaveLength(2);
		expect([first?.id, second?.id]).not.toContain('b');
		expect((await claimJob(db, 'r3', '2026-01-01T00:00:00.000Z', 60))).toBeNull();
	});

	it('can fence the legacy runner to item-only jobs when report execution moves to Inngest', async () => {
		seed(sql, 'a', 'omlx');
		sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES('report','report','2025-12-31T00:00:00.000Z','queued',1,'{}','2025-12-31T00:00:00.000Z')").run();
		sql.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at) VALUES('report-job','report','report',1,'queued','omlx','{}','2025-12-31T00:00:00.000Z','2025-12-31T00:00:00.000Z')").run();
		expect((await claimJob(db, 'runner', '2026-01-01T00:00:00.000Z', 120, 'item'))?.id).toBe('a');
		expect(sql.prepare("SELECT state FROM jobs WHERE id='report-job'").get()).toMatchObject({ state: 'queued' });
	});

	it('keeps a pre-existing report job away from the runner after explicit Inngest selection', async () => {
		const { sql, db } = sqlite();
		const report = { schema_version: 1, id: '20260101-000000-rep-abcd', created_at: '2026-01-01T00:00:00.000Z', topic: '대수', period: '', period_label: '전체 기간', status: 'queued', error: null, attempts: 0, item_ids: [], items_fingerprint: '', summary: null, markdown: null, meta: null };
		sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES(?,'report',?,'queued',1,?,?)").run(report.id, report.created_at, JSON.stringify(report), report.created_at);
		sql.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at) VALUES('legacy-report-job',?,'report',1,'queued','omlx','{}',?,?)").run(report.id, report.created_at, report.created_at);
		const env = { DB: db, REPORT_BACKEND: 'inngest' } as unknown as CloudflareEnv;
		expect(await claimCloudJob(env, 'legacy-runner')).toBeNull();
		expect(sql.prepare("SELECT state FROM jobs WHERE id='legacy-report-job'").get()).toMatchObject({ state: 'queued' });
	});

	it('fences stale heartbeat/failure and persists retry delay then terminal failure', async () => {
		seed(sql, 'a', 'omlx');
		const job = (await claimJob(db, 'runner', '2026-01-01T00:00:00.000Z', 60))!;
		expect(await heartbeatJob(db, job, job.lease_token, '2026-01-01T00:00:30.000Z', 60)).toBe(true);
		expect(await failJob(db, job, 'wrong', '2026-01-01T00:00:31.000Z', 'stale', 30)).toBe(false);
		expect(await failJob(db, job, job.lease_token, '2026-01-01T00:00:31.000Z', '429 rate limited', 45)).toBe(true);
		expect(sql.prepare('SELECT state,retry_at,last_error FROM jobs WHERE id=?').get('a')).toMatchObject({ state: 'queued', retry_at: '2026-01-01T00:01:16.000Z', last_error: '429 rate limited' });
		expect(await claimJob(db, 'early', '2026-01-01T00:01:00.000Z', 60)).toBeNull();
		const retry = (await claimJob(db, 'retry', '2026-01-01T00:01:17.000Z', 60))!;
		for (let attempt = 3; attempt <= 6; attempt++) {
			expect(await failJob(db, retry, retry.lease_token, '2026-01-01T00:02:00.000Z', 'provider failed', 1)).toBe(true);
			if (attempt < 6) {
				const next = (await claimJob(db, 'retry', `2026-01-01T00:02:0${attempt + 1}.000Z`, 60))!;
				Object.assign(retry, next);
			}
		}
		expect(sql.prepare('SELECT state,attempts FROM jobs WHERE id=?').get('a')).toMatchObject({ state: 'failed', attempts: 5 });
	});

	it('rejects expired, duplicate, reclaimed, and deleted-entity results', async () => {
		seed(sql, 'a', 'omlx');
		const first = (await claimJob(db, 'one', '2026-01-01T00:00:00.000Z', 10))!;
		expect(await commitJobResult(db, first, '2026-01-01T00:00:11.000Z', 'expired')).toBe(false);
		const second = (await claimJob(db, 'two', '2026-01-01T00:00:11.000Z', 10))!;
		expect(await commitJobResult(db, first, '2026-01-01T00:00:12.000Z', 'stale-token')).toBe(false);
		expect(await commitJobResult(db, second, '2026-01-01T00:00:12.000Z', 'saved')).toBe(true);
		expect(await commitJobResult(db, second, '2026-01-01T00:00:12.000Z', 'duplicate')).toBe(false);
		seed(sql, 'b', 'agy', '2026-01-01T00:01:00.000Z');
		const deleted = (await claimJob(db, 'three', '2026-01-01T00:01:00.000Z', 10))!;
		sql.prepare("UPDATE entities SET deleted_at='2026-01-01T00:01:01.000Z',generation=generation+1 WHERE id='e-b'").run();
		expect(await commitJobResult(db, deleted, '2026-01-01T00:01:02.000Z', 'late-after-delete')).toBe(false);
	});

	it('marks an expired fifth lease terminal instead of leaving it stuck leased', async () => {
		seed(sql, 'a', 'omlx');
		sql.prepare("UPDATE jobs SET state='leased',attempts=5,lease_until='2025-12-31T23:59:59.000Z',lease_token='expired' WHERE id='a'").run();
		expect(await claimJob(db, 'next', '2026-01-01T00:00:00.000Z', 10)).toBeNull();
		expect(sql.prepare("SELECT state,lease_token FROM jobs WHERE id='a'").get()).toMatchObject({ state: 'failed', lease_token: null });
		expect(sql.prepare("SELECT status FROM entities WHERE id='e-a'").get()).toMatchObject({ status: 'failed' });
	});

	it('marks the report metadata failed when its fifth lease expires and leaves it retryable', async () => {
		const id = '20261017-090000-rep-abcd';
		const report = { id, status: 'generating', attempts: 5, error: null, markdown: null };
		sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES(?,'report','2026-10-17T08:00:00.000Z','generating',1,?,'2026-10-17T08:00:00.000Z')").run(id, JSON.stringify(report));
		sql.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,provider,payload,attempts,lease_until,created_at,updated_at) VALUES('report-expiry',?,'report',1,'leased','omlx','{}',5,'2026-10-17T08:00:01.000Z','2026-10-17T08:00:00.000Z','2026-10-17T08:00:00.000Z')").run(id);
		expect(await claimJob(db, 'replacement', '2026-10-17T09:00:00.000Z', 120)).toBeNull();
		expect(sql.prepare('SELECT status,report_json FROM entities WHERE id=?').get(id)).toMatchObject({ status: 'failed' });
		expect(JSON.parse((sql.prepare('SELECT report_json FROM entities WHERE id=?').get(id) as { report_json: string }).report_json)).toMatchObject({ status: 'failed', error: 'runner lease expired after maximum attempts' });
	});
});
