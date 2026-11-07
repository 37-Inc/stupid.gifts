import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {permanentCatalogFixture} from './helpers/permanent-catalog-fixture.mjs';
import {scope,uuid} from './helpers/published-vector-fixture.mjs';
import {preparePermanentCatalog,settlePermanentCatalog} from '../lib/catalog/freeze-permanent-catalog.ts';
import {approvedCohortOperationKey} from '../lib/catalog/freeze-approved-cohort.ts';
import {claimMutationOwnership,releaseMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {enqueueBuildRequest,claimBuildRequest,beginBuildActivation,resolveBuildActivation} from '../lib/catalog/build-requests.ts';
import {enqueuePublication,claimPublication,recordPublicationDispatch,completeActivatedPermanentPublication,
  completeActivatedApprovedCatalogPublication,completeActivatedServingPublication,servingPublicationStatus} from '../lib/catalog/publication.ts';
import {prunedVectorPlan,prunedVectorIds} from '../lib/catalog/prune-existing-revision.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {createPermanentCatalogSeal} from '../scripts/catalog/permanent-catalog-seal.ts';
import {createPublishedApprovedCatalogSeal,catalogSuccessorBytes,readApprovedPrior} from '../scripts/catalog/approved-catalog-seal.ts';
import {createD1CatalogMaintenanceStore} from '../scripts/catalog/maintenance-d1.ts';
import {createSealedSnapshotEnvelope} from '../scripts/catalog/export-d1-snapshot.ts';
import {prepareOwnedApprovedCohortPlan,settleOwnedApprovedCohortVectorProof,readActivatedCatalogVectors,deliverOwnedApprovedCohortVector} from '../scripts/catalog/owned-vector-delivery.ts';
import {readAcceptedCodeOnlyCatalog,acceptedCodeOnlyOperationKey,assertAcceptedCodeOnlyBinding,acceptedCodeOnlyControl} from '../scripts/catalog/accepted-code-only.ts';
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
import {siteIdentityFor} from '../static-site/lib/site-identity.ts';
import {guides} from '../static-site/lib/guides.ts';
import {codeOnlyAuthority} from '../scripts/catalog/code-only-operator.mjs';
import safeCatalogPayload from '../static-site/public/safe/catalog.json' with {type:'json'};

async function fixture(t,{codeSha='8'.repeat(40)}={}){
  const f=await permanentCatalogFixture(t,{count:32,afterExpiry:true});
  const prepared=await preparePermanentCatalog(f.db,f.owner,f.request),initial=prepared.revision;
  async function publish(revision,queued,releaseId,prior,version,permanent=false,servingPrior){
    const build=await claimBuildRequest(f.db,queued.requestId,releaseId,f.now());
    const intent={releaseId,catalogRevision:revision.snapshot.catalogRevision,codeSha:revision.request.codeSha,
      catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
      priorReleaseId:prior.releaseId,nextExpiry:null};
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

test('accepted persistent reader proves >20 identities without source/native writes or renewed observations',async t=>{
  const f=await fixture(t);assert.equal(f.input.revision.sourceRows.length,32);
  const prepared=codeOnlyAuthority({seal:f.seal,codeSha:f.authority.request.codeSha,observedAt:f.authority.observedAt,cutoff:f.authority.request.cutoff,
    globalVectorWatermark:f.authority.globalVectorWatermark,publicationReceiptWatermark:f.authority.publicationReceiptWatermark});
  assert.equal(prepared.identityCount,32);assert.equal(prepared.request.capturedAt,f.input.revision.snapshot.generatedAt);
  assert.equal(prepared.publication.receiptSha256,f.seal.publication.receiptSha256);
  assert.ok(f.input.revision.snapshot.products.length>20);assert.ok(f.input.revision.snapshot.products.every(p=>p.eligibleUntil===null));
  assertAcceptedCodeOnlyBinding(f.input);const before=canonicalJson(f.input);
  await f.read();f.unchanged();assert.equal(canonicalJson(f.input),before);
  const changed=structuredClone(f.input);changed.authority.sealSha256='0'.repeat(64);assert.throws(()=>assertAcceptedCodeOnlyBinding(changed));
  const bit=f.index.get(uuid(1)).values[0];f.index.get(uuid(1)).values[0]=Object.is(bit,-0)?0:-0;
  await assert.rejects(f.read());f.index.get(uuid(1)).values[0]=bit;f.unchanged();
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
  f.sql.prepare("UPDATE products SET title='source drift' WHERE public_id=?").run(uuid(1));await assert.rejects(f.read());
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
test('actual serving-only publisher resumes uncertain activation with one upload and no catalog receipt',{skip:process.platform!=='darwin'},async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'accepted-code-only-'))),sourceRoot=path.join(directory,'source');
  let workspace;t.after(async()=>{await workspace?.close();await fs.rm(directory,{recursive:true,force:true});});
  await fs.mkdir(sourceRoot,{mode:0o700});
  const put=async(file,bytes)=>{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,bytes,{mode:0o600});};
  const git=(...args)=>execFileSync('git',args,{cwd:sourceRoot,encoding:'utf8',env:{PATH:process.env.PATH,HOME:directory,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  git('init','-q');await put(path.join(sourceRoot,'.gitignore'),'build/\nstatic-site/out/\n');git('add','.gitignore');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Owned serving fixture');
  const codeSha=git('rev-parse','HEAD'),f=await fixture(t,{codeSha}),r=f.input.revision,version=uuid(410),deployment=uuid(411);
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
  const counts={uploads:0,activations:0,builds:0,nativeWrites:0};let uploaded=false,active=false,uploadedConfig,identityFailure=true,loseResolve=false;
  const response=result=>Response.json({success:true,result}),checkpoint=async()=>(await workspace.readCheckpoint({controlOnly:true})).checkpoint;
  const base=`https://api.cloudflare.com/client/v4/accounts/${f.accountId}`,worker=`${base}/workers/scripts/${config.workerName}`;
  const raw=async(url,init={})=>{init.signal?.throwIfAborted();const u=new URL(url);
    if(url===`${base}/d1/database/${f.databaseId}`)return response({uuid:f.databaseId,name:config.database.name,read_replication:{mode:'disabled'}});
    if(url===`${base}/d1/database/${f.databaseId}/query`){const batch=JSON.parse(init.body).batch,result=[];f.sql.exec('BEGIN');
      try{for(const q of batch){const before=f.sql.prepare('SELECT total_changes() n').get().n,rows=f.sql.prepare(q.sql).all(...q.params).map(row=>({...row}));
        const changes=f.sql.prepare('SELECT total_changes() n').get().n-before;
        result.push({success:true,results:rows,meta:{served_by_primary:true,rows_read:rows.length,rows_written:changes,changes}});}f.sql.exec('COMMIT');}
      catch(error){f.sql.exec('ROLLBACK');throw error;}
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
      for(const name of createOgRelease(snapshot,siteIdentityFor(context.sourceMode)).byPath.keys())assets.set(name,bytes('Owned PNG fixture'));
      const assembled=assembleReleaseAssets(snapshot,assets,context,null),rest={...context};delete rest.retainedManifestSha256;
      const manifest={...rest,dataKind:'catalog',siteIdentitySha256:sha256(siteIdentityBytes(context.sourceMode)),nextExpiry:null,
        productCount:snapshot.products.length,slugCount:snapshot.products.length,checksums:Object.fromEntries([...assembled.assets].map(([p,b])=>[p,sha256(b)])),routes:assembled.routes,retention:assembled.retention};
      const manifestBytes=bytes(`${JSON.stringify(manifest,null,2)}\n`),outputs={'asset-manifest.json':manifestBytes,'catalog.snapshot.json':bytes(`${JSON.stringify(snapshot)}\n`),
        'release-context.json':bytes(`${JSON.stringify(context)}\n`),'release-identity.json':bytes(createReleaseIdentity(manifestBytes)),
        'site-identity.json':bytes(siteIdentityBytes(context.sourceMode)),'feed-plan.json':bytes(createStaticFeedPlan(snapshot,context.catalogSnapshotSha256))};
      for(const[name,b]of Object.entries(outputs))await put(path.join(sourceRoot,'build/stupid-gifts',name),b);
      for(const[name,b]of assembled.assets)await put(path.join(sourceRoot,'static-site/out',name.slice(1)),b);
    }else if(input.args.includes('upload')){counts.uploads++;uploadedConfig=JSON.parse(await fs.readFile(input.args[input.args.indexOf('--config')+1]));
      const endpoint=input.env.CLOUDFLARE_API_BASE_URL;assert.equal(new URL(endpoint).hostname,'127.0.0.1');
      for(const route of [`/accounts/${f.accountId}/workers/scripts/${config.workerName}/assets-upload-session`,`/accounts/${f.accountId}/workers/assets/upload?base64=true`,
        `/accounts/${f.accountId}/workers/scripts/${config.workerName}/versions?bindings_inherit=strict`]){
        const reply=await fetch(`${endpoint}${route}`,{method:'POST',body:'{}'});assert.equal(reply.status,200);await reply.arrayBuffer();}}
  };
  const execute=async(completed=false)=>executePublication({db:io.db,owner:(await checkpoint()).owner,revision:completed?null:r,
    acceptedCatalog:completed?acceptedCodeOnlyControl(f.seal,f.authority):f.input,requestId:queued.requestId,
    runReference:config.releaseId,workspace,config,credentials:{cloudflareToken:'FIXTURE_ONLY',identityAuthorization:'Basic FIXTURE_ONLY'},dependencies:{fetch:io.fetch,
      observationFetch:io.observationFetch,command:accountedPublicationUploadCommand({workspace,scope:{accountId:f.accountId,workerName:config.workerName},send:raw,command}),now:f.now}});
  const denied=await execute(true);assert.equal(denied.state,'pending');assert.equal(denied.errorCode,'publication_serving_settlement_scope');assert.equal(counts.uploads,0);
  const first=await execute();assert.equal(first.state,'pending',JSON.stringify(first));assert.equal(counts.activations,1);assert.equal(counts.uploads,1);f.unchanged();
  const expectedManifestSha256=workspace.manifestSha256;await workspace.close();workspace=await openRunWorkspace({...wsOptions,mode:'resume',expectedManifestSha256});io=await transports();
  loseResolve=true;const uncertain=await execute();assert.equal(uncertain.state,'pending',JSON.stringify(uncertain));f.unchanged();
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests WHERE request_id=?').get(queued.requestId).state,'resolved');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts WHERE release_id=?').get(config.releaseId).n,0);
  assert.deepEqual(counts,{uploads:1,activations:1,builds:1,nativeWrites:0});
  const manifestAfterResolve=workspace.manifestSha256;await workspace.close();workspace=await openRunWorkspace({...wsOptions,mode:'resume',expectedManifestSha256:manifestAfterResolve});io=await transports();
  assert.equal((await execute(true)).state,'published');assert.deepEqual(counts,{uploads:1,activations:1,builds:1,nativeWrites:0});f.unchanged();
});
