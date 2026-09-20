import { json } from '@sveltejs/kit';
import { listRecords } from '$lib/server/store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => json({ items: listRecords() });
