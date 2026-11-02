import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import amazonCreators from '../lib/amazon-creators.js';
import { createCatalogProviderEvidence } from '../scripts/catalog/provider-evidence.ts';
import { createD1CatalogMaintenanceStore, loadMaintenanceVectorPayload } from '../scripts/catalog/maintenance-d1.ts';
import { createD1CatalogTelemetryStore } from '../scripts/catalog/telemetry-d1.ts';
import { maintenanceEmbeddingText } from '../scripts/catalog/maintenance-state.ts';
import { canonicalJson, sha256 } from '../scripts/catalog/migration.ts';
import { decodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';
import { executeCatalog, parseArgs, runCatalogWithBackend } from '../scripts/ops/prefetch-catalog.mjs';
import { runWeeklyCatalogWithBackend } from '../scripts/ops/catalog-weekly.mjs';
import { createUsageLedger } from '../scripts/ops/catalog-telemetry.mjs';
import { editorialSourceHash } from '../scripts/ops/catalog-editorial-core.mjs';
import { createPostgresCatalogMaintenanceStore } from '../scripts/ops/catalog-maintenance-postgres.mjs';
import { claimMutationOwnership, readMutationOwner, releaseMutationOwnership } from '../lib/catalog/mutation-fence.ts';
import { createProjectionPacket, projectionQueries } from '../lib/catalog/d1.ts';
import { createSealedSnapshotEnvelope } from '../scripts/catalog/export-d1-snapshot.ts';
import { approvedCohortOperationKey, prepareApprovedCohort, settleApprovedCohort } from '../lib/catalog/freeze-approved-cohort.ts';
import { deliverOwnedOutboxEvent, deliverOwnedApprovedCohortVector, readOwnedApprovedCohortVectors } from '../scripts/catalog/owned-vector-delivery.ts';

// Independently owned synthetic content/IDs only. No retailer/model requests,
// actual rights claims, CLI activation, public fixture releases or file writes.
const NOW='2026-10-20T12:00:00.123Z';const ID='B000000001';const UUID='00000000-0000-4000-8000-000000000001';
const values=Array(1536).fill(.1);values[0]=-0;values[1]=1e-45;
const writeup=Array(2).fill(Array(15).fill('Synthetic brass lobster desk bell fixture editorial.').join(' ')).join('\n\n');
const product={id:ID,title:'TEST ONLY novelty brass lobster desk bell',price:19.99,currency:'USD',imageUrl:'https://example.invalid/lobster.jpg',
  affiliateUrl:`https://www.amazon.com/dp/${ID}?tag=fixture-20`,source:'amazon',sourceQuery:'test-only private source query',
  humorTags:['fixture','desk'],punnyTitle:'Test only shell service',wittyDescription:'An independently owned synthetic desk bell description.',
  qualityScore:.85,rating:4.5,reviewCount:12,isActive:true,editorialWriteup:writeup,sourceFacts:{fixture:true,material:'brass',shape:'lobster'},
  availabilityStatus:'IN_STOCK',editorialStatus:'manual_locked',editorialQualityScore:.95,remotelyVerified:true};
const rights=p=>Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,affiliateUrl:p.affiliateUrl,
  punnyTitle:p.punnyTitle,wittyDescription:p.wittyDescription,editorialWriteup:p.editorialWriteup,humorTags:JSON.stringify(p.humorTags)})
  .map(([field,value])=>[field,{basis:'owned',reference:`test-only-owned/${field}`,value}]));
test('new reviewed short copy receives only exact same-observation display grants',async()=>{
  const saved=[];
  const evidence=createCatalogProviderEvidence({now:()=>NOW,associateTag:'goose-gifts-37-20',
    async saveReceipt(input){return{sha256:input.sha256,reference:'fixture/merchant'};},
    async saveReviewedShort(input){saved.push(input);return{reference:'fixture/review'};}});
  const source={...product,affiliateUrl:`https://www.amazon.com/dp/${ID}?tag=goose-gifts-37-20`};
  await evidence.amazon('searchItems',async()=>[source]);
  const candidate={...source,wittyDescription:'A brass lobster desk bell for a small tabletop.',editorialStatus:'short_ready',
    editorialQualityScore:.9,editorialSourceHash:editorialSourceHash(source),requiresManualReview:false};
  assert.equal(await evidence.reviewedShort(candidate,{approved:false,qualityScore:.95}),false);
  assert.equal(await evidence.reviewedShort({...candidate,affiliateUrl:'https://example.invalid/'},{approved:true,qualityScore:.95}),false);
  assert.equal(await evidence.reviewedShort(candidate,{approved:true,qualityScore:.95}),true);
  assert.equal(saved.length,1);
  const grant=evidence.intent('upsertProduct',[candidate,editorialSourceHash(candidate)]).rightsById[ID];
  assert.equal(grant.imageUrl.reference,'fixture/merchant');
  assert.equal(Date.parse(grant.imageUrl.observedAt),Date.parse(NOW));
  assert.equal(grant.description.value,candidate.wittyDescription);
  assert.equal(grant.description.reference,'fixture/review');
  assert.equal(saved[0].title,candidate.title);
  assert.equal(grant.persistent.title.value,candidate.title);
  assert.equal(grant.persistent.description.value,candidate.wittyDescription);
  assert.equal(grant.persistent.imageUrl.value,'/images/gift-placeholder.svg');
  assert.equal(grant.persistent.imageUrl.expiresAt,undefined);
  assert.equal(grant.imageUrl.expiresAt,new Date(Date.parse(NOW)+86400000).toISOString());
  await evidence.amazon('searchItems',async()=>[source]);
  assert.equal(evidence.intent('upsertProduct',[candidate,editorialSourceHash(candidate)]).rightsById,undefined);
});
const scope={environment:'staging',indexName:'test-only-evidence'};
const original={fetch:globalThis.fetch,getItems:amazonCreators.getItems,searchItems:amazonCreators.searchItems,
  env:Object.fromEntries(['OPENAI_API_KEY','POSTGRES_URL','AMAZON_ASSOCIATE_TAG','GOOGLE_SEARCH_API_KEY','GOOGLE_SEARCH_ENGINE_ID'].map(key=>[key,process.env[key]]))};
