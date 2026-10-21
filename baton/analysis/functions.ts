/**
 * ymath baton App 소유 function 소스(순수 — fs·네트워크·credential 없음).
 *
 * 이 모듈은 `analysis` 산출물 유형의 와이어 계약과 프롬프트 조립·구조 검증의 유일한 근원이다.
 * - baton 공통 Runner의 신뢰 adapter(baton 레포 src/ymath/)가 SHS 파일럿이
 *   /Users/y/Github/shs/baton/solutions/functions.ts 를 절대경로 import 하듯 이 파일을 import 한다.
 * - ymath Worker(baton backend)도 같은 계약 상수·검증기를 import 해서 양쪽이 하나의 근원을 공유한다.
 *
 * 자산 배치(2026-10-19 원칙): 이 디렉터리(analysis/)가 산출물 유형별 디렉터리다.
 * 계약 근원: contract.md(구조·표기·가드레일의 유일 근원), instruction.md(모델 행동 규칙 —
 * run 실행·입력·종료 조건 포함), analysis.output.schema.json(출력 기계 schema),
 * analysis.input.schema.json(요청 매니페스트 기계 schema). 별도 functions/·types/·schemas/ 트리는 없다.
 */
import {
	MATH_COACH_SYSTEM,
	imageUserMessage,
	promptWithSchema,
	type ChatContentPart
} from '../../src/lib/server/llm-core.ts';
import analysisOutputSchema from './analysis.output.schema.json' with { type: 'json' };

/** 이벤트 이름 계약. ymath Worker가 발행하고 baton Runner의 execute function이 수신한다. */
export const BATON_TRIGGER_EVENT = 'ymath/item.baton.requested';
/** 완료 이벤트 계약. baton Runner가 발행하고 ymath Worker가 step.waitForEvent 로 대기한다. */
export const BATON_COMPLETION_EVENT = 'ymath/item.baton.completed';
/** 실행 중 인한 재시도가 아닌 순수 배송 dedupe 를 위한 stable 트리거 이벤트 ID 접두어. */
export const BATON_TRIGGER_EVENT_ID_PREFIX = 'ymath-baton';

export const ANALYSIS_RESULT_CONTRACT_VERSION = 1;

export type AnalysisErrorCode =
	| 'REQUEST_INVALID'
	| 'INPUT_MISSING'
	| 'INPUT_INVALID'
	| 'INPUT_TOO_LARGE'
	| 'PROVIDER_FAILED'
	| 'PROVIDER_UNAVAILABLE'
	| 'RATE_LIMITED'
	| 'OUTPUT_SCHEMA_INVALID'
	| 'ARTIFACT_HASH_MISMATCH'
	| 'ARTIFACT_WRITE_FAILED'
	| 'RECEIPT_CONFLICT'
	| 'RESOURCE_QUARANTINED'
	| 'RUNNER_FAILED'
	| 'EXTERNAL_UNKNOWN';

export interface BatonExecuteRequest {
	job_id: string;
	entity_id: string;
	entity_generation: number;
	request_key: string;
	image_key: string;
	ocr_key?: string;
	run_id: string;
	/** 선택: Runner catalog 에 등록된 profile id (예: 'analysis-glm'). 없으면 default 'analysis'. */
	profile_id?: string;
}

export interface BatonManifest {
	contract_version: number;
	job_id: string;
	entity_id: string;
	entity_generation: number;
	workbook_name: string;
	student_name: string | null;
	feedback: { choice: string; comment: string } | null;
	known_patterns: { id: string; count: number; example: string }[];
	taxonomy_md: string;
}

export type BatonTaskResult =
	| {
			status: 'completed';
			result_key: string;
			content_hash: string;
			size_bytes: number;
			model: string;
			prompt_version: string;
			analyzed_at: string;
	  }
	| { status: 'failed'; code: AnalysisErrorCode }
	| { status: 'outcome_unknown'; code: AnalysisErrorCode };

/** ymath Worker 최종화에 필요한 작은 참조만 담는 완료 이벤트 페이로드(본문·이미지 금지). */
export type BatonCompletionPayload =
	| (Extract<BatonTaskResult, { status: 'completed' }> & {
			job_id: string;
			entity_id: string;
			entity_generation: number;
			status: 'completed';
	  })
	| ((Extract<BatonTaskResult, { status: 'failed' | 'outcome_unknown' }> & {
			job_id: string;
			entity_id: string;
			entity_generation: number;
	  }) & { status: 'failed' | 'outcome_unknown' });

const ENTITY_ID = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
const JOB_ID = /^[0-9a-fA-F-]{36}$/;
const RUN_ID = /^[-a-zA-Z0-9_]{1,200}$/;
/** R2 결과 키 계약: items/<entity_id>/ 접두어 안의 상대 키. 경로 탈출·인코딩 트릭 거부. */
const OBJECT_KEY = /^items\/[!-~]+$/;

