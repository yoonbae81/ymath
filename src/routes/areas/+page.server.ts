import { listReports } from '$lib/server/report';
import { listRecords } from '$lib/server/store';
import { loadTaxonomy } from '$lib/server/taxonomy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:reports');
	depends('app:items');

	const reports = listReports();
	const items = listRecords();

	let topics: string[] = [];
	try {
		const t = loadTaxonomy();
		topics = t.topics;
	} catch {
		topics = [...new Set(items.map((i) => i.analysis?.classification.topic).filter((x): x is string => !!x))];
	}

	return {
		reports,
		items,
		topics
	};
};