process.env.OPENAI_API_KEY='TEST_ONLY_NOT_A_CREDENTIAL';delete process.env.POSTGRES_URL;process.env.AMAZON_ASSOCIATE_TAG='fixture-20';
delete process.env.GOOGLE_SEARCH_API_KEY;delete process.env.GOOGLE_SEARCH_ENGINE_ID;
let responder;
// The lazy SDK may retain this function; route each test through the same mock.
globalThis.fetch=(...args)=>{if(!responder)throw new Error('All network is forbidden');return responder(...args);};
after(()=>{globalThis.fetch=original.fetch;amazonCreators.getItems=original.getItems;amazonCreators.searchItems=original.searchItems;
  for(const [key,value] of Object.entries(original.env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function providerMocks(remote=product,draft=writeup) {
  const calls={getItems:0,searchItems:0,chat:0,embedding:0};const requests=[];
  amazonCreators.getItems=async ids=>{calls.getItems++;assert.deepEqual(ids,[ID]);return[structuredClone(remote)];};
  amazonCreators.searchItems=async()=>{calls.searchItems++;return[structuredClone(remote)];};
  responder=async(url,init)=>{
    assert.ok(String(url).startsWith('https://api.openai.com/v1/'));const body=JSON.parse(init.body);requests.push(body);
    if(String(url).endsWith('/embeddings')){
      calls.embedding++;assert.equal(body.model,'text-embedding-3-small');assert.equal(body.encoding_format,'float');
      const encoded=values.map(n=>Object.is(n,-0)?'-0':String(n)).join(',');
      return new Response(`{"object":"list","model":"text-embedding-3-small","usage":{"prompt_tokens":8,"total_tokens":8},"data":[{"index":0,"embedding":[${encoded}]}]}`,
        {headers:{'content-type':'application/json'}});
    }
    assert.ok(String(url).endsWith('/chat/completions'));calls.chat++;
    const content=JSON.stringify({products:[body.messages[0].content.includes('skeptical')
      ? {id:remote.id,approved:true,correctedEditorial:null,correctedDescription:null,qualityScore:.95,reasons:[]}
      : {id:remote.id,punnyTitle:remote.punnyTitle,wittyDescription:remote.wittyDescription,
        shortDescription:`A ${remote.sourceFacts.material} ${remote.sourceFacts.shape} ${remote.sourceFacts.design || 'desk bell'} with a distinctive silhouette.`,
        humorTags:remote.humorTags,qualityScore:.85,isActive:true,editorialWriteup:draft}]});
    return Response.json({id:'test-only-completion',choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
  };return{calls,requests};
}
const telemetry=()=>({runId:'weekly-run',usage:createUsageLedger(),timingsMs:{},warnings:[],items:{record(){},async flush(){}}});
const phase=()=>parseArgs(['--enrich-only','--backfill-limit','1','--ids',ID]);
async function fixture(t,{observedAt=NOW,reviewedRights=rights(product),loseResponse=false,allowReviewedShort=false}={}) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name=>/^\d{4}.*\.sql$/.test(name)).sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  sql.function('strftime',(format,instant)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return NOW;});
  let lost=false;let armed=false;
  const db={prepare(query){let params=[];return{query,bind(...values){assert.ok(values.length<=100);params=values;return this;},
    async all(){return{results:sql.prepare(query).all(...params).map(row=>({...row}))};},async run(){return sql.prepare(query).run(...params);},
    execute(){return sql.prepare(query).all(...params);}};},async batch(statements){
      sql.exec('BEGIN');try{for(const statement of statements)statement.execute();sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}
      if(loseResponse&&armed&&!lost&&statements.some(s=>s.query.startsWith('INSERT INTO catalog_maintenance_products'))){lost=true;throw new Error('TEST ONLY lost D1 response');}
    }};
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const seedOwner=await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'test-only/seed',operationKey:'a'.repeat(64)});
  const seed=createD1CatalogMaintenanceStore({db,owner:seedOwner,runId:'seed-run',catalogRevision:'prior-r',newPublicId:()=>UUID});
  await seed.upsertProduct({...product,remotelyVerified:false,embedding:null},editorialSourceHash(product));
  const row={...sql.prepare('SELECT * FROM products').get()};
  const previous={schemaVersion:1,dataKind:'catalog',catalogRevision:'prior-r',generatedAt:NOW,products:[],heldProducts:[{
    id:ID,publicId:UUID,slug:row.slug,path:`/gifts/${row.slug}`,title:'Gift currently unavailable',
    description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'editorial_hold'}],slugHistory:[]};
  const source='b'.repeat(64);const packet=await createProjectionPacket(previous,{[UUID]:row.source_facts_hash},source,new Date(NOW));
  sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run('prior-r',NOW,source,'published');
  for(const q of projectionQueries(packet))sql.prepare(q.sql).run(...q.params);
  const prior={release_id:'prior-release',catalog_revision:'prior-r',code_sha:'c'.repeat(40),completed_at:NOW,
    manifest_json:JSON.stringify({releaseId:'prior-release',catalogRevision:'prior-r',codeSha:'c'.repeat(40),catalogSnapshotSha256:packet.receipt.snapshot_sha256,
      manifestSha256:'d'.repeat(64),vectorSyncWatermark:0,priorReleaseId:null,nextExpiry:null})};
  sql.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(...Object.values(prior));
  const sealed=createSealedSnapshotEnvelope(previous);
  const context={envelopeSha256:sha256(`${JSON.stringify(sealed)}\n`),snapshotSha256:packet.receipt.snapshot_sha256,projectionSha256:packet.receipt.projection_sha256,
    sourceExportSha256:source,vectorSyncWatermark:0,publicationReceiptWatermark:1,cutoff:new Date(Date.parse(NOW)+3600000).toISOString(),
    priorPublication:{releaseId:'prior-release',receiptSha256:sha256(canonicalJson(prior))}};
  // Seed construction never grants public rights, even with a manual lock.
  assert.equal(row.public_display_json,null);await releaseMutationOwnership(db,await readMutationOwner(db,scope));armed=true;
  const cursor={current:await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'test-only/weekly',operationKey:'e'.repeat(64)})};
  const receipts=[];
  const evidence=createCatalogProviderEvidence({reviewedRightsById:{[ID]:reviewedRights},reviewedDeleteReference:'test-only/reviewed-delete',now:()=>observedAt,
    ...(allowReviewedShort?{associateTag:'goose-gifts-37-20',async saveReviewedShort(input){receipts.push(structuredClone(input));return{reference:'test-only/short-review'};}}:{}),
    async saveReceipt(input){assert.equal(sha256(canonicalJson(input.receipt)),input.sha256);receipts.push(structuredClone(input));
      return{sha256:input.sha256,reference:`test-only/receipt/${input.sha256}`};}});
  const store=createD1CatalogMaintenanceStore({db,owner:cursor.current,ownerCursor:cursor,runId:'weekly-run',catalogRevision:'weekly-r',intent:evidence.intent});
  const index=new Map();let dispatches=0;
  const adapters={...scope,providerIdentity:'test-only:index',async dispatch(input){dispatches++;if(input.vector)index.set(input.publicId,structuredClone(input.vector));else index.delete(input.publicId);
    return{reference:`test-only/mutation-${dispatches}`};},async resolve(input){return{state:'settled',reference:input.reference};},async readback(id){return structuredClone(index.get(id)||null);}};
  return{sql,db,store,cursor,evidence,receipts,index,adapters,lost:()=>lost,row:()=>({...sql.prepare('SELECT * FROM products').get()}),
    async freeze(){
      for(const event of sql.prepare("SELECT sequence FROM vector_sync_outbox WHERE status='pending' ORDER BY sequence").all()){
        const options={db,sequence:event.sequence,catalogRevision:'weekly-r',adapters,loadPayload:e=>loadMaintenanceVectorPayload(db,e)};
        let result=await deliverOwnedOutboxEvent({...options,owner:cursor.current});
        if(result.state==='pending')result=await deliverOwnedOutboxEvent({...options,owner:result.owner});
        assert.equal(result.state,'complete');cursor.current=result.owner;
      }
      const current={...sql.prepare('SELECT * FROM products').get()};
      const receipt=sql.prepare("SELECT * FROM catalog_maintenance_operations WHERE run_id='weekly-run' AND json_array_length(changes_json)>0").get();
      const approval={schemaVersion:1,runId:'weekly-run',catalogRevision:'weekly-r',changes:[{publicId:UUID,operationId:receipt.operation_id,
        inputSha256:receipt.input_sha256,productSha256:sha256(canonicalJson(current)),displaySha256:sha256(current.public_display_json??'null')}]};
      const request={previous,context,scope,codeSha:'f'.repeat(40),approval,approvalSha256:sha256(canonicalJson(approval))};
      await releaseMutationOwnership(db,cursor.current);
      const owner=await claimMutationOwnership(db,scope,{phase:'freezing',ownerReference:'test-only/approved-cohort',operationKey:approvedCohortOperationKey(request)});
      const prepared=await prepareApprovedCohort(db,owner,request);let next=prepared.owner;
      const options={db,revision:prepared.revision,publicId:UUID,adapters};
      let result=await deliverOwnedApprovedCohortVector({...options,owner:next});
      if(result.state==='pending')result=await deliverOwnedApprovedCohortVector({...options,owner:result.owner});next=result.owner;
      assert.equal(result.state,'complete');
      const queued=await settleApprovedCohort(db,next,prepared.revision,()=>readOwnedApprovedCohortVectors(db,next,prepared.revision,adapters));
      return{prepared,queued};
    }};
}

