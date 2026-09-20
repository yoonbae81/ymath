import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	SHARE_TTL_SECONDS,
	clientIp,
	createLimiter,
	createSessionValue,
	createShareToken,
	guestMayRequest,
	isInternalRequest,
	parseCidrs,
	passwordMatches,
	safeNext,
	verifySessionValue,
	verifyShareToken
} from './auth';

const H = (h: Record<string, string> = {}) => new Headers(h);
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'ymath-auth-'));
	process.env.DATA_DIR = dir;
	delete process.env.SESSION_SECRET;
	delete process.env.TRUSTED_CIDRS;
	delete process.env.PASSWORD;
});
afterEach(() => {
	delete process.env.DATA_DIR;
	rmSync(dir, { recursive: true, force: true });
});

describe('공유 링크 토큰', () => {
	it('발급 직후에는 유효하고 정확히 1시간 뒤에 만료된다', () => {
		const { token, exp } = createShareToken(1000);
		expect(exp).toBe(1000 + SHARE_TTL_SECONDS);
		expect(verifyShareToken(token, 1000)).toBe(exp);
		expect(verifyShareToken(token, exp - 1)).toBe(exp);
		expect(verifyShareToken(token, exp)).toBeNull();
	});

	it('만료 시각이나 서명을 고치면 거부한다', () => {
		const { token, exp } = createShareToken(1000);
		const [, sig] = token.split('.');
		expect(verifyShareToken(`${exp + 86400}.${sig}`, 1000)).toBeNull();
		expect(verifyShareToken(`${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, 1000)).toBeNull();
		expect(verifyShareToken(`${exp}.`, 1000)).toBeNull();
		expect(verifyShareToken('garbage', 1000)).toBeNull();
		expect(verifyShareToken(`${exp}.${sig}.x`, 1000)).toBeNull();
		expect(verifyShareToken(`-1.${sig}`, 1000)).toBeNull();
	});

	it('비밀 키가 다르면 거부한다', () => {
		process.env.SESSION_SECRET = 'a';
		const { token } = createShareToken(1000);
		process.env.SESSION_SECRET = 'b';
		expect(verifyShareToken(token, 1000)).toBeNull();
	});

	it('SESSION_SECRET 이 없으면 데이터 폴더에 만들어 재사용한다(권한 600)', () => {
		const { token } = createShareToken(1000);
		const file = join(dir, 'session-secret');
		expect(existsSync(file)).toBe(true);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(verifyShareToken(token, 1000)).not.toBeNull();
	});
});

describe('세션 쿠키 값', () => {
	it('역할과 만료가 서명에 묶인다', () => {
		const v = createSessionValue('guest', 5000);
		expect(verifySessionValue(v, 4999)).toEqual({ role: 'guest', exp: 5000 });
		expect(verifySessionValue(v, 5000)).toBeNull(); // 만료
		expect(verifySessionValue(v.replace('guest', 'family'), 4999)).toBeNull(); // 권한 상승 시도
		expect(verifySessionValue(v.replace('.5000.', '.9000.'), 4999)).toBeNull(); // 만료 연장 시도
		expect(verifySessionValue(undefined)).toBeNull();
		expect(verifySessionValue('family.5000')).toBeNull();
	});

	it('공유 링크 토큰은 세션 쿠키로 쓸 수 없다', () => {
		const { token } = createShareToken(1000);
		expect(verifySessionValue(`family.${token}`, 1000)).toBeNull();
		expect(verifySessionValue(`guest.${token}`, 1000)).toBeNull();
	});
});

describe('비밀번호·실패 제한', () => {
	it('PASSWORD 가 없으면 어떤 입력도 통과하지 못한다', () => {
		expect(passwordMatches('')).toBe(false);
		expect(passwordMatches('undefined')).toBe(false);
	});

	it('맞는 비밀번호만 통과한다', () => {
		process.env.PASSWORD = 'yoonseo-1234';
		expect(passwordMatches('yoonseo-1234')).toBe(true);
		expect(passwordMatches('yoonseo-12345')).toBe(false);
		expect(passwordMatches('')).toBe(false);
	});

	it('5번 실패하면 막고, 시간이 지나면 풀리며, 성공하면 초기화된다', () => {
		const l = createLimiter(5, 1000);
		for (let i = 0; i < 4; i++) l.fail('ip', 0);
		expect(l.blocked('ip', 0)).toBe(false);
		l.fail('ip', 0);
		expect(l.blocked('ip', 0)).toBe(true);
		expect(l.blocked('other', 0)).toBe(false);
		expect(l.blocked('ip', 1000)).toBe(false);
		l.fail('ip', 2000);
		l.reset('ip');
		expect(l.blocked('ip', 2000)).toBe(false);
	});

	it('기록이 한도를 넘으면 가장 오래된 것부터 버려 메모리가 무한히 늘지 않는다', () => {
		const l = createLimiter(1, 10_000, 3);
		for (const k of ['a', 'b', 'c', 'd']) l.fail(k, 0);
		expect(l.blocked('a', 0)).toBe(false); // 밀려남
		expect(l.blocked('d', 0)).toBe(true);
	});
});

describe('내부망 판정', () => {
	it('기본값은 192.168.1.0/24 만 내부망', () => {
		expect(isInternalRequest('192.168.1.7', H())).toBe(true);
		expect(isInternalRequest('192.168.1.255', H())).toBe(true);
		expect(isInternalRequest('192.168.2.7', H())).toBe(false);
		expect(isInternalRequest('10.0.0.5', H())).toBe(false);
		expect(isInternalRequest('8.8.8.8', H())).toBe(false);
	});

	it('IPv4 매핑 주소(::ffff:)도 IPv4 로 본다. 해석 못 하는 주소는 내부망이 아니다', () => {
		expect(isInternalRequest('::ffff:192.168.1.7', H())).toBe(true);
		expect(isInternalRequest('fe80::1', H())).toBe(false);
		expect(isInternalRequest('', H())).toBe(false);
		expect(isInternalRequest('192.168.1.999', H())).toBe(false);
	});

	it('nginx(루프백)가 넘긴 X-Real-IP 를 기준으로 판단한다', () => {
		expect(isInternalRequest('127.0.0.1', H({ 'x-real-ip': '192.168.1.20' }))).toBe(true);
		expect(isInternalRequest('127.0.0.1', H({ 'x-real-ip': '203.0.113.9' }))).toBe(false);
		expect(isInternalRequest('::1', H({ 'x-real-ip': '192.168.1.20' }))).toBe(true);
	});

	it('루프백이라도 X-Real-IP 가 없으면(터널 등) 내부망이 아니다', () => {
		expect(isInternalRequest('127.0.0.1', H())).toBe(false);
	});

	it('루프백이 아닌 곳에서 온 요청의 X-Real-IP 는 무시한다(앱 포트에 직접 붙어 위조)', () => {
		expect(isInternalRequest('203.0.113.9', H({ 'x-real-ip': '192.168.1.20' }))).toBe(false);
		expect(clientIp('203.0.113.9', H({ 'x-real-ip': '192.168.1.20' }))).toBe('203.0.113.9');
	});

	it('X-Forwarded-For 에 바깥 주소가 있으면 내부망이 아니다(nginx 가 붙인 실제 접속자 포함)', () => {
		const spoof = { 'x-real-ip': '192.168.1.20' };
		expect(isInternalRequest('127.0.0.1', H({ ...spoof, 'x-forwarded-for': '203.0.113.9' }))).toBe(false);
		expect(isInternalRequest('127.0.0.1', H({ ...spoof, 'x-forwarded-for': '192.168.1.20, 203.0.113.9' }))).toBe(false);
		expect(isInternalRequest('127.0.0.1', H({ ...spoof, 'x-forwarded-for': '192.168.1.20' }))).toBe(true);
	});

	it('Cloudflare 를 거친 요청은 내부망이 아니다', () => {
		expect(isInternalRequest('127.0.0.1', H({ 'x-real-ip': '192.168.1.20', 'cf-connecting-ip': '203.0.113.9' }))).toBe(false);
	});

	it('TRUSTED_CIDRS 로 범위를 바꾸거나 여러 개 줄 수 있다', () => {
		process.env.TRUSTED_CIDRS = '10.0.0.0/8, 192.168.1.5';
		expect(isInternalRequest('10.20.30.40', H())).toBe(true);
		expect(isInternalRequest('192.168.1.5', H())).toBe(true);
		expect(isInternalRequest('192.168.1.6', H())).toBe(false);
		process.env.TRUSTED_CIDRS = '127.0.0.1';
		expect(isInternalRequest('127.0.0.1', H())).toBe(true); // 개발용
		process.env.TRUSTED_CIDRS = '';
		expect(isInternalRequest('192.168.1.5', H())).toBe(false);
	});

	it('잘못된 CIDR 은 버린다(넓게 열리지 않도록)', () => {
		expect(parseCidrs('abc, 1.2.3.4/33, 1.2.3.4/, 1.2.3.4/8/8, 300.1.1.1/8')).toEqual([]);
		expect(parseCidrs('192.168.1.77/24')).toEqual(parseCidrs('192.168.1.0/24'));
	});
});

describe('게스트 허용 범위', () => {
	it('읽기 전용 화면만 허용한다', () => {
		for (const p of ['/items', '/items/', '/areas', '/results', '/reports', '/status', '/status/']) expect(guestMayRequest('GET', p, false)).toBe(true);
		for (const p of ['/upload', '/api/items', '/api/reports', '/api/upload', '/']) expect(guestMayRequest('GET', p, false)).toBe(false);
	});

	it('상태를 바꾸는 메서드는 모두 막는다', () => {
		for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(guestMayRequest(m, '/items', false)).toBe(false);
	});

	it('원본 사진은 GUEST_PHOTOS 일 때만', () => {
		expect(guestMayRequest('GET', '/api/items/abc/image', false)).toBe(false);
		expect(guestMayRequest('GET', '/api/items/abc/image', true)).toBe(true);
		expect(guestMayRequest('GET', '/api/items/abc/retry', true)).toBe(false);
	});
});

describe('safeNext', () => {
	it('이 앱의 화면만 돌아갈 곳으로 허용한다', () => {
		expect(safeNext('/ymath/areas?id=1', '/ymath')).toBe('/ymath/areas?id=1');
		for (const bad of ['https://evil.test', '//evil.test', '/other', '/ymath/api/items', '/ymath/\\evil', undefined, 5]) {
			expect(safeNext(bad, '/ymath')).toBe('/ymath/upload');
		}
	});
});
