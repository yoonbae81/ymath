import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifestSnapshot, compareManifests } from './cloudflare-migrate.mjs';

test('rejects nonexistent and symlink snapshot roots', async () => {
 const root=await mkdtemp(join(tmpdir(),'ymath-migrate-path-'));
 try {
  await assert.rejects(manifestSnapshot(join(root,'missing')));
  await mkdir(join(root,'real')); await symlink(join(root,'real'),join(root,'link'));
  await assert.rejects(manifestSnapshot(join(root,'link')),/snapshot/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('dry run inventories only explicit item/report data and rejects missing image references', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ymath-migrate-unit-'));
 try {
  const id='20261017-080000-abcd';
  await mkdir(join(root,'items',id),{recursive:true});
  await mkdir(join(root,'reports'),{recursive:true});
  await writeFile(join(root,'session-secret'),'DO-NOT-READ');
  await writeFile(join(root,'items',id,'record.json'),JSON.stringify({id,status:'done',image:'image.jpg',feedback:[{choice:'accurate'}]}));
  await assert.rejects(manifestSnapshot(root),/image/);
  await writeFile(join(root,'items',id,'image.jpg'),Buffer.from([1,2,3]));
  const manifest=await manifestSnapshot(root);
  assert.deepEqual(manifest.itemIds,[id]);
  assert.equal(manifest.files.length,2);
  assert.equal(manifest.files.every(f=>f.sha256.length===64),true);
  assert.deepEqual(compareManifests(manifest,manifest),[]);
  assert.equal(compareManifests(manifest,{...manifest,files:manifest.files.slice(1)}).length>0,true);
  assert.equal(await readFile(join(root,'session-secret'),'utf8'),'DO-NOT-READ');
 } finally { await rm(root,{recursive:true,force:true}); }
});
