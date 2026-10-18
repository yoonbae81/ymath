import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import type { RequestHandler } from './$types';
import { cloudItem, markViewed } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);

/** 오답분석을 열면 마지막 확인 시각을 덮어쓴다 */
export const POST: RequestHandler = async ({ params, request, getClientAddress, platform }) => {
	requireAjax(request);
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');

	if (platform?.env?.DB) {
		const record = await cloudItem(platform.env, params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		if (record.status !== 'done' || !record.analysis) error(409, '분석이 끝난 항목만 기록해요');
		const viewed_at = new Date().toISOString();
		if (!(await markViewed(platform.env.DB, params.id, viewed_at))) error(404, '항목을 찾을 수 없습니다');
		return json({ viewed_at });
	}
	if (NODE_RUNTIME) {
		const { readRecord, updateRecord } = await import('$lib/server/store');
		const record = readRecord(params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		if (record.status !== 'done' || !record.analysis) error(409, '분석이 끝난 항목만 기록해요');
		const updated = updateRecord(params.id, (r) => { r.viewed_at = new Date().toISOString(); });
		return json({ viewed_at: updated.viewed_at });
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
