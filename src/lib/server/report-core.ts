import { problemLabel } from '$lib/report-links';
import type { ItemRecord, ReportSummary } from '$lib/types';

const UNCONFIRMED_PATTERN_ID = 'unconfirmed';

export function calculateReportSummary(
	targetRecords: ItemRecord[],
	priorRecords: ItemRecord[],
	conceptsMap: Record<string, string>
): ReportSummary {
	const total_items = targetRecords.length;
	const unit_distribution: Record<string, number> = {};
	const error_type_distribution: Record<string, number> = {};
	const severity_distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
	const patternMap = new Map<string, string[]>();
	const conceptCounts: Record<string, number> = {};

	for (const r of targetRecords) {
		const a = r.analysis;
		if (!a) continue;

		const unit = a.classification.unit_major || '기타';
		unit_distribution[unit] = (unit_distribution[unit] ?? 0) + 1;

		const et = a.error_analysis.error_type || '판정 불가';
		error_type_distribution[et] = (error_type_distribution[et] ?? 0) + 1;

		const sev = a.error_analysis.severity || 1;
		severity_distribution[sev] = (severity_distribution[sev] ?? 0) + 1;

		const pat = a.error_analysis.error_pattern_id || 'unknown-pattern';
		if (pat !== UNCONFIRMED_PATTERN_ID) {
			const list = patternMap.get(pat) ?? [];
			list.push(r.id);
			patternMap.set(pat, list);
		}

		for (const cid of a.error_analysis.root_cause_concept_ids || []) {
			conceptCounts[cid] = (conceptCounts[cid] ?? 0) + 1;
		}
	}

	const pattern_counts = [...patternMap.entries()]
		.map(([pattern_id, sample_ids]) => ({
			pattern_id,
			count: sample_ids.length,
			sample_ids
		}))
		.sort((a, b) => b.count - a.count);

	const root_cause_concepts = Object.entries(conceptCounts)
		.map(([id, count]) => ({
			id,
			desc: conceptsMap[id] || id,
			count
		}))
		.sort((a, b) => b.count - a.count);

	const priorPatternCounts = new Map<string, number>();
	for (const r of priorRecords) {
		const pat = r.analysis?.error_analysis.error_pattern_id;
		if (pat) {
			priorPatternCounts.set(pat, (priorPatternCounts.get(pat) ?? 0) + 1);
		}
	}

	const recurrent_patterns = pattern_counts.map(({ pattern_id, count: current_count }) => {
		const prior_count = priorPatternCounts.get(pattern_id) ?? 0;
		let trend: '신규' | '증가' | '감소' | '유지' = '신규';
		if (prior_count === 0) {
			trend = '신규';
		} else if (current_count > prior_count) {
			trend = '증가';
		} else if (current_count < prior_count) {
			trend = '감소';
		} else {
			trend = '유지';
		}
		return { pattern_id, current_count, prior_count, trend };
	});

	return {
		total_items,
		unit_distribution,
		error_type_distribution,
		severity_distribution,
		pattern_counts,
		root_cause_concepts,
		recurrent_patterns
	};
}

export function buildReportPrompt(params: {
	guideline: string;
	topic: string;
	periodLabel: string;
	summary: ReportSummary;
	items: ItemRecord[];
}): string {
	const itemsPayload = params.items.map((item) => {
		const a = item.analysis!;
		// classification.course(단원의 학기 표시, 예: '중3-1')는 넘기지 않는다. 문제집(workbook)과 학기가 다를 수 있어서
		// 보고서에서 "쎈 중3-1"처럼 출판사에 붙여 문제집 이름을 잘못 만들어 냈다.
		const { course: _course, ...classification } = a.classification;
		return {
			id: item.id,
			// 보고서에서 이 문제를 가리킬 표기. 화면에서 이 표기가 해당 오답으로 연결된다
			label: problemLabel(item),
			workbook: item.workbook.name,
			created_at: item.created_at,
			problem: a.problem,
			classification,
			asks: a.asks,
			student_work: a.student_work,
			error_analysis: a.error_analysis,
			verification: a.verification
		};
	});

	return [
		params.guideline.trim(),
		'---',
		'# 대상 영역 및 기간',
		`- 대상 영역: ${params.topic}`,
		`- 대상 기간: ${params.periodLabel} (총 ${params.summary.total_items}건)`,
		'---',
		'# 코드 사전 집계 데이터 (수치는 이 집계를 그대로 인용하고 직접 다시 세지 마세요)',
		'```json',
		JSON.stringify(params.summary, null, 2),
		'```',
		'---',
		'# 해당 영역·기간의 개별 오답 분석 JSON 목록 (오답 사진/OCR을 다시 거치지 않고 이 JSON 데이터만으로 작성합니다)',
		'```json',
		JSON.stringify(itemsPayload, null, 2),
		'```',
		'---',
		'문제를 가리킬 때는 각 항목의 `label`을 글자 그대로 쓰세요(예: `0255 · 쎈 중3-2`). 문제집 이름을 바꾸거나 학기·출판사를 다시 조합하지 마세요. 화면에서 이 표기가 해당 오답으로 연결됩니다. 단, 진단표의 첫 열(문제)만은 `쎈 중3-2<br/>0255`처럼 문제집과 문제 번호를 `<br/>`로 나눠 두 줄로 쓰세요.',
		'위 지침에 따라 영역별 개선방향 보고서를 Markdown 형식으로 작성하세요. 수식은 LaTeX($...$)를 사용하세요.'
	].join('\n');
}

