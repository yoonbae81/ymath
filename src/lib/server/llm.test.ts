import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFakeCli } from './fake-cli';
import { AGY_MAX_PROMPT_BYTES, codexErrorMessage, firstJsonObject, parseAgyOutput, parseCodexOutput, parseJsonBody, runStructured, runText, toGeminiSchema } from './llm';
import { buildAnalysisSchema } from './taxonomy';
import { loadTaxonomy } from './taxonomy';

let work: string;
const log = () => JSON.parse(readFileSync(process.env.FAKE_LOG!, 'utf8'));
const SCHEMA = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false };

beforeEach(() => {
	work = realpathSync(mkdtempSync(join(tmpdir(), 'ymath-llm-')));
	process.env.CONFIG_DIR = work; // 실제 user/config/providers.json 이 테스트에 새지 않게 한다
	writeFileSync(join(work, 'work.jpg'), 'img');
	writeFileSync(join(work, 'out.json'), JSON.stringify({ a: '결과' }));
	process.env.FAKE_LOG = join(work, 'log.json');
	process.env.FAKE_OUT = join(work, 'out.json');
	process.env.CODEX_BIN = makeFakeCli('codex');
	process.env.AGY_BIN = makeFakeCli('agy');
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const k of ['FAKE_LOG', 'FAKE_OUT', 'FAKE_MODE', 'CODEX_BIN', 'CODEX_MODEL', 'AGY_BIN', 'AGY_MODEL', 'OMLX_API_KEY', 'CONFIG_DIR']) delete process.env[k];
	rmSync(work, { recursive: true, force: true });
});

const call = () => ({ prompt: '프롬프트 본문', schema: SCHEMA, dir: work, imagePath: join(work, 'work.jpg') });

describe('codex (구조화)', () => {
	it('올바른 인자로 실행하고 프롬프트는 stdin 으로 넘긴다', async () => {
		const r = await runStructured('codex', call());
		expect(r).toEqual({ output: { a: '결과' }, model: 'gpt-5.5' });

		const { args, stdin, schemaAtRun, cwd } = log();
		expect(stdin).toBe('프롬프트 본문');
		expect(args[0]).toBe('exec');
		expect(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2)).toEqual(['-m', 'gpt-5.5']);
		expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--skip-git-repo-check']));
		// 읽기 전용 샌드박스(사진은 첨부로 주므로 셸·파일 접근이 필요 없다)
		expect(args.slice(args.indexOf('-s'), args.indexOf('-s') + 2)).toEqual(['-s', 'read-only']);
		expect(args.slice(args.indexOf('-C'), args.indexOf('-C') + 2)).toEqual(['-C', work]);
		// -i 는 값을 여러 개 받으므로 뒤에 위치 인자가 없어야 한다(있으면 프롬프트가 이미지로 삼켜진다)
		expect(args.at(-2)).toBe('-i');
		expect(args.at(-1)).toBe(join(work, 'work.jpg'));
		expect(schemaAtRun).toEqual(SCHEMA);
		expect(cwd).toBe(work);
	});

	it('임시 스키마·결과 파일을 남기지 않는다(성공·실패 모두)', async () => {
		const before = readdirSync(work).sort();
		await runStructured('codex', call());
		process.env.FAKE_MODE = 'error';
		await expect(runStructured('codex', call())).rejects.toThrow();
		expect(readdirSync(work).sort()).toEqual([...before, 'log.json'].sort());
	});

	it('모델은 CODEX_MODEL 로 바꿀 수 있다', async () => {
		process.env.CODEX_MODEL = 'gpt-5.6-terra';
		expect((await runStructured('codex', call())).model).toBe('gpt-5.6-terra');
		expect(log().args).toContain('gpt-5.6-terra');
	});

	it('코드펜스로 감싼 JSON 도 읽는다', async () => {
		process.env.FAKE_MODE = 'fenced';
		expect((await runStructured('codex', call())).output).toEqual({ a: '결과' });
	});

	it('실패하면 훅 로그가 아니라 ERROR 사유를 오류 메시지로 쓴다', async () => {
		process.env.FAKE_MODE = 'error';
		const err = (await runStructured('codex', call()).catch((e: unknown) => e)) as Error;
		expect(err.message).toContain('usage limit');
		expect(err.message).not.toContain('hook:');
	});

	it('성공 종료인데 결과 파일이 없으면 오류', async () => {
		process.env.FAKE_MODE = 'nooutput';
		await expect(runStructured('codex', call())).rejects.toThrow(/결과 파일/);
	});
});

describe('알 수 없는 provider', () => {
	it('타입 검사를 우회한 옛 값(claude)은 실행하지 않고 오류를 낸다', async () => {
		await expect(runStructured('claude' as never, call())).rejects.toThrow(/사용할 수 없는 LLM/);
		expect(existsSync(process.env.FAKE_LOG!)).toBe(false);
	});
});

