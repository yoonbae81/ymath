import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { FEEDBACK_CHOICES, FEEDBACK_COMMENT_MAX, type Feedback, type FeedbackChoice } from '$lib/types';
import type { RequestHandler } from './$types';
import { cloudItem, saveFeedback } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);

/** 학생의 분석 반응을 남긴다. 같은 분석에 다시 답하면 덮어쓰고, 재분석 전의 반응은 그대로 둔다. */
export const POST: RequestHandler = async ({ params, request, getClientAddress, platform }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const body = (await request.json().catch(() => null)) as { choice?: unknown; comment?: unknown } | null;
	if (!body || !FEEDBACK_CHOICES.includes(body.choice as FeedbackChoice)) error(400, '알 수 없는 응답입니다');
	if (body.comment !== undefined && typeof body.comment !== 'string') error(400, '의견은 글자여야 합니다');
	// 제어 문자는 빼고 길이를 자른다(화면은 텍스트로만 그리지만, 저장값도 깨끗하게 둔다)
	const comment = (body.comment ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, FEEDBACK_COMMENT_MAX);

	if (platform?.env?.DB) {
		const record = await cloudItem(platform.env, params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		if (record.status !== 'done' || !record.analysis || !record.meta) error(409, '분석이 끝난 항목에만 남길 수 있어요');
		const entry: Feedback = { choice: body.choice as FeedbackChoice, comment, created_at: new Date().toISOString(), analyzed_at: record.meta.analyzed_at, prompt_version: record.meta.prompt_version, provider: record.meta.provider, model: record.meta.model };
		if (!(await saveFeedback(platform.env.DB, params.id, entry.analyzed_at, entry))) error(409, '분석이 바뀌었습니다. 최신 분석을 확인한 뒤 다시 남겨 주세요');
		return json(entry);
	}
	if (NODE_RUNTIME) {
		const { readRecord, updateRecord } = await import('$lib/server/store');
		const record = readRecord(params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		if (record.status !== 'done' || !record.analysis || !record.meta) error(409, '분석이 끝난 항목에만 남길 수 있어요');
		const updated = updateRecord(params.id, (r) => {
			const meta = r.meta!;
			const entry: Feedback = { choice: body.choice as FeedbackChoice, comment, created_at: new Date().toISOString(), analyzed_at: meta.analyzed_at, prompt_version: meta.prompt_version, provider: meta.provider, model: meta.model };
			r.feedback = [...(r.feedback ?? []).filter((f) => f.analyzed_at !== meta.analyzed_at), entry];
		});
		return json(updated.feedback!.find((f) => f.analyzed_at === updated.meta!.analyzed_at));
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
