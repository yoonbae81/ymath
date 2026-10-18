import type { PageServerLoad } from './$types';
import { cloudItems, workbooksFromEnv } from '$lib/server/cloudflare/runtime';
import { type Provider } from '$lib/types';
import { NODE_RUNTIME, requireWorkerDatabase } from '$lib/server/runtime-target';

export const load: PageServerLoad = async ({ depends, platform }) => {
	depends('app:items');
	requireWorkerDatabase(platform, NODE_RUNTIME);
	const items = platform?.env?.DB ? await cloudItems(platform.env) : NODE_RUNTIME ? (await import('$lib/server/store')).listRecords() : [];
	if (platform?.env?.DB) {
		let taxonomy: { topics?: string[]; concepts?: Record<string, string> } = {};
		try { taxonomy = JSON.parse(platform.env.TAXONOMY_JSON ?? '{}'); } catch { /* use stored topic fallback */ }
		const topics = taxonomy.topics ?? [...new Set(items.map((i) => i.analysis?.classification.topic).filter((x): x is string => !!x))];
		const defaultProvider: Provider = 'omlx';
		return { items, topics, concepts: taxonomy.concepts ?? {}, taxonomyError: null, workbooks: workbooksFromEnv(platform.env.WORKBOOKS_JSON), defaultProvider };
	}
	if (!NODE_RUNTIME) return { items, topics: [], concepts: {}, taxonomyError: '데이터베이스에 연결할 수 없습니다', workbooks: [], defaultProvider: 'omlx' as Provider };
	const config = await import('$lib/server/config');
	const { loadTaxonomy } = await import('$lib/server/taxonomy');

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
		workbooks: config.loadWorkbooks(),
		/** 재분석 때 기본으로 선택되는 LLM(ANALYZE_PROVIDER) */
		defaultProvider: config.settings().provider
	};
};
