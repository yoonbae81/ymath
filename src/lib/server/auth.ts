import type { Cookies } from '@sveltejs/kit';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './config';

/**
 * 접근 제어. 계정·DB 없이 서명(HMAC)만으로 처리한다.
 *  - 내부망(TRUSTED_CIDRS)에서 온 요청은 로그인 없이 family
 *  - 그 밖은 비밀번호(PASSWORD)로 로그인 → 서명 쿠키(family, 30일)
 *  - 가족이 만든 공유 링크(1시간)로 들어오면 읽기 전용 guest 쿠키(링크와 같은 시각에 만료)
 */
export type Role = 'family' | 'guest';
/** network: 내부망이라 로그인 생략, cookie: 서명 쿠키 */
export type Session = { role: Role; via: 'network' | 'cookie'; exp: number | null };

export const SESSION_COOKIE = 'ymath_session';
export const SHARE_TTL_SECONDS = 60 * 60;
export const FAMILY_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_TRUSTED_CIDRS = '192.168.1.0/24';

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------- 서명 ----------

const secrets = new Map<string, string>();

/** SESSION_SECRET 이 없으면 데이터 폴더에 한 번 만들어 두고 계속 쓴다(재시작해도 로그인 유지). 지우면 모든 세션·링크가 무효가 된다 */
function secret(): string {
	if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
	const file = join(dataDir(), 'session-secret');
	let value = secrets.get(file);
	if (value) return value;
	try {
		value = readFileSync(file, 'utf8').trim();
	} catch {
		// 아직 없다
	}
	if (!value) {
		value = randomBytes(32).toString('hex');
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, value, { mode: 0o600 });
	}
	secrets.set(file, value);
	return value;
}

const mac = (message: string) => createHmac('sha256', secret()).update(message).digest('base64url');

