import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { deleteReport, isValidReportId, readReport } from '$lib/server/report';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	if (!isValidReportId(params.id)) error(400, '잘못된 보고서 ID 형식입니다');
	const report = readReport(params.id);
	if (!report) error(404, '보고서를 찾을 수 없습니다');
	return json(report);
};

export const DELETE: RequestHandler = ({ params, request, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidReportId(params.id)) error(400, '잘못된 보고서 ID 형식입니다');
	const ok = deleteReport(params.id);
	if (!ok) error(404, '보고서를 찾을 수 없습니다');
	return new Response(null, { status: 204 });
};

