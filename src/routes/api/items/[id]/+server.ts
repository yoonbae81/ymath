import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import type { RequestHandler } from './$types';
import { cloudItem } from '$lib/server/cloudflare/runtime';
import { tombstoneEntity } from '$lib/server/cloudflare/repository';
import { NODE_RUNTIME } from '$lib/server/runtime-target';

const isId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);
export const GET: RequestHandler = async ({ params, platform }) => {
	if (!isId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	let record;
	if (platform?.env?.DB) record = await cloudItem(platform.env, params.id);
	else if (NODE_RUNTIME) record = (await import('$lib/server/store')).readRecord(params.id);
	else error(503, '데이터베이스에 연결할 수 없습니다');
	if (!record) error(404, '항목을 찾을 수 없습니다');
	return json(record);
};

export const DELETE: RequestHandler = async ({ params, request, getClientAddress, platform }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	if (platform?.env?.DB) {
		const record = await cloudItem(platform.env, params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		const keys = await platform.env.DB.prepare('SELECT image_key,raw_key,ocr_key FROM entities WHERE id = ? AND deleted_at IS NULL').bind(params.id).first<{ image_key: string | null; raw_key: string | null; ocr_key: string | null }>();
		const analyses = await platform.env.DB.prepare('SELECT analysis_key FROM analyses WHERE entity_id=?').bind(params.id).all<{ analysis_key: string }>();
		const results = await platform.env.DB.prepare('SELECT result_key FROM jobs WHERE entity_id=? AND result_key IS NOT NULL').bind(params.id).all<{ result_key: string }>();
		if (!(await tombstoneEntity(platform.env.DB, params.id))) error(409, '항목이 이미 변경되었습니다');
		const objects = new Set([keys?.image_key, keys?.raw_key, keys?.ocr_key, ...(analyses.results ?? []).map((row) => row.analysis_key), ...(results.results ?? []).map((row) => row.result_key)].filter((key): key is string => Boolean(key)));
		await Promise.all([...objects].map((key) => platform.env.OBJECTS.delete(key).catch(() => undefined)));
		return new Response(null, { status: 204 });
	}
	if (NODE_RUNTIME) {
		const { readRecord, deleteItem } = await import('$lib/server/store');
		const record = readRecord(params.id);
		if (!record) error(404, '항목을 찾을 수 없습니다');
		if (record.status === 'ocr' || record.status === 'analyzing') error(409, '분석 중인 항목은 삭제할 수 없습니다');
		deleteItem(params.id);
		return new Response(null, { status: 204 });
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};

