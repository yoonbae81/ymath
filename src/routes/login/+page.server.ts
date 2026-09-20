import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import { passwordConfigured, safeNext } from '$lib/server/auth';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next'), base);
	// 이미 가족 권한이 있는 사람은 로그인 화면을 볼 필요가 없다 (게스트는 가족 로그인 가능)
	if (locals.session?.role === 'family') redirect(303, next);
	return { next, configured: passwordConfigured() };
};
