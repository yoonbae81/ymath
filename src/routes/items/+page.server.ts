import { loadWorkbooks, settings } from '$lib/server/config';
import { listRecords } from '$lib/server/store';
import { loadTaxonomy } from '$lib/server/taxonomy';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:items');
	const items = listRecords();

	// curriculum.md 가 깨져 있어도 결과 목록은 볼 수 있어야 한다
	let topics: string[] = [];
	let concepts: Record<string, string> = {};
	let taxonomyError: string | null = null;
	try {
		const t = loadTaxonomy();
		topics = t.topics;
		concepts = Object.fromEntries([...t.conceptById.values()].map((c) => [c.id, c.desc]));
	} catch (e) {
		taxonomyError = e instanceof Error ? e.message : String(e);
		topics = [...new Set(items.map((i) => i.analysis?.classification.topic).filter((x): x is string => !!x))];
	}
	return {
		items,
		topics,
		concepts,
		taxonomyError,
		workbooks: loadWorkbooks(),
		/** 재분석 때 기본으로 선택되는 LLM(ANALYZE_PROVIDER) */
		defaultProvider: settings().provider
	};
};
