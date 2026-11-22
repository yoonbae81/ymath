import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeItem, providerFor } from './analyze';
import { validAnalysis } from './analysis.fixture';
import type { ItemRecord, Provider } from '$lib/types';

// Agy 레인은 실제 CLI를 실행하므로 spawn을 가짜 프로세스로 대체한다
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

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
	// z.ai만 있는 기본 설정 — providers.json 에 agy 항목이 없으면 디폴트 provider는 glm 이다
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
	for (const k of ['DATA_DIR', 'CONFIG_DIR']) delete process.env[k];
	rmSync(work, { recursive: true, force: true });
});

const run = (r: ItemRecord) => analyzeItem({ record: r, dir: work, ocrText: '$x$' });

/** spawn이 가짜 agy 프로세스를 돌려준다. spawn 시점의 프롬프트 파일 내용을 캡처한다 */
const fakeAgy = (stdout: string, code = 0, stderr = '') => {
	let promptInFile = '';
	vi.mocked(spawn).mockImplementation(() => {
		promptInFile = readFileSync(join(work, 'agy-prompt.txt'), 'utf8');
		const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.pid = 4242;
		queueMicrotask(() => {
			if (stdout) child.stdout.emit('data', Buffer.from(stdout));
			if (stderr) child.stderr.emit('data', Buffer.from(stderr));
			child.emit('close', code);
		});
		return child as never;
	});
	return {
		spawnCall: () => vi.mocked(spawn).mock.calls.at(-1) as unknown as [string, string[], { cwd: string }],
		prompt: () => promptInFile
	};
};

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
		expect(capturedBody.max_tokens).toBe(65536);
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

describe('Agy(Gemini CLI) 분석', () => {
	it('agy 항목이 있으면 디폴트 provider는 agy이고 CLI 레인으로 실행된다', async () => {
		writeFileSync(
			join(work, 'providers.json'),
			JSON.stringify({ providers: { agy: { bin: '/opt/agy/bin/agy', models: [{ id: 'gemini-3.8-flash-high' }] } } })
		);
		expect(providerFor(record())).toBe('agy');
		const fake = fakeAgy(JSON.stringify(validAnalysis()));
		const res = await run(record());
		expect(res).toMatchObject({ provider: 'agy', model: 'gemini-3.8-flash-high' });
		const [file, args, opts] = fake.spawnCall();
		expect(file).toBe('sh');
		const cmd = args[1];
		expect(cmd).toContain("exec '/opt/agy/bin/agy' --print \"$(cat agy-prompt.txt)\"");
		expect(cmd).toContain("--model 'gemini-3.8-flash-high'");
		expect(cmd).toContain('--dangerously-skip-permissions');
		expect(opts.cwd).toBe(work);
		// 프롬프트는 파일 경로로 사진을 지시하고, 호출 뒤 프롬프트 파일은 지워진다
		expect(fake.prompt()).toContain(`파일 ${join(work, 'image.jpg')} 를 파일 열기 도구로 직접 열어 보고 분석하세요`);
		expect(fake.prompt()).toContain('준수해야 할 JSON Schema');
		expect(existsSync(join(work, 'agy-prompt.txt'))).toBe(false);
	});

	it('agy 항목에 모델이 없으면 기본 모델 gemini-3.8-flash-medium 을 쓴다', async () => {
		writeFileSync(join(work, 'providers.json'), JSON.stringify({ providers: { agy: {} } }));
		const fake = fakeAgy(JSON.stringify(validAnalysis()));
		const res = await run(record('agy'));
		expect(res).toMatchObject({ provider: 'agy', model: 'gemini-3.8-flash-medium' });
		expect(fake.spawnCall()[2].cwd).toBe(work);
	});

	it('CLI 실패는 stderr 꼬리와 함께 분석 실패로 전달된다', async () => {
		const fake = fakeAgy('', 1, 'model not found');
		await expect(run(record('agy'))).rejects.toThrow(/Agy CLI 오류\(exit 1\): model not found/);
		expect(fake.spawnCall()[0]).toBe('sh');
	});

	it('할당량·429 문구는 재시도 큐가 알아보는 할당량 오류로 분류된다', async () => {
		fakeAgy('', 1, '429 Too Many Requests');
		await expect(run(record('agy'))).rejects.toThrow(/할당량 소진 또는 제한/);
	});
});
