/** item 분석 Inngest 전환: D1 fencing·outbox·스냅샷·실행 핸들러.
 * 기존 저장 계약은 commitCloudResult(기존 runner와 동일 S3/D1 구조)를 재사용해 보존한다. */
import { StepError } from 'inngest';
import type { ItemRecord } from '$lib/types';
import { currentFeedback } from '$lib/types';
import type { ClaimedJob, D1DatabaseLike } from './jobs';
import { cloudItem, commitCloudResult, hasImageMagicBytes, persistCloudNormalizedImage, resolveS3, updateCloudJobStage, workbooksFromEnv, type CloudflareEnv } from './runtime';
import { normalizeCloudImage } from './item-normalize';
import { parseTaxonomy, buildAnalysisSchema } from '../taxonomy-core';

import { cloudItemBackend } from './jobs';
import { runBatonAnalysis } from './baton-analysis';
import type { BatonTriggerPublisher } from './baton-analysis';

export { cloudItemBackend };
export const DEFAULT_OCR_MODEL = 'PaddleOCR-VL-1.6-mlx';
export const ITEM_EVENT_NAME = 'ymath/item.requested';
export const BATON_COMPLETION_EVENT = 'ymath/item.baton.completed';
export const ITEM_FUNCTION_ID = 'item-analysis';
/** 실행/재시도 전이마다 갱신하는 기본 lease. 429 대기는 별도로 대기 시간만큼 먼저 연장한다. */
export const ITEM_LEASE_SECONDS = 30 * 60;

/** Atomic compare-and-claim of the durable item job by the Inngest run. */
export async function claimInngestItem(db: D1DatabaseLike, jobId: string, entityId: string, entityGeneration: number, owner: string, now = new Date().toISOString(), leaseSeconds = ITEM_LEASE_SECONDS): Promise<ClaimedJob | null> {
	if (!owner) throw new Error('Inngest item run owner is required');
	const leaseToken = crypto.randomUUID();
	const row = await db.prepare(`UPDATE jobs SET state='leased', lease_owner=?, lease_token=?,
		lease_until=strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || ? || ' seconds'),
		generation=generation+1, attempts=attempts+1, updated_at=?
		WHERE id=? AND entity_id=? AND entity_generation=? AND state='queued'
		RETURNING id, entity_id, kind, generation, entity_generation, lease_token, payload, provider`)
		.bind(owner, leaseToken, now, leaseSeconds, now, jobId, entityId, entityGeneration).first<ClaimedJob>();
	if (row) return row;
	// 클레임 응답 유실 후 같은 run 이 재개한 경우(멱등 재클레임).
	const existing = await db.prepare(`SELECT id, entity_id, kind, generation, entity_generation, lease_token, payload, provider
		FROM jobs WHERE id=? AND entity_id=? AND entity_generation=? AND state='leased' AND lease_owner=?`)
		.bind(jobId, entityId, entityGeneration, owner).first<ClaimedJob>();
	return existing ?? null;
}

export interface ItemSnapshot {
	record: ItemRecord;
	knownPatterns: { id: string; count: number; example: string }[];
	imageKey: string | null;
	rawKey: string | null;
	ocrText: string | null;
}

