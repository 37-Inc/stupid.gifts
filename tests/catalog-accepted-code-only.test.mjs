import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {permanentCatalogFixture} from './helpers/permanent-catalog-fixture.mjs';
import {scope,uuid} from './helpers/published-vector-fixture.mjs';
import {earliestDisplayExpiry,resolvePublicProduct} from '../lib/catalog/display.ts';
import {preparePermanentCatalog,settlePermanentCatalog} from '../lib/catalog/freeze-permanent-catalog.ts';
import {approvedCohortOperationKey} from '../lib/catalog/freeze-approved-cohort.ts';
import {claimMutationOwnership,releaseMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {enqueueBuildRequest,claimBuildRequest,beginBuildActivation,reconcileObservedServingActivation,resolveBuildActivation} from '../lib/catalog/build-requests.ts';
import {enqueuePublication,claimPublication,recordPublicationDispatch,completeActivatedPermanentPublication,
  completeActivatedApprovedCatalogPublication,completeActivatedServingPublication,servingPublicationStatus} from '../lib/catalog/publication.ts';
import {prunedVectorPlan,prunedVectorIds} from '../lib/catalog/prune-existing-revision.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {createPermanentCatalogSeal} from '../scripts/catalog/permanent-catalog-seal.ts';
import {createPublishedApprovedCatalogSeal,catalogSuccessorBytes,readApprovedPrior} from '../scripts/catalog/approved-catalog-seal.ts';
import {createD1CatalogMaintenanceStore} from '../scripts/catalog/maintenance-d1.ts';
import {createSealedSnapshotEnvelope} from '../scripts/catalog/export-d1-snapshot.ts';
import {prepareOwnedApprovedCohortPlan,settleOwnedApprovedCohortVectorProof,readActivatedCatalogVectors,deliverOwnedApprovedCohortVector} from '../scripts/catalog/owned-vector-delivery.ts';
import {readAcceptedCodeOnlyCatalog,recheckAcceptedCodeOnlyCatalog,acceptedCodeOnlyOperationKey,assertAcceptedCodeOnlyBinding,acceptedCodeOnlyControl} from '../scripts/catalog/accepted-code-only.ts';
import {executePublication} from '../scripts/catalog/publish-release.ts';
import {openRunWorkspace} from '../scripts/catalog/run-workspace.ts';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';
import {accountedPublicationFetch,accountedPublicationReadFetch} from '../scripts/catalog/publication-read-fetch.ts';
import {accountedPublicationUploadCommand} from '../scripts/catalog/publication-upload-command.ts';
import {createReleaseIdentity} from '../scripts/staging/release-identity.mts';
import {siteIdentityBytes} from '../scripts/staging/build.mts';
import {assembleReleaseAssets} from '../scripts/staging/retention.mts';
import {createStaticFeedPlan} from '../workers/site/feed.ts';
import {createBrowseRelease} from '../static-site/lib/browse.ts';
import {createOgRelease} from '../static-site/lib/og.ts';
import {createPhotoRelease} from '../static-site/lib/photos.ts';
import {siteIdentityFor} from '../static-site/lib/site-identity.ts';
import {guides} from '../static-site/lib/guides.ts';
import {codeOnlyAuthority} from '../scripts/catalog/code-only-operator.mjs';
import safeCatalogPayload from '../static-site/public/safe/catalog.json' with {type:'json'};
import {exportRuntimeCatalog} from '../scripts/catalog/export-runtime-catalog.ts';
import {publishRuntimeCatalog,readAcceptedRuntimeHandoff} from '../scripts/catalog/publish-runtime-catalog.ts';

async function fixture(t,{codeSha='8'.repeat(40),mixed=false}={}){
  const f=await permanentCatalogFixture(t,{count:32,afterExpiry:!mixed,merchant:mixed});
  const prepared=await preparePermanentCatalog(f.db,f.owner,f.request),initial=prepared.revision;
  async function publish(revision,queued,releaseId,prior,version,permanent=false,servingPrior){
    const build=await claimBuildRequest(f.db,queued.requestId,releaseId,f.now());
    const intent={releaseId,catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
      catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
      priorReleaseId:prior.releaseId,nextExpiry:earliestDisplayExpiry(revision.snapshot.products)};
    await enqueuePublication(f.db,revision.snapshot,intent,f.now());
    const publication=await claimPublication(f.db,revision.snapshot,releaseId,f.now());
    await recordPublicationDispatch(f.db,revision.snapshot,publication,'version:'+version,f.now());
    const permit=await beginBuildActivation(f.db,build,revision.snapshot,publication,version,
      async()=>({environment:scope.environment,settled:true,active:servingPrior??prior}),f.now(),queued.owner,servingPrior);
    const plan=prunedVectorPlan(revision),read=()=>readActivatedCatalogVectors(f.db,permit,{catalogRevision:plan.catalogRevision,
      planSha256:sha256(canonicalJson(plan)),ids:prunedVectorIds(plan)},f.adapters,permanent?{permanent:revision}:{});
    const complete=permanent?completeActivatedPermanentPublication:completeActivatedApprovedCatalogPublication;
    await complete(f.db,revision,publication,permit,async()=>{await read();return intent;},f.now);
    await resolveBuildActivation(f.db,permit,async()=>{await read();return{environment:scope.environment,settled:true,active:{...intent,versionReference:version}};});
    return{intent,versionReference:version,publication:{releaseId,receiptSha256:sha256(canonicalJson({...f.sql.prepare('SELECT * FROM publication_receipts WHERE release_id=?').get(releaseId)}))}};
  }
  const queued=await settlePermanentCatalog(f.db,prepared.owner,initial,f.adapters);
  const original=await publish(initial,queued,'permanent-first',{...f.original.intent,versionReference:f.original.permit.versionReference},uuid(401),true);
  const predecessor=createPermanentCatalogSeal(initial,original.publication);
  const approval={schemaVersion:1,runId:'accepted',catalogRevision:'accepted',changes:[]};
  const request={scope,codeSha:'7'.repeat(40),previous:initial.snapshot,predecessor,approval,approvalSha256:sha256(canonicalJson(approval)),
    context:{envelopeSha256:sha256(JSON.stringify(createSealedSnapshotEnvelope(initial.snapshot))+'\n'),snapshotSha256:initial.packet.receipt.snapshot_sha256,
      projectionSha256:initial.packet.receipt.projection_sha256,sourceExportSha256:initial.sourceDigest,vectorSyncWatermark:initial.vectorSyncWatermark,
      publicationReceiptWatermark:f.sql.prepare('SELECT max(rowid) n FROM publication_receipts').get().n,
      priorPublication:predecessor.publication,cutoff:new Date(f.now().getTime()+3600000).toISOString()}};
  const freezing=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'accepted',operationKey:approvedCohortOperationKey(request)});
  const current=await prepareOwnedApprovedCohortPlan({db:f.db,owner:freezing,request,adapters:f.adapters});
  const next=await settleOwnedApprovedCohortVectorProof({db:f.db,owner:current.owner,revision:current.revision,adapters:f.adapters});
  const accepted=await publish(current.revision,next,'accepted', {...original.intent,versionReference:original.versionReference},uuid(402));
  const seal=await createPublishedApprovedCatalogSeal(f.db,current.revision,accepted.publication);
  const authority={schemaVersion:1,kind:'accepted-persistent-code-only',sealSha256:sha256(catalogSuccessorBytes(seal).toString('utf8')),
    publication:seal.publication,request:{schemaVersion:1,environment:scope.environment,sourceRevision:current.revision.snapshot.catalogRevision,
      sourceDigest:seal.snapshotSha256,codeSha,priorReleaseId:seal.publication.releaseId,capturedAt:current.revision.snapshot.generatedAt,
      cutoff:new Date(f.now().getTime()+3600000).toISOString()},observedAt:f.now().toISOString(),
    globalVectorWatermark:f.sql.prepare('SELECT coalesce(max(sequence),0) n FROM vector_sync_outbox').get().n,
    publicationReceiptWatermark:f.sql.prepare('SELECT max(rowid) n FROM publication_receipts').get().n,identityCount:32};
  const owner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'code-only',operationKey:acceptedCodeOnlyOperationKey(authority)});
  const read=(writer=owner)=>readAcceptedCodeOnlyCatalog({db:f.db,owner:writer,seal,authority,runReference:'code-only',adapters:f.adapters});
  const input=await read(),products=canonicalJson(f.sql.prepare('SELECT * FROM products ORDER BY id').all()),
    native=canonicalJson([...f.index]),journals=canonicalJson(f.sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY delivery_id').all()),
    receipts=canonicalJson(f.sql.prepare('SELECT * FROM publication_receipts ORDER BY release_id').all()),pointer=canonicalJson(seal);
  return{...f,seal,authority,owner,input,accepted,read,publishCatalog:publish,unchanged(){
    assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM products ORDER BY id').all()),products);
    assert.equal(canonicalJson([...f.index]),native);assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY delivery_id').all()),journals);
    assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM publication_receipts ORDER BY release_id').all()),receipts);assert.equal(canonicalJson(seal),pointer);
  }};
}

