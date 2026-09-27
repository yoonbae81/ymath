import { settings, zaiApiKeySource } from '$lib/server/config';
import { listReports } from '$lib/server/report';
import { listRecords } from '$lib/server/store';
import type { ItemRecord, ReportRecord } from '$lib/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:status');

	// 작업상태는 최근 10일치(또는 아직 대기/진행 중인 작업)만 보여준다
	const cutoff = Date.now() - 10 * 86400_000;
	const isRecentOrActiveItem = (i: ItemRecord) =>
		new Date(i.created_at).getTime() >= cutoff ||
		i.status === 'queued' ||
		i.status === 'ocr' ||
		i.status === 'analyzing';

	const isRecentOrActiveReport = (r: ReportRecord) =>
		new Date(r.created_at).getTime() >= cutoff || r.status === 'queued' || r.status === 'generating';

	const items = listRecords().filter(isRecentOrActiveItem);
	const reports = listReports().filter(isRecentOrActiveReport);

	const stats = {
		total: items.length + reports.length,
		queued: items.filter((i) => i.status === 'queued').length + reports.filter((r) => r.status === 'queued').length,
		processing:
			items.filter((i) => i.status === 'ocr' || i.status === 'analyzing').length +
			reports.filter((r) => r.status === 'generating').length,
		done: items.filter((i) => i.status === 'done').length + reports.filter((r) => r.status === 'done').length,
		failed: items.filter((i) => i.status === 'failed').length + reports.filter((r) => r.status === 'failed').length,
		itemsTotal: items.length,
		reportsTotal: reports.length
	};

	return {
		items,
		reports,
		stats,
		/** 분석 설정 패널용. 실제 키 값은 노출하지 않고 어디서 왔는지만 알려 준다 */
		zai: { keySource: zaiApiKeySource(), model: settings().zaiModel, provider: settings().provider }
	};
};
