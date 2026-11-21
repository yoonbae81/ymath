import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
import { clientIp, mutationLimiter } from '$lib/server/request-utils';

/**
 * 요청 Origin 이 이 앱의 정식 출처인지 검사한다. Origin 헤더가 없는 요청(curl·서버 간 호출)은
 * 브라우저 위조 대상이 아니므로 통과시킨다. OWASP ASVS V3.5: CSRF 및 크로스 오리진 위조 방어.
 * ORIGIN 환경변수(adapter-node 표준)가 있으면 그 주소만 정식 출처로 본다 — 요청이 스스로 심을 수
 * 있는 Host·X-Forwarded-Host 는 정식 출처가 있을 때는 신뢰하지 않는다. 없으면(테스트·로컬 실행)
 * 기존처럼 프록시가 전달한 Host 와의 일치로 검사한다.
 */
export function sameOriginOk(request: Request, fallbackHost?: string): boolean {
	const origin = request.headers.get('origin');
	if (!origin) return true;
	let originHost: string;
	try {
		originHost = new URL(origin).host;
	} catch {
		return false;
	}
	const configured = env.ORIGIN?.trim();
	if (configured) {
		try {
			return originHost === new URL(configured).host;
		} catch {
			return false;
		}
	}
	const reqHost = request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? fallbackHost;
	return reqHost != null && originHost === reqHost;
}

/**
 * 상태를 바꾸는 API 는 이 앱의 화면에서 보낸 요청만 받는다.
 * 1. 커스텀 헤더(X-Requested-With) 검증: CORS 사전 요청을 유발하여 비신뢰 사이트 차단
 * 2. Sec-Fetch-Site 헤더 검증: 브라우저가 cross-site 로 판단한 요청 즉각 거부
 * 3. Origin 헤더 검증: sameOriginOk
 */
export function requireAjax(request: Request) {
	if (request.headers.get('sec-fetch-site') === 'cross-site') {
		error(403, '허용되지 않은 교차 출처 요청입니다');
	}
	if (!sameOriginOk(request)) {
		error(403, '허용되지 않은 출처입니다');
	}
	if (request.headers.get(AJAX_HEADER) !== AJAX_VALUE) {
		error(403, '허용되지 않은 요청입니다');
	}
}

/**
 * OWASP ASVS V2.4.1: 상태를 바꾸는 API 의 공용 속도 제한(IP 당).
 * requireAjax 와 인가 검사 뒤에 호출한다. 몇 분에 걸친 자동화 시도를 막고, 가족 사용에는 여유가 있다.
 */
export function requireMutationRate(getClientAddress: () => string, request: Request) {
	let address = '';
	try {
		address = getClientAddress();
	} catch {
		// 주소를 모르면 모두 같은 칸으로 센다
	}
	const ip = clientIp(address, request.headers) || 'unknown';
	if (mutationLimiter.blocked(ip)) error(429, '요청이 너무 많아요. 잠시 후 다시 시도해 주세요');
	mutationLimiter.fail(ip);
}
