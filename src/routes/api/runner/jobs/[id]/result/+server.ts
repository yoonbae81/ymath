import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { commitCloudReportResult, commitCloudResult } from '$lib/server/cloudflare/runtime';
import { runnerAuthorized } from '$lib/server/cloudflare/runner-auth';

export const POST: RequestHandler = async ({ request, params, platform, url }) => {
	if (!platform?.env?.DB || !runnerAuthorized(request, platform.env.RUNNER_TOKEN)) error(401, '실행기 인증이 필요합니다');
	const token = request.headers.get('x-lease-token') ?? '';
	if ((request.headers.get('content-type') ?? '').includes('application/json')) {
		const value = await request.json().catch(() => null) as { job?: { id: string; entity_id: string; kind: 'item' | 'report'; generation: number; entity_generation: number; lease_token: string; payload: string }; report?: import('$lib/types').ReportRecord } | null;
		const job = value?.job;
		const report = value?.report;
		if (!job || !report || job.kind !== 'report' || job.id !== params.id || job.lease_token !== token || report.id !== job.entity_id) error(400, '보고서 작업 lease 정보가 맞지 않습니다');
		if (report.meta?.model === 'TEST-ONLY fixture' && !(platform.env.TEST_ONLY_FIXTURES === '1' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) error(403, 'TEST-ONLY 보고서 fixture는 로컬에서만 쓸 수 있습니다');
		if (!(await commitCloudReportResult(platform.env, job, token, report))) error(409, '보고서 작업 lease가 만료되었거나 삭제되었습니다');
		return json({ committed: true });
	}
	const form = await request.formData().catch(() => null);
	const image = form?.get('image');
	const rawMeta = form?.get('result');
	const ocrText = form?.get('ocr_text');
	const ocrMode = form?.get('ocr_mode');
	if (!(image instanceof File) || image.size < 12 || image.size > 25 * 1024 * 1024 || !(rawMeta instanceof File || typeof rawMeta === 'string')) error(400, '잘못된 결과입니다');
	const value = JSON.parse(typeof rawMeta === 'string' ? rawMeta : await rawMeta.text()) as {
		job: { id: string; entity_id: string; kind: 'item' | 'report'; generation: number; entity_generation: number; lease_token: string; payload: string };
		analysis: unknown; meta: { provider: string; model: string; prompt_version: string; analyzed_at: string };
		flags: { ocr_missing: boolean; taxonomy_mismatch: string[]; guardrail: string[] };
	};
	if (typeof ocrText === 'string' && ocrText.length > 1_000_000) error(413, 'OCR 결과가 너무 큽니다');
	if ((ocrMode === 'TEST-ONLY fixture' || (typeof ocrText === 'string' && ocrText.startsWith('TEST-ONLY'))) && !(platform.env.TEST_ONLY_FIXTURES === '1' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) error(403, 'TEST-ONLY OCR fixture는 로컬에서만 쓸 수 있습니다');
	if (!value.job || value.job.id !== params.id || value.job.lease_token !== token || value.job.kind !== 'item' || !value.meta?.analyzed_at) error(400, '작업 결과의 lease 정보가 맞지 않습니다');
	if (value.meta.provider === 'test-only' && !(platform.env.TEST_ONLY_FIXTURES === '1' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname))) error(403, 'TEST-ONLY 분석 fixture는 로컬에서만 쓸 수 있습니다');
	const jpeg = new Uint8Array(await image.arrayBuffer());
	if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) error(415, '정규화된 JPEG가 아닙니다');
	const ok = await commitCloudResult(platform.env, value.job, token, jpeg, value.analysis, value.meta, value.flags, typeof ocrText === 'string' ? ocrText : '');
	if (!ok) error(409, '작업 lease가 만료되었거나 항목이 삭제되었습니다');
	return json({ committed: true });
};
