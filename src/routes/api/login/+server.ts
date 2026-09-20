import { error, json } from '@sveltejs/kit';
import { base } from '$app/paths';
import {
	FAMILY_TTL_SECONDS,
	clientIp,
	loginLimiter,
	passwordConfigured,
	passwordMatches,
	safeNext,
	setSessionCookie
} from '$lib/server/auth';
import { requireAjax } from '$lib/server/guard';
import { auditLog } from '$lib/server/log';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, cookies, url, getClientAddress }) => {
	requireAjax(request);
	if (!passwordConfigured()) error(503, '서버에 PASSWORD 가 설정되지 않아 외부 로그인이 꺼져 있어요');

	let address = '';
	try {
		address = getClientAddress();
	} catch {
		// 주소를 모르면 모두 같은 칸으로 센다
	}
	const ip = clientIp(address, request.headers) || 'unknown';
	if (loginLimiter.blocked(ip)) error(429, '실패가 너무 많아요. 잠시 후 다시 시도해 주세요');

	const body = (await request.json().catch(() => null)) as { password?: unknown; next?: unknown } | null;
	const password = body?.password;
	if (typeof password !== 'string' || password.length === 0 || password.length > 200) error(400, '비밀번호를 입력해 주세요');
	if (!passwordMatches(password)) {
		loginLimiter.fail(ip);
		// OWASP ASVS V16.3.1: 인증 실패 이벤트 로깅
		auditLog('login', { ok: 'fail', ip });
		error(401, '비밀번호가 맞지 않아요');
	}

	loginLimiter.reset(ip);
	// OWASP ASVS V16.3.1: 인증 성공 이벤트 로깅
	auditLog('login', { ok: 'success', ip });
	const exp = Math.floor(Date.now() / 1000) + FAMILY_TTL_SECONDS;
	setSessionCookie(cookies, 'family', exp, { path: base, secure: url.protocol === 'https:' });
	return json({ next: safeNext(body?.next, base) });
};