test('accepted published reader proves >20 identities without private source or native writes or renewed observations',async t=>{
  const f=await fixture(t);assert.equal(f.input.revision.evidence,'accepted-public-projection');assert.equal('sourceRows' in f.input.revision,false);
  const prepared=codeOnlyAuthority({seal:f.seal,codeSha:f.authority.request.codeSha,observedAt:f.authority.observedAt,cutoff:f.authority.request.cutoff,
    globalVectorWatermark:f.authority.globalVectorWatermark,publicationReceiptWatermark:f.authority.publicationReceiptWatermark});
  assert.equal(prepared.identityCount,32);assert.equal(prepared.request.capturedAt,f.input.revision.snapshot.generatedAt);
  assert.equal(prepared.publication.receiptSha256,f.seal.publication.receiptSha256);
  assert.ok(f.input.revision.snapshot.products.length>20);assert.ok(f.input.revision.snapshot.products.every(p=>p.eligibleUntil===null));
  assertAcceptedCodeOnlyBinding(f.input);const before=canonicalJson(f.input);
  const queryStart=f.queryText.length;
  await f.read();f.unchanged();assert.equal(canonicalJson(f.input),before);
  assert.ok(!f.queryText.slice(queryStart).some(sql=>/\b(?:FROM|JOIN)\s+(?:products|catalog_maintenance_products|catalog_maintenance_operations)\b/i.test(sql)),
    'Serving input must not recapture mutable private product/semantic history');
  const changed=structuredClone(f.input);changed.authority.sealSha256='0'.repeat(64);assert.throws(()=>assertAcceptedCodeOnlyBinding(changed));
  const bit=f.index.get(uuid(1)).values[0];f.index.get(uuid(1)).values[0]=Object.is(bit,-0)?0:-0;
  // Code-only reuses authenticated immutable delivery proof, not live provider payloads.
  await f.read();f.index.get(uuid(1)).values[0]=bit;f.unchanged();
  const vector=f.sql.prepare('SELECT sequence,status FROM vector_sync_outbox LIMIT 1').get();
  f.sql.prepare("UPDATE vector_sync_outbox SET status='pending' WHERE sequence=?").run(vector.sequence);
  await assert.rejects(readAcceptedCodeOnlyCatalog({db:f.db,owner:f.owner,seal:f.seal,authority:f.authority,runReference:'code-only'}));
  f.sql.prepare('UPDATE vector_sync_outbox SET status=? WHERE sequence=?').run(vector.status,vector.sequence);
  const latest=f.sql.prepare('SELECT max(sequence) n FROM vector_sync_outbox').get().n;
  f.sql.prepare('UPDATE vector_sync_outbox SET sequence=? WHERE sequence=?').run(latest+1,latest);
  await assert.rejects(readAcceptedCodeOnlyCatalog({db:f.db,owner:f.owner,seal:f.seal,authority:f.authority,runReference:'code-only'}));
  f.sql.prepare('UPDATE vector_sync_outbox SET sequence=? WHERE sequence=?').run(latest,latest+1);
  const wrongWatermark=structuredClone(f.authority);wrongWatermark.globalVectorWatermark++;
  await assert.rejects(readAcceptedCodeOnlyCatalog({db:f.db,owner:f.owner,seal:f.seal,authority:wrongWatermark,runReference:'code-only'}));
  f.unchanged();
  const originalTitle=f.sql.prepare('SELECT title FROM products WHERE public_id=?').get(uuid(1)).title;
  f.sql.prepare("UPDATE products SET title='unpublished private edit' WHERE public_id=?").run(uuid(1));
  assert.equal(canonicalJson((await f.read()).revision.snapshot),canonicalJson(f.input.revision.snapshot));
  f.sql.prepare('UPDATE products SET title=? WHERE public_id=?').run(originalTitle,uuid(1));f.unchanged();
  await assert.rejects(f.read({...f.owner,epoch:f.owner.epoch+1}));
});

