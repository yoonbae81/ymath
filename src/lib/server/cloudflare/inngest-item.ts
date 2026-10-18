/** item 분석 Inngest 전환: D1 fencing·outbox·스냅샷·실행 핸들러.
 * 기존 저장 계약은 commitCloudResult(기존 runner와 동일 R2/D1 구조)를 재사용해 보존한다. */
import { StepError } from 'inngest';
import type { ItemRecord } from '$lib/types';
import { currentFeedback } from '$lib/types';
import type { ClaimedJob, D1DatabaseLike } from './jobs';
import { cloudItem, commitCloudResult, hasImageMagicBytes, persistCloudNormalizedImage, updateCloudJobStage, workbooksFromEnv, type CloudflareEnv } from './runtime';
import { normalizeCloudImage } from './item-normalize';
import { buildOcrMessages, markdownFromOcrResponse } from '../ocr-core';
import { MATH_COACH_SYSTEM, imageUserMessage, isQuotaOrRateLimitError, parseJsonBody, promptWithSchema } from '../llm-core';
import { buildPrompt, promptVersionAsync, validateAnalysis } from '../analyze-prompt';
import { buildAnalysisSchema, checkClassification, parseTaxonomy } from '../taxonomy-core';
import { renderPrompt } from '../prompt-template';
import { checkGuardrail } from '../guardrail';
import { openaiModel, toBase64, validateInferenceConfig, validateOpenAiResponse } from '../inngest-slice/inference';

import { cloudItemBackend } from './jobs';

export { cloudItemBackend };
export const DEFAULT_OCR_MODEL = 'PaddleOCR-VL-1.6-mlx';
export const ITEM_EVENT_NAME = 'ymath/item.requested';
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
		const object = await env.OBJECTS.get(entity.ocr_key);
		if (object) {
			const reader = object.body.getReader();
			const decoder = new TextDecoder();
			let size = 0;
			let text = '';
			let tooLarge = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 1_000_000) { tooLarge = true; await reader.cancel(); break; }
				text += decoder.decode(value, { stream: true });
			}
			if (!tooLarge) ocrText = text + decoder.decode();
		}
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
		if (raw?.raw_key) await env.OBJECTS.delete(raw.raw_key).catch(() => undefined);
	}
	return ok;
}

