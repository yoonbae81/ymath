import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { claimInngestReport, markInngestReportFailed } from './inngest-report-store';
import type { D1DatabaseLike } from './jobs';
import { commitInngestReportResult, type CloudflareEnv } from './runtime';

function dbFixture() {
	const sql = new DatabaseSync(':memory:');
	sql.exec(readFileSync(new URL('../../../../migrations/0001_initial.sql', import.meta.url), 'utf8'));
	sql.exec(readFileSync(new URL('../../../../migrations/0002_jobs_provider_lease.sql', import.meta.url), 'utf8'));
	sql.exec(readFileSync(new URL('../../../../migrations/0003_item_ocr.sql', import.meta.url), 'utf8'));
		sql.exec(readFileSync(new URL('../../../../migrations/0005_report_outbox.sql', import.meta.url), 'utf8'));
		sql.exec(readFileSync(new URL('../../../../migrations/0006_inngest_report_owner.sql', import.meta.url), 'utf8'));
	const report = { schema_version: 1, id: '20261017-080000-rep-abcd', created_at: '2026-10-17T08:00:00Z', topic: '대수', period: '2026-10', period_label: '2026-10', status: 'queued', error: null, attempts: 0, item_ids: [], items_fingerprint: '', summary: null, markdown: null, meta: null };
	sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,updated_at) VALUES(?,'report',?,'queued',1,?,?)").run(report.id, report.created_at, JSON.stringify(report), report.created_at);
	sql.prepare("INSERT INTO report_outbox(report_id,generation,state,created_at,updated_at) VALUES(?,1,'sent',?,?)").run(report.id, report.created_at, report.created_at);
	const DB = { prepare(query: string) { return { values: [] as SQLInputValue[], bind(...values: unknown[]) { this.values = values as SQLInputValue[]; return this; }, async first<T>() { return (sql.prepare(query).get(...this.values) as T | undefined) ?? null; }, async all<T>() { return { results: sql.prepare(query).all(...this.values) as T[] }; }, async run() { const result = sql.prepare(query).run(...this.values); return { meta: { changes: Number(result.changes) } }; } }; } } as unknown as D1DatabaseLike;
	return { sql, DB, id: report.id };
}

