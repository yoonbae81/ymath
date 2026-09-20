import { json } from '@sveltejs/kit';
import type { Handle, HandleServerError, RequestEvent } from '@sveltejs/kit';
import { base } from '$app/paths';
import {
	SESSION_COOKIE,
	clientIp,
	guestMayRequest,
	isInternalRequest,
	passwordPolicyIssue,
	verifySessionValue,
	type Session
} from '$lib/server/auth';
import { getQueue } from '$lib/server/queue';
import { auditLog, safeErrorForLog } from '$lib/server/log';

// 서버 시작 시 큐를 만들고, 처리 중이던 항목을 복구한다.
getQueue();

// OWASP ASVS V6.2.1: 비밀번호 최소 길이(8자) 정책을 기동 시 점검한다
const passwordIssue = passwordPolicyIssue();
if (passwordIssue) console.warn(`[보안] ${passwordIssue}`);

/** base 와 SvelteKit 의 데이터 요청 꼬리(`/__data.json`)를 뗀 경로. 예: /ymath/items/__data.json → /items */
function relativePath(pathname: string): string {
	const path = (pathname.startsWith(base) ? pathname.slice(base.length) : pathname).replace(/\/__data\.json$/, '');
	return path || '/';
}

/** 로그인 없이 볼 수 있는 곳: 로그인 화면·API, 로그아웃 API, 공유 링크 입구, 화면에 필요한 정적 파일 */
const isPublic = (path: string) =>
	path === '/login' || path === '/api/login' || path === '/api/logout' || path.startsWith('/s/') || path.startsWith('/_app/');

function sessionOf(event: RequestEvent): Session | null {
	// 쿠키에 유효한 세션(게스트 또는 가족)이 있으면 망 위치와 상관없이 해당 권한을 우선 적용한다
	const cookie = verifySessionValue(event.cookies.get(SESSION_COOKIE));
	if (cookie) return { role: cookie.role, via: 'cookie', exp: cookie.exp };

	let address = '';
	try {
		address = event.getClientAddress();
	} catch {
		// 주소를 알 수 없으면 내부망으로 보지 않는다
	}
	if (address && isInternalRequest(address, event.request.headers)) return { role: 'family', via: 'network', exp: null };
	return null;
}

/** 로그용 요청 IP. address 는 sessionOf 이 이미 구했지만 여기서는 헤더 위조 여부와 무관하게 판정값만 쓴다 */
function requestIpOf(event: RequestEvent): string {
	let address = '';
	try {
		address = event.getClientAddress();
	} catch {
		// 주소를 모르면 모두 같은 칸으로 센다
	}
	return clientIp(address, event.request.headers) || 'unknown';
}

/** 통과하면 null, 막으면 그 응답 */
function guard(event: RequestEvent): Response | null {
	const session = (event.locals.session = sessionOf(event));
	const path = relativePath(event.url.pathname);
	if (isPublic(path)) return null;

	// 화면 이동이면 안내하고, API·데이터 요청은 상태 코드로 답한다
	const wantsPage = event.request.method === 'GET' && !path.startsWith('/api/') && !event.url.pathname.endsWith('/__data.json');
	const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } });

	if (!session) {
		// OWASP ASVS V16.3.2: 인가 실패(로그인 안 함) 이벤트 로깅
		auditLog('authz', { ok: 'deny', reason: 'no-session', ip: requestIpOf(event), method: event.request.method, path });
		if (!wantsPage) return json({ message: '로그인이 필요합니다' }, { status: 401 });
		return redirect(`${base}/login?next=${encodeURIComponent(event.url.pathname + event.url.search)}`);
	}
	if (session.role === 'guest' && !guestMayRequest(event.request.method, path)) {
		// OWASP ASVS V16.3.2: 인가 실패(읽기 전용 게스트의 허용 밖 요청) 이벤트 로깅
		auditLog('authz', { ok: 'deny', reason: 'guest-readonly', ip: requestIpOf(event), method: event.request.method, path });
		if (!wantsPage) return json({ message: '읽기 전용 링크로는 할 수 없어요' }, { status: 403 });
		return redirect(`${base}/items`);
	}
	return null;
}

export const handle: Handle = async ({ event, resolve }) => {
	const response = guard(event) ?? (await resolve(event));

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

