/** ITEM_ANALYSIS_BACKEND=baton — Connect Runner(Baton 공통 Runner)가 호출하는
 * 단일 인증 콜백 라우트의 실제 처리기(src/routes/api/runner/items/[action]).
 *
 * 계약 근원: ymath/baton/analysis/functions.ts (양쪽이 하나의 와이어 계약을 공유한다).
 * - 모든 action 은 RUNNER_TOKEN(runnerAuthorized)으로 인증한다.
 * - jobId·entityId·entityGeneration 을 functions.ts 와 같은 정규식으로 검증하고,
 *   이벤트가 임의의 URL·경로·SQL 을 고를 수 없다(action 은 라우트 세그먼트 화이트리스트).
 * - D1 job·entity generation 과 live lease token fencing 은 기존 함수
 *   (claimInngestItem·persistCloudOcr·updateCloudJobStage·commitCloudResult·markInngestItemFailed)를
 *   그대로 재사용한다 — 콜백이 자체 SQL 을 만들지 않는다(renew 의 좁은 lease 연장 제외).
 * - hosted step.ai.infer 없음: OCR 은 설정된 OpenAI 호환 API 직접 호출이다. */
import { Inngest } from 'inngest';
import {
	batonRequestKey,
	validateBatonManifest,
	validateCompletionPayload,
	type BatonCompletionPayload
} from '../../../../baton/analysis/functions';
import { buildBatonManifest, finalizeBatonResult } from './baton-analysis';
import { normalizeCloudImage } from './item-normalize';
import { claimInngestItem, loadInngestItemSnapshot, markInngestItemFailed, persistCloudOcr, publishPendingItemOutbox, readObjectBytes, type ItemOutboxPublisher } from './inngest-item';
import type { ClaimedJob, D1DatabaseLike } from './jobs';
import { runnerAuthorized } from './runner-auth';
import { persistCloudNormalizedImage, readClaimedRaw, updateCloudJobStage, type CloudflareEnv } from './runtime';
import { requireS3Store } from './s3-store';
import { buildAnalysisSchema, parseTaxonomy } from '../taxonomy-core';
import { buildOcrMessages, markdownFromOcrResponse } from '../ocr-core';
import curriculum from '../../../../user/prompts/curriculum.md?raw';

export const ITEM_CALLBACK_ACTIONS = [
	'claim', 'snapshot', 'normalized', 'ocr', 'transition', 'renew', 'prepare', 'commit', 'failure', 'recover-outbox'
] as const;
export type ItemCallbackAction = (typeof ITEM_CALLBACK_ACTIONS)[number];

const JOB_ID = /^[0-9a-fA-F-]{36}$/;
const ENTITY_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const OBJECT_KEY = /^items\/[!-~]+$/;
const DEFAULT_OCR_MODEL = 'PaddleOCR-VL-1.6-mlx';
/** RATE_LIMITED bounded sleep 후의 lease 연장 상한(초). 숨은 무한 대기 금지. */
export const ITEM_RENEW_MAX_SECONDS = 3600;

interface ItemIds { jobId: string; entityId: string; entityGeneration: number; owner: string }
interface LeaseFence { jobId: string; entityId: string; entityGeneration: number; generation: number; lease_token: string }
interface FencedIds extends LeaseFence { owner: string }

function badRequest(reason: string): Response {
	return Response.json({ ok: false, error: reason }, { status: 400 });
}

function parseIds(body: Record<string, unknown>): ItemIds | null {
	const jobId = body.jobId;
	const entityId = body.entityId;
	const entityGeneration = body.entityGeneration;
	if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) return null;
	if (typeof entityId !== 'string' || !ENTITY_ID.test(entityId)) return null;
	if (typeof entityGeneration !== 'number' || !Number.isSafeInteger(entityGeneration) || entityGeneration < 1) return null;
	const owner = typeof body.owner === 'string' && /^[-a-zA-Z0-9_]{1,200}$/.test(body.owner) ? body.owner : 'connect-runner';
	return { jobId, entityId, entityGeneration, owner };
}

