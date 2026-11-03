import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import type {CatalogSnapshot} from '../../lib/catalog/types.ts';
import type {ApprovedCohortRequest,ApprovedCohortRevision} from '../../lib/catalog/freeze-approved-cohort.ts';
import type {PersistentCohortState} from '../../lib/catalog/freeze-approved-cohort.ts';
import type {NativeHistoryBinding} from '../../lib/catalog/prune-existing-revision.ts';
import {prunedVectorPlan,prunedVectorIds} from '../../lib/catalog/prune-existing-revision.ts';
import {encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import {encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {approvedCohortOperationKey} from '../../lib/catalog/freeze-approved-cohort.ts';
import {validateCatalogSnapshot} from '../../lib/catalog/snapshot.ts';
import {canonicalJson,sha256} from './migration.ts';
import {createSealedSnapshotEnvelope,readOwnedProjection,readApprovedRevisionSource} from './export-d1-snapshot.ts';
import type {SealedSnapshotEnvelope,SnapshotReadContext} from './export-d1-snapshot.ts';

/** Body-free daily handoff. Actual receipt/projection readback is mandatory on
 * consumption; constructing technical metadata is never proof of publication. */
export interface ApprovedCatalogSeal {
  schemaVersion:1;kind:'approved-catalog-seal';envelopeJson:string;snapshotSha256:string;
  projectionReceipt:ApprovedCohortRevision['packet']['receipt'];publication:{releaseId:string;receiptSha256:string};
  currentNative?:NativeHistoryBinding;
  persistent?:PersistentCohortState & {operationKey:string;sourceRowsSha256:string;priorRow:Record<string,unknown>;
    globalVectorWatermark:number;request:{schemaVersion:1;environment:'staging'|'production';sourceRevision:string;sourceDigest:string;
      codeSha:string;priorReleaseId:string|null;capturedAt:string;cutoff:string}};
}
/** Durable control is NOT arbitrary JSON storage. Exact technical schemas only;
 * product bodies, grants, vectors and provider responses cannot enter it. */
export function catalogSuccessorBytes(seal:ApprovedCatalogSeal){
  const exact=(v:unknown,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.sort().join(',');
  const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),id=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
  const label=(v:unknown)=>typeof v==='string'&&/^[a-zA-Z0-9._:-]{1,200}$/.test(v),slug=(v:unknown)=>typeof v==='string'&&/^[a-z0-9][a-z0-9-]{0,199}$/.test(v);
  const refuse=()=>{throw new Error('cohort_successor_control_invalid');};
  const publication=(v:ApprovedCatalogSeal['publication'])=>exact(v,['releaseId','receiptSha256'])&&label(v.releaseId)&&hash(v.receiptSha256);
  const native=(v:NativeHistoryBinding)=>exact(v,['source','revisionSha256','planSha256','ids'])&&hash(v.revisionSha256)&&hash(v.planSha256)
    &&exact(v.source,['releaseId','receiptSha256','deliveryId','deliverySha256'])&&label(v.source.releaseId)
    &&[v.source.receiptSha256,v.source.deliveryId,v.source.deliverySha256].every(hash)&&Array.isArray(v.ids)&&v.ids.length<=10000
    &&new Set(v.ids).size===v.ids.length&&v.ids.every(id);
  if(!exact(seal,['schemaVersion','kind','envelopeJson','snapshotSha256','projectionReceipt','publication','persistent','currentNative'])
    ||seal.schemaVersion!==1||seal.kind!=='approved-catalog-seal'||!hash(seal.snapshotSha256)||!publication(seal.publication)
    ||!seal.currentNative||!native(seal.currentNative)||typeof seal.envelopeJson!=='string')refuse();
  const e=JSON.parse(seal.envelopeJson),p=seal.persistent!,r=seal.projectionReceipt;
  if(!exact(e,['schemaVersion','dataKind','catalogRevision','generatedAt','products','heldProducts','slugHistory'])||e.schemaVersion!==1||e.dataKind!=='catalog'
    ||!label(e.catalogRevision)||!Array.isArray(e.products)||!e.products.every(id)||e.products.length>5000||!Array.isArray(e.heldProducts)
    ||e.products.length+e.heldProducts.length>10000||!Array.isArray(e.slugHistory)||e.slugHistory.length>20000)refuse();
  for(const h of e.heldProducts){if(!exact(h,['id','publicId','slug','path','title','description','reason',...(h.affiliateUrl===undefined?[]:['affiliateUrl'])])
    ||!label(h.id)||!id(h.publicId)||!slug(h.slug)||h.path!==`/gifts/${h.slug}`||h.title!=='Gift currently unavailable'
    ||h.description!=='This gift is not currently available in the curated catalog. Browse other gifts instead.'||!label(h.reason)
    ||h.affiliateUrl!==undefined&&(typeof h.affiliateUrl!=='string'||h.affiliateUrl.length>2048||!/^https:\/\/[^\s]+$/.test(h.affiliateUrl)))refuse();}
  if(e.slugHistory.some((v:Record<string,unknown>)=>!exact(v,['slug','canonicalSlug','publicId'])||!slug(v.slug)||!slug(v.canonicalSlug)||!id(v.publicId)))refuse();
  if(!exact(r,['catalog_revision','snapshot_sha256','projection_sha256','source_export_sha256','product_count','created_at'])
    ||r.catalog_revision!==e.catalogRevision||r.snapshot_sha256!==seal.snapshotSha256||![r.snapshot_sha256,r.projection_sha256,r.source_export_sha256].every(hash)
    ||r.product_count!==e.products.length||r.created_at!==e.generatedAt
    ||!exact(p,['generation','inventory','nativeHistory','operationKey','sourceRowsSha256','priorRow','globalVectorWatermark','request'])
    ||!Number.isSafeInteger(p.generation)||p.generation<1||!Number.isSafeInteger(p.globalVectorWatermark)||p.globalVectorWatermark<0
    ||![p.operationKey,p.sourceRowsSha256].every(hash)||!Array.isArray(p.inventory)||p.inventory.length!==e.products.length+e.heldProducts.length
    ||p.inventory.some(v=>!exact(v,['publicId','sourceRowSha256','productSha256','privateStateSha256'])||!id(v.publicId)
      ||![v.sourceRowSha256,v.productSha256,v.privateStateSha256].every(hash))||!Array.isArray(p.nativeHistory)||p.nativeHistory.length>10000||!p.nativeHistory.every(native)
    ||!exact(p.priorRow,['release_id','catalog_revision','code_sha','completed_at','manifest_json'])
    ||!exact(p.request,['schemaVersion','environment','sourceRevision','sourceDigest','codeSha','priorReleaseId','capturedAt','cutoff']))refuse();
  encodeBuildRequest(p.request);const oldIntent=JSON.parse(String(p.priorRow.manifest_json));
  if(encodePublicationIntent(oldIntent)!==p.priorRow.manifest_json||!label(p.priorRow.release_id)||!label(p.priorRow.catalog_revision)
    ||typeof p.priorRow.code_sha!=='string'||!/^[a-f0-9]{40}$/.test(p.priorRow.code_sha))refuse();
  for(const value of [e.generatedAt,p.priorRow.completed_at])if(typeof value!=='string'||new Date(value).toISOString()!==value)refuse();
  const bytes=Buffer.from(canonicalJson(seal));if(bytes.length>8*1024*1024)refuse();return bytes;
}
export function createApprovedCatalogSeal(revision:ApprovedCohortRevision,publication:{releaseId:string;receiptSha256:string},currentNative?:NativeHistoryBinding):ApprovedCatalogSeal{
  if(revision.persistent&&!currentNative)throw new Error('cohort_successor_native_missing');
  const persistent=revision.persistent&&{...revision.persistent,operationKey:revision.operationKey,
    sourceRowsSha256:sha256(canonicalJson(revision.sourceRows)),priorRow:revision.priorRow,globalVectorWatermark:revision.globalVectorWatermark,
    request:{schemaVersion:1 as const,environment:revision.request.scope.environment,sourceRevision:revision.snapshot.catalogRevision,
      sourceDigest:revision.packet.receipt.snapshot_sha256,codeSha:revision.request.codeSha,priorReleaseId:revision.request.context.priorPublication?.releaseId??null,
      capturedAt:revision.snapshot.generatedAt,cutoff:revision.request.context.cutoff}};
  // The source digest binds the INPUT history; the successor adds its freshly
  // published bounded current cohort separately, without recursive seal bodies.
  return{schemaVersion:1 as const,kind:'approved-catalog-seal' as const,envelopeJson:JSON.stringify(createSealedSnapshotEnvelope(revision.snapshot)),
    snapshotSha256:revision.packet.receipt.snapshot_sha256,projectionReceipt:revision.packet.receipt,publication,
    ...(persistent?{persistent,currentNative}: {})};
}
/** Only an actual resolved publication can supply the new native anchor. */
export async function createPublishedApprovedCatalogSeal(db:CatalogD1,revision:ApprovedCohortRevision,publication:ApprovedCatalogSeal['publication']){
  if(!revision.persistent)return createApprovedCatalogSeal(revision,publication);
  const rows=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
    AND status='complete' AND disposition='verified' AND json_extract(request_json,'$.kind')='approved-cohort-plan'
    AND json_extract(request_json,'$.catalogRevision')=? LIMIT 2`).bind(revision.request.scope.environment,revision.request.scope.indexName,
      revision.persistent.generation,revision.snapshot.catalogRevision).all()).results;
  const receipts=(await db.prepare(`SELECT p.* FROM publication_receipts p JOIN catalog_build_requests b ON b.release_id=p.release_id
    JOIN publication_outbox o ON o.release_id=p.release_id JOIN catalog_mutation_scopes s ON s.environment=b.environment
    WHERE p.release_id=? AND b.state='resolved' AND o.state='verified' AND s.index_name=? AND s.phase='idle'
    AND s.generation=? AND s.external_pending=0`).bind(publication.releaseId,revision.request.scope.indexName,revision.persistent.generation).all()).results;
  const plan=prunedVectorPlan(revision),row=rows[0],request=row&&JSON.parse(String(row.request_json));
  if(rows.length!==1||receipts.length!==1||sha256(canonicalJson(receipts[0]))!==publication.receiptSha256
    ||request.revisionSha256!==sha256(canonicalJson(revision))||canonicalJson(request.plan)!==canonicalJson(plan))throw new Error('cohort_successor_unpublished');
  return createApprovedCatalogSeal(revision,publication,{source:{...publication,deliveryId:String(row.delivery_id),deliverySha256:sha256(canonicalJson(row))},
    revisionSha256:request.revisionSha256,planSha256:request.planSha256,ids:[...plan.products.map(p=>p.publicId),...plan.absentIds]});
}
/** Resume after the receipt/build committed but before the local seal did.
 * The scoped workspace reader authenticates this exact permanent control;
 * actual resolved/idle/native receipts still supply the publication anchor. */
export async function createPublishedApprovedCatalogSealFromControl(db:CatalogD1,control:ReturnType<typeof approvedRevisionControl>,
  publication:ApprovedCatalogSeal['publication'],vectorPlan:{catalogRevision:string;planSha256:string;ids:string[]}){
  const r=control.revision,q=control.request.request;
  if(!r.persistent||r.snapshot.products.some(p=>p.eligibleUntil!==null)||vectorPlan.catalogRevision!==r.snapshot.catalogRevision)
    throw new Error('cohort_successor_control_invalid');
  const rows=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
    AND status='complete' AND disposition='verified' AND json_extract(request_json,'$.kind')='approved-cohort-plan'
    AND json_extract(request_json,'$.catalogRevision')=? LIMIT 2`).bind(q.scope.environment,q.scope.indexName,
      r.persistent.generation,r.snapshot.catalogRevision).all()).results;
  const receipts=(await db.prepare(`SELECT p.* FROM publication_receipts p JOIN catalog_build_requests b ON b.release_id=p.release_id
    JOIN publication_outbox o ON o.release_id=p.release_id JOIN catalog_mutation_scopes s ON s.environment=b.environment
    WHERE p.release_id=? AND b.state='resolved' AND o.state='verified' AND s.index_name=? AND s.phase='idle'
    AND s.generation=? AND s.external_pending=0`).bind(publication.releaseId,q.scope.indexName,r.persistent.generation).all()).results;
  const row=rows[0],request=row&&JSON.parse(String(row.request_json)),plan=request?.plan;
  if(rows.length!==1||receipts.length!==1||sha256(canonicalJson(receipts[0]))!==publication.receiptSha256
    ||request.revisionSha256!==control.revisionSha256||request.planSha256!==vectorPlan.planSha256
    ||sha256(canonicalJson(plan))!==vectorPlan.planSha256
    ||canonicalJson(prunedVectorIds(plan))!==canonicalJson(vectorPlan.ids))
    throw new Error('cohort_successor_unpublished');
  const seal:ApprovedCatalogSeal={schemaVersion:1,kind:'approved-catalog-seal',
    envelopeJson:JSON.stringify(createSealedSnapshotEnvelope(r.snapshot)),snapshotSha256:r.packet.receipt.snapshot_sha256,
    projectionReceipt:r.packet.receipt,publication,persistent:{...r.persistent,operationKey:r.operationKey,
      sourceRowsSha256:control.sourceRowsSha256,priorRow:r.priorRow,globalVectorWatermark:r.globalVectorWatermark,
      request:{schemaVersion:1,environment:q.scope.environment,sourceRevision:r.snapshot.catalogRevision,
        sourceDigest:r.packet.receipt.snapshot_sha256,codeSha:q.codeSha,priorReleaseId:q.context.priorPublication?.releaseId??null,
        capturedAt:r.snapshot.generatedAt,cutoff:q.context.cutoff}},currentNative:{source:{...publication,deliveryId:String(row.delivery_id),
      deliverySha256:sha256(canonicalJson(row))},revisionSha256:control.revisionSha256,planSha256:vectorPlan.planSha256,
      ids:[...plan.products.map((p:{publicId:string})=>p.publicId),...plan.absentIds]}};
  catalogSuccessorBytes(seal);return seal;
}
type ProjectionSeal=Pick<ApprovedCatalogSeal,'envelopeJson'|'snapshotSha256'|'projectionReceipt'>;
/** Original projection bytes are reconstructed only in memory at their original
 * generatedAt, under the exact current owner. No expired body is re-pinned. */
