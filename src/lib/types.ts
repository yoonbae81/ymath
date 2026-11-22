/** 분석에 쓸 수 있는 LLM — Agy(Antigravity CLI, Gemini)와 GLM(z.ai). 첫 항목이 기본 선택이다. */
export const PROVIDERS = ['agy', 'glm'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABEL: Record<Provider, string> = { agy: 'Gemini 3.8 (Agy)', glm: 'GLM' };
/** 재분석 폼의 라디오 버튼에 보여주는 짧은 라벨 */
export const PROVIDER_SHORT: Record<Provider, string> = { agy: 'Gemini', glm: 'GLM' };

/** 분석 UI 에서 재분석 버튼 옆에 보여주는 프로바이더 옵션 — baton 카탈로그와는 무관하다(baton-catalog.ts 참고) */
export const AVAILABLE_PROVIDERS: readonly { id: Provider; label: string; short: string }[] =
	PROVIDERS.map((id) => ({ id, label: PROVIDER_LABEL[id], short: PROVIDER_SHORT[id] }));

/** 삭제된 LLM. 옛 기록의 requested_provider·meta.provider 값이 여기 남는다 */
const LEGACY_PROVIDER_LABEL: Record<string, string> = {
	claude: 'Claude',
	zai: 'GLM 5.3 (Z.AI)',
	codex: 'Codex',
	omlx: 'Qwen (oMLX)'
};

/** 기록에 남은 provider 값을 화면 표시용 라벨로. 목록에서 빠진 옛 값도 깨지지 않게 그 값 자체로 보여 준다 */
export const providerLabel = (provider: string | null | undefined): string =>
	provider ? ((PROVIDER_LABEL as Record<string, string>)[provider] ?? LEGACY_PROVIDER_LABEL[provider] ?? provider) : '';

export type Status = 'queued' | 'ocr' | 'analyzing' | 'done' | 'failed';
export type Session = { role: 'family'; via: 'anonymous'; exp: null };

export const ACTIVE_STATUSES: Status[] = ['queued', 'ocr', 'analyzing'];

export interface Workbook {
	id: string;
	name: string;
	publisher: string;
	grade: string;
	semester: number;
}

export const ERROR_TYPES = [
	'숨은 전제·특수 조건 누락',
	'개념의 본질적 해석 오류',
	'전략·모델링 실패',
	'연산·기호 착오',
	'판정 불가'
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const QUESTION_TYPES = ['계산', '증명·서술', '도형', '그래프', '문장제', '개념 이해', '기타'] as const;

export interface Analysis {
	problem: { number_guess: string; text_md: string; figure_description: string };
	classification: {
		topic: string;
		topic_rationale: string;
		secondary_topics: string[];
		unit_major: string;
		unit_minor: string;
		concept_ids: string[];
		question_type: string;
		difficulty: number;
		/** 서버가 curriculum.md에서 채운다(LLM 출력 아님) */
		course?: string;
	};
	asks: string;
	student_work: { visible: boolean; transcription_md: string; student_answer: string };
	error_analysis: {
		error_type: ErrorType;
		error_step: string;
		explanation: string;
		root_cause_concept_ids: string[];
		prerequisites: string[];
		misconception: string;
		error_pattern_id: string;
		trigger: string;
		self_check: string;
		/** 사고 전환 넛지 2개. 정답·풀이 없이 질문만 담는다 */
		nudges: { condition_question: string; strategy_question: string };
		severity: 1 | 2 | 3;
	};
	flags: { multiple_problems: boolean; unreadable: boolean };
	/** 정답을 저장하지 않고 참/거짓만 남긴다 */
	verification: { independently_solved: boolean; student_error_confirmed: boolean };
	confidence: 'high' | 'medium' | 'low';
}

/** 서버가 판단해 붙이는 경고. LLM 출력과 분리해 둔다. */
export interface RecordFlags {
	ocr_missing: boolean;
	taxonomy_mismatch: string[];
	/** 넛지·진단에 정답이 섞였을 가능성(등식, "정답은" 등). 비어 있으면 통과 */
	guardrail: string[];
}

/** 재분석 요청 때 분석 프롬프트에 덧붙이는 사용자 코멘트 최대 길이 */
export const REQUEST_NOTE_MAX = 500;

export interface ItemRecord {
	schema_version: 1;
	id: string;
	created_at: string;
	status: Status;
	error: string | null;
	attempts: number;
	workbook: Workbook;
	image: string;
	flags: RecordFlags;
	analysis: Analysis | null;
	/** 과거 재분석 요청 provider도 읽기 위해 문자열로 보존. 새 실행은 GLM만 사용 */
	requested_provider?: string;
	meta: { provider?: string; model: string; prompt_version: string; analyzed_at: string } | null;
	/** 재분석 요청 때 사용자가 덧붙인 코멘트. 다음 분석 프롬프트에 데이터로 들어가고, 새 요청 때 덮어쓴다 */
	request_note?: string;
	/** 오답분석 화면을 마지막으로 연 시각. 가족이 상세를 열 때마다 덮어쓴다. 없으면 아직 확인하지 않은 것 */
	viewed_at?: string | null;
	/** 나중에 다시 볼 오답 표시. 목록에서 별로 보이고 즐겨찾기만 골라 볼 수 있다. 재분석해도 유지한다 */
	favorite?: boolean;
}

/** 항목 폴더의 analysis-<provider>.json 에 프로바이더별로 남기는 분석 한 건. record.json 은 마지막 분석만 가진다 */
export interface SavedAnalysis {
	analysis: Analysis;
	meta: { provider?: string; model: string; prompt_version: string; analyzed_at: string };
	flags: RecordFlags;
}

export type ReportStatus = 'queued' | 'generating' | 'done' | 'failed';
export const ACTIVE_REPORT_STATUSES: ReportStatus[] = ['queued', 'generating'];

export const REPORT_STATUS_LABEL: Record<ReportStatus, string> = {
	queued: '대기 중',
	generating: '작성 중',
	done: '작성 완료',
	failed: '작성 실패'
};

export const REPORT_STATUS_TONE: Record<ReportStatus, 'line' | 'accent' | 'ok' | 'bad'> = {
	queued: 'line',
	generating: 'accent',
	done: 'ok',
	failed: 'bad'
};

export function isPastMonthPeriod(period: string, now = new Date()): boolean {
	const m = period.match(/^(\d{4})-(\d{2})$/);
	if (!m) return false;
	const curYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	return period < curYearMonth;
}

export function formatPeriodLabel(period: string, now = new Date()): string {
	if (!period || period === 'all') return '전체 기간';
	if (period === 'today' || period === 'day') return '당일';
	if (period === '10d' || period === 'week') return '최근 10일';
	const curYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	if (period === 'month' || period === curYearMonth) return curYearMonth;
	return period;
}

export function getPeriodRange(period: string, now = new Date()): { start: number | null; end: number | null } {
	if (!period || period === 'all') return { start: null, end: null };

	if (period === 'today' || period === 'day') {
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
		return { start, end: null };
	}

	if (period === '10d' || period === 'week') {
		const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 10).getTime();
		return { start, end: null };
	}

	if (period === 'month') {
		const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
		return { start, end: null };
	}

	const m = period.match(/^(\d{4})-(\d{2})$/);
	if (m) {
		const year = Number(m[1]);
		const month = Number(m[2]);
		const start = new Date(year, month - 1, 1, 0, 0, 0, 0).getTime();
		const end = new Date(year, month, 0, 23, 59, 59, 999).getTime();
		return { start, end };
	}

	return { start: null, end: null };
}

export function isItemInPeriod(createdAtIso: string, period: string, now = new Date()): boolean {
	const { start, end } = getPeriodRange(period, now);
	if (start === null && end === null) return true;
	const created = new Date(createdAtIso).getTime();
	if (Number.isNaN(created)) return true;
	if (start !== null && created < start) return false;
	if (end !== null && created > end) return false;
	return true;
}

export function getAvailablePeriods(
	items: { created_at: string }[] = [],
	now = new Date()
): { value: string; label: string; isPast: boolean }[] {
	const curYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	const pastMonths = new Set<string>();
	for (const item of items) {
		const created = new Date(item.created_at);
		if (Number.isNaN(created.getTime())) continue;
		const yearMonth = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}`;
		if (yearMonth < curYearMonth) pastMonths.add(yearMonth);
	}

	return [
		{ value: '', label: '전체 기간', isPast: false },
		{ value: 'today', label: '당일', isPast: false },
		{ value: '10d', label: '최근 10일', isPast: false },
		{ value: 'month', label: curYearMonth, isPast: false },
		...[...pastMonths]
			.sort((a, b) => b.localeCompare(a))
			.map((yearMonth) => ({ value: yearMonth, label: yearMonth, isPast: true }))
	];
}

export interface ReportSummary {
	total_items: number;
	unit_distribution: Record<string, number>;
	error_type_distribution: Record<string, number>;
	severity_distribution: Record<number, number>;
	pattern_counts: { pattern_id: string; count: number; sample_ids: string[] }[];
	root_cause_concepts: { id: string; desc: string; count: number }[];
	recurrent_patterns: {
		pattern_id: string;
		current_count: number;
		prior_count: number;
		trend: '신규' | '증가' | '감소' | '유지';
	}[];
}

export interface ReportRecord {
	schema_version: 1;
	id: string;
	created_at: string;
	topic: string;
	period: string;
	period_label: string;
	status: ReportStatus;
	error: string | null;
	attempts: number;
	item_ids: string[];
	items_fingerprint: string;
	summary: ReportSummary | null;
	markdown: string | null;
	meta: {
		model: string;
		prompt_version: string;
		generated_at: string;
		/** LLM 이 잘못 쓴 문제집 이름을 코드가 바로잡은 횟수 */
		workbook_corrections?: number;
		/** 교정 후에도 남은, 이 보고서와 무관한 문제집 표기(사람이 확인) */
		stray_workbooks?: string[];
	} | null;
}
