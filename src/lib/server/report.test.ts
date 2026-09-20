import { describe, expect, it } from 'vitest';
import type { ItemRecord, Analysis, ReportRecord } from '$lib/types';
import {
	isItemInPeriod,
	isPastMonthPeriod,
	getAvailablePeriods,
	formatPeriodLabel
} from '$lib/types';
import {
	calculateReportSummary,
	buildReportPrompt,
	computeItemsFingerprint,
	findMatchingReport,
	saveReport,
	listReports,
	deleteReport,
	ReportQueue
} from './report';

function makeMockRecord(id: string, dateIso: string, topic = '대수', pattern = 'sign-error'): ItemRecord {
	const analysis: Analysis = {
		problem: { number_guess: '1', text_md: 'x + 1 = 2', figure_description: '' },
		classification: {
			topic,
			topic_rationale: '단순 방정식',
			secondary_topics: [],
			unit_major: '일차방정식',
			unit_minor: '일차방정식의 풀이',
			concept_ids: ['alg-lin-01'],
			question_type: '계산',
			difficulty: 2
		},
		asks: 'x의 값을 구하시오',
		student_work: { visible: true, transcription_md: 'x = 3', student_answer: '3' },
		error_analysis: {
			error_type: '연산·기호 착오',
			error_step: '이항할 때 부호를 바꾸지 않음',
			explanation: '우변으로 이항하면서 부호 반전 누락',
			root_cause_concept_ids: ['alg-lin-01'],
			prerequisites: ['정수의 덧셈과 뺄셈'],
			misconception: '항을 옮겨도 부호는 그대로라고 생각함',
			error_pattern_id: pattern,
			trigger: '상수항을 우변으로 이항할 때',
			self_check: '등식의 양변에서 같은 수를 뺐는지 확인했나요?',
			severity: 1,
			nudges: {
				condition_question: '좌변의 +1을 없애려면 양변에 어떤 연산을 해야 하나요?',
				strategy_question: '등식의 기본 성질을 떠올려 보면 어떻게 달라질까요?'
			}
		},
		flags: { multiple_problems: false, unreadable: false },
		verification: { independently_solved: true, student_error_confirmed: true },
		confidence: 'high'
	};

	return {
		schema_version: 1,
		id,
		created_at: dateIso,
		status: 'done',
		error: null,
		attempts: 1,
		workbook: { id: 'wb-1', name: '쎈 수학', grade: '중1', semester: 1, publisher: '신사고' },
		image: 'image.png',
		flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] },
		analysis,
		meta: { model: 'sonnet', prompt_version: 'abc', analyzed_at: dateIso }
	};
}

