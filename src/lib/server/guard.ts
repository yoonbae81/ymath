import { error } from '@sveltejs/kit';
import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
import { clientIp, mutationLimiter } from '$lib/server/auth';

/**
 * 상태를 바꾸는 API 는 이 앱의 화면에서 보낸 요청만 받는다.
 * OWASP ASVS V3.5: CSRF 및 크로스 오리진 위조 공격 방어
 * 1. 커스텀 헤더(X-Requested-With) 검증: CORS 사전 요청을 유발하여 비신뢰 사이트 차단
 * 2. Sec-Fetch-Site 헤더 검증: 브라우저가 cross-site 로 판단한 요청 즉각 거부
 * 3. Origin 헤더 검증: 출처가 제공된 경우 요청 호스트와 일치하는지 확인
 */
export function requireAjax(request: Request) {
	const secFetchSite = request.headers.get('sec-fetch-site');
	if (secFetchSite === 'cross-site') {
		error(403, '허용되지 않은 교차 출처 요청입니다');
	}

	const origin = request.headers.get('origin');
	if (origin) {
		try {
			const originHost = new URL(origin).host;
			const reqHost =
				request.headers.get('x-forwarded-host') ??
				request.headers.get('host') ??
				new URL(request.url).host;
			if (reqHost && originHost !== reqHost) {
				error(403, '허용되지 않은 출처입니다');
			}
		} catch {
			error(403, '유효하지 않은 출처 헤더입니다');
		}
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
