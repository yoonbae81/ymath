import type { ReportRecord } from '$lib/types';
import type { D1DatabaseLike } from './jobs';

export async function claimInngestReport(db: D1DatabaseLike, id: string, generation: number, owner: string, now = new Date().toISOString()): Promise<ReportRecord | null> {
	if (!owner) throw new Error('Inngest report run owner is required');
	const row = await db.prepare(`UPDATE entities SET status='generating',report_owner=?,updated_at=?,report_json=json_set(report_json,'$.status','generating',
		'$.attempts',COALESCE(json_extract(report_json,'$.attempts'),0)+1,'$.error',NULL)
		WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND status='queued'
		RETURNING report_json`).bind(owner,now,id,generation).first<{ report_json: string }>();
	if (row?.report_json) return JSON.parse(row.report_json) as ReportRecord;
	const existing = await db.prepare(`SELECT report_json FROM entities WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND status='generating' AND report_owner=?`)
		.bind(id,generation,owner).first<{report_json:string}>();
	return existing?.report_json ? JSON.parse(existing.report_json) as ReportRecord : null;
}

export async function markInngestReportFailed(db: D1DatabaseLike, id: string, generation: number, message: string, now = new Date().toISOString(), owner?: string): Promise<boolean> {
	const bounded = message.slice(0, 1000);
	const result = await db.prepare(`UPDATE entities SET status='failed',updated_at=?,report_json=json_set(report_json,'$.status','failed','$.error',?)
		WHERE id=? AND kind='report' AND deleted_at IS NULL AND generation=? AND status IN ('queued','generating') AND (? IS NULL OR report_owner=?)`)
		.bind(now,bounded, id,generation,owner ?? null,owner ?? null).run();
	return (result.meta?.changes as number | undefined) === 1;
}