describe('agy (구조화)', () => {
	it('프롬프트는 -p 인자, 스키마는 파일 경로로 넘기고 권한 우회 옵션은 쓰지 않는다', async () => {
		const r = await runStructured('agy', call());
		expect(r).toEqual({ output: { a: '결과' }, model: 'gemini-3.1-pro-high' });
		const { args, promptArg, schemaAtRun, cwd, stdin } = log();
		expect(promptArg).toBe('프롬프트 본문');
		expect(stdin).toBe(''); // agy 는 stdin 을 쓰지 않는다
		expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gemini-3.1-pro-high']);
		expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 2)).toEqual(['--output-format', 'json']);
		expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', work]);
		expect(args).not.toContain('--dangerously-skip-permissions');
		expect(schemaAtRun).toEqual(SCHEMA);
		expect(cwd).toBe(work);
	});

	it('임시 스키마 파일을 남기지 않는다(성공·실패 모두)', async () => {
		const before = readdirSync(work).sort();
		await runStructured('agy', call());
		process.env.FAKE_MODE = 'error';
		await expect(runStructured('agy', call())).rejects.toThrow();
		expect(readdirSync(work).sort()).toEqual([...before, 'log.json'].sort());
	});

	it('모델은 AGY_MODEL 로 바꿀 수 있다', async () => {
		process.env.AGY_MODEL = 'gemini-3.8-flash-high';
		expect((await runStructured('agy', call())).model).toBe('gemini-3.8-flash-high');
		expect(log().args).toContain('gemini-3.8-flash-high');
	});

	it('structured_output 이 없으면 response 본문의 JSON 을 쓰고 도구 진행 표시는 뗀다', async () => {
		process.env.FAKE_MODE = 'response';
		expect((await runStructured('agy', call())).output).toEqual({ a: '결과' });
	});

	it('도구 권한이 거부돼 응답이 비면 원인을 알려 준다(status 는 SUCCESS 라 그냥 두면 원인 불명)', async () => {
		process.env.FAKE_MODE = 'denied';
		const err = (await runStructured('agy', call()).catch((e: unknown) => e)) as Error;
		expect(err.message).toMatch(/권한/);
		expect(err.message).toContain('RunCommand');
	});

	it('응답이 비고 거부 기록도 없으면 오류, 비정상 종료도 오류', async () => {
		process.env.FAKE_MODE = 'nooutput';
		await expect(runStructured('agy', call())).rejects.toThrow(/structured_output/);
		process.env.FAKE_MODE = 'error';
		await expect(runStructured('agy', call())).rejects.toThrow(/종료 코드 1/);
	});

	it('프롬프트가 인자 길이 한도를 넘으면 실행하지 않고 알린다', async () => {
		const big = { ...call(), prompt: '가'.repeat(AGY_MAX_PROMPT_BYTES / 3 + 10) };
		await expect(runStructured('agy', big)).rejects.toThrow(/너무 큼/);
		expect(existsSync(process.env.FAKE_LOG!)).toBe(false);
	});
});

describe('runText', () => {
	it('omlx: OpenAI 호환 엔드포인트로 본문을 받는다', async () => {
		process.env.OMLX_API_KEY = 'k';
		let url = '';
		let body: any;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (u: string, opts: any) => {
				url = u;
				body = JSON.parse(opts.body);
				return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '보고서 본문' } }] }) };
			})
		);
		const r = await runText('omlx', '써 줘');
		expect(r).toEqual({ text: '보고서 본문', model: 'mlx-community--Qwen3.8-27B-8bit' });
		expect(url).toBe('http://192.168.1.9:9000/v1/chat/completions');
		expect(body.model).toBe('mlx-community--Qwen3.8-27B-8bit');
		// 본문 요청에는 JSON 모드를 쓰지 않는다
		expect(body.response_format).toBeUndefined();
		expect(body.messages).toEqual([{ role: 'user', content: '써 줘' }]);
	});

	it('omlx: 키가 없으면 호출하지 않고 오류', async () => {
		await expect(runText('omlx', 'x')).rejects.toThrow(/oMLX API 키가 설정되지 않았습니다/);
	});

	it('agy: 도구를 쓰지 말라는 지시를 붙여 본문을 받는다', async () => {
		const r = await runText('agy', '보고서를 써 줘');
		expect(r).toEqual({ text: '본문', model: 'gemini-3.1-pro-high' });
		expect(log().promptArg).toMatch(/도구를 사용하지 말고[\s\S]*보고서를 써 줘/);
	});

	it('agy: 응답이 비면(권한 거부 등) 오류', async () => {
		process.env.FAKE_MODE = 'denied';
		await expect(runText('agy', 'x')).rejects.toThrow(/비었음/);
	});

	it('codex: 텍스트 결과를 읽고 임시 폴더를 지운다', async () => {
		writeFileSync(join(work, 'out.json'), '보고서 본문');
		const r = await runText('codex', '써 줘');
		expect(r).toEqual({ text: '보고서 본문', model: 'gpt-5.5' });
		const { args, stdin, cwd } = log();
		expect(stdin).toBe('써 줘');
		expect(args).not.toContain('--output-schema');
		expect(existsSync(cwd)).toBe(false);
	});

	it('codex 실패 사유를 전달한다', async () => {
		process.env.FAKE_MODE = 'error';
		await expect(runText('codex', 'x')).rejects.toThrow(/usage limit/);
	});
});

