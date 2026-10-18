import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { claimCloudJob } from '$lib/server/cloudflare/runtime';
import { runnerAuthorized } from '$lib/server/cloudflare/runner-auth';

export const POST: RequestHandler = async ({ request, platform }) => {
	if (!platform?.env?.DB) error(503, '실행기 연결이 설정되지 않았습니다');
	if (!runnerAuthorized(request, platform.env.RUNNER_TOKEN)) error(401, '실행기 인증이 필요합니다');
	const body = await request.json().catch(() => ({})) as { runner?: string };
	const runner = typeof body.runner === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(body.runner) ? body.runner : 'runner';
	const job = await claimCloudJob(platform.env, runner);
	return json({ job });
};
