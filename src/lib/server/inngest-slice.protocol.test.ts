import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { POST as submitRoute } from '../../routes/api/inngest/submit/+server';
import { GET as statusRoute } from '../../routes/api/inngest/jobs/[id]/+server';
import { GET as healthRoute } from '../../routes/api/inngest/health/+server';
import { makeSliceApp } from './inngest-slice/app';
import { createSliceSubmission } from './inngest-slice/submit';
import type { SliceDb, SliceStatement } from './inngest-slice/store';

const config = { INNGEST_EVENT_KEY: 'synthetic-event-key', INNGEST_SIGNING_KEY: 'signkey-test-1234567890abcdef', LLM_API_KEY: 'synthetic-provider-key', LLM_BASE_URL: 'https://llm.example.test/v1', LLM_MODEL: 'synthetic-model' };
const require = createRequire(import.meta.url);
const { signDataWithKey } = require('../../../node_modules/inngest/helpers/net.js');
function setup(failFirstSave = false, objects?: import('./cloudflare/runtime').R2BucketLike) {
 let shouldFailSave = failFirstSave;
 const sqlite = new DatabaseSync(':memory:');
 sqlite.exec(readFileSync(new URL('../../../migrations/0004_inngest_slice.sql', import.meta.url), 'utf8'));
 const db: SliceDb = { prepare(sql) { const stmt = sqlite.prepare(sql); let args: unknown[] = []; const wrapper: SliceStatement = {
 bind(...values) { args = values; return wrapper; }, async first<T>() { return (stmt.get(...args as never[]) as T) ?? null; }, async run() { if(shouldFailSave && sql.includes("status='done'")) {shouldFailSave=false;throw new Error('SYNTHETIC transient database transport failure before commit');} return { meta: { changes: Number(stmt.run(...args as never[]).changes) } }; }
 }; return wrapper; } };
 const app = makeSliceApp({ DB: db, OBJECTS: objects, ...config });
 return { ...app, db, close: () => sqlite.close() };
}
function driver(app: ReturnType<typeof makeSliceApp>, event: Record<string, unknown>, fnId = 'ymath-synthetic-slice-synthetic-text-analysis') {
 const steps: Record<string, unknown> = {};
 async function call(stepId = 'step') {
  const body = { version: 2, event, events: [event], steps, ctx: { run_id: '01SYNTHETICRUN0000000000000', attempt: 0, disable_immediate_execution: true, use_api: false } };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await signDataWithKey(body, config.INNGEST_SIGNING_KEY, timestamp, { debug() {} });
  const url = new URL(`https://math.test/math/api/inngest?fnId=${fnId}&stepId=${stepId}`);
  const request = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', host: 'math.test', 'x-inngest-signature': `t=${timestamp}&s=${signature}` }, body: JSON.stringify(body) });
  const response = await app.handler.POST({ request, url } as never);
  return { status: response.status, body: await response.json() };
 }
 return { steps, call };
}
async function advance(run: ReturnType<typeof driver>, completion: unknown) {
 let result = await run.call();
 let gatewayCount = 0;
 for(let i=0;i<40 && result.status===206;i++) {
  const op = (result.body as Array<{id:string;op:string;data?:unknown}>)[0];
  if(op.op==='StepPlanned') result=await run.call(op.id);
  else if(op.op==='StepRun') {run.steps[op.id]={type:'data',data:op.data};result=await run.call();}
  else if(op.op==='AIGateway') {gatewayCount++;run.steps[op.id]={type:'data',data:completion};result=await run.call();}
  else throw new Error(`Unexpected protocol op ${JSON.stringify(op)}`);
 }
 return { ...result, gatewayCount };
}
afterEach(() => vi.unstubAllGlobals());
describe('signed SDK execution protocol against real SQLite', () => {
 it('runs the exact OCR probe through image AIGateway and memoized R2 readback', async () => {
  const network = vi.fn(() => { throw new Error('NETWORK FORBIDDEN'); }); vi.stubGlobal('fetch', network);
  const stored = new Map<string, Uint8Array>();
  const put = vi.fn(async (key: string, value: ArrayBuffer | Uint8Array) => { stored.set(key, new Uint8Array(value)); });
  const get = vi.fn(async (key: string) => { const value = stored.get(key); return value ? { body: new Response(new Uint8Array(value).buffer).body! } : null; });
  const app = setup(true, { put, get, delete: async () => {} });
  try {
   const id = await app.store.create('SYNTHETIC_IMAGE_OCR_PROBE_V1');
   const run = driver(app, { name: 'ymath/slice.requested', data: { jobId: id, generation: 1 } });
   let result = await run.call(); let gateways = 0; let failed = false;
   for (let i = 0; i < 40 && result.status === 206; i++) {
    const op = result.body[0];
    if (op.op === 'StepPlanned') result = await run.call(op.id);
    else if (op.op === 'StepRun') { run.steps[op.id] = { type: 'data', data: op.data }; result = await run.call(); }
    else if (op.op === 'AIGateway') {
     gateways++;
     expect(op.opts).toMatchObject({ url: 'https://llm.example.test/v1/chat/completions', timeout: '2m', body: { model: 'PaddleOCR-VL-1.6-mlx' } });
     const messages = op.opts.body.messages;
     const image = messages[1].content[0].image_url.url;
     expect(image).toMatch(/^data:image\/jpeg;base64,\/9j\//);
     expect(messages[0].content + messages[1].content[1].text).not.toContain('YMATH7Q9K2');
     run.steps[op.id] = { type: 'data', data: { choices: [{ finish_reason: 'stop', message: { content: ' <|LOC_42|> YMATH7Q9K2\nx + 2 = 5 ' } }] } };
     result = await run.call();
    } else if (op.op === 'StepError' && !failed) { failed = true; result = await run.call(op.id); }
    else throw new Error(JSON.stringify(op));
   }
   expect(result).toMatchObject({ status: 200, body: { status: 'done' } });
   expect(gateways).toBe(1); expect(failed).toBe(true); expect(put).toHaveBeenCalledTimes(1); expect(get).toHaveBeenCalledTimes(1);
   const evidence = JSON.parse((await app.store.get(id)).result_text!);
   expect(evidence).toMatchObject({ imageMarkerMatched: true, ocrText: 'YMATH7Q9K2\nx + 2 = 5', ocrKey: `probes/${id}/ocr.txt`, persistedReadback: true, model: 'PaddleOCR-VL-1.6-mlx' });
   expect(evidence.inferObservedMs).toBeGreaterThanOrEqual(0);
   const timestamps = Object.values(run.steps).map(value => (value as {data: unknown}).data).filter((value): value is number => typeof value === 'number');
   expect(timestamps).toHaveLength(2);
   expect(evidence.inferObservedMs).toBe(timestamps[1] - timestamps[0]);
   expect(new TextDecoder().decode(stored.get(evidence.ocrKey))).toBe(evidence.ocrText);
   expect(await run.call()).toMatchObject(result);
   expect(network).not.toHaveBeenCalled();
  } finally { app.close(); }
 });
 it.each([
  { text: 'Wrong synthetic marker\nx + 2 = 5', readback: 'same', imageMarkerMatched: false, persistedReadback: true },
  { text: 'YMATH7Q9K2\nx + 2 = 5', readback: 'corrupt R2 text', imageMarkerMatched: true, persistedReadback: false },
  { text: 'YMATH7Q9K2\nx + 2 = 5', readback: null, imageMarkerMatched: true, persistedReadback: false }
 ])('retains failure evidence for OCR mismatch/readback: $readback / $imageMarkerMatched', async ({ text, readback, imageMarkerMatched, persistedReadback }) => {
  const network = vi.fn(() => { throw new Error('NETWORK FORBIDDEN'); }); vi.stubGlobal('fetch', network);
  let stored = '';
  const app = setup(false, { put: async (_key, bytes) => { stored = new TextDecoder().decode(bytes); }, get: async () => readback === null ? null : { body: new Response(readback === 'same' ? stored : readback).body! }, delete: async () => {} });
  try {
   const id = await app.store.create('SYNTHETIC_IMAGE_OCR_PROBE_V1');
   const result = await advance(driver(app, { name: 'ymath/slice.requested', data: { jobId: id, generation: 1 } }), { choices: [{ finish_reason: 'stop', message: { content: text } }] });
   expect(result).toMatchObject({ status: 200, body: { status: 'probe_failed' }, gatewayCount: 1 });
   expect(JSON.parse((await app.store.get(id)).result_text!)).toMatchObject({ imageMarkerMatched, persistedReadback, ocrText: text });
   expect(network).not.toHaveBeenCalled();
  } finally { app.close(); }
 });
 it('rejects provider error payloads even if they contain marker text', async () => {
  const app = setup(false, { put: async () => {}, get: async () => ({ body: new Response('YMATH7Q9K2').body! }), delete: async () => {} });
  try {
   const id = await app.store.create('SYNTHETIC_IMAGE_OCR_PROBE_V1');
   const result = await advance(driver(app, { name: 'ymath/slice.requested', data: { jobId: id, generation: 1 } }), { error: { message: 'synthetic error' }, choices: [{ finish_reason: 'length', message: { content: 'YMATH7Q9K2' } }] });
   expect(result.status).toBe(500); expect((await app.store.get(id)).result_text).toBeNull();
  } finally { app.close(); }
 });
 it('rejects empty OCR rather than producing successful probe evidence', async () => {
  const put = vi.fn(); const app = setup(false, { put, get: async () => null, delete: async () => {} });
  try {
   const id = await app.store.create('SYNTHETIC_IMAGE_OCR_PROBE_V1');
   const result = await advance(driver(app, { name: 'ymath/slice.requested', data: { jobId: id, generation: 1 } }), { choices: [{ finish_reason: 'stop', message: { content: '<|LOC_1|> ' } }] });
   expect(result.status).toBe(500); expect((await app.store.get(id)).result_text).toBeNull(); expect(put).not.toHaveBeenCalled();
  } finally { app.close(); }
 });
 it('does not activate the image probe for a near-match input', async () => {
  const app = setup();
  try {
   const id = await app.store.create('SYNTHETIC_IMAGE_OCR_PROBE_V1 ');
   const result = await advance(driver(app, { name: 'ymath/slice.requested', data: { jobId: id, generation: 1 } }), { choices: [{ finish_reason: 'stop', message: { content: 'Ordinary text result.' } }] });
   expect(result).toMatchObject({ status: 200, body: { status: 'done' } });
   expect((await app.store.get(id)).result_text).toBe('Ordinary text result.');
  } finally { app.close(); }
 });
 it('exercises actual submit/status/health routes with only SDK ingest HTTP replaced by a labeled fixture',async()=>{
  let payload:unknown;
  const network=vi.fn(async (url:unknown,init?:RequestInit)=>{
   expect(String(url)).toBe('https://inn.gs/e/synthetic-event-key');
   payload=JSON.parse(String(init?.body));
   return new Response(JSON.stringify({status:200,ids:['SYNTHETIC_EVENT_ACK']}),{status:200,headers:{'content-type':'application/json'}});
  });vi.stubGlobal('fetch',network);
  const app=setup();try{
   const platform={env:{DB:app.db,...config}};
   const response=await submitRoute({platform,request:new Request('https://math.test/math/api/inngest/submit',{method:'POST',body:JSON.stringify({text:'Explicit synthetic route input.'})})} as never);
   expect(response.status).toBe(202);expect(network).toHaveBeenCalledTimes(1);
   const {jobId}=await response.json();
   expect(payload).toMatchObject([{name:'ymath/slice.requested',data:{jobId,generation:1}}]);
   expect(JSON.stringify(payload)).not.toContain('Explicit synthetic route input');
   const status=await statusRoute({platform,params:{id:jobId}} as never);
   expect(await status.json()).toMatchObject({jobId,status:'queued',result:null});
   const health=await healthRoute({} as never);expect(health.status).toBe(200);
   const disabled=await submitRoute({platform:{env:{DB:app.db}},request:new Request('https://math.test/math/api/inngest/submit',{method:'POST',body:'{}'})} as never);
   expect(disabled.status).toBe(503);expect(network).toHaveBeenCalledTimes(1);
  }finally{app.close();}
 });
 it('replays the failed save step on the same signed run without claiming or inferring again',async()=>{
  const network=vi.fn(()=>{throw new Error('NETWORK FORBIDDEN');});vi.stubGlobal('fetch',network);
  const app=setup(true);try{
   const id=await app.store.create('Synthetic retry input.');
   const run=driver(app,{name:'ymath/slice.requested',data:{jobId:id,generation:1}});
   let result=await run.call();let gateways=0;let failureStep='';
   for(let i=0;i<12;i++){
    expect(result.status,JSON.stringify(result.body)).toBe(206);
    const op=(result.body as Array<{op:string;id:string;data?:unknown}>)[0];
    if(op.op==='StepPlanned')result=await run.call(op.id);
    else if(op.op==='StepRun'){run.steps[op.id]={type:'data',data:op.data};result=await run.call();}
    else if(op.op==='AIGateway'){gateways++;run.steps[op.id]={type:'data',data:{choices:[{finish_reason:'stop',message:{content:'SYNTHETIC retry result retained across save retry.'}}]}};result=await run.call();}
    else if(op.op==='StepError'){failureStep=op.id;break;}
    else throw new Error(JSON.stringify(result));
   }
   expect(failureStep).not.toBe('');expect((await app.store.get(id)).status).toBe('running');
   const retried=await run.call(failureStep);
   expect(retried.status).toBe(206);
   const saved=(retried.body as Array<{id:string;op:string;data:unknown}>)[0];expect(saved.op).toBe('StepRun');
   run.steps[saved.id]={type:'data',data:saved.data};expect(await run.call()).toMatchObject({status:200,body:{status:'done'}});
   expect(gateways).toBe(1);expect(network).not.toHaveBeenCalled();
  }finally{app.close();}
 });
 it('accepts signed in-band registration without outbound registration and rejects tampering',async()=>{
  const network=vi.fn(()=>{throw new Error('NETWORK FORBIDDEN');});vi.stubGlobal('fetch',network);
  const app=setup();try{
   const body={url:'https://math.test/math/api/inngest'};const timestamp=String(Math.floor(Date.now()/1000));
   const signature=await signDataWithKey(body,config.INNGEST_SIGNING_KEY,timestamp,{debug(){}});
   const request=new Request('https://math.test/math/api/inngest',{method:'PUT',headers:{host:'math.test','content-type':'application/json','x-inngest-sync-kind':'in_band','x-inngest-signature':`t=${timestamp}&s=${signature}`},body:JSON.stringify(body)});
   const registered=await app.handler.PUT({request,url:new URL(request.url)} as never);
   expect(registered.status).toBe(200);
   const registration=await registered.json();expect(JSON.stringify(registration)).toContain('synthetic-text-analysis');
   expect(JSON.stringify(registration)).not.toContain(config.LLM_API_KEY);
   const tampered=new Request(request.url,{method:'PUT',headers:request.headers,body:JSON.stringify({url:'https://tampered.example.test'})});
   expect((await app.handler.PUT({request:tampered,url:new URL(tampered.url)} as never)).status).toBe(401);
   expect(network).not.toHaveBeenCalled();
  }finally{app.close();}
 });
 it('configures bounded SDK retries instead of disabling retry orchestration', () => {
  const app=setup();
  try { expect(app.analyze.opts.retries).toBe(2); } finally {app.close();}
 });
 it('persists a text completion once and rejects duplicate SDK delivery and stale save',async()=>{
  const network=vi.fn(()=>{throw new Error('NETWORK FORBIDDEN');});vi.stubGlobal('fetch',network);
  const app=setup();try {
   const id=await app.store.create('Explicit synthetic text fixture.');
   const event={name:'ymath/slice.requested',data:{jobId:id,generation:1}};
   const run=driver(app,event);
   const result=await advance(run,{choices:[{finish_reason:'stop',message:{content:'Explicit synthetic text answer, not real provider inference.'}}]});
   expect(result).toMatchObject({status:200,body:{status:'done'},gatewayCount:1});
   const duplicate=await advance(driver(app,event),{});
   expect(duplicate).toMatchObject({status:200,body:{status:'duplicate_or_unavailable'},gatewayCount:0});
   expect((await app.store.get(id)).result_text).toContain('synthetic text answer');
   expect(await app.store.complete({id,generation:1,attempt_token:'stale'},'overwrite')).toBe(false);
   expect(network).not.toHaveBeenCalled();
  }finally{app.close();}
 });
 it('delivers signed terminal failure through SDK onFailure and fences deleted generations',async()=>{
  const network=vi.fn(()=>{throw new Error('NETWORK FORBIDDEN');});vi.stubGlobal('fetch',network);
  const app=setup();try {
   const id=await app.store.create('Synthetic failing inference.');
   const original={name:'ymath/slice.requested',data:{jobId:id,generation:1}};
   const failed=await advance(driver(app,original),{error:{message:'explicit synthetic provider error'}});
   expect(failed.status).toBe(500);expect((await app.store.get(id)).status).toBe('running');
   const failureEvent={name:'inngest/function.failed',data:{event:original,error:{name:'Error',message:'Synthetic provider failure'},function_id:'synthetic-text-analysis',run_id:'synthetic-run'}};
   const terminal=await advance(driver(app,failureEvent,'ymath-synthetic-slice-synthetic-text-analysis-failure'),{});
   expect(terminal.status).toBe(200);expect((await app.store.get(id)).status).toBe('failed');
   const next=await app.store.reanalyze(id);const current=await app.store.claim(id,next);await app.store.delete(id);
   expect(await app.store.complete(current!,'late synthetic answer')).toBe(false);
   const lateFailure=await advance(driver(app,failureEvent,'ymath-synthetic-slice-synthetic-text-analysis-failure'),{});
   expect(lateFailure.status).toBe(200);expect((await app.store.get(id)).status).toBe('deleted');
   expect(network).not.toHaveBeenCalled();
  }finally{app.close();}
 });
 it('submits a synthetic report, emits an actual AIGateway command, resumes and saves', async () => {
  const network = vi.fn(() => { throw new Error('ALL NETWORK FORBIDDEN in local protocol test'); }); vi.stubGlobal('fetch', network);
  const app = setup();
  try {
   let published: Record<string, unknown> = {};
   const submit = createSliceSubmission({ store: app.store, configured: true, send: async (jobId, generation) => { published = { name: 'ymath/slice.requested', data: { jobId, generation } }; } });
   const accepted = await submit(new Request('https://math.test/api/inngest/submit', { method:'POST', body: JSON.stringify({kind:'report',text:'Synthetic report about a fictional exercise.'}) }));
   expect(accepted.status).toBe(202);
   const {jobId} = await accepted.json();
   const run = driver(app, published);
   let result = await run.call();
   const trace: unknown[] = [];
   let gateway: { id:string; opts:{ url:string; auth_key:string; body:{model:string;messages:Array<{content:string}>} } } | undefined;
   for (let i=0; i<10; i++) {
    trace.push({status:result.status,body:result.body});
    if (result.status === 200) break;
    expect(result.status, JSON.stringify(result.body)).toBe(206);
    const ops = result.body as Array<{op:string;id:string;data?:unknown;opts?:unknown}>;
    expect(Array.isArray(ops), JSON.stringify(ops)).toBe(true);
    const op = ops[0];
    if (op.op === 'StepPlanned') result = await run.call(op.id);
    else if (op.op === 'StepRun') { run.steps[op.id] = {type:'data',data:op.data}; result = await run.call(); }
    else if (op.op === 'AIGateway') {
     gateway = op as unknown as typeof gateway;
     expect(gateway!.opts.url).toBe('https://llm.example.test/v1/chat/completions');
     expect(gateway!.opts.auth_key).toBe('synthetic-provider-key');
     expect(gateway!.opts.body.model).toBe('synthetic-model');
     expect(gateway!.opts.body.messages.map(x=>x.content).join('\n')).toContain('recommendations');
     run.steps[op.id] = {type:'data',data:{choices:[{finish_reason:'stop',message:{content:JSON.stringify({title:'Synthetic report',summary:'Explicit synthetic fixture, not a real inference.',findings:['Fictional finding'],recommendations:['Fictional recommendation']})}}]}};
     result = await run.call();
    } else throw new Error(`Unexpected protocol op ${JSON.stringify(op)}`);
   }
   expect(gateway).toBeDefined();
   expect(result).toMatchObject({status:200,body:{status:'done'}});
   expect(await app.store.get(jobId)).toMatchObject({status:'done'});
   expect(JSON.parse((await app.store.get(jobId)).result_text!).title).toBe('Synthetic report');
   expect(network).not.toHaveBeenCalled();
   const dir='/Users/y/.hermes/profiles/plan/cache/scratch/inngest-vertical-slice'; mkdirSync(dir,{recursive:true});
   writeFileSync(`${dir}/signed-protocol-trace.json`, JSON.stringify({fixture:'SYNTHETIC; no provider HTTP call',trace}, (k,v)=>k==='auth_key'?'[REDACTED SYNTHETIC KEY]':v,2));
  } finally { app.close(); }
 });
});
