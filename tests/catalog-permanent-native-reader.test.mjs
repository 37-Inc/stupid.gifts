import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {permanentCatalogFixture} from './helpers/permanent-catalog-fixture.mjs';
import {scope,uuid} from './helpers/published-vector-fixture.mjs';
import {preparePermanentCatalog,settlePermanentCatalog} from '../lib/catalog/freeze-permanent-catalog.ts';
import {approvedCohortOperationKey,prepareApprovedCohort} from '../lib/catalog/freeze-approved-cohort.ts';
import {durableApprovedRevisionControl,hydrateDurableApprovedRevision} from '../scripts/catalog/approved-catalog-seal.ts';
import {validatePublicationControlArtifact} from '../scripts/catalog/publication-control.ts';
import {claimMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {claimBuildRequest,beginBuildActivation,resolveBuildActivation,permanentPublicationDeadline} from '../lib/catalog/build-requests.ts';
import {enqueuePublication,claimPublication,recordPublicationDispatch,completePublication,completeActivatedApprovedCatalogPublication} from '../lib/catalog/publication.ts';
import {prunedVectorPlan,prunedVectorIds} from '../lib/catalog/prune-existing-revision.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {createPermanentCatalogSeal,assertApprovedCatalogInventory} from '../scripts/catalog/permanent-catalog-seal.ts';
import {createSealedSnapshotEnvelope,readApprovedCurrentRows} from '../scripts/catalog/export-d1-snapshot.ts';
import {prepareOwnedApprovedCohortPlan,readOwnedApprovedCohortVectors,readOwnedPermanentCohortNative,readActivatedCatalogVectors,
  approvedCatalogPlanChecks,readHistoricalNativePreservation,readNativeHistory} from '../scripts/catalog/owned-vector-delivery.ts';
import {settleOwnedApprovedCohortVectorProof} from '../scripts/catalog/owned-vector-delivery.ts';

async function fixture(t,{publicationRevision}={}){
  const f=await permanentCatalogFixture(t,{afterExpiry:true}),prepared=await preparePermanentCatalog(f.db,f.owner,f.request),initial=prepared.revision;
  const queued=await settlePermanentCatalog(f.db,prepared.owner,initial,f.adapters),build=await claimBuildRequest(f.db,queued.requestId,'native-test',f.now());
  const intent={releaseId:'native-initial',catalogRevision:initial.snapshot.catalogRevision,codeSha:initial.request.codeSha,
    catalogSnapshotSha256:initial.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:initial.vectorSyncWatermark,
    priorReleaseId:f.original.intent.releaseId,nextExpiry:null};
  await enqueuePublication(f.db,initial.snapshot,intent,f.now());const publication=await claimPublication(f.db,initial.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,initial.snapshot,publication,'version:native-initial-version',f.now());
  const permit=await beginBuildActivation(f.db,build,initial.snapshot,publication,'native-initial-version',
    async()=>({environment:scope.environment,settled:true,active:{...f.original.intent,versionReference:f.original.permit.versionReference}}),f.now(),queued.owner);
  const plan=prunedVectorPlan(initial),read=()=>readActivatedCatalogVectors(f.db,permit,{catalogRevision:plan.catalogRevision,
    planSha256:sha256(canonicalJson(plan)),ids:prunedVectorIds(plan)},f.adapters,{permanent:initial});
  await completePublication(f.db,initial.snapshot,intent.releaseId,publication.token,async()=>{await read();return intent;},f.now,permit.mutationOwner);
  await resolveBuildActivation(f.db,permit,async()=>{await read();return{environment:scope.environment,settled:true,active:{...intent,versionReference:'native-initial-version'}};});
  const receipt={...f.sql.prepare('SELECT * FROM publication_receipts WHERE release_id=?').get(intent.releaseId)},predecessor=createPermanentCatalogSeal(initial,
    {releaseId:intent.releaseId,receiptSha256:sha256(canonicalJson(receipt))});
  const approval={schemaVersion:1,runId:'native-current',catalogRevision:'native-current',changes:[]},request={scope,codeSha:'7'.repeat(40),previous:initial.snapshot,
    predecessor,approval,approvalSha256:sha256(canonicalJson(approval)),context:{envelopeSha256:sha256(JSON.stringify(createSealedSnapshotEnvelope(initial.snapshot))+'\n'),
      snapshotSha256:initial.packet.receipt.snapshot_sha256,projectionSha256:initial.packet.receipt.projection_sha256,
      sourceExportSha256:initial.sourceDigest,vectorSyncWatermark:initial.vectorSyncWatermark,
      publicationReceiptWatermark:f.sql.prepare('SELECT max(rowid) n FROM publication_receipts').get().n,
      priorPublication:predecessor.publication,cutoff:new Date(f.now().getTime()+60000).toISOString()}};
  if(publicationRevision)request.publicationRevision=publicationRevision;
  const owner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:approval.runId,operationKey:approvedCohortOperationKey(request)});
  const current=await prepareOwnedApprovedCohortPlan({db:f.db,owner,request,adapters:f.adapters});
  assert.ok(current.revision.persistent);assert.ok(current.revision.snapshot.products.every(p=>p.eligibleUntil===null));
  return{...f,...current};
}

