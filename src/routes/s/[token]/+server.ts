import { error, redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { setSessionCookie, verifyShareToken } from '$lib/server/auth';
import type { RequestHandler } from './$types';

/** 공유 링크 입구. 서명과 만료를 확인하고, 링크와 같은 시각에 끝나는 읽기 전용 쿠키를 준 뒤 토큰이 없는 주소로 보낸다 */
export const GET: RequestHandler = ({ params, cookies, url, locals }) => {
	const exp = verifyShareToken(params.token);
	if (exp === null) error(410, '링크가 만료되었거나 올바르지 않아요');
	// 공유 링크로 접속하면 게스트(읽기 전용) 쿠키를 발급하여 임시 세션으로 진입하게 한다
	setSessionCookie(cookies, 'guest', exp, { path: base, secure: url.protocol === 'https:' });
	redirect(303, `${base}/items`);
};
