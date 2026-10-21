/** ITEM_ANALYSIS_BACKEND=baton — upload/retry 라우트가 공유하는 독립 item 발행 모듈.
 *
 * - 필요한 것만 요구한다: S3 저장 설정(S3_*), RUNNER_TOKEN,
 *   outbox 복구용 INNGEST_EVENT_KEY. hosted signing·LLM credential(step.ai.infer)은
 *   요구하지 않는다 — 분석 추론은 Connect Runner 가 소유하기 때문이다.
 * - 발행은 D1 item_outbox 커밋 + 직접 Inngest 이벤트 발행기(client id=ymath)다.
 * - 기존 inngest 백엔드·리포트는 기존 경로와 호환된다. */
import { Inngest } from 'inngest';
import { publishPendingItemOutbox, type ItemOutboxPublisher } from './inngest-item';
import type { CloudflareEnv } from './runtime';

export interface BatonItemPublicationEnv extends CloudflareEnv {
	ITEM_ANALYSIS_BACKEND?: string;
}

/** Worker 와 Connect Runner 는 공통 RUNNER_TOKEN 하나로 콜백을 인증한다. */
export function runnerToken(env: { RUNNER_TOKEN?: string }): string | null {
	return env.RUNNER_TOKEN?.trim() || null;
}

/** baton 백엔드 접수 사전 검증. 없으면 가짜 접수 성공 대신 명확히 실패한다. */
export function assertItemBatonConfigured(env: BatonItemPublicationEnv): void {
	if (env.ITEM_ANALYSIS_BACKEND !== 'baton') return;
	for (const key of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const) {
		if (!env[key]?.trim()) throw new Error(`${key} is required for baton item analysis`);
	}
	if (!runnerToken(env)) throw new Error('RUNNER_TOKEN is required for baton item analysis');
	if (!env.INNGEST_EVENT_KEY?.trim()) throw new Error('INNGEST_EVENT_KEY is required to publish baton item outbox events');
}

/** D1 outbox → 직접 Inngest 이벤트 발행(id=ymath). */
export async function publishItemOutboxDirect(env: BatonItemPublicationEnv, send?: ItemOutboxPublisher): Promise<{ sent: number; failed: number }> {
	assertItemBatonConfigured(env);
	const publisher = send ?? makeDirectItemSender(env);
	return publishPendingItemOutbox(env.DB, publisher);
}

/** 직접 이벤트 발행기. Inngest client id 는 소비 function(client id=ymath)과 같아야 한다. */
export function makeDirectItemSender(env: BatonItemPublicationEnv): ItemOutboxPublisher {
	const eventKey = env.INNGEST_EVENT_KEY?.trim();
	if (!eventKey) throw new Error('INNGEST_EVENT_KEY is required to publish baton item outbox events');
	const client = new Inngest({ id: 'ymath', eventKey, isDev: false });
	return (event) => client.send(event);
}