test('real Amazon mapper optional undefined ratings survive exact image-only normalization without entering JSON receipts',async()=>{
  const mapped=amazonCreators.mapItem({asin:ID,itemInfo:{title:{displayValue:'TEST ONLY lobster bell'},
    features:{displayValues:['Owned synthetic brass bell fixture']}},images:{primary:{large:{url:'https://example.invalid/original.jpg'}}},
    detailPageURL:`https://www.amazon.com/dp/${ID}?tag=fixture-20`,offersV2:{listings:[{availability:{type:'IN_STOCK'},price:{money:{amount:12,currency:'USD'}}}]}});
  assert.ok(Object.hasOwn(mapped,'rating'));assert.equal(mapped.rating,undefined);assert.equal(mapped.reviewCount,undefined);
  const before=structuredClone(mapped),receipts=[];let loads=0;
  const evidence=createCatalogProviderEvidence({now:()=>NOW,async saveReceipt(input){
    assert.equal(sha256(canonicalJson(input.receipt)),input.sha256);receipts.push(input.receipt);
    return{sha256:input.sha256,reference:'test-only/optional-rating'};
  }});
  const returned=await evidence.amazon('getItems',async()=>{loads++;return[mapped];},p=>({...p,imageUrl:'https://example.invalid/normalized.jpg'}),[ID]);
  assert.equal(loads,1);assert.equal(returned[0],mapped);assert.deepEqual(mapped,before);
  assert.equal(Object.hasOwn(returned[0],'rating'),true);assert.equal(returned[0].rating,undefined);
  assert.equal(receipts.length,1);assert.deepEqual(receipts[0].products.map(p=>p.snapshot.imageUrl),
    ['https://example.invalid/original.jpg','https://example.invalid/normalized.jpg']);
  assert.deepEqual(JSON.parse(canonicalJson(receipts[0])),receipts[0]);
  for(const change of [p=>({...p,rating:null}),p=>{delete p.rating;return p;},p=>({...p,title:'Changed unobserved title'})]){
    await assert.rejects(evidence.amazon('getItems',async()=>[mapped],change,[ID]),{message:'provider_evidence_normalization'});
  }
  assert.equal(receipts.length,1);
  assert.throws(()=>canonicalJson(mapped),/Non-JSON source value/); // JSON boundary stays strict.
});