function parseFence(body: Record<string, unknown>, ids: ItemIds): FencedIds | null {
	const generation = body.generation;
	const leaseToken = body.lease_token;
	if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return null;
	if (typeof leaseToken !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(leaseToken)) return null;
	return { ...ids, generation, lease_token: leaseToken };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** lease 토큰으로 현재 leased job 행을 읽는다 — 모든 fenced action 의 진입 검증. */
async function loadLeasedItemJob(db: D1DatabaseLike, fenced: FencedIds): Promise<ClaimedJob | null> {
	return db.prepare(`SELECT id, entity_id, kind, generation, entity_generation, lease_token, payload, provider FROM jobs
		WHERE id=? AND entity_id=? AND entity_generation=? AND kind='item' AND state='leased'
		AND generation=? AND lease_token=? AND lease_until>?`)
		.bind(fenced.jobId, fenced.entityId, fenced.entityGeneration, fenced.generation, fenced.lease_token, new Date().toISOString())
		.first<ClaimedJob>();
}

/** RATE_LIMITED bounded sleep 동안의 lease 연장(좁은 단일 UPDATE, generation+token fence). */
export async function renewItemLease(db: D1DatabaseLike, fenced: LeaseFence, seconds: number): Promise<boolean> {
	const bounded = Math.max(1, Math.min(ITEM_RENEW_MAX_SECONDS, Math.floor(seconds)));
	const now = new Date().toISOString();
	const result = await db.prepare(`UPDATE jobs SET lease_until=strftime('%Y-%m-%dT%H:%M:%fZ',?,'+' || ? || ' seconds'),updated_at=?
		WHERE id=? AND entity_id=? AND entity_generation=? AND kind='item' AND state='leased'
		AND generation=? AND lease_token=? AND lease_until>?`)
		.bind(now, bounded, now, fenced.jobId, fenced.entityId, fenced.entityGeneration, fenced.generation, fenced.lease_token, now).run();
	return (result.meta?.changes ?? 0) === 1;
}

async function runDirectOcr(env: CloudflareEnv, imageKey: string): Promise<string> {
	const base = env.OMLX_BASE_URL?.trim().replace(/\/+$/, '');
	const key = env.OMLX_API_KEY?.trim();
	const model = env.OCR_MODEL?.trim() || DEFAULT_OCR_MODEL;
	if (!base || !key) throw new Error('OCR_OMLX_NOT_CONFIGURED');
	const jpeg = await readObjectBytes(env, imageKey);
	const response = await fetch(`${base}/chat/completions`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model,
			messages: buildOcrMessages(Buffer.from(jpeg).toString('base64')),
			max_tokens: 8192, temperature: 0, stream: false
		})
	});
	if (!response.ok) throw new Error(`OCR_PROVIDER_FAILED: ${response.status}`);
	return markdownFromOcrResponse(await response.json());
}

/** 단일 인증 콜백 처리기. 라우트는 env·action 만 전달한다.
 * 내부 오류(해시 불일치·검증 실패 등)는 500 {ok:false} 로 정직하게 돌아간다. */
export async function handleItemCallback(action: string, request: Request, env: CloudflareEnv): Promise<Response> {
	if (!(ITEM_CALLBACK_ACTIONS as readonly string[]).includes(action)) return badRequest('UNKNOWN_ACTION');
	if (!runnerAuthorized(request, env.RUNNER_TOKEN)) return Response.json({ ok: false, error: 'UNAUTHORIZED' }, { status: 401 });
	try {
		return await dispatchItemCallback(action, request, env);
	} catch (cause) {
		console.error('[item callback]', action, cause instanceof Error ? cause.message : cause);
		return Response.json({ ok: false, error: cause instanceof Error ? cause.message.slice(0, 300) : 'CALLBACK_FAILED' }, { status: 500 });
	}
}