test('sealed permanent publication resumes after runner cutoff with body-free controls and unchanged source/owner',async t=>{
  const f=await fixture(t),r=f.revision,control=durableApprovedRevisionControl(r),before=f.dispatches();
  validatePublicationControlArtifact({schemaVersion:1,kind:'revision',value:control});
  assert.equal(control.revision.snapshot,undefined);assert.equal(control.revision.packet,undefined);
  assert.equal(control.sourceRows,undefined);
  f.advance(120000);
  assert.deepEqual(await hydrateDurableApprovedRevision(f.db,f.owner,control),r);
  const rebuilt=await prepareApprovedCohort(f.db,f.owner,r.request);
  assert.deepEqual(rebuilt.revision,r);assert.deepEqual(rebuilt.owner,f.owner);
  const queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner:f.owner,revision:r,adapters:f.adapters});
  assert.ok(queued.requestId);assert.equal(f.dispatches(),before);
  assert.equal(r.request.context.cutoff,control.request.request.context.cutoff);
  await assert.rejects(hydrateDurableApprovedRevision(f.db,queued.owner,{...control,revisionSha256:'0'.repeat(64)}));
});

test('publication-only policy preserves genuine historical native members without granting new native effects',async t=>{
  const f=await fixture(t,{publicationRevision:'native-recovery'}),plan=prunedVectorPlan(f.revision);
  assert.equal(f.revision.request.approval.catalogRevision,'native-current');
  assert.equal(plan.catalogRevision,'native-recovery');
  assert.ok(prunedVectorIds(plan).length>0);assert.equal(plan.products.length,0);assert.equal(plan.absentIds.length,0);
  const before=canonicalJson([...f.index]),dispatches=f.dispatches();
  assert.equal((await readOwnedPermanentCohortNative(f.db,f.owner,f.revision,f.adapters)).settled,true);
  assert.equal(canonicalJson([...f.index]),before);assert.equal(f.dispatches(),dispatches);
});

