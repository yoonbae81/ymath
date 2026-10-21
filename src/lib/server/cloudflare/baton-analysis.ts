/** ITEM_ANALYSIS_BACKEND=baton — item 분석 추론을 baton 공통 Runner(Mac Studio)의 execute run 으로 위임한다.
 *
 * 계약 근원: ymath/baton/analysis/functions.ts (양쪽이 하나의 와이어 계약을 공유한다).
 * - 트리거/완료 전달: SHS dispatch 계약 준용 — stable event ID 발행 + step.waitForEvent 대기.
 * - LLM 호출 주체는 Runner. 결과 JSON은 Runner가 R2(S3 호환)에 readback-verify 저장하고
 *   작은 참조만 완료 이벤트로 돌아온다. ymath는 참조로 R2에서 결과를 읽어 hash 검증 뒤
 *   기존 commitCloudResult 계약(lease fencing 유지)으로 최종화한다.
 * - guardrail·taxonomy·schema 최종 검증은 ymath 커밋 경로가 그대로 소유한다(기존 계약 불변).
 * - OCR·claim·outbox는 기존 inngest 경로와 공유된다. llm.xcv.kr 직접 경로는 기본값 아님(flag) 으로 보존된다. */
import type { Feedback, ItemRecord } from '$lib/types';
import { currentFeedback } from '$lib/types';
import {
	ANALYSIS_RESULT_CONTRACT_VERSION,
	BATON_COMPLETION_EVENT,
	BATON_TRIGGER_EVENT,
	BATON_TRIGGER_EVENT_ID_PREFIX,
	batonRequestKey,
	validateBatonManifest,
	validateCompletionPayload,
	type BatonCompletionPayload,
	type BatonManifest
} from '../../../../baton/analysis/functions';
import { validateAnalysis } from '../analysis-validator';
import { checkGuardrail } from '../guardrail';
import { checkClassification, renderTaxonomy, type Taxonomy } from '../taxonomy-core';
import { batonDefaultProvider, batonCatalog, batonProfileForProvider } from './baton-catalog';
import { markInngestItemFailed, transitionItemRetry, readObjectBytes } from './inngest-item';
import type { ClaimedJob } from './jobs';
import { commitCloudResult, cloudItem, type CloudflareEnv } from './runtime';
import { requireS3Store } from './s3-store';

/** baton 트리거 이벤트 발행기(app.ts 가 Inngest client.send 로 주입). */
export type BatonTriggerPublisher = (event: { name: typeof BATON_TRIGGER_EVENT; id: string; data: Record<string, unknown> }) => Promise<unknown>;

export interface BatonStepTools {
	run<T>(id: string, callback: () => T | Promise<T>): Promise<T>;
	sleep(id: string, duration: number): Promise<unknown>;
	waitForEvent(id: string, options: { event: string; timeout: string; if?: string }): Promise<unknown>;
}

/** 요청 매니페스트를 item 스냅샷에서 유도한다(ymath/baton/analysis/contract.md 의 입력 계약). */
export function buildBatonManifest(input: {
	jobId: string;
	entityId: string;
	entityGeneration: number;
	record: ItemRecord;
	knownPatterns: { id: string; count: number; example: string }[];
	taxonomy: Taxonomy;
	studentName?: string;
}): BatonManifest {
	const feedback = currentFeedback(input.record) as Feedback | null;
	return {
		contract_version: ANALYSIS_RESULT_CONTRACT_VERSION,
		job_id: input.jobId,
		entity_id: input.entityId,
		entity_generation: input.entityGeneration,
		workbook_name: input.record.workbook.name,
		student_name: input.studentName?.trim() || null,
		feedback: feedback ? { choice: feedback.choice, comment: feedback.comment } : null,
		known_patterns: input.knownPatterns,
		taxonomy_md: renderTaxonomy(input.taxonomy)
	};
}

