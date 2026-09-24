import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROVIDERS, type Provider, type Workbook } from '$lib/types';

const root = () => process.cwd();

/** 경로는 호출 시점마다 읽는다. 테스트에서 환경변수를 바꿔도 반영되도록. */
/** 사용자가 직접 고치거나(config, prompts) 쌓이는(data) 것은 모두 user/ 아래에 둔다 */
export const userDir = () => resolve(process.env.USER_DIR ?? join(root(), 'user'));
export const dataDir = () => resolve(process.env.DATA_DIR ?? join(userDir(), 'data'));
export const promptsDir = () => resolve(process.env.PROMPTS_DIR ?? join(userDir(), 'prompts'));
export const configDir = () => resolve(process.env.CONFIG_DIR ?? join(userDir(), 'config'));

export const settings = () => ({
	/** 분석에 쓰는 LLM 기본값. 재분석 때 항목별로 바꿀 수 있다 */
	provider: (PROVIDERS as readonly string[]).includes(process.env.ANALYZE_PROVIDER ?? '')
		? (process.env.ANALYZE_PROVIDER as Provider)
		: ('zai' as Provider),
	zaiApiKey: process.env.ZAI_API_KEY ?? '48383d54493740bfb16a6a87b4547240.j4vooPFkXEVEkYtl',
	zaiBaseUrl: process.env.ZAI_BASE_URL ?? 'https://api.z.ai/api/coding/paas/v4',
	zaiModel: process.env.ANALYZE_MODEL ?? process.env.ZAI_MODEL ?? 'glm-5.3',
	claudeBin: process.env.CLAUDE_BIN ?? 'claude',
	claudeModel: process.env.ANALYZE_MODEL ?? 'sonnet',
	codexBin: process.env.CODEX_BIN ?? 'codex',
	// codex 설정 파일의 기본 모델은 계정에 따라 지원되지 않을 수 있고 이미지 입력도 필요하므로 명시한다
	codexModel: process.env.CODEX_MODEL ?? 'gpt-5.5',
	agyBin: process.env.AGY_BIN ?? 'agy',
	// 사진을 읽어야 하므로 이미지 입력이 되는 모델. `agy models` 로 목록을 볼 수 있다
	agyModel: process.env.AGY_MODEL ?? 'gemini-3.1-pro-high',
	ocrBin: process.env.OCR_BIN ?? 'ocr',
	analyzeTimeoutMs: Number(process.env.ANALYZE_TIMEOUT_MS ?? 5 * 60_000),
	ocrTimeoutMs: Number(process.env.OCR_TIMEOUT_MS ?? 2 * 60_000),
	maxAttempts: Number(process.env.ANALYZE_MAX_ATTEMPTS ?? 2),
	studentName: (process.env.STUDENT_NAME ?? '').trim()
});

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
