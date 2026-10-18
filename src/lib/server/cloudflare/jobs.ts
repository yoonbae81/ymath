/** Small structural types keep the storage protocol usable in Node tests and Workers. */
export interface D1Result<T = unknown> { results?: T[]; success?: boolean; meta?: Record<string, unknown> }
export interface D1Statement {
	bind(...values: unknown[]): D1Statement;
	first<T = unknown>(): Promise<T | null>;
	run(): Promise<D1Result>;
	all<T = unknown>(): Promise<D1Result<T>>;
}
export interface D1DatabaseLike { prepare(sql: string): D1Statement }
export interface ClaimedJob { id: string; entity_id: string; kind: 'item' | 'report'; generation: number; entity_generation: number; lease_token: string; payload: string; provider?: string }

/** ITEM_ANALYSIS_BACKEND 선택. REPORT_BACKEND 와 같은 패턴: unset 또는 'inngest' 외 값은 기존 runner 소유를 유지한다. */
export function cloudItemBackend(env: { ITEM_ANALYSIS_BACKEND?: string }): 'runner' | 'inngest' {
	return env.ITEM_ANALYSIS_BACKEND === 'inngest' ? 'inngest' : 'runner';
}

/** ITEM_ANALYSIS_BACKEND 와 REPORT_BACKEND 조합에서 runner 가 claim할 job kind.
 * 둘 다 inngest 면 runner가 남길 작업이 없음을 null 로 알린다(이중실행 방지). */
export function runnerClaimableKind(env: { REPORT_BACKEND?: string; ITEM_ANALYSIS_BACKEND?: string }): 'item' | 'report' | 'both' | null {
	const ownsReports = env.REPORT_BACKEND !== 'inngest';
	const ownsItems = env.ITEM_ANALYSIS_BACKEND !== 'inngest';
	if (ownsReports && ownsItems) return 'both';
	if (ownsReports) return 'report';
	if (ownsItems) return 'item';
	return null;
}

/** Atomic compare-and-claim. RETURNING ensures only one runner receives an available row. */
export async function claimJob(db: D1DatabaseLike, runnerId: string, now: string, leaseSeconds: number, kind?: ClaimedJob['kind']): Promise<ClaimedJob | null> {
	await db.prepare(`UPDATE jobs SET state='failed',last_error=COALESCE(last_error,'runner lease expired after maximum attempts'),
		lease_owner=NULL,lease_token=NULL,lease_until=NULL,updated_at=? WHERE state='leased' AND lease_until <= ? AND attempts >= 5`)
		.bind(now, now).run();
	await db.prepare(`UPDATE entities SET status='failed',updated_at=?,record_json=json_set(record_json,'$.status','failed','$.error',
		COALESCE((SELECT last_error FROM jobs WHERE jobs.entity_id=entities.id AND jobs.entity_generation=entities.generation AND jobs.state='failed' ORDER BY updated_at DESC LIMIT 1),'runner lease expired'))
		WHERE deleted_at IS NULL AND status IN ('queued','ocr','analyzing')
		AND EXISTS (SELECT 1 FROM jobs j WHERE j.entity_id=entities.id AND j.entity_generation=entities.generation AND j.state='failed' AND j.attempts >= 5)
		AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.entity_id=entities.id AND active.entity_generation=entities.generation AND active.state IN ('queued','leased'))`)
		.bind(now).run();
	await db.prepare(`UPDATE entities SET status='failed',updated_at=?,report_json=json_set(report_json,'$.status','failed','$.error',
		COALESCE((SELECT last_error FROM jobs WHERE jobs.entity_id=entities.id AND jobs.entity_generation=entities.generation AND jobs.state='failed' ORDER BY updated_at DESC LIMIT 1),'runner lease expired'))
		WHERE kind='report' AND deleted_at IS NULL AND status IN ('queued','generating')
		AND EXISTS (SELECT 1 FROM jobs j WHERE j.entity_id=entities.id AND j.entity_generation=entities.generation AND j.state='failed' AND j.attempts >= 5)
		AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.entity_id=entities.id AND active.entity_generation=entities.generation AND active.state IN ('queued','leased'))`)
		.bind(now).run();
	const leaseToken = crypto.randomUUID();
	return db.prepare(`
		UPDATE jobs
		SET state = 'leased', lease_owner = ?, lease_token = ?,
		    lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' seconds'),
		    generation = generation + 1, attempts = attempts + 1, updated_at = ?
		WHERE id = (
			SELECT id FROM jobs
			WHERE ((state = 'queued' AND COALESCE(retry_at, '') <= ?)
			   OR (state = 'leased' AND lease_until <= ?))
			AND NOT EXISTS (SELECT 1 FROM jobs active WHERE active.provider IS jobs.provider AND active.state = 'leased'
				AND active.lease_until > ? AND active.id != jobs.id)
			AND (? IS NULL OR kind = ?)
			AND attempts < 5
			ORDER BY created_at, id LIMIT 1
		)
		AND ((state = 'queued' AND COALESCE(retry_at, '') <= ?) OR (state = 'leased' AND lease_until <= ?))
		RETURNING id, entity_id, kind, generation, entity_generation, lease_token, payload, provider
	`).bind(runnerId, leaseToken, now, leaseSeconds, now, now, now, now, kind ?? null, kind ?? null, now, now).first<ClaimedJob>();
}

