import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publishHostedInputs,currentHostedInputs,restoreHostedInputs} from '../scripts/catalog/hosted-inputs.ts';
function memory(){const data=new Map();let n=0;return{data,async get(k){return data.get(k)??null;},
  async putImmutable(k,bytes){const old=data.get(k);if(old&&!Buffer.from(old.bytes).equals(bytes))throw Error('conflict');
    const value=old??{bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(k,value);return value;},
  async compareAndSwap(k,etag,bytes){if((data.get(k)?.etag??null)!==etag)throw Error('conflict');
    const value={bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(k,value);return value;},async remove(){throw Error('no removal');}};}
async function base(t){const value=await realpath(await mkdtemp(path.join(os.tmpdir(),'hosted-inputs-')));t.after(()=>rm(value,{recursive:true,force:true}));return value;}
const file=value=>({relative:'daily-catalog-care/automation-policy.json',bytes:Buffer.from(JSON.stringify(value)+'\n')});
test('versioned inputs restore exact metadata while pending runs keep their original reference',async t=>{
  const store=memory(),first=await publishHostedInputs(store,[file({schemaVersion:1,enabled:false})],null);
  const old=store.data.get('pointers/operator-inputs.json').bytes;
  const second=await publishHostedInputs(store,[file({schemaVersion:1,enabled:true})],old);
  assert.deepEqual(await currentHostedInputs(store),second);
  const directory=await base(t);await restoreHostedInputs(store,directory,first);
  assert.equal(JSON.parse(await readFile(path.join(directory,file({}).relative))).enabled,false);
  await assert.rejects(restoreHostedInputs(store,directory,second),/inputs_invalid/);
});
test('inputs reject path escapes, locks, secret paths, corrupt bodies and stale pointer replacement',async t=>{
  const store=memory();
  for(const relative of ['../escape.json','locks/owner.json','credentials.json'])
    await assert.rejects(publishHostedInputs(store,[{relative,bytes:Buffer.from('{}')}],null),/inputs_invalid/);
  const ref=await publishHostedInputs(store,[file({schemaVersion:1})],null);
  await assert.rejects(publishHostedInputs(store,[file({schemaVersion:2})],null),/inputs_invalid/);
  const manifest=JSON.parse(store.data.get(ref.key).bytes);store.data.get(manifest.files[0].key).bytes=Buffer.from('{"changed":true}');
  await assert.rejects(restoreHostedInputs(store,await base(t),ref),/inputs_invalid/);
});