for(const loss of ['none','commit-ack','checkpoint-ack'])test('runtime data publication uses the original native proof and real receipt without any Worker activation: '+loss,async t=>{
  const f=await fixture(t);await releaseMutationOwnership(f.db,f.owner);
  for(const file of ['0018_content_admin_requests.sql','0019_runtime_catalog.sql'])f.sql.exec(await fs.readFile(new URL('../migrations/d1/'+file,import.meta.url),'utf8'));
  const objects=new Map(),puts=[];
  const store={async get(key){const bytes=objects.get(key);return bytes?{bytes:new Uint8Array(bytes),etag:'"fixture"'}:null;},async putImmutable(key,bytes){
    const prior=objects.get(key);if(prior)assert.deepEqual(prior,bytes);else objects.set(key,new Uint8Array(bytes));puts.push(key);return{bytes,etag:'"fixture"'};}};
  const assets=Object.fromEntries(f.input.revision.snapshot.products.flatMap(p=>[p,...(p.persistent?[p.persistent]:[])]).filter(p=>p.imageUrl.startsWith('/'))
    .map(p=>[p.imageUrl,{sha256:'a'.repeat(64),contentType:'image/svg+xml',eligibleUntil:null}]));
  const old=await exportRuntimeCatalog({snapshot:f.input.revision.snapshot,releaseId:f.seal.publication.releaseId,sourceCodeSha:f.authority.request.codeSha,assets,store,registerFinite:async()=>{}});
  f.sql.prepare('INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,owner_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(f.seal.publication.releaseId,f.input.revision.snapshot.catalogRevision,old.dataSha256,f.seal.snapshotSha256,old.publicSnapshotSha256,'{}',f.now().toISOString());
  f.sql.prepare('INSERT INTO catalog_runtime_head(singleton,release_id,version,enabled) VALUES(1,?,1,1)').run(f.seal.publication.releaseId);
  const approval={schemaVersion:1,runId:'runtime-next',catalogRevision:'runtime-next',changes:[]},previous=f.input.revision.snapshot;
  const request={scope,codeSha:'6'.repeat(40),previous,predecessor:f.seal,approval,approvalSha256:sha256(canonicalJson(approval)),
    context:{envelopeSha256:sha256(JSON.stringify(createSealedSnapshotEnvelope(previous))+'\n'),snapshotSha256:f.seal.snapshotSha256,
      projectionSha256:f.seal.projectionReceipt.projection_sha256,sourceExportSha256:f.seal.projectionReceipt.source_export_sha256,
      vectorSyncWatermark:f.input.revision.vectorSyncWatermark,publicationReceiptWatermark:f.authority.publicationReceiptWatermark,
      priorPublication:f.seal.publication,cutoff:new Date(f.now().getTime()+3600000).toISOString()}};
  const claim=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'runtime-next',operationKey:approvedCohortOperationKey(request)});
  const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,owner:claim,request,adapters:f.adapters});
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner:prepared.owner,revision:prepared.revision,adapters:f.adapters});
  const products=canonicalJson(f.sql.prepare('SELECT * FROM products ORDER BY id').all()),native=canonicalJson([...f.index]);
  const summary={counts:{refresh:{attempted:0,updated:0}},timingsMs:{},usage:{},warnings:[]};
  let cp={sha256:'0'.repeat(64),checkpoint:{phase:'publishing',owner:queued.owner,state:{requestId:queued.requestId},pins:{},phaseComplete:{sha256:'1'.repeat(64),reference:'summary'},control:{}}},crash=loss==='checkpoint-ack';
  const workspace={async readCheckpoint(){return structuredClone(cp);},async readArtifact(){return summary;},async writeCheckpoint(expected,value){
    assert.equal(expected,cp.sha256);if(crash&&value.control.runtimeCatalog.stage==='published'){crash=false;throw Error('synthetic checkpoint lost');}
    cp={sha256:sha256(canonicalJson(value)),checkpoint:value};return structuredClone(cp);}};
  let lost=loss==='commit-ack',commits=0;
  const db={...f.db,prepare:f.db.prepare.bind(f.db),async batch(statements){const result=await f.db.batch(statements);
    if(f.sql.prepare('SELECT 1 FROM catalog_runtime_publications WHERE release_id=?').get('runtime-next')){
      commits++;if(lost){lost=false;throw Error('synthetic committed ACK loss');}}
    return result;}};
  const config={releaseId:'runtime-next',codeSha:request.codeSha,prior:{releaseId:f.seal.publication.releaseId},
    runtimeCatalog:{schemaVersion:1,previousReleaseId:f.seal.publication.releaseId,previousDataSha256:old.dataSha256,homepageRevision:0}};
  const input={db,owner:queued.owner,revision:prepared.revision,requestId:queued.requestId,runReference:'runtime-next',config,configSha256:'f'.repeat(64),workspace,store,now:f.now};
  if(loss==='checkpoint-ack')await assert.rejects(publishRuntimeCatalog(input),/synthetic checkpoint/);
  else{const result=await publishRuntimeCatalog(input);assert.equal(result.state,'published');}
  assert.equal(commits,1,'Only the one data transaction commits');
  const control=cp.checkpoint.control.runtimeCatalog,handoff=await readAcceptedRuntimeHandoff(db,store,control);
  assert.equal(handoff.seal.publication.releaseId,'runtime-next');
  const live=f.sql.prepare('SELECT * FROM catalog_runtime_head').get();assert.equal(live.release_id,'runtime-next');assert.equal(live.version,2);
  const build=f.sql.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').get(queued.requestId);
  assert.equal(build.state,'resolved');assert.equal(build.version_reference,null);assert.match(build.dispatch_reference,/^runtime:[a-f0-9]{64}$/);
  const owner=f.sql.prepare('SELECT phase,external_pending FROM catalog_mutation_scopes').get();assert.equal(owner.phase,'idle');assert.equal(owner.external_pending,0);
  assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM products ORDER BY id').all()),products);assert.equal(canonicalJson([...f.index]),native);
  const seal=await createPublishedApprovedCatalogSeal(db,prepared.revision,handoff.seal.publication);assert.equal(canonicalJson(seal),canonicalJson(handoff.seal));
  assert.ok(puts.every(key=>key.startsWith('public-')||key.startsWith('runtime-handoffs/')));
});

test('accepted published reader rejects actual public, native anchor and genuine receipt drift',async t=>{
  const f=await fixture(t),revision=f.input.revision.snapshot.catalogRevision;
  f.sql.exec('DROP TRIGGER catalog_public_immutable');
  const row=f.sql.prepare('SELECT description FROM catalog_public_products WHERE catalog_revision=? AND public_id=?').get(revision,uuid(1));
  f.sql.prepare("UPDATE catalog_public_products SET description='public drift' WHERE catalog_revision=? AND public_id=?").run(revision,uuid(1));
  await assert.rejects(f.read());
  f.sql.prepare('UPDATE catalog_public_products SET description=? WHERE catalog_revision=? AND public_id=?').run(row.description,revision,uuid(1));
  const id=f.input.revision.nativeHistory[0].source.deliveryId,native=f.sql.prepare('SELECT evidence_json FROM catalog_vector_deliveries WHERE delivery_id=?').get(id);
  f.sql.exec('DROP TRIGGER catalog_vector_delivery_complete_immutable');
  f.sql.prepare("UPDATE catalog_vector_deliveries SET evidence_json='[]' WHERE delivery_id=?").run(id);await assert.rejects(f.read());
  f.sql.prepare('UPDATE catalog_vector_deliveries SET evidence_json=? WHERE delivery_id=?').run(native.evidence_json,id);
  const receipt=f.sql.prepare('SELECT completed_at FROM publication_receipts WHERE release_id=?').get(f.seal.publication.releaseId);
  f.sql.prepare("UPDATE publication_receipts SET completed_at='2000-01-01T00:00:00.000Z' WHERE release_id=?").run(f.seal.publication.releaseId);
  await assert.rejects(f.read());
  f.sql.prepare('UPDATE publication_receipts SET completed_at=? WHERE release_id=?').run(receipt.completed_at,f.seal.publication.releaseId);f.unchanged();
});

