import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { POST as upload } from '../../../routes/api/upload/+server';
import { POST as retry } from '../../../routes/api/items/[id]/retry/+server';
import type { CloudflareEnv } from './runtime';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.unstubAllGlobals(); cleanup.splice(0).forEach((fn) => fn()); });

function fixture() {
  const sql = new DatabaseSync(':memory:');
  cleanup.push(() => sql.close());
  for (const name of readdirSync(new URL('../../../../migrations/', import.meta.url)).filter((s) => s.endsWith('.sql')).sort()) {
    sql.exec(readFileSync(new URL(`../../../../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const DB = {prepare(query: string) {
    const stmt = sql.prepare(query);
    let args: SQLInputValue[] = [];
    const wrapped = {
      bind(...values: unknown[]) { args = values as SQLInputValue[]; return wrapped; },
      async first<T>() { return (stmt.get(...args) as T | undefined) ?? null; },
      async all<T>() { return {results: stmt.all(...args) as T[]}; },
      async run() { return {meta: {changes: Number(stmt.run(...args).changes)}}; }
    };
    return wrapped;
  }, async batch(statements: Array<{run(): Promise<unknown>}>) {
    sql.exec('BEGIN');
    try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sql.exec('COMMIT'); return results; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  }};
  const objects = new Map<string, Uint8Array>();
  const env = {
    DB, S3: {
      async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
      async get(key: string) { return objects.get(key) ?? null; },
      async delete(key: string) { objects.delete(key); }
    },
    ITEM_ANALYSIS_BACKEND: 'baton', INNGEST_EVENT_KEY: 'fixture-event-key', RUNNER_TOKEN: 'fixture-token',
    S3_ENDPOINT: 'https://s3.example.test', S3_BUCKET: 'fixture-bucket',
    S3_ACCESS_KEY_ID: 'fixture-access', S3_SECRET_ACCESS_KEY: 'fixture-secret',
    WORKBOOKS_JSON: JSON.stringify({workbooks: [{id: 'fixture-wb', name: '테스트 문제집', publisher: '테스트', grade: '중3', semester: 2}]})
    // Deliberately no INNGEST_SIGNING_KEY or LLM credentials: Worker admission
    // must not need hosted-app registration/inference configuration for Baton.
  } as unknown as CloudflareEnv;
  return {sql, env};
}

it('actual Baton upload and retry routes publish generations without hosted signing or inference configuration', async () => {
  const {sql, env} = fixture();
  const requests: Array<{name?: string; id?: string; data?: Record<string, unknown>}> = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    const parsed = JSON.parse(String(init?.body ?? '{}'));
    requests.push(...(Array.isArray(parsed) ? parsed : parsed.events ?? [parsed]));
    return Response.json({ids: ['fixture-event'], status: 200});
  }));
  const url = new URL('https://ymath.example.test/math/api/upload?workbookId=fixture-wb');
  const request = new Request(url, {method: 'POST', headers: {'x-requested-with': 'ymath', 'content-type': 'image/jpeg', 'idempotency-key': 'connect-entrypoints-supervisor'}, body: new Uint8Array([255,216,255,224,0,0,0,0,0,0,255,217])});
  const uploaded = await upload({request, url, platform: {env}, getClientAddress: () => '192.0.2.41'} as never);
  expect(uploaded.status).toBe(201);
  const {id} = await uploaded.json() as {id: string};
  expect(sql.prepare('SELECT state FROM item_outbox WHERE entity_id=? AND generation=1').get(id)).toMatchObject({state: 'sent'});
  expect(requests).toContainEqual(expect.objectContaining({name: 'ymath/item.requested', id: `item-${id}-1`, data: expect.objectContaining({entityId: id, entityGeneration: 1})}));
  sql.prepare("UPDATE entities SET status='failed',record_json=json_set(record_json,'$.status','failed') WHERE id=?").run(id);
  sql.prepare("UPDATE jobs SET state='failed' WHERE entity_id=?").run(id);
  const retryUrl = new URL(`https://ymath.example.test/math/api/items/${id}/retry`);
  const retried = await retry({request: new Request(retryUrl, {method: 'POST', headers: {'x-requested-with': 'ymath'}}), url: retryUrl, params: {id}, platform: {env}, getClientAddress: () => '192.0.2.42'} as never);
  expect(retried.status).toBe(202);
  expect(sql.prepare('SELECT state FROM item_outbox WHERE entity_id=? AND generation=2').get(id)).toMatchObject({state: 'sent'});
  expect(requests).toContainEqual(expect.objectContaining({name: 'ymath/item.requested', id: `item-${id}-2`, data: expect.objectContaining({entityId: id, entityGeneration: 2})}));
});
