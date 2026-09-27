import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOcr } from './ocr';

let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'ymath-ocr-'));
	writeFileSync(join(work, 'image.jpg'), 'img');
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(work, { recursive: true, force: true });
});

describe('runOcr (mdconv /convert)', () => {
	it('image.jpg 를 POST /convert 로 보내고 LOC 토큰을 치운 markdown 을 돌려준다', async () => {
		let url = '';
		let method = '';
		let body: any;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string, opts: any) => {
				url = u;
				method = opts.method;
				body = opts.body;
				return {
					ok: true,
					status: 200,
					json: async () => ({ format: 'jpeg', warnings: [], markdown: '0051 심\n<| LOC_69|> 두 이차방정식 <|LOC_10|>' })
				};
			})
		);
		const md = await runOcr(work);
		expect(md).toBe('0051 심\n두 이차방정식');
		expect(url).toBe('http://m/mdconv/convert');
		expect(method).toBe('POST');
		const file = body.get('file') as File;
		expect(file.name).toBe('image.jpg');
	});

	it('HTTP 오류면 사유를 담아 실패한다', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 422, text: async () => 'parsing failed' }))
		);
		await expect(runOcr(work)).rejects.toThrow(/OCR 실패\(HTTP 422\).*parsing failed/);
	});

	it('markdown 이 없거나 비면 오류다', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ format: 'jpeg' }) })));
		await expect(runOcr(work)).rejects.toThrow(/markdown 이 없음/);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ format: 'jpeg', markdown: '  ' }) }))
		);
		await expect(runOcr(work)).rejects.toThrow(/OCR 결과가 비어 있음/);
	});

	it('연결 실패·시간 초과를 구분해 알린다', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
		await expect(runOcr(work)).rejects.toThrow(/OCR 서버\(http:\/\/m\/mdconv\)에 연결할 수 없음/);
		const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)));
		await expect(runOcr(work)).rejects.toThrow(/OCR 시간 초과/);
	});
});
