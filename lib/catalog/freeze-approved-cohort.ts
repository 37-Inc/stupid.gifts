import type { CatalogD1 } from './storage/d1.ts';
import { catalogDisplayDeadline, persistentPublicProduct } from './display.ts';
import type { CatalogSnapshot, PublicCatalogProduct, SafeHeldProduct } from './types.ts';
import type { MutationOwner } from './mutation-fence.ts';
import { mutationAssertion } from './mutation-fence.ts';
import { createProjectionPacket } from './d1.ts';
import { canonicalTime, validateCatalogSnapshot, validatePublicCatalogProduct } from './snapshot.ts';
import { areNearDuplicateTitles, suppressNearDuplicateProducts } from '../db/product-scoring.ts';
import { checkCurrent, readApprovedCurrentRows, readOwnerBaseOperationReceipts, readAutomationOperationReceipts,readPruningSource, SNAPSHOT_READ_LIMITS } from '../../scripts/catalog/export-d1-snapshot.ts';
import { canonicalJson, sha256 } from '../../scripts/catalog/migration.ts';
import { pruneOperationKey, prunedVectorPlan, sealCapturedRevision, settleCapturedRevision } from './prune-existing-revision.ts';
import type { PruneRequest, PrunedRevision, PrunedVectorObservation, PrunedVectorPlan } from './prune-existing-revision.ts';
import type { NativeHistoryBinding } from './prune-existing-revision.ts';
import type { PermanentCatalogSeal } from '../../scripts/catalog/permanent-catalog-seal.ts';
import type { ApprovedCatalogSeal } from '../../scripts/catalog/approved-catalog-seal.ts';
import type { permanentSourceInventory } from './freeze-permanent-catalog.ts';
import { approvedBaseChangeLimit, exactOwnerBaseTitle, ownerBasePublicDuplicate } from './owner-base-review.ts';
import type { OwnerBaseCatalogReview } from './owner-base-review.ts';
import {effectiveSlugApproval} from '../../scripts/catalog/new-product-slug-repair.ts';
import {confirmedRetailAvailable,confirmedRetailUnavailable} from './retail-availability.ts';
import {validateAutomationCohort} from './automation-cohort.ts';
import type {AutomationCohortAuthority} from './automation-cohort.ts';

type Row = Record<string, unknown>;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Private, independently reviewed input, not approval inferred from ready rows.
 * productSha256 hashes canonicalJson of the COMPLETE current products row;
 * displaySha256 hashes its exact public_display_json bytes (literal "null" for a
 * held row). Order is deliberate.
 * The immutable maintenance receipt must bind those same row/input bytes.
 */