/** 기존 runner claimCloudJob 의 item 스냅샷 구성을 동일 계약으로 수행한다. */
export async function loadInngestItemSnapshot(env: CloudflareEnv, job: ClaimedJob): Promise<ItemSnapshot | null> {
	const entity = await env.DB.prepare('SELECT raw_key, image_key, record_json, ocr_key FROM entities WHERE id = ? AND deleted_at IS NULL AND generation = ?')
		.bind(job.entity_id, job.entity_generation).first<{ raw_key: string | null; image_key: string | null; record_json: string; ocr_key: string | null }>();
	if (!entity) return null;
	const record = JSON.parse(entity.record_json) as ItemRecord;
	if (job.provider) record.requested_provider = job.provider as ItemRecord['requested_provider'];
	const feedback = await env.DB.prepare('SELECT payload_json FROM feedback WHERE entity_id = ? ORDER BY updated_at').bind(job.entity_id).all<{ payload_json: string }>();
	record.feedback = (feedback.results ?? []).map((entry) => JSON.parse(entry.payload_json));
	const patterns = await env.DB.prepare(`SELECT json_extract(record_json,'$.analysis.error_analysis.error_pattern_id') AS id, COUNT(*) AS count,
		MIN(json_extract(record_json,'$.analysis.error_analysis.misconception')) AS example FROM entities WHERE kind='item' AND status='done' AND deleted_at IS NULL
		AND json_extract(record_json,'$.analysis.error_analysis.error_pattern_id') IS NOT NULL
		AND json_extract(record_json,'$.analysis.error_analysis.error_pattern_id') != 'unconfirmed'
		GROUP BY id ORDER BY count DESC LIMIT 60`).all<{ id: string; count: number; example: string }>();
	let ocrText: string | null = null;
	if (entity.ocr_key) {
		const bytes = await resolveS3(env).get(entity.ocr_key);
		// OCR text is capped at 1,000,000 characters (legacy stream cap preserved).
		if (bytes && bytes.byteLength <= 1_000_000) ocrText = new TextDecoder().decode(bytes);
	}
	return { record, knownPatterns: patterns.results ?? [], imageKey: entity.image_key || null, rawKey: entity.raw_key || null, ocrText };
}

/** Terminal failure after Inngest retries are exhausted. Owner/generation-fenced; cannot touch done items.
 * jobs.generation 은 claim 때마다 증가해 onFailure 가 알 수 없으므로 run owner(유일)로 fence 한다. */
export async function markInngestItemFailed(env: CloudflareEnv, jobId: string, entityId: string, entityGeneration: number, owner: string, message: string, now = new Date().toISOString(), fence?: { generation: number; token: string; attempts: number }): Promise<boolean> {
	const bounded = message.slice(0, 1000);
	const failureMarker = fence ? JSON.stringify([owner, fence.generation, fence.token, fence.attempts]) : crypto.randomUUID();
	const out = await env.DB.batch([
		env.DB.prepare(`UPDATE jobs SET state='failed', last_error=?, lease_owner=NULL, lease_token=NULL, lease_until=NULL, updated_at=?,
			payload=json_set(payload,'$.inngest_failure_marker',?)
			WHERE id=? AND lease_owner=? AND state='leased' AND entity_id=? AND entity_generation=?
			AND (? IS NULL OR (generation=? AND lease_token=? AND attempts=? AND lease_until>?
			AND EXISTS (SELECT 1 FROM entities e WHERE e.id=jobs.entity_id AND e.generation=jobs.entity_generation
			AND e.deleted_at IS NULL AND e.status IN ('queued','ocr','analyzing'))))`)
			.bind(bounded, now, failureMarker, jobId, owner, entityId, entityGeneration, fence?.generation ?? null, fence?.generation ?? null,
				fence?.token ?? null, fence?.attempts ?? null, now),
		env.DB.prepare(`UPDATE entities SET status='failed', updated_at=?,
			record_json=json_set(record_json,'$.status','failed','$.error',?)
			WHERE id=? AND kind='item' AND deleted_at IS NULL AND generation=? AND status IN ('queued','ocr','analyzing','failed') AND EXISTS
			(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND entity_generation=? AND state='failed'
			AND json_extract(payload,'$.inngest_failure_marker')=? AND (? IS NULL OR (generation=? AND attempts=?)))`)
			.bind(now, bounded, entityId, entityGeneration, jobId, entityGeneration, failureMarker,
				fence?.generation ?? null, fence?.generation ?? null, fence?.attempts ?? null)
	]);
	const ok = ((out[0] as { meta?: { changes?: number } })?.meta?.changes ?? 0) === 1 || !!(fence &&
		await env.DB.prepare(`SELECT 1 FROM jobs j JOIN entities e ON e.id=j.entity_id WHERE j.id=? AND j.entity_id=?
			AND j.entity_generation=? AND j.generation=? AND j.attempts=? AND j.state='failed'
			AND json_extract(j.payload,'$.inngest_failure_marker')=? AND j.last_error=?
			AND e.generation=j.entity_generation AND e.deleted_at IS NULL AND e.status='failed'`)
			.bind(jobId, entityId, entityGeneration, fence.generation, fence.attempts, failureMarker, bounded).first());
	if (ok) {
		const raw = await env.DB.prepare('SELECT raw_key FROM entities WHERE id=? AND deleted_at IS NULL').bind(entityId).first<{ raw_key: string | null }>();
		if (raw?.raw_key) await resolveS3(env).delete(raw.raw_key).catch(() => undefined);
	}
	return ok;
}

