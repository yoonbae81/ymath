import { json } from '@sveltejs/kit';
import type { SliceJob } from './store';

interface Store {
	create(input: string, kind: 'text'|'report'): Promise<string>;
	get(id: string): Promise<SliceJob>;
	markPublishFailed(id: string, reason: string): Promise<void>;
}
export function createSliceSubmission(options: { store: Store; send: (id: string, generation: number) => Promise<unknown>; configured: boolean }) {
	return async (request: Request): Promise<Response> => {
		if (!options.configured) return json({ error: 'Inngest or inference configuration is not ready' }, { status: 503 });
		let body: unknown;
		try {
			const declared = Number(request.headers.get('content-length'));
			if (Number.isFinite(declared) && declared > 25_000) return json({ error: 'Request body too large' }, { status: 413 });
			if (!request.body) return json({ error: 'Invalid JSON body' }, { status: 400 });
			const reader = request.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > 25_000) { await reader.cancel(); return json({ error: 'Request body too large' }, { status: 413 }); }
				chunks.push(value);
			}
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
			body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
		} catch { return json({ error: 'Invalid JSON body' }, { status: 400 }); }
		const input = body && typeof body === 'object' ? (body as {text?: unknown}).text : undefined;
		if (typeof input !== 'string' || input.trim().length < 1 || input.length > 20_000) return json({ error: 'text must contain 1 to 20000 characters' }, { status: 400 });
		const kind = (body as {kind?: unknown}).kind ?? 'text';
		if (kind !== 'text' && kind !== 'report') return json({ error: 'kind must be text or report' }, { status: 400 });
		const jobId = await options.store.create(input.trim(), kind);
		try {
			await options.send(jobId, 1);
			return json({ jobId, status: 'queued' }, { status: 202 });
		} catch {
			await options.store.markPublishFailed(jobId, 'Inngest event publish failed');
			return json({ jobId, status: 'publish_failed', error: 'Inngest event publish failed' }, { status: 502 });
		}
	};
}
