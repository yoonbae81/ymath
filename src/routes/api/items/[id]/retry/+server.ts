import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { PROVIDERS, REQUEST_NOTE_MAX, type Provider } from '$lib/types';
import { batonDefaultProvider, batonCatalog } from '$lib/server/cloudflare/baton-catalog';
import type { RequestHandler } from './$types';
import { cloudItem, queueCloudReanalysis } from '$lib/server/cloudflare/runtime';
import { assertItemBatonConfigured, publishItemOutboxDirect } from '$lib/server/cloudflare/item-publication';
import { NODE_RUNTIME } from '$lib/server/runtime-target';
import { settings } from '$lib/server/config';
const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);

/** 재분석 요청 때 덧붙일 코멘트. 제어 문자는 빼고 길이를 자른다(프롬프트에 데이터로 들어간다) */
const cleanNote = (raw: unknown): string => {
	if (raw === undefined || raw === null) return '';
	if (typeof raw !== 'string') error(400, '코멘트는 글자여야 합니다');
	return raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim().slice(0, REQUEST_NOTE_MAX);
};

/** 재분석. 카탈로그(provider)에서 선택한 LLM 을 사용한다. 생략 시 default.
 * 본문 { comment } 로 분석 프롬프트에 덧붙일 사용자 코멘트를 보낼 수 있다(없으면 이전 코멘트를 지운다). */
export const POST: RequestHandler = async ({ params, request, url, getClientAddress, platform }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const wanted = url.searchParams.get('provider');
	if (wanted !== null && !PROVIDERS.includes(wanted as Provider)) error(400, `알 수 없는 LLM 입니다: ${wanted}`);
	// node 런타임 기본값은 설정(providers.json 의 agy 항목 여부)을 따르고, baton(cloud) 기본값은 카탈로그를 따른다
	const selectedProvider = wanted ?? (NODE_RUNTIME ? settings().provider : batonDefaultProvider);
	const note = cleanNote(((await request.json().catch(() => null)) as { comment?: unknown } | null)?.comment);
	let record;
	if (platform?.env?.DB) record = await cloudItem(platform.env, params.id);
	else if (NODE_RUNTIME) record = (await import('$lib/server/store')).readRecord(params.id);
	else error(503, '데이터베이스에 연결할 수 없습니다');
	if (!record) error(404, '항목을 찾을 수 없습니다');
	if (record.status !== 'done' && record.status !== 'failed') error(409, '이미 분석 대기 중이거나 진행 중입니다');
	if (platform?.env?.DB) {
		assertItemBatonConfigured(platform.env);
		if (!(await queueCloudReanalysis(platform.env, params.id, selectedProvider, note))) error(409, '항목이 이미 변경되었습니다');
		try { await publishItemOutboxDirect(platform.env); }
		catch (err) { console.error('[item outbox publish]', err); /* committed D1 outbox remains recoverable by the Connect recovery cron */ }
		return json({ id: params.id, status: 'queued', provider: selectedProvider, comment: note }, { status: 202 });
	}
	if (NODE_RUNTIME) {
		const { updateRecord } = await import('$lib/server/store');
		updateRecord(params.id, (r) => {
			r.status = 'queued';
			r.error = null;
			r.attempts = 0;
			r.requested_provider = selectedProvider;
			if (note) r.request_note = note;
			else delete r.request_note;
		});
		(await import('$lib/server/queue')).getQueue().enqueue(params.id);
		return json({ id: params.id, status: 'queued', provider: selectedProvider, comment: note }, { status: 202 });
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
