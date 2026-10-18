import { json } from '@sveltejs/kit';
import type { Handle, HandleServerError, RequestEvent } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { Session } from '$lib/types';
import { safeErrorForLog } from '$lib/server/log';
import { consumeRateLimit } from '$lib/server/cloudflare/repository';
import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
import { NODE_RUNTIME } from '$lib/server/runtime-target';

function relativePath(pathname: string): string {
	const path = (pathname.startsWith(base) ? pathname.slice(base.length) : pathname).replace(/\/__data\.json$/, '');
	return path || '/';
}

export const handle: Handle = async ({ event, resolve }) => {
	if (NODE_RUNTIME) {
		if (!event.platform?.env?.DB) (await import('$lib/server/queue')).getQueue();
	}
	event.locals.session = { role: 'family', via: 'anonymous', exp: null } as Session;
	const relative = relativePath(event.url.pathname);
	let response: Response | null = null;
	if (relative === '/login' || relative === '/api/login' || relative === '/api/logout' || relative === '/api/share' || relative.startsWith('/s/')) {
		response = new Response(JSON.stringify({ message: '이 경로는 더 이상 지원하지 않습니다' }), { status: 410, headers: { 'content-type': 'application/json' } });
	}
	const isInngestSdk = relative === '/api/inngest';
	if (!response && event.request.method !== 'GET' && event.request.method !== 'HEAD' && !relative.startsWith('/api/runner/') && !isInngestSdk) {
		const site = event.request.headers.get('sec-fetch-site');
		const origin = event.request.headers.get('origin');
		let originOk = true;
		if (origin) { try { originOk = new URL(origin).host === (event.request.headers.get('x-forwarded-host') ?? event.request.headers.get('host') ?? event.url.host); } catch { originOk = false; } }
		if (site === 'cross-site' || !originOk || event.request.headers.get(AJAX_HEADER) !== AJAX_VALUE) response = new Response(JSON.stringify({ message: '허용되지 않은 요청입니다' }), { status: 403, headers: { 'content-type': 'application/json' } });
	}
	if (!response && event.platform?.env?.DB && event.request.method !== 'GET' && event.request.method !== 'HEAD' && !relative.startsWith('/api/runner/') && !isInngestSdk) {
		let address = '';
		try { address = event.getClientAddress(); } catch { address = event.request.headers.get('cf-connecting-ip') ?? 'unknown'; }
		const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(address || 'unknown'));
		const key = `rate:${Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('')}`;
		try {
			if (!(await consumeRateLimit(event.platform.env.DB, key, Date.now(), 10 * 60_000, 300))) response = new Response(JSON.stringify({ message: '요청が多すぎます' }), { status: 429, headers: { 'content-type': 'application/json' } });
		} catch {
			response = new Response(JSON.stringify({ message: '요청 제한 저장소에 연결할 수 없습니다' }), { status: 503, headers: { 'content-type': 'application/json' } });
		}
	}
	response ??= await resolve(event);

	// OWASP ASVS V3.4.3 / V13: 보안 헤더 설정
	// 페이지(HTML) 응답은 SvelteKit 이 vite.config.ts 의 csp(hash 모드)로 인라인 스크립트 해시를
	// 담아 헤더를 이미 설정하므로 여기서 덮어쓰지 않는다. 그 외 응답(API·JSON·가드 생성)만 fallback 으로
	// 설정한다. script-src 에 'unsafe-inline' 이 없는 것은 hash 모드를 쓰기 때문이다.
	if (!response.headers.has('content-security-policy')) {
		response.headers.set(
			'Content-Security-Policy',
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
		);
	}
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('X-Permitted-Cross-Domain-Policies', 'none');

	// OWASP ASVS V14.3.2: 민감 데이터가 담긴 응답(API·데이터 요청·HTML 페이지)에 대한 캐시 방지.
	// 이미지 등 자체 cache-control 을 지정한 응답은 건드리지 않는다.
	const isHtml = (response.headers.get('content-type') ?? '').startsWith('text/html');
	const isPageData = event.url.pathname.endsWith('/__data.json');
	if ((event.url.pathname.includes('/api/') || isHtml || isPageData) && !response.headers.has('cache-control')) {
		response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
		response.headers.set('Pragma', 'no-cache');
	}

	return response;
};

export const handleError: HandleServerError = ({ error }) => {
	// OWASP ASVS V16.5 + V16.4.1: 에러 상세·스택을 클라이언트에 노출하지 않고, 로그는 로그 인젝션에
	// 안전한 형태(제어 문자 제거)로 남긴다
	const time = new Date().toISOString();
	console.error(`[${time}] [Server Error]:`, safeErrorForLog(error));
	return {
		message: '서버 내부 오류가 발생했습니다'
	};
};

