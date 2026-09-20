import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { getReportQueue, listReports } from '$lib/server/report';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => {
	return json(listReports());
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	let body: Record<string, unknown>;
	try {
		const parsed = await request.json();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			error(400, '잘못된 JSON 본문입니다');
		}
		body = parsed as Record<string, unknown>;
	} catch {
		error(400, '잘못된 JSON 본문입니다');
	}

	const rawTopic = typeof body.topic === 'string' ? body.topic.trim() : '';
	if (!rawTopic) {
		error(400, '보고서를 작성할 영역을 지정해 주세요');
	}
	if (rawTopic.length > 100) {
		error(400, '영역 이름은 100자 이하여야 합니다');
	}
	// 제어 문자 방지
	if (/[\x00-\x1F\x7F]/.test(rawTopic)) {
		error(400, '유효하지 않은 문자가 포함되어 있습니다');
	}

	let period = '';
	if (body.period !== undefined && body.period !== null) {
		if (typeof body.period !== 'string') {
			error(400, '기간은 문자열이어야 합니다');
		}
		period = body.period.trim();
		if (period === 'all') period = '';
		else if (period === 'day') period = 'today';
		else if (period === 'week') period = '10d';

		const PERIOD_RE = /^(|today|10d|month|\d{4}-\d{2})$/;
		if (!PERIOD_RE.test(period)) {
			error(400, '유효하지 않은 기간 형식입니다');
		}
	}

	const force = Boolean(body.force);

	try {
		const result = await getReportQueue().generateOrReuse({ topic: rawTopic, period, force });
		return json(result, { status: 201 });
	} catch (err) {
		console.error('[reports error]', err);
		error(500, '보고서 생성 중 오류가 발생했습니다');
	}
};