test('real phase → exact private provider evidence → atomic D1 replay → owned vector → approved cohort',async t=>{
  const observedAt='2026-10-19T12:00:00.123Z';const f=await fixture(t,{observedAt,loseResponse:true});const mock=providerMocks();const usage=telemetry();
  const raw=f.row().source_record_json;const result=await executeCatalog(phase(),undefined,usage,f.store,f.evidence);
  assert.equal(result.backfilled,1);assert.deepEqual(mock.calls,{getItems:1,searchItems:0,chat:0,embedding:1});assert.ok(f.lost());
  assert.equal(f.receipts.length,2);assert.equal(Date.parse(f.receipts[0].receipt.observedAt),Date.parse(observedAt));
  assert.deepEqual(f.receipts[0].receipt.requestedIds,[ID]);assert.deepEqual(f.receipts[0].receipt.returnedIds,[ID]);
  const binding=f.receipts[1].receipt.products[0];assert.equal(binding.text,mock.requests.find(r=>r.input).input[0]);
  assert.equal(binding.sourceFactsHash,editorialSourceHash(product));assert.ok(Object.is(decodePgvectorSendBase64(binding.nativeBase64)[0],-0));
  assert.equal(decodePgvectorSendBase64(binding.nativeBase64)[1],Math.fround(1e-45));
  assert.equal(f.row().source_record_json,raw);assert.ok(f.row().public_display_json);
  assert.equal(Date.parse(f.row().eligible_until),Date.parse(observedAt)+35*86400000);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_maintenance_operations WHERE json_array_length(changes_json)>0').get().n,2);
  assert.ok(!JSON.stringify(usage).includes(binding.text));assert.ok(!JSON.stringify(f.receipts).includes(process.env.OPENAI_API_KEY));
  const {prepared,queued}=await f.freeze();assert.equal(prepared.revision.snapshot.products.length,1);assert.equal(queued.state,'build_queued');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1); // Never claim deployment.
  assert.ok(Object.is(f.index.get(UUID).values[0],-0));assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('stale actual observation and absent independently reviewed rights remain held through actual enrichment',async t=>{
  for(const options of [{observedAt:'2026-07-01T00:00:00.000Z'},{reviewedRights:{}}]){
    const f=await fixture(t,options);const mock=providerMocks();await executeCatalog(phase(),undefined,telemetry(),f.store,f.evidence);
    assert.equal(f.row().public_display_json,null);assert.equal(f.row().eligible_until,null);assert.ok(f.row().embedding_text_hash);
    assert.deepEqual(mock.calls,{getItems:1,searchItems:0,chat:0,embedding:1});
  }
});

test('changed post-observation facts get no fresh verification even with exact newly generated embedding',async t=>{
  const f=await fixture(t);providerMocks();
  const evidence={...f.evidence,async amazon(...args){const products=await f.evidence.amazon(...args);products[0].title='Changed unobserved brass lobster desk bell';return products;}};
  const before=f.row();await assert.rejects(executeCatalog(phase(),undefined,telemetry(),f.store,evidence),{message:'provider_evidence_superseded'});
  assert.deepEqual(f.row(),before); // No fabricated fresh fields or partial product write.
});

test('real generated discovery captures exact model inputs but invents no rights for new copy',async t=>{
  const f=await fixture(t);const remote={...product,id:'B000000002',title:'TEST ONLY novelty ceramic mushroom desk lamp',
    affiliateUrl:'https://www.amazon.com/dp/B000000002?tag=fixture-20',imageUrl:'https://example.invalid/mushroom.jpg',
    editorialStatus:'pending',editorialWriteup:null,sourceFacts:{fixture:2,material:'ceramic',shape:'mushroom',design:'lamp'}};
  const draft=Array(2).fill(Array(10).fill('Novelty ceramic mushroom lamp fixture offers an unusual desk silhouette.').join(' ')).join('\n\n');
  const mock=providerMocks(remote,draft);
  const options=parseArgs(['--theme-limit','1','--per-theme','1','--max-new','1','--min-quality-score','0.05','--backfill-limit','0']);
  options.themes=['test-only novelty objects'];await executeCatalog(options,undefined,telemetry(),f.store,f.evidence);
  const row=f.sql.prepare('SELECT * FROM products WHERE id=?').get(remote.id);
  assert.ok(row);assert.equal(row.editorial_status,'short_ready');assert.ok(row.embedding_text_hash);assert.equal(row.public_display_json,null);
  assert.deepEqual(JSON.parse(row.rights_json),{});assert.equal(f.receipts.length,2);
  assert.deepEqual(mock.calls,{getItems:0,searchItems:1,chat:2,embedding:1});
});

test('bounded discovery carries approved same-response short copy into the D1 public projection',async t=>{
  const oldTag=process.env.AMAZON_ASSOCIATE_TAG;process.env.AMAZON_ASSOCIATE_TAG='goose-gifts-37-20';
  t.after(()=>{process.env.AMAZON_ASSOCIATE_TAG=oldTag;});
  const f=await fixture(t,{allowReviewedShort:true});
  const remote={...product,id:'B000000002',title:'Funny ceramic mushroom desk lamp',
    affiliateUrl:'https://www.amazon.com/dp/B000000002?tag=goose-gifts-37-20',imageUrl:'https://example.invalid/mushroom.jpg',
    editorialStatus:'pending',editorialWriteup:null,sourceFacts:{fixture:2,material:'ceramic',shape:'mushroom',design:'lamp'}};
  providerMocks(remote);
  const options=parseArgs(['--theme-limit','1','--per-theme','1','--max-new','1','--min-quality-score','0.05','--backfill-limit','0']);
  options.themes=['test-only novelty objects'];options.discoveryNewOnly=true;
  await executeCatalog(options,undefined,telemetry(),f.store,f.evidence);
  const row=f.sql.prepare('SELECT * FROM products WHERE id=?').get(remote.id);
  assert.equal(row.editorial_status,'short_ready');
  assert.ok(row.public_display_json);
  const display=JSON.parse(row.public_display_json);
  assert.equal(display.description,'A ceramic mushroom lamp with a distinctive silhouette.');
  assert.equal(display.imageUrl,remote.imageUrl);
  assert.equal(display.affiliateUrl,remote.affiliateUrl);
  assert.equal(JSON.parse(row.rights_json).description.reference,'test-only/short-review');
});

test('later contradictory ASIN in an actual second theme cannot bless the first discovery',async t=>{
  for(const priorReady of [false,true]){
    const f=await fixture(t);providerMocks();
    if(priorReady){await executeCatalog(phase(),undefined,telemetry(),f.store,f.evidence);assert.ok(f.row().public_display_json);}
    const mock=providerMocks();
    amazonCreators.searchItems=async()=>{mock.calls.searchItems++;return[structuredClone(mock.calls.searchItems===1?product:{...product,
      title:'Different observed ceramic mushroom lamp',sourceFacts:{fixture:2,material:'ceramic',shape:'mushroom'},availabilityStatus:'UNAVAILABLE'})];};
    const options=parseArgs(['--theme-limit','2','--per-theme','1','--max-new','1','--min-quality-score','0.05','--backfill-limit','0']);
    options.themes=[product.sourceQuery,'test-only second theme'];const before=f.row();let published=0;
    const store=createD1CatalogTelemetryStore({db:f.db,owner:f.cursor.current,ownerCursor:f.cursor,runId:'weekly-run',catalogRevision:'weekly-r'});
    await assert.rejects(runCatalogWithBackend(options,{runId:'weekly-run',maintenanceStore:f.store,telemetryStore:store,providerEvidence:f.evidence,
      async publish(){published++;throw new Error('Cannot publish superseded facts');},async finalizeRun(id,input){await store.finishCatalogRun(id,input);return store.loadCatalogRun(id);}}),
    {message:'provider_evidence_superseded'});
    assert.deepEqual(f.row(),before);assert.equal(published,0);assert.equal((await store.loadCatalogRun('weekly-run')).run.status,'failed');
    assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1);
    assert.throws(()=>f.evidence.intent('upsertProduct',[product,editorialSourceHash(product)]),/superseded/);
    assert.deepEqual(mock.calls,{getItems:0,searchItems:2,chat:0,embedding:0});
  }
});

