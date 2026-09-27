import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './config';
import { IMAGE_FILE } from './image';

/**
 * 내부망 mdconv(POST /convert)로 image.jpg 를 Markdown 으로 바꾼다. mdconv 는 jpeg/png 를
 * oMLX 의 PaddleOCR-VL 비전 모델로 읽는다. 판독 위치 토큰(<|LOC_n|>)은 분석에 불필요한 노이즈라 치운다.
 */
export async function runOcr(dir: string): Promise<string> {
	const s = settings();
	const form = new FormData();
	form.append('file', new Blob([readFileSync(join(dir, IMAGE_FILE))], { type: 'image/jpeg' }), IMAGE_FILE);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), s.ocrTimeoutMs);
	let res: Response;
	try {
		res = await fetch(`${s.ocrUrl.replace(/\/+$/, '')}/convert`, { method: 'POST', body: form, signal: controller.signal });
	} catch (e) {
		if ((e as Error).name === 'AbortError') throw new Error(`OCR 시간 초과(${Math.round(s.ocrTimeoutMs / 1000)}초)`);
		throw new Error(`OCR 서버(${s.ocrUrl})에 연결할 수 없음: ${(e as Error).message}`);
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OCR 실패(HTTP ${res.status}): ${body.trim().slice(0, 200)}`);
	}
	const data = (await res.json().catch(() => null)) as { markdown?: unknown } | null;
	if (!data || typeof data.markdown !== 'string') throw new Error('OCR 응답에 markdown 이 없음');
	const md = data.markdown.replace(/[ \t]*<\| *LOC_\d+ *\|>[ \t]*/g, '').trim();
	if (!md) throw new Error('OCR 결과가 비어 있음');
	return md;
}
