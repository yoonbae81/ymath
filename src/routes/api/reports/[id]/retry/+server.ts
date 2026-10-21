import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
import { cloudReport, retryCloudReport } from '$lib/server/cloudflare/runtime';

import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ params, request, url, getClientAddress, platform }) => {
	requireAjax(request);
	const provider = url.searchParams.get('provider');
	if (provider !== null && provider !== 'omlx') error(400, 'Qwen(omlx)만 사용할 수 있습니다');
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!/^[0-9]{8}-[0-9]{6}-rep-[a-z0-9]{4}$/.test(params.id)) error(400, '잘못된 보고서 ID 형식입니다');
	if (platform?.env?.DB) {
		const report = await cloudReport(platform.env, params.id);
		if (!report) error(404, '보고서를 찾을 수 없습니다');
		if (report.status !== 'done' && report.status !== 'failed') error(409, '이미 보고서 작성 대기 중이거나 진행 중입니다');
		if (!(await retryCloudReport(platform.env, params.id))) error(409, '보고서가 이미 변경되었습니다');
		return json({ id: params.id, status: 'queued' }, { status: 202 });
	}
	if (!platform?.env?.DB && NODE_RUNTIME) {
	const { getReportQueue, readReport, updateReport } = await import('$lib/server/report');
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
	}
	error(503, '보고서 저장소에 연결할 수 없습니다');
};
