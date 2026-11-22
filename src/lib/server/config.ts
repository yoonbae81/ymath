import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Provider, type Workbook } from '$lib/types';

const root = () => process.cwd();

/** 경로는 호출 시점마다 읽는다. 테스트에서 환경변수를 바꿔도 반영되도록. */
/** 사용자가 직접 고치거나(config, prompts) 쌓이는(data) 것은 모두 user/ 아래에 둔다 */
export const userDir = () => resolve(process.env.USER_DIR ?? join(root(), 'user'));
export const dataDir = () => resolve(process.env.DATA_DIR ?? join(userDir(), 'data'));
export const promptsDir = () => resolve(process.env.PROMPTS_DIR ?? join(userDir(), 'prompts'));
export const configDir = () => resolve(process.env.CONFIG_DIR ?? join(userDir(), 'config'));

/** user/config/providers.json의 zai(GLM)·agy(Antigravity CLI) 항목을 읽는다. 레거시 설정과 환경변수는 지원하지 않는다. */
export interface LlmProviderConfig {
	bin?: string;
	baseUrl?: string;
	apiKey?: string;
	models?: { id: string; name?: string }[];
}

const providersFile = () => join(configDir(), 'providers.json');

/**
 * z.ai(OpenAI 호환) GLM 실행 기본 모델. 사진을 base64 data URL 로 첨부하므로
 * 이미지 입력이 되는 모델이어야 한다(glm-5.3 텍스트 전용은 사진 블록을 400 으로 거부 — 실호 확인).
 * 실측 검증: 코딩 엔드포인트에서 glm-5.3-flash 텍스트·json_object·json_schema(strict) OK, glm-4.6v 이미지 data URL OK.
 */
export const DEFAULT_GLM_MODEL = 'glm-5.3-flash';
/** OCR 기본 모델. 이미지 data URL 입력이 되는 GLM 비전 모델(PaddleOCR-VL 전처리를 대체한다). */
export const DEFAULT_OCR_MODEL = 'glm-4.6v';

/**
 * Agy(Antigravity) CLI 기본 실행 파일 — s3 박스 설치 경로. 분석 모델 디폴트는
 * Gemini 3.8 Flash(2026-11-22 사용자 지정). 모델 ID는 effort 변형(high/medium/low)만 존재한다.
 */
export const DEFAULT_AGY_BIN = '~/.local/bin/agy';
export const DEFAULT_AGY_MODEL = 'gemini-3.8-flash-medium';

/** 설정 파일의 providers 맵. 파일이 없으면 빈 객체, 있지만 깨졌으면 명확히 실패한다 */
export function readLlmProviders(): Record<string, LlmProviderConfig> {
	try {
		const parsed = JSON.parse(readFileSync(providersFile(), 'utf8')) as { providers?: Record<string, LlmProviderConfig> };
		const out: Record<string, LlmProviderConfig> = {};
		if (parsed.providers?.zai) out.zai = parsed.providers.zai;
		if (parsed.providers?.agy) out.agy = parsed.providers.agy;
		return out;
	} catch (e) {
		if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return {};
		throw new Error(`user/config/providers.json 을 읽을 수 없음: ${e instanceof Error ? e.message : String(e)}`);
	}
}

/** 설정의 ~/ 경로를 실제 홈으로 펼친다 */
const expandHome = (p: string) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

