import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const ITEM=/^\d{8}-\d{6}-[a-z0-9]{4}$/;
const REPORT=/^\d{8}-\d{6}-rep-[a-z0-9]{4}$/;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function directory(path) { try { const s=await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error('snapshot directory required'); return await readdir(path); } catch(e) { if(e.code==='ENOENT') return []; throw e; } }
async function bytesAt(path) { const s=await lstat(path); if(!s.isFile() || s.isSymbolicLink()) throw new Error('snapshot regular files only'); return readFile(path); }

/** Explicit data-root input. Never enumerates user config, root secrets or unrelated files. */
export async function manifestSnapshot(root) {
 const rootStat=await lstat(root);
 if(!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('snapshot root must be a real directory');
 const itemIds=[],reportIds=[],files=[];
 async function add(path) { const bytes=await bytesAt(join(root,path)); files.push({path,bytes:bytes.length,sha256:sha(bytes)}); }
 for(const id of (await directory(join(root,'items'))).sort()) {
  if(!ITEM.test(id)) throw new Error('invalid snapshot item identifier');
  const names=await directory(join(root,'items',id));
  if(!names.includes('record.json')) throw new Error('missing item record');
  const record=JSON.parse(await bytesAt(join(root,'items',id,'record.json')));
  if(record.id!==id || record.image!=='image.jpg' || !names.includes('image.jpg')) throw new Error('invalid image reference');
  if(['queued','ocr','analyzing'].includes(record.status)) throw new Error('snapshot must be quiescent: active item');
  itemIds.push(id);
  for(const name of names.sort()) {
   if(!/^(record\.json|image\.jpg|ocr\.md|analysis-[a-z0-9]+\.json)$/.test(name)) throw new Error('unexpected snapshot item artifact');
   await add(`items/${id}/${name}`);
  }
 }
 for(const name of (await directory(join(root,'reports'))).sort()) {
  if(!name.endsWith('.json') || !REPORT.test(name.slice(0,-5))) throw new Error('invalid snapshot report identifier');
  const record=JSON.parse(await bytesAt(join(root,'reports',name)));
  if(record.id!==name.slice(0,-5) || !Array.isArray(record.item_ids) || record.item_ids.some(id=>!itemIds.includes(id))) throw new Error('broken report reference');
  if(['queued','generating'].includes(record.status)) throw new Error('snapshot must be quiescent: active report');
  reportIds.push(record.id); await add(`reports/${name}`);
 }
 return {version:1,itemIds,reportIds,files:files.sort((a,b)=>a.path.localeCompare(b.path))};
}
export function compareManifests(a,b) {
 const errors=[];
 for(const field of ['itemIds','reportIds']) if(JSON.stringify([...a[field]].sort())!==JSON.stringify([...b[field]].sort())) errors.push(`${field} mismatch`);
 const x=new Map(a.files.map(f=>[f.path,f])), y=new Map(b.files.map(f=>[f.path,f]));
 for(const path of new Set([...x.keys(),...y.keys()])) if(x.get(path)?.sha256!==y.get(path)?.sha256 || x.get(path)?.bytes!==y.get(path)?.bytes) errors.push(`object mismatch: ${path}`);
 return errors;
}

async function writeNew(path,bytes) { await mkdir(dirname(path),{recursive:true}); await writeFile(path,bytes,{flag:'wx'}); }
async function r2Bytes(env,key) { const object=await env.OBJECTS.get(key); if(!object) throw new Error('missing migration object'); return Buffer.from(await object.arrayBuffer()); }

export async function initializeLocalDatabase(env) {
 const directory=new URL('../migrations/',import.meta.url);
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS d1_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)').run();
 for(const name of (await readdir(directory)).filter(n=>/^\d+_.+\.sql$/.test(n)).sort()) {
  if(await env.DB.prepare('SELECT 1 AS ok FROM d1_migrations WHERE name=?').bind(name).first()) continue;
  const sql=await readFile(new URL(name,directory),'utf8');
  for(const statement of sql.split(';').map(s=>s.trim()).filter(Boolean)) await env.DB.prepare(statement).run();
  await env.DB.prepare('INSERT INTO d1_migrations(name,applied_at) VALUES(?,?)').bind(name,new Date().toISOString()).run();
 }
}

