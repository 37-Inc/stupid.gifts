import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createOperatorStateStore} from '../scripts/catalog/operator-state-store.ts';
import {prepareStaffProduct,staffReady,importStaffPreparation} from '../scripts/catalog/staff-preparation.mjs';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';

test('a completed private preparation survives duplicate wakes and a changed catalog head without new provider work',async t=>{
  const base=await mkdtemp((await realpath(tmpdir()))+'/catalog-staff-');t.after(()=>rm(base,{recursive:true,force:true}));
  const objects=new Map(),write=(k,b)=>{const o={etag:'"'+sha256(Buffer.from(b)).slice(0,20)+'"',bytes:new Uint8Array(b)};objects.set(k,o);return o;};
  const durable={get:async k=>objects.get(k)??null,async putImmutable(k,b){if(objects.has(k)){assert.deepEqual(objects.get(k).bytes,new Uint8Array(b));return objects.get(k);}return write(k,b);},
    async compareAndSwap(k,e,b){assert.equal(objects.get(k)?.etag??null,e);return write(k,b);},remove:async()=>assert.fail('no purge')};
  const runtime={base,care:base+'/care',state:createOperatorStateStore(base,durable),durable};
  const asin='012345678X',day='2026-11-14',now=()=>day+'T10:00:00.000Z',repository=process.cwd(),written=new Map();let calls=0;
  const input={runtime,repository,source:'a'.repeat(40),db:{},row:{request_id:'staff-admit-test-new-book',payload_json:JSON.stringify({asin})},day,now,
    prepare:async({journal,runId})=>{calls++;await journal.put('phase-0-prepared',{schemaVersion:1,items:[],warnings:[],merchandising:{},timingsMs:{},result:{},mutations:[
      {method:'recordEditorialEvent',args:[{runId,productId:asin,eventType:'discovered'}],intent:{}},
      {method:'upsertProduct',args:[{id:asin}],intent:{expectedSourceById:{[asin]:null}}}]});}};
  assert.equal((await prepareStaffProduct(input)).state,'ready');
  assert.equal((await prepareStaffProduct(input)).reused,true);
  const pin=await staffReady(runtime,day,asin),handoff={runtime,repository,pin,now,ws:{},journal:{put:(k,v)=>written.set(k,v)},runId:'new-accepted-head-writer'};
  await importStaffPreparation(handoff);
  assert.equal(written.get('phase-0-prepared').mutations[0].args[0].runId,handoff.runId);
  assert.deepEqual(written.get('phase-0-prepared').mutations[1].intent.expectedSourceById,{[asin]:null});
  assert.equal(calls,1);assert.equal(objects.has('pointers/pending-run.json'),false);
  await assert.rejects(importStaffPreparation({...handoff,now:()=>pin.expiresAt}),/preparation_invalid/);
  await assert.rejects(importStaffPreparation({...handoff,pin:{...pin,manifestSha256:'b'.repeat(64)}}),/preparation_invalid/);
});
