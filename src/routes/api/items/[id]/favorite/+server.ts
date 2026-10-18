import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { auditLog } from '$lib/server/log';
import type { RequestHandler } from './$types';
import { cloudItem, setFavorite } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);

/** 오답을 즐겨찾기에 넣거나 뺀다(토글은 화면에서 지금 값을 뒤집어 보낸다) */
export const POST: RequestHandler = async ({ params, request, getClientAddress, platform }) => {
	requireAjax(request);
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const body = (await request.json().catch(() => null)) as { favorite?: unknown } | null;
	if (typeof body?.favorite !== 'boolean') error(400, '즐겨찾기 여부는 참/거짓으로 보내 주세요');

	if (platform?.env?.DB) {
		if (!(await cloudItem(platform.env, params.id))) error(404, '항목을 찾을 수 없습니다');
		if (!(await setFavorite(platform.env.DB, params.id, body.favorite))) error(404, '항목을 찾을 수 없습니다');
		return json({ favorite: body.favorite });
	}
	if (NODE_RUNTIME) {
		const { readRecord, updateRecord } = await import('$lib/server/store');
		const record = readRecord(params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		const updated = updateRecord(params.id, (r) => { r.favorite = body.favorite as boolean; });
		auditLog('favorite', { ok: 'success', id: params.id, favorite: updated.favorite });
		return json({ favorite: updated.favorite });
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
