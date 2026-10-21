import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile, chmod, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { resolve, join, dirname, relative, basename } from 'node:path';
import { manifestSnapshot, compareManifests } from './cloudflare-migrate.mjs';

export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const TABLES=['entities','analyses','feedback','jobs','report_outbox','item_outbox','inngest_slice_jobs'];
const STAGE_DDL=[
 'CREATE TABLE IF NOT EXISTS cutover_runs (run_id TEXT PRIMARY KEY, manifest_json TEXT NOT NULL, target_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN (\'staged\',\'published\')))',
 'CREATE TABLE IF NOT EXISTS cutover_rows (run_id TEXT NOT NULL, kind TEXT NOT NULL, row_id TEXT NOT NULL, payload_json TEXT NOT NULL, PRIMARY KEY(run_id,kind,row_id))',
 'CREATE TABLE IF NOT EXISTS cutover_guards (run_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1))',
 'CREATE TABLE IF NOT EXISTS migration_files (path TEXT PRIMARY KEY,object_key TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL)'
];
const COLUMNS={
 entity:['id','kind','created_at','status','generation','workbook_json','record_json','image_key','ocr_key','favorite','viewed_at','updated_at','report_json','report_key'],
 analysis:['entity_id','provider','generation','analysis_key','meta_json','flags_json','created_at'],
 feedback:['entity_id','analyzed_at','payload_json','updated_at'],
 file:['path','object_key','sha256','bytes']
};
COLUMNS.entity.push('current_analysis_key','raw_key','deleted_at','idempotency_key');
const DEST={entity:'entities',analysis:'analyses',feedback:'feedback',file:'migration_files'};
function canonical(value) { if(Array.isArray(value)) return JSON.stringify(value.map(v=>JSON.parse(canonical(v)))); if(value&&typeof value==='object') return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))]))); return JSON.stringify(value); }
const equal=(a,b)=>canonical(a)===canonical(b);
async function queryRows(db,sql,params=[]) { return (await db.prepare(sql).bind(...params).all()).results; }
async function emptyTarget(db) {
 for(const table of TABLES) if((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n!==0) throw new Error('migration target must be empty: '+table);
 const exists=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='migration_files'").first();
 if(exists && (await db.prepare('SELECT COUNT(*) AS n FROM migration_files').first()).n!==0) throw new Error('migration target must be empty: migration_files');
}
async function buildRows(snapshot,manifest,prefix) {
 const rows=[];
 const add=(kind,id,value)=>rows.push({kind,id,value:kind==='entity'?{current_analysis_key:null,raw_key:null,deleted_at:null,idempotency_key:null,...value}:value});
 const key=path=>prefix+path;
 for(const f of manifest.files) add('file',f.path,{path:f.path,object_key:key(f.path),sha256:f.sha256,bytes:f.bytes});
 for(const id of manifest.itemIds) {
  const text=(await regular(join(snapshot,'data/items',id,'record.json'))).toString(),r=JSON.parse(text);
  const base=`items/${id}/`;
  add('entity',id,{id,kind:'item',created_at:r.created_at,status:r.status,generation:1,workbook_json:JSON.stringify(r.workbook),record_json:text,image_key:key(base+'image.jpg'),ocr_key:manifest.files.some(f=>f.path===base+'ocr.md')?key(base+'ocr.md'):null,favorite:r.favorite?1:0,viewed_at:r.viewed_at??null,updated_at:r.created_at,report_json:null,report_key:null});
  for(const f of r.feedback??[]) add('feedback',id+'/'+f.analyzed_at,{entity_id:id,analyzed_at:f.analyzed_at,payload_json:JSON.stringify(f),updated_at:f.created_at??r.created_at});
  for(const f of manifest.files.filter(f=>f.path.startsWith(base+'analysis-'))) {
   const saved=JSON.parse(await regular(join(snapshot,'data',f.path))),provider=f.path.split('/').at(-1).slice(9,-5);
   add('analysis',id+'/'+provider,{entity_id:id,provider,generation:1,analysis_key:key(f.path),meta_json:JSON.stringify(saved.meta),flags_json:JSON.stringify(saved.flags),created_at:saved.meta.analyzed_at});
  }
 }
 for(const id of manifest.reportIds) {
  const r=JSON.parse(await regular(join(snapshot,'data/reports',id+'.json')));
  add('entity',id,{id,kind:'report',created_at:r.created_at,status:r.status,generation:1,workbook_json:null,record_json:null,image_key:null,ocr_key:null,favorite:0,viewed_at:null,updated_at:r.created_at,report_json:JSON.stringify({...r,markdown:null}),report_key:key(`reports/${id}.json`)});
 }
 return rows;
}
async function verifyMetadata(db,rows) {
 for(const [kind,table] of Object.entries(DEST)) {
  const expected=rows.filter(r=>r.kind===kind).map(r=>r.value),actual=await queryRows(db,`SELECT ${COLUMNS[kind].join(',')} FROM ${table}`);
  const sort=list=>list.map(canonical).sort();
  if(!equal(sort(expected),sort(actual))) throw new Error('published metadata mismatch: '+table);
 }
 for(const table of TABLES.slice(3)) if((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n!==0) throw new Error('unexpected queued work: '+table);
 const broken=await queryRows(db,'PRAGMA foreign_key_check'); if(broken.length) throw new Error('published foreign key references broken');
}
async function objectBytes(bucket,key) { const obj=await bucket.get(key); return obj?Buffer.from(await obj.arrayBuffer()):null; }
async function verifyObjects(bucket,manifest,prefix) {
 for(const file of manifest.files) { const bytes=await objectBytes(bucket,prefix+file.path); if(!bytes || bytes.length!==file.bytes || sha256(bytes)!==file.sha256) throw new Error('target object hash/bytes mismatch: '+file.path); }
}
async function verifyBucketScope(bucket,prefix,manifest) {
 const allowed=new Set(manifest.files.map(f=>prefix+f.path)); let cursor;
 do { const result=await bucket.list({cursor,limit:1000}); for(const obj of result.objects) if(!allowed.has(obj.key)) throw new Error('target bucket must be empty except identical run staging'); cursor=result.truncated?result.cursor:undefined; } while(cursor);
}
async function approvedLocalInput(options,target) {
 const {snapshot,backup,source,workbooks,applyRemote,approval:a}=options;
 if(applyRemote!==true || a?.approvedByParent!==true || a.maintenanceConfirmed!==true || a.expectedEmpty!==true || !['access-protected','public-approved'].includes(a.privacyDecision)) throw new Error('explicit parent/privacy/maintenance/empty-target approval required');
 if(!equal(a.target,target) || !a.target?.accountId || !a.target?.databaseId || !a.target?.bucket) throw new Error('approved target identity mismatch');
 await separate([source,snapshot,backup]);
 const verified=await verifySnapshot(snapshot),saved=await verifySnapshot(backup);
 if(a.manifestSha256!==verified.manifestSha256 || saved.manifestSha256!==verified.manifestSha256 || !equal(a.expectedCounts,verified.counts)) throw new Error('approved manifest/counts or verified backup mismatch');
 const current=await inspect(source,await workbookBytes(workbooks));
 if(!equal(current,verified.manifest)) throw new Error('source changed since approved snapshot');
 return verified;
}
/** Explicit approval gates run BEFORE any target access. Never delete staged R2 bytes, including ambiguous commits. */
export async function applySnapshot(env,options) {
 const {snapshot,approval:a}=options;
 const verified=await approvedLocalInput(options,env.target);
 const {manifest,manifestSha256:run}=verified,prefix=`cutover/${run}/`,db=env.DB,bucket=env.OBJECTS;
 const rows=await buildRows(snapshot,manifest,prefix);
 await verifyBucketScope(bucket,prefix,manifest);
 const hasRuns=await db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='cutover_runs'").first();
 const existing=hasRuns?await db.prepare('SELECT * FROM cutover_runs WHERE run_id=?').bind(run).first():null;
 if(existing && (!equal(JSON.parse(existing.manifest_json),manifest)||!equal(JSON.parse(existing.target_json),a.target))) throw new Error('run identity conflict');
 if(existing?.state==='published') {
  await verifyMetadata(db,rows); await verifyObjects(bucket,manifest,prefix);
  return {...verified,published:true,resumed:true,prefix};
 }
 await emptyTarget(db);
 if(hasRuns && (await queryRows(db,'SELECT run_id FROM cutover_runs')).some(r=>r.run_id!==run)) throw new Error('another migration run exists');
 // DDL and stage data never expose application entities.
 for(const sql of STAGE_DDL) await db.prepare(sql).run();
 await db.prepare("INSERT INTO cutover_runs(run_id,manifest_json,target_json,state) VALUES(?,?,?,'staged') ON CONFLICT(run_id) DO NOTHING").bind(run,JSON.stringify(manifest),JSON.stringify(a.target)).run();
 for(const file of manifest.files) {
  const key=prefix+file.path,prior=await objectBytes(bucket,key);
  if(prior && (prior.length!==file.bytes||sha256(prior)!==file.sha256)) throw new Error('staged object conflict: '+file.path);
  if(!prior) {
   const bytes=await regular(join(snapshot,'data',file.path));
   if(bytes.length!==file.bytes||sha256(bytes)!==file.sha256) throw new Error('snapshot changed before PUT');
   await bucket.put(key,bytes);
  }
  const readback=await objectBytes(bucket,key);
  if(!readback||readback.length!==file.bytes||sha256(readback)!==file.sha256) throw new Error('target object hash/bytes mismatch: '+file.path);
 }
 for(let offset=0;offset<rows.length;offset+=25) {
  await db.batch(rows.slice(offset,offset+25).map(row=>db.prepare('INSERT INTO cutover_rows(run_id,kind,row_id,payload_json) VALUES(?,?,?,?) ON CONFLICT(run_id,kind,row_id) DO NOTHING').bind(run,row.kind,row.id,JSON.stringify(row.value))));
 }
 const staged=await queryRows(db,'SELECT kind,row_id,payload_json FROM cutover_rows WHERE run_id=?',[run]);
 if(!equal(staged.map(r=>canonical([r.kind,r.row_id,JSON.parse(r.payload_json)])).sort(),rows.map(r=>canonical([r.kind,r.id,r.value])).sort())) throw new Error('staged metadata conflict');
 await verifyObjects(bucket,manifest,prefix);
 await approvedLocalInput(options,env.target); // Recheck source quiescence/counts/hashes immediately before publication.
 const noLive=[...TABLES,'migration_files'].map(t=>`(SELECT COUNT(*) FROM ${t})=0`).join(' AND ');
 const statements=[db.prepare(`INSERT INTO cutover_guards(run_id,ok) SELECT ?,CASE WHEN ${noLive} AND (SELECT COUNT(*) FROM cutover_rows WHERE run_id=?)=? THEN 1 ELSE 0 END`).bind(run,run,rows.length)];
 for(const [kind,table] of Object.entries(DEST)) {
  const cols=COLUMNS[kind];
  statements.push(db.prepare(`INSERT INTO ${table}(${cols.join(',')}) SELECT ${cols.map(c=>`json_extract(payload_json,'$.${c}')`).join(',')} FROM cutover_rows WHERE run_id=? AND kind=?`).bind(run,kind));
 }
 statements.push(db.prepare("UPDATE cutover_runs SET state='published' WHERE run_id=? AND state='staged'").bind(run));
 // Six statements regardless of item count. D1 batch is transactional; stage chunks <=25, <=100 bound values.
 // On ANY error retain objects and stage evidence. A lost response may mean metadata is live.
 await db.batch(statements);
 await verifyMetadata(db,rows); await verifyObjects(bucket,manifest,prefix);
 const state=await db.prepare('SELECT state FROM cutover_runs WHERE run_id=?').bind(run).first();
 if(state?.state!=='published') throw new Error('publication state verification failed');
 return {...verified,published:true,resumed:false,prefix};
}
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
async function regular(path) {
 const s=await lstat(path); if(!s.isFile() || s.isSymbolicLink()) throw new Error('regular file required');
 return readFile(path);
}
async function canonicalPath(path) {
 const absolute=resolve(path);
 try {return await realpath(absolute);} catch(error) {
  if(error.code!=='ENOENT') throw error;
  return join(await canonicalPath(dirname(absolute)),basename(absolute));
 }
}
async function separate(paths) {
 const absolute=await Promise.all(paths.map(canonicalPath));
 for(let i=0;i<absolute.length;i++) for(let j=i+1;j<absolute.length;j++) {
  const r=relative(absolute[i],absolute[j]),s=relative(absolute[j],absolute[i]);
  const child=r=>r!==''&&r!=='..'&&!r.startsWith('../');
  if(!r || child(r) || child(s)) throw new Error('source, snapshot and backup must be separate non-nested paths');
 }
}
async function newFile(path,bytes) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,bytes,{flag:'wx',mode:0o600}); }
async function seal(root) {
 for(const name of await readdir(root)) { const p=join(root,name),s=await lstat(p); if(s.isDirectory()) await seal(p); else await chmod(p,0o400); }
 await chmod(root,0o500);
}
async function workbookBytes(path) {
 const parsed=JSON.parse(await regular(path));
 if(!Array.isArray(parsed.workbooks) || (parsed.publisherOrder!==undefined && (!Array.isArray(parsed.publisherOrder)||parsed.publisherOrder.some(p=>typeof p!=='string')))) throw new Error('invalid workbook list');
 const seen=new Set();
 const list=parsed.workbooks.map(w=>{
  const allowed=['id','name','publisher','grade','semester'];
  if(Object.keys(w).some(k=>!allowed.includes(k)) || allowed.slice(0,4).some(k=>typeof w[k]!=='string'||!w[k]) || !Number.isInteger(w.semester) || seen.has(w.id)) throw new Error('invalid/duplicate workbook or non-allowlisted workbook fields');
  seen.add(w.id); return w;
 });
 // Reuse, do not approximate, the application's grade/publisher/semester/Korean-name ordering.
 const {sortWorkbooks}=await import('../src/lib/server/config.ts');
 return jsonBytes({workbooks:sortWorkbooks(list,parsed.publisherOrder??[])});
}
async function inspect(root,vars) {
 const manifest=await manifestSnapshot(root),workbooks=JSON.parse(vars).workbooks;
 if(!Array.isArray(workbooks)) throw new Error('invalid WORKBOOKS_JSON');
 const workbookIds=new Set(workbooks.map(w=>w.id)); let analyses=0,feedback=0;
 for(const id of manifest.itemIds) {
  const r=JSON.parse(await regular(join(root,'items',id,'record.json')));
  if(!['done','failed'].includes(r.status) || !r.created_at || !workbookIds.has(r.workbook?.id)) throw new Error('source must be quiescent with known workbook references');
  const seen=new Set();
  for(const f of r.feedback??[]) { if(!f.analyzed_at || seen.has(f.analyzed_at)) throw new Error('invalid/duplicate feedback reference'); seen.add(f.analyzed_at); feedback++; }
 }
 for(const id of manifest.reportIds) {
  const r=JSON.parse(await regular(join(root,'reports',id+'.json')));
  if(!['done','failed'].includes(r.status) || !r.created_at || (r.status==='done' && typeof r.markdown!=='string')) throw new Error('source report must be quiescent and completed reports need markdown');
 }
 for(const file of manifest.files.filter(f=>/\/analysis-/.test(f.path))) {
  const saved=JSON.parse(await regular(join(root,file.path))),provider=file.path.split('/').at(-1).slice(9,-5);
  if(saved.meta?.provider!==provider || !saved.meta.analyzed_at || !saved.analysis || !saved.flags) throw new Error('invalid provider analysis reference');
  analyses++;
 }
 return {version:1,...manifest,workbooksSha256:sha256(vars),counts:{items:manifest.itemIds.length,reports:manifest.reportIds.length,objects:manifest.files.length,analyses,feedback,workbooks:workbooks.length}};
}
export async function verifySnapshot(root) {
 const s=await lstat(root); if(!s.isDirectory()||s.isSymbolicLink()) throw new Error('snapshot root must be real directory');
 const names=(await readdir(root)).sort();
 if(JSON.stringify(names)!==JSON.stringify(['WORKBOOKS_JSON.json','data','manifest.json'])) throw new Error('unexpected snapshot root artifact');
 const raw=await regular(join(root,'manifest.json')),manifest=JSON.parse(raw),vars=await regular(join(root,'WORKBOOKS_JSON.json'));
 const current=await inspect(join(root,'data'),vars);
 if(JSON.stringify(current)!==JSON.stringify(manifest)) throw new Error('snapshot manifest/hash/count mismatch');
 return {manifest,manifestSha256:sha256(raw),counts:manifest.counts};
}
/** No network, secret/config directory traversal or source writes. Explicit workbooks.json only. */
export async function prepareSnapshot({source,workbooks,snapshot,backup}) {
 await separate([source,snapshot,backup]);
 const vars=await workbookBytes(workbooks),manifest=await inspect(source,vars),raw=jsonBytes(manifest);
 // Source quiescence and semantic checks precede even local artifact creation.
 for(const destination of [snapshot,backup]) {
  await mkdir(destination,{recursive:false});
  await mkdir(join(destination,'data'));
  for(const file of manifest.files) {
   const bytes=await regular(join(source,file.path));
   if(bytes.length!==file.bytes || sha256(bytes)!==file.sha256) throw new Error('source changed during snapshot');
   await newFile(join(destination,'data',file.path),bytes);
  }
  await newFile(join(destination,'WORKBOOKS_JSON.json'),vars);
  await newFile(join(destination,'manifest.json'),raw);
  await verifySnapshot(destination);
 }
 if(compareManifests(manifest,await manifestSnapshot(source)).length || sha256(await workbookBytes(workbooks))!==manifest.workbooksSha256) throw new Error('source changed during snapshot');
 await seal(snapshot); await seal(backup);
 return {manifest,manifestSha256:sha256(raw),counts:manifest.counts};
}