test('same-invocation accepted proof skips full public rows but retains fresh schema, receipt, native and owner checks',async t=>{
  const f=await fixture(t),projectionReads=queries=>queries.filter(q=>q.includes('LEFT JOIN catalog_public_products p')).length;
  const fullStart=f.queryText.length,fullMetrics=f.metrics(),fullTime=performance.now();
  for(let i=0;i<4;i++)await f.read();
  const full={elapsedMs:Math.round(performance.now()-fullTime),requests:f.metrics().requests-fullMetrics.requests,
    publicPageReads:projectionReads(f.queryText.slice(fullStart))};
  const checkStart=f.queryText.length,checkMetrics=f.metrics(),checkTime=performance.now();
  for(let i=0;i<4;i++)await recheckAcceptedCodeOnlyCatalog({db:f.db,owner:f.owner,input:f.input,runReference:'code-only'});
  const repeated=f.queryText.slice(checkStart),checked={elapsedMs:Math.round(performance.now()-checkTime),requests:f.metrics().requests-checkMetrics.requests,
    publicPageReads:projectionReads(repeated)};
  assert.equal(full.publicPageReads,4);assert.equal(checked.publicPageReads,0);
  assert.ok(repeated.some(q=>q.includes('sqlite_master')));assert.ok(repeated.some(q=>q.includes('count(*) n FROM catalog_public_products')));
  assert.ok(repeated.some(q=>q.includes('FROM catalog_vector_deliveries')));assert.ok(repeated.some(q=>q.includes('FROM publication_receipts')));
  assert.ok(repeated.some(q=>q.includes('vector_sync_outbox')));assert.ok(repeated.some(q=>q.includes('mutation_fenced')));
  assert.ok(checked.requests<full.requests);f.unchanged();
  t.diagnostic(JSON.stringify({localFixture:true,identities:32,boundaries:4,full,checked,supplierCalls:0,modelCalls:0}));
  // Serialization/another client has no process provenance and reauthenticates.
  for(const options of [{input:structuredClone(f.input),db:f.db},{input:f.input,db:{prepare:f.db.prepare.bind(f.db),batch:f.db.batch.bind(f.db)}}]){
    const start=f.queryText.length;await recheckAcceptedCodeOnlyCatalog({...options,owner:f.owner,runReference:'code-only'});
    assert.equal(projectionReads(f.queryText.slice(start)),1);
  }
  f.sql.exec('DROP TRIGGER catalog_public_immutable');
  const unprotectedStart=f.queryText.length;
  for(let i=0;i<2;i++)await recheckAcceptedCodeOnlyCatalog({db:f.db,owner:f.owner,input:f.input,runReference:'code-only'});
  assert.equal(projectionReads(f.queryText.slice(unprotectedStart)),2,'Missing schema protection must retain full-read compatibility, not introduce a new stop');
});

test('same-invocation proof cannot mask source, owner, schema, receipt, pending or native drift',async t=>{
  const cases={
    'caller packet mutation':f=>{f.input.revision.packet.rows[0].description='changed';},
    'owner epoch mutation':f=>{f.owner.epoch++;},
    'owner generation mutation':f=>{f.owner.generation++;},
    'actual owner cursor drift':f=>{f.sql.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run();},
    'authority source mutation':f=>{f.input.authority.request.codeSha='1'.repeat(40);},
    'pending native write':f=>{f.sql.prepare("UPDATE vector_sync_outbox SET status='pending' WHERE sequence=(SELECT max(sequence) FROM vector_sync_outbox)").run();},
    'global watermark drift':f=>{f.sql.prepare('UPDATE vector_sync_outbox SET sequence=sequence+1 WHERE sequence=(SELECT max(sequence) FROM vector_sync_outbox)').run();},
    'catalog receipt drift':f=>{f.sql.prepare("UPDATE publication_receipts SET completed_at='2000-01-01T00:00:00.000Z' WHERE release_id=?").run(f.seal.publication.releaseId);},
    'projection receipt drift':f=>{f.sql.exec('DROP TRIGGER catalog_projection_receipt_immutable');f.sql.prepare('UPDATE catalog_projection_receipts SET projection_sha256=? WHERE catalog_revision=?').run('1'.repeat(64),f.authority.request.sourceRevision);},
    'native journal drift':f=>{f.sql.exec('DROP TRIGGER catalog_vector_delivery_complete_immutable');f.sql.prepare("UPDATE catalog_vector_deliveries SET evidence_json='[]' WHERE delivery_id=?").run(f.input.revision.nativeHistory[0].source.deliveryId);},
    'dropped immutable trigger with changed public field':f=>{f.sql.exec('DROP TRIGGER catalog_public_immutable');f.sql.prepare("UPDATE catalog_public_products SET description='changed' WHERE catalog_revision=? AND public_id=?").run(f.authority.request.sourceRevision,uuid(1));},
    'same-name ineffective trigger with changed public field':f=>{f.sql.exec('DROP TRIGGER catalog_public_immutable; CREATE TRIGGER catalog_public_immutable BEFORE UPDATE ON catalog_public_products BEGIN SELECT 1; END');f.sql.prepare("UPDATE catalog_public_products SET description='changed' WHERE catalog_revision=? AND public_id=?").run(f.authority.request.sourceRevision,uuid(1));},
    'deleted public row':f=>{f.sql.prepare('DELETE FROM catalog_public_products WHERE catalog_revision=? AND public_id=?').run(f.authority.request.sourceRevision,uuid(1));},
  };
  for(const [name,change]of Object.entries(cases))await t.test(name,async t=>{
    const f=await fixture(t);change(f);
    await assert.rejects(recheckAcceptedCodeOnlyCatalog({db:f.db,owner:f.owner,input:f.input,runReference:'code-only'}));
  });
});

test('observed serving reconciliation retains expired original claims and rejects identity or accepted-state drift',async t=>{
  for(const fault of [null,'version','marker','public','receipt','native','owner','late-owner','token'])await t.test(fault??'exact already-live target',async t=>{
    const f=await fixture(t),r=f.input.revision,queued=await enqueueBuildRequest(f.db,f.authority.request),
      build=await claimBuildRequest(f.db,queued.requestId,'observed-serving',f.now()),version=uuid(430),marker='catalog-observed-activate',
      intent={releaseId:'observed-serving',catalogRevision:r.snapshot.catalogRevision,codeSha:f.authority.request.codeSha,
        catalogSnapshotSha256:f.seal.snapshotSha256,manifestSha256:'b'.repeat(64),vectorSyncWatermark:r.vectorSyncWatermark,
        priorReleaseId:f.seal.publication.releaseId,nextExpiry:null};
    const queryStart=f.queryText.length;
    await enqueuePublication(f.db,r.snapshot,intent,f.now(),f.authority);
    const publication=await claimPublication(f.db,r.snapshot,intent.releaseId,f.now(),600_000,f.authority);
    assert.ok(!f.queryText.slice(queryStart).some(sql=>/SELECT public_display_json FROM catalog_public_products/i.test(sql)),
      'accepted authority enqueue/claim must not rescan every public row');
    f.advance(11*60_000);let retained;
    if(fault==='public'){f.sql.exec('DROP TRIGGER catalog_public_immutable');
      f.sql.prepare("UPDATE catalog_public_products SET description='changed public' WHERE catalog_revision=? AND public_id=?").run(r.snapshot.catalogRevision,uuid(1));}
    if(fault==='receipt')f.sql.prepare("UPDATE publication_receipts SET completed_at='2000-01-01T00:00:00.000Z' WHERE release_id=?").run(f.seal.publication.releaseId);
    if(fault==='native'){f.sql.exec('DROP TRIGGER catalog_vector_delivery_complete_immutable');
      f.sql.prepare("UPDATE catalog_vector_deliveries SET evidence_json='[]' WHERE delivery_id=?").run(r.nativeHistory[0].source.deliveryId);}
    if(fault==='owner')f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1');
    if(fault==='token')f.sql.prepare('UPDATE catalog_build_requests SET lease_token=? WHERE request_id=?').run(uuid(431),queued.requestId);
    const reconcile=()=>reconcileObservedServingActivation(f.db,build,publication,r,f.authority,f.owner,version,marker,async()=>({
      environment:scope.environment,settled:true,active:{...intent,versionReference:fault==='version'?uuid(432):version},
      deploymentId:uuid(433),marker:fault==='marker'?'foreign-marker':marker}),async observation=>{
        await f.read();retained=observation;
        if(fault==='late-owner')f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1');
      },f.now());
    if(fault){await assert.rejects(reconcile());assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests WHERE request_id=?').get(queued.requestId).state,'building');
      assert.equal(f.sql.prepare('SELECT state FROM publication_outbox WHERE release_id=?').get(intent.releaseId).state,'claimed');return;}
    const result=await reconcile();assert.equal(retained.kind,'observed-serving-activation');assert.equal(result.observation.deploymentId,uuid(433));
    assert.equal(result.permit.token,build.token);assert.deepEqual(result.permit.mutationOwner,{...f.owner,phase:'activating'});
    const recorded=f.sql.prepare('SELECT * FROM publication_outbox WHERE release_id=?').get(intent.releaseId);
    assert.equal(recorded.lease_token,publication.token);assert.equal(recorded.lease_until,publication.leaseUntil);assert.equal(recorded.attempts,1);
    await completeActivatedServingPublication(f.db,r,publication,result.permit,f.authority,async()=>{await f.read(result.permit.mutationOwner);return intent;},f.now);
    assert.equal(await resolveBuildActivation(f.db,result.permit,async()=>({environment:scope.environment,settled:true,active:{...intent,versionReference:version}}),
      {acceptedCatalog:f.authority}),'resolved');f.unchanged();
    assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
  });
});

