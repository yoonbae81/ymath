import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { heartbeatCloudJob } from '$lib/server/cloudflare/runtime';
import { runnerAuthorized } from '$lib/server/cloudflare/runner-auth';

export const POST: RequestHandler = async ({ request, params, platform }) => {
	if (!platform?.env?.DB || !runnerAuthorized(request, platform.env.RUNNER_TOKEN)) error(401, '실행기 인증이 필요합니다');
	const body = await request.json().catch(() => null) as { job?: { id: string; generation: number; entity_id: string; entity_generation: number; kind: 'item' | 'report'; payload: string; lease_token: string } } | null;
	const job = body?.job;
	const token = request.headers.get('x-lease-token') ?? '';
	if (!job || job.id !== params.id || job.lease_token !== token) error(400, '작업 lease 정보가 맞지 않습니다');
	if (!(await heartbeatCloudJob(platform.env, job, token))) error(409, '작업 lease가 만료되었습니다');
	return json({ heartbeat: true });
};
