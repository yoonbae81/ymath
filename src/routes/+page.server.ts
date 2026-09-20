import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';
import type { PageServerLoad } from './$types';

// `/`는 향후 대시보드를 연결할 자리다. 그때까지는 업로드 페이지로 보낸다.
export const load: PageServerLoad = () => redirect(307, `${base}/upload`);
