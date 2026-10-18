import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeSliceApp, validateInferenceConfig } from '$lib/server/inngest-slice/app';
import { createSliceSubmission } from '$lib/server/inngest-slice/submit';
export const POST: RequestHandler = (event) => {
	const env = event.platform?.env;
	if (!env?.DB) error(503, 'D1 binding is unavailable');
	let configured = true;
	try { validateInferenceConfig(env); } catch { configured = false; }
	if (!configured) return json({ error: 'Inngest or inference configuration is not ready' }, { status: 503 });
	const app = makeSliceApp(env);
	return createSliceSubmission({
		store: app.store,
		configured: true,
		send: (jobId, generation) => app.client.send({ name: 'ymath/slice.requested', data: { jobId, generation } })
	})(event.request);
};
