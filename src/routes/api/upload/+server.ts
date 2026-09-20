import { error, json } from '@sveltejs/kit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadWorkbooks } from '$lib/server/config';
import { requireAjax, requireMutationRate } from '$lib/server/guard';
import { processImage } from '$lib/server/image';
import { getQueue } from '$lib/server/queue';
import { createItem, itemDir } from '$lib/server/store';
import type { RequestHandler } from './$types';

/**
 * 사진을 바이너리 본문으로 받는다: `POST /api/upload?workbookId=<id>`, `Content-Type: image/*`.
 * multipart 를 쓰지 않는 이유: 폼 전송은 SvelteKit 의 Origin 검사를 받는데, adapter-node 는 ORIGIN 이 없으면
 * https 로 가정해 http://집서버IP 접속을 전부 막는다. 바이너리 본문은 그 검사 대상이 아니고 CORS 사전 요청으로 보호된다.
 */
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024; // 25MB (OWASP ASVS V5.2.1)

export const POST: RequestHandler = async ({ request, url, getClientAddress }) => {
	requireAjax(request);
	// OWASP ASVS V2.4.1: 상태 변경 API 속도 제한(IP 당)
	requireMutationRate(getClientAddress, request);
	const type = request.headers.get('content-type') ?? '';
	if (type === 'image/svg+xml') error(415, 'SVG 이미지는 보안상 업로드할 수 없습니다');
	if (!type.startsWith('image/') && type !== 'application/octet-stream') error(415, '이미지 파일만 올릴 수 있습니다');

	const workbookId = url.searchParams.get('workbookId');
	if (!workbookId || typeof workbookId !== 'string') error(400, '문제집 ID 가 필요합니다');
	const workbook = loadWorkbooks().find((w) => w.id === workbookId);
	if (!workbook) error(400, '알 수 없는 문제집입니다');

	const body = Buffer.from(await request.arrayBuffer());
	if (body.length === 0) error(400, '사진이 없습니다');
	if (body.length > MAX_UPLOAD_SIZE) error(413, '업로드 가능한 최대 파일 크기는 25MB 입니다');

	// 이미지 처리가 실패하면 항목을 만들기 전에 거절한다(빈 폴더가 남지 않도록)
	let processed;
	try {
		processed = await processImage(body);
	} catch {
		error(400, '이미지를 읽을 수 없거나 지원되지 않는 형식입니다');
	}

	const record = createItem(workbook);
	const dir = itemDir(record.id);
	writeFileSync(join(dir, record.image), processed);
	getQueue().enqueue(record.id);

	return json({ id: record.id, status: record.status }, { status: 201 });
};