test('mixed accepted catalog preserves original finite overlays, permanent fallbacks and completion authority',async t=>{
  const f=await fixture(t,{mixed:true}),r=f.input.revision,original=canonicalJson(r.snapshot),
    overlays=r.snapshot.products.filter(p=>p.eligibleUntil!==null);
  assert.ok(overlays.length>0);assert.ok(r.snapshot.products.some(p=>p.eligibleUntil===null));
  assert.ok(overlays.every(p=>p.persistent?.eligibleUntil===null));
  assert.equal(earliestDisplayExpiry(r.snapshot.products),null);assertAcceptedCodeOnlyBinding(f.input);
  const queued=await enqueueBuildRequest(f.db,f.authority.request),build=await claimBuildRequest(f.db,queued.requestId,'mixed-code',f.now()),
    intent={releaseId:'mixed-code',catalogRevision:r.snapshot.catalogRevision,codeSha:f.authority.request.codeSha,
      catalogSnapshotSha256:f.seal.snapshotSha256,manifestSha256:'b'.repeat(64),vectorSyncWatermark:r.vectorSyncWatermark,
      priorReleaseId:f.seal.publication.releaseId,nextExpiry:earliestDisplayExpiry(r.snapshot.products)};
  await enqueuePublication(f.db,r.snapshot,intent,f.now());const publication=await claimPublication(f.db,r.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,r.snapshot,publication,'version:mixed-version',f.now());
  const permit=await beginBuildActivation(f.db,build,r.snapshot,publication,'mixed-version',async()=>({environment:scope.environment,settled:true,
    active:{...f.accepted.intent,versionReference:f.accepted.versionReference}}),f.now(),f.owner);
  await assert.rejects(completeActivatedServingPublication(f.db,r,{...publication,intent:{...intent,nextExpiry:overlays[0].eligibleUntil}},permit,
    f.authority,async()=>intent,f.now),/serving_publication_fenced/);
  await completeActivatedServingPublication(f.db,r,publication,permit,f.authority,async()=>{await f.read(permit.mutationOwner);return intent;},f.now);
  assert.equal(await resolveBuildActivation(f.db,permit,async()=>({environment:scope.environment,settled:true,active:{...intent,versionReference:'mixed-version'}}),
    {acceptedCatalog:f.authority}),'resolved');f.unchanged();assert.equal(canonicalJson(r.snapshot),original);
  for(const p of overlays)assert.equal(resolvePublicProduct(p,Date.parse(p.eligibleUntil)),p.persistent??null);
});

test('serving completion and uncertain activation resolution preserve latest catalog receipt and accepted pointer',async t=>{
  const f=await fixture(t),r=f.input.revision,queued=await enqueueBuildRequest(f.db,f.authority.request);
  const build=await claimBuildRequest(f.db,queued.requestId,'code-only',f.now());
  const intent={releaseId:'serving-code-only',catalogRevision:r.snapshot.catalogRevision,codeSha:f.authority.request.codeSha,
    catalogSnapshotSha256:f.seal.snapshotSha256,manifestSha256:'b'.repeat(64),vectorSyncWatermark:r.vectorSyncWatermark,
    priorReleaseId:f.seal.publication.releaseId,nextExpiry:null};
  await enqueuePublication(f.db,r.snapshot,intent,f.now());const publication=await claimPublication(f.db,r.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,r.snapshot,publication,'version:serving-version',f.now());
  const permit=await beginBuildActivation(f.db,build,r.snapshot,publication,'serving-version',
    async()=>({environment:scope.environment,settled:true,active:{...f.accepted.intent,versionReference:f.accepted.versionReference}}),f.now(),f.owner);
  assert.equal((await servingPublicationStatus(f.db,intent.releaseId,f.authority)).state,'dispatched');
  await completeActivatedServingPublication(f.db,r,publication,permit,f.authority,async()=>{await f.read(permit.mutationOwner);return intent;},f.now);
  assert.equal((await servingPublicationStatus(f.db,intent.releaseId,f.authority)).state,'published');f.unchanged();
  assert.equal(f.sql.prepare('SELECT release_id FROM publication_receipts ORDER BY rowid DESC LIMIT 1').get().release_id,f.seal.publication.releaseId);
  await assert.rejects(resolveBuildActivation(f.db,permit,async()=>{throw Error('synthetic lost provider read');},{acceptedCatalog:f.authority}));
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'activating');
  assert.equal(await resolveBuildActivation(f.db,permit,async()=>({environment:scope.environment,settled:true,active:{...intent,versionReference:'serving-version'}})),'awaiting_receipt');
  assert.equal(await resolveBuildActivation(f.db,permit,async()=>{await f.read(permit.mutationOwner);return{
    environment:scope.environment,settled:true,active:{...intent,versionReference:'serving-version'}};},{acceptedCatalog:f.authority}),'resolved');
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');f.unchanged();
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests WHERE request_id=?').get(queued.requestId).state,'resolved');
});

