import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import amazonCreators from '../lib/amazon-creators.js';
import { dailyCatalogExecutor, dailyCatalogPhases, withCatalogCadence } from '../scripts/ops/catalog-daily.mjs';
import { createUsageLedger } from '../scripts/ops/catalog-telemetry.mjs';
import { editorialSourceHash } from '../scripts/ops/catalog-editorial-core.mjs';
import { createCatalogProviderEvidence } from '../scripts/catalog/provider-evidence.ts';

// Owned fictional records and mocked SDK/merchant responses only. No network,
// schedules, real products, publication, rights issuance or provider changes.
const MONDAY='2026-10-19T18:00:00.000Z',TUESDAY='2026-10-20T18:00:00.000Z';
const prose=material=>Array(2).fill(Array(15).fill(`Synthetic ${material} lobster desk bell fixture editorial.`).join(' ')).join('\n\n');
const product=(n=1)=>({id:`B${String(n).padStart(9,'0')}`,slug:`test-only-bell-${n}`,
  title:'TEST ONLY novelty brass lobster desk bell',price:12,currency:'USD',imageUrl:'https://example.invalid/bell.jpg',
  affiliateUrl:`https://www.amazon.com/dp/B${String(n).padStart(9,'0')}?tag=fixture-20`,source:'amazon',sourceQuery:'test-only fixture',
  humorTags:['fixture','desk'],punnyTitle:'Test only original title',wittyDescription:'Test only original sentence.',
  qualityScore:.9,isActive:true,availabilityStatus:'IN_STOCK',sourceFacts:{fixture:true,material:'brass',shape:'lobster'},
  editorialWriteup:prose('brass'),editorialStatus:'generated_ready',editorialQualityScore:.9,remotelyVerified:true});
const row=(p,hasEmbedding=true)=>({...Object.fromEntries(Object.entries(p).map(([key,value])=>[key.replace(/[A-Z]/g,c=>`_${c.toLowerCase()}`),value])),
  source_facts_hash:editorialSourceHash(p),editorial_source_hash:editorialSourceHash(p),has_embedding:hasEmbedding});
let respond;
const originalFetch=globalThis.fetch;
const originalKey=process.env.OPENAI_API_KEY;
globalThis.fetch=(...args)=>{if(!respond)throw new Error('Live network forbidden');return respond(...args);};
test.after(()=>{globalThis.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;});

