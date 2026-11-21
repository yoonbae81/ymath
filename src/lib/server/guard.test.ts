import { afterEach, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';
import { requireAjax, sameOriginOk } from './guard';

// $env/dynamic/private 는 임포트 시점의 환경변수 스냅샷이라 stubEnv 로 못 바꾸므로, 테스트에서는
// 스냅샷 객체에 직접 ORIGIN 을 넣고 빼며 정식 출처 유무를 바꿔 본다.
function setOrigin(value: string | undefined): void {
	if (value === undefined) delete env.ORIGIN;
	else env.ORIGIN = value;
}

function req(url: string, headers: Record<string, string> = {}): Request {
	return new Request(url, { method: 'POST', headers });
}

/** requireAjax 는 @sveltejs/kit 의 HttpError(status) 로 거부한다 */
function statusOf(fn: () => void): number | undefined {
	try {
		fn();
		return undefined;
	} catch (e) {
		return (e as { status?: number }).status;
	}
}

afterEach(() => setOrigin(undefined));

describe('sameOriginOk', () => {
	it('passes requests without an Origin header (curl, server-to-server)', () => {
		expect(sameOriginOk(req('https://study.xcv.kr/math/api/upload'))).toBe(true);
	});

	it('rejects malformed Origin headers', () => {
		expect(sameOriginOk(req('https://study.xcv.kr/math/api/upload', { origin: 'not-a-url' }))).toBe(false);
	});

	it('without ORIGIN, compares against the forwarded host', () => {
		setOrigin(undefined);
		const ok = req('https://study.xcv.kr/math/api/upload', { origin: 'https://study.xcv.kr', 'x-forwarded-host': 'study.xcv.kr' });
		expect(sameOriginOk(ok)).toBe(true);
		const bad = req('https://study.xcv.kr/math/api/upload', { origin: 'https://evil.example', 'x-forwarded-host': 'study.xcv.kr' });
		expect(sameOriginOk(bad)).toBe(false);
		const fallback = req('https://study.xcv.kr/math/api/upload', { origin: 'https://study.xcv.kr' });
		expect(sameOriginOk(fallback, 'study.xcv.kr')).toBe(true);
	});

	it('with ORIGIN, trusts only the configured origin — not forwarded hosts', () => {
		setOrigin('https://study.xcv.kr');
		const canonical = req('https://10.0.0.9:3141/math/api/upload', { origin: 'https://study.xcv.kr', host: '10.0.0.9:3141' });
		expect(sameOriginOk(canonical)).toBe(true);
		const spoofed = req('https://study.xcv.kr/math/api/upload', { origin: 'https://evil.example', 'x-forwarded-host': 'evil.example' });
		expect(sameOriginOk(spoofed)).toBe(false);
	});
});

describe('requireAjax', () => {
	it('rejects cross-site fetch metadata, bad origins, and missing AJAX header', () => {
		setOrigin(undefined);
		expect(statusOf(() => requireAjax(req('https://study.xcv.kr/math/api/upload', { 'sec-fetch-site': 'cross-site', 'x-requested-with': 'ymath' })))).toBe(403);
		expect(statusOf(() => requireAjax(req('https://study.xcv.kr/math/api/upload', { origin: 'https://evil.example', 'x-requested-with': 'ymath' })))).toBe(403);
		expect(statusOf(() => requireAjax(req('https://study.xcv.kr/math/api/upload')))).toBe(403);
	});

	it('accepts a same-origin AJAX mutation', () => {
		setOrigin('https://study.xcv.kr');
		const ok = req('https://study.xcv.kr/math/api/upload', { origin: 'https://study.xcv.kr', 'x-requested-with': 'ymath' });
		expect(statusOf(() => requireAjax(ok))).toBeUndefined();
	});
});
