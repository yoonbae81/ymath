import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { makeSliceApp } from '$lib/server/inngest-slice/app';
function sdk(event: Parameters<RequestHandler>[0]) {
	const env = event.platform?.env;
	if (!env?.DB || !env.INNGEST_SIGNING_KEY || !env.INNGEST_EVENT_KEY) error(503, 'Inngest is not configured');
	return makeSliceApp(env);
}
export const GET: RequestHandler = (event) => sdk(event).handler.GET(event);
export const POST: RequestHandler = (event) => sdk(event).handler.POST(event);
export const PUT: RequestHandler = (event) => sdk(event).handler.PUT(event);