/** LOCAL bindings only. Caller must explicitly create an isolated proxy with remoteBindings:false. */
export async function importLocalSnapshot(env,source,backup) {
 const manifest=await manifestSnapshot(source);
 if(resolve(source)===resolve(backup)) throw new Error('backup must be separate');
 const count=await env.DB.prepare('SELECT COUNT(*) AS n FROM entities').first();
 if(count.n!==0) throw new Error('migration target must be empty');
 // A complete verified backup must exist before the first target write.
 for(const file of manifest.files) await writeNew(join(backup,file.path),await bytesAt(join(source,file.path)));
 if(compareManifests(manifest,await manifestSnapshot(backup)).length) throw new Error('backup verification failed');
 const prefix=`migration/${crypto.randomUUID()}/`,keys=new Map();
 await env.DB.prepare('CREATE TABLE IF NOT EXISTS migration_files (path TEXT PRIMARY KEY,object_key TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL)').run();
 const statements=[];
 try {
  for(const file of manifest.files) {
   const bytes=await bytesAt(join(source,file.path));
   if(sha(bytes)!==file.sha256) throw new Error('snapshot changed during migration');
   const key=prefix+file.path; keys.set(file.path,key);
   await env.OBJECTS.put(key,bytes);
   if(sha(await r2Bytes(env,key))!==file.sha256) throw new Error('target object verification failed');
   statements.push(env.DB.prepare('INSERT INTO migration_files(path,object_key,sha256,bytes) VALUES(?,?,?,?)').bind(file.path,key,file.sha256,file.bytes));
  }
  const entities=[];
  for(const id of manifest.itemIds) {
   const text=(await bytesAt(join(source,'items',id,'record.json'))).toString(); const r=JSON.parse(text);
   entities.push(env.DB.prepare(`INSERT INTO entities(id,kind,created_at,status,generation,workbook_json,record_json,image_key,ocr_key,favorite,viewed_at,updated_at) VALUES(?,'item',?,?,1,?,?,?,?,?,?,?)`).bind(id,r.created_at,r.status,JSON.stringify(r.workbook),text,keys.get(`items/${id}/image.jpg`),keys.get(`items/${id}/ocr.md`)??null,r.favorite?1:0,r.viewed_at??null,r.created_at));
   for(const f of r.feedback??[]) statements.push(env.DB.prepare('INSERT INTO feedback(entity_id,analyzed_at,payload_json,updated_at) VALUES(?,?,?,?)').bind(id,f.analyzed_at,JSON.stringify(f),f.created_at??r.created_at));
   for(const file of manifest.files.filter(f=>f.path.startsWith(`items/${id}/analysis-`))) {
    const saved=JSON.parse(await bytesAt(join(source,file.path))); const provider=file.path.split('/').at(-1).slice(9,-5);
    if(saved.meta?.provider!==provider) throw new Error('analysis provider reference mismatch');
    statements.push(env.DB.prepare('INSERT INTO analyses(entity_id,provider,generation,analysis_key,meta_json,flags_json,created_at) VALUES(?,?,1,?,?,?,?)').bind(id,provider,keys.get(file.path),JSON.stringify(saved.meta),JSON.stringify(saved.flags),saved.meta.analyzed_at));
   }
  }
  for(const id of manifest.reportIds) {
   const text=(await bytesAt(join(source,'reports',`${id}.json`))).toString(),r=JSON.parse(text);
   entities.push(env.DB.prepare("INSERT INTO entities(id,kind,created_at,status,generation,report_json,report_key,updated_at) VALUES(?,'report',?,?,1,?,?,?)").bind(id,r.created_at,r.status,JSON.stringify({...r,markdown:null}),keys.get(`reports/${id}.json`),r.created_at));
  }
  // All metadata is committed atomically; imported objects remain private until this succeeds.
  await env.DB.batch([...entities,...statements]);
  return manifest;
 } catch(error) { for(const key of keys.values()) await env.OBJECTS.delete(key); throw error; }
}