function sameString(a: string, b: string): boolean {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

const EXP_RE = /^\d{1,12}$/;

/** 읽기 전용 공유 링크: `<만료>.<서명>`. 서버에 저장하지 않는다 */
export function createShareToken(now = nowSeconds()): { token: string; exp: number } {
	const exp = now + SHARE_TTL_SECONDS;
	return { token: `${exp}.${mac(`share.${exp}`)}`, exp };
}

/** 유효하면 만료 시각(초), 아니면 null */
export function verifyShareToken(token: string, now = nowSeconds()): number | null {
	const parts = token.split('.');
	if (parts.length !== 2 || !EXP_RE.test(parts[0])) return null;
	if (!sameString(parts[1], mac(`share.${parts[0]}`))) return null;
	const exp = Number(parts[0]);
	return exp > now ? exp : null;
}

/** 세션 쿠키 값: `<역할>.<만료>.<서명>`. 서명 메시지에 접두어가 달라 공유 링크 토큰을 쿠키로 쓸 수 없다 */
export function createSessionValue(role: Role, exp: number): string {
	return `${role}.${exp}.${mac(`session.${role}.${exp}`)}`;
}

export function verifySessionValue(value: string | undefined, now = nowSeconds()): { role: Role; exp: number } | null {
	if (!value) return null;
	const parts = value.split('.');
	if (parts.length !== 3) return null;
	const [role, exp, sig] = parts;
	if ((role !== 'family' && role !== 'guest') || !EXP_RE.test(exp)) return null;
	if (!sameString(sig, mac(`session.${role}.${exp}`))) return null;
	return Number(exp) > now ? { role, exp: Number(exp) } : null;
}

/** 쿠키는 이 앱의 경로에만 보내고, 만료는 서명에 든 시각과 같게 한다 */
export function setSessionCookie(cookies: Cookies, role: Role, exp: number, opts: { path: string; secure: boolean }) {
	cookies.set(SESSION_COOKIE, createSessionValue(role, exp), {
		path: opts.path || '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: opts.secure,
		expires: new Date(exp * 1000)
	});
}

// ---------- 비밀번호 ----------

export const passwordConfigured = () => Boolean(process.env.PASSWORD);

export function passwordMatches(input: string): boolean {
	const expected = process.env.PASSWORD;
	if (!expected) return false; // 설정이 없으면 외부 로그인은 막힌다
	const digest = (s: string) => createHash('sha256').update(s).digest();
	return timingSafeEqual(digest(input), digest(expected));
}

/** 로그인 실패 횟수 제한(IP 별). 메모리에만 둔다 */
export function createLimiter(max = 5, windowMs = 10 * 60_000, capacity = 1000) {
	const hits = new Map<string, { count: number; resetAt: number }>();
	const live = (key: string, now: number) => {
		const hit = hits.get(key);
		if (hit && hit.resetAt > now) return hit;
		hits.delete(key);
		return undefined;
	};
	return {
		blocked: (key: string, now = Date.now()) => (live(key, now)?.count ?? 0) >= max,
		fail(key: string, now = Date.now()) {
			const hit = live(key, now);
			if (hit) {
				hit.count++;
				return;
			}
			if (hits.size >= capacity) {
				for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
				if (hits.size >= capacity) hits.delete(hits.keys().next().value as string);
			}
			hits.set(key, { count: 1, resetAt: now + windowMs });
		},
		reset: (key: string) => void hits.delete(key)
	};
}
export const loginLimiter = createLimiter();

/** OWASP ASVS V6.2.1: 비밀번호 최소 길이(8자) 정책 점검. 문제가 없거나 설정이 없으면 null */
export function passwordPolicyIssue(): string | null {
	const password = process.env.PASSWORD;
	if (!password) return null; // 설정이 없으면 외부 로그인이 아예 꺼져 있어 정책 위반이 아니다
	return password.length >= 8 ? null : 'PASSWORD 가 8자 미만입니다. 더 긴 값으로 설정하세요 (OWASP ASVS V6.2.1)';
}

/** OWASP ASVS V2.4.1: 상태를 바꾸는 API 의 공용 속도 제한(IP 당 10분). 가족 앱이라 업로드 버스트를 막지 않게 여유를 둔다 */
export const mutationLimiter = createLimiter(300, 10 * 60_000, 500);

// ---------- 내부망 판정 ----------

type Cidr = { net: number; mask: number };

function ipv4ToInt(ip: string): number | null {
	const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
	if (!m) return null;
	const o = m.slice(1).map(Number);
	if (o.some((n) => n > 255)) return null;
	return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** '::ffff:192.168.1.5' 같은 IPv4 매핑 주소를 IPv4 로 */
const normalizeIp = (ip: string) => ip.trim().replace(/^::ffff:/i, '');

/** '192.168.1.0/24,10.0.0.5' → 목록. IPv4 만 다루고, 해석할 수 없는 항목은 버린다(=신뢰하지 않음) */
export function parseCidrs(spec: string): Cidr[] {
	return spec
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.flatMap((entry) => {
			const [addr, bits = '32', ...rest] = entry.split('/');
			const ip = ipv4ToInt(addr);
			if (ip === null || rest.length || !/^\d{1,2}$/.test(bits) || Number(bits) > 32) return [];
			const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
			return [{ net: (ip & mask) >>> 0, mask }];
		});
}

const trustedCidrs = () => parseCidrs(process.env.TRUSTED_CIDRS ?? DEFAULT_TRUSTED_CIDRS);

function isTrustedIp(ip: string, cidrs: Cidr[]): boolean {
	const n = ipv4ToInt(normalizeIp(ip));
	return n !== null && cidrs.some((c) => ((n & c.mask) >>> 0) === c.net);
}

const isLoopback = (ip: string) => ip === '::1' || ip.startsWith('127.');

/**
 * 요청을 보낸 쪽의 주소. 소켓 상대가 같은 서버의 nginx(루프백)일 때만 nginx 가 덮어쓰는 X-Real-IP 를 믿는다.
 * 그 외에는 헤더를 무시하므로, 앱 포트에 직접 붙어서 헤더를 꾸며도 소용없다.
 */
export function clientIp(socketAddress: string, headers: Headers): string {
	const socket = normalizeIp(socketAddress);
	if (!isLoopback(socket)) return socket;
	return normalizeIp(headers.get('x-real-ip') ?? '') || socket;
}

/**
 * 내부망에서 온 요청인가. 터널이나 다른 프록시를 거친 요청이 루프백으로 보여 내부망으로 오인되지 않도록,
 * 프록시가 남기는 흔적(X-Forwarded-For, CF-Connecting-IP)에 바깥 주소가 하나라도 있으면 내부망으로 보지 않는다.
 */
export function isInternalRequest(socketAddress: string, headers: Headers): boolean {
	const cidrs = trustedCidrs();
	if (!isTrustedIp(clientIp(socketAddress, headers), cidrs)) return false;
	if (headers.has('cf-connecting-ip')) return false;
	const forwarded = headers.get('x-forwarded-for');
	return !forwarded || forwarded.split(',').every((hop) => isTrustedIp(hop, cidrs));
}

// ---------- 게스트 허용 범위 ----------

export const guestPhotosAllowed = () => process.env.GUEST_PHOTOS === '1';

/** 게스트는 읽기 전용 화면만 본다(허용 목록 방식). 원본 사진은 GUEST_PHOTOS=1 일 때만 */
export function guestMayRequest(method: string, path: string, photos = guestPhotosAllowed()): boolean {
	if (method !== 'GET' && method !== 'HEAD') return false;
	if (/^\/(items|areas|results|reports|status)\/?$/.test(path)) return true;
	return photos && /^\/api\/items\/[^/]+\/image$/.test(path);
}

/** 로그인 후 돌아갈 곳. 이 앱 안의 화면(API 제외)만 허용해 다른 사이트로 보내는 데 쓰이지 않게 한다 */
export function safeNext(next: unknown, base: string): string {
	if (typeof next === 'string' && next.startsWith(`${base}/`) && !next.startsWith(`${base}/api/`) && !next.includes('\\')) {
		return next;
	}
	return `${base}/upload`;
}
