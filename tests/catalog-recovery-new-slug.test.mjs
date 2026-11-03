import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {planNewProductSlugRepair,applyNewProductSlugRepair,effectiveSlugApproval,repairApprovedNewSlugs,repairedSlugOriginalVector} from '../scripts/catalog/new-product-slug-repair.ts';
import {maintenanceProjection,maintenanceEmbeddingText} from '../scripts/catalog/maintenance-state.ts';
import {mergeCatalogMaintenanceUpsert} from '../scripts/ops/catalog-maintenance-merge.mjs';
import {editorialSourceHash} from '../scripts/ops/catalog-editorial-core.mjs';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {validatePublicCatalogProduct} from '../lib/catalog/snapshot.ts';
import {createProjectionPacket,projectionQueries} from '../lib/catalog/d1.ts';
import {approvedCohortOperationKey,prepareApprovedCohort} from '../lib/catalog/freeze-approved-cohort.ts';
import {createSealedSnapshotEnvelope} from '../scripts/catalog/export-d1-snapshot.ts';
import {approvedRevisionControl,hydrateApprovedRevision} from '../scripts/catalog/approved-catalog-seal.ts';

const NOW='2026-11-02T12:00:00.000Z';
const OBSERVED='2026-11-02T11:59:00.000000Z';
function fixture(){
  const input={id:'B000000001',title:'Synthetic lobster mitts',price:12,currency:'USD',imageUrl:'https://example.invalid/mitts.jpg',
    affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=test-20',source:'amazon',sourceQuery:'test-only',humorTags:['lobster'],
    wittyDescription:'Owned synthetic lobster-shaped cotton oven mitts.',qualityScore:.9,isActive:true,sourceFacts:{material:'cotton'},
    availabilityStatus:'IN_STOCK',editorialStatus:'short_ready',editorialQualityScore:.9,editorialModel:'test-only',
    editorialPromptVersion:'test-short',editorialGeneratedAt:NOW,remotelyVerified:true};
  const facts=editorialSourceHash(input);
  const p={...mergeCatalogMaintenanceUpsert(null,{...input,editorialSourceHash:facts},{sourceFactsHash:facts,databaseTime:NOW}).product,
    publicId:'00000000-0000-4000-8000-000000000001',slug:'a'.repeat(119)+'-'};
  const grant=(value)=>({basis:'owned',reference:'test-only-owner-content',value});
  const persistent=Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,affiliateUrl:p.affiliateUrl,
    wittyDescription:p.wittyDescription,humorTags:JSON.stringify(p.humorTags)}).map(([k,v])=>[k,grant(v)]));
  persistent.imageUrl=grant('/images/gift-placeholder.svg');
  const rights={...persistent,imageUrl:{basis:'merchant',reference:'test-only-observation',value:p.imageUrl,observedAt:new Date(OBSERVED).toISOString(),expiresAt:'2026-11-03T11:59:00.000Z'},persistent};
  const row={...maintenanceProjection(p,rights,'new-run',NOW,true,NOW,undefined,true).row,
    embedding_text_hash:sha256(maintenanceEmbeddingText(p)),source_record_json:canonicalJson({kind:'maintenance_creation',id:p.id,public_id:p.publicId,slug:p.slug,product:p}),
    timestamp_provenance_json:canonicalJson({schemaVersion:1,fields:{availability_checked_at:{state:'evidenced',basis:'maintenance_operation',
      operationId:'1'.repeat(64),observedAt:OBSERVED,sourceFactsHash:facts,reference:'test-only-observation'}}})};
  assert.equal(row.public_display_json,null);
  const native=encodePgvectorSendBase64(Array(1536).fill(.25)),text=maintenanceEmbeddingText(p);
  const state={product_id:p.id,version:1,semantic_json:canonicalJson(p),embedding_present:1,embedding_native_base64:native,
    embedding_provenance_json:canonicalJson({input:'verified',reference:'test-only-native',model:'text-embedding-3-small',text,
      sourceFactsHash:facts,embeddingTextHash:sha256(text),vectorBytesSha256:createHash('sha256').update(Buffer.from(native,'base64')).digest('hex')})};
  const operation={operation_id:'1'.repeat(64),input_sha256:'2'.repeat(64),run_id:'new-run',catalog_revision:'new-run',
    environment:'staging',index_name:'test-slug',generation:1,prior_epoch:0,next_epoch:1,database_time:NOW,result_json:'{}',
    changes_json:canonicalJson([{productId:p.id,beforeSha256:null,afterSha256:sha256(canonicalJson(row))}])};
  const change={publicId:p.publicId,operationId:operation.operation_id,inputSha256:operation.input_sha256,
    productSha256:sha256(canonicalJson(row)),displaySha256:sha256('null')};
  const owner={environment:'staging',indexName:'test-slug',generation:2,epoch:1,token:'test-token',phase:'freezing',ownerReference:'new-run:freeze',operationKey:'3'.repeat(64),capturedAt:NOW};
  const request={previous:{products:[],heldProducts:[]},approval:{schemaVersion:1,runId:'new-run',catalogRevision:'new-run',changes:[change]}};
  return{row,state,operation,change,owner,request,now:NOW};
}
async function database(t,f){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.function('strftime',(_format,instant)=>instant==='now'?NOW:new Date(instant).toISOString());
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())
    sql.exec(await readFile(new URL('../migrations/d1/'+name,import.meta.url),'utf8'));
  for(const [table,row] of [['products',f.row],['catalog_maintenance_products',f.state],['catalog_maintenance_operations',f.operation]]){
    const keys=Object.keys(row);sql.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...Object.values(row));
  }
  sql.prepare(`INSERT INTO catalog_mutation_scopes(environment,index_name,phase,generation,mutation_epoch,owner_token,owner_reference,operation_key,captured_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(f.owner.environment,f.owner.indexName,f.owner.phase,f.owner.generation,f.owner.epoch,f.owner.token,f.owner.ownerReference,f.owner.operationKey,NOW);
  const db={prepare(query){let params=[];return{bind(...p){params=p;return this;},async all(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},execute(){return sql.prepare(query).all(...params);}};},
    async batch(statements){sql.exec('BEGIN');try{for(const s of statements)s.execute();sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return{sql,db};
}
test('only fixes never-public trailing-hyphen truncation; source, observations and native input remain exact',()=>{
  const f=fixture(),plan=planNewProductSlugRepair(f);
  assert.equal(plan.after.slug,'a'.repeat(119));
  const display=validatePublicCatalogProduct(JSON.parse(plan.after.public_display_json),new Date(NOW));
  assert.ok(display.persistent);assert.equal(display.description,'Owned synthetic lobster-shaped cotton oven mitts.');
  for(const field of ['source_record_json','rights_json','embedding_text_hash','availability_checked_at','timestamp_provenance_json','created_at','updated_at'])
    assert.equal(plan.after[field],f.row[field]);
  for(const field of ['embedding_native_base64','embedding_provenance_json'])assert.equal(plan.nextState[field],f.state[field]);
  for(const mutate of [x=>x.request.previous.products.push({publicId:x.change.publicId}),x=>x.row.is_active=0,x=>x.row.slug='valid-slug',
    x=>x.row.public_display_json='{}',x=>x.owner.phase='writing',x=>x.state.embedding_provenance_json='{}',
    x=>{const proof=JSON.parse(x.row.timestamp_provenance_json);proof.fields.availability_checked_at.observedAt='2026-11-02T12:01:00.000Z';
      x.row.timestamp_provenance_json=canonicalJson(proof);}]){
    const bad=fixture();mutate(bad);assert.throws(()=>planNewProductSlugRepair(bad));
  }
});
test('same-owner repair is atomic/idempotent and retains original URL, archive, operation and trigger',async t=>{
  const f=fixture(),{sql,db}=await database(t,f),plan=planNewProductSlugRepair(f);
  const owner=await applyNewProductSlugRepair(db,plan);
  assert.deepEqual(await applyNewProductSlugRepair(db,plan),owner);
  assert.equal(sql.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,2);
  assert.deepEqual({...sql.prepare('SELECT * FROM catalog_maintenance_operations WHERE operation_id=?').get(f.operation.operation_id)},f.operation);
  assert.equal(sql.prepare('SELECT product_id FROM product_slug_history WHERE slug=?').get(f.row.slug).product_id,f.row.id);
  assert.throws(()=>sql.prepare('UPDATE products SET slug=? WHERE id=?').run('unapproved-new-slug',f.row.id),/preserves existing slugs/);
  const row={...sql.prepare('SELECT * FROM products').get()},ops=sql.prepare('SELECT * FROM catalog_maintenance_operations').all().map(r=>({...r}));
  const effective=effectiveSlugApproval(f.change,ops,row,owner,f.request);
  assert.notEqual(effective.operationId,f.change.operationId);assert.equal(effective.productSha256,sha256(canonicalJson(row)));
  for(const mutate of [x=>x.row.title='changed',x=>x.owner.epoch=0,x=>x.owner.generation++,x=>x.request.previous.products.push({publicId:f.change.publicId})]){
    const input=structuredClone({row,owner,request:f.request});mutate(input);
    assert.throws(()=>effectiveSlugApproval(f.change,ops,input.row,input.owner,input.request));
  }
  assert.deepEqual(await repairApprovedNewSlugs(db,owner,f.request,NOW),owner);
});
test('a failed repair rolls back URL/history/receipt and restores the same trigger',async t=>{
  const f=fixture(),{sql,db}=await database(t,f),plan=planNewProductSlugRepair(f);
  sql.exec("CREATE TRIGGER test_lost_sidecar BEFORE UPDATE ON catalog_maintenance_products BEGIN SELECT RAISE(ABORT,'test conflict'); END");
  await assert.rejects(applyNewProductSlugRepair(db,plan));
  assert.equal(sql.prepare('SELECT slug FROM products').get().slug,f.row.slug);
  assert.equal(sql.prepare('SELECT count(*) n FROM product_slug_history').get().n,0);
  assert.equal(sql.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,1);
  assert.throws(()=>sql.prepare('UPDATE products SET slug=? WHERE id=?').run('still-fenced',f.row.id),/preserves existing slugs/);
});
test('the original immutable approval seals the repaired display through the real cohort validator',async t=>{
  const f=fixture(),{sql,db}=await database(t,f);
  const previous={schemaVersion:1,dataKind:'catalog',catalogRevision:'prior',generatedAt:NOW,products:[],heldProducts:[],slugHistory:[]};
  const packet=await createProjectionPacket(previous,{},'a'.repeat(64),new Date(NOW));
  sql.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,'published')").run('prior',NOW,'a'.repeat(64));
  for(const q of projectionQueries(packet))sql.prepare(q.sql).run(...q.params);
  const intent={releaseId:'prior',catalogRevision:'prior',codeSha:'c'.repeat(40),catalogSnapshotSha256:packet.receipt.snapshot_sha256,
    manifestSha256:'d'.repeat(64),vectorSyncWatermark:0,priorReleaseId:null,nextExpiry:null};
  const receipt={release_id:'prior',catalog_revision:'prior',code_sha:intent.codeSha,completed_at:NOW,manifest_json:JSON.stringify(intent)};
  sql.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(...Object.values(receipt));
  const context={envelopeSha256:sha256(JSON.stringify(createSealedSnapshotEnvelope(previous))+'\n'),snapshotSha256:packet.receipt.snapshot_sha256,
    projectionSha256:packet.receipt.projection_sha256,sourceExportSha256:'a'.repeat(64),vectorSyncWatermark:0,publicationReceiptWatermark:1,
    cutoff:'2026-11-02T13:00:00.000Z',priorPublication:{releaseId:'prior',receiptSha256:sha256(canonicalJson(receipt))}};
  const request={...f.request,previous,context,scope:{environment:f.owner.environment,indexName:f.owner.indexName},codeSha:'e'.repeat(40),
    approvalSha256:sha256(canonicalJson(f.request.approval))};
  const owner={...f.owner,operationKey:approvedCohortOperationKey(request)};
  sql.prepare('UPDATE catalog_mutation_scopes SET operation_key=?').run(owner.operationKey);
  const fixed=await repairApprovedNewSlugs(db,owner,request,NOW),before=canonicalJson(request.approval);
  const prepared=await prepareApprovedCohort(db,fixed,request);
  assert.equal(prepared.state,'prepared');assert.equal(prepared.revision.snapshot.products.length,1);
  assert.equal(prepared.revision.snapshot.products[0].slug,'a'.repeat(119));
  assert.equal(canonicalJson(prepared.revision.request.approval),before);
  assert.equal(sql.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,2);
  assert.deepEqual(await hydrateApprovedRevision(db,prepared.owner,approvedRevisionControl(prepared.revision)),prepared.revision);
  const current={...sql.prepare('SELECT * FROM products WHERE id=?').get(f.row.id)};
  // Owned technical fixture for the full private-inventory binding supplied by
  // the real permanent predecessor. This is not a provider acceptance claim.
  const state={...sql.prepare('SELECT * FROM catalog_maintenance_products').get()};
  const proofRevision={...prepared.revision,persistent:{inventory:[{publicId:f.change.publicId,privateStateSha256:sha256(canonicalJson(state))}]}};
  const native=await repairedSlugOriginalVector(db,prepared.owner,proofRevision,f.change,current);
  assert.equal(native.values.length,1536);assert.equal(native.values[0],.25);
  assert.equal(sql.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n,0);
  await assert.rejects(repairedSlugOriginalVector(db,prepared.owner,prepared.revision,f.change,current));
  sql.prepare("UPDATE catalog_maintenance_products SET embedding_provenance_json='{}' WHERE product_id=?").run(f.row.id);
  await assert.rejects(repairedSlugOriginalVector(db,prepared.owner,proofRevision,f.change,current));
});
