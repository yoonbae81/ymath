import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { formatProblemCells, normalizeWorkbookMentions, problemLabel, problemRefsFrom, stripLeadingTitle } from '$lib/report-links';
import type { ItemRecord, ReportRecord, ReportSummary } from '$lib/types';
import {
	ACTIVE_REPORT_STATUSES,
	formatPeriodLabel,
	getPeriodRange,
	isItemInPeriod,
	isPastMonthPeriod
} from '$lib/types';
import { dataDir, loadWorkbooks, promptsDir, renderPrompt, settings } from './config';
import { runText } from './llm';
import { listRecords, UNCONFIRMED_PATTERN_ID } from './store';
import { loadTaxonomy } from './taxonomy';

const REPORT_ID_RE = /^\d{8}-\d{6}-rep-[a-z0-9]{4}$/;
export const isValidReportId = (id: string) => REPORT_ID_RE.test(id);

export function newReportId(now = new Date()): string {
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
	const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
	return `${date}-${time}-rep-${rand}`;
}

const reportsDir = () => join(dataDir(), 'reports');

function writeJsonAtomic(path: string, value: unknown) {
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
	renameSync(tmp, path);
}

export function saveReport(report: ReportRecord): void {
	mkdirSync(reportsDir(), { recursive: true });
	const path = join(reportsDir(), `${report.id}.json`);
	writeJsonAtomic(path, report);
}

export function listReports(): ReportRecord[] {
	const dir = reportsDir();
	if (!existsSync(dir)) return [];
	const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'));
	const reports: ReportRecord[] = [];
	for (const f of files) {
		try {
			const text = readFileSync(join(dir, f), 'utf8');
			const parsed = JSON.parse(text) as ReportRecord;
			reports.push(parsed);
		} catch {
			/* 손상된 파일 무시 */
		}
	}
	reports.sort((a, b) => b.created_at.localeCompare(a.created_at));
	return reports;
}

export function readReport(id: string): ReportRecord | null {
	if (!isValidReportId(id)) return null;
	const path = join(reportsDir(), `${id}.json`);
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as ReportRecord;
	} catch {
		return null;
	}
}

export function deleteReport(id: string): boolean {
	if (!isValidReportId(id)) return false;
	const path = join(reportsDir(), `${id}.json`);
	if (!existsSync(path)) return false;
	rmSync(path, { force: true });
	return true;
}

export function updateReport(id: string, fn: (r: ReportRecord) => void): ReportRecord | null {
	const r = readReport(id);
	if (!r) return null;
	fn(r);
	saveReport(r);
	return r;
}

export function computeItemsFingerprint(items: ItemRecord[]): string {
	const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
	const payload = sorted.map((i) => `${i.id}:${i.meta?.analyzed_at ?? i.created_at}`).join('|');
	return createHash('sha1').update(payload).digest('hex').slice(0, 12);
}

export function findMatchingReport(
	topic: string,
	period: string,
	currentItems: ItemRecord[],
	now = new Date()
): ReportRecord | null {
	const reports = listReports();
	const doneReports = reports.filter(
		(r) => r.topic === topic && r.period === period && r.status === 'done'
	);
	if (doneReports.length === 0) return null;

	// 집계 완료된 과거 월(예: 2026-08): 이미 완료된 보고서가 있으면 그대로 반환
	if (isPastMonthPeriod(period, now)) {
		return doneReports[0];
	}

	// 당일 / 최근 10일 / 당월: 개별문제 분석결과 json 파일 목록/내용이 변하지 않은 경우 기존 보고서 반환
	const fingerprint = computeItemsFingerprint(currentItems);
	const match = doneReports.find((r) => r.items_fingerprint === fingerprint);
	return match ?? null;
}

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

export class ReportQueue {
	private pending: string[] = [];
	private running = false;
	private waiters: (() => void)[] = [];

	constructor(private runner?: (prompt: string) => Promise<string>) {}

	enqueue(id: string) {
		if (!this.pending.includes(id)) this.pending.push(id);
		void this.drain();
	}

	recover(): number {
		const stuck = listReports()
			.filter((r) => ACTIVE_REPORT_STATUSES.includes(r.status))
			.reverse();
		for (const r of stuck) this.enqueue(r.id);
		return stuck.length;
	}

	idle(): Promise<void> {
		if (!this.running && this.pending.length === 0) return Promise.resolve();
		return new Promise((res) => this.waiters.push(res));
	}

	private async drain() {
		if (this.running) return;
		this.running = true;
		try {
			let id: string | undefined;
			while ((id = this.pending.shift())) {
				try {
					await this.process(id);
				} catch (e) {
					console.error(`[report-queue] ${id} 처리 중 오류`, e);
				}
			}
		} finally {
			this.running = false;
			this.waiters.splice(0).forEach((w) => w());
		}
	}

