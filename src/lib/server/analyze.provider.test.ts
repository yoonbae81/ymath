import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeItem, providerFor } from './analyze';
import { validAnalysis } from './analysis.fixture';
import type { ItemRecord, Provider } from '$lib/types';

let work: string;
const record = (requested?: Provider) =>
	({
		id: '20260919-100000-abcd',
		workbook: { id: 'w', name: '블랙라벨 중2-2', publisher: '블랙라벨', grade: '중2', semester: 2 },
		requested_provider: requested
	}) as ItemRecord;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'ymath-prov-'));
	process.env.DATA_DIR = join(work, 'data'); // knownPatternIds 가 읽는다(비어 있음)
	process.env.CONFIG_DIR = work; // 실제 user/config/providers.json 이 테스트에 새지 않게 한다
	// z.ai 경로는 키가 없으면 호출 전에 실패하므로 기본 케이스에선 키를 준다. omlx 는 providers.json 픽스처로 지정한다(단일 소스)
	writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { omlx: { baseUrl: 'http://omlx.test/v1', apiKey: 'test-key', models: [{ id: 'Qwen3.6-35B-A3B' }] } } }));
	writeFileSync(join(work, 'image.jpg'), 'img');
	writeFileSync(join(work, 'out.json'), JSON.stringify(validAnalysis()));
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [
					{
						message: {
							content: JSON.stringify(validAnalysis())
						}
					}
				]
			}),
			text: async () => ''
		}))
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const k of ['DATA_DIR', 'FAKE_LOG', 'FAKE_OUT', 'FAKE_MODE', 'CODEX_BIN', 'AGY_BIN', 'ANALYZE_PROVIDER', 'ZAI_API_KEY', 'CONFIG_DIR']) delete process.env[k];
	rmSync(work, { recursive: true, force: true });
});

const run = (r: ItemRecord) => analyzeItem({ record: r, dir: work, ocrText: '$x$' });

describe('Qwen 분석 HTTP', () => {
	it('기본값은 omlx(Qwen3.6 35B-A3B)', async () => {
		expect(providerFor(record())).toBe('omlx');
		const res = await run(record());
		expect(res).toMatchObject({ provider: 'omlx', model: 'Qwen3.6-35B-A3B' });
	});
	it('omlx 로 분석하면 oMLX 엔드포인트를 호출하고 모델·스키마 지시가 담긴다', async () => {
		let capturedUrl = '';
		let capturedBody: any;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, opts: any) => {
				capturedUrl = url;
				capturedBody = JSON.parse(opts.body);
				expect(opts.headers.Authorization).toBe('Bearer test-key');
				return {
					ok: true,
					status: 200,
					json: async () => ({
						choices: [{ message: { content: JSON.stringify(validAnalysis()) } }]
					})
				} as any;
			})
		);
		const res = await run(record('omlx'));
		expect(res).toMatchObject({ provider: 'omlx', model: 'Qwen3.6-35B-A3B', taxonomyIssues: [], guardrailWarnings: [] });
		expect(capturedUrl).toBe('http://omlx.test/v1/chat/completions');
		expect(capturedBody.model).toBe('Qwen3.6-35B-A3B');
		expect(capturedBody.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema: expect.any(Object) } });
		// Qwen3.6 은 멀티모달 — 사진을 base64 data URL 로 첨부하고 첨부 안내가 프롬프트에 들어간다
		const parts = capturedBody.messages[1].content as any[];
		expect(parts).toHaveLength(2);
		expect(parts[0].type).toBe('image_url');
		expect(parts[0].image_url.url).toBe('data:image/jpeg;base64,aW1n');
		expect(parts[1].type).toBe('text');
		expect(parts[1].text).toContain('첨부된 이미지');
		expect(parts[1].text).toContain('준수해야 할 JSON Schema');
	});
	it('providers.json 의 omlx 에 apiKey 가 없으면 oMLX 를 호출하지 않고 사유를 알린다', async () => {
		writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { omlx: { baseUrl: 'http://omlx.test/v1', models: [{ id: 'Qwen3.6-35B-A3B' }] } } }));
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(run(record('omlx'))).rejects.toThrow(/oMLX API 키가 설정되지 않았습니다/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