/** finalize 때 정리하는 staging 객체 키(요청 매니페스트·baton OCR 사본·결과 staging). */
export function batonStagingCleanupKeys(entityId: string, jobId: string, generation: number, resultKey: string): string[] {
	return [
		batonRequestKey(entityId, jobId, generation),
		`items/${entityId}/baton-ocr-${jobId}-${generation}.txt`,
		resultKey
	];
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Runner staging 결과 객체를 읽고 hash 검증한 뒤 기존 commitCloudResult 계약으로 최종화한다.
 * guardrail 위반은 기존 inngest 경로와 동일하게 flags.guardrail 로 기록한다(커밋 실패 아님).
 * Connect 경로의 /runner/items/commit 콜백도 같은 최종 검증을 재사용한다(export). */
export async function finalizeBatonResult(
	env: CloudflareEnv,
	claimed: ClaimedJob,
	completion: Extract<BatonCompletionPayload, { status: 'completed' }>,
	ctx: { imageKey: string; ocrText: string; taxonomy: Taxonomy; schema: Record<string, unknown> }
): Promise<boolean> {
	if (!(await cloudItem(env, claimed.entity_id))) return false;
	const bytes = await requireS3Store(env).get(completion.result_key);
	if (!bytes) throw new Error(`INPUT_MISSING: baton result ${completion.result_key}`);
	if (await sha256Hex(bytes) !== completion.content_hash) throw new Error(`ARTIFACT_HASH_MISMATCH: baton result ${completion.result_key}`);
	const stored = JSON.parse(new TextDecoder().decode(bytes)) as {
		contract_version?: number; status?: string; analysis?: unknown;
		meta?: { provider?: string; model?: string };
	};
	if (stored.contract_version !== ANALYSIS_RESULT_CONTRACT_VERSION || stored.status !== 'completed' || !stored.analysis || !stored.meta) {
		throw new Error('INPUT_INVALID: baton result object');
	}
	const out = stored.analysis as ItemRecord['analysis'];
	validateAnalysis(ctx.schema, out);
	const guard = checkGuardrail(out);
	const issues = checkClassification(ctx.taxonomy, out);
	const course = ctx.taxonomy.unitByName.get(out.classification.unit_major)?.course;
	if (course) out.classification.course = course;
	const meta = {
		provider: stored.meta.provider ?? 'omlx',
		model: completion.model || stored.meta.model || '',
		prompt_version: completion.prompt_version,
		analyzed_at: completion.analyzed_at
	};
	const flags: ItemRecord['flags'] = {
		ocr_missing: !ctx.ocrText.trim(),
		taxonomy_mismatch: issues,
		guardrail: [...guard.violations, ...guard.warnings]
	};
	const jpeg = await readObjectBytes(env, ctx.imageKey);
	const ok = await commitCloudResult(env, claimed, claimed.lease_token, jpeg, out, meta, flags, ctx.ocrText);
	if (ok) {
		// staging 객체 정리(S3) — 최종 커밋(analysis-*.jpg.json) 뒤에만 지운다.
		for (const key of batonStagingCleanupKeys(claimed.entity_id, claimed.id, claimed.entity_generation, completion.result_key)) {
			await requireS3Store(env).delete(key).catch(() => undefined);
		}
	}
	return ok;
}

/** baton 분석 본문. 기존 inngest 분석 루프와 같은 예산·quota·lease fencing 규약을 따른다. */
export async function runBatonAnalysis(env: CloudflareEnv, claimed: ClaimedJob, input: {
	step: BatonStepTools;
	send: BatonTriggerPublisher;
	runId: string;
	jobId: string;
	entityId: string;
	entityGeneration: number;
	imageKey: string;
	ocrText: string;
	taxonomy: Taxonomy;
	schema: Record<string, unknown>;
	knownPatterns: { id: string; count: number; example: string }[];
	record: ItemRecord;
	studentName?: string;
}): Promise<{ status: 'done' | 'failed' | 'stale_result_rejected' }> {
	const retryEnv = env as { ANALYZE_MAX_ATTEMPTS?: string; QUOTA_RETRY_DELAY_MS?: string };
	const quotaDelayMs = Number(retryEnv.QUOTA_RETRY_DELAY_MS ?? 600_000);
	const maxAttempts = Number(retryEnv.ANALYZE_MAX_ATTEMPTS ?? 2);
	const provider = input.record.requested_provider ?? batonDefaultProvider;
	const providers = batonCatalog.providers as Record<string, unknown>;
	const profileId = providers[provider] ? batonProfileForProvider(provider) : null;
	let attempts = input.record.attempts;
	let budgetAttempt = 1;

	// ① 요청 매니페스트·정규화 이미지·OCR 사본을 S3(MinIO)에 등록한다(Runner가 읽는다).
	// 키 계약: items/<entity>/baton-request-*.json, items/<entity>/normalized-*.jpg.
	const request = await input.step.run('build-baton-request', async () => {
		const manifest = buildBatonManifest({
			jobId: claimed.id, entityId: claimed.entity_id, entityGeneration: claimed.entity_generation,
			record: input.record, knownPatterns: input.knownPatterns, taxonomy: input.taxonomy, studentName: input.studentName
		});
		validateBatonManifest(manifest);
		const requestKey = batonRequestKey(claimed.entity_id, claimed.id, claimed.entity_generation);
		const store = requireS3Store(env);
		await store.put(requestKey, new TextEncoder().encode(JSON.stringify(manifest)), 'application/json');
		// Runner가 이미지를 같은 버킷에서 읽는다 — R2 의 정규화 JPEG 를 S3 로 복제한다(멱등).
		const jpeg = await readObjectBytes(env, input.imageKey);
		await store.put(input.imageKey, jpeg, 'image/jpeg');
		let ocrKey: string | undefined;
		if (input.ocrText.trim()) {
			// persisted OCR 이 없는 경우에도 Runner가 참조할 수 있게 결정적 키로 등록한다(멱등).
			ocrKey = `items/${claimed.entity_id}/baton-ocr-${claimed.id}-${claimed.entity_generation}.txt`;
			await store.put(ocrKey, new TextEncoder().encode(input.ocrText), 'text/plain; charset=utf-8');
		}
		return { requestKey, ocrKey };
	});

	// ② 트리거 이벤트 — stable ID(순수 배송 dedupe). 본문·이미지는 이벤트에 넣지 않는다.
	const trigger = {
		name: BATON_TRIGGER_EVENT,
		id: `${BATON_TRIGGER_EVENT_ID_PREFIX}-${claimed.id}-${claimed.entity_generation}`,
		data: {
			job_id: claimed.id,
			entity_id: claimed.entity_id,
			entity_generation: claimed.entity_generation,
			request_key: request.requestKey,
			image_key: input.imageKey,
			...(profileId ? { profile_id: profileId } : {}),
			...(request.ocrKey ? { ocr_key: request.ocrKey } : {})
		}
	} as const;
	// 재발행 때마다 새 step id — memoize 되어 재전송이 생략되지 않게 한다.
	const publish = (turn: number) => input.step.run(`publish-baton-request-${turn}`, async () => {
		try {
			await input.send(trigger);
		} catch (cause) {
			// 동일 stable ID 재전송이 dedupe 로 거부되는 것은 이미 전달된 것이다.
			if (!/duplicate|already exist/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
		}
		return { published: true };
	});
	await publish(0);

	// ③ 완료 이벤트 대기 — SHS 파일럿과 같은 작은 참조 전달. 대기 전에 lease 를 연장한다.
	for (let turn = 0; ; turn++) {
		const fenced = await input.step.run(`fence-baton-wait-${turn}`, () =>
			transitionItemRetry(env, claimed, input.runId, `baton-wait-${turn}`, attempts, attempts, 'analyzing', null, 31 * 60_000));
		if (!fenced) return { status: 'stale_result_rejected' };
		const completion = await input.step.waitForEvent(`wait-baton-completion-${turn}`, {
			event: BATON_COMPLETION_EVENT,
			timeout: '30m',
			if: `async.data.job_id == "${claimed.id}" && async.data.entity_id == "${claimed.entity_id}" && async.data.entity_generation == ${claimed.entity_generation}`
		}) as { data?: BatonCompletionPayload | null | undefined } | null | undefined;

		const payload = completion?.data as BatonCompletionPayload | null | undefined;

		if (payload === null || payload === undefined) {
			// 유실/미도착: Runner 영수증이 멱등이므로 예산 내에서 재발행·재대기한다.
			if (budgetAttempt >= maxAttempts) {
				const failed = await input.step.run(`fail-baton-timeout-${turn}`, () => markInngestItemFailed(env,
					claimed.id, claimed.entity_id, claimed.entity_generation, input.runId, 'baton: completion wait timed out',
					undefined, { generation: claimed.generation, token: claimed.lease_token, attempts }));
				return { status: failed ? 'failed' : 'stale_result_rejected' };
			}
			const retried = await input.step.run(`retry-baton-timeout-${turn}`, () =>
				transitionItemRetry(env, claimed, input.runId, `baton-timeout-${turn}`, attempts, attempts + 1, 'analyzing', 'baton 완료 대기 시간 초과(자동 재시도)'));
			if (!retried) return { status: 'stale_result_rejected' };
			attempts++;
			budgetAttempt++;
			await publish(turn + 1);
			continue;
		}

		let payloadValid = true;
		try { validateCompletionPayload(payload); } catch { payloadValid = false; }

		if (payloadValid && payload.status === 'completed') {
			const saved = await input.step.run('commit-baton-result', () => finalizeBatonResult(env, claimed, payload, {
				imageKey: input.imageKey, ocrText: input.ocrText, taxonomy: input.taxonomy, schema: input.schema
			}));
			return { status: saved ? 'done' : 'stale_result_rejected' };
		}

		const code = payloadValid && 'code' in payload ? payload.code : 'REQUEST_INVALID';
		if (code === 'RATE_LIMITED') {
			// Runner 모델 quota: 기존 inngest 루프와 같은 quota 대기·재개 규약.
			budgetAttempt = 1;
			const message = `API 할당량 초과 또는 요청 제한(429)으로 ${Math.round(quotaDelayMs / 60_000)}분 후 자동으로 다시 시도합니다.`;
			const waiting = await input.step.run(`wait-baton-quota-${turn}`, () =>
				transitionItemRetry(env, claimed, input.runId, `baton-quota-${turn}`, attempts, Math.max(0, attempts - 1), 'queued', message, quotaDelayMs));
			if (!waiting) return { status: 'stale_result_rejected' };
			attempts = Math.max(0, attempts - 1);
			await input.step.sleep(`sleep-baton-quota-${turn}`, quotaDelayMs);
			const resumed = await input.step.run(`resume-baton-quota-${turn}`, () =>
				transitionItemRetry(env, claimed, input.runId, `baton-resume-${turn}`, attempts, attempts + 1, 'analyzing', null));
			if (!resumed) return { status: 'stale_result_rejected' };
			attempts++;
			await publish(turn + 1);
			continue;
		}

		if (budgetAttempt >= maxAttempts) {
			const failed = await input.step.run(`fail-baton-attempt-${turn}`, () => markInngestItemFailed(env,
				claimed.id, claimed.entity_id, claimed.entity_generation, input.runId, `baton: ${code}`,
				undefined, { generation: claimed.generation, token: claimed.lease_token, attempts }));
			return { status: failed ? 'failed' : 'stale_result_rejected' };
		}
		const retried = await input.step.run(`retry-baton-attempt-${turn}`, () =>
			transitionItemRetry(env, claimed, input.runId, `baton-retry-${turn}`, attempts, attempts + 1, 'analyzing', null));
		if (!retried) return { status: 'stale_result_rejected' };
		attempts++;
		budgetAttempt++;
		await publish(turn + 1);
	}
}
