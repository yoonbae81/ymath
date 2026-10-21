import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { handleItemCallback } from './item-callbacks';
import { validAnalysis } from '../analysis.fixture';
import { validateBatonRequest } from '../../../../baton/analysis/functions';
import type { CloudflareEnv } from './runtime';
import { Inngest } from '/Users/y/Github/baton/node_modules/inngest/index.js';
import { InngestTestEngine } from '/Users/y/Github/baton/node_modules/@inngest/test/dist/index.js';
import { createItemPipelineFunction } from '/Users/y/Github/baton/src/ymath/connect-item';

const storage = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock('./s3-store', () => ({requireS3Store: () => ({
  async put(key: string, bytes: Uint8Array) { storage.set(key, bytes); },
  async get(key: string) { return storage.get(key) ?? null; },
  async delete(key: string) { storage.delete(key); }
})}));
const dbs: DatabaseSync[] = [];
afterEach(() => { storage.clear(); dbs.splice(0).forEach((db) => db.close()); });
const entityId = '20260101-000000-ab12';
const jobId = '0f0e0d0c-0b0a-4938-8273-626b4f9e7e1a';
const imageKey = `items/${entityId}/normalized-1.jpg`;
const owner = 'supervisor-connect-run';
function fixture() {
  const sql = new DatabaseSync(':memory:'); dbs.push(sql);
  for (const file of readdirSync(new URL('../../../../migrations/', import.meta.url)).filter((s) => s.endsWith('.sql')).sort()) sql.exec(readFileSync(new URL(`../../../../migrations/${file}`, import.meta.url), 'utf8'));
  const DB = {prepare(query: string) {
    const stmt = sql.prepare(query); let args: SQLInputValue[] = [];
    const w = {bind(...values: unknown[]) {args = values as SQLInputValue[]; return w;}, async first<T>() {return stmt.get(...args) as T ?? null;}, async all<T>() {return {results: stmt.all(...args) as T[]};}, async run() {return {meta: {changes: Number(stmt.run(...args).changes)}};}};
    return w;
  }, async batch(statements: Array<{run(): Promise<unknown>}>) {sql.exec('BEGIN'); try {const r=[]; for (const s of statements) r.push(await s.run()); sql.exec('COMMIT'); return r;} catch(e) {sql.exec('ROLLBACK'); throw e;}}};
  const objects = new Map<string, Uint8Array>([[imageKey,new Uint8Array([255,216,255,224,0,0,0,0,0,0,255,217])]]);
  const record = {schema_version: 1,id: entityId,created_at:'2026-01-01T00:00:00.000Z',workbook: {id:'wb-test',name:'테스트 중3-2',publisher:'테스트',grade:'중3',semester:2},image:'image.jpg',status:'queued',attempts:0,error:null,analysis:null,meta:null,flags:{ocr_missing:false,taxonomy_mismatch:[],guardrail:[]}};
  sql.prepare("INSERT INTO entities(id,kind,created_at,status,generation,record_json,image_key,updated_at) VALUES(?,'item',?,'queued',1,?,?,?)").run(entityId,record.created_at,JSON.stringify(record),imageKey,record.created_at);
  sql.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,created_at,updated_at) VALUES(?,?,'item',1,'queued',?,?)").run(jobId,entityId,record.created_at,record.created_at);
  const env = {DB, RUNNER_TOKEN:'fixture-token',ITEM_ANALYSIS_BACKEND:'baton',S3:{async get(key:string){return objects.get(key)??null;},async put(key:string,b:Uint8Array){objects.set(key,b);},async delete(key:string){objects.delete(key);}}} as unknown as CloudflareEnv;
  const call = (action:string,body:Record<string,unknown>={},token='fixture-token') => handleItemCallback(action,new Request('https://worker.example.test/math/api/runner/items/'+action,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({jobId,entityId,entityGeneration:1,owner,...body})}),env);
  return {sql,objects,env,call};
}

