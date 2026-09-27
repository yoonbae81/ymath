import { error, json } from '@sveltejs/kit';
import { isValidId, listAnalyses } from '$lib/server/store';
import type { RequestHandler } from './$types';

/** 항목에 저장된 모든 분석(프로바이더별 파일). 상태를 바꾸지 않는 읽기 전용이라 게스트도 볼 수 있다 */
export const GET: RequestHandler = ({ params }) => {
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	return json({ analyses: listAnalyses(params.id) });
};
