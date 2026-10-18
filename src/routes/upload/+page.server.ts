import type { PageServerLoad } from './$types';
import { cloudItems, workbooksFromEnv } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME, requireWorkerDatabase } from '$lib/server/runtime-target';

export const load: PageServerLoad = async ({ depends, platform }) => {
	depends('app:recent');
	requireWorkerDatabase(platform, NODE_RUNTIME);
	const records = platform?.env?.DB ? await cloudItems(platform.env) : NODE_RUNTIME ? (await import('$lib/server/store')).listRecords() : [];
	const recent = records
		.slice(0, 6)
		.map((r) => ({
			id: r.id,
			status: r.status,
			workbook: r.workbook.name,
			created_at: r.created_at,
			asks: r.analysis?.asks ?? null
		}));
	const workbooks = platform?.env?.DB ? workbooksFromEnv(platform.env.WORKBOOKS_JSON) : NODE_RUNTIME ? (await import('$lib/server/config')).loadWorkbooks() : [];
	return { workbooks, recent };
};