test('approved permanent continuation reclaims an expired build and publishes without renewing original inputs',async t=>{
  const f=await fixture(t,{publicationRevision:'permanent-recovery'}),r=f.revision,queued=await settleOwnedApprovedCohortVectorProof({db:f.db,owner:f.owner,revision:r,adapters:f.adapters});
  const old=await claimBuildRequest(f.db,queued.requestId,'permanent-continuation',f.now()),original=canonicalJson(old.request);
  f.advance(60001);
  const authority={approvalReference:'a'.repeat(64),approvedAt:f.now().toISOString(),publicationUntil:new Date(f.now().getTime()+7200000).toISOString()};
  assert.equal(await permanentPublicationDeadline(old.request,r.snapshot,authority,f.now()),authority.publicationUntil);
  for(const patch of [{approvalReference:'unapproved'},{approvedAt:new Date(f.now().getTime()+1).toISOString()},
    {publicationUntil:new Date(f.now().getTime()+7200001).toISOString()}])
    await assert.rejects(permanentPublicationDeadline(old.request,r.snapshot,{...authority,...patch},f.now()));
  const finite=structuredClone(r.snapshot);finite.products[0].eligibleUntil=authority.publicationUntil;
  await assert.rejects(permanentPublicationDeadline(old.request,finite,authority,f.now()));
  await assert.rejects(claimBuildRequest(f.db,old.requestId,old.runReference,f.now(),900000,
    {authority,snapshot:r.snapshot,owner:{...queued.owner,epoch:queued.owner.epoch+1}}));
  assert.equal(f.sql.prepare('SELECT lease_token FROM catalog_build_requests WHERE request_id=?').get(old.requestId).lease_token,old.token);
  const build=await claimBuildRequest(f.db,old.requestId,old.runReference,f.now(),900000,{authority,snapshot:r.snapshot,owner:queued.owner});
  assert.ok(build);assert.notEqual(build.token,old.token);assert.ok(build.leaseUntil>old.request.cutoff);
  assert.equal(canonicalJson(build.request),original);
  const intent={releaseId:'continued-permanent',catalogRevision:r.snapshot.catalogRevision,codeSha:r.request.codeSha,
    catalogSnapshotSha256:r.packet.receipt.snapshot_sha256,manifestSha256:'c'.repeat(64),vectorSyncWatermark:r.vectorSyncWatermark,
    priorReleaseId:build.request.priorReleaseId,nextExpiry:null};
  await enqueuePublication(f.db,r.snapshot,intent,f.now());const publication=await claimPublication(f.db,r.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,r.snapshot,publication,'version:continued-version',f.now());
  // An acknowledged upload may outlive both leases. Normal activation remains
  // fenced; a separately authorized exact permanent finish changes no tokens.
  f.advance(16*60000);const attempt=f.sql.prepare('SELECT attempts FROM catalog_build_requests WHERE request_id=?').get(build.requestId).attempts;
  const changes=f.sql.prepare('SELECT total_changes() n').get().n;
  await recordPublicationDispatch(f.db,r.snapshot,publication,'version:continued-version',f.now());
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,changes);
  const prior=JSON.parse(r.priorRow.manifest_json),dispatches=f.dispatches();
  const observe=async()=>({environment:scope.environment,settled:true,active:{...prior,versionReference:'native-initial-version'}});
  await assert.rejects(beginBuildActivation(f.db,build,r.snapshot,publication,'continued-version',observe,f.now(),queued.owner));
  await assert.rejects(beginBuildActivation(f.db,build,r.snapshot,publication,'wrong-version',observe,f.now(),queued.owner,undefined,authority));
  const permit=await beginBuildActivation(f.db,build,r.snapshot,publication,'continued-version',
    observe,f.now(),queued.owner,undefined,authority);
  assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests WHERE request_id=?').get(build.requestId).attempts,attempt);
  const plan=prunedVectorPlan(r),control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),ids:prunedVectorIds(plan)};
  const read=()=>readActivatedCatalogVectors(f.db,permit,control,f.adapters);
  await completeActivatedApprovedCatalogPublication(f.db,r,publication,permit,async()=>{await read();return intent;},f.now);
  assert.equal(await resolveBuildActivation(f.db,permit,async()=>{await read();return{environment:scope.environment,settled:true,
    active:{...intent,versionReference:'continued-version'}};}),'resolved');
  assert.equal(canonicalJson(build.request),original);assert.equal(f.dispatches(),dispatches);
});

