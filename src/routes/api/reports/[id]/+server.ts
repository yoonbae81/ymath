import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
import { cloudReport, deleteCloudReport } from '$lib/server/cloudflare/runtime';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, platform }) => {
	if (!/^[0-9]{8}-[0-9]{6}-rep-[a-z0-9]{4}$/.test(params.id)) error(400, '잘못된 보고서 ID 형식입니다');
	if (platform?.env?.DB) {
		let report;
		try { report = await cloudReport(platform.env, params.id); }
		catch (err) { console.error('[report storage error]', err); error(503, '보고서 저장소를 읽지 못했습니다'); }
		if (!report) error(404, '보고서를 찾을 수 없습니다');
		return json(report);
	}
	if (!platform?.env?.DB && NODE_RUNTIME) {
	const { readReport } = await import('$lib/server/report');
	const report = readReport(params.id);
	if (!report) error(404, '보고서를 찾을 수 없습니다');
	return json(report);
	}
	error(503, '보고서 저장소에 연결할 수 없습니다');
};

export const DELETE: RequestHandler = async ({ params, request, getClientAddress, platform }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!/^[0-9]{8}-[0-9]{6}-rep-[a-z0-9]{4}$/.test(params.id)) error(400, '잘못된 보고서 ID 형식입니다');
	if (platform?.env?.DB) {
		if (!(await deleteCloudReport(platform.env, params.id))) error(404, '보고서를 찾을 수 없습니다');
		return new Response(null, { status: 204 });
	}
	if (!platform?.env?.DB && NODE_RUNTIME) {
	const { deleteReport } = await import('$lib/server/report');
	const ok = deleteReport(params.id);
	if (!ok) error(404, '보고서를 찾을 수 없습니다');
	return new Response(null, { status: 204 });
	}
	error(503, '보고서 저장소에 연결할 수 없습니다');
};

