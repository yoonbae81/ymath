import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { cloudReportBackend, publishPendingReportOutbox, publishRecoverableReportOutbox } from './report-outbox';
import type { D1DatabaseLike } from './jobs';

function database() {
	const sql = new DatabaseSync(':memory:');
	sql.exec(readFileSync(new URL('../../../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
	sql.exec(readFileSync(new URL('../../../../migrations/0005_report_outbox.sql', import.meta.url), 'utf8'));
	const db = { prepare(query: string) { return { values: [] as SQLInputValue[], bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }, async first<T>() { return (sql.prepare(query).get(...this.values) as T | undefined) ?? null; }, async all<T>() { return { results: sql.prepare(query).all(...this.values) as T[] }; }, async run() { const result = sql.prepare(query).run(...this.values); return { meta: { changes: Number(result.changes) } }; } }; } } as unknown as D1DatabaseLike;
	return { sql, db };
}
function seed(sql: DatabaseSync, status: string, leaseUntil: string | null = null) {
	const id = '20261017-080000-rep-abcd';
	const report = { schema_version: 1, id, created_at: '2026-10-17T08:00:00Z', topic: '대수', period: '2026-10', period_label: '2026-10', status: 'queued', error: null, attempts: 0, item_ids: [], items_fingerprint: '', summary: null, markdown: null, meta: null };
	sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES(?,'report',?,'queued',1,?,?)").run(id, report.created_at, JSON.stringify(report), report.created_at);
	sql.prepare('INSERT INTO report_outbox(report_id,generation,state,attempts,lease_until,created_at,updated_at) VALUES(?,1,?,0,?,?,?)').run(id, status, leaseUntil, report.created_at, report.created_at);
	return id;
}

describe('durable application report outbox', () => {
	it('defaults to the existing runner and requires explicit Inngest selection', () => {
		expect(cloudReportBackend({})).toBe('runner');
		expect(cloudReportBackend({ REPORT_BACKEND: 'runner' })).toBe('runner');
		expect(cloudReportBackend({ REPORT_BACKEND: 'inngest' })).toBe('inngest');
	});
	it('recovers a committed outbox row after a crash before event publishing', async () => {
		const { sql, db } = database(); const id = seed(sql, 'pending'); const events: unknown[] = [];
		const result = await publishPendingReportOutbox(db, async (event) => { events.push(event); }, '2026-10-17T09:00:00.000Z');
		expect(result).toMatchObject({ sent: 1, failed: 0 });
		expect(events).toEqual([{ name: 'ymath/report.requested', id: `report-${id}-1`, data: { reportId: id, generation: 1 } }]);
		expect(sql.prepare('SELECT state FROM report_outbox').get()).toMatchObject({ state: 'sent' });
	});
	it('does not import legacy queued reports when the execution flag starts', async () => {
		const { sql, db } = database(); const id = seed(sql, 'pending');
		sql.prepare('DELETE FROM report_outbox WHERE report_id=?').run(id);
		const events: unknown[] = [];
		expect(await publishRecoverableReportOutbox(db, async (event) => { events.push(event); }, '2026-10-17T09:00:00.000Z')).toMatchObject({ sent: 0, failed: 0 });
		expect(events).toHaveLength(0);
		expect(sql.prepare('SELECT COUNT(*) AS count FROM report_outbox').get()).toMatchObject({ count: 0 });
	});
	it('retries failed publishing and treats duplicate event acceptance idempotently', async () => {
		const { sql, db } = database(); const id = seed(sql, 'pending'); const accepted = new Set<string>(); let deliveries = 0;
		const unreliable = async (event: { id: string }) => { if (!accepted.has(event.id)) { accepted.add(event.id); deliveries++; throw new Error('synthetic lost publish acknowledgement'); } };
		expect(await publishPendingReportOutbox(db, unreliable, '2026-10-17T09:00:00.000Z')).toMatchObject({ sent: 0, failed: 1 });
		expect(sql.prepare('SELECT state,attempts,last_error FROM report_outbox').get()).toMatchObject({ state: 'publishing', attempts: 1, last_error: 'synthetic lost publish acknowledgement' });
		expect(await publishPendingReportOutbox(db, unreliable, '2026-10-17T09:01:00.000Z')).toMatchObject({ sent: 1, failed: 0 });
		expect(await publishPendingReportOutbox(db, unreliable, '2026-10-17T09:01:01.000Z')).toMatchObject({ sent: 0, failed: 0 });
		expect(deliveries).toBe(1);
		expect(sql.prepare('SELECT report_id,state FROM report_outbox').get()).toMatchObject({ report_id: id, state: 'sent' });
	});
	it('reclaims a publisher lease after process death and does not publish stale generations', async () => {
		const { sql, db } = database(); const id = seed(sql, 'publishing', '2026-10-17T08:59:00.000Z'); const sent: unknown[] = [];
		expect(await publishPendingReportOutbox(db, async (event) => { sent.push(event); }, '2026-10-17T09:00:00.000Z')).toMatchObject({ sent: 1 });
		sql.prepare("UPDATE entities SET generation=2 WHERE id=?").run(id);
		expect(await publishPendingReportOutbox(db, async (event) => { sent.push(event); }, '2026-10-17T09:00:01.000Z')).toMatchObject({ sent: 0, failed: 0 });
		expect(sent).toHaveLength(1);
	});
	it('leases and dispatches only one exact composite generation row for a report', async () => {
		const { sql, db } = database(); const id = seed(sql, 'pending');
		sql.prepare("UPDATE entities SET generation=2 WHERE id=?").run(id);
		sql.prepare("UPDATE report_outbox SET state='publishing',lease_until='2026-10-17T08:59:00.000Z' WHERE report_id=? AND generation=1").run(id);
		sql.prepare("INSERT INTO report_outbox(report_id,generation,state,attempts,created_at,updated_at) VALUES(?,2,'pending',0,'2026-10-17T08:01:00Z','2026-10-17T08:01:00Z')").run(id);
		const events: Array<{ data: { generation: number } }> = [];
		expect(await publishPendingReportOutbox(db, async (event) => { events.push(event); }, '2026-10-17T09:00:00.000Z', 1)).toMatchObject({ sent: 1, failed: 0 });
		expect(events).toHaveLength(1);
		expect(events[0].data.generation).toBe(2);
		expect(sql.prepare('SELECT generation,state,lease_until FROM report_outbox ORDER BY generation').all()).toEqual([
			{ generation: 1, state: 'publishing', lease_until: '2026-10-17T08:59:00.000Z' }, { generation: 2, state: 'sent', lease_until: null }
		]);
	});
});
