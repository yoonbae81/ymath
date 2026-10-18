import { describe, expect, it } from 'vitest';
import { handle } from './hooks.server';

function event(path: string, method = 'GET', headers: HeadersInit = {}) {
	return {
		url: new URL(`https://family.example/math${path}`), request: new Request(`https://family.example/math${path}`, { method, headers }),
		locals: {}, cookies: {}, platform: { env: { DB: {} } }, getClientAddress: () => '127.0.0.1'
	} as never;
}

describe('anonymous family app boundary', () => {
	it('serves app pages without cookies, password, or Access headers', async () => {
		let reached = false;
		const response = await handle({ event: event('/items'), resolve: async () => { reached = true; return new Response('ok'); } } as never);
		expect(reached).toBe(true);
		expect(response.status).toBe(200);
	});

	it('requires the custom CSRF header for app mutations', async () => {
		const blocked = await handle({ event: event('/api/items/123/favorite', 'POST'), resolve: async () => new Response('unexpected') } as never);
		expect(blocked.status).toBe(403);
		const accepted = await handle({ event: event('/api/items/123/favorite', 'POST', { 'x-requested-with': 'ymath', origin: 'https://family.example' }), resolve: async () => new Response('ok') } as never);
		expect(accepted.status).toBe(503); // authenticated app mutation reaches the configured D1 rate limit boundary
	});

	it('exempts only the exact Inngest SDK endpoint from the app AJAX gate', async () => {
		const sdk = await handle({ event: event('/api/inngest', 'POST'), resolve: async () => new Response('sdk') } as never);
		expect(sdk.status).toBe(200); // exact SDK path reaches the endpoint without AJAX headers.
		for (const path of ['/api/inngest/submit', '/api/inngest/jobs/123']) {
			const blocked = await handle({ event: event(path, 'POST'), resolve: async () => new Response('unexpected') } as never);
			expect(blocked.status).toBe(403);
		}
	});

	it('retires old login, logout, share, and share-link routes with 410', async () => {
		for (const path of ['/login', '/api/login', '/api/logout', '/api/share', '/s/old-token']) {
			const response = await handle({ event: event(path), resolve: async () => new Response('unexpected') } as never);
			expect(response.status).toBe(410);
		}
	});
});