/** OCR 결과를 분석 커밋 전에 멱등 저장해 재시도 때 재추론하지 않게 한다(재분석 재사용은 스냅샷의 ocr_key). */
export async function persistCloudOcr(env: CloudflareEnv, job: ClaimedJob, token: string, ocrText: string, now = new Date().toISOString()): Promise<boolean> {
	const key = `items/${job.entity_id}/ocr-${job.id}-${job.generation}.txt`;
	const current = await env.DB.prepare("SELECT ocr_key FROM entities WHERE id=? AND kind='item' AND deleted_at IS NULL").bind(job.entity_id).first<{ ocr_key: string | null }>();
	if (current?.ocr_key === key) return true;
	await resolveS3(env).put(key, new TextEncoder().encode(ocrText), 'text/plain; charset=utf-8');
	const saved = await env.DB.prepare(`UPDATE entities SET ocr_key=?, updated_at=? WHERE id=? AND kind='item' AND deleted_at IS NULL
		AND generation=? AND (ocr_key IS NULL OR ocr_key='') AND EXISTS
		(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND state='leased' AND generation=? AND lease_token=? AND lease_until > ?)`)
		.bind(key, now, job.entity_id, job.entity_generation, job.id, job.generation, token, now).run();
	if ((saved.meta?.changes ?? 0) === 1) return true;
	const after = await env.DB.prepare("SELECT ocr_key FROM entities WHERE id=? AND kind='item' AND deleted_at IS NULL").bind(job.entity_id).first<{ ocr_key: string | null }>();
	if (after?.ocr_key === key) return true;
	await resolveS3(env).delete(key).catch(() => undefined);
	return false;
}

/** Durable item-outbox publication with stable event IDs (report_outbox 와 같은 계약). */
interface LeasedOutbox { entity_id: string; generation: number; job_id: string; lease_token: string; provider: string | null }
export type ItemOutboxPublisher = (event: { name: typeof ITEM_EVENT_NAME; id: string; data: { jobId: string; entityId: string; entityGeneration: number; requestedProvider?: string } }) => Promise<unknown>;

export async function publishPendingItemOutbox(db: D1DatabaseLike, send: ItemOutboxPublisher, now = new Date().toISOString(), limit = 20, leaseSeconds = 55) {
	let sent = 0;
	let failed = 0;
	for (let index = 0; index < Math.max(0, Math.min(100, limit)); index++) {
		const token = crypto.randomUUID();
		const row = await db.prepare(`UPDATE item_outbox SET state='publishing',attempts=attempts+1,lease_token=?,
			lease_until=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+' || ? || ' seconds'),updated_at=?
			WHERE (entity_id,generation)=(SELECT o.entity_id,o.generation FROM item_outbox o JOIN entities e ON e.id=o.entity_id
				WHERE e.kind='item' AND e.deleted_at IS NULL AND e.generation=o.generation AND e.status='queued'
				AND (o.state='pending' OR (o.state='publishing' AND o.lease_until<=?))
				ORDER BY o.created_at,o.entity_id LIMIT 1)
			AND (state='pending' OR (state='publishing' AND lease_until<=?))
			RETURNING entity_id,generation,job_id,lease_token,(SELECT provider FROM jobs WHERE id=job_id LIMIT 1) AS provider`)
			.bind(token, now, leaseSeconds, now, now, now).first<LeasedOutbox>();
		if (!row) break;
		const event = { name: ITEM_EVENT_NAME, id: `item-${row.entity_id}-${row.generation}`, data: { jobId: row.job_id, entityId: row.entity_id, entityGeneration: row.generation, requestedProvider: row.provider ?? undefined } } as const;
		try {
			await send(event);
			await db.prepare(`UPDATE item_outbox SET state='sent',lease_token=NULL,lease_until=NULL,last_error=NULL,updated_at=?
				WHERE entity_id=? AND generation=? AND state='publishing' AND lease_token=?`)
				.bind(now, row.entity_id, row.generation, token).run();
			sent++;
		} catch (cause) {
			const message = (cause instanceof Error ? cause.message : String(cause)).slice(0, 500);
			await db.prepare(`UPDATE item_outbox SET last_error=?,updated_at=? WHERE entity_id=? AND generation=? AND state='publishing' AND lease_token=?`)
				.bind(message, now, row.entity_id, row.generation, token).run();
			await db.prepare(`UPDATE entities SET record_json=json_set(record_json,'$.error',?) WHERE id=? AND kind='item' AND generation=? AND deleted_at IS NULL AND status='queued'`)
				.bind(`분석 이벤트 발행이 대기 중입니다(자동 재시도): ${message}`, row.entity_id, row.generation).run();
			failed++;
		}
	}
	return { sent, failed };
}

