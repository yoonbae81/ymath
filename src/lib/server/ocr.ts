import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLlmProviders, settings } from './config';
import { IMAGE_FILE } from './image';
import { buildOcrMessages, markdownFromOcrResponse } from './ocr-core';

export { cleanOcrMarkdown } from './ocr-core';

/**
 * providers.json 의 zai(z.ai, OpenAI 호환) API로 image.jpg 를 Markdown 으로 바꾼다.
 * 모델은 settings().ocrModel(기본 glm-4.6v). PaddleOCR-VL 판독 위치 토큰(<|LOC_n|>)은
 * 남아 있어도 분석에 불필요한 노이즈라 치운다.
 */
export async function runOcr(dir: string): Promise<string> {
	const s = settings();
	const zai = readLlmProviders().zai;
	const baseUrl = zai?.baseUrl?.trim();
	const apiKey = zai?.apiKey?.trim();
	if (!baseUrl || !apiKey) {
		throw new Error('OCR 서버 설정이 없음: user/config/providers.json 의 zai baseUrl·apiKey 를 확인하세요');
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
				messages: buildOcrMessages(image),
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
	const data = (await res.json().catch(() => null)) as unknown;
	return markdownFromOcrResponse(data);
}