/** Export current D1 metadata, not just original source bytes: includes post-cutover writes. */
export async function exportLocalSnapshot(env,out) {
 const rows=(await env.DB.prepare('SELECT * FROM entities WHERE deleted_at IS NULL ORDER BY id').all()).results;
 const maps=(await env.DB.prepare('SELECT * FROM migration_files ORDER BY path').all()).results;
 const original=new Map(maps.map(row=>[row.path,row]));
 await mkdir(dirname(resolve(out)),{recursive:true});
 await mkdir(out); // exclusive root: never merge a rollback over retained original data
 const writeJson=async(path,value)=>{
  const prior=original.get(path); let bytes=Buffer.from(JSON.stringify(value,null,2));
  if(prior) { const raw=await r2Bytes(env,prior.object_key); if(JSON.stringify(JSON.parse(raw))===JSON.stringify(value)) bytes=raw; }
  await writeNew(join(out,path),bytes);
 };
 for(const row of rows) {
  if(row.kind==='report') {
   const report=JSON.parse(row.report_json);
   if(report.markdown==null && row.report_key) { try { report.markdown=JSON.parse(await r2Bytes(env,row.report_key)).markdown??null; } catch { report.markdown=null; } }
   await writeJson(`reports/${row.id}.json`,report); continue;
  }
  const r=JSON.parse(row.record_json); r.status=row.status;
  if('favorite' in r || row.favorite) r.favorite=Boolean(row.favorite);
  if('viewed_at' in r || row.viewed_at) r.viewed_at=row.viewed_at;
  const feedback=(await env.DB.prepare('SELECT payload_json FROM feedback WHERE entity_id=? ORDER BY updated_at').bind(row.id).all()).results.map(f=>JSON.parse(f.payload_json));
  if('feedback' in r || feedback.length) r.feedback=feedback;
  await writeJson(`items/${row.id}/record.json`,r);
  if(!row.image_key) throw new Error('cannot rollback item without normalized image');
  await writeNew(join(out,'items',row.id,'image.jpg'),await r2Bytes(env,row.image_key));
  if(row.ocr_key) await writeNew(join(out,'items',row.id,'ocr.md'),await r2Bytes(env,row.ocr_key));
  const analyses=(await env.DB.prepare('SELECT provider,analysis_key FROM analyses WHERE entity_id=?').bind(row.id).all()).results;
  for(const analysis of analyses) {
   if(!/^[a-z0-9]+$/.test(analysis.provider)) throw new Error('invalid analysis provider');
   await writeNew(join(out,'items',row.id,`analysis-${analysis.provider}.json`),await r2Bytes(env,analysis.analysis_key));
  }
 }
 return manifestSnapshot(out);
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const [mode,source,out,state]=process.argv.slice(2);
 if(!source || !out || !['dry-run','apply-local','export-local'].includes(mode)) throw new Error('usage: dry-run SNAPSHOT MANIFEST | apply-local SNAPSHOT BACKUP STATE | export-local STATE OUTPUT');
 if(mode==='dry-run') {
  const manifest=await manifestSnapshot(resolve(source));
  await mkdir(dirname(resolve(out)),{recursive:true});
  await writeFile(out,JSON.stringify(manifest,null,2),{flag:'wx'});
  console.log(JSON.stringify({mode,items:manifest.itemIds.length,reports:manifest.reportIds.length,objects:manifest.files.length,manifest:resolve(out),writesToSource:0}));
 } else {
  const localState=resolve(mode==='apply-local' ? state??'' : source);
  if(mode==='apply-local' && !state) throw new Error('explicit local state path required');
  await mkdir(localState,{recursive:true});
  // Own configuration directory prevents loading repository credential/env files.
  const config=join(localState,`migration-${crypto.randomUUID()}.json`);
  await writeFile(config,JSON.stringify({name:'ymath-local-migration',compatibility_date:'2026-10-17',d1_databases:[{binding:'DB',database_name:'ymath',database_id:'local-only'}],r2_buckets:[{binding:'OBJECTS',bucket_name:'ymath-private'}]}),{flag:'wx'});
  const {getPlatformProxy}=await import('wrangler');
  const proxy=await getPlatformProxy({configPath:config,persist:{path:localState},remoteBindings:false,envFiles:[]});
  try {
   if(mode==='apply-local') {
    await initializeLocalDatabase(proxy.env);
   }
   const manifest=mode==='apply-local' ? await importLocalSnapshot(proxy.env,resolve(source),resolve(out)) : await exportLocalSnapshot(proxy.env,resolve(out));
   console.log(JSON.stringify({mode,items:manifest.itemIds.length,reports:manifest.reportIds.length,objects:manifest.files.length,localState,output:resolve(out),remote:false}));
  } finally { await proxy.dispose(); await (await import('node:fs/promises')).unlink(config); }
 }
}
