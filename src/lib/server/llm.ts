import { readFileSync } from 'node:fs';
import type { Provider } from '$lib/types';
import { settings } from './config';
import {
	MATH_COACH_SYSTEM,
	firstJsonObject,
	imageUserMessage as base64ImageUserMessage,
	isQuotaOrRateLimitError,
	parseJsonBody,
	promptWithSchema,
	QuotaExceededError
} from './llm-core';
import type { ChatContentPart } from './llm-core';

// 순수 구현은 llm-core.ts 가 소유하고 여기서 재노출한다(계약 보존).
export { MATH_COACH_SYSTEM, firstJsonObject, isQuotaOrRateLimitError, parseJsonBody, promptWithSchema, QuotaExceededError };
export type { ChatContentPart };

/** 사진 1장 + 프롬프트를 보내 JSON 스키마에 맞는 결과를 받는 호출 */
export interface StructuredCall {
	prompt: string;
	schema: object;
	/** 작업 디렉터리(임시 파일도 여기에 만들고 지운다) */
	dir: string;
	/** 분석할 사진. Qwen에 base64 data URL로 첨부한다 */
	imagePath: string;
}

export interface LlmOutput {
	output: unknown;
	model: string;
}

const missingKeyError = (provider: string, how: string) => new Error(`${provider} API 키가 설정되지 않았습니다. ${how}`);

/** image.jpg 를 base64 data URL 로 첨부한 멀티모달 user 메시지(Qwen) */
const imageUserMessage = (imagePath: string, prompt: string): { role: 'user'; content: ChatContentPart[] } =>
	base64ImageUserMessage(readFileSync(imagePath).toString('base64'), prompt);

/**
 * OpenAI 호환 chat/completions 한 번 호출하고 응답 본문을 반환한다.
 * 집 내부망 oMLX에서 한 곳에서 429·할당량·빈 응답을 처리한다.
 */
async function chatCompletion(o: {
	label: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	/** content 는 문자열 또는 멀티모달 파트 배열(이미지 data URL + 텍스트) */
	messages: { role: 'system' | 'user'; content: string | ChatContentPart[] }[];
	/** response_format: json_object 를 보낸다. 미지원 서버를 위해 끌 수 있다 */
	jsonMode: boolean;
	extraBody?: Record<string, unknown>;
	timeoutMs: number;
}): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), o.timeoutMs);
	try {
		const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
			method: 'POST',
			headers: {
				...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: o.model,
				messages: o.messages,
				...(o.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
				max_tokens: 4096,
				temperature: 0.2,
				...o.extraBody
			}),
			signal: controller.signal
		});

		if (res.status === 429) {
			const errText = await res.text().catch(() => '');
			throw new QuotaExceededError(`${o.label} 요청 한도 초과(HTTP 429): ${errText.slice(0, 200)}`, 429);
		}

		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			if (isQuotaOrRateLimitError(errText)) {
				throw new QuotaExceededError(`${o.label} 할당량 소진 또는 제한(${res.status}): ${errText.slice(0, 200)}`, res.status);
			}
			throw new Error(`${o.label} API 오류(${res.status}): ${errText.slice(0, 300)}`);
		}

		const data = (await res.json()) as any;
		if (data.error) {
			const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
			if (isQuotaOrRateLimitError(msg)) {
				throw new QuotaExceededError(`${o.label} 할당량 소진: ${msg.slice(0, 200)}`);
			}
			throw new Error(`${o.label} 응답 오류: ${msg.slice(0, 300)}`);
		}

		const choice = data.choices?.[0];
		const content = choice?.message?.content ?? '';
		if (!content.trim()) {
			throw new Error(`${o.label} 응답 내용이 비었음 (finish_reason: ${choice?.finish_reason})`);
		}
		return content;
	} catch (e: any) {
		if (e.name === 'AbortError') {
			throw new Error(`분석 시간 초과(${Math.round(o.timeoutMs / 1000)}초)`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

async function structuredWithOmlx(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	if (!s.omlxApiKey) throw missingKeyError('oMLX', 'user/config/providers.json 의 omlx apiKey 를 채우세요');
	if (!s.omlxBaseUrl || !s.omlxModel)
		throw new Error('user/config/providers.json 의 omlx 에 baseUrl 과 models[0].id 를 채우세요 — 환경변수 우회나 하드코드 폴백은 없다');
	const { omlxBaseUrl, omlxApiKey, omlxModel } = s;
	const content = await chatCompletion({
		label: 'oMLX',
		baseUrl: omlxBaseUrl,
		apiKey: omlxApiKey,
		model: omlxModel,
		messages: [{ role: 'system', content: MATH_COACH_SYSTEM }, imageUserMessage(c.imagePath, promptWithSchema(c.prompt, c.schema))],
		jsonMode: true,
		// Qwen 계열은 thinking 을 본문에 섞어 내보내므로 출력 예산을 넉넉히 둔다
		extraBody: {
			max_tokens: 16384,
			// 서버 측 스키마 강제(oMLX가 json_schema response_format 지원). 프롬프트 스키마는 보조 수단.
			response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema: c.schema } }
		},
		timeoutMs: s.analyzeTimeoutMs
	});
	return { output: parseJsonBody('oMLX', content), model: omlxModel };
}

/** 지정한 LLM 으로 사진을 분석해 구조화된 결과를 받는다. */
export function runStructured(provider: Provider, call: StructuredCall): Promise<LlmOutput> {
	if (provider === 'omlx') return structuredWithOmlx(call);
	// 옛 기록의 requested_provider 같은 값이 타입 검사를 우회해 올 수 있다
	return Promise.reject(new Error(`사용할 수 없는 LLM 입니다: ${provider}`));
}

/** 텍스트만 주고받는 호출(사진·스키마 없음). 보고서 작성처럼 프롬프트 → 본문만 필요한 곳에서 쓴다. */
export async function runText(provider: Provider, prompt: string): Promise<{ text: string; model: string }> {
	if (provider !== 'omlx') throw new Error(`사용할 수 없는 LLM 입니다: ${provider}`);
	const s = settings();
	if (provider === 'omlx') {
		if (!s.omlxApiKey) throw missingKeyError('oMLX', 'user/config/providers.json 의 omlx apiKey 를 채우세요');
		if (!s.omlxBaseUrl || !s.omlxModel)
			throw new Error('user/config/providers.json 의 omlx 에 baseUrl 과 models[0].id 를 채우세요 — 환경변수 우회나 하드코드 폴백은 없다');
		const { omlxBaseUrl, omlxApiKey, omlxModel } = s;
		const text = await chatCompletion({
			label: 'oMLX',
			baseUrl: omlxBaseUrl,
			apiKey: omlxApiKey,
			model: omlxModel,
			messages: [{ role: 'user', content: prompt }],
			jsonMode: false,
			timeoutMs: s.analyzeTimeoutMs
		});
		return { text: text.trim(), model: omlxModel };
	}
	throw new Error(`사용할 수 없는 LLM 입니다: ${provider}`);
}
