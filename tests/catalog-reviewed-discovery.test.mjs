import assert from 'node:assert/strict';
import test from 'node:test';
import amazon from '../lib/amazon-creators.js';
import {executeCatalog,parseArgs,enrichProducts} from '../scripts/ops/prefetch-catalog.mjs';
import {createEditorialStages} from '../scripts/catalog/catalog-editorial.mjs';
import {createUsageLedger} from '../scripts/ops/catalog-telemetry.mjs';

const item=(n,title)=>({id:`B${String(n).padStart(9,'0')}`,title,price:20,currency:'USD',source:'amazon',
  imageUrl:`https://example.invalid/${n}.jpg`,availabilityStatus:'IN_STOCK',remotelyVerified:true,
  affiliateUrl:`https://www.amazon.com/dp/B${String(n).padStart(9,'0')}?tag=fixture-20`,
  sourceFacts:{material:'cotton',shape:'alligator'},qualityScore:.2,isActive:true});
const usage=()=>({runId:'reviewed-discovery-fixture',usage:createUsageLedger(),timingsMs:{},warnings:[],items:{record(){},async flush(){}}});
function stages(){
  const records=new Map();
  return{records,stage:createEditorialStages({read:async key=>records.get(key),put:async(key,value)=>{
    if(records.has(key))assert.deepEqual(records.get(key),value);else records.set(key,structuredClone(value));
  }})};
}
test('new discovery saves collection before judgment, ignores title taste/score and admits only actual reviewed candidates',async t=>{
  const products=[item(1,'Alligator oven mitts'),item(2,'Alligator oven mitts with a different design'),item(3,'Funny household cup'),item(4,'Existing private identity')];
  let supplier=0,models=0;const saved=stages(),written=[];
  t.mock.method(amazon,'searchItems',async()=>{supplier++;return products;});
  t.mock.method(globalThis,'fetch',async()=>{models++;throw Error('no model calls in this skip-enrichment fixture');});
  const options={...parseArgs(['--themes','one','--max-new','1','--backfill-limit','0','--skip-enrichment']),
    discoveryRunKey:'test-cohort',discoveryNewOnly:true,editorialStages:saved.stage,
    discoveryEditor:{async reviewDiscovery(candidates){
      assert.ok([...saved.records.keys()].some(key=>key.startsWith('discovery-collect-')&&key.endsWith('-result')));
      assert.deepEqual(candidates.map(p=>p.id),products.slice(0,3).map(p=>p.id));
      return candidates.map(p=>({id:p.id,decision:p.id===products[2].id?'reject':'admit',appeal:'giftable',
        imageMatches:true,reason:p.id===products[2].id?'Ordinary cup without a distinctive visual gag.':'A distinctive alligator mouth design turns a kitchen tool into a visual joke.'}));
    }}};
  const store={getActiveCatalogIdentities:async({includeInactive})=>{assert.equal(includeInactive,true);return[{id:products[3].id,title:'Private held product'}];},
    getExistingEditorialWriteups:async()=>{throw Error('short-copy discovery must not read the article library');},
    upsertProduct:async p=>{written.push(p.id);return{inserted:true,slug:'fixture'};},recordEditorialEvent:async()=>{}};
  const result=await executeCatalog(options,undefined,usage(),store);
  assert.deepEqual(written,products.slice(0,2).map(p=>p.id));
  assert.equal(result.editorialRejected,1);assert.equal(result.candidates,2);assert.equal(result.catalogDuplicates,1);
  assert.equal(result.discoveryDuplicates,0);assert.equal(result.deferredCandidates,0);assert.equal(supplier,1);assert.equal(models,0);
  await executeCatalog(options,undefined,usage(),store);
  assert.equal(supplier,1); // Same saved collection, never a second supplier batch.
});
test('unknown collection dispatch does not silently refetch on the same stage',async t=>{
  let supplier=0;const saved=stages();
  t.mock.method(amazon,'searchItems',async()=>{supplier++;throw Error('unknown supplier result');});
  const options={...parseArgs(['--themes','one','--max-new','1','--backfill-limit','0']),discoveryRunKey:'unknown',
    editorialStages:saved.stage,discoveryEditor:{reviewDiscovery:async()=>{throw Error('not reached');}}};
  for(let i=0;i<2;i++)await assert.rejects(executeCatalog(options,undefined,usage(),{}),/editorial_dispatch_uncertain/);
  assert.equal(supplier,1);
});
test('campaign and repeated search-topic leads share saved collection and one admission-before-enrichment pass',async t=>{
  const campaign=item(7,'A ridiculous guitar-shaped desk object'),ordinary=item(8,'Animal-shaped kitchen tool'),saved=stages();
  let gets=0,searches=0;const queries=[],written=[];
  t.mock.method(amazon,'getItems',async ids=>{gets++;assert.deepEqual(ids,[campaign.id]);return[campaign];});
  t.mock.method(amazon,'searchItems',async input=>{searches++;queries.push(input.keywords);return[ordinary];});
  const options={...parseArgs(['--themes','ordinary one|ordinary two','--theme-limit','2','--backfill-limit','0','--skip-enrichment']),
    discoveryNewOnly:true,discoveryRunKey:'mixed-leads',discoveryLeadAsins:[campaign.id],discoverySearchTopics:['funny guitar gift'],editorialStages:saved.stage,
    discoveryEditor:{async reviewDiscovery(products){return products.map(p=>({id:p.id,decision:'admit',appeal:'giftable',imageMatches:true,reason:'A distinctive visual gift with an obvious joke.'}));}}};
  const store={getActiveCatalogIdentities:async()=>[],getExistingEditorialWriteups:async()=>[],
    upsertProduct:async p=>{written.push(p.id);return{inserted:true};},recordEditorialEvent:async()=>{}};
  await executeCatalog(options,undefined,usage(),store);
  assert.equal(gets,1);assert.equal(searches,2);assert.ok(queries.includes('funny guitar gift'));
  assert.deepEqual(written,[campaign.id,ordinary.id]);
  await executeCatalog(options,undefined,usage(),store);assert.equal(gets,1);assert.equal(searches,2);
});
test('reviewed discovery refuses missing saved-stage capability before a supplier request',async t=>{
  let calls=0;t.mock.method(amazon,'searchItems',async()=>{calls++;return[];});
  await assert.rejects(executeCatalog({...parseArgs([]),discoveryEditor:{reviewDiscovery:async()=>[]}},undefined,usage(),{}),/discovery_editor_capability_required/);
  assert.equal(calls,0);
});
test('visual admission, not a legacy price band or keyword score, decides expensive and cheap gifts',async t=>{
  const products=[{...item(5,'Odd mechanical animal sculpture'),price:350},{...item(6,'Tiny ridiculous desk object'),price:.5}],saved=stages(),written=[];
  t.mock.method(amazon,'searchItems',async()=>products);
  const options={...parseArgs(['--themes','one','--max-new','1','--backfill-limit','0','--skip-enrichment']),
    discoveryNewOnly:true,discoveryRunKey:'price-not-taste',editorialStages:saved.stage,
    discoveryEditor:{async reviewDiscovery(candidates){assert.equal(candidates.length,2);assert.ok(candidates.every(p=>p.qualityScore===0));
      return candidates.map(p=>({id:p.id,decision:'admit',appeal:'giftable',imageMatches:true,reason:'The actual visible object has a distinctive gift-worthy joke.'}));}}};
  await executeCatalog(options,undefined,usage(),{getActiveCatalogIdentities:async()=>[],getExistingEditorialWriteups:async()=>[],
    upsertProduct:async p=>{written.push(p.id);return{inserted:true};},recordEditorialEvent:async()=>{}});
  assert.deepEqual(written,products.map(p=>p.id));
});
test('contradictory same-run observations defer only that identity instead of blocking good unrelated gifts',async t=>{
  const first=item(1,'Alligator oven mitts'),good=item(2,'Chicken-leg socks');let calls=0;const written=[];
  t.mock.method(amazon,'searchItems',async()=>++calls===1?[first,good]:[{...first,title:'An entirely different product'}]);
  const saved=stages(),options={...parseArgs(['--themes','one|two','--max-new','1','--backfill-limit','0','--skip-enrichment']),
    discoveryRunKey:'contradiction',discoveryNewOnly:true,editorialStages:saved.stage,
    discoveryEditor:{reviewDiscovery:async candidates=>{
      assert.deepEqual(candidates.map(p=>p.id),[good.id]);
      return candidates.map(p=>({id:p.id,decision:'admit',appeal:'giftable',imageMatches:true,reason:'A distinct animal-shaped gift.'}));
    }}};
  const result=await executeCatalog(options,undefined,usage(),{getActiveCatalogIdentities:async()=>[],getExistingEditorialWriteups:async()=>[],
    upsertProduct:async p=>{written.push(p.id);return{inserted:true};},recordEditorialEvent:async()=>{}});
  assert.deepEqual(written,[good.id]);assert.equal(result.editorialDeferred,1);
});
test('copy draft, review and native response are each saved and reused without another model call',async t=>{
  const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='TEST_ONLY_REVIEWED_DISCOVERY';
  t.after(()=>{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;});
  const saved=stages(),p={...item(1,'Alligator oven mitts'),sourceFacts:{material:'cotton',shape:'alligator',feature:'toothy mouth'}};
  let chat=0,embedding=0,proofs=0;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const body=JSON.parse(init.body);
    if(String(url).endsWith('/embeddings')){
      embedding++;return Response.json({model:'text-embedding-3-small',data:[{index:0,embedding:Array(1536).fill(.1)}],usage:{total_tokens:10}});
    }
    assert.ok(String(url).endsWith('/chat/completions'));chat++;
    const review=body.messages[0].content.includes('skeptical');
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({products:[review
      ?{id:p.id,approved:true,correctedDescription:null,qualityScore:.95,reasons:[]}
      :{id:p.id,shortTitle:p.title,shortDescription:'A cotton alligator oven mitt with a toothy mouth.',humorTags:['alligator','kitchen'],qualityScore:.9,isActive:true}]})}}],usage:{total_tokens:10}});
  });
  const evidence={embeddings:async()=>{proofs++;},reviewedShort:async()=>true};
  const options={enrichmentBatchSize:4,discoveryNewOnly:true,editorialStages:saved.stage};
  const first=await enrichProducts([p],options,[],usage(),evidence);
  const second=await enrichProducts([p],options,[],usage(),evidence);
  assert.equal(first[0].editorialStatus,'short_ready');assert.equal(first[0].embedding.length,1536);
  assert.equal(second[0].wittyDescription,first[0].wittyDescription);assert.deepEqual(second[0].embedding,first[0].embedding);
  assert.equal(chat,2);assert.equal(embedding,1);assert.equal(proofs,1);
  for(const stage of ['copy-draft','copy-review','embedding'])assert.ok([...saved.records.keys()].some(key=>key.startsWith(stage+'-')&&key.endsWith('-result')));
});
