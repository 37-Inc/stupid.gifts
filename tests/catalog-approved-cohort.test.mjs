import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvedCohortOperationKey, approvedCohortVectorPlan, prepareApprovedCohort, settleApprovedCohort } from '../lib/catalog/freeze-approved-cohort.ts';
import {approvedRequestControl,hydrateApprovedRequest} from '../scripts/catalog/approved-catalog-seal.ts';
import {recoverProjectionSeal} from '../scripts/catalog/recover-projection-seal.ts';
import { claimMutationOwnership, readMutationOwner, releaseMutationOwnership,mutationAssertion } from '../lib/catalog/mutation-fence.ts';
import {permanentSourceRows,permanentSourceInventory} from '../lib/catalog/freeze-permanent-catalog.ts';
import { createProjectionPacket, projectionQueries, getRevisionProductsByPublicIds } from '../lib/catalog/d1.ts';
import { validateCatalogSnapshot } from '../lib/catalog/snapshot.ts';
import { createSealedSnapshotEnvelope, reconstructD1Snapshot } from '../scripts/catalog/export-d1-snapshot.ts';
import { canonicalJson, sha256 } from '../scripts/catalog/migration.ts';
import { createD1CatalogMaintenanceStore, loadMaintenanceVectorPayload } from '../scripts/catalog/maintenance-d1.ts';
import { maintenanceEmbeddingText } from '../scripts/catalog/maintenance-state.ts';
import { editorialSourceHash } from '../scripts/ops/catalog-editorial-core.mjs';
import { nativeHash, payloadVector } from '../scripts/catalog/vector-outbox.ts';
import { abandonExpiredPrunedRevision, deliverOwnedOutboxEvent, deliverOwnedApprovedCohortVector, readOwnedApprovedCohortVectors,
  reuseOwnedApprovedCohortVectorProof, readActivatedCatalogVectors, settleOwnedApprovedCohortVectorProof, prepareOwnedApprovedCohortPlan,
  resumeOwnedPrunedDelete } from '../scripts/catalog/owned-vector-delivery.ts';
import { claimBuildRequest, beginBuildActivation, resolveBuildActivation } from '../lib/catalog/build-requests.ts';
import { enqueuePublication, claimPublication, recordPublicationDispatch, completeActivatedApprovedCatalogPublication } from '../lib/catalog/publication.ts';
import { approvedRevisionControl, hydrateApprovedRevision, createApprovedCatalogSeal, readApprovedPrior } from '../scripts/catalog/approved-catalog-seal.ts';
import { sealCapturedRevision, settleCapturedRevision } from '../lib/catalog/prune-existing-revision.ts';
import { createCatalogD1Rest } from '../scripts/catalog/d1-write-rest.ts';
import { openRunWorkspace } from '../scripts/catalog/run-workspace.ts';
import { createVectorizeRestAdapters } from '../scripts/catalog/vectorize-rest.ts';
import { accountedPublicationReadFetch } from '../scripts/catalog/publication-read-fetch.ts';

const AT = Date.parse('2026-10-20T12:00:00.000Z');
const at = ms => new Date(AT+ms).toISOString();
const scope = { environment:'staging',indexName:'test-approved-cohort' };
const id = n => `B${String(n).padStart(9,'0')}`;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const source = 'b'.repeat(64);
const values = Array(1536).fill(Math.fround(.1)); values[0]=-0;
const names = ['Brass lobster desk bell','Velvet mushroom reading lamp','Cosmic pickle kayak anchor','Glass cactus snow globe','Rubber flamingo bath mat'];
function product(n, overrides={}) {
  return { id:id(n),title:names[n-1]||`Fixture object ${n}`,price:19.99,currency:'USD',source:'amazon',
    imageUrl:`https://example.invalid/owned-${n}.jpg`,affiliateUrl:`https://www.amazon.com/dp/${id(n)}?tag=fixture-20`,
    humorTags:[`fixture${n}`],punnyTitle:null,wittyDescription:`Owned synthetic description ${n}.`,sourceQuery:'synthetic',
    sourceFacts:{fixture:n},isActive:true,qualityScore:.85,availabilityStatus:'IN_STOCK',remotelyVerified:true,
    editorialStatus:'generated_ready',editorialQualityScore:.95,editorialWriteup:Array(2).fill(Array(55).fill(`Specific useful owned editorial ${n}`).join(' ')).join('\n\n'),
    embedding:[...values],...overrides };
}
const rights = p => Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,
  affiliateUrl:p.affiliateUrl,wittyDescription:p.wittyDescription,editorialWriteup:p.editorialWriteup,humorTags:JSON.stringify(p.humorTags)})
  .map(([field,value])=>[field,{basis:'owned',reference:`test-only-owned/${p.id}/${field}`,value}]));