export async function heartbeatJob(db: D1DatabaseLike, job: ClaimedJob, token: string, now: string, leaseSeconds: number) {
	const result = await db.prepare(`UPDATE jobs SET lease_until = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' seconds'), updated_at = ?
		WHERE id = ? AND state = 'leased' AND generation = ? AND lease_token = ? AND lease_until > ?`)
		.bind(now, leaseSeconds, now, job.id, job.generation, token, now).run();
	return (result.meta?.changes as number | undefined) === 1;
}

export async function failJob(db: D1DatabaseLike, job: ClaimedJob, token: string, now: string, message: string, retryDelaySeconds: number, maxAttempts = 5) {
	const boundedMessage = message.slice(0, 1000);
	const retry = Math.max(1, Math.min(3600, Math.floor(retryDelaySeconds)));
	const result = await db.prepare(`UPDATE jobs SET
		state = CASE WHEN attempts >= ? THEN 'failed' ELSE 'queued' END,
		retry_at = CASE WHEN attempts >= ? THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' seconds') END,
		last_error = ?, lease_owner = NULL, lease_token = NULL, lease_until = NULL, updated_at = ?
		WHERE id = ? AND state = 'leased' AND generation = ? AND lease_token = ? AND lease_until > ?
		AND EXISTS (SELECT 1 FROM entities e WHERE e.id = jobs.entity_id AND e.deleted_at IS NULL AND e.generation = jobs.entity_generation)`)
		.bind(maxAttempts, maxAttempts, now, retry, boundedMessage, now, job.id, job.generation, token, now).run();
	return (result.meta?.changes as number | undefined) === 1;
}

/** A result can commit only against the current live lease and non-tombstoned entity. */
export async function commitJobResult(db: D1DatabaseLike, job: ClaimedJob, now: string, resultObjectKey: string): Promise<boolean> {
	const out = await db.prepare(`
		UPDATE jobs SET state = 'done', result_key = ?, lease_owner = NULL,
		 lease_token = NULL, lease_until = NULL, updated_at = ?
		WHERE id = ? AND state = 'leased' AND generation = ? AND lease_token = ? AND lease_until > ?
		AND EXISTS (SELECT 1 FROM entities e WHERE e.id = jobs.entity_id AND e.deleted_at IS NULL AND e.generation = jobs.entity_generation)
	`).bind(resultObjectKey, now, job.id, job.generation, job.lease_token, now).run();
	return (out.meta?.changes as number | undefined) === 1;
}
