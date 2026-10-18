import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { readClaimedRaw } from '$lib/server/cloudflare/runtime';
import { runnerAuthorized } from '$lib/server/cloudflare/runner-auth';

export const GET: RequestHandler = async ({ request, params, platform }) => {
	if (!platform?.env?.DB || !runnerAuthorized(request, platform.env.RUNNER_TOKEN)) error(401, '실행기 인증이 필요합니다');
	const token = request.headers.get('x-lease-token') ?? '';
	const object = await readClaimedRaw(platform.env, params.id, token);
	if (!object) error(404, '작업 원본을 찾을 수 없습니다');
	return new Response(object.body, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } });
};
