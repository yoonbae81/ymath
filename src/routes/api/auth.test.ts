import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base } from '$app/paths';

import { POST as login } from './login/+server';
import { POST as logout } from './logout/+server';
import { POST as share } from './share/+server';
import { GET as enter } from '../s/[token]/+server';
import { AJAX_HEADER, AJAX_VALUE } from '$lib/ajax';
import {
	SESSION_COOKIE,
	createShareToken,
	loginLimiter,
	verifySessionValue,
	verifyShareToken,
	type Session
} from '$lib/server/auth';

const AJAX = { [AJAX_HEADER]: AJAX_VALUE };
const FAMILY: Session = { role: 'family', via: 'cookie', exp: null };
const GUEST: Session = { role: 'guest', via: 'cookie', exp: null };
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-authapi-'));
	process.env.DATA_DIR = dir;
	process.env.PASSWORD = 'yoonseo-1234';
	delete process.env.PUBLIC_URL;
	loginLimiter.reset('203.0.113.9');
});
afterEach(() => {
	delete process.env.DATA_DIR;
	delete process.env.PASSWORD;
	rmSync(dir, { recursive: true, force: true });
});

const cookies = () => ({ set: vi.fn(), delete: vi.fn(), get: vi.fn() });
const req = (path: string, body?: unknown, headers: Record<string, string> = AJAX) =>
	new Request(`http://ymath.test${base}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});

function tryLogin(body: unknown, o: { headers?: Record<string, string>; ip?: string; https?: boolean } = {}) {
	const c = cookies();
	const request = req('/api/login', body, o.headers);
	const url = new URL(`${o.https ? 'https' : 'http'}://ymath.test${base}/api/login`);
	return { c, result: login({ request, cookies: c, url, getClientAddress: () => o.ip ?? '203.0.113.9' } as never) };
}

describe('POST /api/login', () => {
	it('맞는 비밀번호면 30일짜리 가족 쿠키를 주고 돌아갈 곳을 알려 준다', async () => {
		const { c, result } = tryLogin({ password: 'yoonseo-1234', next: `${base}/areas` }, { https: true });
		const res = await result;
		expect(await res.json()).toEqual({ next: `${base}/areas` });
		const [name, value, opts] = c.set.mock.calls[0];
		expect(name).toBe(SESSION_COOKIE);
		const session = verifySessionValue(value);
		expect(session?.role).toBe('family');
		expect(session!.exp - Date.now() / 1000).toBeGreaterThan(29 * 86400);
		expect(opts).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true, path: base || '/' });
	});

	it('다른 사이트로 보내는 next 는 무시한다', async () => {
		const res = await tryLogin({ password: 'yoonseo-1234', next: 'https://evil.test' }).result;
		expect(await res.json()).toEqual({ next: `${base}/upload` });
	});

	it('틀린 비밀번호는 401이고 쿠키를 주지 않는다', async () => {
		const { c, result } = tryLogin({ password: 'nope' });
		await expect(result).rejects.toMatchObject({ status: 401 });
		expect(c.set).not.toHaveBeenCalled();
	});

	it('5번 틀리면 맞는 비밀번호로도 429 (같은 IP 만)', async () => {
		for (let i = 0; i < 5; i++) await expect(tryLogin({ password: 'nope' }).result).rejects.toMatchObject({ status: 401 });
		await expect(tryLogin({ password: 'yoonseo-1234' }).result).rejects.toMatchObject({ status: 429 });
		const other = await tryLogin({ password: 'yoonseo-1234' }, { ip: '198.51.100.7' }).result;
		expect(other.status).toBe(200);
		loginLimiter.reset('198.51.100.7');
	});

	it('nginx 뒤에서는 X-Real-IP 별로 센다', async () => {
		const h = (ip: string) => ({ ...AJAX, 'x-real-ip': ip });
		for (let i = 0; i < 5; i++) await expect(tryLogin({ password: 'x' }, { ip: '127.0.0.1', headers: h('203.0.113.9') }).result).rejects.toMatchObject({ status: 401 });
		await expect(tryLogin({ password: 'yoonseo-1234' }, { ip: '127.0.0.1', headers: h('203.0.113.9') }).result).rejects.toMatchObject({ status: 429 });
		expect((await tryLogin({ password: 'yoonseo-1234' }, { ip: '127.0.0.1', headers: h('198.51.100.8') }).result).status).toBe(200);
		loginLimiter.reset('198.51.100.8');
	});

	it('비밀번호가 없거나 이상한 본문은 400', async () => {
		for (const body of [{}, { password: '' }, { password: 5 }, { password: 'x'.repeat(201) }, null]) {
			await expect(tryLogin(body).result).rejects.toMatchObject({ status: 400 });
		}
	});

	it('커스텀 헤더가 없으면 403', async () => {
		await expect(tryLogin({ password: 'yoonseo-1234' }, { headers: {} }).result).rejects.toMatchObject({ status: 403 });
	});

	it('PASSWORD 가 설정되지 않았으면 503', async () => {
		delete process.env.PASSWORD;
		await expect(tryLogin({ password: '' }).result).rejects.toMatchObject({ status: 503 });
	});
});

