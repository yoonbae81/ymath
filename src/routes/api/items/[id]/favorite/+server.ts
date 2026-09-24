import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { isValidId, readRecord, updateRecord } from '$lib/server/store';
import { auditLog } from '$lib/server/log';
import type { RequestHandler } from './$types';

/** 오답을 즐겨찾기에 넣거나 뺀다(토글은 화면에서 지금 값을 뒤집어 보낸다) */
export const POST: RequestHandler = async ({ params, request, getClientAddress }) => {
	requireAjax(request);
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const body = (await request.json().catch(() => null)) as { favorite?: unknown } | null;
	if (typeof body?.favorite !== 'boolean') error(400, '즐겨찾기 여부는 참/거짓으로 보내 주세요');

	const record = readRecord(params.id);
	if (!record) error(404, '항목을 찾을 수 없습니다');

	const updated = updateRecord(params.id, (r) => {
		r.favorite = body.favorite as boolean;
	});
	auditLog('favorite', { ok: 'success', id: params.id, favorite: updated.favorite });
	return json({ favorite: updated.favorite });
};
