import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { PROVIDERS, type Provider } from '$lib/types';
import { batonDefaultProvider, batonCatalog } from '$lib/server/cloudflare/baton-catalog';
import type { RequestHandler } from './$types';
import { cloudItem, queueCloudReanalysis } from '$lib/server/cloudflare/runtime';
import { assertItemBatonConfigured, publishItemOutboxDirect } from '$lib/server/cloudflare/item-publication';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);

/** 재분석. 카탈로그(provider)에서 선택한 LLM 을 사용한다. 생략 시 default. */
export const POST: RequestHandler = async ({ params, request, url, getClientAddress, platform }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const wanted = url.searchParams.get('provider');
	if (wanted !== null && !PROVIDERS.includes(wanted as Provider)) error(400, `알 수 없는 LLM 입니다: ${wanted}`);
	const selectedProvider = wanted ?? batonDefaultProvider;
	let record;
	if (platform?.env?.DB) record = await cloudItem(platform.env, params.id);
	else if (NODE_RUNTIME) record = (await import('$lib/server/store')).readRecord(params.id);
	else error(503, '데이터베이스에 연결할 수 없습니다');
	if (!record) error(404, '항목을 찾을 수 없습니다');
	if (record.status !== 'done' && record.status !== 'failed') error(409, '이미 분석 대기 중이거나 진행 중입니다');
	if (platform?.env?.DB) {
		assertItemBatonConfigured(platform.env);
		if (!(await queueCloudReanalysis(platform.env, params.id, selectedProvider))) error(409, '항목이 이미 변경되었습니다');
		try { await publishItemOutboxDirect(platform.env); }
		catch (err) { console.error('[item outbox publish]', err); /* committed D1 outbox remains recoverable by the Connect recovery cron */ }
		return json({ id: params.id, status: 'queued', provider: selectedProvider }, { status: 202 });
	}
	if (NODE_RUNTIME) {
		const { updateRecord } = await import('$lib/server/store');
		updateRecord(params.id, (r) => {
			r.status = 'queued';
			r.error = null;
			r.attempts = 0;
			r.requested_provider = selectedProvider;
		});
		(await import('$lib/server/queue')).getQueue().enqueue(params.id);
		return json({ id: params.id, status: 'queued', provider: selectedProvider }, { status: 202 });
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
