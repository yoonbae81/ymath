import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { persistCloudNormalizedImage } from '$lib/server/cloudflare/runtime';
import { runnerAuthorized } from '$lib/server/cloudflare/runner-auth';

export const POST: RequestHandler = async ({ request, params, platform }) => {
	if (!platform?.env?.DB || !runnerAuthorized(request, platform.env.RUNNER_TOKEN)) error(401, '실행기 인증이 필요합니다');
	const form = await request.formData().catch(() => null);
	const rawJob = form?.get('job');
	const image = form?.get('image');
	const job = typeof rawJob === 'string' ? JSON.parse(rawJob) as { id: string; entity_id: string; kind: 'item' | 'report'; generation: number; entity_generation: number; lease_token: string; payload: string } : null;
	const token = request.headers.get('x-lease-token') ?? '';
	if (!job || !(image instanceof File) || job.id !== params.id || job.lease_token !== token || job.kind !== 'item') error(400, '잘못된 작업 lease입니다');
	const jpeg = new Uint8Array(await image.arrayBuffer());
	if (jpeg.length < 12 || jpeg.length > 25 * 1024 * 1024 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff) error(415, '정규화된 JPEG가 아닙니다');
	if (!(await persistCloudNormalizedImage(platform.env, job, token, jpeg))) error(409, '작업 lease가 만료되었거나 항목이 삭제되었습니다');
	return json({ persisted: true });
};