async function openRemote(target) {
 if(!/^[a-f0-9]{32}$/.test(target.accountId)||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(target.databaseId)||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(target.bucket)) throw new Error('invalid explicit production target identifiers');
 const root=await mkdtemp(join(tmpdir(),'ymath-approved-remote-'));
 const configPath=join(root,'wrangler.json');
 // No repository configuration, .env, Worker secrets, LLM bindings, app code or schema migration.
 await writeFile(configPath,JSON.stringify({name:'ymath-approved-data-cutover',account_id:target.accountId,compatibility_date:'2026-10-17',d1_databases:[{binding:'DB',database_name:'approved-cutover-target',database_id:target.databaseId,remote:true}],S3_ENDPOINT:target.s3Endpoint||'https://s3.xcv.kr',S3_BUCKET:target.bucket,S3_REGION:'us-east-1',S3_ACCESS_KEY_ID:target.accessKeyId,S3_SECRET_ACCESS_KEY:target.secretKey]}),{flag:'wx',mode:0o600});
 try {
  const {getPlatformProxy}=await import('wrangler');
  const proxy=await getPlatformProxy({configPath,remoteBindings:true,envFiles:[],persist:false});
  return {env:{DB:proxy.env.DB,OBJECTS:proxy.env.OBJECTS,target},dispose:async()=>{try{await proxy.dispose();}finally{await rm(root,{recursive:true,force:true});}}};
 } catch(error) {await rm(root,{recursive:true,force:true});throw error;}
}
export async function runCli(argv,{openRemote:open=openRemote}={}) {
 const [mode,...args]=argv,options={};
 if(!['prepare','verify','apply'].includes(mode)) throw new Error('usage: prepare|verify|apply with explicit paths; production apply requires --apply-remote and --approval FILE');
 const allowed=new Set(['source','workbooks','snapshot','backup','approval','account','database','bucket','apply-remote']);
 for(let i=0;i<args.length;i++) {
  const arg=args[i]; if(!arg.startsWith('--')||!allowed.has(arg.slice(2))||Object.hasOwn(options,arg.slice(2))) throw new Error('unknown/duplicate option');
  const name=arg.slice(2);
  if(name==='apply-remote') options[name]=true;
  else { if(!args[i+1]||args[i+1].startsWith('--')) throw new Error('option value required'); options[name]=args[++i]; }
 }
 for(const key of mode==='verify'?['snapshot']:['source','workbooks','snapshot','backup']) if(!options[key]) throw new Error('explicit '+key+' path required');
 if(mode==='verify') return {...await verifySnapshot(options.snapshot),remote:false};
 if(mode==='prepare') {if(options['apply-remote']) throw new Error('prepare never accepts --apply-remote');return {...await prepareSnapshot(options),remote:false};}
 if(!options['apply-remote']||!options.approval) throw new Error('apply requires --apply-remote and --approval FILE after parent approval');
 const target={accountId:options.account,databaseId:options.database,bucket:options.bucket};
 for(const key of Object.keys(target)) if(!target[key]) throw new Error('explicit target identity required');
 const apply={...options,applyRemote:true,approval:JSON.parse(await regular(options.approval))};
 await approvedLocalInput(apply,target); // Before remote proxy creation, auth lookup or target access.
 const proxy=await open(target);
 try {return {...await applySnapshot(proxy.env,apply),remote:true};} finally {await proxy.dispose();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 try {
  const result=await runCli(process.argv.slice(2));
  console.log(JSON.stringify({mode:process.argv[2],remote:result.remote,counts:result.counts,manifestSha256:result.manifestSha256,published:result.published??false,resumed:result.resumed??false}));
 } catch(error) {console.error('cutover blocked: '+error.message);process.exitCode=1;}
}
