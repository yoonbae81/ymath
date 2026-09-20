import { error } from '@sveltejs/kit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_FILE } from '$lib/server/image';
import { isValidId, itemDir } from '$lib/server/store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	if (!isValidId(params.id)) error(404);
	try {
		const image = readFileSync(join(itemDir(params.id), IMAGE_FILE));
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
};