describe('report generator & queue', () => {
	it('calculates summary correctly from JSON records', () => {
		const r1 = makeMockRecord('1', '2026-09-19T10:00:00Z', '대수', 'sign-error');
		const r2 = makeMockRecord('2', '2026-09-18T10:00:00Z', '대수', 'sign-error');
		const r3 = makeMockRecord('3', '2026-09-17T10:00:00Z', '대수', 'boundary-missed');
		r3.analysis!.classification.unit_major = '부등식';
		r3.analysis!.error_analysis.severity = 2;
		r3.analysis!.error_analysis.error_type = '숨은 전제·특수 조건 누락';

		const prior = [makeMockRecord('0', '2026-08-01T10:00:00Z', '대수', 'sign-error')];
		const conceptsMap = { 'alg-lin-01': '일차방정식' };

		const summary = calculateReportSummary([r1, r2, r3], prior, conceptsMap);

		expect(summary.total_items).toBe(3);
		expect(summary.unit_distribution).toEqual({ 일차방정식: 2, 부등식: 1 });
		expect(summary.error_type_distribution).toEqual({
			'연산·기호 착오': 2,
			'숨은 전제·특수 조건 누락': 1
		});
		expect(summary.severity_distribution).toEqual({ 1: 2, 2: 1, 3: 0 });

		expect(summary.pattern_counts).toEqual([
			{ pattern_id: 'sign-error', count: 2, sample_ids: ['1', '2'] },
			{ pattern_id: 'boundary-missed', count: 1, sample_ids: ['3'] }
		]);

		expect(summary.recurrent_patterns).toEqual([
			{ pattern_id: 'sign-error', current_count: 2, prior_count: 1, trend: '증가' },
			{ pattern_id: 'boundary-missed', current_count: 1, prior_count: 0, trend: '신규' }
		]);
	});

	it('checks period boundaries: today, 10d, month, and past month YYYY-MM', () => {
		const now = new Date('2026-09-19T15:00:00+09:00');

		// 오늘
		expect(isItemInPeriod('2026-09-19T01:00:00+09:00', 'today', now)).toBe(true);
		expect(isItemInPeriod('2026-09-18T23:59:59+09:00', 'today', now)).toBe(false);

		// 최근 10일
		expect(isItemInPeriod('2026-09-09T00:00:00+09:00', '10d', now)).toBe(true);
		expect(isItemInPeriod('2026-09-08T23:59:59+09:00', '10d', now)).toBe(false);

		// 현재 월 (2026-09)
		expect(isItemInPeriod('2026-09-01T00:00:00+09:00', 'month', now)).toBe(true);
		expect(isItemInPeriod('2026-08-31T23:59:59+09:00', 'month', now)).toBe(false);

		// 과거 월 2026-08
		expect(isItemInPeriod('2026-08-15T10:00:00+09:00', '2026-08', now)).toBe(true);
		expect(isItemInPeriod('2026-09-01T00:00:00+09:00', '2026-08', now)).toBe(false);
		expect(isItemInPeriod('2026-07-31T23:59:59+09:00', '2026-08', now)).toBe(false);
		expect(isPastMonthPeriod('2026-08', now)).toBe(true);
		expect(isPastMonthPeriod('2026-09', now)).toBe(false);
	});

	it('provides available periods up to current month', () => {
		const now = new Date('2026-09-19T15:00:00+09:00');
		const items = [
			{ created_at: '2026-09-10T10:00:00Z' },
			{ created_at: '2026-08-20T10:00:00Z' },
			{ created_at: '2026-07-05T10:00:00Z' }
		];

		const periods = getAvailablePeriods(items, now);
		expect(periods.map((p) => p.value)).toEqual(['', 'today', '10d', 'month']);
		expect(periods.map((p) => p.label)).toEqual(['전체 기간', '당일', '최근 10일', '2026-09']);
	});

	it('fingerprints items and detects JSON additions or deletions', () => {
		const r1 = makeMockRecord('1', '2026-09-19T10:00:00Z', '대수');
		const r2 = makeMockRecord('2', '2026-09-19T11:00:00Z', '대수');

		const fp1 = computeItemsFingerprint([r1]);
		const fp2 = computeItemsFingerprint([r1, r2]);
		const fp3 = computeItemsFingerprint([r2, r1]);

		expect(fp1).not.toBe(fp2);
		expect(fp2).toBe(fp3); // 순서와 무관하게 동일한 결과
	});

	it('builds prompt containing only JSON data without image references', () => {
		const r1 = makeMockRecord('1', '2026-09-19T10:00:00Z', '대수');
		const summary = calculateReportSummary([r1], [], {});

		const prompt = buildReportPrompt({
			guideline: '보고서 작성 지침',
			topic: '대수',
			periodLabel: '최근 10일',
			summary,
			items: [r1]
		});

		expect(prompt).toContain('보고서 작성 지침');
		expect(prompt).toContain('대수');
		expect(prompt).toContain('최근 10일');
		expect(prompt).toContain('"total_items": 1');
		expect(prompt).toContain('sign-error');
		expect(prompt).toContain('x + 1 = 2');
		expect(prompt).not.toContain('image.png');
		expect(prompt).not.toContain('work.jpg');
	});
});
