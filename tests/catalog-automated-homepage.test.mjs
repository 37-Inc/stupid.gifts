import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {curateAutomationHomepage} from '../scripts/catalog/automated-homepage.mjs';
import {createOperatorStateStore} from '../scripts/catalog/operator-state-store.ts';
const repository=fileURLToPath(new URL('..',import.meta.url)),source=execFileSync('git',['rev-parse','HEAD'],{cwd:repository,encoding:'utf8'}).trim();
async function fixture(t){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'automated-homepage-')));t.after(()=>rm(base,{recursive:true,force:true}));
  const day=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const products=Array.from({length:24},(_,n)=>({id:'B'+String(n).padStart(9,'0'),publicId:'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),
    slug:'test-only-'+n,title:'Owned fixture '+n,description:'A factual owned fixture object.',imageUrl:'https://example.invalid/'+n+'.jpg',
    affiliateUrl:'https://www.amazon.com/dp/B'+String(n).padStart(9,'0')+'?tag=fixture-20',source:'amazon',currency:'USD',price:0,
    isActive:true,qualityScore:.5,eligibleUntil:null,indexable:true}));
  const rows=products.map(p=>({public_display_json:JSON.stringify(p)}));
  const db={prepare(query){return{bind(){return this;},async all(){return{results:query.includes('SELECT public_display_json')?rows:products.map(p=>({product_id:p.id}))};}};},
    async batch(){return[{results:rows},{results:[]},{results:[]},{results:[]}];},metrics(){return{};}};
  const prior={schemaVersion:1,day,anchors:products.slice(0,6).map(p=>p.id),rotation:products.slice(6).map(p=>p.id)};
  const runtime={base,care:path.join(base,'care'),workspace:path.join(base,'workspace'),state:createOperatorStateStore(base)};
  return{runtime,db,seal:{projectionReceipt:{catalog_revision:'test-only'}},prior,day,repository,source};
}
test('optional API edition is durable and an identical invocation never calls the model again',async t=>{
  const f=await fixture(t);let calls=0;
  const complete=async()=>{calls++;return{choices:[{finish_reason:'stop',message:{content:JSON.stringify({anchors:f.prior.anchors,rotation:f.prior.rotation,anchorReplacements:[]})}}]};};
  const first=await curateAutomationHomepage({...f,complete});assert.equal(first.state,'curated',JSON.stringify(first));assert.equal(calls,1);
  const again=await curateAutomationHomepage({...f,complete});assert.equal(again.state,'already_curated');assert.equal(calls,1);
});
test('uncertain API dispatch keeps the prior edition without a repeated model call',async t=>{
  const f=await fixture(t);let calls=0;const complete=async()=>{calls++;throw Error('owned fixture network loss');};
  const first=await curateAutomationHomepage({...f,complete});assert.equal(first.state,'last_good');assert.deepEqual(first.edition,f.prior);
  const again=await curateAutomationHomepage({...f,complete});assert.equal(again.state,'last_good');assert.equal(calls,1);
});
test('fresh runner finishes a saved successful response after edition-save failure without another model call',async t=>{
  const f=await fixture(t),objects=new Map();let sequence=0,calls=0;
  const copy=value=>value?{bytes:new Uint8Array(value.bytes),etag:value.etag}:null,write=(key,bytes)=>{const value={bytes:new Uint8Array(bytes),etag:'"'+(++sequence)+'"'};
    objects.set(key,value);return copy(value);},durable={async get(key){return copy(objects.get(key));},async putImmutable(key,bytes){
      const old=objects.get(key);if(old){assert.deepEqual(old.bytes,new Uint8Array(bytes));return copy(old);}return write(key,bytes);},
    async compareAndSwap(key,etag,bytes){const old=objects.get(key);assert.equal(old?.etag??null,etag);return write(key,bytes);},async remove(){assert.fail('No cleanup in this fixture');}};
  const state=createOperatorStateStore(f.runtime.base,durable),editionFile=path.join(f.runtime.care,'homepage',f.day+'.json');
  const firstRuntime={...f.runtime,durable,state:{...state,async put(file,value){if(file===editionFile)throw Error('synthetic edition-save failure');return state.put(file,value);}}};
  const complete=async()=>{calls++;return{choices:[{finish_reason:'stop',message:{content:JSON.stringify({anchors:f.prior.anchors,rotation:f.prior.rotation,anchorReplacements:[]})}}]};};
  assert.equal((await curateAutomationHomepage({...f,runtime:firstRuntime,complete})).state,'last_good');assert.equal(calls,1);
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'automated-homepage-fresh-')));t.after(()=>rm(base,{recursive:true,force:true}));
  const runtime={base,care:path.join(base,'care'),workspace:path.join(base,'workspace'),durable,state:createOperatorStateStore(base,durable)};
  const resumed=await curateAutomationHomepage({...f,runtime,complete});assert.equal(resumed.state,'curated',JSON.stringify(resumed));assert.equal(calls,1);
  assert.deepEqual(JSON.parse(await runtime.state.bytes(path.join(runtime.care,'homepage',f.day+'.json'))),f.prior);
});