export interface ApprovedChange {
  publicId: string; operationId: string; inputSha256: string; productSha256: string; displaySha256: string;
}
export interface ApprovedCohortEnvelope {
  schemaVersion: 1; runId: string; catalogRevision: string; changes: ApprovedChange[];
}
export interface ApprovedCohortRequest extends PruneRequest {
  approval: ApprovedCohortEnvelope; approvalSha256: string;
  predecessor?: PermanentCatalogSeal | ApprovedCatalogSeal;
  ownerBaseReview?: OwnerBaseCatalogReview;
  automation?:AutomationCohortAuthority;
  /** A publication-only recovery keeps original ingestion receipts immutable. */
  publicationRevision?: string;
}
export interface PersistentCohortState {
  generation:number; inventory:ReturnType<typeof permanentSourceInventory>; nativeHistory:NativeHistoryBinding[];
}
export interface ApprovedCohortRevision extends PrunedRevision { request: ApprovedCohortRequest; persistent?:PersistentCohortState }
export function approvedCohortOperationKey(request: ApprovedCohortRequest): string {
  pruneOperationKey(request); // Shared scope/code/cutoff validation, NOT subset policy.
  const envelope = request.approval;
  if(request.publicationRevision!==undefined&&(!envelope||!/^[a-zA-Z0-9._-]{1,64}$/.test(request.publicationRevision)
    ||request.publicationRevision===request.previous.catalogRevision||request.publicationRevision===envelope.catalogRevision))
    throw Error('cohort_publication_revision_invalid');
  if (!envelope || Object.keys(envelope).sort().join(',') !== 'catalogRevision,changes,runId,schemaVersion'
    || envelope.schemaVersion !== 1 || !/^[a-zA-Z0-9._-]{1,200}$/.test(envelope.runId)
    || !/^[a-zA-Z0-9._-]{1,64}$/.test(envelope.catalogRevision) || envelope.catalogRevision === request.previous.catalogRevision
    || !Array.isArray(envelope.changes) || !request.automation&&envelope.changes.length > approvedBaseChangeLimit(request.ownerBaseReview)
    || new Set(envelope.changes.map(value => value.publicId)).size !== envelope.changes.length
    || envelope.changes.some(value => Object.keys(value).sort().join(',') !== 'displaySha256,inputSha256,operationId,productSha256,publicId'
      || !UUID.test(value.publicId) || ![value.operationId,value.inputSha256,value.productSha256,value.displaySha256].every(hash => HASH.test(hash)))
    || !HASH.test(request.approvalSha256) || sha256(canonicalJson(envelope)) !== request.approvalSha256)
    throw new Error('cohort_approval_invalid');
  if(request.automation){
    if(request.ownerBaseReview||request.publicationRevision||!request.predecessor)throw Error('automation_cohort_invalid');
    validateAutomationCohort(request.automation,envelope);
  }
  const publicDuplicate = ownerBasePublicDuplicate(request.ownerBaseReview, request.previous);
  if (request.ownerBaseReview && (!request.predecessor || envelope.changes.some(change =>
    change.publicId !== publicDuplicate?.publicId && !request.previous.heldProducts.some(p => p.publicId === change.publicId))
    || publicDuplicate && !envelope.changes.some(change => change.publicId === publicDuplicate.publicId))) throw Error('cohort_owner_base_scope');
  return sha256(canonicalJson({ kind:'approved-cohort', previous:pruneOperationKey(request), approvalSha256:request.approvalSha256,
    ...(request.publicationRevision?{publicationRevision:request.publicationRevision}:{}),
    ...(request.ownerBaseReview ? { ownerBaseReview: request.ownerBaseReview } : {}),
    ...(request.automation?{automation:request.automation}:{}),
    ...(request.predecessor?{predecessorSha256:sha256(canonicalJson(request.predecessor))}:{}) }));
}
function held(value: { id: string; publicId: string; slug: string }, reason: SafeHeldProduct['reason']): SafeHeldProduct {
  return { id:value.id,publicId:value.publicId,slug:value.slug,path:`/gifts/${value.slug}`,title:'Gift currently unavailable',
    description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason };
}
async function prepare(db: CatalogD1, owner: MutationOwner, input: ApprovedCohortRequest,
  beforeSeal?:(owner:MutationOwner,revision:ApprovedCohortRevision)=>Promise<void>) {
  owner = structuredClone(owner);
  const request = structuredClone(input); const operationKey = approvedCohortOperationKey(request);
  if (owner.phase !== 'freezing' || owner.operationKey !== operationKey || owner.environment !== request.scope.environment
    || owner.indexName !== request.scope.indexName) throw new Error('cohort_owner_mismatch');
  await db.batch([mutationAssertion(db,owner,['freezing'])]);
  // Reconstruct from immutable D1, never from an expired workspace body. This
  // independently authenticates every private identity, not just visible rows.
  const predecessor=request.predecessor?await (await import('../../scripts/catalog/permanent-catalog-seal.ts')).readCatalogPredecessor({
    db,owner,seal:request.predecessor,approval:request.approval,approvalSha256:request.approvalSha256,
    ...(request.ownerBaseReview ? { ownerBaseReview: request.ownerBaseReview } : {}),...(request.automation?{automation:request.automation}:{})}):undefined;
  const source = await readPruningSource(db,request.previous,request.context,owner);
  const revision = request.publicationRevision??request.approval.catalogRevision;
  const existing = (await db.prepare('SELECT created_at FROM catalog_revisions WHERE revision=?').bind(revision).all()).results[0];
  // Reconstruct a sealed candidate at its original observation time. This does
  // not renew display rights: serving resolves finite overlays at real time.
  const now = new Date(existing&&predecessor?canonicalTime(existing.created_at):source.observedAt); const cutoff = Date.parse(request.context.cutoff);
  if (now.getTime() < Date.parse(owner.capturedAt) || cutoff <= now.getTime()
    || cutoff - Date.parse(owner.capturedAt) > 26*3600000) throw new Error('cohort_window_elapsed');
  const extra = await readApprovedCurrentRows(db,request.approval.changes.map(value => value.publicId),owner,false,undefined,request.ownerBaseReview,request.automation);
  const full = new Map(extra.rows.map(row => [String(row.public_id),row]));
  const current = new Map([...source.current,...extra.current].map(row => [String(row.public_id),row]));
  const projection = new Map(source.projection.map(row => [String(row.public_id),row]));
  const unavailable=new Set([...current].filter(([,row])=>confirmedRetailUnavailable(row)).map(([id])=>id));
  const approved = new Map<string,PublicCatalogProduct>();
  const changed = new Map(request.approval.changes.map(value => [value.publicId,value]));
  const priorBases=new Set(source.snapshot.products.filter(persistentPublicProduct).map(p=>p.publicId));
  const publicDuplicate=ownerBasePublicDuplicate(request.ownerBaseReview,source.snapshot);
  if(publicDuplicate&&(!predecessor?.inventory.some(p=>p.publicId===publicDuplicate.keeperPublicId
    &&p.productSha256===publicDuplicate.keeperProductSha256&&p.privateStateSha256===publicDuplicate.keeperPrivateStateSha256)))
    throw Error('cohort_owner_base_keeper_changed');
  const exactBaseTitles=new Set(source.snapshot.products.map(p=>exactOwnerBaseTitle(p.title)));
  // Daily10 plus Monday20 independently pinned operation IDs. Vector proof rebuilds this
  // seal repeatedly; one bounded read avoids an N+1 provider request per change.
  const operationIds = [...new Set(request.approval.changes.map(value => value.operationId))];
  const receipts = new Map((request.automation?await readAutomationOperationReceipts(db,owner,operationIds,request.approval.runId)
    :request.ownerBaseReview ? await readOwnerBaseOperationReceipts(db,owner,operationIds) : operationIds.length ? (await db.prepare(`SELECT * FROM catalog_maintenance_operations
    WHERE operation_id IN (SELECT value FROM json_each(?)) OR (run_id=? AND json_extract(result_json,'$.kind')='new-product-slug-repair-v1')`)
    .bind(JSON.stringify(operationIds),request.approval.runId).all()).results : [])
    .map(row => [String(row.operation_id), row]));
  for (const original of request.approval.changes) {
    const row = full.get(original.publicId)!;
    const change=effectiveSlugApproval(original,[...receipts.values()],row,owner,request);
    const receipt = receipts.get(change.operationId);
    if (row.catalog_revision !== request.approval.catalogRevision || sha256(canonicalJson(row)) !== change.productSha256
      || row.public_display_json !== null && typeof row.public_display_json !== 'string'
      || sha256(row.public_display_json === null ? 'null' : String(row.public_display_json)) !== change.displaySha256
      || !receipt || receipt.input_sha256 !== change.inputSha256 || receipt.run_id !== request.approval.runId
      || receipt.catalog_revision !== request.approval.catalogRevision || receipt.environment !== owner.environment || receipt.index_name !== owner.indexName
      || !JSON.parse(String(receipt.changes_json)).some((value: Row) => value.productId === row.id && value.afterSha256 === change.productSha256))
      throw new Error('cohort_approval_changed');
    if(request.automation){
      const binding=request.automation.products.find(p=>p.publicId===original.publicId);
      const source=receipts.get(original.operationId);
      if(!binding||binding.id!==row.id||source?.generation!==request.automation.writerGeneration
        ||source.run_id!==request.automation.runId)throw Error('automation_cohort_changed');
    }
    if (request.ownerBaseReview) {
      const result = JSON.parse(String(receipt.result_json));
      if(result.kind!=='held-catalog-resolution-v1'||result.planSha256!==request.ownerBaseReview.resolutionPlanSha256)throw Error('cohort_owner_base_changed');
      if(change.publicId===publicDuplicate?.publicId){
        if(row.id!==publicDuplicate.id||row.duplicate_of_product_id!==publicDuplicate.keeperId||row.editorial_status!=='duplicate'
          ||row.public_display_json!==null||row.is_active!==1)throw Error('cohort_owner_base_changed');
        current.get(change.publicId)!.approval_operation_json=canonicalJson(receipt);continue;
      }
      const product = validatePublicCatalogProduct(JSON.parse(String(row.public_display_json)),now);
      const rights = JSON.parse(String(row.rights_json));
      const baseRights = rights.persistent ?? rights;
      if (product.eligibleUntil !== null || product.indexable || product.editorialWriteup
        || ['title','description','imageUrl','affiliateUrl'].some(field => !['owned','licensed'].includes(baseRights[field]?.basis)
          || baseRights[field]?.expiresAt || !String(baseRights[field]?.reference).includes(request.ownerBaseReview!.authorizationSha256)))
        throw Error('cohort_owner_base_changed');
      const title=exactOwnerBaseTitle(product.title);
      if(exactBaseTitles.has(title))throw Error('cohort_owner_base_duplicate');
      exactBaseTitles.add(title);
    }
    current.get(change.publicId)!.approval_operation_json = canonicalJson(receipt);
    try {
      const product = validatePublicCatalogProduct(JSON.parse(String(row.public_display_json)),now);
      checkCurrent(product,{ source_facts_hash:row.source_facts_hash },current.get(change.publicId)!,now);
      if (catalogDisplayDeadline(product) <= cutoff) throw new Error('expired');
      // A permanent catalog never replaces cleared pages with finite-only copy,
      // or admits new identities by inferring permanent rights from a fetch.
      if(priorBases.has(change.publicId)&&!persistentPublicProduct(product))throw new Error('permanent_base_missing');
      approved.set(change.publicId,product);
    } catch { /* A reviewed mutation is not a fresh availability/rights grant. */ }
  }
  const products: PublicCatalogProduct[] = []; const safeHeld: SafeHeldProduct[] = [];
  const seen = new Set<string>();
  for (const prior of source.snapshot.products) {
    seen.add(prior.publicId);
    if(unavailable.has(prior.publicId)){safeHeld.push(held(prior,'unavailable'));continue;}
    if (changed.has(prior.publicId)) {
      const value = approved.get(prior.publicId);
      if (value) products.push(value); else safeHeld.push(held(prior,prior.publicId===publicDuplicate?.publicId?'duplicate':'editorial_hold'));
    } else {
      try {
        checkCurrent(prior,projection.get(prior.publicId)!,current.get(prior.publicId)!,now);
        if (catalogDisplayDeadline(prior) <= cutoff) throw new Error('expired');
        // Do not re-pin expired supplier fields into a later prepared artifact.
        // The independently cleared base keeps its exact identity/copy/grants.
        products.push(prior.eligibleUntil!==null&&Date.parse(prior.eligibleUntil)<=now.getTime()
          ?persistentPublicProduct(prior)??prior:prior);
      } catch { safeHeld.push(held(prior,catalogDisplayDeadline(prior) <= cutoff ? 'expired' : 'editorial_hold')); }
    }
  }
  for (const prior of source.snapshot.heldProducts) {
    seen.add(prior.publicId);
    if(prior.reason==='unavailable'&&!confirmedRetailAvailable(current.get(prior.publicId)!)){safeHeld.push(held(prior,'unavailable'));continue;}
    const value = approved.get(prior.publicId);
    if (value&&(!priorBases.size||persistentPublicProduct(value))) products.push(value); else safeHeld.push(held(prior,prior.reason));
  }
  for (const change of request.approval.changes) if (!seen.has(change.publicId)) {
    const product = approved.get(change.publicId);
    if (product&&(!priorBases.size||persistentPublicProduct(product))) products.push(product);
    else { const row=full.get(change.publicId)!;safeHeld.push(held({id:String(row.id),publicId:change.publicId,slug:String(row.slug)},'editorial_hold')); }
  }
  const stable = new Set(products.filter(value=>priorBases.has(value.publicId)&&persistentPublicProduct(value)).map(value=>value.publicId));
  const preserved=products.filter(value=>stable.has(value.publicId));
  const preferred=(value:PublicCatalogProduct)=>persistentPublicProduct(value)??value;
  const candidates=products.filter(value=>!stable.has(value.publicId)
    && !preserved.some(prior=>areNearDuplicateTitles(preferred(prior).title,preferred(value).title)));
  // Successor discovery already compared actual photos before admission. A
  // title-only second guess cannot silently undo those distinct-object reviews.
  const winners = new Set((request.ownerBaseReview||request.automation ? products.filter(value => !stable.has(value.publicId))
    : suppressNearDuplicateProducts(candidates.map(preferred))).map(value => value.publicId));
  const ready = products.filter(value => { if (stable.has(value.publicId) || winners.has(value.publicId)) return true;
    safeHeld.push(held(value,'duplicate'));return false; });
  const readyIds = new Set(ready.map(value => value.publicId));
  const removed = source.snapshot.products.filter(value => !readyIds.has(value.publicId)&&value.publicId!==publicDuplicate?.publicId);
  // An ordinary refresh must not silently withdraw an unrelated existing
  // listing, let alone dispatch a native DELETE for it. Stop before staging.
  if(removed.some(value=>persistentPublicProduct(value)&&!changed.has(value.publicId)&&!unavailable.has(value.publicId)))throw Error('cohort_unreviewed_withdrawal');
  const semantic = ready.filter(value => value.eligibleUntil !== null && Date.parse(value.eligibleUntil) > cutoff
    &&(!predecessor||changed.has(value.publicId)));
  // A changed supplier input is not absence. Keep a still-public cleared base's
  // original native history; it must not be deleted or promoted as fresh input.
  const additionalAbsentIds = request.approval.changes.filter(value => value.publicId!==publicDuplicate?.publicId
    &&!readyIds.has(value.publicId)&&!unavailable.has(value.publicId)).map(value => value.publicId);
  // Retail availability changes public membership, not persistent identity,
  // copy or original native history. Serving resolves only current public IDs.
  const targetIds=new Set([...semantic.map(p=>p.publicId),...removed.filter(p=>!unavailable.has(p.publicId)||!persistentPublicProduct(p)).map(p=>p.publicId),...additionalAbsentIds]);
  const nativeHistory=predecessor?.priorNativeHistory.map(group=>({...group,ids:group.ids.filter(id=>!targetIds.has(id))})).filter(group=>group.ids.length);
  const persistent=predecessor?{generation:owner.generation,inventory:predecessor.inventory,nativeHistory:nativeHistory!}:undefined;
  if (semantic.length + new Set([...removed.map(value=>value.publicId),...additionalAbsentIds]).size > SNAPSHOT_READ_LIMITS.identities) throw new Error('cohort_vector_proof_bound');
  const generatedAt = existing ? canonicalTime(existing.created_at) : owner.capturedAt;
  const snapshot: CatalogSnapshot = validateCatalogSnapshot({ ...source.snapshot,catalogRevision:revision,generatedAt,
    products:ready,heldProducts:safeHeld },now);
  // SQL candidate iteration is not an ordering contract. Snapshot order follows
  // the reviewed prior/envelope; private digest/CAS rows have a separate stable order.
  const sourceRows = [...current.values()].sort((a,b)=>String(a.public_id).localeCompare(String(b.public_id)));
  const globalVectorWatermark = Number(source.header.globalWatermark);
  const sourceDigest = sha256(canonicalJson({ operationKey,generatedAt,globalVectorWatermark,
    ...(persistent?{currentSha256:sha256(canonicalJson(sourceRows)),persistent}:{current:sourceRows}),prior:source.header.prior }));
  const facts = Object.fromEntries(sourceRows.map(row => [String(row.public_id),row.source_facts_hash===null?null:String(row.source_facts_hash)]));
  const packet = await createProjectionPacket(snapshot,facts,sourceDigest,now);
  const candidate={request,snapshot,packet,sourceRows,priorRow:source.header.prior as Row,
    sourceDigest,globalVectorWatermark,vectorSyncWatermark:0,operationKey,additionalAbsentIds,
    ...(persistent?{persistent,nativeHistory}: {})} as ApprovedCohortRevision;
  await beforeSeal?.(owner,candidate);
  const sealed = await sealCapturedRevision(db,owner,candidate);
  return { state:ready.length ? 'prepared' as const : 'all_held' as const,owner:sealed.owner,
    revision:{...sealed.revision,request} as ApprovedCohortRevision };
}
async function safe<T>(operation:()=>Promise<T>):Promise<T> {
  try { return await operation(); } catch(error) {
    if(error instanceof Error && error.message==='permanent_seal_changed')throw new Error('cohort_predecessor_changed');
    throw new Error(error instanceof Error && /^(cohort_|prune_)[a-z_]+$/.test(error.message) ? error.message : 'cohort_failed');
  }
}
/** Supplied observations/rights only: no merchant/model calls, new approval,
 * verification renewal, implicit ready-row scan or mutable catalog revision flip.
 * On an uncertain D1 response keep the exact request, resume the SAME ownership
 * claim/reference to read its persisted epoch, then replay. Never infer release
 * or adopt another writer's cursor. Vector unknown responses retain that owner.
 */
export function prepareApprovedCohort(...args:Parameters<typeof prepare>) { return safe(()=>prepare(...args)); }
export function approvedCohortVectorPlan(revision:ApprovedCohortRevision):PrunedVectorPlan { return prunedVectorPlan(revision); }
export function settleApprovedCohort(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision,
  readVectors:(plan:PrunedVectorPlan,signal:AbortSignal)=>Promise<PrunedVectorObservation>) {
  return safe(async()=>{
    const rebuilt=await prepareApprovedCohort(db,owner,revision.request);
    if(canonicalJson(rebuilt.revision)!==canonicalJson(revision))throw new Error('cohort_packet_changed');
    return settleCapturedRevision(db,owner,revision,readVectors);
  });
}
