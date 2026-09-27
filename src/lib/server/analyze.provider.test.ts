import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeItem, providerFor } from './analyze';
import { validAnalysis } from './analysis.fixture';
import { makeFakeCli } from './fake-cli';
import { AGY_MAX_PROMPT_BYTES } from './llm';
import type { ItemRecord, Provider } from '$lib/types';

let work: string;
const log = () => JSON.parse(readFileSync(process.env.FAKE_LOG!, 'utf8'));
const record = (requested?: Provider) =>
	({
		id: '20260919-100000-abcd',
		workbook: { id: 'w', name: '블랙라벨 중2-2', publisher: '블랙라벨', grade: '중2', semester: 2 },
		requested_provider: requested
	}) as ItemRecord;

beforeEach(() => {
	work = mkdtempSync(join(tmpdir(), 'ymath-prov-'));
	process.env.DATA_DIR = join(work, 'data'); // knownPatternIds 가 읽는다(비어 있음)
	// z.ai·oLMX 경로는 키가 없으면 호출 전에 실패하므로 기본 케이스에선 키를 준다
	process.env.ZAI_API_KEY = 'test-key';
	process.env.OLMX_API_KEY = 'test-key';
	writeFileSync(join(work, 'image.jpg'), 'img');
	writeFileSync(join(work, 'out.json'), JSON.stringify(validAnalysis()));
	process.env.FAKE_LOG = join(work, 'log.json');
	process.env.FAKE_OUT = join(work, 'out.json');
	process.env.CODEX_BIN = makeFakeCli('codex');
	process.env.AGY_BIN = makeFakeCli('agy');
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
	for (const k of ['DATA_DIR', 'FAKE_LOG', 'FAKE_OUT', 'FAKE_MODE', 'CODEX_BIN', 'AGY_BIN', 'ANALYZE_PROVIDER', 'ZAI_API_KEY', 'OLMX_API_KEY', 'CONFIG_DIR']) delete process.env[k];
	rmSync(work, { recursive: true, force: true });
});

const run = (r: ItemRecord) => analyzeItem({ record: r, dir: work, ocrText: '$x$' });

