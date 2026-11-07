import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryPublicationPackage } from '../scripts/catalog/publish-release.ts';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function directory(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'publication-package-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}

test('real package inventories retain hashes above10k and accept20,001 files on the existing Standard plan',async t=>{
  const root=await directory(t),suffixes=['.html','.txt','.json','.js','.png'];
  const name=i=>`assets/group-${Math.floor(i/200)}/file-${i}${suffixes[i%suffixes.length]}`;
  const body=i=>Buffer.from([0,255,...Buffer.from(`Synthetic package file ${i}`)]);
  async function add(start,end){
    for(let i=start;i<end;i+=64)await Promise.all(Array.from({length:Math.min(64,end-i)},async(_,offset)=>{
      const n=i+offset,file=path.join(root,name(n));await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
      await fs.writeFile(file,body(n),{mode:0o600});
    }));
  }
  await add(0,15422);
  const realistic=await inventoryPublicationPackage(root);assert.equal(Object.keys(realistic).length,15422);
  for(const i of [0,7711,15421])assert.equal(realistic[name(i)],sha(body(i)));
  await add(15422,20000);
  const boundary=await inventoryPublicationPackage(root);assert.equal(Object.keys(boundary).length,20000);
  assert.equal(boundary[name(19999)],sha(body(19999)));assert.equal(boundary[name(0)],realistic[name(0)]);
  await add(20000,20001);
  const paid=await inventoryPublicationPackage(root);assert.equal(Object.keys(paid).length,20001);
  assert.equal(paid[name(20000)],sha(body(20000)));
});

test('larger inventory allowance preserves private modes, symlink refusal, binary hashes and32MiB per-file bound',async t=>{
  const root=await directory(t),file=path.join(root,'binary.png'),body=Buffer.from([0,255,128,13,10]);
  await fs.writeFile(file,body,{mode:0o600});assert.equal((await inventoryPublicationPackage(root))['binary.png'],sha(body));
  await fs.chmod(file,0o644);await assert.rejects(inventoryPublicationPackage(root),/publication_package_invalid/);
  await fs.chmod(file,0o600);await fs.chmod(root,0o755);
  await assert.rejects(inventoryPublicationPackage(root),/publication_package_invalid/);await fs.chmod(root,0o700);
  const link=path.join(root,'linked.png');await fs.symlink(file,link);
  await assert.rejects(inventoryPublicationPackage(root),/publication_package_invalid/);await fs.unlink(link);await fs.unlink(file);
  const large=await fs.open(path.join(root,'oversized.bin'),'wx',0o600);
  try{await large.truncate(32*1024*1024+1);}finally{await large.close();}
  await assert.rejects(inventoryPublicationPackage(root),/publication_package_invalid/);
});

test('total inventory accepts measured274MiB and exact384MiB packages, but refuses384MiB plus one byte',async t=>{
  const root=await directory(t),chunkBytes=32*1024*1024,measuredBytes=287067746;
  async function sizeFile(index,size){const file=await fs.open(path.join(root,`${index}.bin`),'w',0o600);
    try{await file.truncate(size);}finally{await file.close();}}
  function zeroSha(bytes){const hash=createHash('sha256'),chunk=Buffer.alloc(1024*1024);
    for(let left=bytes;left>0;left-=chunk.length)hash.update(chunk.subarray(0,Math.min(left,chunk.length)));return hash.digest('hex');}
  for(let i=0,left=measuredBytes;left>0;i++,left-=chunkBytes)await sizeFile(i,Math.min(left,chunkBytes));
  const measured=await inventoryPublicationPackage(root);assert.equal(Object.keys(measured).length,9);
  assert.equal(measured['0.bin'],zeroSha(chunkBytes));assert.equal(measured['8.bin'],zeroSha(measuredBytes-8*chunkBytes));
  for(let i=8;i<12;i++)await sizeFile(i,chunkBytes);
  const boundary=await inventoryPublicationPackage(root);assert.equal(Object.keys(boundary).length,12);
  assert.equal(boundary['11.bin'],measured['0.bin']);
  await fs.writeFile(path.join(root,'overflow.bin'),Buffer.from([1]),{mode:0o600});
  await assert.rejects(inventoryPublicationPackage(root),/publication_package_bound/);
});
