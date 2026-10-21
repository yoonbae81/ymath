import { error, json } from '@sveltejs/kit';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import type { RequestHandler } from './$types';
import { acceptCloudItem, hasImageMagicBytes, readBoundedRequest, workbooksFromEnv } from '$lib/server/cloudflare/runtime';
import { assertItemBatonConfigured, publishItemOutboxDirect } from '$lib/server/cloudflare/item-publication';
import { NODE_RUNTIME } from '$lib/server/runtime-target';

/**
 * 사진을 바이너리 본문으로 받는다: `POST /api/upload?workbookId=<id>`, `Content-Type: image/*`.
 * multipart 를 쓰지 않는 이유: 폼 전송은 SvelteKit 의 Origin 검사를 받는데, adapter-node 는 ORIGIN 이 없으면
 * https 로 가정해 http://집서버IP 접속을 전부 막는다. 바이너리 본문은 그 검사 대상이 아니고 CORS 사전 요청으로 보호된다.
 */
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25MB (OWASP ASVS V5.2.1)

export const POST: RequestHandler = async ({ request, url, getClientAddress, platform }) => {
	requireAjax(request);
	const provider = url.searchParams.get('provider');
	if (provider !== null && provider !== 'omlx') error(400, 'Qwen(omlx)만 사용할 수 있습니다');
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	const type = request.headers.get('content-type') ?? '';
	if (type === 'image/svg+xml') error(415, 'SVG 이미지는 보안상 업로드할 수 없습니다');
	if (!type.startsWith('image/') && type !== 'application/octet-stream') error(415, '이미지 파일만 올릴 수 있습니다');

	const workbookId = url.searchParams.get('workbookId');
	if (!workbookId || typeof workbookId !== 'string') error(400, '문제집 ID 가 필요합니다');
	const workbookList = platform?.env?.DB ? workbooksFromEnv(platform.env.WORKBOOKS_JSON) : NODE_RUNTIME ? (await import('$lib/server/config')).loadWorkbooks() : error(503, '데이터베이스에 연결할 수 없습니다');
	const workbook = workbookList.find((w) => w.id === workbookId);
	if (!workbook) error(400, '알 수 없는 문제집입니다');

	let bytes: Uint8Array;
	try { bytes = await readBoundedRequest(request, MAX_UPLOAD_SIZE); }
	catch (e) { if (e instanceof RangeError) error(413, '업로드 가능한 최대 파일 크기는 25MB 입니다'); error(400, '사진을 읽을 수 없습니다'); }
	const body = bytes;
	if (body.length === 0) error(400, '사진이 없습니다');
	if (body.length > MAX_UPLOAD_SIZE) error(413, '업로드 가능한 최대 파일 크기는 25MB 입니다');
	if (platform?.env?.DB) {
		// The private raw object remains inaccessible to clients until it is validated and normalized (Node runner or Worker WASM path).
		if (!hasImageMagicBytes(body)) error(400, '이미지를 읽을 수 없거나 지원되지 않는 형식입니다');
		const key = request.headers.get('idempotency-key') ?? request.headers.get('x-idempotency-key') ?? '';
		if (!key) error(400, '요청 중복 방지 키가 필요합니다');
		try {
			assertItemBatonConfigured(platform.env);
			const accepted = await acceptCloudItem(platform.env, workbook, body, key);
			try { await publishItemOutboxDirect(platform.env); }
			catch (err) { console.error('[item outbox publish]', err); /* committed D1 outbox remains recoverable by the Connect recovery cron */ }
			return json({ id: accepted.id, status: 'queued' }, { status: accepted.created ? 201 : 200 });
		} catch (e) {
			if (e instanceof Error && (e.message.includes('binding is required') || e.message.includes('configuration is missing') || e.message.includes('must be a valid HTTPS') || e.message.includes('format is invalid'))) error(503, '분석 실행 구성이 완료되지 않아 접수할 수 없습니다');
			error(503, '사진을 저장하지 못했습니다. 다시 시도해 주세요');
		}
	}
	if (NODE_RUNTIME) {
		const { processImage } = await import('$lib/server/image');
		let processed;
		try { processed = await processImage(Buffer.from(body)); }
		catch { error(400, '이미지를 읽을 수 없거나 지원되지 않는 형식입니다'); }
		const { createItem, itemDir } = await import('$lib/server/store');
		const record = createItem(workbook);
		const dir = itemDir(record.id);
		(await import('node:fs')).writeFileSync((await import('node:path')).join(dir, record.image), processed);
		(await import('$lib/server/queue')).getQueue().enqueue(record.id);
		return json({ id: record.id, status: record.status }, { status: 201 });
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
