import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLlmProviders, settings } from './config';
import { IMAGE_FILE } from './image';

/**
 * providers.json 의 omlx OpenAI 호환 API로 image.jpg 를 Markdown 으로 바꾼다.
 * PaddleOCR-VL 판독 위치 토큰(<|LOC_n|>)은 분석에 불필요한 노이즈라 치운다.
 */
export async function runOcr(dir: string): Promise<string> {
	const s = settings();
	const omlx = readLlmProviders().omlx;
	const baseUrl = omlx?.baseUrl?.trim();
	const apiKey = omlx?.apiKey?.trim();
	if (!baseUrl || !apiKey) {
		throw new Error('OCR 서버 설정이 없음: user/config/providers.json 의 omlx baseUrl·apiKey 를 확인하세요');
	}
	const image = readFileSync(join(dir, IMAGE_FILE)).toString('base64');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), s.ocrTimeoutMs);
	let res: Response;
	try {
		res = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: s.ocrModel,
				messages: [
					{
						role: 'system',
						content:
							'당신은 수학 문제 이미지 OCR 도구입니다. 이미지에 보이는 모든 텍스트와 수식을 원문 순서대로 정확히 판독해 Markdown으로 전사하세요. 문제를 풀거나 설명하지 말고 전사 결과만 출력하세요.'
					},
					{
						role: 'user',
						content: [
							{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } },
							{
								type: 'text',
								text: '이미지의 모든 텍스트와 수식을 원문 순서대로 정확히 판독해 Markdown 본문만 출력하세요. 설명·요약·코드 펜스는 추가하지 마세요.'
							}
						]
					}
				],
				max_tokens: 8192,
				temperature: 0,
				stream: false
			}),
			signal: controller.signal
		});
	} catch (e) {
		if ((e as Error).name === 'AbortError') throw new Error(`OCR 시간 초과(${Math.round(s.ocrTimeoutMs / 1000)}초)`);
		throw new Error(`OCR 서버(${baseUrl})에 연결할 수 없음: ${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OCR 실패(HTTP ${res.status}): ${body.trim().slice(0, 200)}`);
	}
	const data = (await res.json().catch(() => null)) as
		| { choices?: { message?: { content?: unknown } }[] }
		| null;
	const content = data?.choices?.[0]?.message?.content;
	const markdown =
		typeof content === 'string'
			? content
			: Array.isArray(content)
				? content
						.map((part) => (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string' ? part.text : ''))
						.join('')
				: undefined;
	if (typeof markdown !== 'string') throw new Error('OCR 응답에 markdown 이 없음');
	const md = markdown.replace(/[ \t]*<\| *LOC_\d+ *\|>[ \t]*/g, '').trim();
	if (!md) throw new Error('OCR 결과가 비어 있음');
	return md;
}
