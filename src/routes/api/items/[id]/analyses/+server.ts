import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cloudAnalyses, cloudItem } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);

/** 항목에 저장된 모든 분석(프로바이더별 파일). 상태를 바꾸지 않는 읽기 전용이라 게스트도 볼 수 있다 */
export const GET: RequestHandler = async ({ params, platform }) => {
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	if (platform?.env?.DB) {
		if (!(await cloudItem(platform.env, params.id))) error(404, '항목을 찾을 수 없습니다');
		try { return json({ analyses: await cloudAnalyses(platform.env, params.id) }); }
		catch (err) { console.error('[analysis storage error]', err); error(503, '분석 저장소를 읽지 못했습니다'); }
	}
	if (NODE_RUNTIME) return json({ analyses: (await import('$lib/server/store')).listAnalyses(params.id) });
	error(503, '데이터베이스에 연결할 수 없습니다');
};
