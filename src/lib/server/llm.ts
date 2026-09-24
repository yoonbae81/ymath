import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '$lib/types';
import { settings } from './config';
import { exec } from './exec';

/** 사진 1장 + 프롬프트를 보내 JSON 스키마에 맞는 결과를 받는 호출 */
export interface StructuredCall {
	prompt: string;
	schema: object;
	/** 작업 디렉터리(임시 파일도 여기에 만들고 지운다) */
	dir: string;
	/** 분석할 사진. claude 는 프롬프트에 적힌 경로를 Read 로 열고, codex 는 -i 로 첨부한다 */
	imagePath: string;
}

export interface LlmOutput {
	output: unknown;
	model: string;
}

/** `claude -p --output-format json` 의 표준출력에서 구조화된 결과만 꺼낸다. */
export function parseClaudeOutput(stdout: string): unknown {
	let env: any;
	try {
		env = JSON.parse(stdout);
	} catch {
		throw new Error(`claude 출력이 JSON 이 아님: ${stdout.slice(0, 200)}`);
	}
	if (env.is_error) throw new Error(`claude 오류: ${String(env.result ?? env.subtype).slice(0, 300)}`);
	if (env.structured_output && typeof env.structured_output === 'object') return env.structured_output;
	// 구조화 필드가 없으면 result 본문의 JSON 을 시도한다
	if (typeof env.result === 'string') {
		try {
			return JSON.parse(env.result);
		} catch {
			/* fallthrough */
		}
	}
	throw new Error('claude 결과에 structured_output 이 없음');
}

/**
 * `agy -p --output-format json` 의 표준출력에서 구조화된 결과만 꺼낸다.
 * 헤드리스에서는 권한 확인창을 띄울 수 없어 도구가 자동 거부되면 status 는 SUCCESS 인데 응답이 비므로 그 경우를 따로 알린다.
 */
export function parseAgyOutput(stdout: string): unknown {
	let env: any;
	try {
		env = JSON.parse(stdout);
	} catch {
		throw new Error(`agy 출력이 JSON 이 아님: ${stdout.slice(0, 200)}`);
	}
	// 실패하면 status 가 ERROR 이고 사유는 error 필드에 있다(response 는 비어 있다)
	if (env.status && env.status !== 'SUCCESS') throw new Error(`agy 오류(${env.status}): ${String(env.error ?? env.response ?? '').slice(0, 300)}`);
	if (env.structured_output && typeof env.structured_output === 'object') return env.structured_output;
	if (typeof env.response === 'string' && env.response.trim()) {
		try {
			const obj = JSON.parse(env.response);
			// response 본문에는 도구 진행 표시(toolAction, toolSummary)가 섞여 나올 수 있다
			delete obj.toolAction;
			delete obj.toolSummary;
			return obj;
		} catch {
			/* fallthrough */
		}
	}
	const denied = (env.denied_actions ?? []).map((a: any) => a.display_name ?? a.action).join(', ');
	if (denied) throw new Error(`agy 도구 권한이 거부되어 응답이 비었음(${denied}). 헤드리스에서는 허용되지 않는 도구를 쓰려 했습니다`);
	throw new Error('agy 결과에 structured_output 이 없음');
}

/** codex 가 마지막 메시지로 쓴 JSON. 코드펜스로 감싸 오는 경우도 허용한다. */
export function parseCodexOutput(text: string): unknown {
	const body = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`codex 출력이 JSON 이 아님: ${text.slice(0, 200)}`);
	}
}

/** codex 는 실패 사유를 stderr 의 `ERROR:` 줄로 남기고 그 앞뒤에 훅 로그가 섞인다. */
export function codexErrorMessage(stderr: string): string {
	const lines = stderr.split('\n').map((l) => l.trim());
	const errors = lines.filter((l) => l.startsWith('ERROR:'));
	const last = errors.at(-1);
	if (last) {
		const raw = last.slice('ERROR:'.length).trim();
		try {
			const msg = JSON.parse(raw)?.error?.message;
			if (typeof msg === 'string') return msg.slice(0, 300);
		} catch {
			/* JSON 이 아니면 그대로 */
		}
		return raw.slice(0, 300);
	}
	return lines.filter((l) => l && !l.startsWith('hook:')).slice(-3).join(' | ').slice(0, 300);
}

