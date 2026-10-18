import { spawn } from 'node:child_process';
import { mkdir, open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const scratchRoot = process.env.TMPDIR ?? '/Users/y/.hermes/profiles/plan/cache/scratch';
if (!scratchRoot.startsWith('/Users/y/.hermes/profiles/plan/cache/scratch')) throw new Error('Node smoke must use isolated task scratch');
const root = join(scratchRoot, `ymath-node-smoke-${process.pid}`);
for (const dir of ['user','data','config','prompts']) await mkdir(join(root,dir),{recursive:true});
await writeFile(join(root,'config','workbooks.json'),JSON.stringify({workbooks:[]}));
const log = await open(join(root,'node-runtime.log'),'w');
const port = 8891;
const child = spawn(process.execPath,['.build'],{cwd:process.cwd(),env:{...process.env,HOST:'127.0.0.1',PORT:String(port),USER_DIR:join(root,'user'),DATA_DIR:join(root,'data'),CONFIG_DIR:join(root,'config'),PROMPTS_DIR:join(root,'prompts')},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',(chunk)=>log.write(chunk)); child.stderr.on('data',(chunk)=>log.write(chunk));
try {
 const end=Date.now()+30_000; let ready=false;
 while(Date.now()<end && !ready) {
  if(child.exitCode!==null) throw new Error(`isolated Node server exited ${child.exitCode}`);
  try { const r=await fetch(`http://127.0.0.1:${port}/math/api/items`); ready=r.status===200; } catch { /* wait for local startup */ }
  if(!ready) await new Promise((resolve)=>setTimeout(resolve,300));
 }
 if(!ready) throw new Error(`isolated Node server did not start; see ${join(root,'node-runtime.log')}`);
 const page=await fetch(`http://127.0.0.1:${port}/math/items`);
 const login=await fetch(`http://127.0.0.1:${port}/math/api/login`,{method:'POST'});
 if(page.status!==200 || login.status!==410) throw new Error(`isolated Node smoke failed: page=${page.status} retired-login=${login.status}`);
 const items=await (await fetch(`http://127.0.0.1:${port}/math/api/items`)).json();
 if(!Array.isArray(items.items) || items.items.length!==0) throw new Error('isolated Node store was not empty');
 console.log(JSON.stringify({result:'PASS',page:page.status,itemsApi:200,retiredLogin:login.status,isolatedRoot:root,actualUserDataRead:false,providerCalls:0}));
} finally { child.kill('SIGTERM'); await new Promise((resolve)=>setTimeout(resolve,500)); await log.close(); }