test('latest ASIN only: same-response image variants survive; missing/invalid/uncertain GetItems invalidate, search omission does not',async()=>{
  let fail=false;
  const evidence=createCatalogProviderEvidence({now:()=>NOW,async saveReceipt(input){if(fail)throw new Error('PRIVATE failure');
    return{sha256:input.sha256,reference:`test-only/${input.sha256}`};}});
  const check=p=>evidence.intent('upsertProduct',[p,editorialSourceHash(p)]).verificationById;
  const raw={...product,imageUrl:product.imageUrl+'_SL300_.jpg'};
  await evidence.amazon('searchItems',async()=>[raw],p=>({...p,imageUrl:product.imageUrl}));assert.ok(check(raw));assert.ok(check(product));
  await evidence.amazon('searchItems',async()=>[]);assert.ok(check(raw));assert.ok(check(product));
  await evidence.amazon('getItems',async()=>[],undefined,[ID]);assert.throws(()=>check(raw),/superseded/);assert.throws(()=>check(product),/superseded/);
  for(const response of [[{...product,remotelyVerified:false}],[{...product,title:''}],[{...product,sourceFacts:{}}]]){
    await evidence.amazon('searchItems',async()=>[product]);await evidence.amazon('getItems',async()=>response,undefined,[ID]);assert.throws(()=>check(product),/superseded/);
  }
  await evidence.amazon('searchItems',async()=>[product]);fail=true;
  await assert.rejects(evidence.amazon('getItems',async()=>[{...product,title:'Contradictory new title'}],undefined,[ID]),/storage_unconfirmed/);
  assert.throws(()=>check(product),/superseded/);
  fail=false;await evidence.amazon('searchItems',async()=>[product]);
  await assert.rejects(evidence.amazon('getItems',async()=>[product,product],undefined,[ID]),/products/);assert.throws(()=>check(product),/superseded/);
  const changed={...product,title:'New actual observed brass lobster bell'};await evidence.amazon('searchItems',async()=>[changed]);
  assert.ok(check(changed));assert.throws(()=>check(product),/superseded/);
});