describe('POST /api/share', () => {
	const make = (session: Session | null, origin = 'http://192.168.1.10') =>
		share({ request: req('/api/share'), url: new URL(`${origin}${base}/api/share`), locals: { session } } as never);

	it('가족은 1시간짜리 링크를 받는다', async () => {
		const res = await make(FAMILY);
		expect(res.status).toBe(201);
		const body = await res.json();
		const token = body.url.split('/s/')[1];
		const exp = verifyShareToken(token);
		expect(exp).not.toBeNull();
		expect(exp! - Date.now() / 1000).toBeGreaterThan(3590);
		expect(exp! - Date.now() / 1000).toBeLessThanOrEqual(3600);
		expect(Date.parse(body.expires_at) / 1000).toBe(exp);
		expect(body.url).toBe(`http://192.168.1.10${base}/s/${token}`);
		expect(body.public_url_configured).toBe(false);
	});

	it('PUBLIC_URL 이 있으면 그 주소로 만든다(끝 슬래시 정리)', async () => {
		process.env.PUBLIC_URL = 'https://math.example.com/';
		const body = await (await make(FAMILY)).json();
		expect(body.url.startsWith(`https://math.example.com${base}/s/`)).toBe(true);
		expect(body.public_url_configured).toBe(true);
	});

	it('PUBLIC_URL 에 앱 경로까지 적어도 경로가 겹치지 않는다', async () => {
		for (const v of [`https://lab.example.com${base}`, `https://lab.example.com${base}/`]) {
			process.env.PUBLIC_URL = v;
			const body = await (await make(FAMILY)).json();
			expect(body.url.startsWith(`https://lab.example.com${base}/s/`)).toBe(true);
			if (base) expect(body.url).not.toContain(`${base}${base}`);
		}
	});

	it('게스트·로그인 안 한 사람은 만들 수 없다', () => {
		expect(() => make(GUEST)).toThrow(expect.objectContaining({ status: 403 }));
		expect(() => make(null)).toThrow(expect.objectContaining({ status: 403 }));
	});

	it('커스텀 헤더가 없으면 403', () => {
		expect(() =>
			share({ request: req('/api/share', undefined, {}), url: new URL('http://x.test/'), locals: { session: FAMILY } } as never)
		).toThrow(expect.objectContaining({ status: 403 }));
	});
});

describe('GET /s/[token]', () => {
	const enterWith = (token: string, session: Session | null, https = true) => {
		const c = cookies();
		let thrown: unknown;
		try {
			enter({ params: { token }, cookies: c, url: new URL(`${https ? 'https' : 'http'}://ymath.test${base}/s/${token}`), locals: { session } } as never);
		} catch (e) {
			thrown = e;
		}
		return { c, thrown };
	};

	it('유효한 링크: 링크와 같은 시각에 끝나는 게스트 쿠키를 주고 토큰 없는 주소로 보낸다', () => {
		const { token, exp } = createShareToken();
		const { c, thrown } = enterWith(token, null);
		expect(thrown).toMatchObject({ status: 303, location: `${base}/items` });
		const [name, value, opts] = c.set.mock.calls[0];
		expect(name).toBe(SESSION_COOKIE);
		expect(verifySessionValue(value)).toEqual({ role: 'guest', exp });
		expect(opts.expires.getTime()).toBe(exp * 1000);
		expect(opts).toMatchObject({ httpOnly: true, secure: true, path: base || '/' });
	});

	it('만료됐거나 위조된 링크는 410 이고 쿠키를 주지 않는다', () => {
		const old = createShareToken(Math.floor(Date.now() / 1000) - 3601);
		const fresh = createShareToken();
		for (const token of [old.token, `${fresh.exp + 100}.${fresh.token.split('.')[1]}`, 'abc']) {
			const { c, thrown } = enterWith(token, null);
			expect(thrown).toMatchObject({ status: 410 });
			expect(c.set).not.toHaveBeenCalled();
		}
	});

	it('가족이 링크를 열어도 게스트 쿠키를 발급받아 읽기 전용으로 진입한다', () => {
		const { token, exp } = createShareToken();
		const { c, thrown } = enterWith(token, FAMILY);
		expect(thrown).toMatchObject({ status: 303 });
		expect(c.set).toHaveBeenCalled();
		const [, value] = c.set.mock.calls[0];
		expect(verifySessionValue(value)).toEqual({ role: 'guest', exp });
	});
});

describe('POST /api/logout', () => {
	it('세션 쿠키를 지운다', async () => {
		const c = cookies();
		const res = logout({ request: req('/api/logout'), cookies: c } as never);
		expect((await (res as Response).json()).ok).toBe(true);
		expect(c.delete).toHaveBeenCalledWith(SESSION_COOKIE, { path: base || '/' });
	});
});
