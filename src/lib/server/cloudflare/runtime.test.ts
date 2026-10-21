import { describe, expect, it } from 'vitest';
import { acceptCloudItem, cloudItem, cloudItems, readBoundedRequest, type CloudflareEnv } from './runtime';
import type { S3Store } from './s3-store';

function fixtureEnv(s3?: Partial<S3Store>) {
	const stored = new Map<string, Uint8Array>();
	const sql: string[] = [];
	let entity: { id: string; record_json: string } | null = null;
	const store: S3Store = {
		async put(key: string, value: Uint8Array) { stored.set(key, value); },
		async get(key: string) { return stored.get(key) ?? null; },
		async delete(key: string) { stored.delete(key); },
		...s3
	};
	const env = {
		S3: store,
		DB: {
			prepare(query: string) {
				sql.push(query);
				return { bind() { return this; }, async first() { return entity; }, async all() { return { results: entity ? [entity] : [] }; }, async run() { return { meta: { changes: 1 } }; } };
			},
			async batch() { return []; }
		}
	} as unknown as CloudflareEnv;
	return { env, stored, sql, setEntity(value: { id: string; record_json: string } | null) { entity = value; } };
}

describe('Cloudflare storage runtime', () => {
	it('fails closed without S3 configuration before writing storage or D1', async () => {
		const f = fixtureEnv();
		delete (f.env as { S3?: unknown }).S3;
		await expect(acceptCloudItem(f.env, {} as never, new Uint8Array([1]), 'missing-s3')).rejects.toThrow(/S3_/);
		expect(f.stored.size).toBe(0);
		expect(f.sql).toEqual([]);
	});
	it('writes raw uploads privately before durable item/job acceptance and removes orphan on failure', async () => {
		const f = fixtureEnv();
		const result = await acceptCloudItem(f.env, { id: 'w', name: 'Workbook', publisher: 'P', grade: '중1', semester: 1 } as never, new Uint8Array([1, 2, 3]), 'request-1');
		expect(result.created).toBe(true);
		expect(f.stored.size).toBe(1);
		expect([...f.stored.keys()][0]).toMatch(/^items\/raw\//);
		expect(f.sql.join(' ')).toContain('INSERT INTO entities');
	});

	it('reads only live records from D1 and parses the existing record shape', async () => {
		const f = fixtureEnv();
		const record = { id: '20260101-000000-abcd', status: 'queued' };
		f.setEntity({ id: record.id, record_json: JSON.stringify(record) });
		expect(await cloudItem(f.env, record.id)).toMatchObject({ ...record, favorite: false, feedback: [] });
		expect(await cloudItems(f.env)).toHaveLength(1);
		expect(f.sql.filter((q) => q.includes('FROM entities')).every((q) => q.includes('deleted_at IS NULL'))).toBe(true);
	});

	it('enforces upload byte limits while consuming the request stream', async () => {
		const request = new Request('http://local/upload', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
		await expect(readBoundedRequest(request, 2)).rejects.toThrow(RangeError);
	});
});
