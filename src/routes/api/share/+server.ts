import { error, json } from '@sveltejs/kit';
import { base } from '$app/paths';
import { clientIp, createShareToken } from '$lib/server/auth';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { auditLog } from '$lib/server/log';
import type { RequestHandler } from './$types';

/** 1시간 동안만 열리는 읽기 전용 링크를 만든다. 가족만 만들 수 있다 */
export const POST: RequestHandler = ({ request, url, locals, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당), V16.3.2: 링크 생성 감사 로그
	requireMutationRate(getClientAddress, request);
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		// 주소를 모르면 모두 같은 칸으로 센다
	}
	auditLog('share', { ok: 'create', ip: clientIp(address, request.headers) || 'unknown' });
	if (locals.session?.role !== 'family') error(403, '가족만 링크를 만들 수 있어요');

	const { token, exp } = createShareToken();
	// 내부망 주소로 링크를 만들면 지인이 열 수 없다. 바깥에서 접속하는 주소를 PUBLIC_URL 로 알려 준다(예: https://math.example.com).
	// 앱 경로(/ymath)까지 적어도 되도록 끝의 슬래시와 base 는 떼고 쓴다
	const publicUrl = process.env.PUBLIC_URL?.replace(/\/+$/, '').replace(new RegExp(`${base}$`), '') || undefined;
	return json(
		{
			url: `${publicUrl ?? url.origin}${base}/s/${token}`,
			expires_at: new Date(exp * 1000).toISOString(),
			public_url_configured: Boolean(publicUrl)
		},
		{ status: 201 }
	);
};