it('real callback auth rejects an invalid runner token before claiming a job',async()=>{
  const f=fixture(); const response=await f.call('claim',{},'wrong-token'); expect(response.status).toBe(401);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'queued'});
});
it('real preparation writes the App-valid manifest and image to S3',async()=>{
  const f=fixture(); const claim=await (await f.call('claim')).json() as {job:{generation:number;lease_token:string}};
  const prepare=await f.call('prepare',{...claim.job,image_key:imageKey}); expect(prepare.status).toBe(200);
  const refs=await prepare.json();
  expect(()=>validateBatonRequest({job_id:jobId,entity_id:entityId,entity_generation:1,run_id:owner,request_key:refs.request_key,image_key:refs.image_key,...(refs.ocr_key?{ocr_key:refs.ocr_key}:{})})).not.toThrow();
  expect(storage.has(refs.request_key)).toBe(true); expect(storage.has(imageKey)).toBe(true);
});
it('real callback commit preserves generation fences and is replay-safe after a lost response',async()=>{
  const f=fixture(); const claim=await (await f.call('claim')).json() as {job:{generation:number;lease_token:string}};
  const resultKey=`items/${entityId}/baton-result-${jobId}-1.json`;
  const bytes=new TextEncoder().encode(JSON.stringify({contract_version:1,status:'completed',analysis:validAnalysis(),meta:{provider:'omlx',model:'fixture-model'}}));
  storage.set(resultKey,bytes);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const completion={...claim.job,result_key:resultKey,content_hash:hash,size_bytes:bytes.length,model:'fixture-model',prompt_version:'abcd1234',analyzed_at:'2026-10-20T00:00:00.000Z'};
  const stale=await (await f.call('commit',{...completion,entityGeneration:2})).json(); expect(stale.ok).toBe(false);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'leased'});
  const committed=await f.call('commit',completion); expect(committed.status).toBe(200); expect((await committed.json()).ok).toBe(true);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'done'});
  const replay=await f.call('commit',completion); expect(replay.status).toBe(200); expect((await replay.json()).ok).toBe(true);
  const conflicting=await f.call('commit',{...completion,content_hash:'b'.repeat(64)}); expect((await conflicting.json()).ok).toBe(false);
});

it('commit batch response loss still leaves an authoritative replay receipt',async()=>{
  const f=fixture(); const claim=await (await f.call('claim')).json() as {job:{generation:number;lease_token:string}};
  const result_key=`items/${entityId}/baton-result-${jobId}-1.json`;
  const bytes=new TextEncoder().encode(JSON.stringify({contract_version:1,status:'completed',analysis:validAnalysis(),meta:{provider:'omlx',model:'fixture-model'}}));
  storage.set(result_key,bytes);
  const content_hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const completion={...claim.job,result_key,content_hash,size_bytes:bytes.length,model:'fixture-model',prompt_version:'abcd1234',analyzed_at:'2026-10-20T00:00:00.000Z'};
  const originalBatch=f.env.DB.batch.bind(f.env.DB);
  let injected=false;
  f.env.DB.batch=async<T>(statements: Parameters<CloudflareEnv['DB']['batch']>[0])=>{
    const result=await originalBatch<T>(statements);
    if(!injected && (f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId) as {state:string}).state==='done') {injected=true;throw new Error('fixture: committed D1 batch response lost');}
    return result;
  };
  const first=await f.call('commit',completion); expect(first.status).toBe(500); expect(injected).toBe(true);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'done'});
  const replay=await f.call('commit',completion); expect(replay.status).toBe(200); expect((await replay.json()).ok).toBe(true);
});

it('real Connect SDK drives real Worker callbacks through validated S3 preparation and fenced completion', async () => {
  const f=fixture();
  f.sql.prepare('UPDATE entities SET ocr_key=? WHERE id=?').run('cached-ocr.txt',entityId);
  f.objects.set('cached-ocr.txt',new TextEncoder().encode('cached fixture OCR'));
  let runnerCalls=0;
  const fn=createItemPipelineFunction(new Inngest({id:'ymath',isDev:false}), {
    token:'fixture-token',callbacksBase:'https://worker.example.test/math/api',
    fetch: async (input,init) => {
      const request=new Request(input,init);
      return handleItemCallback(new URL(request.url).pathname.split('/').at(-1)!,request,f.env);
    }
  },{execute:async(request)=>{
    runnerCalls++;
    validateBatonRequest(request);
    expect(storage.has(request.request_key)).toBe(true);
    expect(storage.has(request.image_key)).toBe(true);
    const result_key=`items/${entityId}/baton-result-${jobId}-1.json`;
    const bytes=new TextEncoder().encode(JSON.stringify({contract_version:1,status:'completed',analysis:validAnalysis(),meta:{provider:'omlx',model:'fixture-model'}}));
    storage.set(result_key,bytes);
    const content_hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    return {status:'completed' as const,result_key,content_hash,size_bytes:bytes.length,model:'fixture-model',prompt_version:'abcd1234',analyzed_at:'2026-10-20T00:00:00.000Z'};
  }});
  const result=await new InngestTestEngine({function:fn}).execute({events:[{name:'ymath/item.requested',data:{jobId,entityId,entityGeneration:1}}]});
  expect(result.error).toBeUndefined(); expect(result.result).toEqual({status:'done'}); expect(runnerCalls).toBe(1);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'done'});
  expect(f.sql.prepare('SELECT status FROM entities WHERE id=?').get(entityId)).toMatchObject({status:'done'});
});

