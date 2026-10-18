import type { PageServerLoad } from './$types';
import { cloudItems, cloudReports } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME, requireWorkerDatabase } from '$lib/server/runtime-target';

export const load: PageServerLoad = async ({ depends, platform }) => {
	depends('app:reports');
	depends('app:items');
	requireWorkerDatabase(platform, NODE_RUNTIME);

	const reports = platform?.env?.DB ? await cloudReports(platform.env) : NODE_RUNTIME ? (await import('$lib/server/report')).listReports() : [];
	const items = platform?.env?.DB ? await cloudItems(platform.env) : NODE_RUNTIME ? (await import('$lib/server/store')).listRecords() : [];

	let topics: string[] = [];
	try {
		if (platform?.env?.DB) topics = JSON.parse(platform.env.TAXONOMY_JSON ?? '{}').topics ?? [];
		else if (NODE_RUNTIME) topics = (await import('$lib/server/taxonomy')).loadTaxonomy().topics;
	} catch {
		topics = [...new Set(items.map((i) => i.analysis?.classification.topic).filter((x): x is string => !!x))];
	}

	return {
		reports,
		items,
		topics
	};
};