export class QuotaExceededError extends Error {
	constructor(message: string, public readonly status?: number) {
		super(message);
		this.name = 'QuotaExceededError';
	}
}

export function isQuotaOrRateLimitError(err: unknown): boolean {
	if (err instanceof QuotaExceededError) return true;
	const msg = String(err instanceof Error ? err.message : err).toLowerCase();
	return (
		msg.includes('429') ||
		msg.includes('quota') ||
		msg.includes('rate limit') ||
		msg.includes('rate_limit') ||
		msg.includes('insufficient_quota') ||
		msg.includes('resource_exhausted') ||
		msg.includes('too many requests') ||
		msg.includes('1301') ||
		msg.includes('1302')
	);
}

export function parseZaiOutput(text: string): unknown {
	const body = text
		.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');
	try {
		return JSON.parse(body);
	} catch {
		throw new Error(`zai 출력이 JSON 이 아님: ${text.slice(0, 200)}`);
	}
}

async function structuredWithZai(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	const endpoint = `${s.zaiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), s.analyzeTimeoutMs);

	const promptWithSchema = `${c.prompt}\n\n---\n# 준수해야 할 JSON Schema\n${JSON.stringify(c.schema, null, 2)}\n\n위 JSON Schema에 정확히 맞는 유효한 JSON 객체 하나만 출력하세요.`;

	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${s.zaiApiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: s.zaiModel,
				messages: [
					{
						role: 'system',
						content:
							'당신은 학생의 수학 오답을 전문적으로 분석하고 코칭하는 수학 교육 전문가입니다. 주어진 JSON Schema를 엄격히 준수하여 순수 JSON 객체 하나만 출력하십시오. 마크다운 코드 블록이나 다른 텍스트는 일체 출력하지 마세요.'
					},
					{
						role: 'user',
						content: promptWithSchema
					}
				],
				response_format: { type: 'json_object' },
				thinking: { type: 'disabled' },
				max_tokens: 4096,
				temperature: 0.2
			}),
			signal: controller.signal
		});

		clearTimeout(timer);

		if (res.status === 429) {
			const errText = await res.text().catch(() => '');
			throw new QuotaExceededError(`z.ai 요청 한도 초과(HTTP 429): ${errText.slice(0, 200)}`, 429);
		}

		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			if (isQuotaOrRateLimitError(errText)) {
				throw new QuotaExceededError(`z.ai 할당량 소진 또는 제한(${res.status}): ${errText.slice(0, 200)}`, res.status);
			}
			throw new Error(`z.ai API 오류(${res.status}): ${errText.slice(0, 300)}`);
		}

		const data = (await res.json()) as any;
		if (data.error) {
			const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
			if (isQuotaOrRateLimitError(msg)) {
				throw new QuotaExceededError(`z.ai 할당량 소진: ${msg.slice(0, 200)}`);
			}
			throw new Error(`z.ai 응답 오류: ${msg.slice(0, 300)}`);
		}

		const choice = data.choices?.[0];
		const content = choice?.message?.content ?? '';
		if (!content.trim()) {
			throw new Error(`z.ai 응답 내용이 비었음 (finish_reason: ${choice?.finish_reason})`);
		}

		return { output: parseZaiOutput(content), model: s.zaiModel };
	} catch (e: any) {
		clearTimeout(timer);
		if (e.name === 'AbortError') {
			throw new Error(`분석 시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
		}
		throw e;
	}
}

async function structuredWithClaude(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	const r = await exec(
		s.claudeBin,
		[
			'-p',
			'--model',
			s.claudeModel,
			'--output-format',
			'json',
			'--json-schema',
			JSON.stringify(c.schema),
			'--tools',
			'Read',
			'--allowedTools',
			'Read',
			'--add-dir',
			c.dir,
			'--no-session-persistence'
		],
		{ cwd: c.dir, input: c.prompt, timeoutMs: s.analyzeTimeoutMs }
	);
	if (r.timedOut) throw new Error(`분석 시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
	if (r.code !== 0 && !r.stdout.trim()) throw new Error(`claude 종료 코드 ${r.code}: ${r.stderr.trim().slice(-300)}`);
	return { output: parseClaudeOutput(r.stdout), model: s.claudeModel };
}

async function structuredWithCodex(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	const schemaPath = join(c.dir, 'codex.schema.json');
	const outPath = join(c.dir, 'codex.out.json');
	writeFileSync(schemaPath, JSON.stringify(c.schema), 'utf8');
	rmSync(outPath, { force: true });
	try {
		// -i 는 값을 여러 개 받으므로 뒤에 위치 인자를 두지 않는다(프롬프트는 stdin 으로 넘긴다).
		// 읽기 전용 샌드박스: 사진은 첨부로 주므로 파일 시스템이나 셸 접근이 필요 없다.
		const r = await exec(
			s.codexBin,
			[
				'exec',
				'-m',
				s.codexModel,
				'--ephemeral',
				'--skip-git-repo-check',
				'-s',
				'read-only',
				'-C',
				c.dir,
				'--output-schema',
				schemaPath,
				'-o',
				outPath,
				'-i',
				c.imagePath
			],
			{ cwd: c.dir, input: c.prompt, timeoutMs: s.analyzeTimeoutMs }
		);
		if (r.timedOut) throw new Error(`분석 시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
		if (r.code !== 0) throw new Error(`codex 실패(code ${r.code}): ${codexErrorMessage(r.stderr)}`);
		let text: string;
		try {
			text = readFileSync(outPath, 'utf8');
		} catch {
			throw new Error(`codex 가 결과 파일을 만들지 않음: ${codexErrorMessage(r.stderr)}`);
		}
		return { output: parseCodexOutput(text), model: s.codexModel };
	} finally {
		rmSync(schemaPath, { force: true });
		rmSync(outPath, { force: true });
	}
}

/**
 * Gemini 의 함수 선언 스키마는 enum 값이 문자열이어야 해서 숫자 enum([1,2,3])을 400 으로 거부한다.
 * agy 로 보낼 때만 숫자 enum 을 정수 범위(minimum/maximum)로 바꾼다. 결과 검증은 원래 스키마로 한다.
 */
export function toGeminiSchema<T>(schema: T): T {
	const walk = (n: any): any => {
		if (Array.isArray(n)) return n.map(walk);
		if (!n || typeof n !== 'object') return n;
		const out: any = {};
		for (const [k, v] of Object.entries(n)) out[k] = walk(v);
		if (Array.isArray(out.enum) && out.enum.length && out.enum.every((x: unknown) => typeof x === 'number')) {
			const nums = out.enum as number[];
			delete out.enum;
			out.type = nums.every(Number.isInteger) ? 'integer' : 'number';
			out.minimum = Math.min(...nums);
			out.maximum = Math.max(...nums);
		}
		return out;
	};
	return walk(schema);
}

/** -p 의 값으로 넘기는 프롬프트의 길이 한도(리눅스 단일 인자 상한 128KiB 보다 여유 있게) */
export const AGY_MAX_PROMPT_BYTES = 120_000;

async function structuredWithAgy(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	const bytes = Buffer.byteLength(c.prompt, 'utf8');
	// agy 는 프롬프트를 -p 인자로 받는다(stdin 미지원). 너무 크면 exec 가 E2BIG 로 알 수 없게 죽으므로 미리 알린다
	if (bytes > AGY_MAX_PROMPT_BYTES) throw new Error(`agy 프롬프트가 너무 큼(${bytes}바이트 > ${AGY_MAX_PROMPT_BYTES}). 분류 체계나 지침을 줄이세요`);
	const schemaPath = join(c.dir, 'agy.schema.json');
	writeFileSync(schemaPath, JSON.stringify(toGeminiSchema(c.schema)), 'utf8');
	try {
		// 권한 우회 옵션(--dangerously-skip-permissions)은 쓰지 않는다. 사진은 view_file 로 읽고, 셸 명령은 프롬프트에서 금지한다.
		const r = await exec(
			s.agyBin,
			['-p', c.prompt, '--model', s.agyModel, '--output-format', 'json', '--json-schema', schemaPath, '--add-dir', c.dir],
			{ cwd: c.dir, timeoutMs: s.analyzeTimeoutMs }
		);
		if (r.timedOut) throw new Error(`분석 시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
		if (r.code !== 0 && !r.stdout.trim()) throw new Error(`agy 종료 코드 ${r.code}: ${r.stderr.trim().slice(-300)}`);
		return { output: parseAgyOutput(r.stdout), model: s.agyModel };
	} finally {
		rmSync(schemaPath, { force: true });
	}
}

/** 지정한 LLM 으로 사진을 분석해 구조화된 결과를 받는다. */
export function runStructured(provider: Provider, call: StructuredCall): Promise<LlmOutput> {
	if (provider === 'zai') return structuredWithZai(call);
	if (provider === 'codex') return structuredWithCodex(call);
	if (provider === 'agy') return structuredWithAgy(call);
	return structuredWithClaude(call);
}

/** 텍스트만 주고받는 호출(사진·스키마 없음). 보고서 작성처럼 프롬프트 → 본문만 필요한 곳에서 쓴다. */
export async function runText(provider: Provider, prompt: string): Promise<{ text: string; model: string }> {
	const s = settings();
	if (provider === 'zai') {
		const endpoint = `${s.zaiBaseUrl.replace(/\/+$/, '')}/chat/completions`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), s.analyzeTimeoutMs);
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${s.zaiApiKey}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({
					model: s.zaiModel,
					messages: [{ role: 'user', content: prompt }],
					thinking: { type: 'disabled' },
					max_tokens: 4096,
					temperature: 0.2
				}),
				signal: controller.signal
			});
			clearTimeout(timer);
			if (res.status === 429) {
				throw new QuotaExceededError('z.ai 요청 한도 초과(429)', 429);
			}
			if (!res.ok) {
				const errText = await res.text().catch(() => '');
				if (isQuotaOrRateLimitError(errText)) throw new QuotaExceededError(`z.ai 할당량 소진: ${errText.slice(0, 200)}`);
				throw new Error(`z.ai 오류(${res.status}): ${errText.slice(0, 300)}`);
			}
			const data = (await res.json()) as any;
			const text = data.choices?.[0]?.message?.content?.trim() ?? '';
			if (!text) throw new Error('z.ai 응답이 비었음');
			return { text, model: s.zaiModel };
		} catch (e: any) {
			clearTimeout(timer);
			if (e.name === 'AbortError') throw new Error(`시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
			throw e;
		}
	}
	if (provider === 'claude') {
		const r = await exec(s.claudeBin, ['-p', '--model', s.claudeModel, '--no-session-persistence'], {
			input: prompt,
			timeoutMs: s.analyzeTimeoutMs
		});
		if (r.timedOut) throw new Error(`시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
		if (r.code !== 0) throw new Error(`claude 실패(code ${r.code}): ${r.stderr.trim().slice(-300)}`);
		return { text: r.stdout.trim(), model: s.claudeModel };
	}
	if (provider === 'agy') {
		// 도구를 쓰려다 헤드리스 권한 거부로 응답이 비는 것을 막기 위해 본문만 답하게 한다
		const r = await exec(
			s.agyBin,
			['-p', `도구를 사용하지 말고 아래 요청에 대한 본문만 바로 답하라.\n\n${prompt}`, '--model', s.agyModel, '--output-format', 'json'],
			{ timeoutMs: s.analyzeTimeoutMs }
		);
		if (r.timedOut) throw new Error(`시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
		if (r.code !== 0 && !r.stdout.trim()) throw new Error(`agy 종료 코드 ${r.code}: ${r.stderr.trim().slice(-300)}`);
		let env: any;
		try {
			env = JSON.parse(r.stdout);
		} catch {
			throw new Error(`agy 출력이 JSON 이 아님: ${r.stdout.slice(0, 200)}`);
		}
		if (env.status && env.status !== 'SUCCESS') throw new Error(`agy 오류(${env.status})`);
		const text = String(env.response ?? '').trim();
		if (!text) throw new Error('agy 응답이 비었음(도구 권한 거부 가능성)');
		return { text, model: s.agyModel };
	}
	const dir = mkdtempSync(join(tmpdir(), 'ymath-codex-'));
	const outPath = join(dir, 'out.txt');
	try {
		const r = await exec(
			s.codexBin,
			['exec', '-m', s.codexModel, '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-C', dir, '-o', outPath],
			{ cwd: dir, input: prompt, timeoutMs: s.analyzeTimeoutMs }
		);
		if (r.timedOut) throw new Error(`시간 초과(${Math.round(s.analyzeTimeoutMs / 1000)}초)`);
		if (r.code !== 0) throw new Error(`codex 실패(code ${r.code}): ${codexErrorMessage(r.stderr)}`);
		return { text: readFileSync(outPath, 'utf8').trim(), model: s.codexModel };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