test('unchanged source proof reuses one scan; source edits, owner drift and absent migration do not',async t=>{
  const f=await fixture(t),queries=[],db={...f.db,prepare(sql){queries.push(sql);return f.db.prepare(sql);}};
  f.sql.exec(await readFile(new URL('../migrations/d1/0020_catalog_source_version.sql',import.meta.url),'utf8'));
  const scan=()=>queries.filter(q=>q.includes('WITH bounded AS')).length;
  await assertApprovedCatalogInventory(db,f.owner,f.revision);const first=scan();assert.ok(first>0);
  await assertApprovedCatalogInventory(db,f.owner,f.revision);assert.equal(scan(),first);
  await assert.rejects(assertApprovedCatalogInventory(db,{...f.owner,epoch:f.owner.epoch+1},f.revision));
  // A harmless same-value write still invalidates the proof, conservatively.
  f.sql.exec('UPDATE products SET title=title');
  await assertApprovedCatalogInventory(db,f.owner,f.revision);assert.equal(scan(),first*2);
  f.sql.exec('DROP TRIGGER catalog_source_products_insert');
  await assertApprovedCatalogInventory(db,f.owner,f.revision);assert.equal(scan(),first*3,'partial migration cannot reuse cached proof');
  f.sql.prepare('UPDATE products SET title=? WHERE public_id=?').run('tampered title',uuid(1));
  await assert.rejects(assertApprovedCatalogInventory(db,f.owner,f.revision),/permanent_seal_changed/);
  const g=await fixture(t),oldQueries=[],legacy={...g.db,prepare(sql){oldQueries.push(sql);
    if(sql.includes("name='catalog_source_version'"))return{all:async()=>({results:[{n:0}]})};
    return g.db.prepare(sql);}};
  await assertApprovedCatalogInventory(legacy,g.owner,g.revision);const oldCount=oldQueries.filter(q=>q.includes('WITH bounded AS')).length;
  await assertApprovedCatalogInventory(legacy,g.owner,g.revision);assert.equal(oldQueries.filter(q=>q.includes('WITH bounded AS')).length,oldCount*2);
});

test('source counter covers all source tables and rolls back with the original write',async t=>{
  const f=await fixture(t),read=()=>f.sql.prepare('SELECT version FROM catalog_source_version').get().version;
  f.sql.exec(await readFile(new URL('../migrations/d1/0020_catalog_source_version.sql',import.meta.url),'utf8'));
  for(const [table,column] of [['products','title'],['catalog_maintenance_products','product_id']]){
    const n=read();f.sql.exec(`UPDATE ${table} SET ${column}=${column}`);assert.ok(read()>n,table);
    const next=read();f.sql.exec(`BEGIN; UPDATE ${table} SET ${column}=${column}; ROLLBACK;`);assert.equal(read(),next);
  }
  const triggers=f.sql.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'catalog_source_%'").all();
  assert.equal(triggers.length,9);for(const action of ['INSERT','UPDATE','DELETE'])assert.equal(triggers.filter(t=>t.sql.includes('AFTER '+action)).length,3);
});

test('native-only permanent proof retains exact policy/bits/history after context expiry without repeating full source scans or mutations',async t=>{
  const f=await fixture(t),before=canonicalJson(f.revision),changes=f.sql.prepare('SELECT total_changes() n').get().n,dispatches=f.dispatches();
  await readOwnedApprovedCohortVectors(f.db,f.owner,f.revision,f.adapters);f.advance(60001);
  // An immutable, permanently cleared revision is not invalidated by the
  // runner's old capture cutoff. Source/owner and exact native bits still bind it.
  assert.equal((await readOwnedApprovedCohortVectors(f.db,f.owner,f.revision,f.adapters)).settled,true);
  const queries=[],db={...f.db,prepare(sql){queries.push(sql);return f.db.prepare(sql);}};
  assert.equal((await readOwnedPermanentCohortNative(db,f.owner,f.revision,f.adapters)).settled,true);
  const capture={prepare(sql){return{bind(){return{sql};}};}},old=approvedCatalogPlanChecks(capture,f.owner,f.revision);
  assert.ok(!queries.includes(old[1].sql),'native proof must not repeat the temporal/full-source plan assertion');
  assert.ok(queries.every(sql=>!sql.includes('CROSS JOIN catalog_public_products')),'native proof must not re-page the public projection');
  assert.equal(canonicalJson(f.revision),before);assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,changes);assert.equal(f.dispatches(),dispatches);
  const bit=f.index.get(uuid(1)).values[0];f.index.get(uuid(1)).values[0]=Object.is(bit,-0)?0:-0;
  await assert.rejects(readOwnedPermanentCohortNative(f.db,f.owner,f.revision,f.adapters));f.index.get(uuid(1)).values[0]=bit;
});