function safeObjectKey(entityId: string, key: string): boolean {
	if (!key.startsWith(`items/${entityId}/`)) return false;
	if (!OBJECT_KEY.test(key)) return false;
	const rest = key.slice(`items/${entityId}/`.length);
	return rest.length > 0 && !rest.split('/').some((segment) => segment === '.' || segment === '..');
}

export function validateBatonRequest(value: unknown): asserts value is BatonExecuteRequest {
	const req = value as BatonExecuteRequest;
	if (!req || typeof req !== 'object' || Array.isArray(req)) throw new Error('REQUEST_INVALID');
	if (typeof req.job_id !== 'string' || !JOB_ID.test(req.job_id)) throw new Error('REQUEST_INVALID');
	if (typeof req.entity_id !== 'string' || !ENTITY_ID.test(req.entity_id)) throw new Error('REQUEST_INVALID');
	if (!Number.isSafeInteger(req.entity_generation) || req.entity_generation < 1) throw new Error('REQUEST_INVALID');
	if (typeof req.run_id !== 'string' || !RUN_ID.test(req.run_id)) throw new Error('REQUEST_INVALID');
	for (const key of [req.request_key, req.image_key, ...(req.ocr_key ? [req.ocr_key] : [])]) {
		if (typeof key !== 'string' || !safeObjectKey(req.entity_id, key)) throw new Error('REQUEST_INVALID');
	}
	/** profile_id (선택): 소문자-alnum과 하이픈만 허용. 빈 문자열·경로 탈출·대문자 거부. */
	if (req.profile_id !== undefined) {
		if (typeof req.profile_id !== 'string') throw new Error('REQUEST_INVALID');
		if (req.profile_id.length > 64 || !/^[a-z][a-z0-9-]{0,63}$/.test(req.profile_id)) throw new Error('REQUEST_INVALID');
	}
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MODEL_TOKEN = /^[A-Za-z0-9._:/-]{1,160}$/;

export function validateCompletionPayload(value: unknown): asserts value is BatonCompletionPayload {
	const payload = value as BatonCompletionPayload;
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('REQUEST_INVALID');
	if (typeof payload.job_id !== 'string' || !JOB_ID.test(payload.job_id)) throw new Error('REQUEST_INVALID');
	if (typeof payload.entity_id !== 'string' || !ENTITY_ID.test(payload.entity_id)) throw new Error('REQUEST_INVALID');
	if (!Number.isSafeInteger(payload.entity_generation) || payload.entity_generation < 1) throw new Error('REQUEST_INVALID');
	if (payload.status === 'completed') {
		if (!safeObjectKey(payload.entity_id, payload.result_key)) throw new Error('REQUEST_INVALID');
		if (typeof payload.content_hash !== 'string' || !SHA256_HEX.test(payload.content_hash)) throw new Error('REQUEST_INVALID');
		if (!Number.isSafeInteger(payload.size_bytes) || payload.size_bytes < 2 || payload.size_bytes > 2_000_000) throw new Error('REQUEST_INVALID');
		if (typeof payload.model !== 'string' || !MODEL_TOKEN.test(payload.model)) throw new Error('REQUEST_INVALID');
		if (typeof payload.prompt_version !== 'string' || !/^[a-f0-9]{8}$/.test(payload.prompt_version)) throw new Error('REQUEST_INVALID');
		if (typeof payload.analyzed_at !== 'string' || !ISO_INSTANT.test(payload.analyzed_at)) throw new Error('REQUEST_INVALID');
		return;
	}
	if (payload.status === 'failed' || payload.status === 'outcome_unknown') {
		if (typeof payload.code !== 'string' || !/^[A-Z_]{3,40}$/.test(payload.code)) throw new Error('REQUEST_INVALID');
		return;
	}
	throw new Error('REQUEST_INVALID');
}

/** 결과 키 템플릿(output-policy.yaml final artifact 와 같은 계약). */
export function batonResultKey(entityId: string, jobId: string, generation: number): string {
	return `items/${entityId}/baton-result-${jobId}-${generation}.json`;
}

export function batonRequestKey(entityId: string, jobId: string, generation: number): string {
	return `items/${entityId}/baton-request-${jobId}-${generation}.json`;
}

/** 요청 매니페스트의 구조 검증(analysis.input.schema.json 과 같은 계약). */
export function validateBatonManifest(value: unknown): asserts value is BatonManifest {
	const manifest = value as BatonManifest;
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('INPUT_INVALID');
	if (manifest.contract_version !== ANALYSIS_RESULT_CONTRACT_VERSION) throw new Error('INPUT_INVALID');
	if (typeof manifest.job_id !== 'string' || !JOB_ID.test(manifest.job_id)) throw new Error('INPUT_INVALID');
	if (typeof manifest.entity_id !== 'string' || !ENTITY_ID.test(manifest.entity_id)) throw new Error('INPUT_INVALID');
	if (!Number.isSafeInteger(manifest.entity_generation) || manifest.entity_generation < 1) throw new Error('INPUT_INVALID');
	if (typeof manifest.workbook_name !== 'string' || manifest.workbook_name.length > 300) throw new Error('INPUT_INVALID');
	if (manifest.student_name !== null && (typeof manifest.student_name !== 'string' || manifest.student_name.length > 100)) throw new Error('INPUT_INVALID');
	if (manifest.feedback !== null) {
		const feedback = manifest.feedback as BatonManifest['feedback'];
		if (!feedback || typeof feedback !== 'object' || typeof feedback.choice !== 'string' || typeof feedback.comment !== 'string' || feedback.comment.length > 4000) throw new Error('INPUT_INVALID');
	}
	if (!Array.isArray(manifest.known_patterns) || manifest.known_patterns.length > 60) throw new Error('INPUT_INVALID');
	for (const pattern of manifest.known_patterns) {
		if (!pattern || typeof pattern !== 'object' || typeof pattern.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(pattern.id) || !Number.isSafeInteger(pattern.count) || pattern.count < 1 || typeof pattern.example !== 'string') throw new Error('INPUT_INVALID');
	}
	if (typeof manifest.taxonomy_md !== 'string' || !manifest.taxonomy_md.trim() || manifest.taxonomy_md.length > 120_000) throw new Error('INPUT_INVALID');
}

/** 프롬프트 재료: Runner가 읽은 App 자산 원문(instruction·contract) + 매니페스트 데이터. */
export interface AnalysisPromptInput {
	instruction: string;
	contract: string;
	manifest: BatonManifest;
	ocrText: string;
	/** 재시도 때 이전 시도의 문제점(ymath 예산 계약). */
	hint?: string;
}

const FEEDBACK_INSTRUCTION: Record<string, string> = {
	wrong_diagnosis: '- 사용자는 직전 진단이 틀렸다고 반응했습니다. 기존 진단을 답습하지 말고, 사용자 의견이 있으면 그 지적을 중심으로 문제와 학생 풀이를 독립적으로 다시 검토해 진단을 바로잡으세요.',
	too_hard: '- 사용자는 직전 설명이 어렵다고 반응했습니다. 사용자 의견이 있으면 해당 부분을 중심으로, 진단의 정확성을 유지하면서 난이도를 낮추고 학생 눈높이의 구체적인 설명과 질문으로 보강하세요.',
	already_knew: '- 사용자는 직전 설명을 이미 알고 있었다고 반응했습니다. 당연한 설명을 반복하지 말고, 더 깊은 원인과 재발 방지에 초점을 맞추세요.',
	learned: '- 사용자는 직전 분석에서 새롭게 배웠다고 반응했습니다. 유효했던 진단·코칭 방향을 유지하되, 사진과 풀이를 다시 확인해 더 정확하게 다듬으세요.',
	accurate: '- 사용자는 직전 진단이 정확했다고 반응했습니다. 핵심 진단 방향을 유지하되, 사진과 풀이를 다시 확인해 더 정확하게 다듬으세요.'
};

/** 기존 ymath buildPrompt 와 같은 구조. guideline 자리에 App 자산(instruction+contract)이 들어간다. */
export function buildItemAnalysisPrompt(input: AnalysisPromptInput): string {
	const patterns = input.manifest.known_patterns.length
		? input.manifest.known_patterns.map((pattern) => `- ${pattern.id} (${pattern.count}회): ${pattern.example}`).join('\n')
		: '(아직 없음. 새 패턴이면 새 ID를 만드세요)';
	const ocr = input.ocrText.trim() ? input.ocrText : '(OCR 결과 없음. 사진만 보고 분석하세요)';
	const feedback = input.manifest.feedback
		? [
				'---',
				'# 사용자 피드백 (이번 분석에서 반드시 반영)',
				FEEDBACK_INSTRUCTION[input.manifest.feedback.choice] ?? '- 사용자 피드백을 진단 정확성을 유지하면서 반영하세요.',
				...(input.manifest.feedback.comment
					? [
							'- [최우선 반영 요청사항] 사용자가 직접 작성한 피드백 텍스트 — 반드시 분석에 반영하세요:',
							input.manifest.feedback.comment
						]
					: [])
			]
		: [];
	return [
		input.instruction.trim(),
		'---',
		'# 산출물 계약 (구조·표기·검증의 유일한 근원)',
		input.contract.trim(),
		'---',
		'# 분류 체계 (이 안에서만 선택)',
		input.manifest.taxonomy_md,
		'---',
		'# 기존 오류 패턴 ID (같은 실수면 그대로 재사용)',
		patterns,
		'---',
		'# 이번 오답',
		`- 문제집: ${input.manifest.workbook_name}`,
		'- 사진: 이 메시지에 첨부된 이미지입니다. 반드시 직접 보고 분석하세요',
		'',
		'## OCR 텍스트 (참고용, 오류 가능)',
		ocr,
		...feedback,
		...(input.hint ? ['---', '# 직전 시도의 문제점 (이번에는 반드시 고칠 것)', input.hint] : []),
		'---',
		'위 지침과 산출물 계약에 따라 분석하고, 결과는 지정된 JSON 스키마에 맞는 JSON 객체 하나로만 출력하세요.'
	].join('\n');
}

/** 기존 inngest-item.ts 분석 요청과 같은 OpenAI 호환 본문 계약(json_schema strict). */
export function buildAnalysisRequestBody(prompt: string, imageBase64: string): Record<string, unknown> {
	const messages: { role: string; content: string | ChatContentPart[] }[] = [
		{ role: 'system', content: MATH_COACH_SYSTEM },
		imageUserMessage(imageBase64, promptWithSchema(prompt, analysisOutputSchema))
	];
	return {
		messages,
		response_format: { type: 'json_schema', json_schema: { name: 'analysis', strict: true, schema: analysisOutputSchema } },
		max_tokens: 16384,
		temperature: 0.2,
		stream: false
	};
}

// ---------------------------------------------------------------------------
// JSON schema 부분집합 검증기(기계 schema 두 파일을 검증하기에 충분한 최소 구현).
// ajv 같은 외부 의존 없이 Worker/Runner 양쪽에서 동작한다.
// ---------------------------------------------------------------------------

type SchemaNode = {
	type?: string | string[];
	enum?: unknown[];
	required?: string[];
	properties?: Record<string, SchemaNode>;
	additionalProperties?: boolean;
	items?: SchemaNode;
	oneOf?: SchemaNode[];
	pattern?: string;
	minimum?: number;
	maxLength?: number;
	maxItems?: number;
};

function typeMatches(node: SchemaNode, value: unknown): boolean {
	if (!node.type) return true;
	const expected = Array.isArray(node.type) ? node.type : [node.type];
	return expected.some((type) => {
		switch (type) {
			case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
			case 'array': return Array.isArray(value);
			case 'string': return typeof value === 'string';
			case 'boolean': return typeof value === 'boolean';
			case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
			case 'number': return typeof value === 'number';
			case 'null': return value === null;
			default: return false;
		}
	});
}

/** schema 위반 경로 목록. 빈 배열이면 통과다. */
export function schemaErrors(node: SchemaNode, value: unknown, path = '/'): string[] {
	if (node.oneOf) {
		const matches = node.oneOf.filter((branch) => schemaErrors(branch, value, path).length === 0);
		return matches.length === 1 ? [] : [`${path} oneOf 위반(${matches.length}개 분기 일치)`];
	}
	if (!typeMatches(node, value)) return [`${path} 타입 위반`];
	const errors: string[] = [];
	if (node.enum && !node.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) errors.push(`${path} enum 위반`);
	if (typeof value === 'string') {
		if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path} 패턴 위반`);
		if (node.maxLength !== undefined && value.length > node.maxLength) errors.push(`${path} 길이 위반`);
	}
	if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) errors.push(`${path} 최솟값 위반`);
	if (Array.isArray(value)) {
		if (node.maxItems !== undefined && value.length > node.maxItems) errors.push(`${path} 항목 수 위반`);
		if (node.items) value.forEach((entry, index) => errors.push(...schemaErrors(node.items!, entry, `${path}${index}/`)));
	}
	if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		for (const key of node.required ?? []) if (!(key in record)) errors.push(`${path}${key} 필수 누락`);
		if (node.additionalProperties === false) {
			for (const key of Object.keys(record)) if (!node.properties?.[key]) errors.push(`${path}${key} 추가 속성 금지`);
		}
		for (const [key, child] of Object.entries(node.properties ?? {})) {
			if (key in record) errors.push(...schemaErrors(child, record[key], `${path}${key}/`));
		}
	}
	return errors;
}

/** 모델 분석 출력의 구조 검증(기계 schema). guardrail 최종 검사는 ymath 커밋 경로가 소유한다. */
export function validateAnalysisStructure(value: unknown): void {
	const errors = schemaErrors(analysisOutputSchema as unknown as SchemaNode, value);
	if (errors.length) throw new Error(`OUTPUT_SCHEMA_INVALID: ${errors.slice(0, 5).join('; ')}`);
}