test('ordinary catalog successor accepts skipped code-only ownership generation without replacing prior authority',async t=>{
  for(const changed of [false,true])await t.test(changed?'one genuine journaled product change':'unchanged refresh cohort',async t=>{
    const f=await fixture(t),r=f.input.revision,oldSeal=canonicalJson(f.seal),oldGeneration=f.seal.persistent.generation,
      request=await enqueueBuildRequest(f.db,f.authority.request),build=await claimBuildRequest(f.db,request.requestId,'code-only',f.now());
    const intent={releaseId:'serving-before-successor',catalogRevision:r.snapshot.catalogRevision,codeSha:f.authority.request.codeSha,
      catalogSnapshotSha256:f.seal.snapshotSha256,manifestSha256:'b'.repeat(64),vectorSyncWatermark:r.vectorSyncWatermark,
      priorReleaseId:f.seal.publication.releaseId,nextExpiry:null};
    await enqueuePublication(f.db,r.snapshot,intent,f.now());const publication=await claimPublication(f.db,r.snapshot,intent.releaseId,f.now());
    await recordPublicationDispatch(f.db,r.snapshot,publication,'version:'+uuid(420),f.now());
    const permit=await beginBuildActivation(f.db,build,r.snapshot,publication,uuid(420),async()=>({environment:scope.environment,settled:true,
      active:{...f.accepted.intent,versionReference:f.accepted.versionReference}}),f.now(),f.owner);
    await completeActivatedServingPublication(f.db,r,publication,permit,f.authority,async()=>intent,f.now);
    const serving={releaseId:intent.releaseId,codeSha:intent.codeSha,catalogRevision:intent.catalogRevision,
      catalogSnapshotSha256:intent.catalogSnapshotSha256,manifestSha256:intent.manifestSha256,versionReference:uuid(420)};
    assert.equal(await resolveBuildActivation(f.db,permit,async()=>({environment:scope.environment,settled:true,active:serving}),{acceptedCatalog:f.authority}),'resolved');
    f.unchanged();assert.equal(f.owner.generation,oldGeneration+1);

    f.advance(1000);const name='ordinary-after-code',writing=await claimMutationOwnership(f.db,scope,{phase:'writing',ownerReference:name,operationKey:sha256(name)}),
      cursor={current:writing},context={envelopeSha256:sha256(f.seal.envelopeJson+'\n'),snapshotSha256:f.seal.snapshotSha256,
        projectionSha256:f.seal.projectionReceipt.projection_sha256,sourceExportSha256:f.seal.projectionReceipt.source_export_sha256,
        vectorSyncWatermark:r.vectorSyncWatermark,publicationReceiptWatermark:f.authority.publicationReceiptWatermark,
        priorPublication:f.seal.publication,cutoff:new Date(f.now().getTime()+3600000).toISOString()},
      previous=await readApprovedPrior(f.db,writing,f.seal,context),changes=[];
    assert.equal(writing.generation,oldGeneration+2);
    if(changed){
      const store=createD1CatalogMaintenanceStore({db:f.db,owner:writing,ownerCursor:cursor,runId:name,catalogRevision:name,preservePermanentListings:true,
        intent:()=>({reviewedDeleteReference:'LOCAL exact duplicate review; no supplier/model observation'})});
      // A real maintenance operation proves the generation-linked change path;
      // an arbitrary SQL edit would still be refused by the prior seal reader.
      await store.markCatalogDuplicate('B000000032','B000000001','LOCAL verified duplicate design');
      const row={...f.sql.prepare('SELECT * FROM products WHERE id=?').get('B000000032')},op=f.sql.prepare('SELECT * FROM catalog_maintenance_operations WHERE run_id=? ORDER BY next_epoch DESC LIMIT 1').get(name);
      assert.equal(op.generation,oldGeneration+2);
      changes.push({publicId:row.public_id,operationId:op.operation_id,inputSha256:op.input_sha256,productSha256:sha256(canonicalJson(row)),displaySha256:sha256(row.public_display_json??'null')});
    }
    await releaseMutationOwnership(f.db,cursor.current);
    const approval={schemaVersion:1,runId:name,catalogRevision:name,changes},nextRequest={scope,codeSha:'9'.repeat(40),previous,predecessor:f.seal,context,
      approval,approvalSha256:sha256(canonicalJson(approval))},freezing=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:name,operationKey:approvedCohortOperationKey(nextRequest)});
    assert.equal(freezing.generation,oldGeneration+3);
    const prepared=await prepareOwnedApprovedCohortPlan({db:f.db,owner:freezing,request:nextRequest,adapters:f.adapters});
    assert.equal(prepared.revision.persistent.generation,freezing.generation);
    let owner=prepared.owner;
    for(const publicId of prepared.remainingIds){let delivery;
      for(let attempt=0;attempt<3;attempt++){delivery=await deliverOwnedApprovedCohortVector({db:f.db,owner,revision:prepared.revision,publicId,adapters:f.adapters});
        owner=delivery.owner;if(delivery.state==='complete')break;}
      assert.equal(delivery.state,'complete');
    }
    const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner,revision:prepared.revision,adapters:f.adapters}),
      accepted=await f.publishCatalog(prepared.revision,queued,name,{...f.accepted.intent,versionReference:f.accepted.versionReference},uuid(421),false,serving),
      successor=await createPublishedApprovedCatalogSeal(f.db,prepared.revision,accepted.publication);
    assert.equal(successor.persistent.generation,oldGeneration+3);assert.equal(successor.publication.releaseId,name);
    assert.equal(f.sql.prepare('SELECT release_id FROM publication_receipts ORDER BY rowid DESC LIMIT 1').get().release_id,name);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts WHERE release_id=?').get(intent.releaseId).n,0);
    assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
    assert.equal(f.sql.prepare('SELECT count(*) n FROM products').get().n,32);assert.equal(canonicalJson(f.seal),oldSeal);
  });
});

