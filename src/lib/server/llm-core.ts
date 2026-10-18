/** 순수(pure) LLM 메시지·파싱 로직 — node:fs 없이 Worker 번들에서 import 가능하다.
 * llm.ts 가 같은 것들을 재노출하므로 기존 공개 계약은 그대로다. */

/** OpenAI 호환 멀티모달 콘텐츠 파트. Qwen 비전 모델은 image_url 에 공개 URL 이나 base64 data URL 을 받는다 */
export type ChatContentPart = { type: 'image_url'; image_url: { url: string } } | { type: 'text'; text: string };

export const MATH_COACH_SYSTEM =
	'당신은 학생의 수학 오답을 전문적으로 분석하고 코칭하는 수학 교육 전문가입니다. 주어진 JSON Schema를 엄격히 준수하여 순수 JSON 객체 하나만 출력하십시오. 마크다운 코드 블록이나 다른 텍스트는 일체 출력하지 마세요.';

export const promptWithSchema = (prompt: string, schema: object) =>
	`${prompt}\n\n---\n# 준수해야 할 JSON Schema\n${JSON.stringify(schema, null, 2)}\n\n위 JSON Schema에 정확히 맞는 유효한 JSON 객체 하나만 출력하세요.`;

/** image bytes 를 base64 data URL 로 첨부한 멀티모달 user 메시지(Qwen). oMLX 0.6.4 는 base64 data URI 만 받는다. */
export const imageUserMessage = (base64: string, prompt: string): { role: 'user'; content: ChatContentPart[] } => ({
	role: 'user',
	content: [
		{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
		{ type: 'text', text: prompt }
	]
});

export class QuotaExceededError extends Error {
	constructor(message: string, public readonly status?: number) {
		super(message);
		this.name = 'QuotaExceededError';
	}
}

export function isQuotaOrRateLimitError(err: unknown): boolean {
	if (err instanceof QuotaExceededError) return true;
	const msg = String(err instanceof Error ? err.message : err).toLowerCase();
	return (
		msg.includes('429') ||
		msg.includes('quota') ||
		msg.includes('rate limit') ||
		msg.includes('rate_limit') ||
		msg.includes('insufficient_quota') ||
		msg.includes('resource_exhausted') ||
		msg.includes('too many requests') ||
		msg.includes('1301') ||
		msg.includes('1302')
	);
}

/** 문자열 이스케이프를 고려해 본문에서 첫 번째 균형 잡힌 {...} 객체 범위를 찾는다 */
export function firstJsonObject(text: string): string | null {
	const start = text.indexOf('{');
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escape = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escape) escape = false;
			else if (ch === '\\') escape = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === '{') depth++;
		else if (ch === '}' && --depth === 0) return text.slice(start, i + 1);
	}
	return null;
}

/**
 * 코드펜스로 감싸진 경우, 심지어 모델의 thinking 이 본문에 섞인 경우에도 JSON 을 건진다.
 * oMLX 의 Qwen 계열은 reasoning 을 content 에 그대로 출력하는 일이 있다.
 */
export function parseJsonBody(label: string, text: string): unknown {
	const body = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');
	try {
		return JSON.parse(body);
	} catch {
		/* 아래 폴백들 */
	}
	const salvage = firstJsonObject(body);
	if (salvage) {
		try {
			return JSON.parse(salvage);
		} catch {
			/* 폴백도 실패하면 원인과 함께 아래에서 실패 */
		}
	}
	throw new Error(`${label} 출력이 JSON 이 아님: ${text.slice(0, 200)}`);
}
