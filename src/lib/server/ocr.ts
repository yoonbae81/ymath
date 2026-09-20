import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { settings } from './config';
import { exec } from './exec';
import { IMAGE_FILE } from './image';

/**
 * PaddleOCR(`ocr` CLI, 127.0.0.1:9004 데몬 재사용)로 image.jpg 를 Markdown 으로 바꾼다.
 * ocr 은 실행 디렉터리에 `<파일명(확장자 제외)>/0001.md` 를 만들므로 cwd 를 항목 폴더로 잡고, 읽은 뒤 치운다.
 */
export async function runOcr(dir: string): Promise<string> {
	const s = settings();
	const outDir = join(dir, IMAGE_FILE.replace(/\.[^.]+$/, ''));
	rmSync(outDir, { recursive: true, force: true });
	try {
		const r = await exec(s.ocrBin, [IMAGE_FILE, '1', '--replace'], { cwd: dir, timeoutMs: s.ocrTimeoutMs });
		if (r.timedOut) throw new Error(`OCR 시간 초과(${s.ocrTimeoutMs}ms)`);
		const page = join(outDir, '0001.md');
		if (r.code !== 0 || !existsSync(page))
			throw new Error(`OCR 실패(code=${r.code}): ${r.stderr.trim().split('\n').slice(-3).join(' | ')}`);
		return readFileSync(page, 'utf8').trim();
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
}
