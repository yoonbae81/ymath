import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { getReportQueue, isValidReportId, readReport, updateReport } from '$lib/server/report';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ params, request, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidReportId(params.id)) error(400, '잘못된 보고서 ID 형식입니다');
	const report = readReport(params.id);
	if (!report) error(404, '보고서를 찾을 수 없습니다');
	if (report.status !== 'done' && report.status !== 'failed') error(409, '이미 보고서 작성 대기 중이거나 진행 중입니다');

	updateReport(params.id, (r) => {
		r.status = 'queued';
		r.error = null;
		r.attempts = 0;
	});
	getReportQueue().enqueue(params.id);
	return json({ id: params.id, status: 'queued' }, { status: 202 });
};
