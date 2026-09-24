import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { isValidId, readRecord, updateRecord } from '$lib/server/store';
import type { RequestHandler } from './$types';

/** 오답분석을 열면 마지막 확인 시각을 덮어쓴다 */
export const POST: RequestHandler = async ({ params, request, getClientAddress }) => {
	requireAjax(request);
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');

	const record = readRecord(params.id);
	if (!record) error(404, '항목을 찾을 수 없습니다');
	if (record.status !== 'done' || !record.analysis) error(409, '분석이 끝난 항목만 기록해요');

	const updated = updateRecord(params.id, (r) => {
		r.viewed_at = new Date().toISOString();
	});
	return json({ viewed_at: updated.viewed_at });
};
