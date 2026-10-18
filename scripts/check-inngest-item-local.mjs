// Real adapter-cloudflare -> Wrangler bundle -> workerd, local D1/R2 only.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import sharp from 'sharp';
import { validAnalysis } from '../src/lib/server/analysis.fixture.ts';
const root = await mkdtemp(join('/Users/y/.hermes/profiles/plan/cache/scratch', 'ymath-item-workerd-'));
process.env.WRANGLER_LOG_PATH = join(root, 'wrangler.log');
const result = spawnSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--dry-run', '--outdir', root], { encoding:'utf8', env:{...process.env, WRANGLER_SEND_METRICS:'false'}, maxBuffer:16*1024*1024 });
assert.equal(result.status, 0, result.stdout + result.stderr);
const signingKey = 'signkey-test-1234567890abcdef';
const { signDataWithKey } = createRequire(import.meta.url)('../node_modules/inngest/helpers/net.js');
const network = [];
const mf = new Miniflare(convertV4MiniflareOptions({ cf:false, workers:[{ name:'item-local', modulesRoot:root, modules:[{type:'ESModule',path:join(root,'_worker.js')}, ...(await readdir(root)).filter(name=>name.endsWith('.wasm')).map(name=>({type:'CompiledWasm',path:join(root,name)}))], compatibilityDate:'2026-10-17', compatibilityFlags:['nodejs_compat'], d1Databases:['DB'], r2Buckets:['OBJECTS'], bindings:{INNGEST_EVENT_KEY:'synthetic-event-key',INNGEST_SIGNING_KEY:signingKey,LLM_API_KEY:'synthetic-provider-key',LLM_BASE_URL:'https://llm.example.test/v1',LLM_MODEL:'synthetic-model',ITEM_ANALYSIS_BACKEND:'inngest'}, outboundService:async request=>{network.push(request.url);throw new Error('External HTTP forbidden: '+request.url);} }] }));
const evidence=[];
try {
 const db=await mf.getD1Database('DB'), r2=await mf.getR2Bucket('OBJECTS');
 for(const name of ['0001_initial.sql','0003_item_ocr.sql','0007_item_outbox.sql']) {
  const sql=await readFile(new URL('../migrations/'+name,import.meta.url),'utf8');
  for(const statement of sql.replace(/--[^\n]*/g,'').split(';').map(s=>s.trim()).filter(Boolean)) await db.prepare(statement).run();
 }
 const raw=await sharp({create:{width:2000,height:400,channels:3,background:'#c04020'}}).withMetadata({orientation:6}).jpeg().toBuffer();
 async function seed(id, ocrKey=null) {
  const now=new Date().toISOString(), key=`items/${id}/raw.jpg`;
  const record={schema_version:1,id,created_at:now,status:'queued',error:null,attempts:0,workbook:{id:'synthetic',name:'Synthetic',publisher:'TEST',grade:'중3',semester:2},image:'image.jpg',flags:{ocr_missing:false,taxonomy_mismatch:[],guardrail:[]},analysis:null,meta:null};
  await r2.put(key,raw);
  await db.prepare("INSERT INTO entities(id,kind,created_at,status,generation,raw_key,record_json,ocr_key,updated_at) VALUES(?,'item',?,'queued',1,?,?,?,?)").bind(id,now,key,JSON.stringify(record),ocrKey,now).run();
  await db.prepare("INSERT INTO jobs(id,entity_id,kind,entity_generation,state,payload,created_at,updated_at) VALUES(?,?,'item',1,'queued','{}',?,?)").bind('job-'+id,id,now,now).run();
 }
 async function run(id,ocr=' <|LOC_1|>SYNTHETIC-OCR-MARKER ',analysis=validAnalysis(), expectSchemaFailure=false) {
  const steps={},event={name:'ymath/item.requested',data:{jobId:'job-'+id,entityId:id,entityGeneration:1}};
  const ops=[], gateways=[];
  async function call(stepId='step') {
   const body={version:2,event,events:[event],steps,ctx:{run_id:'local-'+id,attempt:0,disable_immediate_execution:true,use_api:false}};
   const t=String(Math.floor(Date.now()/1000)),s=await signDataWithKey(body,signingKey,t,{debug(){}});
   const response=await mf.dispatchFetch(`https://math.test/math/api/inngest?fnId=ymath-synthetic-slice-item-analysis&stepId=${stepId}`,{method:'POST',headers:{'content-type':'application/json','x-inngest-signature':`t=${t}&s=${s}`},body:JSON.stringify(body)});
   return {status:response.status,body:await response.json()};
  }
  let response=await call();
  for(let i=0;i<50&&response.status===206;i++) {
   const op=response.body[0];ops.push(op.op);
   if(op.op==='StepPlanned')response=await call(op.id);
   else if(op.op==='StepRun'){steps[op.id]={type:'data',data:op.data};response=await call();}
   else if(op.op==='AIGateway'){
    gateways.push(op);assert.equal(op.opts.type,'step.ai.infer');assert.equal(op.opts.url,'https://llm.example.test/v1/chat/completions');
    const parts=op.opts.body.messages[1].content;assert.match(parts[0].image_url.url,/^data:image\/jpeg;base64,/);
    const jpg=Buffer.from(parts[0].image_url.url.split(',')[1],'base64');
    const meta=await sharp(jpg).metadata();assert.equal(meta.format,'jpeg');assert.equal(meta.width,320);assert.equal(meta.height,1600);
    const pixels=await sharp(jpg).removeAlpha().raw().toBuffer();for(let j=0;j<pixels.length;j+=3){assert.equal(pixels[j],pixels[j+1]);assert.equal(pixels[j+1],pixels[j+2]);}
    const isOcr=op.opts.body.model==='PaddleOCR-VL-1.6-mlx';
    if(!isOcr){assert.match(parts[1].text,/준수해야 할 JSON Schema/);assert.ok(parts[1].text.includes(ocr.trim()? 'SYNTHETIC-OCR-MARKER':'OCR 결과 없음'));}
    const content=isOcr?ocr:JSON.stringify(analysis);
    steps[op.id]={type:'data',data:{choices:[{finish_reason:'stop',message:{content}}]}};response=await call();
   }else throw new Error(JSON.stringify(op));
  }
  if(expectSchemaFailure) {
   assert.equal(response.status,500,JSON.stringify(response));
   assert.match(response.body.message,/분석 결과가 스키마와 다름/);
   const saved=await db.prepare('SELECT status FROM entities WHERE id=?').bind(id).first();
   assert.notEqual(saved.status,'done');
   evidence.push({id,gateways:gateways.length,status:'schema-rejected',operations:ops});
   return;
  }
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(response.body.status,'done');
  const saved=await db.prepare('SELECT status,image_key,ocr_key,record_json FROM entities WHERE id=?').bind(id).first();
  assert.equal(saved.status,'done');assert.ok(await r2.get(saved.image_key));
  const api=await mf.dispatchFetch(`https://math.test/math/api/items/${id}`);assert.equal(api.status,200);assert.equal((await api.json()).status,'done');
  evidence.push({id,gateways:gateways.length,operations:ops,status:saved.status,ocrKey:saved.ocr_key});
  return saved;
 }
 await seed('20261018-000001-test');const saved=await run('20261018-000001-test');
 assert.equal(await (await r2.get(saved.ocr_key)).text(),'SYNTHETIC-OCR-MARKER');
 await seed('20261018-000002-test',saved.ocr_key);await run('20261018-000002-test');assert.equal(evidence.at(-1).gateways,1);
 await seed('20261018-000003-test');const missing=await run('20261018-000003-test','   ');assert.equal(JSON.parse(missing.record_json).flags.ocr_missing,true);
 await seed('20261018-000004-test');await run('20261018-000004-test','SYNTHETIC-OCR-MARKER',{...validAnalysis(),unexpected:true},true);
 assert.deepEqual(network,[]);
 await writeFile(join(root,'evidence.json'),JSON.stringify({status:'PASS',mode:'real workerd D1 R2; signed SDK; synthetic upstream only',evidence},null,2));
 console.log(JSON.stringify({status:'PASS',root,evidence},null,2));
} finally { await mf.dispose(); }