it('commit keeps a pre-bound receipt when the DB fails after the done commit, and the retry replays from the receipt',async()=>{
  const f=fixture();
  const claim=await (await f.call('claim')).json() as {job:{generation:number;lease_token:string}};
  const resultKey=`items/${entityId}/baton-result-${jobId}-1.json`;
  const bytes=new TextEncoder().encode(JSON.stringify({contract_version:1,status:'completed',analysis:validAnalysis(),meta:{provider:'omlx',model:'fixture-model'}}));
  storage.set(resultKey,bytes);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const completion={...claim.job,result_key:resultKey,content_hash:hash,size_bytes:bytes.length,model:'fixture-model',prompt_version:'abcd1234',analyzed_at:'2026-10-20T00:00:00.000Z'};
  // Inject: the moment the job row reaches done, every further DB access fails —
  // the handler dies after the real commit but before a response can be sent.
  let injected=false;
  const db=f.env.DB as unknown as {prepare:(q:string)=>unknown;batch:(s:unknown[])=>Promise<unknown>};
  const origPrepare=db.prepare.bind(db);
  const origBatch=db.batch.bind(db);
  const arm=()=>{const row=f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId) as {state:string}|undefined; if(row?.state==='done') injected=true;};
  // First attempt: the finalize transaction dies before committing (failOnce).
  // The receipt was already bound under the live lease fence, so the job stays
  // leased with an immutable receipt and the retry resumes and completes.
  let failOnce=true;
  db.batch=async(statements)=>{ if(failOnce){failOnce=false; throw new Error('INJECTED_DB_FAILURE');} const r=await origBatch(statements); arm(); return r; };
  db.prepare=((q:string)=>{ if(injected) throw new Error('INJECTED_DB_FAILURE'); const w=origPrepare(q) as {run:()=>Promise<unknown>;first:()=>Promise<unknown>;all:()=>Promise<unknown>};
    return {...w, run:async()=>{const r=await w.run(); arm(); return r;}, first:w.first.bind(w), all:w.all.bind(w)};}) as typeof db.prepare;
  const died=await f.call('commit',completion);
  expect(died.status).toBe(500);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'leased'});
  expect(JSON.parse(String((f.sql.prepare("SELECT payload FROM jobs WHERE id=?").get(jobId) as {payload:string}).payload)).connect_commit.result_key).toBe(resultKey);
  const resumed=await f.call('commit',completion);
  expect(resumed.status).toBe(200);
  expect((await resumed.json()).ok).toBe(true);
  expect(f.sql.prepare('SELECT state FROM jobs WHERE id=?').get(jobId)).toMatchObject({state:'done'});
  injected=false;
  // The response is lost after the real commit; the SDK retries from the receipt.
  const replay=await f.call('commit',completion);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ok:true,replay:true});
});

it('done-commit replay rejects a different lease token or completion fingerprint',async()=>{
  const f=fixture();
  const claim=await (await f.call('claim')).json() as {job:{generation:number;lease_token:string}};
  const resultKey=`items/${entityId}/baton-result-${jobId}-1.json`;
  const bytes=new TextEncoder().encode(JSON.stringify({contract_version:1,status:'completed',analysis:validAnalysis(),meta:{provider:'omlx',model:'fixture-model'}}));
  storage.set(resultKey,bytes);
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
  const completion={...claim.job,result_key:resultKey,content_hash:hash,size_bytes:bytes.length,model:'fixture-model',prompt_version:'abcd1234',analyzed_at:'2026-10-20T00:00:00.000Z'};
  expect((await (await f.call('commit',completion)).json()).ok).toBe(true);
  const otherToken='00000000-0000-4000-8000-000000000000';
  const tokenConflict=await f.call('commit',{...completion,lease_token:otherToken});
  expect(tokenConflict.status).toBe(409);
  const fingerprintConflict=await f.call('commit',{...completion,analyzed_at:'2026-10-21T00:00:00.000Z'});
  expect(fingerprintConflict.status).toBe(409);
  const hashConflict=await f.call('commit',{...completion,content_hash:'b'.repeat(64)});
  expect(hashConflict.status).toBe(409);
});