test('obsolete Google credentials cannot bypass SearchItems receipt uncertainty',async t=>{
  const f=await fixture(t);const mock=providerMocks();let google=0;const openai=responder;
  process.env.GOOGLE_SEARCH_API_KEY='TEST_ONLY_NO_CREDENTIAL';process.env.GOOGLE_SEARCH_ENGINE_ID='TEST_ONLY_ENGINE';
  t.after(()=>{delete process.env.GOOGLE_SEARCH_API_KEY;delete process.env.GOOGLE_SEARCH_ENGINE_ID;});
  responder=(url,init)=>{if(String(url).startsWith('https://customsearch.googleapis.com/')){google++;return Response.json({items:[]});}return openai(url,init);};
  const evidence=createCatalogProviderEvidence({async saveReceipt(){throw new Error('PRIVATE receipt failure');}});
  const options=parseArgs(['--dry-run','--theme-limit','1','--per-theme','10','--max-new','1','--backfill-limit','0']);
  await assert.rejects(executeCatalog(options,undefined,telemetry(),f.store,evidence),{message:'provider_evidence_storage_unconfirmed'});
  assert.equal(google,0);assert.deepEqual(mock.calls,{getItems:0,searchItems:1,chat:0,embedding:0});
});

test('discovery never calls retired search or GetItems fallback with obsolete credentials present',async t=>{
  process.env.GOOGLE_SEARCH_API_KEY='TEST_ONLY_NO_CREDENTIAL';process.env.GOOGLE_SEARCH_ENGINE_ID='TEST_ONLY_ENGINE';
  t.after(()=>{delete process.env.GOOGLE_SEARCH_API_KEY;delete process.env.GOOGLE_SEARCH_ENGINE_ID;});
  for(const result of ['partial','empty','throttled']){
    const f=await fixture(t);const mock=providerMocks();let externalRequests=0;
    amazonCreators.searchItems=async()=>{
      mock.calls.searchItems++;
      if(result==='throttled')throw new amazonCreators.AmazonCreatorsApiError('TooManyRequests',{status:429});
      return result==='partial'?[structuredClone(product)]:[];
    };
    responder=()=>{externalRequests++;throw new Error('Unexpected external request');};
    const options=parseArgs(['--dry-run','--theme-limit','1','--per-theme','10','--max-new','1','--min-quality-score','0.05','--backfill-limit','0']);
    const observed=telemetry();
    await executeCatalog(options,undefined,observed,f.store,f.evidence);
    assert.equal(externalRequests,0,result);
    assert.deepEqual(mock.calls,{getItems:0,searchItems:1,chat:0,embedding:0});
    if(result==='throttled'){
      assert.equal(f.receipts.length,0);
      assert.equal(observed.warnings[0].reasonCode,'provider_throttled');
    }else{
      assert.equal(f.receipts.length,1);
      assert.equal(f.receipts[0].receipt.operation,'searchItems');
      assert.equal(f.receipts[0].receipt.products.some(p=>p.id===ID),result==='partial');
    }
  }
});