async function fixture(t,{day=MONDAY,rows=[row(product())],remote=rows.map(r=>product(Number(r.id.slice(1)))),draftFails=false,embeddingFails=false,crossAfterDraft=false,captureEvidence=true}={}){
  const parent=await realpath(await mkdtemp(join(tmpdir(),'goose-selected-copy-')));t.after(()=>rm(parent,{recursive:true,force:true}));
  process.env.OPENAI_API_KEY='TEST_ONLY_SELECTED_COPY';
  const calls={getItems:0,chat:0,embedding:0},writes=[],receipts=[],events=[];
  let current=day;
  t.mock.method(amazonCreators,'getItems',async ids=>{calls.getItems++;assert.deepEqual(ids,rows.map(r=>r.id));return structuredClone(remote);});
  t.mock.method(amazonCreators,'searchItems',()=>{throw new Error('Selected refresh cannot discover');});
  respond=async(url,init)=>{
    assert.ok(String(url).startsWith('https://api.openai.com/v1/'));const body=JSON.parse(init.body);
    if(String(url).endsWith('/embeddings')){
      calls.embedding++;assert.ok(body.input.length<=10);
      return Response.json({model:'text-embedding-3-small',usage:{prompt_tokens:1,total_tokens:1},
        data:embeddingFails?[]:body.input.map((_,index)=>({index,embedding:Array(1536).fill(.125)}))});
    }
    calls.chat++;const review=body.messages[0].content.includes('skeptical');
    const records=JSON.parse(body.messages[1].content.split(review?'Drafts:\n':'Products:\n')[1]);
    assert.ok(records.length<=10);
    if(!review&&crossAfterDraft)current=TUESDAY;
    return Response.json({choices:[{message:{content:JSON.stringify({products:records.map(p=>review
      ?{id:p.id,approved:true,correctedDescription:null,qualityScore:.95,reasons:[]}
      :{id:p.id,shortTitle:'Lobster desk bell',punnyTitle:'Test only refreshed title',wittyDescription:'Test only refreshed factual sentence.',humorTags:['fixture','desk'],
        isActive:true,qualityScore:.9,shortDescription:draftFails?'Incomplete draft':`A ${p.sourceFacts.material} lobster desk bell for a small tabletop.`})})},finish_reason:'stop'}],
      usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
  };
  const evidence=createCatalogProviderEvidence({now:()=>current,async saveReceipt(input){receipts.push(input);return{sha256:input.sha256,reference:`test-only/${input.sha256}`};}});
  const store={async getProductsForRevalidation(){return rows;},async getExistingEditorialWriteups(){return[];},
    async upsertProduct(p,hash){writes.push({product:structuredClone(p),hash});return{inserted:false,slug:p.slug};},
    async recordEditorialEvent(event){events.push(event);},
    async getProductsNeedingEnrichment(){assert.fail('No global backfill');},async getAffiliateUrlMismatches(){assert.fail('No global repair');}};
  const telemetry={runId:'test-only-selected',usage:createUsageLedger(),warnings:[],timingsMs:{},items:{record(){},async flush(){}}};
  const settings={workspace:join(parent,'private'),repository:process.cwd(),now:()=>current};
  return{calls,writes,receipts,events,async execute(){return withCatalogCadence(settings,async cadence=>{
    // Simulate the weekly discovery allowance already consumed: selected
    // Monday enrichment remains independently attached to this daily batch.
    if(cadence.calendar.monday)await cadence.reserve('discovery','already-discovered');
    const [phase]=await dailyCatalogPhases(cadence);assert.equal(phase.enrichSelectedExisting,cadence.calendar.monday);
    return dailyCatalogExecutor(cadence)(phase,undefined,telemetry,store,captureEvidence?evidence:undefined);
  });}};
}

test('Monday repairs changed selected facts using one same <=10 GetItems response and existing evidence hooks',async t=>{
  const before=product(),changed={...before,title:'TEST ONLY novelty plastic lobster desk bell',sourceFacts:{fixture:true,material:'plastic',shape:'lobster'}};
  const f=await fixture(t,{remote:[changed]});const result=await f.execute();
  assert.deepEqual(f.calls,{getItems:1,chat:2,embedding:1});assert.equal(f.writes.length,1);
  const after=f.writes[0].product;assert.equal(after.editorialStatus,'short_ready');
  assert.equal(after.editorialSourceHash,editorialSourceHash(changed));assert.equal(after.embedding.length,1536);
  assert.match(after.wittyDescription,/plastic/);assert.equal(after.editorialWriteup,before.editorialWriteup);assert.equal(f.receipts.length,2);
  assert.equal(Date.parse(f.receipts[0].receipt.observedAt),Date.parse(MONDAY));assert.equal(f.receipts[1].receipt.kind,'embedding-response');
  assert.equal(f.receipts[1].receipt.products[0].sourceFactsHash,after.editorialSourceHash);
  assert.equal(result.selectedEditorialAttempts,1);assert.equal(result.selectedEditorialReady,1);assert.equal(result.selectedEmbeddings,1);
  assert.equal(f.events.length,1);assert.equal(f.events[0].eventType,'enriched');
});

test('Tuesday changed copy stays held with no model calls; Monday unchanged approved copy/vector is reused',async t=>{
  const changed={...product(),title:'TEST ONLY novelty plastic lobster desk bell',sourceFacts:{fixture:true,material:'plastic',shape:'lobster'}};
  const weekday=await fixture(t,{day:TUESDAY,remote:[changed]});await weekday.execute();
  assert.deepEqual(weekday.calls,{getItems:1,chat:0,embedding:0});assert.equal(weekday.writes[0].product.editorialStatus,'stale');
  const monday=await fixture(t);await monday.execute();
  assert.deepEqual(monday.calls,{getItems:1,chat:0,embedding:0});assert.equal(monday.writes[0].product.editorialWriteup,product().editorialWriteup);
  assert.equal(monday.writes[0].product.embedding,undefined);
});

test('Monday missing vector embeds only the unchanged factual copy, without drafting or another merchant lookup',async t=>{
  const f=await fixture(t,{rows:[row(product(),false)]});await f.execute();
  assert.deepEqual(f.calls,{getItems:1,chat:0,embedding:1});assert.equal(f.writes[0].product.editorialWriteup,product().editorialWriteup);
});

test('Monday fills missing copy from the existing fetched product without using the global backfill',async t=>{
  const missing={...row(product(),false),editorial_status:'pending',editorial_writeup:null,editorial_source_hash:null};
  const f=await fixture(t,{rows:[missing]});await f.execute();
  assert.deepEqual(f.calls,{getItems:1,chat:2,embedding:1});assert.equal(f.writes[0].product.editorialStatus,'short_ready');
  assert.equal(f.writes[0].product.editorialSourceHash,editorialSourceHash(product()));
});

test('failed Monday generation or vector proof keeps changed copy held; manual locks and duplicate holds are untouched',async t=>{
  const changed={...product(),title:'TEST ONLY novelty plastic lobster desk bell',sourceFacts:{fixture:true,material:'plastic',shape:'lobster'}};
  for(const failure of ['draft','embedding']){
    const f=await fixture(t,{remote:[changed],draftFails:failure==='draft',embeddingFails:failure==='embedding'});await f.execute();
    assert.equal(f.calls.getItems,1);assert.equal(f.writes[0].product.editorialStatus,'stale');
    assert.equal(f.writes[0].product.editorialWriteup,product().editorialWriteup);
    assert.notEqual(f.writes[0].product.editorialSourceHash,editorialSourceHash(changed));
  }
  for(const [status,duplicateOfProductId] of [['manual_locked'],['duplicate'],['duplicate','B000000099'],['blocked']]){
    const original={...product(),editorialStatus:status,duplicateOfProductId};
    const f=await fixture(t,{rows:[row(original)],remote:[changed]});await f.execute();
    assert.deepEqual(f.calls,{getItems:1,chat:0,embedding:0});assert.equal(f.writes[0].product.editorialStatus,status);
    assert.equal(f.writes[0].product.editorialWriteup,original.editorialWriteup);
  }
});

test('ten reserved existing IDs still use one merchant batch and unchanged copies trigger no Monday models',async t=>{
  const products=Array.from({length:10},(_,n)=>product(n+1));
  const f=await fixture(t,{rows:products.map(p=>row(p)),remote:products});await f.execute();
  assert.deepEqual(f.calls,{getItems:1,chat:0,embedding:0});assert.equal(f.writes.length,10);
  assert.equal(new Set(f.writes.map(w=>w.product.id)).size,10);
});

test('crossing the day during Monday drafting stops before review, embeddings or persistence',async t=>{
  const f=await fixture(t,{rows:[{...row(product(),false),editorial_status:'pending',editorial_writeup:null,editorial_source_hash:null}],crossAfterDraft:true});
  await assert.rejects(f.execute(),/cadence_day_changed/);
  assert.deepEqual(f.calls,{getItems:1,chat:1,embedding:0});assert.equal(f.writes.length,0);
  assert.equal(Date.parse(f.receipts[0].receipt.observedAt),Date.parse(MONDAY));
});

test('an unverified merchant result cannot trigger Monday generation or new embedding proof',async t=>{
  const changed={...product(),title:'TEST ONLY novelty plastic lobster desk bell',sourceFacts:{fixture:true,material:'plastic',shape:'lobster'},remotelyVerified:false};
  const f=await fixture(t,{remote:[changed]});await f.execute();
  assert.deepEqual(f.calls,{getItems:1,chat:0,embedding:0});assert.equal(f.writes[0].product.editorialStatus,'stale');
  assert.equal(f.writes[0].product.editorialSourceHash,editorialSourceHash(product()));
  assert.equal(f.receipts[0].receipt.products.length,0);
});

test('Neon daily source hashes use the stored clean image so Monday copy stays current on Tuesday without evidence',async t=>{
  const changed={...product(),title:'TEST ONLY novelty plastic lobster desk bell',sourceFacts:{fixture:true,material:'plastic',shape:'lobster'},
    imageUrl:product().imageUrl+'_SL300_.jpg'};
  const monday=await fixture(t,{remote:[changed],captureEvidence:false});await monday.execute();
  const after=monday.writes[0].product;
  assert.deepEqual(monday.calls,{getItems:1,chat:2,embedding:1});
  assert.equal(after.sourceFactsHash,after.editorialSourceHash);assert.equal(after.editorialStatus,'short_ready');
  assert.equal(after.imageUrl,product().imageUrl);assert.equal(after.sourceFactsHash,editorialSourceHash(after));
  const tuesday=await fixture(t,{day:TUESDAY,rows:[row(after)],remote:[changed],captureEvidence:false});await tuesday.execute();
  assert.deepEqual(tuesday.calls,{getItems:1,chat:0,embedding:0});assert.equal(tuesday.writes[0].product.editorialStatus,'short_ready');
  assert.equal(tuesday.writes[0].hash,after.editorialSourceHash);
});
