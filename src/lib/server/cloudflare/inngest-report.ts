import type { ItemRecord, ReportRecord, ReportSummary } from '$lib/types';
import { formatProblemCells, normalizeWorkbookMentions, problemRefsFrom, stripLeadingTitle } from '$lib/report-links';
import { buildReportPrompt, calculateReportSummary } from '../report-core';

const SEOUL_OFFSET_MS = 9 * 60 * 60 * 1000;
const seoulTime = (iso: string) => new Date(iso).getTime() + SEOUL_OFFSET_MS;
function periodRange(period: string, now: Date): { start: number | null; end: number | null } {
	if (!period || period === 'all') return { start: null, end: null };
	const kst = new Date(now.getTime() + SEOUL_OFFSET_MS);
	const y = kst.getUTCFullYear(), m = kst.getUTCMonth(), d = kst.getUTCDate();
	if (period === 'today' || period === 'day') return { start: Date.UTC(y, m, d), end: null };
	if (period === '10d' || period === 'week') return { start: Date.UTC(y, m, d - 10), end: null };
	if (period === 'month') return { start: Date.UTC(y, m, 1), end: null };
	const match = period.match(/^(\d{4})-(\d{2})$/);
	if (match) return { start: Date.UTC(Number(match[1]), Number(match[2]) - 1, 1), end: Date.UTC(Number(match[1]), Number(match[2]), 0, 23, 59, 59, 999) };
	return { start: null, end: null };
}

export interface InngestReportRequest { prompt: string; targetIds: string[]; summary: ReportSummary; targets: ItemRecord[] }

/** Uses the same summary and prompt builders as the existing Node report queue. */
export function buildInngestReportRequest(input: {
	report: ReportRecord; records: ItemRecord[]; guideline: string; concepts: Record<string, string>; now?: Date;
}): InngestReportRequest {
	const { report, records } = input;
	const now = input.now ?? new Date();
	const topic = records.filter((record) => record.status === 'done' && record.analysis !== null && record.analysis.classification.topic === report.topic);
	const { start, end } = periodRange(report.period, now);
	const targets = topic.filter((record) => {
		const created = seoulTime(record.created_at);
		return Number.isNaN(created) || ((start === null || created >= start) && (end === null || created <= end));
	});
	if (!targets.length) throw new Error(`'${report.topic}' 영역의 해당 기간에 분석 완료된 오답이 없습니다.`);
	const prior = start === null ? [] : topic.filter((record) => seoulTime(record.created_at) < start);
	const summary = calculateReportSummary(targets, prior, input.concepts);
	const prompt = buildReportPrompt({ guideline: input.guideline, topic: report.topic, periodLabel: report.period_label, summary, items: targets });
	return { prompt, targetIds: targets.map((record) => record.id), summary, targets };
}

/** Normalizes SDK Markdown into the app's existing ReportRecord shape. */
export async function completeInngestReport(input: {
	report: ReportRecord; prompt: string; targetIds: string[]; summary: ReportSummary; targets: ItemRecord[];
	markdown: string; model: string; guideline: string; publishers: string[]; now?: Date;
}): Promise<ReportRecord> {
	if (!input.markdown.trim() || input.markdown.length > 100_000) throw new Error('보고서 본문이 비어 있거나 너무 깁니다');
	const refs = problemRefsFrom(input.targets);
	const publishers = [...input.targets.map((item) => item.workbook.publisher).filter(Boolean), ...input.publishers];
	const fix = normalizeWorkbookMentions(input.markdown, refs, publishers);
	const markdown = stripLeadingTitle(formatProblemCells(fix.markdown, refs, publishers));
	const promptVersion = await sha1(input.guideline, 8);
	return {
		...input.report,
		status: 'done', error: null, attempts: input.report.attempts,
		item_ids: input.targetIds, items_fingerprint: await fingerprint(input.targets), summary: input.summary, markdown,
		meta: {
			model: input.model, prompt_version: promptVersion, generated_at: (input.now ?? new Date()).toISOString(),
			...(fix.corrections.length ? { workbook_corrections: fix.corrections.length } : {}),
			...(fix.stray.length ? { stray_workbooks: fix.stray } : {})
		}
	};
}

export async function fingerprint(items: ItemRecord[]): Promise<string> {
	const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
	const payload = sorted.map((item) => `${item.id}:${item.meta?.analyzed_at ?? item.created_at}`).join('|');
	const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(payload));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

async function sha1(value: string, length: number): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}
