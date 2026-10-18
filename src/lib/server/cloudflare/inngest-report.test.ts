import { describe, expect, it } from 'vitest';
import type { ItemRecord, ReportRecord } from '$lib/types';
import { validAnalysis } from '../analysis.fixture';
import { buildInngestReportRequest, completeInngestReport } from './inngest-report';

const workbook = { id: 'ssen-m3-2', name: '쎈 중3-2', publisher: '쎈', grade: '중3', semester: 2 };
function item(id: string, created_at: string): ItemRecord {
	const analysis = validAnalysis(); analysis.problem.number_guess = '0255';
	return { schema_version: 1, id, created_at, status: 'done', error: null, attempts: 1, workbook, image: 'image.jpg', flags: { ocr_missing: false, taxonomy_mismatch: [], guardrail: [] }, analysis: analysis as ItemRecord['analysis'], meta: { provider: 'omlx', model: 'fixture', prompt_version: 'fixture', analyzed_at: created_at } };
}
const report: ReportRecord = { schema_version: 1, id: '20261017-080000-rep-abcd', created_at: '2026-10-17T08:00:00Z', topic: '대수', period: '2026-10', period_label: '2026-10', status: 'generating', error: null, attempts: 1, item_ids: [], items_fingerprint: '', summary: null, markdown: null, meta: null };

describe('application report contract for Inngest', () => {
	it('builds the existing report prompt from target and prior analyzed app records', () => {
		const current = item('20261003-080000-abcd', '2026-10-03T08:00:00Z');
		const prior = item('20260930-080000-abcd', '2026-09-30T08:00:00Z');
		const built = buildInngestReportRequest({ report, records: [current, prior], guideline: '# 실제 보고 지침', concepts: { 'ALG-EXPANSION': '곱셈공식' }, now: new Date('2026-10-17T09:00:00Z') });
		expect(built.targetIds).toEqual([current.id]);
		expect(built.prompt).toContain('# 실제 보고 지침');
		expect(built.prompt).toContain('총 1건');
		expect(built.prompt).not.toContain('course');
		expect(built.summary.recurrent_patterns[0]).toMatchObject({ current_count: 1, prior_count: 1, trend: '유지' });
	});
	it('uses the existing Markdown normalization and ReportRecord metadata contract', async () => {
		const current = item('20261003-080000-abcd', '2026-10-03T08:00:00Z');
		const prompt = buildInngestReportRequest({ report, records: [current], guideline: '# 지침', concepts: {}, now: new Date('2026-10-17T09:00:00Z') });
		const completed = await completeInngestReport({ report, ...prompt, markdown: '# AI 제목\n\n| 문제 | 진단 |\n|---|---|\n| 0255 · 쎈 중3-1 | 확인 |', model: 'fixture-model', guideline: '# 지침', publishers: ['쎈'], now: new Date('2026-10-17T09:00:00Z') });
		expect(completed).toMatchObject({ status: 'done', attempts: 1, summary: { total_items: 1 }, item_ids: [current.id], meta: { model: 'fixture-model', workbook_corrections: 1, generated_at: '2026-10-17T09:00:00.000Z' } });
		expect(completed.markdown).toContain('쎈 중3-2<br/>0255');
		expect(completed.markdown).not.toContain('# AI 제목');
		expect(completed.items_fingerprint).toMatch(/^[a-f0-9]{12}$/);
	});
});
