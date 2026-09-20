import { loadWorkbooks } from '$lib/server/config';
import { listRecords } from '$lib/server/store';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:recent');
	const recent = listRecords()
		.slice(0, 6)
		.map((r) => ({
			id: r.id,
			status: r.status,
			workbook: r.workbook.name,
			created_at: r.created_at,
			asks: r.analysis?.asks ?? null
		}));
	return { workbooks: loadWorkbooks(), recent };
};