test('non-throttling discovery errors propagate without a fallback request',async t=>{
  const f=await fixture(t);providerMocks();let externalRequests=0;
  amazonCreators.searchItems=async()=>{throw new Error('TEST ONLY source unavailable');};
  responder=()=>{externalRequests++;throw new Error('Unexpected external request');};
  const options=parseArgs(['--dry-run','--theme-limit','1','--per-theme','10','--max-new','1','--backfill-limit','0']);
  await assert.rejects(executeCatalog(options,undefined,telemetry(),f.store,f.evidence),/source unavailable/);
  assert.equal(externalRequests,0);assert.equal(f.receipts.length,0);
});

test('actual transformed-image revalidation uses opt-in clean hash; default PG-compatible raw hash is unchanged',async t=>{
  const remote={...product,imageUrl:product.imageUrl+'_SL300_.jpg'};const options=parseArgs(['--revalidate','--revalidate-limit','1']);
  for(const capture of [false,true]){
    const f=await fixture(t);providerMocks(remote);let incoming;
    const store={...f.store,async upsertProduct(...args){incoming=args;return f.store.upsertProduct(...args);}};
    await executeCatalog(options,undefined,telemetry(),store,capture?f.evidence:undefined);
    assert.equal(incoming[0].imageUrl,product.imageUrl);
    assert.equal(incoming[1],editorialSourceHash(capture?product:remote));
    if(capture){assert.ok(f.evidence.intent('upsertProduct',incoming).verificationById);assert.equal(f.receipts[0].receipt.products.length,2);}
    else assert.equal(incoming[1]===editorialSourceHash(incoming[0]),false);
  }
});

test('receipt storage uncertainty cannot produce evidence or silently rerun merchant/model work',async()=>{
  let calls=0;let saved;
  const evidence=createCatalogProviderEvidence({async saveReceipt(input){saved=input;throw new Error('PRIVATE SECRET failure');}});
  await assert.rejects(evidence.amazon('getItems',async()=>{calls++;return[product];}),{message:'provider_evidence_storage_unconfirmed'});
  assert.equal(calls,1);assert.ok(saved.sha256);assert.throws(()=>evidence.intent('upsertProduct',[product,editorialSourceHash(product)]),/superseded/);
});

test('real discovery/revalidation hooks use existing calls and capture request-start time without raw search terms',async t=>{
  const f=await fixture(t);const mock=providerMocks();
  const options=parseArgs(['--dry-run','--theme-limit','1','--per-theme','1','--max-new','1','--min-quality-score','0.05','--backfill-limit','0']);
  options.themes=['TEST ONLY PRIVATE SEARCH TERM'];
  const never=()=>{throw new Error('Dry run cannot publish or finalize');};
  const backend={runId:'test-dry',maintenanceStore:f.store,providerEvidence:f.evidence,publish:never,finalizeRun:never,
    telemetryStore:Object.fromEntries(['startCatalogRun','finishCatalogRun','insertCatalogRunItems','loadCatalogRun','loadRecentCatalogRuns'].map(name=>[name,never]))};
  await runCatalogWithBackend(options,backend);
  assert.equal(mock.calls.searchItems,1);assert.equal(mock.calls.getItems,0);assert.equal(f.receipts.length,1);
  assert.ok(!JSON.stringify(f.receipts).includes(options.themes[0]));
  await executeCatalog(parseArgs(['--revalidate','--revalidate-limit','1']),undefined,telemetry(),f.store,f.evidence);
  assert.equal(mock.calls.getItems,1);assert.equal(mock.calls.embedding,0);assert.equal(f.receipts.length,2);
  let clock=NOW;let captured;
  const evidence=createCatalogProviderEvidence({now:()=>clock,async saveReceipt(input){captured=input.receipt;return{sha256:input.sha256,reference:'test-only/captured'};}});
  await evidence.amazon('getItems',async()=>{clock='2026-10-21T12:00:00.123Z';return[product];});
  assert.equal(Date.parse(captured.observedAt),Date.parse(NOW));
});

