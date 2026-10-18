import type { ItemRecord, ReportRecord } from '$lib/types';
import type { PageServerLoad } from './$types';
import { cloudItems, cloudReports } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME, requireWorkerDatabase } from '$lib/server/runtime-target';

export const load: PageServerLoad = async ({ depends, platform }) => {
	depends('app:status');
	requireWorkerDatabase(platform, NODE_RUNTIME);

	// 작업상태는 최근 10일치(또는 아직 대기/진행 중인 작업)만 보여준다
	const cutoff = Date.now() - 10 * 86400_000;
	const isRecentOrActiveItem = (i: ItemRecord) =>
		new Date(i.created_at).getTime() >= cutoff ||
		i.status === 'queued' ||
		i.status === 'ocr' ||
		i.status === 'analyzing';

	const isRecentOrActiveReport = (r: ReportRecord) =>
		new Date(r.created_at).getTime() >= cutoff || r.status === 'queued' || r.status === 'generating';

	let items: ItemRecord[] = [];
	let reports: ReportRecord[] = [];
	let loadError: 'storage' | null = null;
	try {
		items = (platform?.env?.DB ? await cloudItems(platform.env) : NODE_RUNTIME ? (await import('$lib/server/store')).listRecords() : []).filter(isRecentOrActiveItem);
		reports = (platform?.env?.DB ? await cloudReports(platform.env, false) : NODE_RUNTIME ? (await import('$lib/server/report')).listReports() : []).filter(isRecentOrActiveReport);
	} catch (e) {
		loadError = 'storage';
		console.error('[status load] storage refresh failed', e instanceof Error ? e.message : 'unknown error');
	}

	const stats = {
		total: items.length + reports.length,
		queued: items.filter((i) => i.status === 'queued').length + reports.filter((r) => r.status === 'queued').length,
		processing:
			items.filter((i) => i.status === 'ocr' || i.status === 'analyzing').length +
			reports.filter((r) => r.status === 'generating').length,
		done: items.filter((i) => i.status === 'done').length + reports.filter((r) => r.status === 'done').length,
		failed: items.filter((i) => i.status === 'failed').length + reports.filter((r) => r.status === 'failed').length,
		itemsTotal: items.length,
		reportsTotal: reports.length,
		loadError
	};

	return {
		items,
		reports,
		stats,
		loadError
	};
};