test('native-only reader refuses finite/nonpersistent catalogs, owner drift and an absent genuine policy',async t=>{
  const f=await fixture(t),changed=structuredClone(f.revision);delete changed.persistent;
  await assert.rejects(readOwnedPermanentCohortNative(f.db,f.owner,changed,f.adapters),/vector_plan_invalid/);
  changed.persistent=f.revision.persistent;changed.snapshot.products[0].eligibleUntil=new Date(f.now().getTime()+60000).toISOString();
  await assert.rejects(readOwnedPermanentCohortNative(f.db,f.owner,changed,f.adapters),/vector_plan_invalid/);
  await assert.rejects(readOwnedPermanentCohortNative(f.db,{...f.owner,epoch:f.owner.epoch+1},f.revision,f.adapters));
  await assert.rejects(readOwnedPermanentCohortNative(f.db,f.owner,{...f.revision,sourceDigest:'d'.repeat(64)},f.adapters),/vector_plan_receipt_invalid/);
  const absent={...f.revision,snapshot:{...f.revision.snapshot,catalogRevision:'no-policy'}};
  await assert.rejects(readOwnedPermanentCohortNative(f.db,f.owner,absent,f.adapters),/vector_plan_incomplete/);
});

async function changedHistoricalInput(f){
  const history=f.revision.nativeHistory,group=history.find(value=>value.ids.includes(uuid(1)));
  assert.ok(group,'Fixture requires genuine published native history');
  const saved=f.sql.prepare('SELECT request_json FROM catalog_vector_deliveries WHERE delivery_id=?').get(group.source.deliveryId);
  const plan=JSON.parse(saved.request_json).plan;
  // Isolate native history from current-input validation. Full source/approval
  // CAS belongs to the cohort caller; this read alone cannot approve this edit.
  f.sql.prepare('UPDATE products SET source_facts_hash=?,embedding_text_hash=NULL WHERE public_id=?').run('d'.repeat(64),uuid(1));
  const ids=[...plan.products.map(product=>product.publicId),...plan.absentIds];
  const {current}=await readApprovedCurrentRows(f.db,ids,f.owner,true);
  return{history,group,current,native:{source:group.source,revisionSha256:group.revisionSha256,plan}};
}

test('historical proof preserves original native input without approving changed current facts; direct preservation stays strict',async t=>{
  const f=await fixture(t),input=await changedHistoricalInput(f),before=structuredClone([...f.index]),
    changes=f.sql.prepare('SELECT total_changes() n').get().n,dispatches=f.dispatches();
  const options={db:f.db,owner:f.owner,native:input.native,current:input.current,adapters:f.adapters};
  await assert.rejects(readHistoricalNativePreservation(options),/vector_preserved_source_changed/);
  assert.deepEqual(await readHistoricalNativePreservation({...options,historicalOnly:true}),input.group.ids);
  assert.deepEqual(await readNativeHistory({db:f.db,owner:f.owner,history:input.history,adapters:f.adapters}),
    input.history.flatMap(group=>group.ids));
  assert.deepEqual([...f.index],before);assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,changes);
  assert.equal(f.dispatches(),dispatches);
  await assert.rejects(readHistoricalNativePreservation({...options,historicalOnly:'yes'}),/vector_preserved_input_invalid/);
});

test('historical-only proof still rejects changed original native bits, metadata and publication receipt',async t=>{
  const f=await fixture(t),input=await changedHistoricalInput(f),vector=f.index.get(uuid(1)),original=structuredClone(vector);
  const read=(db=f.db)=>readNativeHistory({db,owner:f.owner,history:input.history,adapters:f.adapters});
  assert.deepEqual(await read(),input.history.flatMap(group=>group.ids));
  vector.values[0]=Object.is(vector.values[0],-0)?0:-0;
  await assert.rejects(read());vector.values=[...original.values];
  vector.metadata.eligible=false;await assert.rejects(read());vector.metadata=structuredClone(original.metadata);
  const db={...f.db,prepare(sql){
    if(sql!=='SELECT * FROM publication_receipts WHERE release_id=?')return f.db.prepare(sql);
    return{bind(...params){const statement=f.db.prepare(sql).bind(...params);return{async all(options){
      const result=await statement.all(options);
      return params[0]===input.group.source.releaseId?{...result,results:result.results.map(row=>({...row,code_sha:'0'.repeat(40)}))}:result;
    }};}};
  }};
  await assert.rejects(read(db),/vector_preserved_receipt_changed/);
  assert.deepEqual(await read(),input.history.flatMap(group=>group.ids));
});