export async function readApprovedPrior(db:CatalogD1,owner:MutationOwner,seal:ProjectionSeal,context:SnapshotReadContext){
  const envelope=JSON.parse(seal.envelopeJson) as SealedSnapshotEnvelope;
  if(sha256(seal.envelopeJson+'\n')!==context.envelopeSha256||seal.snapshotSha256!==context.snapshotSha256
    ||seal.projectionReceipt.projection_sha256!==context.projectionSha256
    ||seal.projectionReceipt.source_export_sha256!==context.sourceExportSha256)throw new Error('cohort_prior_changed');
  const rows=await readOwnedProjection(db,owner,envelope.catalogRevision,envelope.products,
    {...(owner.phase==='writing'||owner.phase==='activating'?{phase:owner.phase}:{}),approvedRecovery:true});
  const byId=new Map(rows.map(r=>[r.public_id,r]));
  const snapshot=validateCatalogSnapshot({...envelope,products:envelope.products.map(id=>JSON.parse(String(byId.get(id)?.public_display_json)))},
    new Date(envelope.generatedAt));
  if(sha256(JSON.stringify(snapshot)+'\n')!==seal.snapshotSha256)throw new Error('cohort_prior_changed');
  const receipt=(await db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?').bind(envelope.catalogRevision).all()).results;
  if(receipt.length!==1||canonicalJson(receipt[0])!==canonicalJson(seal.projectionReceipt))throw new Error('cohort_prior_changed');
  if('publication' in seal){const publication=seal.publication as ApprovedCatalogSeal['publication'];
    const actual=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(publication.releaseId).all()).results;
    if(actual.length!==1||sha256(canonicalJson(actual[0]))!==publication.receiptSha256
      ||context.priorPublication?.releaseId!==publication.releaseId||context.priorPublication.receiptSha256!==publication.receiptSha256)
      throw new Error('cohort_prior_changed');
  }
  return snapshot;
}
export function approvedRequestControl(request:ApprovedCohortRequest){
  const {previous,...rest}=request;
  return{schemaVersion:1 as const,kind:'approved-request-control' as const,request:rest,
    previous:{envelopeJson:JSON.stringify(createSealedSnapshotEnvelope(previous)),snapshotSha256:sha256(JSON.stringify(previous)+'\n'),
      projectionReceipt:{catalog_revision:previous.catalogRevision,snapshot_sha256:request.context.snapshotSha256,
        projection_sha256:request.context.projectionSha256,source_export_sha256:request.context.sourceExportSha256,
        product_count:previous.products.length,created_at:previous.generatedAt}},
    requestSha256:sha256(canonicalJson(request))};
}
export async function hydrateApprovedRequest(db:CatalogD1,owner:MutationOwner,control:ReturnType<typeof approvedRequestControl>){
  const previous=await readApprovedPrior(db,owner,control.previous,control.request.context);
  const request={...control.request,previous};
  if(control.schemaVersion!==1||control.kind!=='approved-request-control'||sha256(canonicalJson(request))!==control.requestSha256)
    throw new Error('cohort_request_changed');
  approvedCohortOperationKey(request);return request;
}
export function approvedRevisionControl(revision:ApprovedCohortRevision){
  const {request,sourceRows,...rest}=revision;
  return{schemaVersion:1 as const,kind:'approved-revision-control' as const,revision:rest,request:approvedRequestControl(request),
    sourceIds:sourceRows.map(r=>String(r.public_id)),sourceRowsSha256:sha256(canonicalJson(sourceRows)),revisionSha256:sha256(canonicalJson(revision))};
}
export async function hydrateApprovedRevision(db:CatalogD1,owner:MutationOwner,control:ReturnType<typeof approvedRevisionControl>){
  const request=await hydrateApprovedRequest(db,owner,control.request);
  const sourceRows=await readApprovedRevisionSource(db,owner,control.sourceIds,request.approval.changes,request.ownerBaseReview,request);
  const revision={...control.revision,request,sourceRows};
  if(control.schemaVersion!==1||control.kind!=='approved-revision-control'||sha256(canonicalJson(sourceRows))!==control.sourceRowsSha256
    ||sha256(canonicalJson(revision))!==control.revisionSha256)throw new Error('cohort_revision_changed');
  if(revision.persistent)await (await import('./permanent-catalog-seal.ts')).assertApprovedCatalogInventory(db,owner,revision);
  return revision;
}
/** Finite displayed fields keep their original deadline within existing rules. */
export function approvedArtifactObservedAt(snapshot:CatalogSnapshot,now:string,maxAgeMs:number){
  const deadlines=snapshot.products.flatMap(p=>p.eligibleUntil===null?[]:[Date.parse(p.eligibleUntil)]);
  return new Date(Math.min(Date.parse(now),...deadlines.map(deadline=>deadline-maxAgeMs))).toISOString();
}
