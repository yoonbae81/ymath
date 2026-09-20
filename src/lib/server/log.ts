/**
 * 보안 이벤트 로깅 (OWASP ASVS V16.3, V16.4.1)
 *  - V16.3.1: 인증 성공/실패 로그
 *  - V16.3.2: 인가 실패 로그
 *  - V16.4.1: 로그 인젝션 방지 — 제어 문자(개행 포함)를 걷어 한 줄로 만든다
 */

/** 값에서 로그 인젝션 위험이 있는 문자를 걷어 낸다. 개행은 줄바꿈 가짜 로그를 만들 수 있어 '?'로 바꾼다 */
export function safeLogValue(value: unknown): string {
	return String(value).replace(/[\x00-\x1f\x7f]/g, '?').trim();
}

/** 키=값 쌍을 한 줄로 조립한다. 값은 로그 인젝션 방지를 위해 제어 문자를 제거한다 */
export function formatLogFields(fields: Record<string, unknown>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${k}=${safeLogValue(v)}`)
		.join(' ');
}

/** 보안 감사 로그를 한 줄로 남긴다. 예: auditLog('login', { ok: 'fail', ip, reason }) */
export function auditLog(kind: string, fields: Record<string, unknown>): void {
	console.warn(`[audit:${kind}] ${formatLogFields(fields)}`);
}

/** V16.4.1: 에러 로그도 로그 인젝션에 안전하게. 스택 트레이스는 줄바꿈을 남겨 읽을 수 있게 한다 */
export function safeErrorForLog(error: unknown): string {
	const text = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
	return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\r]/g, '?');
}