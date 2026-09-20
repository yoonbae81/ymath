import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { deleteItem, isValidId, readRecord } from '$lib/server/store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const record = readRecord(params.id);
	if (!record) error(404, '항목을 찾을 수 없습니다');
	return json(record);
};

export const DELETE: RequestHandler = ({ params, request, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const record = readRecord(params.id);
	if (!record) error(404, '항목을 찾을 수 없습니다');
	// 처리 중인 항목을 지우면 워커가 없는 폴더를 만지게 되므로 막는다
	if (record.status === 'ocr' || record.status === 'analyzing') error(409, '분석 중인 항목은 삭제할 수 없습니다');
	deleteItem(params.id);
	return new Response(null, { status: 204 });
};