describe('toGeminiSchema', () => {
	it('숫자 enum 을 정수 범위로 바꾸고 문자열 enum·나머지는 그대로 둔다', () => {
		const src = {
			type: 'object',
			properties: {
				difficulty: { enum: [1, 2, 3, 4, 5], description: '난이도' },
				topic: { enum: ['대수', '기하'] },
				nested: { type: 'array', items: { enum: [1, 2, 3] } }
			}
		};
		expect(toGeminiSchema(src)).toEqual({
			type: 'object',
			properties: {
				difficulty: { type: 'integer', minimum: 1, maximum: 5, description: '난이도' },
				topic: { enum: ['대수', '기하'] },
				nested: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 3 } }
			}
		});
		expect(src.properties.difficulty.enum).toEqual([1, 2, 3, 4, 5]); // 원본은 바뀌지 않는다
	});

	it('실제 분석 스키마에는 숫자 enum 이 하나도 남지 않는다', () => {
		const hasNumericEnum = (n: any): boolean =>
			!!n && typeof n === 'object' && ((Array.isArray(n.enum) && n.enum.some((x: unknown) => typeof x !== 'string')) || Object.values(n).some(hasNumericEnum));
		const schema = buildAnalysisSchema(loadTaxonomy());
		expect(hasNumericEnum(schema)).toBe(true); // 원본에는 있다(검증용)
		expect(hasNumericEnum(toGeminiSchema(schema))).toBe(false);
	});

	it('agy 에는 변환된 스키마 파일을 넘긴다', async () => {
		const numeric = { type: 'object', properties: { d: { enum: [1, 2, 3] } }, required: ['d'], additionalProperties: false };
		await runStructured('agy', { ...call(), schema: numeric });
		expect(log().schemaAtRun.properties.d).toEqual({ type: 'integer', minimum: 1, maximum: 3 });
	});

	it('parseAgyOutput: structured_output 우선, 실패 상태·JSON 아님 오류', () => {
		expect(parseAgyOutput(JSON.stringify({ status: 'SUCCESS', structured_output: { a: 1 }, response: 'x' }))).toEqual({ a: 1 });
		expect(() => parseAgyOutput(JSON.stringify({ status: 'FAILURE', response: '오류 내용' }))).toThrow(/FAILURE/);
		// 실제 실패 응답: status ERROR, 사유는 error 필드, response 는 빈 문자열
		expect(() => parseAgyOutput(JSON.stringify({ status: 'ERROR', response: '', error: 'INVALID_ARGUMENT (code 400): enum cannot be empty' }))).toThrow(/INVALID_ARGUMENT/);
		expect(() => parseAgyOutput('garbage')).toThrow(/JSON/);
	});

	it('parseCodexOutput: 순수 JSON, 펜스 JSON, 깨진 출력', () => {
		expect(parseCodexOutput('{"a":1}')).toEqual({ a: 1 });
		expect(parseCodexOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
		expect(() => parseCodexOutput('말로만 답함')).toThrow(/JSON/);
	});

	it('parseJsonBody: thinking 이 섞인 출력에서도 첫 균형 객체를 건진다', () => {
		const noisy = "We need answer user's request: produce valid JSON only. Need think.\n{\"a\":\"결과\"}";
		expect(parseJsonBody('oMLX', noisy)).toEqual({ a: '결과' });
		// 문자열 안의 중괄호는 객체 경계가 아니다
		expect(firstJsonObject('{"s":"안에 { 있음"}')).toBe('{"s":"안에 { 있음"}');
		expect(() => parseJsonBody('oMLX', '생각만 하고 브레이스 없이 끝남')).toThrow(/JSON 이 아님/);
	});

	it('codexErrorMessage: ERROR 줄의 JSON 메시지, 일반 문자열, ERROR 가 없을 때', () => {
		expect(codexErrorMessage('hook: a\nERROR: {"error":{"message":"한도 초과"}}\nhook: b')).toBe('한도 초과');
		expect(codexErrorMessage('ERROR: 그냥 문자열')).toBe('그냥 문자열');
		expect(codexErrorMessage('hook: a\nsomething broke\nhook: b')).toBe('something broke');
	});
});

describe('스키마 호환성', () => {
	// codex(OpenAI 구조화 출력)는 모든 객체가 additionalProperties:false 이고 모든 속성이 required 여야 한다
	it('분석 스키마의 모든 객체가 OpenAI strict 요건을 만족한다', () => {
		const bad: string[] = [];
		const walk = (n: any, path: string) => {
			if (!n || typeof n !== 'object') return;
			if (n.properties) {
				if (n.additionalProperties !== false) bad.push(`${path}: additionalProperties`);
				const missing = Object.keys(n.properties).filter((k) => !(n.required ?? []).includes(k));
				if (missing.length) bad.push(`${path}: required 누락 ${missing.join(',')}`);
			}
			for (const [k, v] of Object.entries(n)) walk(v, `${path}/${k}`);
		};
		walk(buildAnalysisSchema(loadTaxonomy()), '#');
		expect(bad).toEqual([]);
	});
});
