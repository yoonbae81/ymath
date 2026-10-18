/** 순수(pure) OCR 계약 — node:fs 없이 Worker 번들에서 import 가능하다.
 * ocr.ts 가 메시지·LOC 정리·빈 결과 판정을 재사용하므로 기존 계약은 그대로다. */

export const OCR_SYSTEM_PROMPT =
	'당신은 수학 문제 이미지 OCR 도구입니다. 이미지에 보이는 모든 텍스트와 수식을 원문 순서대로 정확히 판독해 Markdown으로 전사하세요. 문제를 풀거나 설명하지 말고 전사 결과만 출력하세요.';

export const OCR_USER_TEXT =
	'이미지의 모든 텍스트와 수식을 원문 순서대로 정확히 판독해 Markdown 본문만 출력하세요. 설명·요약·코드 펜스는 추가하지 마세요.';

/** oMLX 0.6.4 는 base64 data URI 만 받는다(omlx/utils/image.py 가 원격 URL·파일 경로를 명시적으로 거부). */
export function buildOcrMessages(base64: string): { role: 'system' | 'user'; content: unknown }[] {
	return [
		{ role: 'system', content: OCR_SYSTEM_PROMPT },
		{
			role: 'user',
			content: [
				{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
				{ type: 'text', text: OCR_USER_TEXT }
			]
		}
	];
}

/** PaddleOCR-VL 판독 위치 토큰(<|LOC_n|>)은 분석에 불필요한 노이즈라 치운다. */
export function cleanOcrMarkdown(markdown: string): string {
	return markdown.replace(/[ \t]*<\| *LOC_\d+ *\|>[ \t]*/g, '').trim();
}

/** chat/completions 응답의 content(문자열 또는 text part 배열)를 Markdown 으로 모으고 빈 결과는 실패 처리한다. */
export function markdownFromOcrResponse(response: unknown): string {
	const choices = (response as { choices?: { message?: { content?: unknown } }[] } | null)?.choices;
	const content = choices?.[0]?.message?.content;
	const markdown =
		typeof content === 'string'
			? content
			: Array.isArray(content)
				? content
						.map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
						.join('')
				: undefined;
	if (typeof markdown !== 'string') throw new Error('OCR 응답에 markdown 이 없음');
	const md = cleanOcrMarkdown(markdown);
	if (!md) throw new Error('OCR 결과가 비어 있음');
	return md;
}
