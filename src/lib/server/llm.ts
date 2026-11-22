import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Provider } from '$lib/types';
import { settings } from './config';
import {
	MATH_COACH_SYSTEM,
	firstJsonObject,
	imageUserMessage as base64ImageUserMessage,
	isQuotaOrRateLimitError,
	parseJsonBody,
	promptWithSchema,
	QuotaExceededError
} from './llm-core';
import type { ChatContentPart } from './llm-core';

// 순수 구현은 llm-core.ts 가 소유하고 여기서 재노출한다(계약 보존).
export { MATH_COACH_SYSTEM, firstJsonObject, isQuotaOrRateLimitError, parseJsonBody, promptWithSchema, QuotaExceededError };
export type { ChatContentPart };

/** 사진 1장 + 프롬프트를 보내 JSON 스키마에 맞는 결과를 받는 호출 */
export interface StructuredCall {
	prompt: string;
	schema: object;
	/** 작업 디렉터리(임시 파일도 여기에 만들고 지운다) */
	dir: string;
	/** 분석할 사진. GLM에 base64 data URL 로 첨부한다 */
	imagePath: string;
}

export interface LlmOutput {
	output: unknown;
	model: string;
}

const missingKeyError = (provider: string, how: string) => new Error(`${provider} API 키가 설정되지 않았습니다. ${how}`);

/** image.jpg 를 base64 data URL 로 첨부한 멀티모달 user 메시지(GLM) */
const imageUserMessage = (imagePath: string, prompt: string): { role: 'user'; content: ChatContentPart[] } =>
	base64ImageUserMessage(readFileSync(imagePath).toString('base64'), prompt);

/**
 * OpenAI 호환 chat/completions 한 번 호출하고 응답 본문을 반환한다.
 * z.ai에서 한 곳에서 429·할당량·빈 응답을 처리한다.
 */
