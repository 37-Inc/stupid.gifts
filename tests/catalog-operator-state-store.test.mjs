import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm,readFile,realpath} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createOperatorStateStore} from '../scripts/catalog/operator-state-store.ts';

function memory(){const data=new Map();let n=0;return{
  data,async get(key){return data.get(key)??null;},
  async putImmutable(key,bytes){const old=data.get(key);if(old&&!Buffer.from(old.bytes).equals(bytes))throw Error('conflict');
    const value=old??{bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(key,value);return value;},
  async compareAndSwap(key,etag,bytes){if((data.get(key)?.etag??null)!==etag)throw Error('conflict');
    const value={bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(key,value);return value;},
  async remove(){throw Error('no cleanup in operator metadata');},
};}
async function fixture(t){const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'operator-state-')));t.after(()=>rm(base,{recursive:true,force:true}));return base;}
test('immutable operator config restores exact bytes after runner loss',async t=>{
  const base=await fixture(t),remote=memory(),file=path.join(base,'care/run/config.json'),value={source:'a'.repeat(40),inputs:{path:'original'}};
  const store=createOperatorStateStore(base,remote);const bytes=await store.put(file,value);
  await rm(path.join(base,'care'),{recursive:true});assert.deepEqual(await store.bytes(file),bytes);
  await assert.rejects(store.put(file,{source:'changed'}),/conflict/);
});
test('remote failure prevents metadata acceptance and does not leave a local acknowledged file',async t=>{
  const base=await fixture(t),remote=memory();remote.putImmutable=async()=>{throw Error('lost');};
  const file=path.join(base,'config.json');await assert.rejects(createOperatorStateStore(base,remote).put(file,{}),/lost/);
  await assert.rejects(readFile(file),{code:'ENOENT'});
});
test('successor pointer uses exact predecessor CAS and recovers an acknowledged identical value',async t=>{
  const base=await fixture(t),remote=memory(),store=createOperatorStateStore(base,remote),file=path.join(base,'care/last-success.json');
  const first=await store.pointer('last-success',file,{release:'one'},null);
  await store.pointer('last-success',file,{release:'two'},first);
  await store.pointer('last-success',file,{release:'two'},first);
  await assert.rejects(store.pointer('last-success',file,{release:'three'},first),/pointer_conflict/);
  assert.equal(JSON.parse(await store.readPointer('last-success',file)).release,'two');
});
test('state adapter rejects paths outside its protected base',async t=>{
  const base=await fixture(t),store=createOperatorStateStore(base,memory());
  await assert.rejects(store.put(path.join(base,'../escaped.json'),{}),/path/);
});
test('serving-only pointer is separate from the genuine catalog pointer and restores after runner loss',async t=>{
  const base=await fixture(t),remote=memory(),store=createOperatorStateStore(base,remote),file=base+'/care/code-only/last-serving.json',
    catalog=base+'/care/last-success.json',original=await store.pointer('last-success',catalog,{release:'genuine-catalog'},null);
  const first=await store.pointer('code-only-serving',file,{releaseId:'code-one'},null);
  await store.pointer('code-only-serving',file,{releaseId:'code-two'},first);
  await rm(base+'/care',{recursive:true});assert.equal(JSON.parse(await store.readPointer('code-only-serving',file)).releaseId,'code-two');
  assert.deepEqual(await store.readPointer('last-success',catalog),original);
  await assert.rejects(store.pointer('code-only-serving',file,{releaseId:'stale'},first),/pointer_conflict/);
});
