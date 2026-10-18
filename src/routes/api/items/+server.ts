import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cloudItems } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME } from '$lib/server/runtime-target';

export const GET: RequestHandler = async ({ platform }) => {
	if (platform?.env?.DB) return json({ items: await cloudItems(platform.env) });
	if (NODE_RUNTIME) return json({ items: (await import('$lib/server/store')).listRecords() });
	return json({ message: '데이터베이스에 연결할 수 없습니다' }, { status: 503 });
};
