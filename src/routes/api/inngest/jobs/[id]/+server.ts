import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createSliceStore } from '$lib/server/inngest-slice/store';

export const GET: RequestHandler = async ({ params, platform }) => {
	if (!platform?.env?.DB) error(503, 'D1 binding is unavailable');
	if (!/^slc_[0-9a-f-]{36}$/i.test(params.id)) error(404, 'Job not found');
	const job = await createSliceStore(platform.env.DB).get(params.id);
	if (job.status === 'missing') error(404, 'Job not found');
	return json({ jobId: job.id, status: job.status, generation: job.generation, result: job.status === 'done' ? job.result_text : null, error: job.status === 'failed' || job.status === 'publish_failed' ? job.last_error : null });
};
