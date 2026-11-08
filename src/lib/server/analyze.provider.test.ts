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
	// z.ai(GLM) 단일 설정 — providers.json 의 zai 항목이 유일한 설정 출처다
	writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { zai: { baseUrl: 'https://zai.test/api/coding/paas/v4', apiKey: 'test-key', models: [{ id: 'glm-5.3-flash' }] } } }));
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

describe('GLM 분석 HTTP', () => {
	it('기본값은 glm(glm-5.3-flash)', async () => {
		expect(providerFor(record())).toBe('glm');
		const res = await run(record());
		expect(res).toMatchObject({ provider: 'glm', model: 'glm-5.3-flash' });
	});
	it('glm 으로 분석하면 z.ai 엔드포인트를 호출하고 모델·스키마 지시가 담긴다', async () => {
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
		const res = await run(record('glm'));
		expect(res).toMatchObject({ provider: 'glm', model: 'glm-5.3-flash', taxonomyIssues: [], guardrailWarnings: [] });
		expect(capturedUrl).toBe('https://zai.test/api/coding/paas/v4/chat/completions');
		expect(capturedBody.model).toBe('glm-5.3-flash');
		// z.ai 코딩 엔드포인트는 json_object response_format 을 검증했다. 프롬프트 스키마는 보조 수단.
		expect(capturedBody.response_format).toEqual({ type: 'json_object' });
		// flash 계열은 추론 강제라 thinking 필드를 보내지 않는다
		expect(capturedBody.thinking).toBeUndefined();
		expect(capturedBody.max_tokens).toBe(16384);
		// GLM 비전 모델은 사진을 base64 data URL 로 첨부하고 첨부 안내가 프롬프트에 들어간다
		const parts = capturedBody.messages[1].content as any[];
		expect(parts).toHaveLength(2);
		expect(parts[0].type).toBe('image_url');
		expect(parts[0].image_url.url).toBe('data:image/jpeg;base64,aW1n');
		expect(parts[1].type).toBe('text');
		expect(parts[1].text).toContain('첨부된 이미지');
		expect(parts[1].text).toContain('준수해야 할 JSON Schema');
	});
	it('providers.json 의 zai 에 apiKey 가 없으면 z.ai 를 호출하지 않고 사유를 알린다', async () => {
		writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { zai: { baseUrl: 'https://zai.test/api/coding/paas/v4', models: [{ id: 'glm-5.3-flash' }] } } }));
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(run(record('glm'))).rejects.toThrow(/Z\.AI API 키가 설정되지 않았습니다/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
