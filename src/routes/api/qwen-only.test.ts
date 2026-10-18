import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
let isolated: string;
beforeEach(() => { isolated = mkdtempSync(join(tmpdir(), 'ymath-qwen-api-')); vi.stubEnv('USER_DIR', isolated); vi.stubEnv('DATA_DIR', join(isolated, 'data')); vi.stubEnv('CONFIG_DIR', join(isolated, 'config')); vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network forbidden in provider boundary test'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); rmSync(isolated, { recursive: true, force: true }); });
vi.mock('$lib/server/guard', () => ({ requireAjax: vi.fn(), requireMutationRate: vi.fn() }));
vi.mock('$lib/server/report', () => ({ getReportQueue: () => ({ generateOrReuse: async () => ({}) }), readReport: () => null }));
vi.mock('$lib/server/config', () => ({ loadWorkbooks: () => [] }));
import { POST as upload } from './upload/+server';
import { POST as report } from './reports/+server';
import { POST as retryReport } from './reports/[id]/retry/+server';
const event = (path: string, body?: object) => { const request = new Request(`https://example.test${path}`, {method:'POST',headers:{'content-type': body ? 'application/json' : 'image/jpeg'},body:body ? JSON.stringify(body) : 'image'}); return {request,url:new URL(request.url),params:{id:'20261018-010000-rep-abcd'}} as never; };
it.each(['zai','codex','agy','unknown'])('rejects explicit %s across upload/report/retry', async provider => {
 await expect(upload(event(`/api/upload?workbookId=x&provider=${provider}`))).rejects.toMatchObject({status:400, body:{message:'Qwen(omlx)만 사용할 수 있습니다'}});
 await expect(report(event('/api/reports',{topic:'대수',provider}))).rejects.toMatchObject({status:400, body:{message:'Qwen(omlx)만 사용할 수 있습니다'}});
 await expect(retryReport(event(`/api/reports/20261018-010000-rep-abcd/retry?provider=${provider}`))).rejects.toMatchObject({status:400, body:{message:'Qwen(omlx)만 사용할 수 있습니다'}});
});