export async function readObjectBytes(env: CloudflareEnv, key: string): Promise<Uint8Array> {
	const bytes = await resolveS3(env).get(key);
	if (!bytes) throw new Error(`S3 object missing: ${key}`);
	return bytes;
}

export interface ItemAnalysisOptions {
	/** user/prompts/analyze.md 원문(빌드 타임 ?raw import). */
	guidelineRaw: string;
	/** user/prompts/curriculum.md 원문(빌드 타임 ?raw import). */
	curriculumRaw: string;
	/** ITEM_ANALYSIS_BACKEND=baton 때 baton 트리거 이벤트 발행기(app.ts 가 client.send 로 주입). */
	batonSend?: BatonTriggerPublisher;
	/** baton 모델 요청에 넣을 학생 이름(env.STUDENT_NAME 와 같은 계약). */
	studentName?: string;
}

/** queue.ts defaults, not SDK attempt counts. Worker bindings mirror the Node settings. */
type ItemRetryEnv = CloudflareEnv & { ANALYZE_MAX_ATTEMPTS?: string; QUOTA_RETRY_DELAY_MS?: string; ANALYZE_TIMEOUT_MS?: string };

/** Keep the sleeping run as the sole owner. Extend BEFORE sleep and renew on wake;
 * never resurrect an expired/stolen/deleted generation. The transition marker makes
 * a committed-but-response-lost step replay safe (no double refund/increment). */
export async function transitionItemRetry(env: CloudflareEnv, job: ClaimedJob, owner: string, transition: string,
	expectedAttempts: number, attempts: number, status: 'queued' | 'analyzing', message: string | null, waitMs = 0) {
	const now = new Date().toISOString();
	const leaseSeconds = ITEM_LEASE_SECONDS + Math.ceil(waitMs / 1000);
	await env.DB.batch([
		env.DB.prepare(`UPDATE jobs SET attempts=?,last_error=?,updated_at=?,
			lease_until=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+' || ? || ' seconds'),
			payload=json_set(payload,'$.inngest_retry_transition',?)
			WHERE id=? AND entity_id=? AND entity_generation=? AND generation=? AND lease_owner=? AND lease_token=?
			AND state='leased' AND lease_until>? AND attempts=?
			AND COALESCE(json_extract(payload,'$.inngest_retry_transition'),'')!=?
			AND EXISTS (SELECT 1 FROM entities e WHERE e.id=jobs.entity_id AND e.generation=jobs.entity_generation
			AND e.deleted_at IS NULL AND e.status IN ('queued','ocr','analyzing'))`)
			.bind(attempts, message, now, now, leaseSeconds, transition, job.id, job.entity_id, job.entity_generation,
				job.generation, owner, job.lease_token, now, expectedAttempts, transition),
		env.DB.prepare(`UPDATE entities SET status=?,updated_at=?,record_json=json_set(record_json,'$.status',?,'$.attempts',?,'$.error',?)
			WHERE id=? AND generation=? AND deleted_at IS NULL AND status IN ('queued','ocr','analyzing') AND EXISTS
			(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND entity_generation=entities.generation
			AND generation=? AND lease_owner=? AND lease_token=? AND state='leased' AND lease_until>?
			AND attempts=? AND json_extract(payload,'$.inngest_retry_transition')=?)`)
			.bind(status, now, status, attempts, message, job.entity_id, job.entity_generation, job.id, job.generation,
				owner, job.lease_token, now, attempts, transition)
	]);
	return !!await env.DB.prepare(`SELECT 1 FROM jobs j JOIN entities e ON e.id=j.entity_id
		WHERE j.id=? AND j.entity_id=? AND j.generation=? AND j.entity_generation=? AND j.lease_owner=? AND j.lease_token=?
		AND j.state='leased' AND j.lease_until>? AND j.attempts=? AND json_extract(j.payload,'$.inngest_retry_transition')=?
		AND e.generation=j.entity_generation AND e.deleted_at IS NULL AND e.status=?`)
		.bind(job.id, job.entity_id, job.generation, job.entity_generation, owner, job.lease_token, now, attempts, transition, status).first();
}

