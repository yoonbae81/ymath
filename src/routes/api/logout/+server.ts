import { json } from '@sveltejs/kit';
import { base } from '$app/paths';
import { SESSION_COOKIE } from '$lib/server/auth';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ request, cookies, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	cookies.delete(SESSION_COOKIE, { path: base || '/' });
	return json({ ok: true });
};
