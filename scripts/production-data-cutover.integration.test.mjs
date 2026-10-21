import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile, readdir } from 'node:fs/promises';
import { getPlatformProxy } from 'wrangler';
import { fixture } from './production-data-cutover.fixture.mjs';
import * as api from './production-data-cutover.mjs';

const target={accountId:'fixture-account',databaseId:'fixture-db',bucket:'fixture-bucket'};
function approval(prepared) {
 return {approvedByParent:true,privacyDecision:'access-protected',maintenanceConfirmed:true,expectedEmpty:true,target,manifestSha256:prepared.manifestSha256,expectedCounts:prepared.counts};
}
async function bindings(f) {
 const config=join(f.root,'wrangler.json');
 await writeFile(config,JSON.stringify({name:'cutover-fixture',compatibility_date:'2026-10-17',d1_databases:[{binding:'DB',database_name:'fixture',database_id:'fixture'}],S3_ENDPOINT:'https://s3.example.test',S3_BUCKET:'ymath',S3_REGION:'us-east-1',S3_ACCESS_KEY_ID:'synthetic',S3_SECRET_ACCESS_KEY:'synthetic'));
 const proxy=await getPlatformProxy({configPath:config,persist:{path:join(f.root,'state')},remoteBindings:false,envFiles:[]});
 try {
  const migrations=new URL('../migrations/',import.meta.url);
  for(const name of (await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort()) {
   const sql=(await readFile(new URL(name,migrations),'utf8')).replace(/--[^\n]*/g,'');
   for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) await proxy.env.DB.prepare(statement).run();
  }
  return proxy;
 } catch(error) { await proxy.dispose(); throw error; }
}

test('ambiguous committed response retains every object and retry verifies then resumes',async()=>{
 const f=await fixture(),prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  let lost=false,deletes=0;
  const db={prepare:sql=>proxy.env.DB.prepare(sql),batch:async statements=>{
   const result=await proxy.env.DB.batch(statements);
   if(statements.length===6 && !lost) {lost=true;throw new Error('fixture: committed response lost');}
   return result;
  }};
  const bucket={get:key=>proxy.env.OBJECTS.get(key),put:(...args)=>proxy.env.OBJECTS.put(...args),list:options=>proxy.env.OBJECTS.list(options),delete:()=>{deletes++;throw new Error('must never delete');}};
  const options={...f,applyRemote:true,approval:approval(prepared)};
  await assert.rejects(api.applySnapshot({DB:db,OBJECTS:bucket,target},options),/committed response lost/);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first()).n,2);
  assert.equal((await proxy.env.OBJECTS.list()).objects.length,5);
  assert.equal(deletes,0);
  assert.equal((await api.applySnapshot({...proxy.env,target},options)).resumed,true);
 } finally {await proxy.dispose();}
});

test('empty target guard aborts the whole publication when a writer races staging',async()=>{
 const f=await fixture(),prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  const db={prepare:sql=>proxy.env.DB.prepare(sql),batch:async statements=>{
   if(statements.length===6) await proxy.env.DB.prepare("INSERT INTO entities(id,kind,created_at,status,updated_at) VALUES('racing-writer','item','x','done','x')").run();
   return proxy.env.DB.batch(statements);
  }};
  await assert.rejects(api.applySnapshot({DB:db,OBJECTS:proxy.env.OBJECTS,target},{...f,applyRemote:true,approval:approval(prepared)}),/CHECK constraint failed/);
  assert.deepEqual((await proxy.env.DB.prepare('SELECT id FROM entities').all()).results,[{id:'racing-writer'}]);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first()).n,0);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM migration_files').first()).n,0);
  assert.equal((await proxy.env.DB.prepare('SELECT state FROM cutover_runs').first()).state,'staged');
  assert.equal((await proxy.env.OBJECTS.list()).objects.length,5);
 } finally {await proxy.dispose();}
});
test('production publisher uses real local D1/R2 and resumes only identical verified publications',async()=>{
 assert.equal(typeof api.applySnapshot,'function','approved production publisher is implemented');
 const f=await fixture(),prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  const env={...proxy.env,target},options={...f,applyRemote:true,approval:approval(prepared)};
  const result=await api.applySnapshot(env,options);
  assert.equal(result.published,true);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first()).n,2);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM jobs').first()).n,0);
  const row=await env.DB.prepare('SELECT record_json,image_key,ocr_key FROM entities WHERE id=?').bind(f.id).first();
  assert.equal(row.record_json,await readFile(join(f.source,'items',f.id,'record.json'),'utf8'));
  assert.equal(Buffer.compare(Buffer.from(await (await env.OBJECTS.get(row.image_key)).arrayBuffer()),await readFile(join(f.source,'items',f.id,'image.jpg'))),0);
  assert.equal((await api.applySnapshot(env,options)).resumed,true);
  await env.DB.prepare("UPDATE entities SET deleted_at='fixture-deleted' WHERE id=?").bind(f.id).run();
  await assert.rejects(api.applySnapshot(env,options),/published metadata mismatch/);
  await env.DB.prepare('UPDATE entities SET deleted_at=NULL WHERE id=?').bind(f.id).run();
  await env.DB.prepare("UPDATE entities SET status='failed' WHERE id=?").bind(f.id).run();
  await assert.rejects(api.applySnapshot(env,options),/published metadata mismatch/);
 } finally { await proxy.dispose(); }
});

