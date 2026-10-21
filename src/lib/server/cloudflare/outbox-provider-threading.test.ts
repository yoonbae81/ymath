import { describe, expect, it } from 'vitest';
import { publishPendingItemOutbox } from './inngest-item';
import { DatabaseSync } from 'node:sqlite';

describe('publishPendingItemOutbox provider threading', () => {
	it('includes requestedProvider from jobs.provider in the published event', async () => {
		const sql = new DatabaseSync(':memory:');
		sql.exec(`CREATE TABLE entities (id TEXT PRIMARY KEY, kind TEXT, status TEXT, generation INTEGER, deleted_at TEXT);
		CREATE TABLE item_outbox (entity_id TEXT, generation INTEGER, job_id TEXT, state TEXT, attempts INTEGER, lease_token TEXT, lease_until TEXT, last_error TEXT, created_at TEXT, updated_at TEXT);
		CREATE TABLE jobs (id TEXT PRIMARY KEY, entity_id TEXT, provider TEXT);
		INSERT INTO entities VALUES ('20260101-010000-0001','item','queued',1,NULL);
		INSERT INTO jobs VALUES ('11111111-1111-1111-1111-111111111111','20260101-010000-0001','glm');
		INSERT INTO item_outbox (entity_id,generation,job_id,state,attempts,created_at,updated_at) VALUES ('20260101-010000-0001',1,'11111111-1111-1111-1111-111111111111','pending',0,'2026-01-01','2026-01-01');`);
		const DB = {
			prepare(query: string) {
				const statement = sql.prepare(query);
				let values: unknown[] = [];
				const wrapped = {
					bind(...args: unknown[]) { values = args; return wrapped; },
					async first<T>() { return (statement.get(...(values as never[])) as T | undefined) ?? null; },
					async all<T>() { return { results: statement.all(...(values as never[])) as T[] }; },
					async run() { return { meta: { changes: Number(statement.run(...(values as never[])).changes) } }; }
				};
				return wrapped;
			}
		};
		const sent: unknown[] = [];
		const result = await publishPendingItemOutbox(DB as never, async (event) => { sent.push(event); return { id: 'x' } as never; });
		expect(result.sent).toBe(1);
		expect((sent[0] as { data: { requestedProvider?: string } }).data.requestedProvider).toBe('glm');
	});
});
