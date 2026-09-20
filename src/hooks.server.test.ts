import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base } from '$app/paths';

vi.mock('$lib/server/queue', () => ({ getQueue: () => ({}) }));

import { handle, handleError } from './hooks.server';
import { SESSION_COOKIE, createSessionValue } from '$lib/server/auth';

const LAN = '192.168.1.20';
const OUTSIDE = '203.0.113.9';
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-hooks-'));
	process.env.DATA_DIR = dir;
	delete process.env.TRUSTED_CIDRS;
	delete process.env.GUEST_PHOTOS;
});
afterEach(() => {
	delete process.env.DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

/** ip 는 소켓 상대의 주소. cookie 는 세션 쿠키 값 */
function event(path: string, o: { method?: string; ip?: string; headers?: Record<string, string>; cookie?: string } = {}) {
	const url = new URL(`http://ymath.test${base}${path}`);
	return {
		url,
		request: new Request(url, { method: o.method ?? 'GET', headers: o.headers }),
		cookies: { get: (name: string) => (name === SESSION_COOKIE ? o.cookie : undefined) },
		getClientAddress: () => o.ip ?? LAN,
		locals: {} as Record<string, unknown>
	};
}
const ok = async () => new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } });
const run = (e: ReturnType<typeof event>, resolve = ok) => handle({ event: e as never, resolve });
const guestCookie = () => createSessionValue('guest', Math.floor(Date.now() / 1000) + 600);
const familyCookie = () => createSessionValue('family', Math.floor(Date.now() / 1000) + 600);

describe('hooks.server 접근 제어', () => {
	it('내부망(192.168.1.x)은 로그인 없이 통과하고 가족 권한을 갖는다', async () => {
		const e = event('/upload');
		const res = await run(e);
		expect(res.status).toBe(200);
		expect(e.locals.session).toEqual({ role: 'family', via: 'network', exp: null });
	});

	it('nginx 를 거친 내부망 요청도 통과한다(X-Real-IP)', async () => {
		const res = await run(event('/items', { ip: '127.0.0.1', headers: { 'x-real-ip': LAN, 'x-forwarded-for': LAN } }));
		expect(res.status).toBe(200);
	});

	it('외부 화면 요청은 로그인으로 보내고, 돌아올 주소를 기억한다', async () => {
		const res = await run(event('/areas?id=r1', { ip: OUTSIDE }));
		expect(res.status).toBe(303);
		expect(res.headers.get('location')).toBe(`${base}/login?next=${encodeURIComponent(`${base}/areas?id=r1`)}`);
	});

	it('외부 API·데이터 요청은 리다이렉트 없이 401', async () => {
		const resolve = vi.fn(ok);
		for (const path of ['/api/items', '/items/__data.json']) {
			const res = await run(event(path, { ip: OUTSIDE }), resolve);
			expect(res.status).toBe(401);
		}
		expect((await run(event('/api/upload', { ip: OUTSIDE, method: 'POST' }), resolve)).status).toBe(401);
		expect(resolve).not.toHaveBeenCalled();
	});

	it('외부에서 X-Real-IP 를 위조해도(터널·직접 접속) 내부망이 되지 않는다', async () => {
		const fake = { 'x-real-ip': LAN };
		expect((await run(event('/items', { ip: OUTSIDE, headers: fake }))).status).toBe(303);
		expect((await run(event('/items', { ip: '127.0.0.1', headers: { ...fake, 'x-forwarded-for': OUTSIDE } }))).status).toBe(303);
		expect((await run(event('/items', { ip: '127.0.0.1', headers: { ...fake, 'cf-connecting-ip': OUTSIDE } }))).status).toBe(303);
	});

	it('로그인 화면·로그인 API·공유 링크 입구·정적 파일은 로그인 없이 열린다', async () => {
		for (const path of ['/login', '/api/login', '/api/logout', '/s/123.abc', '/_app/immutable/x.js']) {
			expect((await run(event(path, { ip: OUTSIDE }))).status, path).toBe(200);
		}
	});

	it('내부망이라도 게스트 쿠키가 있으면 읽기 전용(guest) 권한을 갖는다', async () => {
		const e = event('/items', { ip: LAN, cookie: guestCookie() });
		const res = await run(e);
		expect(res.status).toBe(200);
		expect(e.locals.session).toMatchObject({ role: 'guest', via: 'cookie' });
	});

	it('가족 쿠키가 있으면 외부에서도 통과한다', async () => {
		const e = event('/upload', { ip: OUTSIDE, cookie: familyCookie() });
		expect((await run(e)).status).toBe(200);
		expect(e.locals.session).toMatchObject({ role: 'family', via: 'cookie' });
	});

	it('위조·만료된 쿠키는 로그인 안 한 것으로 본다', async () => {
		const forged = familyCookie().replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
		const expired = createSessionValue('family', 1);
		expect((await run(event('/items', { ip: OUTSIDE, cookie: forged }))).status).toBe(303);
		expect((await run(event('/items', { ip: OUTSIDE, cookie: expired }))).status).toBe(303);
		expect((await run(event('/items', { ip: OUTSIDE, cookie: 'family.9999999999.x' }))).status).toBe(303);
	});

	it('게스트는 읽기 전용 화면만 본다(base·__data.json 을 뗀 경로로 판정)', async () => {
		const cookie = guestCookie();
		for (const path of ['/items', '/areas?id=r1', '/status', '/items/__data.json', '/areas/__data.json', '/status/__data.json']) {
			expect((await run(event(path, { ip: OUTSIDE, cookie }))).status, path).toBe(200);
		}
	});

	it('게스트가 올리기 같은 비허용 화면에 가면 문제별 화면으로 돌려보낸다', async () => {
		const cookie = guestCookie();
		for (const path of ['/upload', '/']) {
			const res = await run(event(path, { ip: OUTSIDE, cookie }));
			expect(res.status, path).toBe(303);
			expect(res.headers.get('location')).toBe(`${base}/items`);
		}
	});

	it('게스트의 쓰기·API 요청은 403 (화면 요청이 아니므로 리다이렉트 없음)', async () => {
		const cookie = guestCookie();
		const resolve = vi.fn(ok);
		for (const [method, path] of [
			['POST', '/api/upload'],
			['POST', '/api/share'],
			['POST', '/api/reports'],
			['DELETE', '/api/items/abc'],
			['POST', '/api/items/abc/retry'],
			['GET', '/api/items'],
			['GET', '/api/reports'],
			['POST', '/items']
		]) {
			expect((await run(event(path, { ip: OUTSIDE, cookie, method }), resolve)).status, `${method} ${path}`).toBe(403);
		}
		expect(resolve).not.toHaveBeenCalled();
	});

	it('게스트의 원본 사진 요청은 GUEST_PHOTOS=1 일 때만 허용한다', async () => {
		const cookie = guestCookie();
		expect((await run(event('/api/items/abc/image', { ip: OUTSIDE, cookie }))).status).toBe(403);
		process.env.GUEST_PHOTOS = '1';
		expect((await run(event('/api/items/abc/image', { ip: OUTSIDE, cookie }))).status).toBe(200);
	});

	it('막은 응답에도 보안 헤더가 붙는다', async () => {
		const res = await run(event('/api/items', { ip: OUTSIDE }));
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
	});
});