async function setup(t,{initial=2,permanent=0,extraHeld=0,preservePermanentListings=false,earlyExpiry=[],stockHeld=[]}={}) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name=>/^\d{4}.*\.sql$/.test(name)).sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  let clock=AT;let before;let after;let lost;
  sql.function('strftime',(format,instant)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return new Date(clock).toISOString();});
  let db={prepare(query){let params=[];return{query,bind(...args){assert.ok(args.length<=100);params=args;return this;},
    async all(){const results=sql.prepare(query).all(...params).map(row=>({...row}));
      // Deliberately reverse this unordered candidate query; neither digest nor
      // approved display order may accidentally depend on provider row order.
      return{results:query.startsWith('SELECT p.* FROM json_each(?) ids')?results.reverse():results};},
    async run(){return sql.prepare(query).run(...params);},execute(){before?.(query);return sql.prepare(query).all(...params);}};},
    async batch(statements){const results=[];sql.exec('BEGIN');try{for(const s of statements)results.push({results:s.execute().map(r=>({...r}))});sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}
      after?.(statements);if(lost?.(statements)){lost=null;throw new Error('PRIVATE lost response');}return results;}};
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const index=new Map();let calls=0;let unknown=false;const sent=[];
  const adapters={...scope,providerIdentity:'test:owned-index',async dispatch(input){calls++;sent.push(structuredClone(input));
    if(input.vector)index.set(input.publicId,structuredClone(input.vector));else index.delete(input.publicId);
    if(unknown)throw new Error('PRIVATE unknown provider');return{reference:`test-mutation-${calls}`};},
    async resolve(input){return unknown?{state:'pending'}:{state:'settled',reference:input.reference||`test-mutation-${calls}`};},
    async readback(publicId){return structuredClone(index.get(publicId)||null);}};
  let cursor={current:await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'seed-run',operationKey:'a'.repeat(64)})};
  let mode={runId:'seed-run',catalogRevision:'prior-revision'};let intentOverride;
  let nextNew=10000;
  function store() { return createD1CatalogMaintenanceStore({db,owner:cursor.current,ownerCursor:cursor,...mode,preservePermanentListings,
    newPublicId:()=>mode.runId!=='seed-run'&&permanent?uuid(nextNew++):uuid(Number(sql.prepare('SELECT count(*) n FROM products').get().n)+1),
    intent(_method,args){const p=args[0];if(!p?.id)return{reviewedDeleteReference:'test-only/delete'};
      const hash=args[1],granted=rights(p);if(earlyExpiry.includes(p.id))granted.imageUrl.expiresAt=at(3600000);
      return intentOverride?intentOverride(p,hash):{rightsById:{[p.id]:granted},
        verificationById:{[p.id]:{reference:'test-only/source-observation',observedAt:at(earlyExpiry.includes(p.id)?-23*3600000:-3600000),sourceFactsHash:hash}},
        ...(p.embedding?{embeddingById:{[p.id]:{reference:'test-only/original-embedding',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}}:{}),
        reviewedDeleteReference:'test-only/delete'};}}); }
  async function upsert(p){const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
    try{await store().upsertProduct(p,hash);}catch(error){throw new Error(`${p.id}: ${error.message}`,{cause:error});}}
  async function drain(){for(const row of sql.prepare("SELECT sequence FROM vector_sync_outbox WHERE status='pending' ORDER BY sequence").all()){
    const options={db,owner:cursor.current,sequence:row.sequence,catalogRevision:mode.catalogRevision,loadPayload:event=>loadMaintenanceVectorPayload(db,event),adapters};
    const first=await deliverOwnedOutboxEvent(options);cursor.current=first.owner;
    if(first.state==='pending'){const second=await deliverOwnedOutboxEvent({...options,owner:cursor.current});cursor.current=second.owner;assert.equal(second.state,'complete');}
    else assert.equal(first.state,'complete');}}
  for(let n=1;n<=initial;n++)await upsert(product(n));
  await upsert(product(initial+1,{isActive:false,embedding:null}));
  await drain();
  for(let n=100;n<100+permanent;n++){
    const p={id:id(n),publicId:uuid(n),slug:`independent-object-${n}`,title:`Independent object ${n}`,
      description:`Independent object ${n}`,imageUrl:'/images/gift-placeholder.svg',affiliateUrl:`https://www.amazon.com/dp/${id(n)}?tag=fixture-20`,
      source:'amazon',currency:'USD',price:0,isActive:true,qualityScore:.85,eligibleUntil:null,indexable:false};
    const grants=Object.fromEntries(['title','description','imageUrl','affiliateUrl'].map(field=>[field,{basis:'owned',reference:'synthetic exact clearance',value:p[field]}]));
    sql.prepare(`INSERT INTO products(id,public_id,slug,source,title,description,tags,currency,quality_score,is_active,editorial_status,
      source_facts_hash,catalog_revision,public_display_json,rights_json,source_record_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id,p.publicId,p.slug,p.source,p.title,p.description,'',p.currency,p.qualityScore,1,'pending',source,'prior-revision',JSON.stringify(p),JSON.stringify(grants),
        JSON.stringify({id:p.id,public_id:p.publicId,slug:p.slug,source:p.source,title:p.title,description:p.description,price:'0',currency:p.currency,
          image_url:p.imageUrl,affiliate_url:p.affiliateUrl,humor_tags:'{}',is_active:true,quality_score:.85,editorial_status:'pending'}));
  }
  for(let n=3000;n<3000+extraHeld;n++)sql.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,quality_score,is_active,editorial_status,catalog_revision,rights_json,timestamp_provenance_json,source_record_json)
    VALUES(?,?,?,?,?,'USD',.4,0,'pending','prior-revision','{}','{"schemaVersion":1,"fields":{}}',?)`).run(id(n),uuid(n),`held-${n}`,'amazon',`Held ${n}`,
      JSON.stringify({id:id(n),public_id:uuid(n),slug:`held-${n}`,source:'amazon',title:`Held ${n}`,affiliate_url:`https://www.amazon.com/dp/${id(n)}`}));
  const rows=sql.prepare('SELECT * FROM products ORDER BY public_id').all();
  const previous=structuredClone(validateCatalogSnapshot({schemaVersion:1,dataKind:'catalog',catalogRevision:'prior-revision',generatedAt:at(0),
    products:rows.filter(row=>row.public_display_json).map(row=>JSON.parse(row.public_display_json)),
    heldProducts:rows.filter(row=>!row.public_display_json).map(row=>({id:row.id,publicId:row.public_id,slug:row.slug,path:`/gifts/${row.slug}`,
      title:'Gift currently unavailable',description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'inactive'})),
    slugHistory:[{slug:'older-lobster',canonicalSlug:rows[0].slug,publicId:rows[0].public_id}]},new Date(AT)));
  for(const n of stockHeld){const p=previous.products.find(p=>p.id===id(n));assert.ok(p);
    previous.products=previous.products.filter(value=>value!==p);previous.heldProducts.push({id:p.id,publicId:p.publicId,slug:p.slug,path:`/gifts/${p.slug}`,
      title:'Gift currently unavailable',description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'unavailable'});}
  const packet=await createProjectionPacket(previous,Object.fromEntries(rows.map(row=>[row.public_id,row.source_facts_hash])),source,new Date(AT));
  sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run(previous.catalogRevision,at(0),source,'published');
  for(const q of projectionQueries(packet))sql.prepare(q.sql).run(...q.params);
  const priorIntent={releaseId:'prior-release',catalogRevision:previous.catalogRevision,codeSha:'c'.repeat(40),catalogSnapshotSha256:packet.receipt.snapshot_sha256,
    manifestSha256:'f'.repeat(64),vectorSyncWatermark:initial,priorReleaseId:null,nextExpiry:previous.products[0]?.eligibleUntil??null};
  const prior={release_id:'prior-release',catalog_revision:previous.catalogRevision,code_sha:priorIntent.codeSha,completed_at:at(0),manifest_json:JSON.stringify(priorIntent)};
  sql.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(...Object.values(prior));
  const sealed=createSealedSnapshotEnvelope(previous);
  const context={envelopeSha256:sha256(`${JSON.stringify(sealed)}\n`),snapshotSha256:packet.receipt.snapshot_sha256,projectionSha256:packet.receipt.projection_sha256,
    sourceExportSha256:source,vectorSyncWatermark:initial,publicationReceiptWatermark:1,cutoff:at(6*3600000),
    priorPublication:{releaseId:prior.release_id,receiptSha256:sha256(canonicalJson(prior))}};
  const originals=new Map(previous.products.map(p=>{const row=rows.find(row=>row.public_id===p.publicId);const original={publicId:p.publicId,
    catalogRevision:previous.catalogRevision,sourceFactsHash:row.source_facts_hash,embeddingTextHash:row.embedding_text_hash,
    values:[...values],vectorBytesSha256:nativeHash(values)};
    return[p.publicId,{sha256:sha256(canonicalJson(original)),async load(){return original;}}];}));
  await releaseMutationOwnership(db,cursor.current);
  clock+=1000; // A later real weekly observation/write, not the seed transaction's clock.
  cursor={current:await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'weekly-run',operationKey:'d'.repeat(64)})};
  mode={runId:'weekly-run',catalogRevision:'approved-revision'};
  const f={sql,db,local:db,adapters,index,sent,previous,packet,context,priorIntent,originals,upsert,drain,
    markUnavailable:ids=>store().markConfirmedMissingUnavailable(ids),
    useDb(value){db=value;f.db=value;},
    owner:()=>cursor.current,now:()=>new Date(clock),advance(ms){clock+=ms;},calls:()=>calls,setIntent(fn){intentOverride=fn;},
    before(fn){before=fn;},after(fn){after=fn;},lose(fn){lost=fn;},uncertain(value){unknown=value;},
    async freeze(ids=[],publicationRevision,ownerReference='approved-build'){
      const changes=ids.map(publicId=>{
        const row={...sql.prepare('SELECT * FROM products WHERE public_id=?').get(publicId)};
        const operation=sql.prepare(`SELECT * FROM catalog_maintenance_operations WHERE run_id='weekly-run' AND EXISTS(
          SELECT 1 FROM json_each(changes_json) c WHERE json_extract(c.value,'$.productId')=?) ORDER BY next_epoch DESC LIMIT 1`).get(row.id);
        return{publicId,operationId:operation.operation_id,inputSha256:operation.input_sha256,productSha256:sha256(canonicalJson(row)),
          displaySha256:sha256(row.public_display_json??'null')};});
      const approval={schemaVersion:1,...mode,changes};const request={previous,context,scope,codeSha:'e'.repeat(40),approval,approvalSha256:sha256(canonicalJson(approval))};
      if(publicationRevision)request.publicationRevision=publicationRevision;
      await releaseMutationOwnership(db,cursor.current);
      const owner=await claimMutationOwnership(db,scope,{phase:'freezing',ownerReference,operationKey:approvedCohortOperationKey(request)});
      return{owner,request};
    },
    async promote(prepared){let owner=prepared.owner;const revision=prepared.revision;const plan=approvedCohortVectorPlan(revision);
      for(const publicId of [...plan.products.map(p=>p.publicId),...plan.absentIds]){
        const changed=revision.request.approval.changes.some(p=>p.publicId===publicId);
        const options={db,owner,revision,publicId,adapters,...(!changed&&plan.products.some(p=>p.publicId===publicId)?{original:originals.get(publicId)}:{})};
        const first=await deliverOwnedApprovedCohortVector(options);owner=first.owner;
        if(first.state==='pending'){const next=await deliverOwnedApprovedCohortVector({...options,owner});assert.equal(next.state,'complete');owner=next.owner;}
        else assert.equal(first.state,'complete');
      }return owner;
    }};return f;
}
test('confirmed unavailable cleared listing leaves every public projection but preserves its source and native history',async t=>{
  const f=await setup(t,{permanent:1,preservePermanentListings:true});
  const original=f.sql.prepare('SELECT * FROM products WHERE id=?').get(id(100));
  await f.markUnavailable([id(100)]);const row=f.sql.prepare('SELECT * FROM products WHERE id=?').get(id(100));
  assert.equal(row.is_active,1);assert.equal(row.slug,original.slug);assert.equal(row.source_record_json,original.source_record_json);
  assert.ok(row.public_display_json);const writes=f.calls();
  const input=await f.freeze([uuid(100)]),result=await prepareApprovedCohort(f.db,input.owner,input.request);
  assert.ok(!result.revision.snapshot.products.some(p=>p.id===id(100)));
  assert.equal(result.revision.snapshot.heldProducts.find(p=>p.id===id(100)).reason,'unavailable');
  assert.ok(!approvedCohortVectorPlan(result.revision).absentIds.includes(uuid(100)));
  assert.equal(f.calls(),writes);
});
test('stock-held cleared identity returns at the same URL only after a real positive retailer observation',async t=>{
  for(const status of ['UNKNOWN','IN_STOCK']){
    const f=await setup(t,{permanent:1,preservePermanentListings:true,stockHeld:[100]});
    const before=f.sql.prepare('SELECT * FROM products WHERE id=?').get(id(100));
    await f.upsert(product(100,{availabilityStatus:status,embedding:undefined}));await f.drain();
    const input=await f.freeze([uuid(100)]),result=await prepareApprovedCohort(f.db,input.owner,input.request);
    const restored=result.revision.snapshot.products.find(p=>p.id===id(100));
    if(status==='UNKNOWN')assert.equal(result.revision.snapshot.heldProducts.find(p=>p.id===id(100)).reason,'unavailable');
    else{assert.ok(restored);assert.equal(restored.slug,before.slug);assert.equal(restored.publicId,before.public_id);}
    assert.equal(f.sql.prepare('SELECT count(*) n FROM products').get().n,4);
  }
});
test('committed projection seal recovers the exact owner before stale checkpoint hydration, without writes or dispatch',async t=>{
  const f=await setup(t);await f.upsert(product(1,{sourceFacts:{fresh:true}}));await f.drain();
  const claim=await f.freeze([uuid(1)],undefined,'weekly-run:freeze');
  const control=approvedRequestControl(claim.request),prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  await assert.rejects(hydrateApprovedRequest(f.db,claim.owner,control),/read_bounds/);
  const before=f.sql.prepare('SELECT total_changes() n').get().n,calls=f.calls();
  const recovered=await recoverProjectionSeal(f.db,claim.owner,control);
  assert.deepEqual(recovered,{owner:prepared.owner,request:claim.request});
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.calls(),calls);
  assert.deepEqual(await recoverProjectionSeal(f.db,recovered.owner,control),recovered);
});
test('projection recovery rejects a different owner, extra epoch, changed receipt and source drift',async t=>{
  for(const fault of ['owner','epoch','receipt','source'])await t.test(fault,async t=>{
    const f=await setup(t);await f.upsert(product(1,{sourceFacts:{fresh:true}}));await f.drain();const claim=await f.freeze([uuid(1)],undefined,'weekly-run:freeze');
    const control=approvedRequestControl(claim.request);await prepareApprovedCohort(f.db,claim.owner,claim.request);
    if(fault==='owner')f.sql.prepare('UPDATE catalog_mutation_scopes SET owner_token=?').run('other-owner');
    if(fault==='epoch')f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1');
    if(fault==='receipt')f.useDb({...f.local,prepare(query){const statement=f.local.prepare(query);return{...statement,
      bind(...args){statement.bind(...args);return this;},async all(...args){const result=await statement.all(...args);
        if(query==='SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?')for(const row of result.results)row.projection_sha256='0'.repeat(64);
        return result;}};}});
    if(fault==='source')f.sql.prepare('UPDATE products SET description=? WHERE public_id=?').run('Changed source',uuid(1));
    const before=f.sql.prepare('SELECT total_changes() n').get().n,calls=f.calls();
    await assert.rejects(recoverProjectionSeal(f.db,claim.owner,control));
    assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,before);assert.equal(f.calls(),calls);
  });
});
test('multiple approved changes use one bounded receipt read without weakening per-change checks',async t=>{
  const f=await setup(t,{initial:3});
  for(let n=1;n<=3;n++)await f.upsert(product(n,{sourceFacts:{fixture:n,revision:'fresh'}}));
  await f.drain();
  const {owner,request}=await f.freeze([uuid(1),uuid(2),uuid(3)]);
  let receiptReads=0;const original=f.local.prepare.bind(f.local);
  f.useDb({...f.local,prepare(query){if(query.includes('SELECT * FROM catalog_maintenance_operations'))receiptReads++;return original(query);}});
  const prepared=await prepareApprovedCohort(f.db,owner,request);
  assert.equal(prepared.state,'prepared');assert.equal(prepared.revision.snapshot.products.length,3);
  assert.equal(receiptReads,1);
  const wrong=structuredClone(request);wrong.approval.changes[1].inputSha256='0'.repeat(64);
  wrong.approvalSha256=sha256(canonicalJson(wrong.approval));
  await releaseMutationOwnership(f.db,prepared.owner);
  const wrongOwner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'wrong-input-proof',operationKey:approvedCohortOperationKey(wrong)});
  // Even a matching owner/checksum cannot substitute the second receipt's input.
  await assert.rejects(()=>prepareApprovedCohort(f.db,wrongOwner,wrong),/cohort_approval_changed/);
});
test('publication-only zero-effect policy keeps ingestion IDs and resumes its exact committed candidate',async t=>{
  const f=await setup(t,{initial:0,permanent:2,preservePermanentListings:true});
  await f.upsert(product(100,{sourceFacts:{fresh:true},embedding:null,editorialStatus:'pending'}));await f.drain();
  const claim=await f.freeze([uuid(100)],'publication-recovery'),approval=structuredClone(claim.request.approval);
  let sealed;
  const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters,
    beforeSeal:async(owner,revision)=>{sealed={owner,revision:structuredClone(revision)};}});
  assert.equal(prepared.revision.snapshot.catalogRevision,'publication-recovery');
  assert.deepEqual(prepared.revision.request.approval,approval);
  assert.deepEqual(prepared.remainingIds,[]);
  assert.equal(f.calls(),0);
  const before=f.sql.prepare('SELECT total_changes() n').get().n;
  const resumed=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters,sealed});
  assert.deepEqual(resumed,prepared);
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,before);
  for(const mutate of [r=>{r.request.publicationRevision='wrong-target';},r=>{r.sourceDigest='0'.repeat(64);}]){
    const bad=structuredClone(sealed);mutate(bad.revision);
    await assert.rejects(prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters,sealed:bad}));
  }
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner:resumed.owner,revision:resumed.revision,adapters:f.adapters});
  assert.ok(queued.requestId);assert.equal(f.calls(),0);
  const {revision}=resumed,build=await claimBuildRequest(f.db,queued.requestId,'test-only/recovery',f.now());
  const intent={releaseId:'recovery-release',catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
    catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
    priorReleaseId:'prior-release',nextExpiry:null};
  await enqueuePublication(f.db,revision.snapshot,intent,f.now());
  const publication=await claimPublication(f.db,revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,revision.snapshot,publication,'test-only/recovery-dispatch',f.now());
  const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,'test-only/recovery-upload',async()=>({environment:'staging',settled:true,
    active:{...f.priorIntent,versionReference:'old-version'}}),f.now(),queued.owner);
  const plan=approvedCohortVectorPlan(revision),control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),ids:[]};
  assert.equal((await readActivatedCatalogVectors(f.db,permit,control,f.adapters)).settled,true);
  assert.equal(f.calls(),0);
});
test('publication-only revision cannot authorize new native promotions',async t=>{
  const f=await setup(t);await f.upsert(product(1,{sourceFacts:{fresh:true}}));await f.drain();
  const claim=await f.freeze([uuid(1)],'publication-recovery');
  const calls=f.calls();
  await assert.rejects(prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters}),/vector_plan_invalid/);
  assert.equal(f.calls(),calls);
});
test('daily+Monday approval bound admits30 exact identities but never31, duplicates or rewritten envelope bytes',async t=>{
  const f=await setup(t),claim=await f.freeze();
  const request=structuredClone(claim.request);request.approval.changes=Array.from({length:30},(_,i)=>({publicId:uuid(i+1),
    operationId:'a'.repeat(64),inputSha256:'b'.repeat(64),productSha256:'c'.repeat(64),displaySha256:'d'.repeat(64)}));
  request.approvalSha256=sha256(canonicalJson(request.approval));assert.match(approvedCohortOperationKey(request),/^[a-f0-9]{64}$/);
  request.approval.changes.push({...request.approval.changes[0],publicId:uuid(31)});request.approvalSha256=sha256(canonicalJson(request.approval));
  assert.throws(()=>approvedCohortOperationKey(request),/approval_invalid/);
  request.approval.changes.pop();request.approval.changes[1]=request.approval.changes[0];request.approvalSha256=sha256(canonicalJson(request.approval));
  assert.throws(()=>approvedCohortOperationKey(request),/approval_invalid/);
});
test('Monday admission preserves all identities and order while confirmed unavailable bases become held',async t=>{
  const f=await setup(t,{initial:0,permanent:2359,extraHeld:1023,preservePermanentListings:true});
  f.advance(36*3600000);f.context.cutoff=new Date(f.now().getTime()+3600000).toISOString();
  f.setIntent((p,hash)=>{
    const permission={title:p.title,description:p.title,
      imageUrl:'/images/gift-placeholder.svg',affiliateUrl:p.affiliateUrl};
    const existing=f.sql.prepare('SELECT rights_json FROM products WHERE id=?').get(p.id);
    return{rightsById:{[p.id]:existing?JSON.parse(existing.rights_json):{...rights(p),persistent:Object.fromEntries(Object.entries(permission)
      .map(([key,value])=>[key,{basis:'owned',reference:`test-only/actual-clearance/${p.id}/${key}`,value}]))}},
      verificationById:{[p.id]:{reference:'test-only/fresh-Monday-response',observedAt:f.now().toISOString(),sourceFactsHash:hash}},
      reviewedDeleteReference:'test-only/delete'};
  });
  const ids=[];
  for(let n=100;n<110;n++){await f.upsert(product(n,{title:'merchant duplicated title',embedding:null,isActive:false,
    availabilityStatus:n%2?'UNAVAILABLE':'UNKNOWN',sourceFacts:{fixture:n,fresh:true}}));ids.push(uuid(n));}
  const titles=['Telescope walnut tripod','Copper octopus bookmark','Ceramic meteor lamp','Linen fox cushion','Rubber cactus trivet',
    'Velvet cosmic umbrella','Brass lobster bell','Glass dragon goblet','Canvas moon hammock','Marble jellyfish clock',
    'Bamboo raven flute','Steel unicorn wrench','Clay dinosaur planter','Leather orbit pouch','Wool kiwi scarf',
    'Porcelain shark teapot','Wood robot puzzle','Cotton planet apron','Crystal beetle brooch','Felt wizard slippers'];
  for(let n=0;n<20;n++){await f.upsert(product(5000+n,{title:titles[n],embedding:null}));ids.push(uuid(10000+n));}
  await f.drain();const claim=await f.freeze(ids);
  const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters});
  assert.equal(prepared.revision.request.approval.changes.length,30);
  const unavailable=new Set([101,103,105,107,109].map(uuid));
  assert.equal(prepared.revision.snapshot.products.length,2374);
  assert.deepEqual(prepared.revision.snapshot.products.slice(0,2354).map(p=>p.publicId),f.previous.products.filter(p=>!unavailable.has(p.publicId)).map(p=>p.publicId));
  assert.deepEqual(prepared.revision.snapshot.products.slice(2354).map(p=>p.publicId),ids.slice(10));
  assert.equal(prepared.revision.snapshot.heldProducts.filter(p=>p.reason==='unavailable').length,5);
  assert.ok(prepared.revision.snapshot.products.every(p=>p.eligibleUntil===null));
  assert.deepEqual(prepared.reusedIds,[]);assert.deepEqual(prepared.remainingIds,[]);
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,...prepared,adapters:f.adapters});
  assert.equal(queued.state,'build_queued');assert.equal(f.sql.prepare('SELECT count(*) n FROM products').get().n,3403);
  const revision=prepared.revision,control=approvedRevisionControl(revision);
  assert.equal(JSON.stringify(control).includes('source_record_json'),false);assert.equal(JSON.stringify(control).includes('rights_json'),false);
  assert.deepEqual(await hydrateApprovedRevision(f.db,queued.owner,control),revision);
  const build=await claimBuildRequest(f.db,queued.requestId,'test-only/full-permanent-daily',f.now());
  const intent={releaseId:'full-permanent-daily',catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
    catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
    priorReleaseId:'prior-release',nextExpiry:null};
  await enqueuePublication(f.db,revision.snapshot,intent,f.now());const publication=await claimPublication(f.db,revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,revision.snapshot,publication,'version:test-only/actual-version',f.now());
  const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,'test-only/actual-version',
    async()=>({environment:scope.environment,settled:true,active:{...f.priorIntent,versionReference:'prior-version'}}),f.now(),queued.owner);
  const plan=approvedCohortVectorPlan(revision),vectorPlan={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),
    ids:[...plan.products.map(p=>p.publicId),...plan.absentIds]};
  f.advance(16*60000);const sent=f.calls();
  const old=f.sql.prepare('SELECT rights_json FROM products WHERE public_id=?').get(uuid(1)).rights_json;
  f.sql.prepare("UPDATE products SET rights_json=? WHERE public_id=?").run('{"foreign-held-grant":true}',uuid(1));
  await assert.rejects(completeActivatedApprovedCatalogPublication(f.db,revision,publication,permit,async()=>intent,f.now));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1);
  f.sql.prepare('UPDATE products SET rights_json=? WHERE public_id=?').run(old,uuid(1));
  const observed=async()=>{await readActivatedCatalogVectors(f.db,permit,vectorPlan,f.adapters);return intent;};
  await completeActivatedApprovedCatalogPublication(f.db,revision,publication,permit,observed,f.now);
  const actual=f.sql.prepare('SELECT * FROM publication_receipts WHERE release_id=?').get(intent.releaseId);
  const seal=createApprovedCatalogSeal(revision,{releaseId:intent.releaseId,receiptSha256:sha256(canonicalJson(actual))});
  assert.equal(JSON.stringify(seal).includes('imageUrl'),false);assert.equal(JSON.stringify(seal).includes('rights_json'),false);
  assert.equal(await resolveBuildActivation(f.db,permit,async signal=>{await readActivatedCatalogVectors(f.db,permit,vectorPlan,f.adapters,{signal});
    return{environment:scope.environment,settled:true,active:{...intent,versionReference:permit.versionReference}};}),'resolved');
  assert.equal(f.calls(),sent);
  f.advance(36*3600000);
  const nextContext={envelopeSha256:sha256(seal.envelopeJson+'\n'),snapshotSha256:seal.snapshotSha256,
    projectionSha256:seal.projectionReceipt.projection_sha256,sourceExportSha256:seal.projectionReceipt.source_export_sha256,
    vectorSyncWatermark:revision.vectorSyncWatermark,publicationReceiptWatermark:2,cutoff:new Date(f.now().getTime()+3600000).toISOString(),
    priorPublication:seal.publication};
  const nextWriting=await claimMutationOwnership(f.db,scope,{phase:'writing',ownerReference:'next-day',operationKey:'f'.repeat(64)});
  const previous=await readApprovedPrior(f.db,nextWriting,seal,nextContext);assert.deepEqual(previous,revision.snapshot);
  await releaseMutationOwnership(f.db,nextWriting);
  const nextApproval={schemaVersion:1,runId:'next-day',catalogRevision:'next-day-revision',changes:[]};
  const request={previous,context:nextContext,scope,codeSha:revision.request.codeSha,approval:nextApproval,approvalSha256:sha256(canonicalJson(nextApproval))};
  const nextOwner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'next-day',operationKey:approvedCohortOperationKey(request)});
  const next=await prepareOwnedApprovedCohortPlan({db:f.db,owner:nextOwner,request,adapters:f.adapters});
  assert.deepEqual(next.revision.snapshot.products.map(p=>p.publicId),revision.snapshot.products.map(p=>p.publicId));
  assert.deepEqual(next.remainingIds,[]);assert.equal(f.calls(),sent);
});
test('body-free full revision hydrates exact pending vector journal only; wrong owner/hash/current drift cannot rewrite or resend',async t=>{
  const f=await setup(t,{initial:3});await f.upsert(product(1,{sourceFacts:{fixture:1,fresh:true}}));await f.drain();
  const claim=await f.freeze([uuid(1)]),prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters});
  const control=approvedRevisionControl(prepared.revision);f.uncertain(true);
  const first=await deliverOwnedApprovedCohortVector({db:f.db,owner:prepared.owner,revision:prepared.revision,
    publicId:uuid(2),original:f.originals.get(uuid(2)),adapters:f.adapters});
  assert.equal(first.state,'pending');const sent=f.calls();
  assert.deepEqual(await hydrateApprovedRevision(f.db,first.owner,JSON.parse(JSON.stringify(control))),prepared.revision);
  const rows=Object.fromEntries(['products','catalog_maintenance_products','catalog_maintenance_operations'].map(table=>[table,
    f.sql.prepare(`SELECT * FROM ${table}`).all().map(r=>({...r}))]));
  const persistent={...prepared.revision,nativeHistory:[],persistent:{generation:first.owner.generation,
    inventory:permanentSourceInventory(permanentSourceRows(rows)),nativeHistory:[]}};
  const persistentControl=approvedRevisionControl(persistent);
  assert.deepEqual(await hydrateApprovedRevision(f.db,first.owner,persistentControl),persistent);
  // Only readback gains the existing pending-journal fence, never writes.
  await assert.rejects(mutationAssertion(f.db,first.owner,['freezing']).all());
  const privateState=f.sql.prepare('SELECT semantic_json FROM catalog_maintenance_products WHERE product_id=?').get(id(3));
  f.sql.prepare("UPDATE catalog_maintenance_products SET semantic_json='{}' WHERE product_id=?").run(id(3));
  await assert.rejects(hydrateApprovedRevision(f.db,first.owner,persistentControl));
  f.sql.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?').run(privateState.semantic_json,id(3));
  const journal=f.sql.prepare("SELECT delivery_id,dispatch_token FROM catalog_vector_deliveries WHERE status='pending' AND dispatch_token IS NOT NULL").get();
  f.sql.prepare('UPDATE catalog_vector_deliveries SET dispatch_token=NULL WHERE delivery_id=?').run(journal.delivery_id);
  await assert.rejects(hydrateApprovedRevision(f.db,first.owner,persistentControl));
  f.sql.prepare('UPDATE catalog_vector_deliveries SET dispatch_token=? WHERE delivery_id=?').run(journal.dispatch_token,journal.delivery_id);
  await assert.rejects(hydrateApprovedRevision(f.db,{...first.owner,token:'foreign-token'},control));
  await assert.rejects(hydrateApprovedRevision(f.db,first.owner,{...control,sourceRowsSha256:'0'.repeat(64)}));
  f.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(3));
  await assert.rejects(hydrateApprovedRevision(f.db,first.owner,control));
  assert.equal(f.calls(),sent);assert.equal(f.sql.prepare('SELECT external_pending FROM catalog_mutation_scopes').get().external_pending,1);
});
test('only explicit nonmerchant exact persistent grants admit new D1 bases; supplier and malformed grants stay held',async t=>{
  for(const fault of ['merchant','missing','unsafe-image','expires','weak']){
    const f=await setup(t,{initial:0,permanent:1,preservePermanentListings:true});
    const p=product(5000,{embedding:null,...(fault==='weak'?{qualityScore:.3,isActive:false}:{})});
    f.setIntent(p=>{
      const fields={title:p.title,description:p.title,imageUrl:'/images/gift-placeholder.svg',affiliateUrl:p.affiliateUrl};
      const persistent=Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,{basis:'owned',reference:'explicit exact grant',value}]));
      if(fault==='merchant')persistent.title.basis='merchant';
      if(fault==='missing')delete persistent.description;
      if(fault==='unsafe-image')persistent.imageUrl.value='http://supplier.invalid/unsafe-photo.jpg';
      if(fault==='expires')persistent.title.expiresAt=at(24*3600000);
      return{rightsById:{[p.id]:{...rights(p),persistent}},reviewedDeleteReference:'test-only/delete'};
    });
    await f.upsert(p);await f.drain();const claim=await f.freeze([uuid(10000)]);
    const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters});
    assert.deepEqual(prepared.revision.snapshot.products.map(p=>p.publicId),f.previous.products.map(p=>p.publicId),fault);
    assert.ok(prepared.revision.snapshot.heldProducts.some(p=>p.publicId===uuid(10000)),fault);
  }
});
async function deliverRemaining(f,prepared){
  let owner=prepared.owner;
  for(const publicId of prepared.remainingIds){
    const plan=approvedCohortVectorPlan(prepared.revision),changed=prepared.revision.request.approval.changes.some(c=>c.publicId===publicId);
    const options={db:f.db,owner,revision:prepared.revision,publicId,adapters:f.adapters,
      ...(!changed&&plan.products.some(p=>p.publicId===publicId)?{original:f.originals.get(publicId)}:{})};
    for(let pass=0;pass<4;pass++){const result=await deliverOwnedApprovedCohortVector({...options,owner});owner=result.owner;
      if(result.state==='complete')break;assert.equal(result.state,'pending');assert.ok(pass<3);}
  }
  return owner;
}
test('full-plan policy receipt covers genuine source reuse plus prior promotion/delete without another policy rebuild',async t=>{
  const f=await setup(t,{initial:4,earlyExpiry:[id(4)]});f.advance(2*3600000);
  for(const n of [1,2,6])await f.upsert(product(n,{sourceFacts:{fixture:n,fresh:true}}));await f.drain();
  const claim=await f.freeze([uuid(1),uuid(2),uuid(6)]);let rebuilds=0;const prepare=f.local.prepare.bind(f.local);
  f.useDb({...f.local,prepare(query){if(query.includes('SELECT * FROM catalog_maintenance_operations'))rebuilds++;return prepare(query);}});
  f.lose(statements=>statements.some(s=>s.query.startsWith('INSERT INTO catalog_vector_deliveries')));
  const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,owner:claim.owner,request:claim.request,adapters:f.adapters});
  assert.deepEqual(prepared.reusedIds,[uuid(1),uuid(2),uuid(6)]);assert.deepEqual(prepared.remainingIds,[uuid(3),uuid(4)]);
  assert.equal(rebuilds,1);const owner=await deliverRemaining(f,prepared);assert.equal(rebuilds,1);
  assert.equal(f.index.has(uuid(4)),false);assert.equal(f.index.get(uuid(3)).metadata.catalogRevision,'approved-revision');
  f.lose(statements=>statements.some(s=>s.query.startsWith('INSERT INTO catalog_build_requests')));
  await assert.rejects(settleOwnedApprovedCohortVectorProof({db:f.db,owner,revision:prepared.revision,adapters:f.adapters}));
  const current=await readMutationOwner(f.db,scope);
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner:current,revision:prepared.revision,adapters:f.adapters});
  assert.equal(queued.state,'existing');assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,1);
  assert.equal(rebuilds,1);assert.ok(Object.is(f.index.get(uuid(3)).values[0],-0));
  const calls=f.calls();assert.equal((await settleOwnedApprovedCohortVectorProof({db:f.db,owner:queued.owner,revision:prepared.revision,adapters:f.adapters})).state,'existing');
  assert.equal(f.calls(),calls);
  const row=f.sql.prepare("SELECT * FROM catalog_vector_deliveries WHERE json_extract(request_json,'$.kind')='approved-cohort-plan'").get();
  assert.equal(row.attempts,0);assert.equal(row.dispatch_token,null);assert.equal(row.mutation_reference,null);
  assert.equal(JSON.parse(row.request_json).approval.runId,'weekly-run');
  const revision=prepared.revision,build=await claimBuildRequest(f.db,queued.requestId,'test-only/full-plan',f.now());
  const intent={releaseId:'full-plan-release',catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
    catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
    priorReleaseId:'prior-release',nextExpiry:revision.snapshot.products[0].eligibleUntil};
  await enqueuePublication(f.db,revision.snapshot,intent,f.now());const publication=await claimPublication(f.db,revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,revision.snapshot,publication,'test-only/full-plan-dispatch',f.now());
  const prior={environment:'staging',settled:true,active:{...f.priorIntent,versionReference:'old-version'}};
  const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,'test-only/full-plan-upload',async()=>prior,f.now(),queued.owner);
  const plan=approvedCohortVectorPlan(revision),control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),
    ids:[...plan.products.map(p=>p.publicId),...plan.absentIds]};
  assert.equal((await readActivatedCatalogVectors(f.db,permit,control,f.adapters)).settled,true);
  for(const ids of [control.ids.slice(1),[...control.ids,control.ids[0]],[...control.ids,uuid(99)]])
    await assert.rejects(readActivatedCatalogVectors(f.db,permit,{...control,ids},f.adapters));
  f.index.set(uuid(4),f.index.get(uuid(1)));await assert.rejects(readActivatedCatalogVectors(f.db,permit,control,f.adapters),/vector_not_visible/);
  assert.equal(f.calls(),calls);
});
test('full-plan source/native/metadata/ABA/expiry drift and incomplete remaining coverage fail closed without another native mutation',async t=>{
  for(const fault of ['native','metadata','source','reference','aba','expiry','partial','extra','revision','unknown']){
    const f=await setup(t,{initial:3});await f.upsert(product(1,{sourceFacts:{fixture:1,fresh:true}}));await f.drain();
    const claim=await f.freeze([uuid(1)]),prepared=await prepareOwnedApprovedCohortPlan({db:f.db,owner:claim.owner,request:claim.request,adapters:f.adapters});
    if(fault==='unknown'){
      f.uncertain(true);const options={db:f.db,owner:prepared.owner,revision:prepared.revision,publicId:uuid(2),original:f.originals.get(uuid(2)),adapters:f.adapters};
      const first=await deliverOwnedApprovedCohortVector(options),sent=f.calls();assert.equal(first.state,'pending');
      const next=await deliverOwnedApprovedCohortVector({...options,owner:first.owner});assert.equal(next.state,'pending');assert.equal(f.calls(),sent);
      assert.equal(f.sql.prepare('SELECT external_pending FROM catalog_mutation_scopes').get().external_pending,1);continue;
    }
    const owner=fault==='partial'?prepared.owner:await deliverRemaining(f,prepared),sent=f.calls();
    if(fault==='native')f.index.get(uuid(1)).values[2]=.75;
    if(fault==='metadata')f.index.get(uuid(1)).metadata.embeddingModel='wrong';
    if(fault==='source')f.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(3));
    if(fault==='reference')f.sql.prepare("UPDATE vector_sync_outbox SET mutation_reference='wrong-ref' WHERE source_revision='approved-revision'").run();
    if(fault==='aba')f.sql.prepare('UPDATE catalog_mutation_scopes SET generation=generation+1').run();
    if(fault==='expiry')f.advance(7*3600000);
    const revision=structuredClone(prepared.revision);if(fault==='revision')revision.request.codeSha='0'.repeat(40);
    let db=f.db;
    if(fault==='extra')db={...f.db,prepare(query){const statement=f.db.prepare(query);if(!query.includes('WITH encoded AS(SELECT delivery_id'))return statement;
      return{bind(...args){statement.bind(...args);return this;},async all(...args){const result=await statement.all(...args);
        if(result.results.length)result.results.push(result.results[0]);return result;}};}};
    await assert.rejects(settleOwnedApprovedCohortVectorProof({db,owner,revision,adapters:f.adapters}),undefined,fault);
    assert.equal(f.calls(),sent);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
  }
});
test('only an exact current full-plan journal grants30s; generic observation remains3s',async t=>{
  const f=await setup(t);for(const n of [1,2])await f.upsert(product(n,{sourceFacts:{fixture:n,fresh:true}}));await f.drain();
  const claim=await f.freeze([uuid(1),uuid(2)]),prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters});
  const {owner,revision}=prepared,sent=f.calls(),realTimer=globalThis.setTimeout,windows=[];
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
    windows.push(ms);return realTimer(callback,ms===3000?5:ms===30000?120:ms,...args);});
  let aborted=false;
  await assert.rejects(settleCapturedRevision(f.db,owner,revision,(_plan,signal)=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(new Error('test abort'));},{once:true});})),/prune_vectors_unconfirmed/);
  assert.equal(aborted,true);assert.deepEqual(windows,[3000]);windows.length=0;
  const policy=f.sql.prepare("SELECT * FROM catalog_vector_deliveries WHERE json_extract(request_json,'$.kind')='approved-cohort-plan'").get();
  const proof={deliveryId:policy.delivery_id,requestSha256:sha256(policy.request_json)};
  const sourceRow=f.sql.prepare("SELECT * FROM catalog_vector_deliveries WHERE json_extract(request_json,'$.kind')='outbox' LIMIT 1").get();
  let invoked=0;
  for(const [db,current,value,ref] of [[f.db,owner,revision,{...proof,requestSha256:'0'.repeat(64)}],
    [f.db,owner,revision,{...proof,deliveryId:'0'.repeat(64)}],
    [f.db,owner,revision,{deliveryId:sourceRow.delivery_id,requestSha256:sha256(sourceRow.request_json)}],
    [f.db,{...owner,epoch:owner.epoch+1},revision,proof],
    [f.db,owner,{...revision,sourceDigest:'0'.repeat(64)},proof]]){
    await assert.rejects(settleCapturedRevision(db,current,value,async()=>{invoked++;throw new Error('unexpected');},ref),/prune_owned_observation_invalid/);
  }
  assert.equal(invoked,0);assert.deepEqual(windows,[]);
  // Timers are scaled only in this test:30ms native latency outlives the generic
  // 5ms deadline, but fits the authenticated120ms deadline. Production is3s/30s.
  const adapters={...f.adapters,async readback(id,signal){await new Promise(resolve=>realTimer(resolve,30));signal.throwIfAborted();return f.adapters.readback(id,signal);}};
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner,revision,adapters});
  assert.equal(queued.state,'build_queued');assert.equal(windows.filter(ms=>ms===30000).length,2);assert.equal(windows.includes(3000),false);
  assert.equal(f.calls(),sent);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,1);
});
test('full-plan30s timeout drains same-ledger native accounting exactly once before return and preserves exact retry',async t=>{
  const f=await setup(t);for(const n of [1,2])await f.upsert(product(n,{sourceFacts:{fixture:n,fresh:true}}));await f.drain();
  const rest=await boundedRest(t,f),claim=await f.freeze([uuid(1),uuid(2)]);
  const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters}),sent=f.calls();
  const realTimer=globalThis.setTimeout,windows=[];let reads=0,reserved=0,settled=0,cleanupTimers=0;const statuses=[];
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
    if(ms===30000)windows.push(()=>callback(...args));
    // Once both native requests exist, scale cleanup10s to5ms. Durable25ms
    // settlement must still finish BEFORE return, not leak past this horizon.
    if(ms===10000&&reads===2){cleanupTimers++;return realTimer(callback,5,...args);}return realTimer(callback,ms,...args);});
  const send=accountedPublicationReadFetch({async reserveBudget(value){reserved++;await rest.workspace().reserveBudget(value);},
    async settleBudget(id,value){await new Promise(resolve=>realTimer(resolve,25));await rest.workspace().settleBudget(id,value);settled++;statuses.push(value.status);}},async(_url,init)=>{
    reads++;if(reads===2)realTimer(()=>windows[0](),5);
    return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('raw abort')),{once:true}));
  },{accountId:rest.options.scope.accountId,workerName:rest.options.scope.workerName,databaseId:rest.options.scope.databaseId,
    indexName:scope.indexName,identityOrigin:'https://fixture.example.invalid'});
  const native=createVectorizeRestAdapters({...scope,accountId:rest.options.scope.accountId,token:'TEST_ONLY',fetch:send});
  await assert.rejects(settleOwnedApprovedCohortVectorProof({db:f.db,...prepared,adapters:{...f.adapters,readback:native.readback}}));
  t.mock.restoreAll();assert.equal(windows.length,2);assert.ok(cleanupTimers>0);assert.equal(reads,2);assert.equal(reserved,2);assert.equal(settled,2);
  assert.deepEqual(statuses,['unknown','unknown']);assert.equal((await rest.workspace().budget()).unconfirmedRequests,2);
  const usage=await rest.workspace().budget();await new Promise(resolve=>realTimer(resolve,40));assert.deepEqual(await rest.workspace().budget(),usage);
  assert.equal(reads,2);assert.equal(settled,2);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
  assert.deepEqual(await readMutationOwner(f.db,scope),prepared.owner);await rest.reopen();
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,...prepared,adapters:f.adapters});assert.equal(queued.state,'build_queued');
  const replay=await settleOwnedApprovedCohortVectorProof({db:f.db,...prepared,owner:queued.owner,adapters:f.adapters});
  assert.equal(replay.state,'existing');assert.equal(f.calls(),sent);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,1);
});
test('full-plan30s timeout joins cancelled source-read accounting before return with no late native reads',async t=>{
  const f=await setup(t);await f.upsert(product(1,{sourceFacts:{fixture:1,fresh:true}}));await f.drain();
  const rest=await boundedRest(t,f),claim=await f.freeze([uuid(1)]),prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters});
  const owner=await deliverRemaining(f,prepared),realTimer=globalThis.setTimeout,windows=[];let interrupted=false,reads=0;
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{if(ms===30000)windows.push(()=>callback(...args));return realTimer(callback,ms,...args);});
  rest.before(async batch=>{if(!interrupted&&batch.some(q=>q.sql.includes('d.completed_at delivery_completed_at'))){
    interrupted=true;windows[0]();await new Promise(resolve=>realTimer(resolve,25));}});
  await assert.rejects(settleOwnedApprovedCohortVectorProof({db:f.db,owner,revision:prepared.revision,
    adapters:{...f.adapters,async readback(...args){reads++;return f.adapters.readback(...args);}}}));
  t.mock.restoreAll();assert.equal(interrupted,true);assert.equal(reads,0);assert.equal((await rest.workspace().budget()).unconfirmedRequests,1);
  const usage=await rest.workspace().budget(),requests=rest.wire.requests;await new Promise(resolve=>realTimer(resolve,40));
  assert.deepEqual(await rest.workspace().budget(),usage);assert.equal(rest.wire.requests,requests);assert.equal(reads,0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);assert.deepEqual(await readMutationOwner(f.db,scope),owner);
});
test('authenticated30s observation still refuses late full-source/projection/prior/watermark/ABA/cutoff/rights drift',async t=>{
  for(const fault of ['held-source','projection','prior','watermark','aba','cutoff','rights']){
    const f=await setup(t);f.context.cutoff=at(25*3600000);
    await f.upsert(product(1,{sourceFacts:{fixture:1,fresh:true}}));await f.drain();const claim=await f.freeze([uuid(1)]);
    const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,...claim,adapters:f.adapters}),owner=await deliverRemaining(f,prepared),sent=f.calls();let once=false;
    const adapters={...f.adapters,async readback(...args){const result=await f.adapters.readback(...args);if(!once){once=true;
      if(fault==='held-source')f.sql.prepare("UPDATE products SET source_record_json='{}' WHERE public_id=?").run(uuid(3));
      if(fault==='projection')f.sql.prepare("UPDATE catalog_public_products SET title='wrong' WHERE catalog_revision='approved-revision'").run();
      if(fault==='prior')f.sql.prepare("UPDATE publication_receipts SET completed_at=? WHERE release_id='prior-release'").run(at(10));
      if(fault==='watermark')f.sql.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,status,created_at,completed_at)
        VALUES(?,'foreign-revision',?,'upsert','complete',?,?)`).run(uuid(99),'a'.repeat(64),at(10),at(10));
      if(fault==='aba')f.sql.prepare('UPDATE catalog_mutation_scopes SET generation=generation+1').run();
      if(fault==='cutoff')f.advance(26*3600000);
      if(fault==='rights')f.advance(Date.parse(prepared.revision.snapshot.products[0].eligibleUntil)-f.now().getTime());
    }return result;}};
    await assert.rejects(settleOwnedApprovedCohortVectorProof({db:f.db,owner,revision:prepared.revision,adapters}),undefined,fault);
    assert.equal(f.calls(),sent);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
  }
});
test('full-plan accepted DELETE above legacy20 resumes after expiry with exact control and no redispatch',async t=>{
  const f=await setup(t,{initial:21}),claim=await f.freeze();
  const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,owner:claim.owner,request:claim.request,adapters:f.adapters});
  const plan=approvedCohortVectorPlan(prepared.revision);assert.equal(plan.products.length+plan.absentIds.length,21);
  const publicId=plan.absentIds[0];assert.ok(publicId);
  const first=await deliverOwnedApprovedCohortVector({db:f.db,owner:prepared.owner,revision:prepared.revision,publicId,adapters:f.adapters});
  assert.equal(first.state,'pending');const sent=f.calls();f.advance(40*86400000);
  const result=await resumeOwnedPrunedDelete({db:f.db,owner:first.owner,deliveryId:first.deliveryId,plan,adapters:f.adapters});
  assert.equal(result.state,'complete');assert.equal(f.calls(),sent);assert.equal(f.index.has(publicId),false);
  await assert.rejects(resumeOwnedPrunedDelete({db:f.db,owner:result.owner,deliveryId:first.deliveryId,plan:{...plan,absentIds:plan.absentIds.slice(1)},adapters:f.adapters}));
});
async function reusable(t,{removed=false,initial=2}={}){
  const f=await setup(t,{initial});
  for(let n=1;n<=initial;n++)await f.upsert(product(n,{sourceFacts:{fixture:n,fresh:true},...(removed&&n===1?{isActive:false}:{} )}));
  await f.drain();const claim=await f.freeze(Array.from({length:initial},(_,n)=>uuid(n+1)));
  const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  return{f,...prepared,options:{db:f.db,owner:prepared.owner,revision:prepared.revision,adapters:f.adapters}};
}
test('2361 listed products with no changes keep stable permanent membership and prove only two finite native members',async t=>{
  const f=await setup(t,{permanent:2359}),original=f.previous.products;
  const claim=await f.freeze(),prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request),revision=prepared.revision;
  assert.equal(revision.snapshot.products.length,2361);assert.equal(revision.snapshot.heldProducts.length,1);
  assert.equal(sha256(canonicalJson(revision.snapshot.products)),sha256(canonicalJson(original)));
  const plan=approvedCohortVectorPlan(revision);assert.equal(plan.products.length,2);assert.deepEqual(plan.absentIds,[]);
  const current=await f.promote(prepared);
  const queued=await settleApprovedCohort(f.db,current,revision,()=>readOwnedApprovedCohortVectors(f.db,current,revision,f.adapters));
  const build=await claimBuildRequest(f.db,queued.requestId,'test-only/wide-build',f.now());
  const intent={releaseId:'wide-release',catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
    catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
    priorReleaseId:'prior-release',nextExpiry:revision.snapshot.products[0].eligibleUntil};
  await enqueuePublication(f.db,revision.snapshot,intent,f.now());
  const publication=await claimPublication(f.db,revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,revision.snapshot,publication,'test-only/wide-dispatch',f.now());
  const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,'test-only/wide-upload',async()=>({environment:'staging',settled:true,
    active:{...f.priorIntent,versionReference:'old-version'}}),f.now(),queued.owner);
  const control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),ids:plan.products.map(p=>p.publicId)};
  const dispatches=f.calls();assert.equal((await readActivatedCatalogVectors(f.db,permit,control,f.adapters)).settled,true);
  assert.equal(f.calls(),dispatches);assert.equal(f.index.size,2);
});
test('stockout hides confirmed unavailable bases, while unknown stock and photo expiry preserve remaining cleared listings',async t=>{
  const f=await setup(t,{initial:0,permanent:2359,extraHeld:1023,preservePermanentListings:true}),before=f.previous.products;
  assert.equal(before.length,2359);assert.equal(f.previous.heldProducts.length,1024);
  f.advance(36*3600000);f.context.cutoff=new Date(f.now().getTime()+3600000).toISOString();
  for(let n=100;n<110;n++)await f.upsert(product(n,{title:'Independent object 102',sourceFacts:{fresh:n},isActive:false,
    availabilityStatus:n%2?'UNAVAILABLE':'UNKNOWN',price:n%2?999999:19.99,embedding:null,editorialStatus:'pending'}));
  await f.upsert(product(9999,{title:'Uncleared weak discovery',qualityScore:.3,isActive:false,embedding:null}));await f.drain();
  const changed=Array.from({length:10},(_,n)=>uuid(n+100)),claim=await f.freeze([...changed,uuid(10000)]),prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  const unavailable=new Set([101,103,105,107,109].map(uuid)),remaining=before.filter(p=>!unavailable.has(p.publicId));
  assert.deepEqual(prepared.revision.snapshot.products.map(p=>p.publicId),remaining.map(p=>p.publicId));
  assert.deepEqual(prepared.revision.snapshot.products.map(p=>p.title),remaining.map(p=>p.title));
  assert.equal(prepared.revision.snapshot.heldProducts.filter(p=>p.reason==='unavailable').length,5);
  assert.ok(prepared.revision.snapshot.products.every(p=>p.eligibleUntil===null));
  assert.ok(prepared.revision.snapshot.heldProducts.some(p=>p.publicId===uuid(10000)));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM products').get().n,3384);
  assert.equal(approvedCohortVectorPlan(prepared.revision).products.length,0);
});
test('one approved change cannot make unrelated permanent identities disappear or raise the30-change contract',async t=>{
  const f=await setup(t,{permanent:2359}),unchanged=f.previous.products.filter(p=>p.eligibleUntil===null);
  await f.upsert(product(1,{sourceFacts:{fixture:1,new:true}}));await f.drain();
  const claim=await f.freeze([uuid(1)]),prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  assert.equal(prepared.revision.snapshot.products.length,2361);
  assert.equal(sha256(canonicalJson(prepared.revision.snapshot.products.filter(p=>p.eligibleUntil===null))),sha256(canonicalJson(unchanged)));
  assert.equal(approvedCohortVectorPlan(prepared.revision).products.length,2);
  const excessive=structuredClone(claim.request);excessive.approval.changes=Array.from({length:31},(_,n)=>({...claim.request.approval.changes[0],publicId:uuid(n+1)}));
  excessive.approvalSha256=sha256(canonicalJson(excessive.approval));assert.throws(()=>approvedCohortOperationKey(excessive),/approval_invalid/);
});
test('changed candidates still face family rejection against every preserved permanent member',async t=>{
  const f=await setup(t,{permanent:2});await f.upsert(product(1,{title:'Independent object 101'}));await f.drain();
  const claim=await f.freeze([uuid(1)]),prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  assert.deepEqual(prepared.revision.snapshot.products.filter(p=>p.eligibleUntil===null),f.previous.products.filter(p=>p.eligibleUntil===null));
  assert.ok(prepared.revision.snapshot.heldProducts.some(p=>p.publicId===uuid(1)&&p.reason==='duplicate'));
});
test('settled proof reuse verifies whole approved cohort without provider mutations and survives lost commit/replay/activation',async t=>{
  const {f,options,revision}=await reusable(t,{initial:3});const sent=f.calls(),epoch=options.owner.epoch;
  let rebuilds=0;const prepare=f.local.prepare.bind(f.local);
  options.db={...f.local,prepare(query){if(query.includes('SELECT * FROM catalog_maintenance_operations'))rebuilds++;return prepare(query);}};
  f.lose(statements=>statements.some(s=>s.query.includes("'complete','verified'")));
  const result=await reuseOwnedApprovedCohortVectorProof(options);assert.equal(result.state,'complete');assert.equal(result.owner.epoch,epoch+1);
  assert.equal(rebuilds,1);assert.equal(f.calls(),sent);assert.ok(Object.is(f.index.get(uuid(1)).values[0],-0));
  const proof=f.sql.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').get(result.deliveryId);
  assert.equal(proof.attempts,0);assert.equal(proof.dispatch_token,null);assert.equal(proof.mutation_reference,null);
  assert.equal(f.sql.prepare('SELECT external_pending FROM catalog_mutation_scopes').get().external_pending,0);
  assert.equal(JSON.parse(proof.evidence_json)[0].state,'verification_only');
  assert.equal(JSON.parse(proof.request_json).approval.runId,'weekly-run');
  assert.equal(JSON.parse(proof.request_json).sources.length,3);assert.ok(!proof.request_json.includes('Owned synthetic'));
  assert.deepEqual(await reuseOwnedApprovedCohortVectorProof(options),result);assert.equal(rebuilds,1);
  assert.deepEqual(await reuseOwnedApprovedCohortVectorProof({...options,owner:result.owner}),result);assert.equal(f.calls(),sent);
  const observation=await readOwnedApprovedCohortVectors(f.db,result.owner,revision,f.adapters);assert.equal(observation.settled,true);
  f.lose(statements=>statements.some(s=>s.query.includes('INSERT INTO catalog_build_requests')));
  const settlement={db:options.db,owner:result.owner,revision,adapters:f.adapters};
  await assert.rejects(settleOwnedApprovedCohortVectorProof(settlement));
  const current=await readMutationOwner(f.db,scope);
  const queued=await settleOwnedApprovedCohortVectorProof({...settlement,owner:current});
  assert.equal(queued.state,'existing');assert.equal(rebuilds,1); // NO second full policy rebuild.
  const build=await claimBuildRequest(f.db,queued.requestId,'test-only/reused-workflow',f.now());
  const intent={releaseId:'reused-release',catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
    catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
    priorReleaseId:'prior-release',nextExpiry:revision.snapshot.products[0].eligibleUntil};
  await enqueuePublication(f.db,revision.snapshot,intent,f.now());
  const publication=await claimPublication(f.db,revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,revision.snapshot,publication,'test-only/reused-dispatch',f.now());
  const prior={environment:'staging',settled:true,active:{releaseId:f.priorIntent.releaseId,codeSha:f.priorIntent.codeSha,
    catalogRevision:f.priorIntent.catalogRevision,catalogSnapshotSha256:f.priorIntent.catalogSnapshotSha256,
    manifestSha256:f.priorIntent.manifestSha256,versionReference:'old-version'}};
  const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,'test-only/reused-upload',async()=>prior,f.now(),queued.owner);
  const plan=approvedCohortVectorPlan(revision),control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),ids:plan.products.map(p=>p.publicId)};
  assert.equal((await readActivatedCatalogVectors(f.db,permit,control,f.adapters)).settled,true);
  await assert.rejects(readActivatedCatalogVectors(f.db,permit,{...control,ids:control.ids.slice(1)},f.adapters));
  await assert.rejects(readActivatedCatalogVectors(f.db,permit,{...control,planSha256:'0'.repeat(64)},f.adapters));
  const original=f.index.get(uuid(1));f.index.set(uuid(1),{...original,metadata:{...original.metadata,sourceFactsHash:'0'.repeat(64)}});
  await assert.rejects(readActivatedCatalogVectors(f.db,permit,control,f.adapters),/vector_not_visible/);assert.equal(f.calls(),sent);
});
test('settled proof reuse requires actual held delete absence; no fabricated delete from a policy-held upsert',async t=>{
  const {f,options,revision}=await reusable(t,{removed:true});const sent=f.calls();
  assert.deepEqual(approvedCohortVectorPlan(revision).absentIds,[uuid(1)]);
  assert.equal(f.index.has(uuid(1)),false);const result=await reuseOwnedApprovedCohortVectorProof(options);assert.equal(result.state,'complete');
  f.index.set(uuid(1),f.index.get(uuid(2)));
  await assert.rejects(readOwnedApprovedCohortVectors(f.db,result.owner,revision,f.adapters),/vector_not_visible/);assert.equal(f.calls(),sent);
  const g=await setup(t,{initial:1});await g.upsert(product(1,{title:names[0],sourceFacts:{fixture:1,fresh:true}}));
  await g.upsert(product(3,{title:names[0]}));await g.drain();const c=await g.freeze([uuid(1),uuid(3)]);
  const prepared=await prepareApprovedCohort(g.db,c.owner,c.request);assert.ok(approvedCohortVectorPlan(prepared.revision).absentIds.includes(uuid(3)));
  const before=g.calls();assert.equal((await reuseOwnedApprovedCohortVectorProof({db:g.db,owner:prepared.owner,revision:prepared.revision,adapters:g.adapters})).state,'unsupported');
  assert.equal(g.calls(),before);assert.equal(g.sql.prepare("SELECT count(*) n FROM catalog_vector_deliveries WHERE json_extract(request_json,'$.kind')='approved-cohort-reuse'").get().n,0);
});
test('activated whole-cohort read joins failed siblings and inner timeout accounting before rejecting',async t=>{
  for(const fault of ['failure','timeout']){
    const {f,options,revision}=await reusable(t);const proof=await reuseOwnedApprovedCohortVectorProof(options);
    const queued=await settleOwnedApprovedCohortVectorProof({...options,owner:proof.owner});
    const build=await claimBuildRequest(f.db,queued.requestId,'test-only/read-drain',f.now());
    const intent={releaseId:'read-drain-release',catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
      catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
      priorReleaseId:'prior-release',nextExpiry:revision.snapshot.products[0].eligibleUntil};
    await enqueuePublication(f.db,revision.snapshot,intent,f.now());const publication=await claimPublication(f.db,revision.snapshot,intent.releaseId,f.now());
    await recordPublicationDispatch(f.db,revision.snapshot,publication,'test-only/read-drain',f.now());
    const prior={environment:'staging',settled:true,active:{...f.priorIntent,versionReference:'old-version'}};
    const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,'test-only/upload',async()=>prior,f.now(),queued.owner);
    const plan=approvedCohortVectorPlan(revision),control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),ids:plan.products.map(p=>p.publicId)};
    let reads=0,reserved=0,settled=0;const statuses=[];
    const send=accountedPublicationReadFetch({async reserveBudget(){reserved++;},async settleBudget(_id,value){
      await new Promise(resolve=>setTimeout(resolve,25));settled++;statuses.push(value.status);}},async(_url,init)=>{
      reads++;const publicId=JSON.parse(init.body).ids[0];
      if(fault==='failure'&&publicId===uuid(1))return Response.json({success:true,result:[]});
      return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('raw abort')),{once:true}));
    },{accountId:'a'.repeat(32),workerName:'fixture-worker',databaseId:uuid(9),indexName:scope.indexName,identityOrigin:'https://fixture.example.invalid'});
    const native=createVectorizeRestAdapters({...scope,accountId:'a'.repeat(32),token:'TEST_ONLY',fetch:send});
    await assert.rejects(readActivatedCatalogVectors(f.db,permit,control,{...f.adapters,readback:native.readback}),fault==='failure'?/vector_not_visible/:/vector_provider_timeout/);
    assert.equal(reads,2);assert.equal(reserved,2);assert.equal(settled,2);assert.equal(statuses.filter(s=>s==='unknown').length,fault==='failure'?1:2);
    await new Promise(resolve=>setTimeout(resolve,40));assert.equal(reads,2);assert.equal(settled,2);
    assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'activating');
    assert.equal((await readActivatedCatalogVectors(f.db,permit,control,f.adapters)).settled,true);
  }
});
test('settled proof reuse refuses native/metadata errors, unknown/source reference drift, owner ABA, expiry and unapproved coverage',async t=>{
  for(const fault of ['native','metadata','model','eligible','reference','unknown','input','run','payload','source','outbox','prior','projection','aba','expiry']){
    const {f,options}=await reusable(t);const sent=f.calls(),sourcePrepare=f.local.prepare.bind(f.local);
    if(['reference','unknown','input','run','payload'].includes(fault))options.db={...f.local,prepare(query){
      const statement=sourcePrepare(query);if(!query.includes('d.completed_at delivery_completed_at'))return statement;
      return{...statement,bind(...args){statement.bind(...args);return this;},async all(){const value=await statement.all();
        const row=value.results[0];if(fault==='reference')row.delivery_reference='wrong-source-reference';if(fault==='unknown')row.delivery_status='pending';
        if(fault==='input')row.input_sha256='0'.repeat(64);if(fault==='run')row.run_id='publisher-not-maintenance';
        if(fault==='payload')row.payload_json='{}';return value;}};}};
    let once=false;const adapters={...f.adapters,async readback(publicId,signal){const result=await f.adapters.readback(publicId,signal);
      if(fault==='native'&&publicId===uuid(1))result.values[10]=.9;
      if(fault==='metadata'&&publicId===uuid(1))result.metadata.catalogRevision='wrong-revision';
      if(fault==='model'&&publicId===uuid(1))result.metadata.embeddingModel='wrong-model';
      if(fault==='eligible'&&publicId===uuid(1))result.metadata.eligible=false;
      if(!once){once=true;if(fault==='source')f.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(1));
        if(fault==='prior')f.sql.prepare("UPDATE publication_receipts SET completed_at=? WHERE release_id='prior-release'").run(at(10));
        if(fault==='outbox')f.sql.prepare("UPDATE vector_sync_outbox SET created_at=? WHERE source_revision='approved-revision'").run(at(10));
        if(fault==='projection')f.sql.prepare("DELETE FROM catalog_public_products WHERE catalog_revision='approved-revision' AND public_id=?").run(uuid(1));
        if(fault==='aba'){await releaseMutationOwnership(f.local,options.owner);await claimMutationOwnership(f.local,scope,
          {phase:'freezing',ownerReference:options.owner.ownerReference,operationKey:options.owner.operationKey});}
        if(fault==='expiry')f.advance(7*3600000);}
      return result;}};
    await assert.rejects(reuseOwnedApprovedCohortVectorProof({...options,adapters}),undefined,fault);assert.equal(f.calls(),sent,fault);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM catalog_vector_deliveries WHERE json_extract(request_json,'$.kind')='approved-cohort-reuse'").get().n,0,fault);
    assert.equal(f.sql.prepare('SELECT external_pending FROM catalog_mutation_scopes').get().external_pending,0,fault);
  }
  const f=await setup(t);await f.upsert(product(1,{sourceFacts:{fresh:true}}));await f.drain();const c=await f.freeze([uuid(1)]);
  const prepared=await prepareApprovedCohort(f.db,c.owner,c.request),sent=f.calls();
  assert.equal((await reuseOwnedApprovedCohortVectorProof({db:f.db,owner:prepared.owner,revision:prepared.revision,adapters:f.adapters})).state,'unsupported');assert.equal(f.calls(),sent);
});
test('settled proof reuse keeps already-visible/absent completions truthful and malformed partial matches fail closed',async t=>{
  const f=await setup(t,{initial:1});await f.upsert(product(1,{sourceFacts:{fixture:1,fresh:true}}));
  const row=f.sql.prepare("SELECT * FROM vector_sync_outbox WHERE status='pending'").get();
  const event={sequence:row.sequence,publicId:row.public_id,catalogRevision:row.source_revision,embeddingTextHash:row.embedding_text_hash,operation:row.operation};
  const payload=await loadMaintenanceVectorPayload(f.db,event),productRow=f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(1));
  f.index.set(uuid(1),payloadVector(event,payload,productRow,undefined,f.now().getTime()));await f.drain();
  const c=await f.freeze([uuid(1)]),prepared=await prepareApprovedCohort(f.db,c.owner,c.request);
  const options={db:f.db,owner:prepared.owner,revision:prepared.revision,adapters:f.adapters},sent=f.calls();
  assert.equal((await reuseOwnedApprovedCohortVectorProof(options)).state,'unsupported');assert.equal(f.calls(),sent);
  assert.equal(f.sql.prepare("SELECT attempts FROM catalog_vector_deliveries WHERE delivery_id=?").get(row.lease_token??
    f.sql.prepare('SELECT lease_token FROM vector_sync_outbox WHERE sequence=?').get(row.sequence).lease_token).attempts,0);
  const prepare=f.local.prepare.bind(f.local),malformed={...f.local,prepare(query){const statement=prepare(query);
    if(!query.includes('d.completed_at delivery_completed_at'))return statement;
    return{...statement,bind(...args){statement.bind(...args);return this;},async all(){const value=await statement.all();value.results[0].input_sha256='0'.repeat(64);return value;}};}};
  await assert.rejects(reuseOwnedApprovedCohortVectorProof({...options,db:malformed}),/vector_reuse_source_changed/);
  const tooLarge=structuredClone(prepared.revision);tooLarge.additionalAbsentIds=Array.from({length:10},(_,i)=>uuid(i+20));
  assert.equal((await reuseOwnedApprovedCohortVectorProof({...options,revision:tooLarge})).state,'unsupported');
});
test('receipt-only cohort settlement refuses absent/mixed/tampered proofs, full revision drift, native/source/ABA/expiry changes',async t=>{
  for(const fault of ['absent','mixed','proof','revision','native','source','aba','expiry']){
    const {f,options,revision}=await reusable(t);let owner=options.owner;
    if(fault!=='absent')owner=(await reuseOwnedApprovedCohortVectorProof(options)).owner;
    const proposed=structuredClone(revision);let db=f.db;
    if(fault==='revision')proposed.sourceDigest='0'.repeat(64);
    if(fault==='native')f.index.get(uuid(1)).values[3]=.9;
    if(fault==='source')f.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(1));
    if(fault==='expiry')f.advance(7*3600000);
    if(fault==='aba'){await releaseMutationOwnership(f.db,owner);await claimMutationOwnership(f.db,scope,
      {phase:'freezing',ownerReference:owner.ownerReference,operationKey:owner.operationKey});}
    if(['mixed','proof'].includes(fault)){
      const prepare=f.local.prepare.bind(f.local);db={...f.local,prepare(query){const statement=prepare(query);
        if(!query.includes("IN('prune','approved-cohort-reuse')"))return statement;
        return{...statement,bind(...args){statement.bind(...args);return this;},async all(){const value=await statement.all();
          if(fault==='mixed')value.results.push({...value.results[0],delivery_id:'0'.repeat(64)});
          else {const request=JSON.parse(value.results[0].request_json);request.revisionSha256='0'.repeat(64);value.results[0].request_json=canonicalJson(request);}
          return value;}};}};
    }
    const sent=f.calls();await assert.rejects(settleOwnedApprovedCohortVectorProof({db,owner,revision:proposed,adapters:f.adapters}),undefined,fault);
    assert.equal(f.calls(),sent,fault);assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0,fault);
  }
});
test('actual maintenance → drain → approved addition/update → exact originals → proof → build/activation permission',async t=>{
  const f=await setup(t);const old=f.previous.products[1];
  await f.upsert(product(1,{title:'Bronze lobster desktop bell',sourceFacts:{fixture:1,material:'bronze'}}));
  await f.upsert(product(4));await f.drain();
  const {owner,request}=await f.freeze([uuid(1),uuid(4)]);
  const before=f.sql.prepare('SELECT * FROM products').all();const prepared=await prepareApprovedCohort(f.db,owner,request);
  assert.equal(prepared.state,'prepared');assert.equal(prepared.revision.snapshot.catalogRevision,'approved-revision');
  assert.deepEqual(prepared.revision.snapshot.products.map(p=>p.publicId),[uuid(1),uuid(2),uuid(4)]);
  assert.deepEqual(prepared.revision.sourceRows.map(row=>row.public_id),[uuid(1),uuid(2),uuid(3),uuid(4)]);
  assert.deepEqual(prepared.revision.snapshot.products[1],old);assert.deepEqual(prepared.revision.snapshot.slugHistory,f.previous.slugHistory);
  assert.ok(prepared.revision.snapshot.heldProducts.some(p=>p.publicId===uuid(3)));
  assert.deepEqual(f.sql.prepare('SELECT * FROM products').all(),before);
  assert.equal(prepared.revision.vectorSyncWatermark,4);assert.equal(prepared.revision.globalVectorWatermark,4);
  assert.equal(Date.parse(prepared.revision.snapshot.products[0].eligibleUntil),AT-3600000+35*86400000);
  const current=await f.promote(prepared);
  assert.equal(nativeHash(f.index.get(old.publicId).values),nativeHash(values));assert.ok(Object.is(f.index.get(old.publicId).values[0],-0));
  const queued=await settleApprovedCohort(f.db,current,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,current,prepared.revision,f.adapters));
  assert.equal(queued.state,'build_queued');assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1);
  assert.equal((await settleApprovedCohort(f.db,queued.owner,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,queued.owner,prepared.revision,f.adapters))).state,'existing');
  const build=await claimBuildRequest(f.db,queued.requestId,'test-only/workflow',f.now());
  const intent={releaseId:'new-release',catalogRevision:'approved-revision',codeSha:request.codeSha,catalogSnapshotSha256:prepared.revision.packet.receipt.snapshot_sha256,
    manifestSha256:'a'.repeat(64),vectorSyncWatermark:4,priorReleaseId:'prior-release',nextExpiry:prepared.revision.snapshot.products[0].eligibleUntil};
  await enqueuePublication(f.db,prepared.revision.snapshot,intent,f.now());
  const publication=await claimPublication(f.db,prepared.revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,prepared.revision.snapshot,publication,'test-only/dispatch',f.now());
  const prior={environment:'staging',settled:true,active:{releaseId:f.priorIntent.releaseId,codeSha:f.priorIntent.codeSha,
    catalogRevision:f.priorIntent.catalogRevision,catalogSnapshotSha256:f.priorIntent.catalogSnapshotSha256,manifestSha256:f.priorIntent.manifestSha256,versionReference:'old-version'}};
  const permit=await beginBuildActivation(f.db,build,prepared.revision.snapshot,publication,'test-only/upload',async()=>prior,f.now(),queued.owner);
  assert.equal(permit.mutationOwner.phase,'activating'); // Permission only; no fake deployed/publication receipt.
});
test('unapproved factual/copy changes, revoked rights and unavailable products become held, never stale public content',async t=>{
  for(const mutate of [
    (f)=>f.sql.prepare("UPDATE products SET source_facts_hash=? WHERE public_id=?").run('f'.repeat(64),uuid(1)),
    (f)=>f.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(1)),
    (f)=>f.sql.prepare("UPDATE products SET availability_status='UNAVAILABLE' WHERE public_id=?").run(uuid(1)),
    (f)=>{const row=f.sql.prepare('SELECT public_display_json FROM products WHERE public_id=?').get(uuid(1));
      f.sql.prepare('UPDATE products SET public_display_json=? WHERE public_id=?').run(JSON.stringify({...JSON.parse(row.public_display_json),title:'Unapproved current copy'}),uuid(1));},
  ]){const f=await setup(t);mutate(f);const {owner,request}=await f.freeze();const result=await prepareApprovedCohort(f.db,owner,request);
    assert.deepEqual(result.revision.snapshot.products,[f.previous.products[1]]);assert.ok(result.revision.snapshot.heldProducts.some(p=>p.publicId===uuid(1)));
    assert.deepEqual(approvedCohortVectorPlan(result.revision).absentIds,[uuid(1)]);}
});
test('explicit approved former-held product may enter; family duplicate and unknown evidence remain held',async t=>{
  const f=await setup(t);await f.upsert(product(3));await f.upsert(product(4,{title:names[0]}));await f.drain();
  const {owner,request}=await f.freeze([uuid(3),uuid(4)]);const result=await prepareApprovedCohort(f.db,owner,request);
  assert.deepEqual(result.revision.snapshot.products.map(p=>p.publicId),[uuid(1),uuid(2),uuid(3)]);
  assert.equal(result.revision.snapshot.heldProducts.find(p=>p.publicId===uuid(4)).reason,'duplicate');
  // The duplicate already has a settled maintenance upsert. Its exclusion must
  // therefore be an exact-ID deletion, not just omission from the proof plan.
  assert.ok(f.index.has(uuid(4)));assert.deepEqual(approvedCohortVectorPlan(result.revision).absentIds,[uuid(4)]);
  const current=await f.promote(result);assert.equal(f.index.has(uuid(4)),false);
  assert.equal((await settleApprovedCohort(f.db,current,result.revision,()=>readOwnedApprovedCohortVectors(f.db,current,result.revision,f.adapters))).state,'build_queued');
  const unknown=await setup(t);unknown.setIntent(()=>({reviewedDeleteReference:'test-only'}));
  await unknown.upsert(product(4));await unknown.drain();const next=await unknown.freeze([uuid(4)]);
  const held=await prepareApprovedCohort(unknown.db,next.owner,next.request);
  assert.ok(held.revision.snapshot.heldProducts.some(p=>p.publicId===uuid(4)));assert.equal(held.revision.snapshot.products.length,2);
});
test('expired source observations or short current rights never renew; all-held stays explicit',async t=>{
  const f=await setup(t);f.advance(36*86400000);const {owner,request}=await f.freeze();request.context.cutoff=at(36*86400000+3600000);
  await releaseMutationOwnership(f.db,owner);const freshOwner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'later-build',operationKey:approvedCohortOperationKey(request)});
  const result=await prepareApprovedCohort(f.db,freshOwner,request);assert.equal(result.state,'all_held');assert.equal(result.revision.snapshot.products.length,0);
  assert.equal(result.revision.snapshot.heldProducts.length,3);assert.equal(result.revision.snapshot.generatedAt,f.now().toISOString());
  const short=await setup(t);short.setIntent((p,hash)=>({rightsById:{[p.id]:{...rights(p),title:{...rights(p).title,expiresAt:at(3600000)}}},
    verificationById:{[p.id]:{reference:'test-only',observedAt:at(-3600000),sourceFactsHash:hash}},
    embeddingById:{[p.id]:{reference:'test-only',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}}));
  await short.upsert(product(4));await short.drain();const next=await short.freeze([uuid(4)]);
  assert.ok((await prepareApprovedCohort(short.db,next.owner,next.request)).revision.snapshot.heldProducts.some(p=>p.publicId===uuid(4)));
});
test('approval hashes/receipts, global pending work and wrong owner fail closed; whole plans may exceed20 members',async t=>{
  const f=await setup(t);await f.upsert(product(4));
  const unfinished=await f.freeze([uuid(4)]);
  await assert.rejects(prepareApprovedCohort(f.db,unfinished.owner,unfinished.request),/unsettled/);
  const g=await setup(t);await g.upsert(product(4));await g.drain();const {owner,request}=await g.freeze([uuid(4)]);
  await assert.rejects(prepareApprovedCohort(g.db,{...owner,epoch:999},request));
  const bad=structuredClone(request);bad.approval.changes[0].displaySha256='0'.repeat(64);
  assert.throws(()=>approvedCohortOperationKey(bad),/approval_invalid/);
  g.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(4));
  await assert.rejects(prepareApprovedCohort(g.db,owner,request),/approval_changed/);
  const big=await setup(t,{initial:21});const before=big.calls();const next=await big.freeze();
  const prepared=await prepareApprovedCohort(big.db,next.owner,next.request);
  const plan=approvedCohortVectorPlan(prepared.revision);
  assert.equal(plan.products.length+plan.absentIds.length,21);assert.equal(big.calls(),before);
  assert.equal(big.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,2);
});
test('lost seal/settlement responses restart from exact receipts; drift and unknown provider keep ownership',async t=>{
  const f=await setup(t);await f.upsert(product(4));await f.drain();const {owner,request}=await f.freeze([uuid(4)]);
  f.lose(statements=>statements.some(s=>s.query.startsWith('INSERT INTO catalog_projection_receipts')));
  await assert.rejects(prepareApprovedCohort(f.db,owner,request));
  const recovered=await readMutationOwner(f.db,scope);const prepared=await prepareApprovedCohort(f.db,recovered,request);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,2);
  f.uncertain(true);const pending=await deliverOwnedApprovedCohortVector({db:f.db,owner:prepared.owner,revision:prepared.revision,
    publicId:uuid(1),original:f.originals.get(uuid(1)),adapters:f.adapters});
  assert.equal(pending.state,'pending');await assert.rejects(releaseMutationOwnership(f.db,pending.owner));
  const sent=f.calls();const retry=await deliverOwnedApprovedCohortVector({db:f.db,owner:pending.owner,revision:prepared.revision,
    publicId:uuid(1),original:f.originals.get(uuid(1)),adapters:f.adapters});assert.equal(retry.state,'pending');assert.equal(f.calls(),sent);
  f.uncertain(false);const complete=await deliverOwnedApprovedCohortVector({db:f.db,owner:pending.owner,revision:prepared.revision,
    publicId:uuid(1),original:f.originals.get(uuid(1)),adapters:f.adapters});
  const current=await f.promote({...prepared,owner:complete.owner});
  f.lose(statements=>statements.some(s=>s.query.startsWith('INSERT INTO catalog_build_requests')));
  await assert.rejects(settleApprovedCohort(f.db,current,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,current,prepared.revision,f.adapters)));
  const actual=await readMutationOwner(f.db,scope);
  assert.equal((await settleApprovedCohort(f.db,actual,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,actual,prepared.revision,f.adapters))).state,'existing');
  const g=await setup(t);const claim=await g.freeze();
  g.after(statements=>{if(statements.some(s=>s.query.startsWith('INSERT INTO catalog_public_products'))){g.after(null);
    g.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(1));}});
  await assert.rejects(prepareApprovedCohort(g.db,claim.owner,claim.request));assert.equal(g.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1);
});
test('new sealed reader recognizes operation-bound actual observation, not the later SQL clock',async t=>{
  const f=await setup(t);const claim=await f.freeze();const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  const current=await f.promote(prepared);await settleApprovedCohort(f.db,current,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,current,prepared.revision,f.adapters));
  const revision=prepared.revision;const envelope=createSealedSnapshotEnvelope(revision.snapshot);
  const context={...f.context,envelopeSha256:sha256(`${JSON.stringify(envelope)}\n`),snapshotSha256:revision.packet.receipt.snapshot_sha256,
    projectionSha256:revision.packet.receipt.projection_sha256,sourceExportSha256:revision.sourceDigest,vectorSyncWatermark:0};
  assert.equal((await reconstructD1Snapshot(f.db,envelope,context)).status,'ready');
  const row=f.sql.prepare('SELECT timestamp_provenance_json FROM products WHERE public_id=?').get(uuid(1));const proof=JSON.parse(row.timestamp_provenance_json);
  proof.fields.availability_checked_at.observedAt=at(86400000);f.sql.prepare('UPDATE products SET timestamp_provenance_json=? WHERE public_id=?').run(JSON.stringify(proof),uuid(1));
  assert.equal((await reconstructD1Snapshot(f.db,envelope,context)).status,'held');
  assert.equal((await getRevisionProductsByPublicIds(f.db,[uuid(2)],f.now(),revision.snapshot.catalogRevision)).length,1);
});
test('unapproved revisions remain searchable only when compatible; no early mutable serving-revision flip',async t=>{
  const f=await setup(t);await f.upsert(product(1,{title:'New factual replacement',sourceFacts:{fixture:1,changed:true}}));await f.drain();
  const claim=await f.freeze();const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  assert.deepEqual(prepared.revision.snapshot.products,[f.previous.products[1]]);
  assert.deepEqual((await getRevisionProductsByPublicIds(f.db,[uuid(1),uuid(2)],f.now(),f.previous.catalogRevision)).map(p=>p.publicId),[uuid(2)]);
  assert.equal(f.sql.prepare('SELECT catalog_revision FROM products WHERE public_id=?').get(uuid(2)).catalog_revision,'prior-revision');
  assert.equal(f.sql.prepare('SELECT status FROM catalog_revisions WHERE revision=?').get('approved-revision').status,'importing');
  await assert.rejects(settleApprovedCohort(f.db,prepared.owner,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,prepared.owner,prepared.revision,f.adapters)),/vectors_unconfirmed/);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
});
test('exact approved full-row CAS and prior/watermark/expiry guards reject drift before final queue',async t=>{
  for(const mutate of [
    f=>f.sql.prepare('UPDATE products SET price_minor=1234 WHERE public_id=?').run(uuid(4)),
    f=>f.sql.exec("UPDATE publication_receipts SET manifest_json='[]'"),
    f=>f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1'),
    f=>f.advance(7*3600000),
  ]){
    const f=await setup(t);await f.upsert(product(4));await f.drain();const claim=await f.freeze([uuid(4)]);
    const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);const owner=await f.promote(prepared);
    await assert.rejects(settleApprovedCohort(f.db,owner,prepared.revision,async()=>{
      const proof=await readOwnedApprovedCohortVectors(f.db,owner,prepared.revision,f.adapters);mutate(f);return proof;}));
    assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
    assert.equal(f.sql.prepare('SELECT status FROM catalog_revisions WHERE revision=?').get('approved-revision').status,'importing');
  }
});
test('delayed approved-vector settlement across expiry releases only proven work and can explicitly abandon the seal',async t=>{
  const f=await setup(t);f.setIntent((p,hash)=>({rightsById:{[p.id]:{...rights(p),title:{...rights(p).title,expiresAt:at(8*3600000)}}},
    verificationById:{[p.id]:{reference:'test-only/observation',observedAt:at(-3600000),sourceFactsHash:hash}},
    embeddingById:{[p.id]:{reference:'test-only/embedding',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}}));
  await f.upsert(product(4));await f.drain();const claim=await f.freeze([uuid(4)]);const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  f.index.delete(uuid(4));const options={db:f.db,owner:prepared.owner,revision:prepared.revision,publicId:uuid(4),adapters:f.adapters};
  const first=await deliverOwnedApprovedCohortVector(options);assert.equal(first.state,'pending');const calls=f.calls();
  f.advance(9*3600000);const expired=await deliverOwnedApprovedCohortVector({...options,owner:first.owner});
  assert.equal(expired.state,'expired');assert.equal(f.calls(),calls);assert.equal(f.sql.prepare('SELECT external_pending FROM catalog_mutation_scopes').get().external_pending,0);
  await assert.rejects(settleApprovedCohort(f.db,expired.owner,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,expired.owner,prepared.revision,f.adapters)));
  const abandoned=await abandonExpiredPrunedRevision(f.db,expired.owner,prepared.revision);
  assert.equal(abandoned.state,'abandoned');await releaseMutationOwnership(f.db,abandoned.owner);
  assert.equal(f.sql.prepare('SELECT status FROM catalog_revisions WHERE revision=?').get('approved-revision').status,'importing');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
});

// All rows below are owned synthetic archive identities, not merchant claims.
async function addHeld(f,total) {
  const template={...f.sql.prepare('SELECT * FROM products WHERE public_display_json IS NULL LIMIT 1').get()};
  const columns=Object.keys(template),insert=f.sql.prepare(`INSERT INTO products(${columns}) VALUES(${columns.map(()=>'?')})`);
  f.sql.exec('BEGIN');try{
    for(let n=f.sql.prepare('SELECT count(*) n FROM products').get().n+1;n<=total;n++){
      const row={...template,id:id(n),public_id:uuid(n),slug:`owned-held-${n}`,timestamp_provenance_json:'{}',rights_json:'{}',embedding_text_hash:null,
        source_record_json:JSON.stringify({id:id(n),public_id:uuid(n),source:'amazon',availability_checked_at:null,last_verified_at:null})};
      insert.run(...columns.map(key=>row[key]));f.previous.heldProducts.push({id:row.id,publicId:row.public_id,slug:row.slug,path:`/gifts/${row.slug}`,
        title:'Gift currently unavailable',description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'inactive'});
    }f.sql.exec('COMMIT');
  }catch(error){f.sql.exec('ROLLBACK');throw error;}
  const packet=await createProjectionPacket(f.previous,Object.fromEntries(f.sql.prepare('SELECT public_id,source_facts_hash FROM products').all()
    .map(row=>[row.public_id,row.source_facts_hash])),source,new Date(AT));
  f.sql.prepare('DELETE FROM catalog_projection_receipts WHERE catalog_revision=?').run(f.previous.catalogRevision);
  const receipt=projectionQueries(packet).at(-1);f.sql.prepare(receipt.sql).run(...receipt.params);f.packet=packet;
  f.priorIntent.catalogSnapshotSha256=packet.receipt.snapshot_sha256;
  f.sql.prepare('UPDATE publication_receipts SET manifest_json=?').run(JSON.stringify(f.priorIntent));
  const prior={...f.sql.prepare('SELECT * FROM publication_receipts').get()};
  Object.assign(f.context,{envelopeSha256:sha256(`${JSON.stringify(createSealedSnapshotEnvelope(f.previous))}\n`),
    snapshotSha256:packet.receipt.snapshot_sha256,projectionSha256:packet.receipt.projection_sha256,
    priorPublication:{releaseId:prior.release_id,receiptSha256:sha256(canonicalJson(prior))}});
}
async function boundedRest(t,f) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'goose-capture-')));t.after(()=>rm(directory,{recursive:true,force:true}));
  const options={directory:join(directory,'runs'),repository:await realpath(new URL('..',import.meta.url).pathname),runId:'test-capture',
    codeSha:'e'.repeat(40),configSha256:'f'.repeat(64),scope:{...scope,accountId:'a'.repeat(32),databaseId:uuid(99999),databaseName:'test-capture',workerName:'test-capture'},
    retention:{reviewReference:'test-only/owned-retention',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
      .map(kind=>[kind,{maxAgeMs:86400000,notAfter:at(86400000)}]))},budgetCaps:{httpRequests:10000,sqlStatements:25000},now:()=>f.now().toISOString()};
  let workspace=await openRunWorkspace({...options,mode:'create'});t.after(async()=>{try{await workspace.close();}catch{}});
  const wire={requests:0,statements:0,maxRequest:0,maxResponse:0,maxStatements:0,maxParameters:0,currentPages:0};
  let before,after,tamper,indexChecked=false;
  const fetch=async(_url,init)=>{
    wire.requests++;const input=init.body?JSON.parse(init.body).batch:null;
    if(!input)return Response.json({success:true,result:{uuid:options.scope.databaseId,name:options.scope.databaseName,read_replication:{mode:'disabled'}}});
    wire.maxRequest=Math.max(wire.maxRequest,Buffer.byteLength(init.body));wire.maxStatements=Math.max(wire.maxStatements,input.length);
    assert.ok(wire.maxRequest<=512*1024);assert.ok(input.length<=50);wire.statements+=input.length;await before?.(input);
    const output=[];f.sql.exec('BEGIN');try{
      for(const q of input){wire.maxParameters=Math.max(wire.maxParameters,q.params.length);assert.ok(q.params.length<=100);
        if(/FROM requested ids CROSS JOIN products p\s+ON p.public_id=ids.value/.test(q.sql)){
          wire.currentPages++;
          if(!indexChecked){const plan=f.sql.prepare(`EXPLAIN QUERY PLAN ${q.sql}`).all(...q.params).map(row=>row.detail).join('\n');
            assert.match(plan,/SEARCH p USING INDEX .*public_id=\?/);assert.doesNotMatch(plan,/SCAN p\b/);indexChecked=true;}
        }
        const old=f.sql.prepare('SELECT total_changes() n').get().n,results=f.sql.prepare(q.sql).all(...q.params).map(row=>({...row}));
        const written=f.sql.prepare('SELECT total_changes() n').get().n-old;
        output.push({success:true,results,meta:{served_by_primary:true,rows_read:results.length,rows_written:written,changes:written}});
      }f.sql.exec('COMMIT');
    }catch(error){f.sql.exec('ROLLBACK');throw error;}
    await after?.(input);tamper?.(input,output);
    const bytes=JSON.stringify({success:true,result:output});wire.maxResponse=Math.max(wire.maxResponse,Buffer.byteLength(bytes));
    assert.ok(Buffer.byteLength(bytes)<=512*1024);return new Response(bytes,{headers:{'content-type':'application/json'}});
  };
  async function connect(){const db=await createCatalogD1Rest({accountId:options.scope.accountId,databaseId:options.scope.databaseId,databaseName:options.scope.databaseName,
    token:'TEST_ONLY',fetch,limits:{requests:10000,statements:25000},accounting:{scope:{accountId:options.scope.accountId,databaseId:options.scope.databaseId,databaseName:options.scope.databaseName},
      initial:await workspace.budget(),reserve:input=>workspace.reserveBudget(input),settle:(id,result)=>workspace.settleBudget(id,result)}});f.useDb(db);return db;}
  await connect();return{wire,options,workspace:()=>workspace,before(fn){before=fn;},after(fn){after=fn;},tamper(fn){tamper=fn;},
    async reopen(){const before=await workspace.budget();await workspace.close();workspace=await openRunWorkspace({...options,mode:'resume'});
      assert.deepEqual(await workspace.budget(),before);await connect();return before;}};
}
test('3383 private identities/four ready capture → native promotion → atomic queue through bounded primary REST and durable budget',async t=>{
  const f=await setup(t,{initial:4});await addHeld(f,3383);const rest=await boundedRest(t,f),claim=await f.freeze();
  const rowsBefore=f.sql.prepare('SELECT id,public_id,slug,source_record_json FROM products ORDER BY id').all();
  const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);
  assert.equal(prepared.revision.sourceRows.length,3383);assert.equal(prepared.revision.snapshot.products.length,4);
  assert.equal(prepared.revision.snapshot.heldProducts.length,3379);assert.equal(prepared.revision.additionalAbsentIds.length,0);
  assert.equal(approvedCohortVectorPlan(prepared.revision).absentIds.length,0);
  const owner=await f.promote(prepared);assert.equal(f.index.size,4);
  for(const v of f.index.values()){assert.ok(Object.is(v.values[0],-0));assert.equal(nativeHash(v.values),nativeHash(values));}
  const queued=await settleApprovedCohort(f.db,owner,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,owner,prepared.revision,f.adapters));
  assert.equal(queued.state,'build_queued');assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1); // Queue is NOT publication.
  assert.deepEqual(f.sql.prepare('SELECT id,public_id,slug,source_record_json FROM products ORDER BY id').all(),rowsBefore);
  const before=await rest.reopen();
  assert.equal((await settleApprovedCohort(f.db,queued.owner,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,queued.owner,prepared.revision,f.adapters))).state,'existing');
  const usage=await rest.workspace().budget();assert.ok(usage.httpRequests>before.httpRequests);assert.equal(usage.unconfirmedRequests,0);
  assert.equal(usage.httpRequests,rest.wire.requests);assert.equal(usage.sqlStatements,rest.wire.statements);
  assert.ok(rest.wire.currentPages>=43*6);assert.ok(rest.wire.maxRequest<=512*1024);assert.ok(rest.wire.maxResponse<=512*1024);
  t.diagnostic(JSON.stringify({scope:'fixture capture/promotion/queue/replay ONLY; not whole weekly/provider capacity',...rest.wire,...usage}));
  const unowned=await reconstructD1Snapshot(f.db,createSealedSnapshotEnvelope(f.previous),f.context);
  assert.equal(unowned.status,'held'); // No silent unowned paging.
});
test('late-page owner drift/ABA, invalid/missing/reordered rows and unknown reads cannot create a seal',async t=>{
  for(const fault of ['epoch','aba','owner-object','delete','mutation','missing','duplicate','reordered','primary','unknown']){
    const f=await setup(t);await addHeld(f,180);const rest=await boundedRest(t,f),claim=await f.freeze();let pages=0;
    rest.before(async batch=>{if(!batch.some(q=>/FROM requested ids CROSS JOIN products p\s+ON p.public_id=ids.value/.test(q.sql))||++pages!==2)return;
      if(fault==='epoch')f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1');
      if(fault==='aba'){await releaseMutationOwnership(f.local,claim.owner);await claimMutationOwnership(f.local,scope,
        {phase:'freezing',ownerReference:claim.owner.ownerReference,operationKey:claim.owner.operationKey});}
      if(fault==='owner-object'){claim.owner.epoch++;f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1');}
      if(fault==='delete')f.sql.prepare('DELETE FROM products WHERE public_id=?').run(uuid(85));
      if(fault==='mutation')f.sql.prepare('UPDATE products SET rights_json=? WHERE public_id=?').run('{"test":"changed"}',uuid(6));
      if(fault==='unknown')throw new Error('TEST ONLY unread response');
    });
    rest.tamper((batch,result)=>{if(pages!==2||!batch.some(q=>/FROM requested ids CROSS JOIN products p\s+ON p.public_id=ids.value/.test(q.sql)))return;
      const rows=result[0].results;if(fault==='missing')rows.shift();if(fault==='duplicate')rows[1]=rows[0];if(fault==='reordered')rows.reverse();
      if(fault==='primary')result[0].meta.served_by_primary=false;});
    await assert.rejects(prepareApprovedCohort(f.db,claim.owner,claim.request),undefined,fault);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
    assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'freezing');
    if(['primary','unknown'].includes(fault))assert.ok((await rest.workspace().budget()).unconfirmedRequests>0);
  }
});
test('escaped near-row-limit capture/CAS bytes, interrupted staging, receipt tamper and held legacy writers stay fail-closed',async t=>{
  const f=await setup(t,{initial:4});await addHeld(f,180);
  const original={...f.sql.prepare('SELECT * FROM catalog_maintenance_operations LIMIT 1').get()},columns=Object.keys(original);
  for(let n=6;n<=9;n++){
    const operation={...original,operation_id:sha256(`test-only/escaped-operation-${n}`),changes_json:JSON.stringify([{ownedFixture:'"\\'.repeat(7000)}])};
    f.sql.prepare(`INSERT INTO catalog_maintenance_operations(${columns}) VALUES(${columns.map(()=>'?')})`).run(...columns.map(key=>operation[key]));
    f.sql.prepare('UPDATE products SET timestamp_provenance_json=? WHERE public_id=?').run(JSON.stringify({schemaVersion:1,
      fields:{availability_checked_at:{basis:'maintenance_operation',operationId:operation.operation_id}}}),uuid(n));
  }
  const rest=await boundedRest(t,f),claim=await f.freeze();let interrupted=false;
  rest.after(batch=>{if(!interrupted&&batch.some(q=>q.sql.startsWith('INSERT INTO catalog_public_products'))){interrupted=true;throw new Error('TEST ONLY staged-response loss');}});
  await assert.rejects(prepareApprovedCohort(f.db,claim.owner,claim.request));assert.equal(interrupted,true);
  assert.equal(f.sql.prepare('SELECT status FROM catalog_revisions WHERE revision=?').get('approved-revision').status,'importing');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1);
  assert.deepEqual(await getRevisionProductsByPublicIds(f.db,[uuid(1),uuid(2)],f.now(),'approved-revision'),[]);
  rest.after(null);const prepared=await prepareApprovedCohort(f.db,claim.owner,claim.request);assert.equal(prepared.revision.sourceRows.length,180);
  assert.ok(prepared.revision.sourceRows.some(row=>Buffer.byteLength(JSON.stringify(row))>100*1024));
  assert.ok(prepared.revision.sourceRows.find(row=>row.public_id===uuid(6)).verification_operation_json.includes('ownedFixture'));
  assert.ok(rest.wire.maxResponse>200*1024);assert.ok(rest.wire.maxRequest>300*1024);
  await assert.rejects(f.upsert(product(181)));assert.equal(f.sql.prepare('SELECT count(*) n FROM products').get().n,180);
  const owner=await f.promote(prepared);
  f.sql.prepare('DELETE FROM catalog_projection_receipts WHERE catalog_revision=?').run(prepared.revision.snapshot.catalogRevision);
  await assert.rejects(settleApprovedCohort(f.db,owner,prepared.revision,()=>readOwnedApprovedCohortVectors(f.db,owner,prepared.revision,f.adapters)));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
  assert.ok((await rest.workspace().budget()).unconfirmedRequests>0); // Interrupted request never refunded.
});

test('empty capture still checks owner/header; overlapping prior target and late cutoff cannot seal/queue',async t=>{
  const empty=await setup(t,{initial:0});empty.previous.heldProducts.length=0;empty.previous.slugHistory.length=0;await addHeld(empty,0);
  const er=await boundedRest(t,empty),claim=await empty.freeze();
  await assert.rejects(prepareApprovedCohort(empty.db,{...claim.owner,epoch:claim.owner.epoch+1},claim.request));
  const prepared=await prepareApprovedCohort(empty.db,claim.owner,claim.request);
  assert.equal(prepared.revision.sourceRows.length,0);assert.equal(er.wire.currentPages,0);assert.equal(prepared.state,'all_held');
  await assert.rejects(sealCapturedRevision(empty.db,prepared.owner,{...prepared.revision,
    snapshot:{...prepared.revision.snapshot,catalogRevision:empty.previous.catalogRevision}}),/owner_mismatch/);
  const f=await setup(t);await addHeld(f,180);const rest=await boundedRest(t,f),next=await f.freeze();
  const ready=await prepareApprovedCohort(f.db,next.owner,next.request),owner=await f.promote(ready);
  rest.after(batch=>{if(batch.some(q=>q.sql.includes('SELECT count(*) FROM json_each(?) e CROSS JOIN products p'))){rest.after(null);f.advance(7*3600000);}});
  await assert.rejects(settleCapturedRevision(f.db,owner,ready.revision,()=>readOwnedApprovedCohortVectors(f.db,owner,ready.revision,f.adapters)));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
  assert.equal(f.sql.prepare('SELECT status FROM catalog_revisions WHERE revision=?').get('approved-revision').status,'importing');
});

test('unexpected partial target rows stay held rather than being ignored by fixed identity pages',async t=>{
  const f=await setup(t),rest=await boundedRest(t,f),claim=await f.freeze();
  rest.after(batch=>{if(!batch.some(q=>q.sql.startsWith('INSERT INTO catalog_revisions')))return;rest.after(null);
    const row={...f.sql.prepare('SELECT * FROM catalog_public_products LIMIT 1').get(),catalog_revision:'approved-revision',
      public_id:uuid(3),product_id:id(3),slug:'test-only-unexpected'};
    const columns=Object.keys(row);f.sql.prepare(`INSERT INTO catalog_public_products(${columns}) VALUES(${columns.map(()=>'?')})`).run(...Object.values(row));});
  await assert.rejects(prepareApprovedCohort(f.db,claim.owner,claim.request));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
});
