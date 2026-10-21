import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cloudItem, resolveS3 } from '$lib/server/cloudflare/runtime';
import { NODE_RUNTIME } from '$lib/server/runtime-target';

const isValidId = (id: string) => /^\d{8}-\d{6}-[a-z0-9]{4}$/.test(id);
export const GET: RequestHandler = async ({ params, platform }) => {
	if (!isValidId(params.id)) error(404);
	if (platform?.env?.DB) {
		const record = await cloudItem(platform.env, params.id);
		if (!record) error(404, '이미지를 찾을 수 없습니다');
		const row = await platform.env.DB.prepare("SELECT image_key FROM entities WHERE id = ? AND kind = 'item' AND deleted_at IS NULL")
			.bind(params.id).first<{ image_key: string | null }>();
		if (!row?.image_key) error(404, '이미지를 아직 처리하고 있습니다');
		const bytes = await resolveS3(platform.env).get(row.image_key);
		if (!bytes) error(503, '이미지 저장소에 연결할 수 없습니다');
		return new Response(bytes as BodyInit, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' } });
	}
	if (NODE_RUNTIME) try {
		const { readFileSync } = await import('node:fs');
		const { join } = await import('node:path');
		const { itemDir } = await import('$lib/server/store');
		const image = readFileSync(join(itemDir(params.id), 'image.jpg'));
		return new Response(image, {
			headers: {
				'content-type': 'image/jpeg',
				'cache-control': 'private, max-age=86400',
				'x-content-type-options': 'nosniff'
			}
		});
	} catch {
		error(404, '이미지를 찾을 수 없습니다');
	}
	error(503, '데이터베이스에 연결할 수 없습니다');
};
