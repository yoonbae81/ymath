import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOcr } from './ocr';

let work: string;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'ymath-ocr-'));
	writeFileSync(join(work, 'image.jpg'), 'img');
	writeFileSync(
		join(work, 'providers.json'),
		JSON.stringify({ providers: { omlx: { baseUrl: 'https://omlx.test/v1', apiKey: 'test-key' } } })
	);
	process.env.CONFIG_DIR = work;
	delete process.env.OMLX_BASE_URL;
	delete process.env.OMLX_API_KEY;
});

afterEach(() => {
	vi.restoreAllMocks();
	delete process.env.CONFIG_DIR;
	delete process.env.OCR_MODEL;
	delete process.env.OMLX_BASE_URL;
	delete process.env.OMLX_API_KEY;
	rmSync(work, { recursive: true, force: true });
});

describe('runOcr (oMLX chat/completions)', () => {
	it('image.jpg 를 data URL 로 보내고 LOC 토큰을 치운 markdown 을 돌려준다', async () => {
		let url = '';
		let headers: Record<string, string> = {};
		let body: any;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string, opts: any) => {
				url = u;
				headers = opts.headers;
				body = JSON.parse(opts.body);
				return {
					ok: true,
					status: 200,
					json: async () => ({
						choices: [{ message: { content: '0051 심\n<| LOC_69|> 두 이차방정식 <|LOC_10|>' } }]
					})
				};
			})
		);
		const md = await runOcr(work);
		expect(md).toBe('0051 심\n두 이차방정식');
		expect(url).toBe('https://omlx.test/v1/chat/completions');
		expect(headers).toMatchObject({ Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
		expect(body.model).toBe('PaddleOCR-VL-1.6-mlx');
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0]).toMatchObject({ role: 'system' });
		expect(body.messages[0].content).toContain('Markdown');
		expect(body.messages[1].content[0]).toEqual({
			type: 'image_url',
			image_url: { url: 'data:image/jpeg;base64,aW1n' }
		});
		expect(body.messages[1].content[1].text).toContain('Markdown 본문만 출력');
		expect(body.stream).toBe(false);
	});

	it('OCR_MODEL 환경변수로 모델을 바꾼다', async () => {
		process.env.OCR_MODEL = 'paddle-override';
		let model = '';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (_u: string, opts: any) => {
				model = JSON.parse(opts.body).model;
				return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '본문' } }] }) };
			})
		);
		await runOcr(work);
		expect(model).toBe('paddle-override');
	});

	it('OCR 주소와 키는 OMLX 환경변수 대신 providers.json 만 쓴다', async () => {
		process.env.OMLX_BASE_URL = 'https://wrong-env.test/v1';
		process.env.OMLX_API_KEY = 'wrong-env-key';
		let url = '';
		let authorization = '';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string, opts: any) => {
				url = u;
				authorization = opts.headers.Authorization;
				return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '본문' } }] }) };
			})
		);
		await runOcr(work);
		expect(url).toBe('https://omlx.test/v1/chat/completions');
		expect(authorization).toBe('Bearer test-key');
	});

	it('HTTP 오류면 사유를 담아 실패한다', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: false, status: 422, text: async () => 'parsing failed' }))
		);
		await expect(runOcr(work)).rejects.toThrow(/OCR 실패\(HTTP 422\).*parsing failed/);
	});

	it('markdown 이 없거나 비면 오류다', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) })));
		await expect(runOcr(work)).rejects.toThrow(/markdown 이 없음/);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '  ' } }] }) }))
		);
		await expect(runOcr(work)).rejects.toThrow(/OCR 결과가 비어 있음/);
	});

	it('연결 실패·시간 초과를 구분해 알린다', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
		await expect(runOcr(work)).rejects.toThrow(/OCR 서버\(https:\/\/omlx\.test\/v1\)에 연결할 수 없음/);
		const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
		vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(abort)));
		await expect(runOcr(work)).rejects.toThrow(/OCR 시간 초과/);
	});

	it('providers.json 의 omlx 주소나 키가 없으면 호출 전에 실패한다', async () => {
		writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { omlx: { baseUrl: 'https://omlx.test/v1' } } }));
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(runOcr(work)).rejects.toThrow(/providers\.json.*omlx baseUrl·apiKey/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