async function chatCompletion(o: {
	label: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	/** content 는 문자열 또는 멀티모달 파트 배열(이미지 data URL + 텍스트) */
	messages: { role: 'system' | 'user'; content: string | ChatContentPart[] }[];
	/** response_format: json_object 를 보낸다. 미지원 서버를 위해 끌 수 있다 */
	jsonMode: boolean;
	extraBody?: Record<string, unknown>;
	timeoutMs: number;
}): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), o.timeoutMs);
	try {
		const res = await fetch(`${o.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
			method: 'POST',
			headers: {
				...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: o.model,
				messages: o.messages,
				...(o.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
				max_tokens: 4096,
				temperature: 0.2,
				...o.extraBody
			}),
			signal: controller.signal
		});

		if (res.status === 429) {
			const errText = await res.text().catch(() => '');
			throw new QuotaExceededError(`${o.label} 요청 한도 초과(HTTP 429): ${errText.slice(0, 200)}`, 429);
		}

		if (!res.ok) {
			const errText = await res.text().catch(() => '');
			if (isQuotaOrRateLimitError(errText)) {
				throw new QuotaExceededError(`${o.label} 할당량 소진 또는 제한(${res.status}): ${errText.slice(0, 200)}`, res.status);
			}
			throw new Error(`${o.label} API 오류(${res.status}): ${errText.slice(0, 300)}`);
		}

		const data = (await res.json()) as any;
		if (data.error) {
			const msg = typeof data.error === 'string' ? data.error : data.error.message || JSON.stringify(data.error);
			if (isQuotaOrRateLimitError(msg)) {
				throw new QuotaExceededError(`${o.label} 할당량 소진: ${msg.slice(0, 200)}`);
			}
			throw new Error(`${o.label} 응답 오류: ${msg.slice(0, 300)}`);
		}

		const choice = data.choices?.[0];
		const content = choice?.message?.content ?? '';
		if (!content.trim()) {
			const reasoningTokens = data.usage?.completion_tokens_details?.reasoning_tokens;
			const detail = reasoningTokens ? `, reasoning_tokens: ${reasoningTokens}` : '';
			throw new Error(`${o.label} 응답 내용이 비었음 (finish_reason: ${choice?.finish_reason}${detail})`);
		}
		return content;
	} catch (e: any) {
		if (e.name === 'AbortError') {
			throw new Error(`분석 시간 초과(${Math.round(o.timeoutMs / 1000)}초)`);
		}
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 모델별 z.ai 요청 옵션. GLM-5.3-Flash·GLM-5V 계열은 추론을 강제해서 thinking 을 끌 수 없으므로
 * 텍스트 전용 모델(glm-5.3)일 때만 thinking 을 끈다. 추론 토큰이 응답 JSON 과 함께 max_tokens 를
 * 소비하므로 넉넉하게 둔다. 16384 로 두면 무거운 시험지 페이지(실제 분석 프롬프트는 지침+교육과정+
 * 분류 체계+OCR 텍스트+스키마가 결합)에서 추론만으로 상한을 소진해 finish_reason: length 로
 * 본문이 비어 실패했다(2026-11-22 실측) — API 는 98304 까지 받는 것을 확인했다.
 */
const zaiExtraBody = (model: string): Record<string, unknown> => ({
	max_tokens: 65536,
	...(/flash|5v/.test(model) ? {} : { thinking: { type: 'disabled' as const } })
});

async function structuredWithZai(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	if (!s.zaiApiKey) throw missingKeyError('Z.AI', 'user/config/providers.json 의 zai apiKey 를 채우세요');
	if (!s.zaiBaseUrl)
		throw new Error('user/config/providers.json 의 zai 에 baseUrl 을 채우세요 — z.ai 코딩 엔드포인트(https://api.z.ai/api/coding/paas/v4)를 쓴다');
	const { zaiBaseUrl, zaiApiKey, zaiModel } = s;
	const content = await chatCompletion({
		label: 'z.ai',
		baseUrl: zaiBaseUrl,
		apiKey: zaiApiKey,
		model: zaiModel,
		messages: [{ role: 'system', content: MATH_COACH_SYSTEM }, imageUserMessage(c.imagePath, promptWithSchema(c.prompt, c.schema))],
		jsonMode: true,
		extraBody: zaiExtraBody(zaiModel),
		timeoutMs: s.analyzeTimeoutMs
	});
	return { output: parseJsonBody('zai', content), model: zaiModel };
}

/** Agy(Antigravity CLI, Gemini) 레인 — 사진은 프롬프트의 파일 경로로 전달하고 CLI 가 직접 연다 */

/** 셸 명령 문자열로 들어가는 설정값은 인용이 필요 없는 문자만 받는다 */
const shellSafe = (v: string, what: string) => {
	if (!/^[A-Za-z0-9_@+./-]+$/.test(v)) throw new Error(`${what}에 셸 특수문자가 있습니다: ${v}`);
	return v;
};

/** 프롬프트 파일 이름 — dir 에 만들고 호출 뒤 지운다. CLI 인자 직접 전달은 Linux 128KB 인자 상한(E2BIG)에 걸린다 */
const AGY_PROMPT_FILE = 'agy-prompt.txt';

/** Agy CLI 한 번 호출. 프롬프트 파일을 읽어 print 모드로 실행하고 표준 출력을 반환한다 */
function agyCliPrint(o: { dir: string; prompt: string; bin: string; model: string; timeoutMs: number }): Promise<string> {
	const bin = shellSafe(o.bin, 'agy bin');
	const model = shellSafe(o.model, 'agy model');
	writeFileSync(join(o.dir, AGY_PROMPT_FILE), o.prompt, 'utf8');
	return new Promise((resolve, reject) => {
		// detached + 프로세스 그룹 kill: 타임아웃 때 agy 가 남긴 자식까지 정리한다
		const child = spawn(
			'sh',
			['-c', `exec '${bin}' --print "$(cat ${AGY_PROMPT_FILE})" --model '${model}' --dangerously-skip-permissions`],
			{ cwd: o.dir, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
		);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		const timer = setTimeout(() => {
			try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
			reject(new Error(`분석 시간 초과(${Math.round(o.timeoutMs / 1000)}초)`));
		}, o.timeoutMs);
		child.stdout.on('data', (d: Buffer) => out.push(d));
		child.stderr.on('data', (d: Buffer) => err.push(d));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new Error(`Agy CLI 실행 실패(${o.bin}): ${e.message}`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			const stdout = Buffer.concat(out).toString('utf8');
			const stderr = Buffer.concat(err).toString('utf8');
			if (code === 0 && stdout.trim()) return resolve(stdout);
			const tail = (stderr || stdout || '(출력 없음)').trim().slice(-300);
			if (isQuotaOrRateLimitError(`${stdout}\n${stderr}`)) {
				return reject(new QuotaExceededError(`Agy 할당량 소진 또는 제한: ${tail.slice(0, 200)}`));
			}
			reject(new Error(`Agy CLI 오류(exit ${code}): ${tail}`));
		});
	});
}

async function structuredWithAgy(c: StructuredCall): Promise<LlmOutput> {
	const s = settings();
	try {
		const text = await agyCliPrint({
			dir: c.dir,
			prompt: promptWithSchema(c.prompt, c.schema),
			bin: s.agyBin,
			model: s.agyModel,
			timeoutMs: s.analyzeTimeoutMs
		});
		return { output: parseJsonBody('agy', text), model: s.agyModel };
	} finally {
		try { unlinkSync(join(c.dir, AGY_PROMPT_FILE)); } catch { /* 없어도 무관 */ }
	}
}

/** 텍스트 전용 Agy 호출. 프롬프트는 임시 디렉터리의 파일로 전달하고 정리한다 */
async function textWithAgy(prompt: string, bin: string, model: string, timeoutMs: number): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), 'ymath-agy-'));
	try {
		return await agyCliPrint({ dir, prompt, bin, model, timeoutMs });
	} finally {
		try { unlinkSync(join(dir, AGY_PROMPT_FILE)); } catch { /* 없어도 무관 */ }
	}
}

/** 지정한 LLM 으로 사진을 분석해 구조화된 결과를 받는다. */
export function runStructured(provider: Provider, call: StructuredCall): Promise<LlmOutput> {
	if (provider === 'agy') return structuredWithAgy(call);
	if (provider === 'glm') return structuredWithZai(call);
	// 옛 기록의 requested_provider 같은 값이 타입 검사를 우회해 올 수 있다
	return Promise.reject(new Error(`사용할 수 없는 LLM 입니다: ${provider}`));
}

/** 텍스트만 주고받는 호출(사진·스키마 없음). 보고서 작성처럼 프롬프트 → 본문만 필요한 곳에서 쓴다. */
export async function runText(provider: Provider, prompt: string): Promise<{ text: string; model: string }> {
	const s = settings();
	if (provider === 'agy') {
		const text = await textWithAgy(prompt, s.agyBin, s.agyModel, s.analyzeTimeoutMs);
		return { text: text.trim(), model: s.agyModel };
	}
	if (provider === 'glm') {
		if (!s.zaiApiKey) throw missingKeyError('Z.AI', 'user/config/providers.json 의 zai apiKey 를 채우세요');
		if (!s.zaiBaseUrl || !s.zaiModel)
			throw new Error('user/config/providers.json 의 zai 에 baseUrl 과 models[0].id 를 채우세요 — 환경변수 우회나 하드코드 폴백은 없다');
		const text = await chatCompletion({
			label: 'z.ai',
			baseUrl: s.zaiBaseUrl,
			apiKey: s.zaiApiKey,
			model: s.zaiModel,
			messages: [{ role: 'user', content: prompt }],
			jsonMode: false,
			extraBody: zaiExtraBody(s.zaiModel),
			timeoutMs: s.analyzeTimeoutMs
		});
		return { text: text.trim(), model: s.zaiModel };
	}
	throw new Error(`사용할 수 없는 LLM 입니다: ${provider}`);
}
