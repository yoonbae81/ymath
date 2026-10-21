import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { handleItemCallback, ITEM_CALLBACK_ACTIONS } from '$lib/server/cloudflare/item-callbacks';

/** Connect Runner 전용 단일 item 콜백 라우트. action 은 화이트리스트 세그먼트다 —
 * 이벤트가 임의 URL·경로·SQL 을 고를 수 없고, 인증은 처리기가 RUNNER_TOKEN 으로 수행한다. */
export const POST: RequestHandler = async ({ params, request, platform }) => {
	if (!platform?.env?.DB) error(503, '실행기 연결이 설정되지 않았습니다');
	if (!(ITEM_CALLBACK_ACTIONS as readonly string[]).includes(params.action)) error(404, '알 수 없는 콜백입니다');
	return handleItemCallback(params.action, request, platform.env);
};
