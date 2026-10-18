import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, stat, lstat, chmod, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { fixture } from './production-data-cutover.fixture.mjs';

test('prepare seals allowlisted snapshot and independently verified backup with original workbook sort',async()=>{
 const api=await import('./production-data-cutover.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
 assert.equal(typeof api.prepareSnapshot,'function','snapshot preparation is implemented');
 const f=await fixture(),result=await api.prepareSnapshot(f);
 assert.deepEqual(result.counts,{items:1,reports:1,objects:5,analyses:1,feedback:0,workbooks:2});
 assert.match(result.manifestSha256,/^[a-f0-9]{64}$/);
 assert.deepEqual((await api.verifySnapshot(f.snapshot)).manifest,result.manifest);
 assert.deepEqual((await api.verifySnapshot(f.backup)).manifest,result.manifest);
 const vars=JSON.parse(await readFile(join(f.snapshot,'WORKBOOKS_JSON.json'),'utf8'));
 assert.deepEqual(vars.workbooks.map(w=>w.id),['fixture','older']);
 assert.equal((await stat(join(f.snapshot,'data/items',f.id,'image.jpg'))).mode & 0o222,0);
 assert.equal(result.manifest.files.some(file=>file.path.includes('secret')),false);
});

test('active reports fail closed before local artifact creation',async()=>{
 const api=await import('./production-data-cutover.mjs'),f=await fixture();
 const path=join(f.source,'reports',f.reportId+'.json');
 const report=JSON.parse(await readFile(path)); report.status='generating';
 await writeFile(path,JSON.stringify(report));
 await assert.rejects(api.prepareSnapshot(f),/quiescent/);
 await assert.rejects(lstat(f.snapshot),{code:'ENOENT'});
 assert.equal(JSON.parse(await readFile(path)).status,'generating');
});

test('unexpected item artifact, symlink and snapshot tampering are rejected',async()=>{
 const api=await import('./production-data-cutover.mjs');
 const extra=await fixture(); await writeFile(join(extra.source,'items',extra.id,'private.key'),'excluded');
 await assert.rejects(api.prepareSnapshot(extra),/unexpected snapshot item artifact/);
 const linked=await fixture(); await symlink(join(linked.source,'session-secret'),join(linked.source,'items',linked.id,'analysis-other.json'));
 await assert.rejects(api.prepareSnapshot(linked),/regular files only/);
 const f=await fixture(); await api.prepareSnapshot(f);
 const image=join(f.snapshot,'data/items',f.id,'image.jpg'); await chmod(image,0o600); await writeFile(image,'tampered');
 await assert.rejects(api.verifySnapshot(f.snapshot),/manifest\/hash\/count mismatch/);
});

test('CLI prepare is local and apply refuses before remote session without approval gates',async()=>{
 const api=await import('./production-data-cutover.mjs');
 assert.equal(typeof api.runCli,'function','explicit gated CLI is implemented');
 const f=await fixture(); let remoteCalls=0;
 const openRemote=async()=>{remoteCalls++;throw new Error('remote must not open');};
 const args=['--source',f.source,'--workbooks',f.workbooks,'--snapshot',f.snapshot,'--backup',f.backup];
 const prepared=await api.runCli(['prepare',...args],{openRemote});
 assert.equal(prepared.counts.items,1);
 await assert.rejects(api.runCli(['apply',...args],{openRemote}),/apply-remote/);
 const approvalFile=join(f.root,'approval.json');
 await writeFile(approvalFile,JSON.stringify({approvedByParent:true,privacyDecision:'pending'}));
 await assert.rejects(api.runCli(['apply',...args,'--apply-remote','--approval',approvalFile,'--account','a','--database','b','--bucket','c'],{openRemote}),/approval/);
 assert.equal(remoteCalls,0);
});

test('symlinked output ancestor cannot alias source or the independent backup',async()=>{
 const api=await import('./production-data-cutover.mjs'),f=await fixture();
 const alias=join(f.root,'alias'); await symlink(f.source,alias);
 await assert.rejects(api.prepareSnapshot({...f,snapshot:join(alias,'snapshot')}),/separate non-nested/);
 await assert.rejects(lstat(join(f.source,'snapshot')),{code:'ENOENT'});
});

test('a dot-prefixed nested output is not mistaken for parent traversal',async()=>{
 const api=await import('./production-data-cutover.mjs'),f=await fixture();
 await assert.rejects(api.prepareSnapshot({...f,snapshot:join(f.source,'..snapshot')}),/separate non-nested/);
 await assert.rejects(lstat(join(f.source,'..snapshot')),{code:'ENOENT'});
});
