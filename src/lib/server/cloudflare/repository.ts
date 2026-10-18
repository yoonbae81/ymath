import type { ItemRecord, Feedback } from '$lib/types';
import type { D1DatabaseLike, D1Statement } from './jobs';

type Result = { success?: boolean; meta?: { changes?: number } };
interface BatchDatabase extends D1DatabaseLike { batch<T = unknown>(statements: D1Statement[]): Promise<T[]> }
const changed = (r: Result | null) => (r?.meta?.changes ?? 0) > 0;
const idFor = (date = new Date()) => {
	const p = (x: number, n = 2) => String(x).padStart(n, '0');
	return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}-${crypto.randomUUID().replaceAll('-', '').slice(0, 4)}`;
};

/** Entity and durable job become visible together. A repeated key returns the original entity.
 * outboxJobId: ITEM_ANALYSIS_BACKEND=inngest 일 때 같은 트랜잭션으로 item_outbox 행을 넣기 위한 job id. */
export async function acceptItem(db: BatchDatabase, input: {
	workbook: ItemRecord['workbook']; imageKey: string; rawKey: string; idempotencyKey: string; provider?: string; now?: string; outboxJobId?: string;
}): Promise<{ id: string; created: boolean }> {
	const now = input.now ?? new Date().toISOString();
	const id = idFor(new Date(now));
	const record: ItemRecord = {
		schema_version: 1, id, created_at: now, status: 'queued', error: null, attempts: 0, requested_provider: input.provider as ItemRecord['requested_provider'],
		workbook: input.workbook, image: 'image.jpg', flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] }, analysis: null, meta: null
	};
	const row = {
		id, kind: 'item', created_at: now, status: 'queued', generation: 1, workbook_json: JSON.stringify(input.workbook),
		record_json: JSON.stringify(record), image_key: input.imageKey, raw_key: input.rawKey,
		idempotency_key: input.idempotencyKey, updated_at: now
	};
	const statements = [
		db.prepare(`INSERT INTO entities (id,kind,created_at,status,generation,workbook_json,record_json,image_key,raw_key,idempotency_key,updated_at)
		 VALUES (?,'item',?,'queued',1,?,?,?,?,?,?)`).bind(row.id,row.created_at,row.workbook_json,row.record_json,row.image_key,row.raw_key,row.idempotency_key,row.updated_at),
		db.prepare(`INSERT INTO jobs (id,entity_id,kind,entity_generation,state,provider,payload,created_at,updated_at)
		 VALUES (? ,?,'item',1,'queued',?,'{}',?,?)`).bind(input.outboxJobId ?? crypto.randomUUID(),id,input.provider ?? null,now,now)
	];
	if (input.outboxJobId) statements.push(
		db.prepare(`INSERT INTO item_outbox (entity_id,generation,job_id,state,attempts,created_at,updated_at)
		 VALUES (?,1,?,'pending',0,?,?)`).bind(id,input.outboxJobId,now,now)
	);
	try {
		await db.batch(statements);
		return { id, created: true };
	} catch (error) {
		const prior = await db.prepare('SELECT id FROM entities WHERE idempotency_key = ? AND deleted_at IS NULL').bind(input.idempotencyKey).first<{ id: string }>();
		if (prior) return { id: prior.id, created: false };
		throw error;
	}
}

/** Independent columns avoid overwriting a concurrent feedback or analysis update. */
export async function setFavorite(db: D1DatabaseLike, id: string, value: boolean, now = new Date().toISOString()) {
	const r = await db.prepare("UPDATE entities SET favorite = ?, updated_at = ? WHERE id = ? AND kind = 'item' AND deleted_at IS NULL")
		.bind(value ? 1 : 0, now, id).run();
	return changed(r);
}
export async function markViewed(db: D1DatabaseLike, id: string, now = new Date().toISOString()) {
	const r = await db.prepare("UPDATE entities SET viewed_at = ?, updated_at = ? WHERE id = ? AND kind = 'item' AND deleted_at IS NULL")
		.bind(now, now, id).run();
	return changed(r);
}

/** The INSERT SELECT makes status and analyzed_at validation atomic with the feedback write (409 if zero rows). */
export async function saveFeedback(db: D1DatabaseLike, id: string, analyzedAt: string, feedback: Feedback, now = new Date().toISOString()) {
	const r = await db.prepare(`INSERT INTO feedback (entity_id,analyzed_at,payload_json,updated_at)
		SELECT id, ?, ?, ? FROM entities
		WHERE id = ? AND kind = 'item' AND deleted_at IS NULL AND status = 'done'
		AND json_extract(record_json, '$.meta.analyzed_at') = ?
	ON CONFLICT(entity_id,analyzed_at) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
		.bind(analyzedAt, JSON.stringify(feedback), now, id, analyzedAt).run();
	return changed(r);
}

/** Soft delete increments the entity generation and fences every outstanding job. */
export async function tombstoneEntity(db: BatchDatabase, id: string, now = new Date().toISOString()): Promise<boolean> {
	const result = await db.batch([
		db.prepare("UPDATE entities SET deleted_at = ?, generation = generation + 1, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
			.bind(now, now, id),
		db.prepare("UPDATE jobs SET state = 'cancelled', lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = ? WHERE entity_id = ? AND state IN ('queued','leased')")
			.bind(now, id)
	]);
	return changed(result[0] as Result);
}

/** Atomic fixed-window counter shared by every Worker isolate. */
export async function consumeRateLimit(db: D1DatabaseLike, key: string, nowMs: number, windowMs: number, limit: number): Promise<boolean> {
	const start = Math.floor(nowMs / windowMs) * windowMs;
	const row = await db.prepare(`INSERT INTO rate_limits (key,window_start,count) VALUES (?, ?, 1)
		ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start,
		count = CASE WHEN rate_limits.window_start = excluded.window_start THEN rate_limits.count + 1 ELSE 1 END
		RETURNING count`).bind(key, start).first<{ count: number }>();
	return (row?.count ?? limit + 1) <= limit;
}
