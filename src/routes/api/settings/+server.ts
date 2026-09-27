import { error, json } from '@sveltejs/kit';
import { deleteSavedZaiApiKey, saveZaiApiKey, zaiApiKeySource } from '$lib/server/config';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import type { RequestHandler } from './$types';

const MAX_KEY_LENGTH = 300;

/**
 * Z.AI Coding Plan API 키 저장. 저장한 키는 user/config/zai-api-key(0600)에 남고,
 * 환경변수 ZAI_API_KEY 가 있으면 그쪽이 이긴다. 빈 문자열을 보내면 저장한 키를 지운다.
 * 읽기 전용 게스트는 hooks.server.ts 의 허용 목록에 없어 애초에 여기까지 오지 못한다.
 */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	const body = (await request.json().catch(() => null)) as { apiKey?: unknown } | null;
	if (!body || typeof body.apiKey !== 'string') error(400, 'apiKey 를 문자열로 보내 주세요');
	// 제어문자는 빼고 앞뒤 공백을 잘라 저장한다(화면은 텍스트로만 다루지만, 저장값도 깨끗하게 둔다)
	const key = body.apiKey.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
	if (key.length > MAX_KEY_LENGTH) error(400, 'API 키가 너무 깁니다');
	if (!key) deleteSavedZaiApiKey();
	else saveZaiApiKey(key);
	return json({ source: zaiApiKeySource() });
};
