import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {repairTitleQueue,readTitleRepairs,selectTitleRepairs} from '../scripts/catalog/title-repairs.mjs';
import {createOperatorStateStore} from '../scripts/catalog/operator-state-store.ts';
import {createCatalogEditorial,createEditorialStages} from '../scripts/catalog/catalog-editorial.mjs';
import {readMerchandising,productTitleView} from '../lib/catalog/merchandising.ts';
import {catalogDisplayView} from '../lib/catalog/display.ts';
import {resolveShortDescriptionAttempt} from '../scripts/ops/catalog-editorial-core.mjs';
import {snapshotKeywordSearch} from '../workers/site/snapshot-search.ts';

const description='A book teaching how to draw optical illusions.';
const product=(id='book')=>({id,slug:id,title:'The Art of Drawing Optical Illusions: More ...',description,eligibleUntil:null});
const empty=()=>({schemaVersion:1,reviews:{},attempts:{}});
const review=p=>({id:p.id,sourceTitle:p.title,sourceDescription:p.description,displayTitle:'The Art of Drawing Optical Illusions'});
async function runtime(t){
  const base=await realpath(await mkdtemp(path.join(os.tmpdir(),'title-repairs-')));
  t.after(()=>rm(base,{recursive:true,force:true}));
  return{care:path.join(base,'care'),state:createOperatorStateStore(base)};
}
const database=products=>({prepare(){return{bind(revision,after){assert.equal(revision,'accepted');
  return{async all(){return{results:products.filter(p=>p.id>after).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,128)
    .map(p=>({public_id:p.id,public_display_json:JSON.stringify(p)}))};}};}};}});
test('current exposure, measured interest, then stable sweep; complete names need no repair',()=>{
  const products=['a','b','c','d'].map(id=>product(id));
  products.push({...product('complete'),title:'Complete book name'});
  assert.deepEqual(selectTitleRepairs(products,empty(),{exposedIds:['c'],priorityIds:['d','b']}).map(p=>p.id),['c','d','b','a']);
  assert.deepEqual(selectTitleRepairs(products,empty(),{limit:2}).map(p=>p.id),['a','b']);
});
test('reviewed display title is consistent, source-bound, idempotent and never mutates catalog/history',()=>{
  const p=product(),snapshot={products:[p],nativeHistory:'retained'},original=structuredClone(snapshot);
  const {id,...signal}=review(p),metadata=readMerchandising({[id]:signal});assert.ok(metadata);
  const displayed=catalogDisplayView(snapshot,metadata).products[0];
  assert.equal(displayed.title,signal.displayTitle);assert.equal(displayed.description,p.description);assert.equal(displayed.slug,p.slug);
  assert.deepEqual(productTitleView(displayed,metadata),displayed);assert.deepEqual(snapshot,original);
  for(const changed of [{...p,title:'Different actual object'},{...p,description:'Different facts'},{...p,id:'foreign'}])
    assert.deepEqual(productTitleView(changed,metadata),changed);
  assert.equal(readMerchandising({book:{...signal,displayTitle:'Still cut off ...'}}),null);
  assert.throws(()=>readTitleRepairs({...empty(),attempts:{'bad/key':'a'.repeat(64)}}),/invalid/);
});
test('database-free keyword search returns the same reviewed name, without models or modifying source',async()=>{
  const p=product(),snapshot={products:[p],catalogRevision:'accepted'},before=JSON.stringify(snapshot);
  const {id,...signal}=review(p),search=snapshotKeywordSearch(snapshot,{[id]:signal});
  const results=await search('optical illusions',24,new Date(),'accepted');
  assert.equal(results[0].title,signal.displayTitle);assert.equal(results[0].description,description);
  assert.equal(JSON.stringify(snapshot),before);
});
test('finite queue saves result before pointer, and lost-ACK retry never calls the editor again',async t=>{
  const r=await runtime(t),products=Array.from({length:60},(_,i)=>product(String(i).padStart(3,'0'))),original=structuredClone(products);
  let calls=0,lose=true;const pointer=r.state.pointer;
  r.state.pointer=async(...args)=>{await pointer(...args);if(lose){lose=false;throw Error('lost acknowledgement');}};
  const options={runtime:r,db:database(products),revision:'accepted',day:'2026-11-09',editor:{async repairTitles(ps){calls++;return ps.map(review);}}};
  await assert.rejects(repairTitleQueue(options),/lost acknowledgement/);
  const result=await repairTitleQueue(options);
  assert.equal(calls,1);assert.equal(result.selected,50);assert.equal(result.approved,50);assert.equal(result.remaining,10);assert.equal(result.deferred,0);
  assert.deepEqual(products,original);
  const next=await repairTitleQueue({...options,day:'2026-11-10'});
  assert.equal(next.selected,10);assert.equal(next.approved,10);assert.equal(next.remaining,0);assert.equal(calls,2);
});
test('uncertain or out-of-cohort review preserves products and is explicitly deferred, not paid-retried daily',async t=>{
  for(const respond of [()=>{throw Error('editorial_dispatch_uncertain');},()=>[review(product('foreign'))]]){
    const r=await runtime(t);let calls=0;
    const options={runtime:r,db:database([product()]),revision:'accepted',day:'2026-11-09',editor:{async repairTitles(){calls++;return respond();}}};
    const first=await repairTitleQueue(options);assert.equal(first.approved,0);assert.equal(first.deferred,1);assert.ok(first.attention);
    const next=await repairTitleQueue({...options,day:'2026-11-10'});assert.equal(next.selected,0);assert.equal(next.deferred,1);assert.equal(calls,1);
  }
});
test('draft plus independent fact review is durable, rejects foreign/unfinished names and does not guess ambiguous objects',async()=>{
  const records=new Map(),stages=createEditorialStages({read:async k=>records.get(k),put:async(k,v)=>records.set(k,v)});
  let calls=0;
  const editor=createCatalogEditorial({stages,complete:async request=>{
    calls++;assert.equal(request.model,'gpt-6-luna');assert.equal(request.response_format.json_schema.strict,true);
    const value=calls===1?{products:[{id:'book',title:'Optical illusions drawing book'},{id:'ambiguous',title:null}]}:{products:[{id:'book',approved:true}]};
    return{choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]};
  }});
  const products=[product(),product('ambiguous')],first=await editor.repairTitles(products);
  assert.equal(first.length,1);assert.equal(first[0].displayTitle,'Optical illusions drawing book');
  assert.deepEqual(await editor.repairTitles(products),first);assert.equal(calls,2);
  for(const title of ['Unfinished ...','<script>']){
    const invalid=createCatalogEditorial({stages:createEditorialStages({read:async()=>undefined,put:async()=>{}}),complete:async()=>({choices:[{
      finish_reason:'stop',message:{content:JSON.stringify({products:[{id:'book',title}]})}}]})});
    await assert.rejects(invalid.repairTitles([product()]),/title_invalid/);
  }
});
test('new admissions must have a complete reviewed factual name in existing copy calls',()=>{
  const p={...product(),sourceFacts:{format:'book',topic:'drawing optical illusions'}},options={draftDescription:description,review:{approved:true},reviewQuality:.9};
  for(const draftTitle of ['',p.title])assert.notEqual(resolveShortDescriptionAttempt(p,{...options,draftTitle}).editorialStatus,'short_ready');
  const accepted=resolveShortDescriptionAttempt(p,{...options,draftTitle:'Optical illusions drawing book'});
  assert.equal(accepted.editorialStatus,'short_ready');assert.equal(accepted.punnyTitle,'Optical illusions drawing book');
  assert.equal(accepted.editorialWriteup,undefined);
});
