import { getPlatformProxy } from 'wrangler';
import { mkdtemp,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { cloudItems } from '../src/lib/server/cloudflare/runtime.ts';
import { validAnalysis } from '../src/lib/server/analysis.fixture.ts';
import { initializeLocalDatabase } from './cloudflare-migrate.mjs';

const root=await mkdtemp(join(tmpdir(),'ymath-list-benchmark-'));
const configPath=join(root,'wrangler.json');
await writeFile(configPath,JSON.stringify({name:'ymath-list-benchmark',compatibility_date:'2026-10-17',d1_databases:[{binding:'DB',database_name:'benchmark',database_id:'local-benchmark'}]}));
const proxy=await getPlatformProxy({configPath,persist:{path:join(root,'state')},remoteBindings:false,envFiles:[]});
try {
 const db=proxy.env.DB;
 await initializeLocalDatabase(proxy.env);
 const statements=[];
 for(let i=0;i<1000;i++) {
  const id=`20261017-080000-${i.toString(36).padStart(4,'0')}`;
  const created='2026-10-17T08:00:00.000Z';
  const r={schema_version:1,id,created_at:created,status:'done',error:null,attempts:1,workbook:{id:'fixture',name:'TEST-ONLY',publisher:'Fixture',grade:'중1',semester:1},image:'image.jpg',flags:{ocr_missing:true,taxonomy_mismatch:[],guardrail:[]},analysis:validAnalysis(),meta:{provider:'codex',model:'TEST-ONLY',prompt_version:'fixture',analyzed_at:created}};
  statements.push(db.prepare("INSERT INTO entities(id,kind,created_at,status,record_json,updated_at) VALUES(?,'item',?,'done',?,?)").bind(id,created,JSON.stringify(r),created));
 }
 for(let i=0;i<statements.length;i+=100) await db.batch(statements.slice(i,i+100));
 let queries=0,rowsRead=0;
 const counted={prepare(sql) { const s=db.prepare(sql); return {async all(){queries++;const r=await s.all(); rowsRead+=r.meta.rows_read;return r;},bind(...values){s.bind(...values);return this;}};}};
 const samples=[]; let maxQueries=0;
 for(let i=0;i<12;i++) {
  const q=queries,start=performance.now(); const items=await cloudItems({DB:counted});
  if(items.length!==1000 || new Set(items.map(r=>r.id)).size!==1000) throw new Error('list fixture count mismatch');
  samples.push(performance.now()-start); maxQueries=Math.max(maxQueries,queries-q);
 }
 if(maxQueries>2) throw new Error('list exceeded constant query budget');
 const sorted=[...samples].sort((a,b)=>a-b);
 const result={mode:'LOCAL TEST-ONLY fixture',items:1000,samplesMs:samples,p50Ms:sorted[Math.ceil(sorted.length*0.5)-1],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1],queriesPerList:maxQueries,totalRowsRead:rowsRead,fixtureRoot:root,productionCPUOrLatency:false};
 await writeFile(join(root,'result.json'),JSON.stringify(result,null,2)); console.log(JSON.stringify(result));
} finally { await proxy.dispose(); }