describe('분석 LLM 선택', () => {
	it('기본값은 zai(glm-5.3)', async () => {
		expect(providerFor(record())).toBe('zai');
		const res = await run(record());
		expect(res).toMatchObject({ provider: 'zai', model: 'glm-5.3' });
	});

	it('ANALYZE_PROVIDER=codex 로 서버 기본값을 바꾼다', async () => {
		process.env.ANALYZE_PROVIDER = 'codex';
		expect(providerFor(record())).toBe('codex');
		expect((await run(record())).provider).toBe('codex');
	});

	it('항목의 requested_provider 가 서버 기본값보다 우선한다', async () => {
		process.env.ANALYZE_PROVIDER = 'codex';
		expect(providerFor(record('agy'))).toBe('agy');
		const res = await run(record('agy'));
		expect(res.provider).toBe('agy');
		process.env.ANALYZE_PROVIDER = 'agy';
		expect((await run(record('codex'))).provider).toBe('codex');
	});

	it('codex 로 분석하면 사진을 첨부하고 프롬프트는 첨부 안내로 바뀐다', async () => {
		const res = await run(record('codex'));
		expect(res).toMatchObject({ provider: 'codex', model: 'gpt-5.5', taxonomyIssues: [], guardrailWarnings: [] });
		const { args, stdin } = log();
		expect(args.at(-1)).toBe(join(work, 'image.jpg'));
		expect(stdin).toContain('첨부된 이미지');
		expect(stdin).not.toContain('Read 도구로 반드시 직접 열어'); // claude 전용 안내가 섞이지 않는다
		expect(stdin).not.toContain('Read 도구'); // 지침 본문도 특정 LLM 의 도구 이름에 의존하지 않는다
		// 같은 지침·분류 체계·OCR 이 함께 간다
		expect(stdin).toContain('절대 규칙');
		expect(stdin).toContain('GEO-CIRCLE-EQ');
		expect(stdin).toContain('$x$');
	});

	it('agy 로 분석하면 셸 금지·view_file 안내와 절대 경로가 프롬프트에 들어간다', async () => {
		const res = await run(record('agy'));
		expect(res).toMatchObject({ provider: 'agy', model: 'gemini-3.1-pro-high', taxonomyIssues: [], guardrailWarnings: [] });
		const { promptArg } = log();
		expect(promptArg).toContain('셸 명령(run_command)은 절대 쓰지 말고 view_file');
		expect(promptArg).toContain(join(work, 'image.jpg')); // 상대 경로가 아니라 절대 경로여야 에이전트가 pwd/ls 로 헤매지 않는다
		expect(promptArg).toContain('절대 규칙');
		expect(promptArg).toContain('GEO-CIRCLE-EQ');
		expect(promptArg).not.toContain('Read 도구');
	});

	it('실제 분석 프롬프트는 agy 인자 한도(120KB)에 넉넉히 들어간다', async () => {
		await run(record('agy'));
		expect(Buffer.byteLength(log().promptArg, 'utf8')).toBeLessThan(AGY_MAX_PROMPT_BYTES * 0.6);
	});

	it('ANALYZE_PROVIDER=agy 로 기본값을 바꾸고, 알 수 없는 값과 삭제된 claude 는 zai 로 둔다', async () => {
		process.env.ANALYZE_PROVIDER = 'agy';
		expect(providerFor(record())).toBe('agy');
		process.env.ANALYZE_PROVIDER = 'gemini';
		expect(providerFor(record())).toBe('zai');
		process.env.ANALYZE_PROVIDER = 'claude';
		expect(providerFor(record())).toBe('zai');
		// 옛 기록에 claude 가 지정돼 있어도 기본값으로 되돌린다
		process.env.ANALYZE_PROVIDER = 'codex';
		expect(providerFor(record('claude' as Provider))).toBe('codex');
	});

	it('zai 로 분석하면 z.ai 엔드포인트를 호출하고 OCR 안내가 프롬프트에 들어간다', async () => {
		let capturedBody: any;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, opts: any) => {
				capturedBody = JSON.parse(opts.body);
				return {
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
					})
				} as any;
			})
		);
		const res = await run(record('zai'));
		expect(res).toMatchObject({ provider: 'zai', model: 'glm-5.3', taxonomyIssues: [], guardrailWarnings: [] });
		expect(capturedBody.model).toBe('glm-5.3');
		expect(capturedBody.messages[1].content).toContain('제공된 OCR 텍스트와 문제집 정보를 바탕으로 분석하세요');
	});

	it('API 키가 없으면 z.ai 를 호출하지 않고 사유를 알린다', async () => {
		delete process.env.ZAI_API_KEY;
		process.env.CONFIG_DIR = join(work, 'cfg'); // 저장된 키도 없는 상태
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(run(record('zai'))).rejects.toThrow(/API 키가 설정되지 않았습니다/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('olmx 로 분석하면 oLMX 엔드포인트를 호출하고 모델·스키마 지시가 담긴다', async () => {
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
		const res = await run(record('olmx'));
		expect(res).toMatchObject({ provider: 'olmx', model: 'Qwen3.8 27B', taxonomyIssues: [], guardrailWarnings: [] });
		expect(capturedUrl).toBe('http://192.168.1.9:9000/v1/chat/completions');
		expect(capturedBody.model).toBe('Qwen3.8 27B');
		expect(capturedBody.response_format).toEqual({ type: 'json_object' });
		expect(capturedBody.messages[1].content).toContain('준수해야 할 JSON Schema');
		expect(capturedBody.messages[1].content).toContain('제공된 OCR 텍스트와 문제집 정보를 바탕으로 분석하세요');
	});

	it('OLMX_API_KEY 가 없으면 oLMX 를 호출하지 않고 사유를 알린다', async () => {
		delete process.env.OLMX_API_KEY;
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		await expect(run(record('olmx'))).rejects.toThrow(/oLMX API 키가 설정되지 않았습니다/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('agy 결과에도 스키마 검증과 정답 노출 가드레일이 적용된다', async () => {
		const leak: any = validAnalysis();
		leak.error_analysis.nudges.strategy_question = '정답은 6개인데 다시 세어 볼까요?';
		writeFileSync(join(work, 'out.json'), JSON.stringify(leak));
		await expect(run(record('agy'))).rejects.toThrow(/가드레일/);
	});

	it('codex 결과에도 스키마 검증과 정답 노출 가드레일이 똑같이 적용된다', async () => {
		const bad: any = validAnalysis();
		bad.classification.topic = '통계학'; // curriculum 에 없는 영역
		writeFileSync(join(work, 'out.json'), JSON.stringify(bad));
		await expect(run(record('codex'))).rejects.toThrow(/스키마/);

		const leak: any = validAnalysis();
		leak.error_analysis.nudges.condition_question = 'x=6 이 조건에 맞나요?';
		writeFileSync(join(work, 'out.json'), JSON.stringify(leak));
		await expect(run(record('codex'))).rejects.toThrow(/가드레일/);
	});

	it('codex 호출이 실패하면 사유가 분석 오류로 전달된다', async () => {
		process.env.FAKE_MODE = 'error';
		await expect(run(record('codex'))).rejects.toThrow(/usage limit/);
	});
});
