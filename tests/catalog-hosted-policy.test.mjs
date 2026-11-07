import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {activateHostedPolicy} from '../scripts/catalog/hosted-policy.mjs';
import {createOperatorStateStore} from '../scripts/catalog/operator-state-store.ts';
import {publishHostedInputs,currentHostedInputs} from '../scripts/catalog/hosted-inputs.ts';
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=v=>Buffer.from(JSON.stringify(v)+'\n'),asin='B000000001';
async function fixture(t){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'hosted-policy-')));t.after(()=>rm(base,{recursive:true,force:true}));
  const data=new Map();let seq=0,writes=0,verified=0;
  const store={async get(k){return data.get(k)??null},async putImmutable(k,b){
    const prior=data.get(k);if(prior&&!Buffer.from(prior.bytes).equals(b))throw Error('conflict');
    if(!prior){writes++;data.set(k,{bytes:Buffer.from(b),etag:'"'+(++seq)+'"'})}return data.get(k);
  },async compareAndSwap(k,e,b){assert.equal(data.get(k)?.etag??null,e);writes++;const v={bytes:Buffer.from(b),etag:'"'+(++seq)+'"'};data.set(k,v);return v}};
  const state=createOperatorStateStore(base,store),care=base+'/daily-catalog-care',runKey='canary-2026-11-06-'+asin,dir=care+'/runs/'+runKey;
  const seal={publication:{releaseId:'canary-release'}},s=await state.put(dir+'/catalog-control.json',seal),
    pointer={control:{path:dir+'/catalog-control.json',sha256:hash(s)},versionReference:'version',manifestSha256:'manifest'};
  await state.put(dir+'/success.json',{result:{state:'finalized'},next:pointer,source:'a'.repeat(40)});
  await state.put(dir+'/hosted-run.json',{kind:'canary',canaryId:asin,runKey,source:'a'.repeat(40)});
  await state.pointer('last-success',care+'/last-success.json',pointer,null);
  await state.pointer('pending-run',care+'/pending-run.json',{schemaVersion:1,pending:null},null);
  const original=await publishHostedInputs(store,[{relative:'daily-catalog-care/automation-policy.json',bytes:bytes({schemaVersion:1,enabled:false,discovery:false,homepage:false})},
    {relative:'daily-catalog-care/campaigns/research-leads.json',bytes:bytes({unchanged:true})}],null);
  return{base,store,state,data,pointer,original,runtime:{base,care,state,durable:store,hosted:true},writes:()=>writes,
    verify:async()=>{verified++;return{releaseId:'canary-release',receiptSha256:'receipt'}},verified:()=>verified};
}
test('activation changes only policy inputs after accepted canary verification',async t=>{
  const f=await fixture(t),pointer=Buffer.from(f.data.get('pointers/last-success.json').bytes);
  const result=await activateHostedPolicy(f.runtime,asin,f.verify);
  assert.equal(result.state,'policy_enabled');assert.equal(f.verified(),1);
  assert.deepEqual(result.policy,{schemaVersion:1,enabled:true,discovery:true,homepage:true});
  assert.deepEqual(f.data.get('pointers/last-success.json').bytes,pointer);
  const manifest=JSON.parse(f.data.get(result.inputsRef.key).bytes);
  const policy=manifest.files.find(x=>x.relative.endsWith('/automation-policy.json'));
  assert.deepEqual(JSON.parse(f.data.get(policy.key).bytes),result.policy);
  assert.notDeepEqual(result.inputsRef,f.original);
  await rm(f.base+'/daily-catalog-care/automation-policy.json');
  assert.deepEqual((await activateHostedPolicy(f.runtime,asin,f.verify)).inputsRef,result.inputsRef);
});
test('wrong canary or active pending run cannot enable policy',async t=>{
  const f=await fixture(t),before=f.writes();
  await assert.rejects(activateHostedPolicy(f.runtime,'B000000002',f.verify),/accepted_canary/);
  f.data.set('pointers/pending-run.json',{bytes:bytes({schemaVersion:1,pending:{path:'active'}}),etag:'"active"'});
  await assert.rejects(activateHostedPolicy(f.runtime,asin,f.verify),/accepted_canary/);
  assert.equal(f.verified(),0);assert.equal(f.writes(),before);
});
test('failed live acceptance proof preserves disabled inputs and successor',async t=>{
  const f=await fixture(t),before=f.writes();
  await assert.rejects(activateHostedPolicy(f.runtime,asin,async()=>{throw Error('not live')}),/not live/);
  assert.deepEqual(await currentHostedInputs(f.store),f.original);assert.equal(f.writes(),before);
});