test('source reactivation during staging blocks publication without deleting uploaded bytes',async()=>{
 const f=await fixture(),prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  let changed=false;
  const bucket={get:key=>proxy.env.OBJECTS.get(key),list:opts=>proxy.env.OBJECTS.list(opts),put:async(...args)=>{
   await proxy.env.OBJECTS.put(...args);
   if(!changed) {changed=true;const path=join(f.source,'reports',f.reportId+'.json');const r=JSON.parse(await readFile(path));r.status='generating';await writeFile(path,JSON.stringify(r));}
  }};
  await assert.rejects(api.applySnapshot({DB:proxy.env.DB,OBJECTS:bucket,target},{...f,applyRemote:true,approval:approval(prepared)}),/quiescent/);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first()).n,0);
  assert.equal((await proxy.env.OBJECTS.list()).objects.length,5);
 } finally {await proxy.dispose();}
});

test('failure after entity INSERT rolls back metadata but retains staging',async()=>{
 const f=await fixture(),prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  const db={prepare:sql=>proxy.env.DB.prepare(sql),batch:async statements=>{
   if(statements.length===6) await proxy.env.DB.prepare("UPDATE cutover_rows SET payload_json=json_set(payload_json,'$.entity_id','missing-parent') WHERE kind='analysis'").run();
   return proxy.env.DB.batch(statements);
  }};
  await assert.rejects(api.applySnapshot({DB:db,OBJECTS:proxy.env.OBJECTS,target},{...f,applyRemote:true,approval:approval(prepared)}),/FOREIGN KEY constraint failed/);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first()).n,0);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM cutover_guards').first()).n,0);
  assert.equal((await proxy.env.OBJECTS.list()).objects.length,5);
 } finally {await proxy.dispose();}
});

test('R2 conflicting bytes fail closed; matching staged upload resumes after transient failure',async()=>{
 const f=await fixture(),prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  let puts=0;
  const bucket={get:key=>proxy.env.OBJECTS.get(key),list:opts=>proxy.env.OBJECTS.list(opts),put:async(...args)=>{if(++puts===2)throw new Error('fixture: upload interrupted');return proxy.env.OBJECTS.put(...args);}};
  const options={...f,applyRemote:true,approval:approval(prepared)};
  await assert.rejects(api.applySnapshot({DB:proxy.env.DB,OBJECTS:bucket,target},options),/upload interrupted/);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first()).n,0);
  assert.equal((await proxy.env.OBJECTS.list()).objects.length,1);
  const key=(await proxy.env.OBJECTS.list()).objects[0].key;
  const original=Buffer.from(await (await proxy.env.OBJECTS.get(key)).arrayBuffer());
  await proxy.env.OBJECTS.put(key,'corrupt');
  await assert.rejects(api.applySnapshot({...proxy.env,target},options),/staged object conflict/);
  assert.equal(await (await proxy.env.OBJECTS.get(key)).text(),'corrupt');
  await proxy.env.OBJECTS.put(key,original);
  assert.equal((await api.applySnapshot({...proxy.env,target},options)).published,true);
 } finally {await proxy.dispose();}
});

test('69-item fixture stages bounded batches and publishes in one six-statement transaction',async()=>{
 const f=await fixture();
 const {mkdir}=await import('node:fs/promises');
 for(let i=1;i<69;i++) {
  const id='20261017-080000-'+i.toString(36).padStart(4,'0'),folder=join(f.source,'items',id);
  await mkdir(folder);
  for(const name of await readdir(join(f.source,'items',f.id))) {
   let bytes=await readFile(join(f.source,'items',f.id,name));
   if(name==='record.json') bytes=JSON.stringify({...f.record,id});
   await writeFile(join(folder,name),bytes);
  }
 }
 const prepared=await api.prepareSnapshot(f),proxy=await bindings(f);
 try {
  const sizes=[];
  const db={prepare:sql=>proxy.env.DB.prepare(sql),batch:async statements=>{sizes.push(statements.length);return proxy.env.DB.batch(statements);}};
  const result=await api.applySnapshot({DB:db,OBJECTS:proxy.env.OBJECTS,target},{...f,applyRemote:true,approval:approval(prepared)});
  assert.equal(result.counts.items,69);assert.equal(result.counts.reports,1);assert.equal(result.counts.objects,277);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first()).n,70);
  assert.equal((await proxy.env.DB.prepare('SELECT COUNT(*) AS n FROM analyses').first()).n,69);
  assert.ok(sizes.slice(0,-1).every(n=>n<=25)); assert.equal(sizes.at(-1),6);assert.ok(sizes.length>3);
  console.log(JSON.stringify({fixtureOnly:true,items:69,reports:1,shaVerifiedObjects:277,stageBatches:sizes.slice(0,-1).length,maxStageStatements:Math.max(...sizes.slice(0,-1)),publishStatements:sizes.at(-1),remote:false}));
 } finally {await proxy.dispose();}
});