test('weekly backend forwards evidence through BOTH actual bounded phases without duplicate provider calls',async t=>{
  const f=await fixture(t);const mock=providerMocks();const before=f.sql.prepare('SELECT mutation_epoch epoch FROM catalog_mutation_scopes').get().epoch;
  const never=()=>{throw new Error('Dry weekly run cannot write telemetry, publish or finalize');};
  const result=await runWeeklyCatalogWithBackend({dryRun:true,backfillLimit:0,runId:'test-weekly-dry',maintenanceStore:f.store,providerEvidence:f.evidence,
    publish:never,finalizeRun:never,telemetryStore:Object.fromEntries(['startCatalogRun','finishCatalogRun','insertCatalogRunItems','loadCatalogRun','loadRecentCatalogRuns'].map(name=>[name,never]))});
  assert.equal(result.results[0].selected,1);assert.equal(result.results[1].themes.length,6);
  assert.deepEqual(mock.calls,{getItems:1,searchItems:6,chat:0,embedding:0});assert.equal(f.receipts.length,7);
  assert.equal(f.sql.prepare('SELECT mutation_epoch epoch FROM catalog_mutation_scopes').get().epoch,before);
});

test('input/model/index/vector/facts/availability tampering refuses proof; rights never inferred',async()=>{
  const evidence=createCatalogProviderEvidence({async saveReceipt(input){return{sha256:input.sha256,reference:`test-only/${input.sha256}`};},now:()=>NOW});
  await evidence.amazon('getItems',async()=>[product]);
  const p={...product,embedding:values};const text=maintenanceEmbeddingText(p);const response={model:'text-embedding-3-small',data:[{index:0,embedding:values}]};
  for(const input of [{products:[p],model:'other',inputs:[text],response},{products:[p],model:response.model,inputs:[text+'changed'],response},
    {products:[p],model:response.model,inputs:[text],response:{...response,data:[{index:1,embedding:values}]}},
    {products:[p],model:response.model,inputs:[text],response:{...response,data:[{index:0,embedding:[NaN]}]}}])await assert.rejects(evidence.embeddings(input));
  await evidence.embeddings({products:[p],model:response.model,inputs:[text],response});
  const hash=editorialSourceHash(p);assert.ok(evidence.intent('upsertProduct',[p,hash]).embeddingById);
  assert.equal(evidence.intent('upsertProduct',[p,hash]).rightsById,undefined);
  assert.throws(()=>evidence.intent('upsertProduct',[{...p,availabilityStatus:'UNKNOWN'},hash]),/superseded/);
  assert.throws(()=>evidence.intent('upsertProduct',[{...p,remotelyVerified:false},hash]),/superseded/);
  assert.throws(()=>evidence.intent('upsertProduct',[{...p,source:'unknown'},hash]),/superseded/);
  assert.equal(evidence.intent('upsertProduct',[{...p,embedding:values.map((v,i)=>i===2?.2:v)},hash]).embeddingById,undefined);
  assert.throws(()=>evidence.intent('upsertProduct',[{...p,title:'Unobserved title'},editorialSourceHash({...p,title:'Unobserved title'})]),/superseded/);
  await assert.rejects(evidence.amazon('getItems',async()=>[product],p=>({...p,title:'Invented title'})),/normalization/);
  const unknown={...product,sourceFacts:{}};await evidence.amazon('getItems',async()=>[unknown]);
  assert.throws(()=>evidence.intent('upsertProduct',[unknown,editorialSourceHash(unknown)]),/superseded/);
  const empty={...product,sourceFacts:{unknown:null}};await evidence.amazon('getItems',async()=>[empty]);
  assert.throws(()=>evidence.intent('upsertProduct',[empty,editorialSourceHash(empty)]),/superseded/);
  const missing={...product,title:''};await evidence.amazon('getItems',async()=>[missing]);
  assert.throws(()=>evidence.intent('upsertProduct',[missing,editorialSourceHash(missing)]),/superseded/);
});

test('opt-in evidence leaves actual phase PostgreSQL bind payload, provider count and caps unchanged',async t=>{
  const queries=[];const pg=createPostgresCatalogMaintenanceStore({async query(sql,params){queries.push({sql,params});
    return{rows:[{inserted:false,slug:'test-only-lobster'}],rowCount:1};}});
  // Compare actual phase arguments with/without capture, then bind both through
  // the unchanged real PG adapter with a query spy (no Neon connection).
  const f=await fixture(t);const spy=[];const delegated={...f.store,async upsertProduct(...args){spy.push(structuredClone(args));return f.store.upsertProduct(...args);}};
  const mock=providerMocks();await executeCatalog(phase(),undefined,telemetry(),delegated);
  assert.deepEqual(mock.calls,{getItems:1,searchItems:0,chat:0,embedding:1});assert.equal(f.row().public_display_json,null);
  assert.ok(Object.is(spy[0][0].embedding[0],-0));assert.equal(spy[0][0].embedding[2],.1);
  await pg.upsertProduct(...spy[0]);const first=structuredClone(queries.at(-1));
  const g=await fixture(t);const next=[];const captured={...g.store,async upsertProduct(...args){next.push(structuredClone(args));return g.store.upsertProduct(...args);}};
  const other=providerMocks();await executeCatalog(phase(),undefined,telemetry(),captured,g.evidence);
  await pg.upsertProduct(...next[0]);assert.deepEqual(queries.at(-1),first);assert.deepEqual(other.calls,mock.calls);
  assert.ok(g.row().public_display_json);assert.equal(f.row().public_display_json,null);
  assert.equal(phase().backfillLimit,1);assert.equal(parseArgs([]).revalidateLimit,50);assert.equal(parseArgs([]).maxNew,50);
});