describe('Inngest application report generation fencing', () => {
	it('claims a queued report once for its live generation and records terminal SDK failure only for that generation', async () => {
		const { sql, DB, id } = dbFixture();
		const claimed = await claimInngestReport(DB, id, 1, 'run-A', '2026-10-17T09:00:00.000Z');
		expect(claimed).toMatchObject({ id, status: 'generating', attempts: 1 });
		expect(await claimInngestReport(DB, id, 1, 'run-B')).toBeNull();
		expect(await claimInngestReport(DB, id, 1, 'run-A')).toMatchObject({ id, status: 'generating', attempts: 1 });
		sql.prepare("UPDATE entities SET generation=2,status='queued',report_json=json_set(report_json,'$.status','queued') WHERE id=?").run(id);
		expect(await markInngestReportFailed(DB, id, 1, 'stale failure', undefined, 'run-B')).toBe(false);
		expect(await markInngestReportFailed(DB, id, 2, 'terminal provider failure', undefined, 'run-A')).toBe(true);
		expect(JSON.parse((sql.prepare('SELECT report_json FROM entities WHERE id=?').get(id) as { report_json: string }).report_json)).toMatchObject({ status: 'failed', error: 'terminal provider failure' });
		sql.prepare("UPDATE entities SET status='done' WHERE id=?").run(id);
		expect(await markInngestReportFailed(DB, id, 2, 'late terminal callback', undefined, 'run-A')).toBe(false);
	});
	it('propagates R2 storage failure for SDK retry and removes an unreferenced staged key', async () => {
		const { sql, DB, id } = dbFixture();
		const claimed = await claimInngestReport(DB, id, 1, 'run-A', '2026-10-17T09:00:00.000Z');
		const removed: string[] = [];
		const env = { DB, OBJECTS: { async put() { throw new Error('SYNTHETIC R2 storage failure'); }, async get() { return null; }, async delete(key: string) { removed.push(key); } } } as unknown as CloudflareEnv;
		await expect(commitInngestReportResult(env, 1, { ...claimed!, status: 'done', markdown: 'Synthetic complete Markdown.', summary: null, meta: { model: 'synthetic-model', prompt_version: 'fixture', generated_at: '2026-10-17T09:00:00.000Z' } }, 'run-A')).rejects.toThrow('SYNTHETIC R2 storage failure');
		expect(removed).toHaveLength(1);
		expect(removed[0]).toMatch(new RegExp(`^reports/${id}/result-inngest-1-.*\\.json$`));
		expect(sql.prepare('SELECT status FROM entities WHERE id=?').get(id)).toMatchObject({ status: 'generating' });
	});
	it('keeps the winner artifact immutable under concurrent save attempts and accepts committed replay', async () => {
		const { DB, id } = dbFixture();
		const claimed = await claimInngestReport(DB, id, 1, 'run-A');
		const objects = new Map<string, string>();
		let puts = 0; let release!: () => void;
		const bothPuts = new Promise<void>((resolve) => { release = resolve; });
		const env = { DB, OBJECTS: { async put(key: string, body: ArrayBuffer | ArrayBufferView | string) { objects.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body as ArrayBufferView)); puts++; if (puts === 2) release(); await bothPuts; }, async get(key: string) { const value = objects.get(key); return value ? { text: async () => value, json: async () => JSON.parse(value), body: null, httpMetadata: {}, customMetadata: {}, size: value.length, etag: 'x', uploaded: new Date(), writeHttpMetadata() {} } : null; }, async delete(key: string) { objects.delete(key); } } } as unknown as CloudflareEnv;
		const result = { ...claimed!, status: 'done' as const, markdown: 'winner markdown', summary: null, meta: { model: 'synthetic-model', prompt_version: 'fixture', generated_at: '2026-10-17T09:00:00.000Z' } };
		const [committed, duplicate] = await Promise.all([commitInngestReportResult(env, 1, result, 'run-A'), commitInngestReportResult(env, 1, { ...result, markdown: 'loser markdown' }, 'run-A')]);
		expect([committed, duplicate].filter(Boolean)).toHaveLength(1);
		const row = DB.prepare("SELECT report_key FROM entities WHERE id=?").bind(id);
		const winner = await row.first<{report_key:string}>();
		const winningMarkdown = objects.get(winner!.report_key)!.includes('winner markdown') ? 'winner markdown' : 'loser markdown';
		const winningResult = { ...result, markdown: winningMarkdown };
		const replay = await commitInngestReportResult(env, 1, winningResult, 'run-A');
		expect(replay).toBe(true);
		expect(await commitInngestReportResult(env, 1, { ...winningResult, markdown: 'late overwritten replay' }, 'run-A')).toBe(false);
		expect(objects.get(winner!.report_key)).toContain(winningMarkdown);
		expect([...objects.keys()]).toHaveLength(1);
	});
	it('recovers a lost committed claim response and allows its same SDK run to continue after transient reads', async () => {
		const { DB, id } = dbFixture(); let lost = true;
		const flaky = { prepare(query: string) { const original = DB.prepare(query); return { bind(...values: unknown[]) { original.bind(...values); return this; }, async first<T>() { const value = await original.first<T>(); if (query.includes("UPDATE entities SET status='generating'") && lost) { lost = false; throw new Error('synthetic committed claim response lost'); } return value; }, async all<T>() { return original.all<T>(); }, async run() { return original.run(); } }; } } as unknown as D1DatabaseLike;
		await expect(claimInngestReport(flaky, id, 1, 'sdk-run-1')).rejects.toThrow('synthetic committed claim response lost');
		let transient = true;
		const load = async () => { if (transient) { transient = false; throw new Error('synthetic cloudItems transient failure'); } return 'report prompt ready'; };
		await expect(load()).rejects.toThrow('synthetic cloudItems transient failure');
		expect(await claimInngestReport(flaky, id, 1, 'sdk-run-1')).toMatchObject({ status: 'generating', attempts: 1 });
		expect(await load()).toBe('report prompt ready');
		expect(await claimInngestReport(flaky, id, 1, 'different-sdk-run')).toBeNull();
	});
	it('recognizes a lost D1 commit response by owner and preserves staged objects if authoritative reads fail', async () => {
		const { DB, id } = dbFixture();
		const claimed = await claimInngestReport(DB, id, 1, 'run-A');
		const objects = new Map<string, string>(); let loseCommitAck = true; let objectWrites = 0;
		const flaky = { prepare(query: string) { const original = DB.prepare(query); return { bind(...values: unknown[]) { original.bind(...values); return this; }, async first<T>() { return original.first<T>(); }, async all<T>() { return original.all<T>(); }, async run() { const result = await original.run(); if (query.includes("SET status='done'") && loseCommitAck) { loseCommitAck = false; throw new Error('synthetic committed report response lost'); } return result; } }; } } as unknown as D1DatabaseLike;
		const env = { DB: flaky, OBJECTS: { async put(key: string, body: ArrayBuffer | ArrayBufferView | string) { objectWrites++; objects.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body as ArrayBufferView)); }, async get(key: string) { const value = objects.get(key); return value ? { body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(value)); controller.close(); } }) } : null; }, async delete(key: string) { objects.delete(key); } } } as unknown as CloudflareEnv;
		const done = { ...claimed!, status: 'done' as const, markdown: 'committed Markdown', summary: null, meta: { model: 'synthetic-model', prompt_version: 'fixture', generated_at: '2026-10-17T09:00:00.000Z' } };
		expect(await commitInngestReportResult(env, 1, done, 'run-A')).toBe(true);
		const storedArtifact = [...objects];
		expect(await commitInngestReportResult(env, 1, done, 'run-A')).toBe(true);
		expect(objectWrites).toBe(1);
		// SDK can lose the save-step acknowledgement after the committed write.
		// Re-running normalization generates a later timestamp, not a new result.
		expect(await commitInngestReportResult(env, 1, { ...done, meta: { ...done.meta, generated_at: '2026-10-17T09:00:10.000Z' } }, 'run-A')).toBe(true);
		expect(objectWrites).toBe(1);
		expect([...objects]).toEqual(storedArtifact);
		const ambiguous = dbFixture(); const pending = await claimInngestReport(ambiguous.DB, ambiguous.id, 1, 'run-B');
		const staged = new Map<string, string>();
		const uncertain = { DB: { prepare(query: string) { if (query.startsWith('SELECT generation,status')) throw new Error('synthetic authoritative D1 read failure'); const statement = ambiguous.DB.prepare(query); if (query.includes("SET status='done'")) return { bind(...values: unknown[]) { statement.bind(...values); return this; }, first: <T>() => statement.first<T>(), all: <T>() => statement.all<T>(), async run() { throw new Error('synthetic ambiguous D1 write'); } }; return statement; } }, OBJECTS: { async put(key: string, body: ArrayBuffer | ArrayBufferView | string) { staged.set(key, typeof body === 'string' ? body : new TextDecoder().decode(body as ArrayBufferView)); }, async get() { return null; }, async delete(key: string) { staged.delete(key); } } } as unknown as CloudflareEnv;
		await expect(commitInngestReportResult(uncertain, 1, { ...pending!, status: 'done', markdown: 'ambiguous staged Markdown', summary: null, meta: { model: 'synthetic-model', prompt_version: 'fixture', generated_at: '2026-10-17T09:00:02.000Z' } }, 'run-B')).rejects.toThrow('synthetic ambiguous D1 write');
		expect(staged.size).toBe(1);
	});
});