	async process(id: string): Promise<ReportRecord | null> {
		const r = readReport(id);
		if (!r) return null;

		updateReport(id, (rec) => {
			rec.status = 'generating';
			rec.attempts = (rec.attempts ?? 0) + 1;
			rec.error = null;
		});

		try {
			const allRecords = listRecords();
			const topicRecords = allRecords.filter(
				(rec) => rec.status === 'done' && rec.analysis !== null && rec.analysis.classification.topic === r.topic
			);
			const targetRecords = topicRecords.filter((rec) => isItemInPeriod(rec.created_at, r.period));
			if (targetRecords.length === 0) {
				throw new Error(`'${r.topic}' 영역의 해당 기간에 분석 완료된 오답이 없습니다.`);
			}

			const { start: periodStart } = getPeriodRange(r.period);
			const priorRecords =
				periodStart !== null
					? topicRecords.filter((rec) => new Date(rec.created_at).getTime() < periodStart)
					: [];

			let conceptsMap: Record<string, string> = {};
			try {
				const tax = loadTaxonomy();
				conceptsMap = Object.fromEntries([...tax.conceptById.values()].map((c) => [c.id, c.desc]));
			} catch {
				/* 무시 */
			}

			const summary = calculateReportSummary(targetRecords, priorRecords, conceptsMap);

			const guidelinePath = join(promptsDir(), 'report.md');
			const rawGuideline = existsSync(guidelinePath) ? readFileSync(guidelinePath, 'utf8') : '';
			if (!rawGuideline) {
				throw new Error('user/prompts/report.md 지침 파일을 찾을 수 없습니다.');
			}
			const guideline = renderPrompt(rawGuideline);

			const prompt = buildReportPrompt({
				guideline,
				topic: r.topic,
				periodLabel: r.period_label,
				summary,
				items: targetRecords
			});

			const promptVersion = createHash('sha1').update(guideline).digest('hex').slice(0, 8);

			let markdown: string;
			let usedModel = settings().claudeModel;
			if (this.runner) {
				markdown = await this.runner(prompt);
			} else {
				const s = settings();
				const res = await runText(s.provider, prompt);
				markdown = res.text;
				usedModel = res.model;
			}

			// LLM 이 문제집 이름(특히 학기)을 잘못 조합한 곳을 실제 이름으로 바로잡는다(A 로 줄이되 100%는 아니므로)
			const refs = problemRefsFrom(targetRecords);
			let publishers = targetRecords.map((x) => x.workbook.publisher).filter(Boolean);
			try {
				publishers = [...publishers, ...loadWorkbooks().map((w) => w.publisher)];
			} catch {
				/* 설정 파일에 문제가 있어도 항목에 저장된 출판사로 교정한다 */
			}
			const fix = normalizeWorkbookMentions(markdown, refs, publishers);
			// 진단표의 문제 열은 AI 가 어떻게 썼든 "문제집<br/>문제번호" 두 줄로 통일한다
			markdown = formatProblemCells(fix.markdown, refs, publishers);
			// 상세 창 머리에 제목·기간이 이미 있으므로 본문 첫 큰 제목은 뗀다(지침에서도 쓰지 않게 하지만 AI 가 쓸 수 있다)
			markdown = stripLeadingTitle(markdown);
			if (fix.corrections.length)
				console.warn(`[report-queue] ${id} 문제집 이름 ${fix.corrections.length}곳 교정: ${fix.corrections.map((c) => `${c.number} ${c.from}→${c.to}`).join(', ')}`);
			if (fix.stray.length) console.warn(`[report-queue] ${id} 이 보고서와 무관한 문제집 표기: ${fix.stray.join(', ')}`);

			const updated = updateReport(id, (rec) => {
				rec.status = 'done';
				rec.error = null;
				rec.item_ids = targetRecords.map((x) => x.id);
				rec.items_fingerprint = computeItemsFingerprint(targetRecords);
				rec.summary = summary;
				rec.markdown = markdown;
				rec.meta = {
					model: usedModel,
					prompt_version: promptVersion,
					generated_at: new Date().toISOString(),
					...(fix.corrections.length ? { workbook_corrections: fix.corrections.length } : {}),
					...(fix.stray.length ? { stray_workbooks: fix.stray } : {})
				};
			});

			return updated;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			console.warn(`[report-queue] ${id} 실패: ${errMsg}`);
			return updateReport(id, (rec) => {
				rec.status = 'failed';
				rec.error = errMsg;
			});
		}
	}

	async generateOrReuse(params: {
		topic: string;
		period: string;
		force?: boolean;
		now?: Date;
	}): Promise<{ report: ReportRecord; cached: boolean }> {
		const now = params.now ?? new Date();
		const allRecords = listRecords();
		const topicRecords = allRecords.filter(
			(r) => r.status === 'done' && r.analysis !== null && r.analysis.classification.topic === params.topic
		);
		const targetRecords = topicRecords.filter((r) => isItemInPeriod(r.created_at, params.period, now));

		if (targetRecords.length === 0) {
			const pLabel = formatPeriodLabel(params.period, now);
			throw new Error(`'${params.topic}' 영역의 해당 기간(${pLabel})에 분석 완료된 오답이 없습니다.`);
		}

		if (!params.force) {
			const cached = findMatchingReport(params.topic, params.period, targetRecords, now);
			if (cached) {
				return { report: cached, cached: true };
			}
		}

		const periodLabel = formatPeriodLabel(params.period, now);
		const id = newReportId(now);
		const fingerprint = computeItemsFingerprint(targetRecords);

		const newReport: ReportRecord = {
			schema_version: 1,
			id,
			created_at: now.toISOString(),
			topic: params.topic,
			period: params.period,
			period_label: periodLabel,
			status: 'queued',
			error: null,
			attempts: 0,
			item_ids: targetRecords.map((r) => r.id),
			items_fingerprint: fingerprint,
			summary: null,
			markdown: null,
			meta: null
		};

		saveReport(newReport);
		const finished = await this.process(id);
		return { report: finished ?? newReport, cached: false };
	}
}

let reportQueueInstance: ReportQueue | null = null;
export function getReportQueue(): ReportQueue {
	if (!reportQueueInstance) {
		reportQueueInstance = new ReportQueue();
		const n = reportQueueInstance.recover();
		if (n) console.log(`[report-queue] 미완료 ${n}건을 다시 큐에 넣었습니다`);
	}
	return reportQueueInstance;
}
