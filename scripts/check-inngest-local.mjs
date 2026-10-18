// Local-only SDK protocol proof with a real Wrangler D1 binding. No server/runner remains running.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createServer } from 'vite';

const scratch = '/Users/y/.hermes/profiles/plan/cache/scratch';
assert.equal(resolve(process.env.TMPDIR ?? ''), scratch, 'Set TMPDIR to the required scratch root');
process.env.WRANGLER_LOG_PATH = join(scratch, 'wrangler-logs');
const { mkdir } = await import('node:fs/promises');
await mkdir(process.env.WRANGLER_LOG_PATH, { recursive: true });
const reportTest = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', '--run', 'src/lib/server/cloudflare/inngest-report.local.test.ts'], { stdio: 'inherit', env: { ...process.env, RUN_INNGEST_REPORT_LOCAL: '1', RUN_INNGEST_REPORT_FIXTURE: '' } });
assert.equal(reportTest.status, 0, 'Real Wrangler D1/R2 application report integration must pass before the synthetic slice check');
const { getPlatformProxy } = await import('wrangler');
const vite = await createServer({ configFile: resolve('vite.config.ts'), server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
const { makeSliceApp } = await vite.ssrLoadModule('/src/lib/server/inngest-slice/app.ts');
const root = await mkdtemp(join(scratch, 'inngest-real-d1-'));
const configPath = join(root, 'wrangler.json');
await writeFile(configPath, JSON.stringify({ name:'math-inngest-local-test', compatibility_date:'2026-10-01', compatibility_flags:['nodejs_compat'], d1_databases:[{binding:'DB',database_name:'math',database_id:'00000000-0000-0000-0000-000000000001'}] }));
const proxy = await getPlatformProxy({ configPath, persist:{path:join(root,'state')} });
const realFetch = globalThis.fetch;
// Local runtime proxy traffic is allowed; all external HTTP is prohibited.
globalThis.fetch = (input, init) => {
 const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname), `External HTTP prohibited in this proof: ${url.hostname}`);
 return realFetch(input, init);
};
const require=createRequire(import.meta.url);
const {signDataWithKey}=require('../node_modules/inngest/helpers/net.js');
const config={INNGEST_EVENT_KEY:'synthetic-event-key',INNGEST_SIGNING_KEY:'signkey-test-1234567890abcdef',LLM_API_KEY:'synthetic-provider-key',LLM_BASE_URL:'https://llm.example.test/v1',LLM_MODEL:'synthetic-model'};
const evidence=[];
try {
 const DB=proxy.env.DB;
 const sql=await readFile(new URL('../migrations/0004_inngest_slice.sql',import.meta.url),'utf8');
 await DB.prepare(sql).run();
 const app=makeSliceApp({DB,...config});
 for(const kind of ['text','report']) {
  const id=await app.store.create('EXPLICIT SYNTHETIC LOCAL D1 FIXTURE',kind);
  const event={name:'ymath/slice.requested',data:{jobId:id,generation:1}};
  const steps={};
  async function call(stepId='step'){
   const body={version:2,event,events:[event],steps,ctx:{run_id:`synthetic-${kind}-local-d1`,attempt:0,disable_immediate_execution:true,use_api:false}};
   const t=String(Math.floor(Date.now()/1000));const s=await signDataWithKey(body,config.INNGEST_SIGNING_KEY,t,{debug(){}});
   const url=new URL(`https://math.test/math/api/inngest?fnId=ymath-synthetic-slice-synthetic-text-analysis&stepId=${stepId}`);
   const request=new Request(url,{method:'POST',headers:{host:'math.test','content-type':'application/json','x-inngest-signature':`t=${t}&s=${s}`},body:JSON.stringify(body)});
   const response=await app.handler.POST({request,url});return {status:response.status,body:await response.json()};
  }
  let result=await call();let gateways=0;const operations=[];
  for(let i=0;i<15 && result.status===206;i++){
   const op=result.body[0];operations.push(op.op);
   if(op.op==='StepPlanned')result=await call(op.id);
   else if(op.op==='StepRun'){steps[op.id]={type:'data',data:op.data};result=await call();}
   else if(op.op==='AIGateway'){
    gateways++;assert.equal(op.opts.type,'step.ai.infer');assert.equal(op.opts.url,'https://llm.example.test/v1/chat/completions');assert.equal(op.opts.body.model,'synthetic-model');
    const content=kind==='report'?JSON.stringify({title:'Synthetic report',summary:'Explicit synthetic report fixture; not model output.',findings:['Synthetic finding'],recommendations:['Synthetic recommendation']}):'Explicit synthetic text fixture, never fetched from a provider.';
    steps[op.id]={type:'data',data:{choices:[{finish_reason:'stop',message:{content}}]}};result=await call();
   }else throw new Error(JSON.stringify(result));
  }
  assert.equal(result.status,200);assert.equal(result.body.status,'done');assert.equal(gateways,1);
  const saved=await DB.prepare('SELECT status,result_text,generation,attempts FROM inngest_slice_jobs WHERE id=?').bind(id).first();
  assert.equal(saved.status,'done');assert.equal(saved.attempts,1);assert.ok(saved.result_text.includes('synthetic')||saved.result_text.includes('Synthetic'));
  assert.equal(await app.store.complete({id,generation:1,attempt_token:'stale'},'malicious stale overwrite'),false);
  const generation=await app.store.reanalyze(id);const claimed=await app.store.claim(id,generation);await app.store.delete(id);assert.equal(await app.store.complete(claimed,'late result'),false);
  evidence.push({kind,operations,gatewayCount:gateways,savedStatus:saved.status,duplicateAndDeletionFencing:'PASS'});
 }
 await writeFile(join(root,'result.json'),JSON.stringify({mode:'local Wrangler D1; synthetic executor/provider fixture; no external HTTP',evidence},null,2));
 console.log(JSON.stringify({status:'PASS',evidenceRoot:root,evidence},null,2));
} finally {globalThis.fetch=realFetch;await proxy.dispose();await vite.close();}
