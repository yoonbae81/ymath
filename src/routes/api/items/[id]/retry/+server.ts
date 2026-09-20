import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { getQueue } from '$lib/server/queue';
import { isValidId, readRecord, updateRecord } from '$lib/server/store';
import { PROVIDERS, type Provider } from '$lib/types';
import type { RequestHandler } from './$types';

/** 재분석. `?provider=claude|codex` 로 이번에 쓸 LLM 을 고를 수 있다. 기존 분석 결과는 새 결과로 바뀔 때까지 남겨 둔다. */
export const POST: RequestHandler = ({ params, request, url, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	if (!isValidId(params.id)) error(400, '잘못된 항목 ID 형식입니다');
	const wanted = url.searchParams.get('provider');
	if (wanted !== null && !PROVIDERS.includes(wanted as Provider)) error(400, `알 수 없는 LLM 입니다: ${wanted}`);
	const record = readRecord(params.id);
	if (!record) error(404, '항목을 찾을 수 없습니다');
	if (record.status !== 'done' && record.status !== 'failed') error(409, '이미 분석 대기 중이거나 진행 중입니다');
	updateRecord(params.id, (r) => {
		r.status = 'queued';
		r.error = null;
		r.attempts = 0;
		if (wanted) r.requested_provider = wanted as Provider;
	});
	getQueue().enqueue(params.id);
	return json({ id: params.id, status: 'queued' }, { status: 202 });
};
