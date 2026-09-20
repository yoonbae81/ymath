/** 분석에 쓸 수 있는 LLM */
export const PROVIDERS = ['claude', 'codex', 'agy'] as const;
export type Provider = (typeof PROVIDERS)[number];
export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', codex: 'Codex', agy: 'Agy (Gemini)' };

export type Status = 'queued' | 'ocr' | 'analyzing' | 'done' | 'failed';

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
	/** 재분석 때 지정한 LLM. 없으면 서버 기본값(ANALYZE_PROVIDER)을 쓴다 */
	requested_provider?: Provider;
	meta: { provider?: Provider; model: string; prompt_version: string; analyzed_at: string } | null;
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
	_items: { created_at: string }[] = [],
	now = new Date()
): { value: string; label: string; isPast: boolean }[] {
	const curYearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
	return [
		{ value: '', label: '전체 기간', isPast: false },
		{ value: 'today', label: '당일', isPast: false },
		{ value: '10d', label: '최근 10일', isPast: false },
		{ value: 'month', label: curYearMonth, isPast: false }
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