describe('hooks.server security headers', () => {
	it('응답에 OWASP ASVS 표준 보안 헤더들을 삽입한다', async () => {
		const mockEvent = event('/items') as never;

		const mockResolve = async () => new Response('<html>ok</html>', {
			headers: { 'content-type': 'text/html' }
		});

		const res = await handle({ event: mockEvent, resolve: mockResolve });

		expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
		expect(res.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(res.headers.get('X-Frame-Options')).toBe('DENY');
		expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
		expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=31536000; includeSubDomains');
		expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
		expect(res.headers.get('X-Permitted-Cross-Domain-Policies')).toBe('none');
	});

	it('API 요청에는 anti-caching 헤더(Cache-Control: no-store)를 적용한다', async () => {
		const mockEvent = event('/api/items') as never;

		const mockResolve = async () => new Response('{"items":[]}', {
			headers: { 'content-type': 'application/json' }
		});

		const res = await handle({ event: mockEvent, resolve: mockResolve });
		expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
		expect(res.headers.get('Pragma')).toBe('no-cache');
	});

	it('HTML 페이지 응답에도 anti-caching 헤더를 적용한다 (V14.3.2)', async () => {
		const mockEvent = event('/items') as never;
		const mockResolve = async () => new Response('<html>ok</html>', {
			headers: { 'content-type': 'text/html; charset=utf-8' }
		});

		const res = await handle({ event: mockEvent, resolve: mockResolve });
		expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
	});

	it('__data.json 데이터 요청에도 anti-caching 헤더를 적용한다 (V14.3.2)', async () => {
		const mockEvent = event('/items/__data.json') as never;
		const mockResolve = async () => new Response('{"data":{}}', {
			headers: { 'content-type': 'application/json' }
		});

		const res = await handle({ event: mockEvent, resolve: mockResolve });
		expect(res.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
	});

	it('자체 cache-control 을 가진 응답(이미지 등)은 안 건드린다', async () => {
		const mockEvent = event('/api/items/abc/image') as never;
		const mockResolve = async () => new Response('bytes', {
			headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400' }
		});

		const res = await handle({ event: mockEvent, resolve: mockResolve });
		expect(res.headers.get('Cache-Control')).toBe('private, max-age=86400');
	});

	it('SvelteKit 이 만든 CSP(인라인 스크립트 해시)는 덮어쓰지 않는다', async () => {
		const mockEvent = event('/items') as never;
		const mockResolve = async () =>
			new Response('<html>ok</html>', {
				headers: {
					'content-type': 'text/html',
					'content-security-policy':
						"default-src 'self'; script-src 'self' 'sha256-ABC123xyz=='; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
				}
			});

		const res = await handle({ event: mockEvent, resolve: mockResolve });
		expect(res.headers.get('Content-Security-Policy')).toContain("'sha256-ABC123xyz=='");
		expect(res.headers.get('Content-Security-Policy')).not.toContain("'unsafe-inline'; script-src");
	});

	it('handleError 는 서버 스택을 감추고 안전한 공통 메시지를 반환한다', () => {
		const err = new Error('Secret DB path: /var/secret/db.sqlite failed');
		const res = handleError({
			error: err,
			event: {} as never,
			status: 500,
			message: 'Internal Error'
		});
		expect(res).toEqual({ message: '서버 내부 오류가 발생했습니다' });
	});
});
