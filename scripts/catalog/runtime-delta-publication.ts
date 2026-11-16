import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion} from '../../lib/catalog/mutation-fence.ts';
import type {ApprovedCohortEnvelope} from '../../lib/catalog/freeze-approved-cohort.ts';
import {createHash} from 'node:crypto';
import type {SiteAssetManifest} from '../../lib/catalog/types.ts';
import {validateCatalogSnapshot,validatePublicCatalogProduct} from '../../lib/catalog/snapshot.ts';
import {readRuntimeCatalogData,runtimeOverlayKey} from '../../lib/catalog/runtime-catalog.ts';
import {createProjectionPacket} from '../../lib/catalog/d1.ts';
import {encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import {encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {earliestDisplayExpiry} from '../../lib/catalog/display.ts';
import type {CatalogObjectStore} from './r2-object-store.ts';
import {readOwnedProjection,createSealedSnapshotEnvelope} from './export-d1-snapshot.ts';
import {exportRuntimeCatalog} from './export-runtime-catalog.ts';
import {readReviewedRuntimeDelta,runtimeDeltaSourceFence} from './runtime-delta-source.ts';
import {assembleRuntimeCatalogDelta} from './runtime-catalog-delta.ts';
import {stageOwnedPublicProjection} from './stage-public-projection.ts';
import {commitRuntimePublication,readRuntimeAcceptance} from './commit-runtime-publication.ts';
import type {RuntimeCommit} from './commit-runtime-publication.ts';
import {canonicalJson,sha256} from './migration.ts';
import {runtimeDeltaSealBytes} from './runtime-delta-seal.ts';
import type {RuntimeDeltaSeal} from './runtime-delta-seal.ts';
import type {RuntimePublicationControl} from './run-workspace.ts';
import {activatedPermanentSummary} from './activated-permanent-control.ts';
export type {RuntimeDeltaSeal} from './runtime-delta-seal.ts';
interface DeltaHandoff {schemaVersion:1;kind:'runtime-delta-handoff';commit:RuntimeCommit;sourceVersion:number;seal:RuntimeDeltaSeal;
  indexPublicIds:string[];summary:Record<string,unknown>;retainOriginalFailedTelemetry:false}
const HASH=/^[a-f0-9]{64}$/;
const byteHash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const bytes=(value:unknown)=>Buffer.from(canonicalJson(value));
async function object(store:CatalogObjectStore,key:string,digest:string){
  const value=await store.get(key);if(!value||byteHash(value.bytes)!==digest)throw Error('runtime_delta_object_changed');
  return JSON.parse(Buffer.from(value.bytes).toString('utf8'));
}

/** Only the accepted PUBLIC catalog and public projection. No unrelated private
 * archive, source-row capture, provider request, app build or native audit. */
export async function readAcceptedPublicCatalog(input:{db:CatalogD1;store:CatalogObjectStore;owner:MutationOwner;
  releaseId:string;dataSha256:string;receiptSha256:string;now:Date}){
  const {db,store,owner}=input;
  const rows=(await db.prepare(`SELECT r.*,p.data_sha256,p.source_snapshot_sha256,p.public_snapshot_sha256
    FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id
    JOIN publication_receipts r ON r.release_id=p.release_id WHERE h.singleton=1 AND h.enabled=1`).all<Record<string,unknown>>()).results;
  if(rows.length!==1)throw Error('runtime_predecessor_changed');
  const {data_sha256,source_snapshot_sha256,public_snapshot_sha256,...receipt}=rows[0];
  if(receipt.release_id!==input.releaseId||data_sha256!==input.dataSha256||sha256(canonicalJson(receipt))!==input.receiptSha256)
    throw Error('runtime_predecessor_changed');
  const intent=JSON.parse(String(receipt.manifest_json));
  if(encodePublicationIntent(intent)!==receipt.manifest_json||intent.releaseId!==receipt.release_id
    ||intent.catalogRevision!==receipt.catalog_revision||intent.codeSha!==receipt.code_sha
    ||intent.manifestSha256!==data_sha256||intent.catalogSnapshotSha256!==source_snapshot_sha256)throw Error('runtime_predecessor_changed');
  const data=readRuntimeCatalogData(await object(store,'public-catalog/'+input.dataSha256+'.json',input.dataSha256));
  if(data.releaseId!==input.releaseId||data.sourceCodeSha!==receipt.code_sha||data.snapshot.catalogRevision!==receipt.catalog_revision
    ||sha256(JSON.stringify(data.snapshot)+'\n')!==public_snapshot_sha256)throw Error('runtime_predecessor_changed');
  const projection=(await db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?')
    .bind(data.snapshot.catalogRevision).all<Record<string,unknown>>()).results;
  // Short receipts project only permanent cleared data. Legacy receipts bind
  // their original full DTO/order; retain that reader for the first cutover.
  const projectedIds=source_snapshot_sha256===public_snapshot_sha256?data.snapshot.products.map(p=>p.publicId):data.productOrder;
  const previousRows=await readOwnedProjection(db,owner,data.snapshot.catalogRevision,[...projectedIds].sort(),{phase:'writing'});
  if(projection.length!==1||projection[0].snapshot_sha256!==source_snapshot_sha256
    ||projection[0].product_count!==previousRows.length||sha256(JSON.stringify(previousRows))!==projection[0].projection_sha256)
    throw Error('runtime_predecessor_projection_changed');
  const products=new Map(data.snapshot.products.map(p=>[p.publicId,p]));
  const due=data.overlays.filter(ref=>Date.parse(ref.expiresAt)>input.now.getTime());
  for(let offset=0;offset<due.length;offset+=8){
    // These are immutable accepted public bytes, not supplier calls. If an
    // original still-live photo object is temporarily unreadable, retry this
    // same read rather than publishing a permanent loss or inventing freshness.
    const overlays=await Promise.all(due.slice(offset,offset+8).map(async ref=>{
      const raw=await object(store,runtimeOverlayKey(ref).slice('catalog-v1/'.length),ref.sha256);
      if(!Array.isArray(raw))throw Error('runtime_predecessor_overlay_changed');
      const rows=raw.map(p=>validatePublicCatalogProduct(p,input.now));
      if(new Set(rows.map(p=>p.publicId)).size!==rows.length||rows.some(p=>p.eligibleUntil!==ref.expiresAt||!data.productOrder.includes(p.publicId)))
        throw Error('runtime_predecessor_overlay_changed');
      return rows;
    }));
    for(const overlay of overlays)for(const p of overlay){
      const old=products.get(p.publicId);
      if(old&&(old.id!==p.id||old.slug!==p.slug))throw Error('runtime_predecessor_overlay_changed');
      products.set(p.publicId,p);
    }
  }
  const snapshot=validateCatalogSnapshot({...data.snapshot,products:data.productOrder.flatMap(id=>products.get(id)??[]),
    heldProducts:data.snapshot.heldProducts.filter(p=>!products.has(p.publicId))},input.now);
  return{data,snapshot,previousRows,factsByPublicId:Object.fromEntries(previousRows.map(r=>[String(r.public_id),r.source_facts_hash as string|null]))};
}

/** Stage/export one exact reviewed cohort. Caller durably saves the returned
 * body-free handoff hash BEFORE invoking commitPreparedRuntimeDelta. */
export async function prepareRuntimeDeltaPublication(input:{db:CatalogD1;store:CatalogObjectStore;owner:MutationOwner;
  approval:ApprovedCohortEnvelope;approvalSha256:string;previous:{releaseId:string;dataSha256:string;receiptSha256:string};
  releaseId:string;codeSha:string;runReference:string;nativeHistorySha256:string;now:Date;
  homepage?:SiteAssetManifest['homepage'];merchandising?:SiteAssetManifest['merchandising'];summary?:Record<string,unknown>}){
  if(input.owner.phase!=='writing'||!HASH.test(input.nativeHistorySha256))throw Error('runtime_delta_owner_invalid');
  await object(input.store,'catalog-history/'+input.nativeHistorySha256+'.json',input.nativeHistorySha256);
  const previous=await readAcceptedPublicCatalog({...input,...input.previous});
  const proof=await readReviewedRuntimeDelta({...input,previous:previous.snapshot});
  const assembled=assembleRuntimeCatalogDelta(previous.snapshot,proof.changes,{catalogRevision:input.approval.catalogRevision,generatedAt:input.now.toISOString()});
  const facts={...previous.factsByPublicId,...proof.factsByPublicId};
  const exported=await exportRuntimeCatalog({snapshot:assembled.snapshot,releaseId:input.releaseId,sourceCodeSha:input.codeSha,
    assets:previous.data.assets,disclosures:previous.data.disclosures,semanticCatalog:previous.data.semanticCatalog,
    homepage:input.homepage??previous.data.homepage,merchandising:input.merchandising??previous.data.merchandising,
    store:input.store,now:()=>input.now.getTime(),registerFinite:async ref=>{await input.db.batch([
      mutationAssertion(input.db,input.owner,['writing']),input.db.prepare(`INSERT INTO catalog_runtime_retention(object_key,sha256,not_after,release_id)
        VALUES(?,?,?,?) ON CONFLICT(object_key) DO NOTHING`).bind(ref.key,ref.sha256,ref.notAfter,input.releaseId)]);}});
  // Projection identity is the permanent PUBLIC base, never expiring supplier
  // overlays or private rows. A retry can reuse staged rows after a photo's
  // deadline without re-pinning its bytes or inventing a fresh observation.
  const packet=await createProjectionPacket(exported.data.snapshot,facts,input.approvalSha256,input.now);
  if(exported.publicSnapshotSha256!==packet.receipt.snapshot_sha256)throw Error('runtime_delta_snapshot_changed');
  await stageOwnedPublicProjection({db:input.db,owner:input.owner,packet,previousRevision:previous.snapshot.catalogRevision,previousRows:previous.previousRows});
  const request={schemaVersion:1 as const,environment:input.owner.environment,sourceRevision:assembled.snapshot.catalogRevision,
    sourceDigest:packet.receipt.snapshot_sha256,codeSha:input.codeSha,priorReleaseId:input.previous.releaseId,
    capturedAt:input.now.toISOString(),cutoff:new Date(input.now.getTime()+24*3600000).toISOString()};
  const requestBytes=encodeBuildRequest(request),requestId=sha256(requestBytes);
  const receipt={release_id:input.releaseId,catalog_revision:request.sourceRevision,code_sha:input.codeSha,completed_at:input.now.toISOString(),
    manifest_json:encodePublicationIntent({releaseId:input.releaseId,catalogRevision:request.sourceRevision,codeSha:input.codeSha,
      catalogSnapshotSha256:packet.receipt.snapshot_sha256,manifestSha256:exported.dataSha256,
      vectorSyncWatermark:0,priorReleaseId:input.previous.releaseId,nextExpiry:earliestDisplayExpiry(assembled.snapshot.products)})};
  const seal:RuntimeDeltaSeal={schemaVersion:1,kind:'runtime-delta-seal',publication:{releaseId:input.releaseId,receiptSha256:sha256(canonicalJson(receipt))},
    envelopeJson:JSON.stringify(createSealedSnapshotEnvelope(exported.data.snapshot)),snapshotSha256:packet.receipt.snapshot_sha256,
    dataSha256:exported.dataSha256,publicSnapshotSha256:exported.publicSnapshotSha256,
    projectionReceipt:packet.receipt,nativeHistorySha256:input.nativeHistorySha256,indexDelivery:'asynchronous',generation:input.owner.generation,
    previousPublication:{releaseId:input.previous.releaseId,receiptSha256:input.previous.receiptSha256},
    scope:{environment:input.owner.environment,indexName:input.owner.indexName},request};
  runtimeDeltaSealBytes(seal);
  // Handoff identity excludes its own digest; the exact stored bytes bind all
  // other commit fields. The digest is filled only after reading those bytes.
  const handoff:DeltaHandoff={schemaVersion:1,kind:'runtime-delta-handoff',sourceVersion:proof.sourceVersion,seal,
    summary:activatedPermanentSummary(input.summary??{counts:{},warnings:[],timingsMs:{},usage:null}),retainOriginalFailedTelemetry:false,
    indexPublicIds:input.approval.changes.map(c=>c.publicId),
    commit:{owner:input.owner,receipt,requestId,runReference:input.runReference,request,dataSha256:exported.dataSha256,
      sourceSnapshotSha256:packet.receipt.snapshot_sha256,publicSnapshotSha256:exported.publicSnapshotSha256,handoffSha256:'',
      previousReleaseId:input.previous.releaseId,previousDataSha256:input.previous.dataSha256}};
  const handoffBytes=bytes(handoff),handoffSha256=byteHash(handoffBytes);
  await input.store.putImmutable('runtime-handoffs/'+handoffSha256+'.json',handoffBytes);
  const gate=runtimeDeltaSourceFence(proof.sourceVersion);
  await input.db.batch([mutationAssertion(input.db,input.owner,['writing']),
    input.db.prepare(`SELECT json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'runtime_delta_source_changed' END)`).bind(...gate.params),
    input.db.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,'reconciled') ON CONFLICT(revision) DO NOTHING")
      .bind(request.sourceRevision,request.capturedAt,input.approvalSha256),
    input.db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_revisions WHERE revision=? AND source_export_sha256=?)
      THEN 'true' ELSE 'runtime_delta_revision_changed' END)`).bind(request.sourceRevision,input.approvalSha256),
    input.db.prepare('INSERT INTO catalog_build_requests(request_id,environment,source_revision,request_json) VALUES(?,?,?,?) ON CONFLICT(request_id) DO NOTHING')
      .bind(requestId,request.environment,request.sourceRevision,requestBytes)]);
  return{handoffSha256,seal,deferred:[...new Set([...proof.deferred,...assembled.deferred])],
    products:assembled.snapshot.products.length,changes:proof.changes.length};
}

/** Resume with saved control only: no source-body hydration, providers, model,
 * unrelated private validation or index visibility wait. */
export async function commitPreparedRuntimeDelta(input:{db:CatalogD1;store:CatalogObjectStore;handoffSha256:string}){
  if(!HASH.test(input.handoffSha256))throw Error('runtime_delta_handoff_invalid');
  const handoff=await object(input.store,'runtime-handoffs/'+input.handoffSha256+'.json',input.handoffSha256) as DeltaHandoff;
  runtimeDeltaSealBytes(handoff.seal);
  if(handoff.schemaVersion!==1||handoff.kind!=='runtime-delta-handoff'||handoff.commit.handoffSha256!==''
    ||handoff.seal.kind!=='runtime-delta-seal'||handoff.seal.indexDelivery!=='asynchronous'
    ||!Array.isArray(handoff.indexPublicIds)||new Set(handoff.indexPublicIds).size!==handoff.indexPublicIds.length
    ||handoff.indexPublicIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id))
    ||handoff.seal.publication.receiptSha256!==sha256(canonicalJson(handoff.commit.receipt))
    ||handoff.seal.projectionReceipt.snapshot_sha256!==handoff.commit.sourceSnapshotSha256)throw Error('runtime_delta_handoff_invalid');
  const commit={...handoff.commit,handoffSha256:input.handoffSha256};
  const existing=await readRuntimeAcceptance(input.db,commit);
  if(existing)return{receipt:existing,seal:handoff.seal};
  const r=handoff.seal.projectionReceipt;
  const receipt=await commitRuntimePublication(input.db,commit,runtimeDeltaSourceFence(handoff.sourceVersion),[
    input.db.prepare(`INSERT INTO catalog_projection_receipts(catalog_revision,snapshot_sha256,projection_sha256,source_export_sha256,product_count,created_at)
      VALUES(?,?,?,?,?,?)`).bind(r.catalog_revision,r.snapshot_sha256,r.projection_sha256,r.source_export_sha256,r.product_count,r.created_at),
    input.db.prepare(`INSERT INTO catalog_runtime_index_events(sequence,release_id,operation_id)
      SELECT e.sequence,?,m.operation_id FROM vector_sync_outbox e LEFT JOIN catalog_maintenance_vector_payloads m ON m.sequence=e.sequence
      WHERE e.source_revision=? AND e.status='pending' AND e.public_id IN(SELECT value FROM json_each(?))`)
      .bind(commit.receipt.release_id,commit.receipt.catalog_revision,JSON.stringify(handoff.indexPublicIds))]);
  return{receipt,seal:handoff.seal};
}

/** Accepted short publication can finish its ORIGINAL telemetry handoff even
 * after supplier bodies expire. Only that run's exact finalization owner may
 * coexist with the genuine accepted receipt; another writer is never adopted. */
export async function readAcceptedRuntimeDeltaHandoff(db:CatalogD1,control:RuntimePublicationControl,handoff:DeltaHandoff){
  if(sha256(canonicalJson(handoff))!==control.handoffSha256||handoff.kind!=='runtime-delta-handoff')throw Error('runtime_delta_handoff_invalid');
  runtimeDeltaSealBytes(handoff.seal);activatedPermanentSummary(handoff.summary);
  const commit={...handoff.commit,handoffSha256:control.handoffSha256};
  if(commit.receipt.release_id!==control.releaseId||commit.dataSha256!==control.dataSha256||commit.sourceSnapshotSha256!==control.sourceSnapshotSha256
    ||commit.publicSnapshotSha256!==control.publicSnapshotSha256||commit.requestId!==control.requestId||commit.runReference!==control.runReference
    ||commit.previousReleaseId!==control.previousReleaseId||handoff.seal.publication.receiptSha256!==sha256(canonicalJson(commit.receipt)))
    throw Error('runtime_delta_handoff_invalid');
  return await readRuntimeAcceptance(db,commit,sha256('finalize:'+control.configSha256))?handoff:null;
}