/** OCR 결과를 분석 커밋 전에 멱등 저장해 재시도 때 재추론하지 않게 한다(재분석 재사용은 스냅샷의 ocr_key). */
export async function persistCloudOcr(env: CloudflareEnv, job: ClaimedJob, token: string, ocrText: string, now = new Date().toISOString()): Promise<boolean> {
	const key = `items/${job.entity_id}/ocr-${job.id}-${job.generation}.txt`;
	const current = await env.DB.prepare("SELECT ocr_key FROM entities WHERE id=? AND kind='item' AND deleted_at IS NULL").bind(job.entity_id).first<{ ocr_key: string | null }>();
	if (current?.ocr_key === key) return true;
	await env.OBJECTS.put(key, new TextEncoder().encode(ocrText), { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
	const saved = await env.DB.prepare(`UPDATE entities SET ocr_key=?, updated_at=? WHERE id=? AND kind='item' AND deleted_at IS NULL
		AND generation=? AND (ocr_key IS NULL OR ocr_key='') AND EXISTS
		(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND state='leased' AND generation=? AND lease_token=? AND lease_until > ?)`)
		.bind(key, now, job.entity_id, job.entity_generation, job.id, job.generation, token, now).run();
	if ((saved.meta?.changes ?? 0) === 1) return true;
	const after = await env.DB.prepare("SELECT ocr_key FROM entities WHERE id=? AND kind='item' AND deleted_at IS NULL").bind(job.entity_id).first<{ ocr_key: string | null }>();
	if (after?.ocr_key === key) return true;
	await env.OBJECTS.delete(key).catch(() => undefined);
	return false;
}

/** Durable item-outbox publication with stable event IDs (report_outbox 와 같은 계약). */
interface LeasedOutbox { entity_id: string; generation: number; job_id: string; lease_token: string }
export type ItemOutboxPublisher = (event: { name: typeof ITEM_EVENT_NAME; id: string; data: { jobId: string; entityId: string; entityGeneration: number } }) => Promise<unknown>;

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
			RETURNING entity_id,generation,job_id,lease_token`)
			.bind(token, now, leaseSeconds, now, now, now).first<LeasedOutbox>();
		if (!row) break;
		const event = { name: ITEM_EVENT_NAME, id: `item-${row.entity_id}-${row.generation}`, data: { jobId: row.job_id, entityId: row.entity_id, entityGeneration: row.generation } } as const;
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

async function readObjectBytes(env: CloudflareEnv, key: string): Promise<Uint8Array> {
	const object = await env.OBJECTS.get(key);
	if (!object) throw new Error(`R2 object missing: ${key}`);
	return new Uint8Array(await new Response(object.body).arrayBuffer());
}

export interface ItemAnalysisOptions {
	/** user/prompts/analyze.md 원문(빌드 타임 ?raw import). */
	guidelineRaw: string;
	/** user/prompts/curriculum.md 원문(빌드 타임 ?raw import). */
	curriculumRaw: string;
}

/** queue.ts defaults, not SDK attempt counts. Worker bindings mirror the Node settings. */
type ItemRetryEnv = CloudflareEnv & { ANALYZE_MAX_ATTEMPTS?: string; QUOTA_RETRY_DELAY_MS?: string; ANALYZE_TIMEOUT_MS?: string };

/** Keep the sleeping run as the sole owner. Extend BEFORE sleep and renew on wake;
 * never resurrect an expired/stolen/deleted generation. The transition marker makes
 * a committed-but-response-lost step replay safe (no double refund/increment). */
async function transitionItemRetry(env: CloudflareEnv, job: ClaimedJob, owner: string, transition: string,
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
		// runner와 같은 API-visible 상태/attempts 계약. 오래된 실행은 추론 전에 중단한다.
		const ocrStage = await step.run('mark-item-ocr', () => updateCloudJobStage(env, claimed, claimed.lease_token, 'ocr'));
		if (!ocrStage) return { status: 'stale_result_rejected' };
		const snapshot = await step.run('load-item-snapshot', () => loadInngestItemSnapshot(env, claimed));
		if (!snapshot) return { status: 'entity_unavailable' };

		// ① R2 raw → CF 정규화(재시도 때는 image_key 로 저장된 정규화 결과를 재사용)
		const normalized = await step.run('normalize-item-image', async () => {
			if (snapshot.imageKey) return { imageKey: snapshot.imageKey, reused: true };
			if (!snapshot.rawKey) throw new Error('정규화할 원본 이미지가 없습니다');
			const raw = await readObjectBytes(env, snapshot.rawKey);
			const { jpeg } = await normalizeCloudImage(raw);
			const persisted = await persistCloudNormalizedImage(env, claimed, claimed.lease_token, jpeg);
			if (!persisted) throw new Error('정규화 이미지 저장에 실패했습니다');
			return { imageKey: `items/${entityId}/normalized-${entityGeneration}.jpg`, reused: false };
		});

		const config = validateInferenceConfig(env);
		const ocrModel = openaiModel(validateInferenceConfig({ ...env, LLM_MODEL: env.OCR_MODEL?.trim() || DEFAULT_OCR_MODEL }));

		// ② OCR: 기존 ocr.md/ocr_key 재사용, 없으면 infer(PaddleOCR-VL, base64 data URI 첨부).
		// 기존 queue/runner와 동일하게 OCR 실패 시 빈 OCR로 계속한다(ocr_missing 폴백).
		// 요청 본문 생성(R2 읽기 포함)은 step 안에서 메모이즈한다 — 재생마다 재실행돼 커밋 뒤 재생에서 깨지지 않게.
		let ocrText = snapshot.ocrText ?? '';
		let ocrMissing = false;
		if (!ocrText.trim()) {
			try {
				const request = await step.run('build-ocr-request', async () => {
					const jpeg = await readObjectBytes(env, normalized.imageKey);
					if (!hasImageMagicBytes(jpeg)) throw new Error('normalized image is not readable');
					return { imageBase64: toBase64(jpeg) };
				});
				const response = await step.ai.infer('infer-item-ocr', {
					model: ocrModel,
					timeout: '2m',
					body: { messages: buildOcrMessages(request.imageBase64), max_tokens: 8192, temperature: 0, stream: false }
				});
				ocrText = markdownFromOcrResponse(response);
				await step.run('persist-item-ocr', () => persistCloudOcr(env, claimed, claimed.lease_token, ocrText));
			} catch {
				ocrMissing = true;
				ocrText = '';
			}
		}

		// ③ 분석: 기존 buildPrompt(OCR 텍스트 + 사진 첨부 지시) + 스키마 + guardrail + taxonomy 동일 계약
		// OCR 실패 폴백/저장된 OCR 재사용도 동일하게 analyzing 으로 전환한다.
		const analysisStage = await step.run('mark-item-analyzing', async () => {
			if (!(await updateCloudJobStage(env, claimed, claimed.lease_token, 'analyzing'))) return false;
			// Terminal onFailure must retain the same OCR-missing flag as the legacy queue.
			// Persist before infer, since a gateway error never reaches commit-item-result.
			const updated = await env.DB.prepare(`UPDATE entities SET record_json=json_set(record_json,'$.flags.ocr_missing',json(?))
				WHERE id=? AND kind='item' AND deleted_at IS NULL AND generation=? AND EXISTS
				(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND entity_generation=entities.generation
				AND state='leased' AND generation=? AND lease_token=? AND lease_until>?)`)
				.bind(JSON.stringify(!ocrText.trim()), claimed.entity_id, claimed.entity_generation, claimed.id, claimed.generation, claimed.lease_token, new Date().toISOString()).run();
			return (updated.meta?.changes ?? 0) === 1;
		});
		if (!analysisStage) return { status: 'stale_result_rejected' };
		const taxonomy = parseTaxonomy(options.curriculumRaw);
		const schema = buildAnalysisSchema(taxonomy);
		const guideline = renderPrompt(options.guidelineRaw, env.STUDENT_NAME);
		const prompt = (hint?: string) => buildPrompt({
			hint,
			guideline,
			taxonomy,
			patterns: snapshot.knownPatterns,
			record: snapshot.record,
			imagePath: 'image.jpg',
			ocrText,
			feedback: currentFeedback(snapshot.record) ?? undefined,
			provider: 'omlx'
		});
		const analysisRequest = await step.run('build-analysis-request', async () => {
			const jpeg = await readObjectBytes(env, normalized.imageKey);
			return { imageBase64: toBase64(jpeg) };
		});
		const retryEnv = env as ItemRetryEnv;
		const quotaDelayMs = Number(retryEnv.QUOTA_RETRY_DELAY_MS ?? 600_000);
		let attempts = snapshot.record.attempts;
		let budgetAttempt = 1;
		const maxAttempts = Number(retryEnv.ANALYZE_MAX_ATTEMPTS ?? 2);
		const parseResponse = (response: unknown) => {
			// OpenAI-compatible endpoints can report quota errors in an HTTP 200 body.
			const providerError = (response as { error?: unknown } | null)?.error;
			if (providerError) {
				const message = typeof providerError === 'string' ? providerError :
					(providerError as { message?: string }).message || JSON.stringify(providerError);
				throw new Error(message);
			}
			const out = parseJsonBody('oMLX', validateOpenAiResponse(response));
			validateAnalysis(schema, out);
			const guard = checkGuardrail(out);
			if (guard.violations.length) throw new Error(`정답 노출 가드레일 위반: ${guard.violations.join(' / ')}`);
			return { out, guard };
		};
		let parsed: ReturnType<typeof parseResponse>;
		let lastError: string | undefined;
		for (let turn = 0; ; turn++) {
			try {
				const response = await step.ai.infer(turn === 0 ? 'infer-item-analysis' : `infer-item-analysis-${turn}`, {
					model: openaiModel(config), timeout: retryEnv.ANALYZE_TIMEOUT_MS === undefined ? '15m' : `${Number(retryEnv.ANALYZE_TIMEOUT_MS)}ms`,
					body: {
						messages: [{ role: 'system', content: MATH_COACH_SYSTEM }, imageUserMessage(analysisRequest.imageBase64, promptWithSchema(prompt(lastError), schema))],
						response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema } },
						max_tokens: 16384, temperature: 0.2
					}
				});
				parsed = parseResponse(response);
				break;
			} catch (error) {
				// StepError retains the original provider message even though the SDK
				// treats it as non-retriable. Never rely on the service retrying that ID.
				if (!(isQuotaOrRateLimitError(error) || (error instanceof StepError && error.name === 'QuotaExceededError'))) {
					// queue.ts retries ALL non-quota errors, not just timeouts, with no backoff.
					if (budgetAttempt >= maxAttempts) {
						const failed = await step.run(`fail-item-attempt-${turn}`, () => markInngestItemFailed(env,
							jobId, entityId, entityGeneration, runId, error instanceof Error ? error.message : String(error),
							undefined, { generation: claimed.generation, token: claimed.lease_token, attempts }));
						return { status: failed ? 'failed' : 'stale_result_rejected' };
					}
					const retried = await step.run(`retry-item-attempt-${turn}`, () => transitionItemRetry(env, claimed, runId,
						`retry-${turn}`, attempts, attempts + 1, 'analyzing', null));
					if (!retried) return { status: 'stale_result_rejected' };
					attempts++;
					budgetAttempt++;
					lastError = error instanceof Error ? error.message : String(error);
					continue;
				}
				budgetAttempt = 1; // queue quota re-enqueue starts a fresh maxAttempts loop.
				lastError = undefined;
				const message = `API 할당량 초과 또는 요청 제한(429)으로 ${Math.round(quotaDelayMs / 60_000)}분 후 자동으로 다시 시도합니다.`;
				const waiting = await step.run(`wait-item-quota-${turn}`, () => transitionItemRetry(env, claimed, runId,
					`wait-${turn}`, attempts, Math.max(0, attempts - 1), 'queued', message, quotaDelayMs));
				if (!waiting) return { status: 'stale_result_rejected' };
				attempts = Math.max(0, attempts - 1);
				await step.sleep(`sleep-item-quota-${turn}`, quotaDelayMs);
				const resumed = await step.run(`resume-item-quota-${turn}`, () => transitionItemRetry(env, claimed, runId,
					`resume-${turn}`, attempts, attempts + 1, 'analyzing', null));
				if (!resumed) return { status: 'stale_result_rejected' };
				attempts++;
			}
		}
		const { out, guard } = parsed;
		const issues = checkClassification(taxonomy, out);
		const course = taxonomy.unitByName.get(out.classification.unit_major)?.course;
		if (course) out.classification.course = course;
		const meta = {
			provider: 'omlx',
			model: config.model,
			prompt_version: await promptVersionAsync(guideline, options.curriculumRaw),
			analyzed_at: new Date().toISOString()
		};
		const flags = { ocr_missing: !ocrText.trim(), taxonomy_mismatch: issues, guardrail: guard.warnings };

		// ④ 기존 저장 계약(commitCloudResult: analysis/ocr R2 + entities/jobs/analyses D1).
		// 삭제로 엔티티가 사라졌으면 R2 읽기 전에 실패 확정한다(늦은 결과가 무엇도 덮지 않게).
		const saved = await step.run('commit-item-result', async () => {
			if (!(await cloudItem(env, claimed.entity_id))) return false;
			const jpeg = await readObjectBytes(env, normalized.imageKey);
			return commitCloudResult(env, claimed, claimed.lease_token, jpeg, out, meta, flags, ocrText);
		});
		return { status: saved ? 'done' : 'stale_result_rejected' };
	};
}

/** 업로드·재분석 때 item_outbox 에 넣을 job id를 만들고 저장하는 헬퍼(acceptItem 이 사용). */
export function itemWorkbooks(value?: string) {
	return workbooksFromEnv(value);
}