// Real publisher/control/accounting/upload-bridge composition; only external
// provider HTTP, process execution and generated output are LOCAL fixtures.
for(const externallyPromoted of [false,true])test(`actual mixed serving-only publisher ${externallyPromoted?'reconciles observed external promotion':'resumes uncertain activation'} with one upload and no catalog receipt`,{skip:process.platform!=='darwin'},async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'accepted-code-only-'))),sourceRoot=path.join(directory,'source');
  let workspace;t.after(async()=>{await workspace?.close();await fs.rm(directory,{recursive:true,force:true});});
  await fs.mkdir(sourceRoot,{mode:0o700});
  const put=async(file,bytes)=>{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{mode:0o600});};
  const git=(...args)=>execFileSync('git',args,{cwd:sourceRoot,encoding:'utf8',env:{PATH:process.env.PATH,HOME:directory,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  git('init','-q');await put(path.join(sourceRoot,'.gitignore'),'build/\nstatic-site/out/\n');git('add','.gitignore');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Owned serving fixture');
  const codeSha=git('rev-parse','HEAD'),f=await fixture(t,{codeSha,mixed:true}),r=f.input.revision,version=uuid(410),deployment=uuid(411);
  // Serving code can already be newer than the genuine catalog publication.
  // It has no catalog receipt and must remain a separate deployment identity.
  const servingPrior={releaseId:'prior-code-only',codeSha:'d'.repeat(40),catalogRevision:f.accepted.intent.catalogRevision,
    catalogSnapshotSha256:f.accepted.intent.catalogSnapshotSha256,manifestSha256:'e'.repeat(64),versionReference:uuid(409)};
  const config={schemaVersion:1,...scope,accountId:f.accountId,workerName:'accepted-fixture-worker',database:{id:f.databaseId,name:'accepted-fixture-db'},
    codeSha,sourceMode:'preview',sourceRoot,releaseId:'serving-code-only',identityOrigin:'https://accepted-fixture.example.invalid',compatibilityDate:'2026-10-20',
    prior:{directory:null,manifestSha256:f.accepted.intent.manifestSha256,releaseId:f.accepted.intent.releaseId,versionReference:f.accepted.versionReference},
    servingPrior,
    acceptedCatalog:{...f.seal.publication,sealSha256:f.authority.sealSha256}};
  const until=new Date(f.now().getTime()+24*3600000).toISOString(),wsOptions={directory:path.join(directory,'private'),repository:sourceRoot,mode:'create',
    runId:config.releaseId,codeSha,configSha256:sha256(canonicalJson(config)),scope:{...scope,accountId:f.accountId,databaseId:f.databaseId,databaseName:config.database.name,workerName:config.workerName},
    retention:{reviewReference:'test-only/original-window',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
      .map(kind=>[kind,{maxAgeMs:24*3600000,notAfter:until}]))},budgetCaps:{httpRequests:5000,sqlStatements:12000},now:()=>f.now().toISOString()};
  workspace=await openRunWorkspace(wsOptions);
  const counts={uploads:0,activations:0,builds:0,nativeWrites:0};let uploaded=false,active=false,uploadedConfig,identityFailure=!externallyPromoted,
    loseResolve=false,interruptDispatch=externallyPromoted,loseObservedCas=externallyPromoted,observedCas=0,
    publicPageReads=0,poisonBuild=!externallyPromoted;
  const pendingVector=f.sql.prepare('SELECT sequence,status FROM vector_sync_outbox LIMIT 1').get();
  const response=result=>Response.json({success:true,result}),checkpoint=async()=>(await workspace.readCheckpoint({controlOnly:true})).checkpoint;
  const base=`https://api.cloudflare.com/client/v4/accounts/${f.accountId}`,worker=`${base}/workers/scripts/${config.workerName}`;
  const raw=async(url,init={})=>{init.signal?.throwIfAborted();const u=new URL(url);
    if(url===`${base}/d1/database/${f.databaseId}`)return response({uuid:f.databaseId,name:config.database.name,read_replication:{mode:'disabled'}});
    if(url===`${base}/d1/database/${f.databaseId}/query`){const batch=JSON.parse(init.body).batch,result=[];
      if(interruptDispatch&&batch.some(q=>q.sql.startsWith("UPDATE publication_outbox SET state='dispatched'"))){interruptDispatch=false;throw Error('Synthetic interrupted coordinator before dispatch');}
      f.sql.exec('BEGIN');
      try{for(const q of batch){if(q.sql.includes('LEFT JOIN catalog_public_products p'))publicPageReads++;
        const before=f.sql.prepare('SELECT total_changes() n').get().n,rows=f.sql.prepare(q.sql).all(...q.params).map(row=>({...row}));
        const changes=f.sql.prepare('SELECT total_changes() n').get().n-before;
        result.push({success:true,results:rows,meta:{served_by_primary:true,rows_read:rows.length,rows_written:changes,changes}});}f.sql.exec('COMMIT');}
      catch(error){f.sql.exec('ROLLBACK');throw error;}
      if(externallyPromoted&&batch.some(q=>q.sql.startsWith("UPDATE catalog_mutation_scopes SET phase='activating'"))){observedCas++;
        if(loseObservedCas){loseObservedCas=false;throw Error('Synthetic committed observed-activation acknowledgement lost');}}
      if(loseResolve&&batch.some(q=>q.sql.startsWith("UPDATE catalog_build_requests SET state='resolved'"))){loseResolve=false;throw Error('Synthetic committed resolve acknowledgement lost');}
      return response(result);}
    if(u.origin===config.identityOrigin){if(active&&identityFailure){identityFailure=false;throw Error('Synthetic lost activation read acknowledgement');}
      const intent=active?(await checkpoint()).control.publication.intent:servingPrior;
      return Response.json({release_id:intent.releaseId,code_sha:intent.codeSha,catalog_revision:intent.catalogRevision,
        catalog_snapshot_sha256:intent.catalogSnapshotSha256,manifest_sha256:intent.manifestSha256});}
    if(url===`${base}/vectorize/v2/indexes/${scope.indexName}`)return response({name:scope.indexName,config:{dimensions:1536,metric:'cosine'}});
    if(u.pathname.endsWith('/get_by_ids'))assert.fail('Serving-only publication reuses authenticated native proof without downloading vectors');
    if(u.pathname.includes('/vectorize/')){counts.nativeWrites++;assert.fail('Serving-only publication may not mutate native vectors');}
    const c=(await checkpoint())?.control?.publication;
    if(url===`${worker}/assets-upload-session`||u.pathname===`/client/v4/accounts/${f.accountId}/workers/assets/upload`)return response({jwt:'fixture-only',buckets:[]});
    if(u.pathname.endsWith('/versions')&&init.method==='POST'){uploaded=true;return response({id:version});}
    if(u.pathname.endsWith('/versions'))return response({items:uploaded?[{id:version}]:[]});
    if(url===`${worker}/versions/${version}`)return response({id:version,annotations:{'workers/tag':c.uploadMarker,'workers/message':`package:${c.packageSha256}`},
      resources:{script_runtime:{compatibility_date:config.compatibilityDate},bindings:[{name:'DB',type:'d1',id:f.databaseId},{name:'VECTORIZE',type:'vectorize',index_name:scope.indexName},
        {name:'ASSETS',type:'assets'},{name:'STAGING_AUTH_SECRET',type:'secret_text'},...Object.entries(uploadedConfig.vars).map(([name,text])=>({name,type:'plain_text',text}))]}});
    if(url===`${worker}/deployments`){if(init.method==='POST'){counts.activations++;active=true;return response({id:deployment});}
      return response({deployments:[{id:active?deployment:uuid(412),versions:[{version_id:active?version:servingPrior.versionReference,percentage:100}],
        annotations:{'workers/message':active?c.deploymentMarker:'fixture:accepted'}}]});}assert.fail(`Unexpected local mock route ${u.pathname}`);
  };
  const fetchScope={accountId:f.accountId,workerName:config.workerName,indexName:scope.indexName,databaseId:f.databaseId,identityOrigin:config.identityOrigin};
  const transports=async()=>({db:await createCatalogD1Rest({accountId:f.accountId,databaseId:f.databaseId,databaseName:config.database.name,token:'FIXTURE_ONLY',fetch:raw,
    limits:{requests:5000,statements:12000},accounting:{scope:{accountId:f.accountId,databaseId:f.databaseId,databaseName:config.database.name},initial:await workspace.budget(),
      reserve:input=>workspace.reserveBudget(input),settle:(id,value)=>workspace.settleBudget(id,value)}}),
    fetch:accountedPublicationFetch(workspace,raw,fetchScope),observationFetch:accountedPublicationReadFetch(workspace,raw,fetchScope)});
  let io=await transports();const queued=await enqueueBuildRequest(io.db,f.authority.request);
  await workspace.writeCheckpoint(null,{phase:'freezing',owner:f.owner,state:{driverState:'preserved'},pins:{},phaseComplete:null,control:{}});
  const command=async input=>{if(input.args.includes('scripts/staging/build.mts')){counts.builds++;
      const snapshot=JSON.parse(await fs.readFile(input.env.CATALOG_SNAPSHOT_PATH)),context=JSON.parse(await fs.readFile(input.env.CATALOG_RELEASE_CONTEXT_PATH));
      assert.deepEqual(snapshot,r.snapshot);assert.equal(context.generatedAt,f.authority.observedAt);
      const bytes=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)),pages=['/','/random-gift','/gift-guides','/howie','/preview/presentation',
        ...guides.map(g=>`/gift-guides/${g.slug}`),...snapshot.products.map(p=>`/gifts/${p.slug}`)];
      const assets=new Map(pages.map(p=>[p==='/'?'/index.html':`${p}.html`,bytes('Owned synthetic HTML')]));
      for(const name of ['/safe/catalog.html','/safe/product.html','/safe/howie.html','/safe/presentation.html','/safe/asset.txt'])assets.set(name,bytes('Owned unavailable'));
      assets.set('/safe/catalog.json',bytes(safeCatalogPayload));assets.set('/images/gift-placeholder.svg',bytes('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10"/></svg>'));
      for(const suffix of ['.txt','/__next._full.txt','/__next._tree.txt','/__next.safe.product.__PAGE__.txt'])assets.set(`/safe/product${suffix}`,bytes('Owned safe RSC'));
      for(const shard of createBrowseRelease(snapshot).shards)assets.set(shard.path,bytes(shard.payload));
      const photos=createPhotoRelease(snapshot);if(photos.indexPath)assets.set(photos.indexPath,bytes(photos.index));
      for(const shard of photos.shards)assets.set(shard.path,bytes(shard.payload));
      assets.set('/safe/photos.json',bytes({schemaVersion:1,status:'unavailable'}));
      for(const name of createOgRelease(snapshot,siteIdentityFor(context.sourceMode)).byPath.keys())assets.set(name,bytes('Owned PNG fixture'));
      const assembled=assembleReleaseAssets(snapshot,assets,context,null),rest={...context};delete rest.retainedManifestSha256;
      const manifest={...rest,dataKind:'catalog',siteIdentitySha256:sha256(siteIdentityBytes(context.sourceMode)),nextExpiry:null,
        productCount:snapshot.products.length,slugCount:snapshot.products.length,checksums:Object.fromEntries([...assembled.assets].map(([p,b])=>[p,sha256(b)])),routes:assembled.routes,retention:assembled.retention};
      const manifestBytes=bytes(`${JSON.stringify(manifest,null,2)}\n`),outputs={'asset-manifest.json':manifestBytes,'catalog.snapshot.json':bytes(`${JSON.stringify(snapshot)}\n`),
        'release-context.json':bytes(`${JSON.stringify(context)}\n`),'release-identity.json':bytes(createReleaseIdentity(manifestBytes)),
        'site-identity.json':bytes(siteIdentityBytes(context.sourceMode)),'feed-plan.json':bytes(createStaticFeedPlan(snapshot,context.catalogSnapshotSha256))};
      for(const[name,b]of Object.entries(outputs))await put(path.join(sourceRoot,'build/stupid-gifts',name),b);
      for(const[name,b]of assembled.assets)await put(path.join(sourceRoot,'static-site/out',name.slice(1)),b);
      if(poisonBuild){poisonBuild=false;f.sql.prepare("UPDATE vector_sync_outbox SET status='pending' WHERE sequence=?").run(pendingVector.sequence);}
    }else if(input.args.includes('upload')){counts.uploads++;uploadedConfig=JSON.parse(await fs.readFile(input.args[input.args.indexOf('--config')+1]));
      const endpoint=input.env.CLOUDFLARE_API_BASE_URL;assert.equal(new URL(endpoint).hostname,'127.0.0.1');
      for(const route of [`/accounts/${f.accountId}/workers/scripts/${config.workerName}/assets-upload-session`,`/accounts/${f.accountId}/workers/assets/upload?base64=true`,
        `/accounts/${f.accountId}/workers/scripts/${config.workerName}/versions?bindings_inherit=strict`]){
        const reply=await fetch(`${endpoint}${route}`,{method:'POST',body:'{}'});assert.equal(reply.status,200);await reply.arrayBuffer();}}
  };
  let servingInput=f.input;
  const execute=async(completed=false)=>executePublication({db:io.db,owner:(await checkpoint()).owner,revision:completed?null:r,
    acceptedCatalog:completed?acceptedCodeOnlyControl(f.seal,f.authority):servingInput,requestId:queued.requestId,
    runReference:config.releaseId,workspace,config,credentials:{cloudflareToken:'FIXTURE_ONLY',identityAuthorization:'Basic FIXTURE_ONLY'},dependencies:{fetch:io.fetch,
      observationFetch:io.observationFetch,command:accountedPublicationUploadCommand({workspace,scope:{accountId:f.accountId,workerName:config.workerName},send:raw,command}),now:f.now}});
  const originalTitle=f.sql.prepare('SELECT title FROM products WHERE public_id=?').get(uuid(1)).title;
  const withPrivateDrift=async()=>{
    f.sql.prepare("UPDATE products SET title='unpublished private edit' WHERE public_id=?").run(uuid(1));
    try{const result=await execute();assert.equal(f.sql.prepare('SELECT title FROM products WHERE public_id=?').get(uuid(1)).title,'unpublished private edit');return result;}
    finally{f.sql.prepare('UPDATE products SET title=? WHERE public_id=?').run(originalTitle,uuid(1));}
  };
  const denied=await execute(true);assert.equal(denied.state,'pending');assert.equal(denied.errorCode,'publication_serving_settlement_scope');assert.equal(counts.uploads,0);
  if(!externallyPromoted){
  const stale=await execute();assert.equal(stale.state,'pending');assert.match(stale.errorCode,/^(?:accepted_code_only_source_changed|catalog_d1_result_unknown)$/);
  assert.deepEqual(counts,{uploads:0,activations:0,builds:1,nativeWrites:0});assert.equal(publicPageReads,1);
  f.sql.prepare('UPDATE vector_sync_outbox SET status=? WHERE sequence=?').run(pendingVector.status,pendingVector.sequence);
  servingInput=structuredClone(f.input); // A restored invocation has no process-local provenance.
  }
  const first=await withPrivateDrift();assert.equal(first.state,'pending',JSON.stringify(first));assert.equal(counts.activations,externallyPromoted?0:1,JSON.stringify(first));assert.equal(counts.uploads,1);f.unchanged();
  if(!externallyPromoted)assert.equal(publicPageReads,2,'Each active invocation reads public rows once, never once per activation boundary');
  if(externallyPromoted){active=true;f.advance(11*60_000); // LOCAL separately authorized promotion, not a publisher API call.
    assert.equal((await checkpoint()).control.publication.stage,'uploaded');}
  const expectedManifestSha256=workspace.manifestSha256;await workspace.close();workspace=await openRunWorkspace({...wsOptions,mode:'resume',expectedManifestSha256});io=await transports();
  loseResolve=true;let uncertain=await withPrivateDrift();assert.equal(uncertain.state,'pending',JSON.stringify(uncertain));f.unchanged();
  if(externallyPromoted){assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'activating');
    assert.equal((await checkpoint()).control.publication.stage,'activating'); // Normal CLI can recognize the lost-CAS phase transition.
    uncertain=await withPrivateDrift();assert.equal(uncertain.state,'pending',JSON.stringify(uncertain));assert.equal(observedCas,1);}
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests WHERE request_id=?').get(queued.requestId).state,'resolved');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts WHERE release_id=?').get(config.releaseId).n,0);
  const expectedCounts={uploads:1,activations:externallyPromoted?0:1,builds:1,nativeWrites:0};assert.deepEqual(counts,expectedCounts);
  if(externallyPromoted){const cp=await checkpoint(),pin=cp.pins.publicationObservedActivation;assert.ok(pin);
    const proof=await workspace.readArtifact(pin);assert.equal(proof.observation.kind,'observed-serving-activation');assert.equal(proof.observation.deploymentId,deployment);}
  const manifestAfterResolve=workspace.manifestSha256;await workspace.close();workspace=await openRunWorkspace({...wsOptions,mode:'resume',expectedManifestSha256:manifestAfterResolve});io=await transports();
  assert.equal((await execute(true)).state,'published');assert.deepEqual(counts,expectedCounts);f.unchanged();
});
