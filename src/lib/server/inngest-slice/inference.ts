/** Inngest infer 공용 설정 검증·모델 팩터리. app.ts 가 재노출한다(계약 보존). */
import { openai } from 'inngest';

export interface InferenceConfig {
	INNGEST_EVENT_KEY?: string;
	INNGEST_SIGNING_KEY?: string;
	LLM_API_KEY?: string;
	LLM_BASE_URL?: string;
	LLM_MODEL?: string;
}

export function validateInferenceConfig(env: InferenceConfig) {
	if (!env.INNGEST_EVENT_KEY || !env.INNGEST_SIGNING_KEY || !env.LLM_API_KEY || !env.LLM_BASE_URL || !env.LLM_MODEL) throw new Error('Inngest or LLM inference configuration is missing');
	let url: URL;
	try { url = new URL(env.LLM_BASE_URL); } catch { throw new Error('LLM_BASE_URL must be a valid HTTPS URL'); }
	if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('LLM_BASE_URL must be HTTPS without credentials, query, or fragment');
	if (!/^[A-Za-z0-9._:/-]{1,160}$/.test(env.LLM_MODEL) || !/^[\x21-\x7e]{8,512}$/.test(env.LLM_API_KEY)) throw new Error('LLM model or API key format is invalid');
	return { model: env.LLM_MODEL, baseUrl: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY };
}

/** LLM_MODEL 기본 분석 모델. modelOverride 로 OCR 전용 모델(PaddleOCR-VL-1.6-mlx)을 고른다. */
export function openaiModel(config: ReturnType<typeof validateInferenceConfig>) {
	return openai(config);
}

/** 응답 본문이 단일 choice·stop·문자열 본문인지 검사한다(app.ts 계약과 동일). */
export function validateOpenAiResponse(value: unknown): string {
	if (!value || typeof value !== 'object') throw new Error('LLM response is malformed');
	const record = value as { error?: unknown; choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> };
	if (record.error) throw new Error('LLM provider returned an error');
	const choices = record.choices;
	const content = choices?.[0]?.message?.content;
	if (choices?.length !== 1 || choices[0].finish_reason !== 'stop' || typeof content !== 'string' || content.trim().length < 8 || content.length > 20_000) throw new Error('LLM response content is invalid or incomplete');
	return content.trim();
}

/** Uint8Array → base64(Worker/Node 공통, btoa 사용). 이미지 data URI 첨부용이다. */
export function toBase64(bytes: Uint8Array): string {
	let binary = '';
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	return btoa(binary);
}