export const settings = () => {
	const providers = readLlmProviders();
	const zai = providers.zai;
	const agy = providers.agy;
	return {
		/**
		 * 실행 provider 디폴트. providers.json 에 agy 항목이 있으면 Gemini(Agy CLI),
		 * 없으면 GLM(z.ai). 재분석 시 사용자가 다른 provider를 고르면 그쪽을 쓴다.
		 */
		provider: (agy ? 'agy' : 'glm') as Provider,
		/** z.ai 코딩 엔드포인트(OpenAI 호환). 주소·키는 user/config/providers.json 의 zai 만 본다 — 환경변수 우회는 없다 */
		zaiBaseUrl: zai?.baseUrl,
		zaiApiKey: zai?.apiKey,
		/** 모델. providers.json 의 zai models[0].id 가 없으면 기본값 glm-5.3-flash */
		zaiModel: zai?.models?.[0]?.id ?? DEFAULT_GLM_MODEL,
		/** Agy CLI 실행 파일과 모델. providers.json 의 agy 항목으로 바꿀 수 있다 */
		agyBin: expandHome(agy?.bin?.trim() || DEFAULT_AGY_BIN),
		agyModel: agy?.models?.[0]?.id?.trim() || DEFAULT_AGY_MODEL,
	// OCR 주소·키는 별도 설정 없이 providers.json 의 zai 를 함께 쓰고, 모델만 환경변수로 바꿀 수 있다
	ocrModel: process.env.OCR_MODEL?.trim() || DEFAULT_OCR_MODEL,
	// 15 분. 원격 API 라도 긴 추론(구조화 분석 전체)을 감안해 넉넉히 둔다
	analyzeTimeoutMs: Number(process.env.ANALYZE_TIMEOUT_MS ?? 15 * 60_000),
	ocrTimeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 2 * 60_000),
		maxAttempts: Number(process.env.ANALYZE_MAX_ATTEMPTS ?? 2),
		studentName: (process.env.STUDENT_NAME ?? '').trim()
	};
};

/** 프롬프트 템플릿의 학생 이름 치환. STUDENT_NAME 환경변수가 있으면 친근하게 반영하고, 없으면 자연스러운 기본형으로 처리 */
export function renderPrompt(template: string, name = process.env.STUDENT_NAME?.trim()): string {
	if (name) {
		return template
			.replaceAll('{{STUDENT_NAME}}', name)
			.replaceAll('{{STUDENT_PAREN}}', `(${name})`)
			.replaceAll('{{STUDENT_POSSESSIVE}}', `${name}의 `)
			.replaceAll('{{STUDENT_TOPIC}}', `${name}가 `);
	}
	return template
		.replaceAll('{{STUDENT_NAME}}', '학생')
		.replaceAll('{{STUDENT_PAREN}}', '')
		.replaceAll('{{STUDENT_POSSESSIVE}}', '')
		.replaceAll('{{STUDENT_TOPIC}}', '');
}

/** '중2' → 2, '고1' → 11. 중학교가 고등학교보다 앞. 해석 못 하면 맨 뒤 */
export function gradeRank(grade: string): number {
	const m = grade.match(/^(초|중|고)\s*(\d)$/);
	if (!m) return Number.MAX_SAFE_INTEGER;
	return { 초: 0, 중: 10, 고: 20 }[m[1] as '초' | '중' | '고'] + Number(m[2]);
}

/** 학년(중→고) → publisherOrder 순서 → 학기 → 이름. 출판사가 목록에 없으면 그 학년의 맨 뒤. */
export function sortWorkbooks(list: Workbook[], publisherOrder: string[]): Workbook[] {
	const pub = (w: Workbook) => {
		const i = publisherOrder.indexOf(w.publisher);
		return i === -1 ? publisherOrder.length : i;
	};
	return [...list].sort(
		(a, b) =>
			gradeRank(a.grade) - gradeRank(b.grade) ||
			pub(a) - pub(b) ||
			a.semester - b.semester ||
			a.name.localeCompare(b.name, 'ko')
	);
}

export function loadWorkbooks(): Workbook[] {
	const file = JSON.parse(readFileSync(join(configDir(), 'workbooks.json'), 'utf8')) as {
		publisherOrder?: string[];
		workbooks: Workbook[];
	};
	const seen = new Set<string>();
	for (const w of file.workbooks) {
		if (!w.id || !w.name || !w.publisher) throw new Error('workbooks.json: id, name, publisher는 필수입니다');
		if (seen.has(w.id)) throw new Error(`workbooks.json: id 중복 ${w.id}`);
		seen.add(w.id);
	}
	return sortWorkbooks(file.workbooks, file.publisherOrder ?? []);
}