async function dispatchItemCallback(action: string, request: Request, env: CloudflareEnv): Promise<Response> {
	const body = await request.json().catch(() => null) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') return badRequest('BODY_INVALID');
	const now = new Date().toISOString();

	if (action === 'recover-outbox') {
		if (!env.INNGEST_EVENT_KEY?.trim()) return Response.json({ ok: false, error: 'INNGEST_EVENT_KEY_MISSING' }, { status: 503 });
		// 직접 이벤트 발행기 — event client id=ymath.
		const client = new Inngest({ id: 'ymath', eventKey: env.INNGEST_EVENT_KEY, isDev: false });
		const result = await publishPendingItemOutbox(env.DB, (event) => client.send(event), now);
		return Response.json({ ok: true, sent: result.sent, failed: result.failed });
	}

	const ids = parseIds(body);
	if (!ids) return badRequest('IDS_INVALID');

	switch (action as ItemCallbackAction) {
		case 'claim': {
			const claimed = await claimInngestItem(env.DB, ids.jobId, ids.entityId, ids.entityGeneration, ids.owner);
			return Response.json({ job: claimed ? { generation: claimed.generation, lease_token: claimed.lease_token } : null });
		}
		case 'snapshot': {
			const snapshot = await loadInngestItemSnapshot(env, {
				id: ids.jobId, entity_id: ids.entityId, kind: 'item', generation: 0,
				entity_generation: ids.entityGeneration, lease_token: '', payload: '{}'
			});
			if (!snapshot) return Response.json({ entity_available: false });
			return Response.json({
				entity_available: true,
				image_key: snapshot.imageKey,
				ocr_text: snapshot.ocrText
			});
		}
		case 'normalized': {
			const fenced = parseFence(body, ids);
			if (!fenced) return badRequest('FENCE_INVALID');
			const job = await loadLeasedItemJob(env.DB, fenced);
			if (!job) return Response.json({ ok: false, reason: 'stale' });
			const object = await readClaimedRaw(env, job.id, fenced.lease_token);
			if (!object) return Response.json({ ok: false, reason: 'raw_missing' });
			const raw = new Uint8Array(await new Response(object.body).arrayBuffer());
			const { jpeg } = await normalizeCloudImage(raw);
			const persisted = await persistCloudNormalizedImage(env, job, fenced.lease_token, jpeg);
			return Response.json(persisted
				? { ok: true, image_key: `items/${ids.entityId}/normalized-${ids.entityGeneration}.jpg` }
				: { ok: false, reason: 'stale' });
		}
		case 'ocr': {
			const fenced = parseFence(body, ids);
			if (!fenced) return badRequest('FENCE_INVALID');
			const job = await loadLeasedItemJob(env.DB, fenced);
			if (!job) return Response.json({ ok: false, reason: 'stale' });
			const imageKey = typeof body.image_key === 'string' && OBJECT_KEY.test(body.image_key) && body.image_key.startsWith(`items/${ids.entityId}/`)
				? body.image_key : null;
			if (!imageKey) return badRequest('IMAGE_KEY_INVALID');
			try {
				const ocrText = await runDirectOcr(env, imageKey);
				const persisted = await persistCloudOcr(env, job, fenced.lease_token, ocrText, now);
				return Response.json(persisted ? { ok: true, ocr_text: ocrText } : { ok: false, reason: 'stale' });
			} catch (cause) {
				// 기존 inngest 경로와 동일한 ocr_missing 폴백: OCR 실패는 터미널 실패가 아니다.
				console.error('[item callback ocr]', cause instanceof Error ? cause.message : cause);
				return Response.json({ ok: true, ocr_text: '' });
			}
		}
		case 'transition': {
			const fenced = parseFence(body, ids);
			if (!fenced) return badRequest('FENCE_INVALID');
			const job = await loadLeasedItemJob(env.DB, fenced);
			if (!job) return Response.json({ ok: false, reason: 'stale' });
			const stage = body.stage;
			if (stage !== 'ocr' && stage !== 'analyzing') return badRequest('STAGE_INVALID');
			const ok = await updateCloudJobStage(env, job, fenced.lease_token, stage, now);
			// 기존 경로와 같은 terminal onFailure 플래그 유지: analyzing 전환 때 ocr_missing 을 확정한다.
			if (ok && stage === 'analyzing' && typeof body.ocr_missing === 'boolean') {
				await env.DB.prepare(`UPDATE entities SET record_json=json_set(record_json,'$.flags.ocr_missing',json(?))
					WHERE id=? AND kind='item' AND deleted_at IS NULL AND generation=? AND EXISTS
					(SELECT 1 FROM jobs WHERE id=? AND entity_id=entities.id AND entity_generation=entities.generation
					AND state='leased' AND generation=? AND lease_token=? AND lease_until>?)`)
					.bind(JSON.stringify(body.ocr_missing), ids.entityId, ids.entityGeneration, ids.jobId, fenced.generation, fenced.lease_token, now).run();
			}
			return Response.json({ ok });
		}
		case 'renew': {
			const fenced = parseFence(body, ids);
			if (!fenced) return badRequest('FENCE_INVALID');
			const seconds = typeof body.seconds === 'number' && Number.isFinite(body.seconds) ? body.seconds : ITEM_RENEW_MAX_SECONDS;
			return Response.json({ ok: await renewItemLease(env.DB, fenced, seconds) });
		}
		case 'prepare': {
			const fenced = parseFence(body, ids);
			if (!fenced) return badRequest('FENCE_INVALID');
			const job = await loadLeasedItemJob(env.DB, fenced);
			if (!job) return Response.json({ ok: false, reason: 'stale' });
			const snapshot = await loadInngestItemSnapshot(env, job);
			if (!snapshot) return Response.json({ ok: false, reason: 'entity_unavailable' });
			const imageKey = typeof body.image_key === 'string' && OBJECT_KEY.test(body.image_key) && body.image_key.startsWith(`items/${ids.entityId}/`)
				? body.image_key : snapshot.imageKey;
			if (!imageKey) return badRequest('IMAGE_KEY_INVALID');
			const ocrText = typeof body.ocr_text === 'string' ? body.ocr_text : snapshot.ocrText ?? '';
			const requestKey = batonRequestKey(ids.entityId, ids.jobId, ids.entityGeneration);
			// 실제 매니페스트를 buildBatonManifest 로 만들고 App 검증기를 통과시킨다.
			const manifest = buildBatonManifest({
				jobId: ids.jobId, entityId: ids.entityId, entityGeneration: ids.entityGeneration,
				record: snapshot.record, knownPatterns: snapshot.knownPatterns,
				taxonomy: parseTaxonomy(curriculum), studentName: env.STUDENT_NAME
			});
			validateBatonManifest(manifest);
			const store = requireS3Store(env);
			await store.put(requestKey, new TextEncoder().encode(JSON.stringify(manifest)), 'application/json');
			const jpeg = await readObjectBytes(env, imageKey);
			await store.put(imageKey, jpeg, 'image/jpeg');
			let ocrKey: string | null = null;
			if (ocrText.trim()) {
				ocrKey = `items/${ids.entityId}/baton-ocr-${ids.jobId}-${ids.entityGeneration}.txt`;
				await store.put(ocrKey, new TextEncoder().encode(ocrText), 'text/plain; charset=utf-8');
			}
			return Response.json({ request_key: requestKey, image_key: imageKey, ocr_key: ocrKey });
		}
		case 'commit': {
			const fenced = parseFence(body, ids);
			if (!fenced) return badRequest('FENCE_INVALID');
			const completion = {
				status: 'completed' as const,
				job_id: ids.jobId, entity_id: ids.entityId, entity_generation: ids.entityGeneration,
				result_key: body.result_key, content_hash: body.content_hash, size_bytes: body.size_bytes,
				model: body.model, prompt_version: body.prompt_version, analyzed_at: body.analyzed_at
			};
			validateCompletionPayload(completion as unknown as BatonCompletionPayload);
			// 커밋 영수증: finalization 이전에 live lease fence 아래 불변으로 묶는다.
			// 응답 유실/장애 간극을 없애기 위해 commit 트랜잭션보다 먼저 기록하고,
			// commitCloudResult 의 done 전이가 곧 영수증을 확정한다. 이미 존재하면
			// 동일 영수증일 때만 진행하며, 다른 token/result/hash 는 fail closed 다.
			const receipt = JSON.stringify({
				lease_token: fenced.lease_token,
				generation: fenced.generation,
				result_key: completion.result_key,
				content_hash: completion.content_hash,
				size_bytes: completion.size_bytes,
				model: completion.model,
				prompt_version: completion.prompt_version,
				analyzed_at: completion.analyzed_at
			});
			const receiptMatch = (marker: string | null): boolean => {
				if (!marker) return false;
				try {
					const parsed = JSON.parse(marker) as Record<string, unknown>;
					return parsed.lease_token === fenced.lease_token && parsed.generation === fenced.generation
						&& parsed.result_key === completion.result_key && parsed.content_hash === completion.content_hash
						&& parsed.size_bytes === completion.size_bytes && parsed.model === completion.model
						&& parsed.prompt_version === completion.prompt_version && parsed.analyzed_at === completion.analyzed_at;
				} catch { return false; }
			};
			const job = await loadLeasedItemJob(env.DB, fenced);
			if (!job) {
				// 응답 유실 재전송(replay): done 영수증과 동일한 결과는 승인하고, 다른
				// token/result/hash 는 거부한다. 판정 근원은 D1 영수증뿐 — 삭제된 S3
				// staging 객체를 요구하지 않는다.
				const row = await env.DB.prepare(`SELECT json_extract(payload,'$.connect_commit') AS marker FROM jobs
					WHERE id=? AND entity_id=? AND entity_generation=? AND kind='item' AND state='done' AND generation=? AND result_key IS NOT NULL`)
					.bind(fenced.jobId, fenced.entityId, fenced.entityGeneration, fenced.generation).first<{ marker: string | null }>();
				if (!row) return Response.json({ ok: false, reason: 'stale' });
				if (!receiptMatch(row.marker)) {
					return Response.json({ ok: false, reason: 'conflict' }, { status: 409 });
				}
				return Response.json({ ok: true, replay: true });
			}
			const existing = await env.DB.prepare(`SELECT json_extract(payload,'$.connect_commit') AS marker FROM jobs
				WHERE id=? AND entity_id=? AND entity_generation=? AND kind='item' AND state='leased'
				AND generation=? AND lease_token=? AND lease_until>?`)
				.bind(fenced.jobId, fenced.entityId, fenced.entityGeneration, fenced.generation, fenced.lease_token, now)
				.first<{ marker: string | null }>();
			if (!existing) return Response.json({ ok: false, reason: 'stale' });
			if (existing.marker && !receiptMatch(existing.marker)) {
				return Response.json({ ok: false, reason: 'conflict' }, { status: 409 });
			}
			if (!existing.marker) {
				const bound = await env.DB.prepare(`UPDATE jobs SET payload=json_set(payload,'$.connect_commit',json(?)),updated_at=?
					WHERE id=? AND entity_id=? AND entity_generation=? AND kind='item' AND state='leased'
					AND generation=? AND lease_token=? AND lease_until>?
					AND json_extract(payload,'$.connect_commit') IS NULL`)
					.bind(receipt, now, fenced.jobId, fenced.entityId, fenced.entityGeneration, fenced.generation, fenced.lease_token, now).run();
				if ((bound.meta?.changes ?? 0) !== 1) return Response.json({ ok: false, reason: 'stale' });
			}
			const snapshot = await loadInngestItemSnapshot(env, job);
			if (!snapshot?.imageKey) return badRequest('IMAGE_KEY_INVALID');
			// finalizeBatonResult: S3 readback + hash 검증 + validateAnalysis/checkGuardrail/checkClassification + commitCloudResult.
			const ok = await finalizeBatonResult(env, job, completion as Extract<BatonCompletionPayload, { status: 'completed' }>, {
				imageKey: snapshot.imageKey,
				ocrText: typeof body.ocr_text === 'string' ? body.ocr_text : snapshot.ocrText ?? '',
				taxonomy: parseTaxonomy(curriculum),
				schema: buildAnalysisSchema(parseTaxonomy(curriculum))
			});
			return Response.json({ ok });
		}
		case 'failure': {
			const attempts = typeof body.attempts === 'number' && Number.isSafeInteger(body.attempts) ? body.attempts : undefined;
			const message = typeof body.message === 'string' ? body.message : 'connect pipeline failure';
			const fenceInput = parseFence(body, ids);
			const fence = fenceInput && typeof body.attempts === 'number' && Number.isSafeInteger(body.attempts)
				? { generation: fenceInput.generation, token: fenceInput.lease_token, attempts: body.attempts }
				: undefined;
			const ok = await markInngestItemFailed(env, ids.jobId, ids.entityId, ids.entityGeneration, ids.owner, message, now, fence);
			return Response.json({ ok });
		}
	}
	return badRequest('UNKNOWN_ACTION');
}
