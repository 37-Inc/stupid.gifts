import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import {mutationAssertion} from '../../lib/catalog/mutation-fence.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {publicationPreflight,publicationActivationGate,encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {capturedRevisionBuildRequest,prunedVectorPlan} from '../../lib/catalog/prune-existing-revision.ts';
import {encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import type {ApprovedCohortRevision} from '../../lib/catalog/freeze-approved-cohort.ts';
import type {PublicationConfig,PublicationResult} from './publish-release.ts';
import {verifyPublicationSemanticCatalog} from './publish-release.ts';
import type {RunWorkspace,RuntimePublicationControl} from './run-workspace.ts';
import type {CatalogObjectStore} from './r2-object-store.ts';
import {exportRuntimeCatalog} from './export-runtime-catalog.ts';
import {canonicalJson} from './migration.ts';
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
import {earliestDisplayExpiry} from '../../lib/catalog/display.ts';
import {readRuntimeCatalogData} from '../../lib/catalog/runtime-catalog.ts';
import {assertApprovedCatalogInventory} from './permanent-catalog-seal.ts';
import {createApprovedCatalogSeal,catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {createContentRequestStore,ContentAdminError} from '../../lib/catalog/content-admin.ts';
import {applyRuntimeCollection} from '../../lib/catalog/runtime-collections.ts';

/** One atomic data-head transition, under the ORIGINAL catalog mutation fence.
 * No Worker dispatch, lease or activation is invented for a data publication. */
export async function publishRuntimeCatalog(input:{db:CatalogD1;owner:MutationOwner;revision:ApprovedCohortRevision;
  config:PublicationConfig;configSha256:string;requestId:string;runReference:string;workspace:RunWorkspace;store:CatalogObjectStore;
  editHomepage?:boolean;retainOriginalFailedTelemetry?:boolean;now?:()=>Date}):Promise<PublicationResult>{
  const {db,config,revision,workspace:ws,owner}=input,policy=config.runtimeCatalog,now=input.now??(()=>new Date());
  if(!policy||owner.phase!=='freezing')throw Error('runtime_publication_invalid');
  let checkpoint=await ws.readCheckpoint();if(!checkpoint)throw Error('runtime_checkpoint_missing');
  let control=checkpoint.checkpoint.control?.runtimeCatalog;
  if(!control){
    const prior=await input.store.get('public-catalog/'+policy.previousDataSha256+'.json');
    if(!prior||sha256(prior.bytes)!==policy.previousDataSha256)throw Error('runtime_predecessor_changed');
    const data=readRuntimeCatalogData(JSON.parse(Buffer.from(prior.bytes).toString('utf8')));
    if(data.releaseId!==policy.previousReleaseId)throw Error('runtime_predecessor_changed');
    if(input.editHomepage&&config.homepage){try{
      const saved=await createContentRequestStore(db).save({requestId:'homepage-'+sha256(input.runReference).slice(0,32),resource:'/collections/homepage',
        action:'collection',actor:'daily-homepage-editor',reason:'Reviewed saved daily edition',baseCatalogRevision:data.snapshot.catalogRevision,
        expectedRevision:policy.homepageRevision,payload:{edition:config.homepage}},now().toISOString());
      // A newer manual edition wins. Optional editorial can never block care.
      await applyRuntimeCollection(db,saved.request);
    }catch(error){if(!(error instanceof ContentAdminError&&error.status===409))console.warn(JSON.stringify({notice:'runtime_homepage_not_applied',catalogBlocked:false}));}}
    let semanticCatalog;
    if(config.semanticSearch?.derivedCatalog){const ref=config.semanticSearch.derivedCatalog,bytes=await readFile(ref.path);
      semanticCatalog=await verifyPublicationSemanticCatalog({semanticCatalog:JSON.parse(bytes.toString('utf8'))},config);}
    const exported=await exportRuntimeCatalog({snapshot:revision.snapshot,releaseId:config.releaseId,sourceCodeSha:config.codeSha,
      homepage:config.homepage,merchandising:config.merchandising,semanticCatalog,assets:data.assets,disclosures:data.disclosures,store:input.store,
      now:()=>now().getTime(),registerFinite:async ref=>{await db.batch([mutationAssertion(db,owner,['freezing']),db.prepare(`INSERT INTO catalog_runtime_retention(object_key,sha256,not_after,release_id)
        VALUES(?,?,?,?) ON CONFLICT(object_key) DO NOTHING`).bind(ref.key,ref.sha256,ref.notAfter,config.releaseId)]);}});
    const watermark=(await db.prepare('SELECT coalesce(max(sequence),0) n FROM vector_sync_outbox WHERE source_revision=?').bind(revision.snapshot.catalogRevision).all<{n:number}>()).results[0].n;
    const intent={releaseId:config.releaseId,codeSha:config.codeSha,catalogRevision:revision.snapshot.catalogRevision,
      catalogSnapshotSha256:exported.sourceSnapshotSha256,manifestSha256:exported.dataSha256,vectorSyncWatermark:watermark,
      priorReleaseId:policy.previousReleaseId,nextExpiry:earliestDisplayExpiry(revision.snapshot.products)};
    const receipt={release_id:config.releaseId,catalog_revision:intent.catalogRevision,code_sha:config.codeSha,completed_at:now().toISOString(),manifest_json:encodePublicationIntent(intent)};
    const native=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
      AND status='complete' AND disposition='verified' AND json_extract(request_json,'$.kind')='approved-cohort-plan'
      AND json_extract(request_json,'$.catalogRevision')=? LIMIT 2`).bind(owner.environment,owner.indexName,owner.generation,revision.snapshot.catalogRevision).all<Record<string,unknown>>()).results;
    const plan=prunedVectorPlan(revision),request=native[0]&&JSON.parse(String(native[0].request_json));
    if(native.length!==1||request.revisionSha256!==sha256(canonicalJson(revision))||canonicalJson(request.plan)!==canonicalJson(plan))throw Error('runtime_native_proof_changed');
    const seal=createApprovedCatalogSeal(revision,{releaseId:config.releaseId,receiptSha256:sha256(canonicalJson(receipt))},
      {source:{releaseId:config.releaseId,receiptSha256:sha256(canonicalJson(receipt)),deliveryId:String(native[0].delivery_id),deliverySha256:sha256(canonicalJson(native[0]))},
        revisionSha256:request.revisionSha256,planSha256:request.planSha256,ids:[...plan.products.map(p=>p.publicId),...plan.absentIds]});
    catalogSuccessorBytes(seal);
    const handoff=Buffer.from(canonicalJson({schemaVersion:1,owner,receipt,seal,retainOriginalFailedTelemetry:Boolean(input.retainOriginalFailedTelemetry),
      summary:await ws.readArtifact(checkpoint.checkpoint.pins.publicationSummary??checkpoint.checkpoint.phaseComplete!)})),handoffSha256=sha256(handoff);
    await input.store.putImmutable('runtime-handoffs/'+handoffSha256+'.json',handoff);
    control={schemaVersion:1,configSha256:input.configSha256,requestId:input.requestId,runReference:input.runReference,
      releaseId:config.releaseId,dataSha256:exported.dataSha256,sourceSnapshotSha256:exported.sourceSnapshotSha256,
      publicSnapshotSha256:exported.publicSnapshotSha256,previousReleaseId:policy.previousReleaseId,handoffSha256,stage:'prepared'};
    checkpoint=await ws.writeCheckpoint(checkpoint.sha256,{...checkpoint.checkpoint,control:{runtimeCatalog:control}});
  }
  if(control.configSha256!==input.configSha256||control.requestId!==input.requestId||control.releaseId!==config.releaseId
    ||control.sourceSnapshotSha256!==revision.packet.receipt.snapshot_sha256)throw Error('runtime_publication_changed');
  const handoffObject=await input.store.get('runtime-handoffs/'+control.handoffSha256+'.json');
  if(!handoffObject||sha256(handoffObject.bytes)!==control.handoffSha256)throw Error('runtime_handoff_changed');
  const handoff=JSON.parse(Buffer.from(handoffObject.bytes).toString('utf8')),intent=JSON.parse(handoff.receipt.manifest_json);
  catalogSuccessorBytes(handoff.seal);
  const bytes=encodePublicationIntent(intent),requestBytes=encodeBuildRequest(capturedRevisionBuildRequest(revision)),token=sha256('runtime:'+bytes),at=handoff.receipt.completed_at;
  const existing=async()=>{
    const rows=(await db.prepare(`SELECT r.*,p.data_sha256,p.source_snapshot_sha256,p.public_snapshot_sha256,p.request_id
      FROM publication_receipts r JOIN catalog_runtime_publications p USING(release_id) WHERE r.release_id=?`).bind(config.releaseId).all<Record<string,unknown>>()).results;
    if(!rows.length)return null;const r=rows[0];
    if(rows.length!==1||r.manifest_json!==bytes||r.data_sha256!==control!.dataSha256||r.request_id!==input.requestId
      ||r.source_snapshot_sha256!==control!.sourceSnapshotSha256||r.public_snapshot_sha256!==control!.publicSnapshotSha256)throw Error('runtime_receipt_changed');
    const receipt=Object.fromEntries(Object.entries(r).filter(([key])=>!['data_sha256','source_snapshot_sha256','public_snapshot_sha256','request_id'].includes(key)));
    const proof=(await db.prepare(`SELECT h.release_id,b.state,b.dispatch_reference,b.version_reference,s.phase,s.external_pending,s.generation,s.mutation_epoch
      FROM catalog_runtime_head h JOIN catalog_build_requests b ON b.request_id=? JOIN catalog_mutation_scopes s ON s.environment=? AND s.index_name=? WHERE h.singleton=1`)
      .bind(input.requestId,owner.environment,owner.indexName).all<Record<string,unknown>>()).results[0];
    if(!proof||proof.release_id!==config.releaseId||proof.state!=='resolved'||proof.dispatch_reference!=='runtime:'+control!.dataSha256
      ||proof.version_reference!==null||proof.phase!=='idle'||proof.external_pending!==0||proof.generation!==owner.generation||proof.mutation_epoch!==owner.epoch)
      throw Error('runtime_acceptance_changed');return receipt;
  };
  let receipt=await existing();
  if(!receipt){
    const native=(await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').bind(handoff.seal.currentNative.source.deliveryId).all<Record<string,unknown>>()).results;
    if(native.length!==1||sha256(canonicalJson(native[0]))!==handoff.seal.currentNative.source.deliverySha256)throw Error('runtime_native_proof_changed');
    await assertApprovedCatalogInventory(db,owner,revision);
    await publicationPreflight(db,revision.snapshot,intent,now());
    const gate=publicationActivationGate(revision.snapshot,intent),assert=(sql:string,params:unknown[]=[])=>db.prepare(`SELECT json(CASE WHEN ${sql} THEN 'true' ELSE 'runtime_publication_fenced' END)`).bind(...params);
    try{await db.batch([
      mutationAssertion(db,owner,['freezing']),assert(gate.sql,gate.params),
      assert(`EXISTS(SELECT 1 FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id
        WHERE h.singleton=1 AND p.release_id=? AND p.data_sha256=?)`,[policy.previousReleaseId,policy.previousDataSha256]),
      assert(`EXISTS(SELECT 1 FROM catalog_build_requests WHERE request_id=? AND request_json=? AND state='pending' AND attempts=0)
        AND NOT EXISTS(SELECT 1 FROM publication_outbox WHERE release_id=?)`,[input.requestId,requestBytes,config.releaseId]),
      db.prepare(`INSERT INTO publication_outbox(intent_id,release_id,catalog_revision,intent_json,state,attempts,dispatch_reference,completed_token,created_at,updated_at)
        VALUES(?,?,?,?,'verified',1,?,?,?,?)`).bind(sha256(bytes),config.releaseId,intent.catalogRevision,bytes,'runtime:'+control.dataSha256,token,at,at),
      db.prepare('INSERT INTO publication_receipts(release_id,catalog_revision,code_sha,completed_at,manifest_json) VALUES(?,?,?,?,?)')
        .bind(config.releaseId,intent.catalogRevision,config.codeSha,at,bytes),
      db.prepare('INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,handoff_sha256,request_id,owner_json,previous_release_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(config.releaseId,intent.catalogRevision,control.dataSha256,control.sourceSnapshotSha256,control.publicSnapshotSha256,control.handoffSha256,input.requestId,canonicalJson(owner),policy.previousReleaseId,at),
      db.prepare('UPDATE catalog_runtime_head SET release_id=?,version=version+1 WHERE singleton=1 AND release_id=?').bind(config.releaseId,policy.previousReleaseId),
      db.prepare("UPDATE catalog_revisions SET status='published' WHERE revision=?").bind(intent.catalogRevision),
      db.prepare(`UPDATE catalog_build_requests SET state='resolved',lease_token=?,lease_until=NULL,run_reference=?,release_id=?,dispatch_reference=?,version_reference=NULL,error_code=NULL
        WHERE request_id=? AND state='pending'`).bind(token,input.runReference,config.releaseId,'runtime:'+control.dataSha256,input.requestId),
      db.prepare(`UPDATE catalog_mutation_scopes SET phase='idle',owner_token=NULL,owner_reference=NULL,operation_key=NULL,captured_at=NULL
        WHERE environment=? AND index_name=? AND owner_token=? AND generation=? AND mutation_epoch=? AND phase='freezing' AND external_pending=0`)
        .bind(owner.environment,owner.indexName,owner.token,owner.generation,owner.epoch),
      assert(`EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND phase='idle' AND external_pending=0 AND generation=? AND mutation_epoch=?)`,
        [owner.environment,owner.indexName,owner.generation,owner.epoch]),
    ]);}catch(error){receipt=await existing();if(!receipt)throw error;}
    receipt=receipt??await existing();if(!receipt)throw Error('runtime_receipt_missing');
  }
  const receiptSha256=sha256(canonicalJson(receipt));
  if(receiptSha256!==handoff.seal.publication.receiptSha256)throw Error('runtime_handoff_changed');
  if(control.stage!=='published')await ws.writeCheckpoint(checkpoint.sha256,{...checkpoint.checkpoint,owner:null,control:{runtimeCatalog:{...control,stage:'published',receiptSha256}}});
  return{state:'published',owner:null,releaseId:config.releaseId,receiptSha256,receipt};
}

/** Crash after the atomic D1 commit: finish metadata from retained body-free
 * handoff, never hydrate expired supplier bodies or publish anything again. */
export async function readAcceptedRuntimeHandoff(db:CatalogD1,store:CatalogObjectStore,control:RuntimePublicationControl){
  const rows=(await db.prepare(`SELECT r.*,p.handoff_sha256,p.data_sha256,p.request_id,p.owner_json
    FROM publication_receipts r JOIN catalog_runtime_publications p USING(release_id) WHERE r.release_id=?`).bind(control.releaseId).all<Record<string,unknown>>()).results;
  if(!rows.length)return null;const {handoff_sha256,data_sha256,request_id,owner_json,...receipt}=rows[0];
  if(rows.length!==1||handoff_sha256!==control.handoffSha256||data_sha256!==control.dataSha256||request_id!==control.requestId)throw Error('runtime_receipt_changed');
  const object=await store.get('runtime-handoffs/'+control.handoffSha256+'.json');
  if(!object||sha256(object.bytes)!==control.handoffSha256)throw Error('runtime_handoff_changed');
  const handoff=JSON.parse(Buffer.from(object.bytes).toString('utf8'));catalogSuccessorBytes(handoff.seal);
  if(canonicalJson(handoff.receipt)!==canonicalJson(receipt)||canonicalJson(handoff.owner)!==owner_json
    ||handoff.seal.publication.receiptSha256!==sha256(canonicalJson(receipt)))throw Error('runtime_handoff_changed');
  const b=(await db.prepare('SELECT state,release_id,version_reference,dispatch_reference FROM catalog_build_requests WHERE request_id=?').bind(control.requestId).all<Record<string,unknown>>()).results[0];
  const h=(await db.prepare('SELECT release_id FROM catalog_runtime_head WHERE singleton=1').all<Record<string,unknown>>()).results[0];
  if(b?.state!=='resolved'||b.release_id!==control.releaseId||b.version_reference!==null||b.dispatch_reference!=='runtime:'+control.dataSha256||h?.release_id!==control.releaseId)
    throw Error('runtime_acceptance_changed');
  const n=(await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').bind(handoff.seal.currentNative.source.deliveryId).all<Record<string,unknown>>()).results;
  if(n.length!==1||sha256(canonicalJson(n[0]))!==handoff.seal.currentNative.source.deliverySha256)throw Error('runtime_native_proof_changed');
  return handoff;
}