export type ItemInferStep = (id: string, options: { model: ReturnType<typeof import('inngest').openai>; body: Record<string, unknown> }) => Promise<unknown>;

/** item 분석 Inngest function 본문. 기존 analyze 프롬프트/스키마/guardrail/taxonomy 계약을 그대로 수행한다. */
export function createItemAnalysisHandler(env: CloudflareEnv, options: ItemAnalysisOptions) {
	return async ({ event, step, runId }: {
		event: { data: { jobId?: unknown; entityId?: unknown; entityGeneration?: unknown } };
		step: {
			run<T>(id: string, callback: () => T | Promise<T>): Promise<T>;
			sleep(id: string, duration: number): Promise<unknown>;
			waitForEvent(id: string, options: { event: string; timeout: string; if?: string }): Promise<unknown>;
			ai: { infer(id: string, options: { model: unknown; body: Record<string, unknown>; timeout?: string }): Promise<unknown> };
		};
		runId: string;
	}) => {
		const jobId = event.data.jobId;
		const entityId = event.data.entityId;
		const entityGeneration = event.data.entityGeneration;
		if (typeof jobId !== 'string' || typeof entityId !== 'string' || typeof entityGeneration !== 'number' || !Number.isSafeInteger(entityGeneration)) {
			throw new Error('jobId/entityId/entityGeneration missing from event');
		}
		const claimed = await step.run('claim-item-job', () => claimInngestItem(env.DB, jobId, entityId, entityGeneration, runId));
		if (!claimed) return { status: 'duplicate_or_stale_generation' };
		const ocrStage = await step.run('mark-item-ocr', () => updateCloudJobStage(env, claimed, claimed.lease_token, 'ocr'));
		if (!ocrStage) return { status: 'stale_result_rejected' };
		const snapshot = await step.run('load-item-snapshot', () => loadInngestItemSnapshot(env, claimed));
		if (!snapshot) return { status: 'entity_unavailable' };

		const normalized = await step.run('normalize-item-image', async () => {
			if (snapshot.imageKey) return { imageKey: snapshot.imageKey, reused: true };
			if (!snapshot.rawKey) throw new Error('정규화할 원본 이미지가 없습니다');
			const raw = await readObjectBytes(env, snapshot.rawKey);
			const { jpeg } = await normalizeCloudImage(raw);
			const persisted = await persistCloudNormalizedImage(env, claimed, claimed.lease_token, jpeg);
			if (!persisted) throw new Error('정규화 이미지 저장에 실패했습니다');
			return { imageKey: `items/${entityId}/normalized-${entityGeneration}.jpg`, reused: false };
		});

		const taxonomy = parseTaxonomy(options.curriculumRaw);
		const schema = buildAnalysisSchema(taxonomy);
		const ocrText = snapshot.ocrText ?? '';

		if (!options.batonSend) throw new Error('baton backend requires a trigger publisher (batonSend)');
		return runBatonAnalysis(env, claimed, {
			step, send: options.batonSend, runId,
			jobId, entityId, entityGeneration,
			imageKey: normalized.imageKey,
			ocrText,
			taxonomy, schema,
			knownPatterns: snapshot.knownPatterns,
			record: snapshot.record,
			studentName: options.studentName
		});
	};
}

/** 업로드·재분석 때 item_outbox 에 넣을 job id를 만들고 저장하는 헬퍼(acceptItem 이 사용). */
export function itemWorkbooks(value?: string) {
	return workbooksFromEnv(value);
}
