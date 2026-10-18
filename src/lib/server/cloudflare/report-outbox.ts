import type { D1DatabaseLike } from './jobs';

export interface ReportOutboxEvent { name: 'ymath/report.requested'; id: string; data: { reportId: string; generation: number } }
export interface ReportOutboxPublisher { (event: ReportOutboxEvent): Promise<unknown> }
interface LeasedOutbox { report_id: string; generation: number; lease_token: string }

export function cloudReportBackend(env: { REPORT_BACKEND?: string }): 'runner' | 'inngest' {
	return env.REPORT_BACKEND === 'inngest' ? 'inngest' : 'runner';
}

export async function publishRecoverableReportOutbox(db: D1DatabaseLike, send: ReportOutboxPublisher, now = new Date().toISOString()) {
	return publishPendingReportOutbox(db, send, now);
}

/** Leased D1 outbox publication. Event IDs are stable per report generation, so
 * an accepted event with a lost acknowledgement can safely be sent again. */
export async function publishPendingReportOutbox(
	db: D1DatabaseLike, send: ReportOutboxPublisher, now = new Date().toISOString(), limit = 20, leaseSeconds = 55
) {
	let sent = 0;
	let failed = 0;
	for (let index = 0; index < Math.max(0, Math.min(100, limit)); index++) {
		const token = crypto.randomUUID();
		const row = await db.prepare(`UPDATE report_outbox SET state='publishing',attempts=attempts+1,lease_token=?,
			lease_until=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+' || ? || ' seconds'),updated_at=?
			WHERE (report_id,generation)=(SELECT o.report_id,o.generation FROM report_outbox o JOIN entities e ON e.id=o.report_id
				WHERE e.kind='report' AND e.deleted_at IS NULL AND e.generation=o.generation
				AND (o.state='pending' OR (o.state='publishing' AND o.lease_until<=?))
				ORDER BY o.created_at,o.report_id LIMIT 1)
			AND (state='pending' OR (state='publishing' AND lease_until<=?))
			RETURNING report_id,generation,lease_token`)
			.bind(token, now, leaseSeconds, now, now, now).first<LeasedOutbox>();
		if (!row) break;
		const event: ReportOutboxEvent = { name: 'ymath/report.requested', id: `report-${row.report_id}-${row.generation}`, data: { reportId: row.report_id, generation: row.generation } };
		try {
			await send(event);
			await db.prepare(`UPDATE report_outbox SET state='sent',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=?
				WHERE report_id=? AND generation=? AND state='publishing' AND lease_token=?`)
				.bind(now, row.report_id, row.generation, token).run();
			await db.prepare(`UPDATE entities SET report_json=json_set(report_json,'$.error',NULL) WHERE id=? AND kind='report' AND generation=? AND deleted_at IS NULL AND status='queued'`)
				.bind(row.report_id, row.generation).run();
			sent++;
		} catch (cause) {
			const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
			await db.prepare(`UPDATE report_outbox SET last_error=?,updated_at=?
				WHERE report_id=? AND generation=? AND state='publishing' AND lease_token=?`)
				.bind(message, now, row.report_id, row.generation, token).run();
			await db.prepare(`UPDATE entities SET report_json=json_set(report_json,'$.error',?) WHERE id=? AND kind='report' AND generation=? AND deleted_at IS NULL AND status='queued'`)
				.bind(`Report event publication pending retry: ${message}`, row.report_id, row.generation).run();
			failed++;
		}
	}
	return { sent, failed };
}
