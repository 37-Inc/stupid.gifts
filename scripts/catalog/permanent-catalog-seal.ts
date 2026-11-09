import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion,pendingVectorReadFence} from '../../lib/catalog/mutation-fence.ts';
import {encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import {encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {validateCatalogSnapshot,canonicalTime} from '../../lib/catalog/snapshot.ts';
import {permanentCatalogBinding,permanentSourceRows,permanentSourceInventory,permanentSourceDigest} from '../../lib/catalog/freeze-permanent-catalog.ts';
import type {PermanentCatalogRevision} from '../../lib/catalog/freeze-permanent-catalog.ts';
import type {ApprovedCohortEnvelope} from '../../lib/catalog/freeze-approved-cohort.ts';
import {validateAutomationCohort} from '../../lib/catalog/automation-cohort.ts';
import type {AutomationCohortAuthority} from '../../lib/catalog/automation-cohort.ts';
import type {ApprovedCohortRevision} from '../../lib/catalog/freeze-approved-cohort.ts';
import type {NativeHistoryBinding} from '../../lib/catalog/prune-existing-revision.ts';
import type {ApprovedCatalogSeal} from './approved-catalog-seal.ts';
import {canonicalJson,sha256} from './migration.ts';
import {createSealedSnapshotEnvelope,readOwnedProjection,SNAPSHOT_READ_LIMITS} from './export-d1-snapshot.ts';
import {readOwnedLogicalRows} from './owned-operational-import.ts';
import {isCatalogD1Rest} from './d1-write-rest.ts';
import {readNativeHistory,validateNativeHistory} from './owned-vector-delivery.ts';
import type {OwnedVectorAdapters} from './owned-vector-delivery.ts';
import {approvedBaseChangeLimit} from '../../lib/catalog/owner-base-review.ts';
import type {OwnerBaseCatalogReview} from '../../lib/catalog/owner-base-review.ts';
import {recoveredBaseLink} from './cleared-base-recovery.ts';
import {effectiveSlugApproval} from './new-product-slug-repair.ts';

type Row=Record<string,unknown>;
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
function fail():never{throw new Error('permanent_seal_changed');}
/** Safe technical metadata only. No product/source/native/installer bodies or
 * grant values are retained. A hash alone is not publication: readers require
 * the actual resolved build, verified receipt, immutable projection and owner. */
export function createPermanentCatalogSeal(revision:PermanentCatalogRevision,publication:{releaseId:string;receiptSha256:string}){
  return{schemaVersion:1 as const,kind:'permanent-catalog-seal' as const,control:permanentCatalogBinding(revision.request),
    operationKey:revision.operationKey,envelopeJson:JSON.stringify(createSealedSnapshotEnvelope(revision.snapshot)),
    snapshotSha256:revision.packet.receipt.snapshot_sha256,projectionReceipt:revision.packet.receipt,
    globalVectorWatermark:revision.globalVectorWatermark,inventory:permanentSourceInventory(revision.sourceRows),priorRow:revision.priorRow,
    request:{schemaVersion:1 as const,environment:revision.request.scope.environment,sourceRevision:revision.snapshot.catalogRevision,
      sourceDigest:revision.packet.receipt.snapshot_sha256,codeSha:revision.request.codeSha,priorReleaseId:revision.request.context.priorPublication?.releaseId??null,
      capturedAt:revision.snapshot.generatedAt,cutoff:revision.request.context.cutoff},publication};
}
export type PermanentCatalogSeal=ReturnType<typeof createPermanentCatalogSeal>;
function validate(seal:PermanentCatalogSeal){
  const envelope=JSON.parse(seal.envelopeJson),ids=[...envelope.products,...envelope.heldProducts.map((p:Row)=>p.publicId)];
  if(seal.schemaVersion!==1||seal.kind!=='permanent-catalog-seal'||!HASH.test(seal.operationKey)||!HASH.test(seal.snapshotSha256)
    ||sha256(canonicalJson(seal.control))!==seal.operationKey||!HASH.test(seal.publication.receiptSha256)
    ||Buffer.byteLength(seal.envelopeJson)>SNAPSHOT_READ_LIMITS.resultBytes||ids.length>SNAPSHOT_READ_LIMITS.identities
    ||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!UUID.test(id))||!same(envelope.products,seal.control.productOrder)
    ||seal.inventory.length!==ids.length||new Set(seal.inventory.map(p=>p.publicId)).size!==ids.length
    ||seal.inventory.some(p=>!ids.includes(p.publicId)||![p.sourceRowSha256,p.productSha256,p.privateStateSha256].every(h=>HASH.test(h)))
    ||seal.request.sourceRevision!==envelope.catalogRevision||seal.request.sourceDigest!==seal.snapshotSha256
    ||seal.projectionReceipt.snapshot_sha256!==seal.snapshotSha256||seal.projectionReceipt.catalog_revision!==envelope.catalogRevision
    ||permanentSourceDigest(seal.operationKey,envelope.generatedAt,seal.globalVectorWatermark,seal.inventory,seal.priorRow)!==seal.projectionReceipt.source_export_sha256)fail();
  return envelope;
}
export {validate as validatePermanentCatalogSeal};
/** Transient OLD snapshot bytes are verified at their actual generatedAt. They
 * are never re-pinned as new merchant data; retain only this seal across expiry. */
export async function reconstructPermanentSnapshot(db:CatalogD1,owner:MutationOwner,seal:PermanentCatalogSeal){
  const envelope=validate(seal);if(!isCatalogD1Rest(db)||!['writing','freezing'].includes(owner.phase))fail();
  const phase=owner.phase;await mutationAssertion(db,owner,[phase]).all();
  const rows=await readOwnedProjection(db,owner,envelope.catalogRevision,envelope.products,{...(phase==='writing'?{phase:'writing' as const}:{})});
  const byId=new Map(rows.map(r=>[r.public_id,r]));
  const snapshot=validateCatalogSnapshot({...envelope,products:envelope.products.map((id:string)=>JSON.parse(String(byId.get(id)?.public_display_json)))},new Date(canonicalTime(envelope.generatedAt)));
  if(sha256(`${JSON.stringify(snapshot)}\n`)!==seal.snapshotSha256)fail();
  const receipts=(await db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?').bind(envelope.catalogRevision).all<Row>()).results;
  if(receipts.length!==1||!same(receipts[0],seal.projectionReceipt))fail();
  await mutationAssertion(db,owner,[phase]).all();return snapshot;
}
/** Prior proof only, NOT a target vector settlement receipt. Genuine approved
 * maintenance changes are linked from the old product hash through actual
 * operations; they are excluded from the OLD native-preservation claim. The
 * target's ordinary proof must separately verify their current vectors. */
function predecessor(seal:PermanentCatalogSeal|ApprovedCatalogSeal){
  if(seal.kind==='permanent-catalog-seal'){
    const envelope=validate(seal),native=seal.control.native;
    return{envelope,inventory:seal.inventory,generation:seal.control.installationOwner.generation+1,request:seal.request,
      nativeHistory:[{source:native.source,revisionSha256:native.revisionSha256,planSha256:sha256(canonicalJson(native.plan)),
        ids:[...native.plan.products.map(p=>p.publicId),...native.plan.absentIds]}] as NativeHistoryBinding[]};
  }
  const p=seal.persistent,envelope=JSON.parse(seal.envelopeJson),ids=[...envelope.products,...envelope.heldProducts.map((r:Row)=>r.publicId)];
  if(seal.schemaVersion!==1||seal.kind!=='approved-catalog-seal'||!p||!seal.currentNative||!Number.isSafeInteger(p.generation)||p.generation<1
    ||ids.length>SNAPSHOT_READ_LIMITS.identities||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id))
    ||p.inventory.length!==ids.length||new Set(p.inventory.map(r=>r.publicId)).size!==ids.length
    ||p.inventory.some(r=>!ids.includes(r.publicId)||![r.sourceRowSha256,r.productSha256,r.privateStateSha256].every(h=>HASH.test(h)))
    ||!HASH.test(p.operationKey)||!HASH.test(p.sourceRowsSha256)||!HASH.test(seal.publication.receiptSha256)
    ||p.request.sourceRevision!==envelope.catalogRevision||p.request.sourceDigest!==seal.snapshotSha256
    ||seal.projectionReceipt.snapshot_sha256!==seal.snapshotSha256||seal.projectionReceipt.catalog_revision!==envelope.catalogRevision
    ||sha256(canonicalJson({operationKey:p.operationKey,generatedAt:envelope.generatedAt,globalVectorWatermark:p.globalVectorWatermark,
      currentSha256:p.sourceRowsSha256,persistent:{generation:p.generation,inventory:p.inventory,nativeHistory:p.nativeHistory},prior:p.priorRow}))!==seal.projectionReceipt.source_export_sha256)fail();
  return{envelope,inventory:p.inventory,generation:p.generation,request:p.request,
    nativeHistory:[...p.nativeHistory,...(seal.currentNative.ids.length?[seal.currentNative]:[])]};
}
export function isPersistentCatalogSeal(seal:{kind?:string;persistent?:unknown}){
  return seal.kind==='permanent-catalog-seal'||seal.kind==='approved-catalog-seal'&&Boolean(seal.persistent);
}
export async function readCatalogPredecessor(options:{db:CatalogD1;owner:MutationOwner;seal:PermanentCatalogSeal|ApprovedCatalogSeal;
  approval:ApprovedCohortEnvelope;approvalSha256:string;ownerBaseReview?:OwnerBaseCatalogReview;automation?:AutomationCohortAuthority;
  /** Explicit unchanged accepted-catalog reader; never admits changes. */
  servingOnly?:true;
  adapters?:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>}){
  const {db,owner,seal,approval,adapters}=options,prior=predecessor(seal),{envelope}=prior;
  validateNativeHistory(prior.nativeHistory);
  if(prior.nativeHistory.some(group=>group.ids.some(id=>!prior.inventory.some(row=>row.publicId===id))))fail();
  const phase=options.servingOnly?owner.phase:'freezing';
  if(options.automation){if(options.servingOnly||options.ownerBaseReview)fail();validateAutomationCohort(options.automation,approval);}
  if(options.servingOnly&&(seal.kind!=='approved-catalog-seal'||approval.changes.length!==0||options.ownerBaseReview)
    ||!['freezing','activating'].includes(phase)||owner.phase!==phase||sha256(canonicalJson(approval))!==options.approvalSha256||approval.schemaVersion!==1
    ||!options.automation&&approval.changes.length>approvedBaseChangeLimit(options.ownerBaseReview)||new Set(approval.changes.map(c=>c.publicId)).size!==approval.changes.length)fail();
  const snapshot=seal.kind==='permanent-catalog-seal'?await reconstructPermanentSnapshot(db,owner,seal)
  :await (await import('./approved-catalog-seal.ts')).readApprovedPrior(db,owner,seal,{envelopeSha256:sha256(seal.envelopeJson+'\n'),
    snapshotSha256:seal.snapshotSha256,projectionSha256:seal.projectionReceipt.projection_sha256,sourceExportSha256:seal.projectionReceipt.source_export_sha256,
    cutoff:owner.capturedAt,vectorSyncWatermark:0,publicationReceiptWatermark:0,priorPublication:seal.publication});
  const capture=()=>readOwnedLogicalRows(db,owner,{phase:phase as 'freezing'|'activating',tables:['products','catalog_maintenance_products','catalog_maintenance_operations']});
  const actual=await capture(),current=permanentSourceRows(actual),inventory=permanentSourceInventory(current);
  const old=new Map(prior.inventory.map(r=>[r.publicId,r])),changed:string[]=[];
  const products=new Map(actual.products.map(p=>[p.public_id,p]));
  const priorIdentities={products:prior.inventory,heldProducts:[]};
  const effective=approval.changes.map(c=>effectiveSlugApproval(c,actual.catalog_maintenance_operations,products.get(c.publicId)!,owner,{approval,previous:priorIdentities}));
  const changes=new Map(effective.map(c=>[c.publicId,c]));
  const repairs=new Set(effective.filter((c,i)=>c.operationId!==approval.changes[i].operationId).map(c=>c.operationId));
  for(const change of effective){const product=products.get(change.publicId),ops=actual.catalog_maintenance_operations.filter(op=>op.operation_id===change.operationId),op=ops[0];
    if(!product||ops.length!==1||product.catalog_revision!==approval.catalogRevision||sha256(canonicalJson(product))!==change.productSha256
      ||sha256(String(product.public_display_json??'null'))!==change.displaySha256||op.input_sha256!==change.inputSha256||op.run_id!==approval.runId
      ||op.catalog_revision!==approval.catalogRevision||op.environment!==owner.environment||op.index_name!==owner.indexName
      ||!JSON.parse(String(op.changes_json)).some((c:Row)=>c.productId===product.id&&c.afterSha256===change.productSha256))fail();}
  if(current.length<old.size||new Set(current.map(r=>r.public_id)).size!==current.length||prior.inventory.some(p=>!inventory.some(r=>r.publicId===p.publicId)))fail();
  for(const row of inventory){const before=old.get(row.publicId);if(before&&same(row,before))continue;
    const approved=changes.get(row.publicId);
    const recovered=!approved&&before?recoveredBaseLink(actual.catalog_maintenance_operations,{publicId:row.publicId,
      productId:products.get(row.publicId)?.id,productSha256:row.productSha256,priorProductSha256:before.productSha256,
      priorReceiptSha256:seal.publication.receiptSha256,priorSnapshotSha256:seal.snapshotSha256,priorGeneration:prior.generation,owner,runId:approval.runId}):null;
    if(approved?approved.productSha256!==row.productSha256:!recovered)fail();
    const product=current.find(p=>p.public_id===row.publicId)!;let hash:string|null=before?.productSha256??null,steps=0,last='';
    const links=actual.catalog_maintenance_operations.filter(op=>(op.run_id===approval.runId||recovered)&&op.environment===owner.environment&&op.index_name===owner.indexName
      &&Number(op.generation)>prior.generation&&(Number(op.generation)<owner.generation||op.operation_id===recovered?.operation_id||repairs.has(String(op.operation_id)))
      &&String(op.database_time)>=envelope.generatedAt&&(String(op.database_time)<=owner.capturedAt||op.operation_id===recovered?.operation_id||repairs.has(String(op.operation_id))))
      .flatMap(op=>(JSON.parse(String(op.changes_json)) as Row[]).filter(c=>c.productId===product.id).map(c=>({op,c})));
    while(hash!==row.productSha256){const matches=links.filter(l=>l.c.beforeSha256===hash);if(matches.length!==1||++steps>4)fail();
      hash=String(matches[0].c.afterSha256);last=String(matches[0].op.operation_id);}
    const finalOperation=approved?.operationId??String(recovered!.operation_id);
    if(last!==finalOperation&&links.some(l=>l.op.operation_id===finalOperation&&l.c.beforeSha256===hash&&l.c.afterSha256===hash))last=finalOperation;
    if(last!==finalOperation)fail();if(approved)changed.push(row.publicId);
  }
  const exact=(table:string,row:Row)=>{const keys=Object.keys(row);if(!keys.length||keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))fail();
    return db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM ${table}
    WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')}) THEN 'true' ELSE 'permanent_seal_changed' END)`).bind(...keys.map(k=>row[k]));};
  const receipts=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(seal.publication.releaseId).all<Row>()).results;
  const builds=(await db.prepare("SELECT * FROM catalog_build_requests WHERE release_id=? AND state='resolved' LIMIT 2").bind(seal.publication.releaseId).all<Row>()).results;
  const outbox=(await db.prepare("SELECT * FROM publication_outbox WHERE release_id=? AND state='verified' LIMIT 2").bind(seal.publication.releaseId).all<Row>()).results;
  if(receipts.length!==1||builds.length!==1||outbox.length!==1||sha256(canonicalJson(receipts[0]))!==seal.publication.receiptSha256
    ||builds[0].request_json!==encodeBuildRequest(prior.request)||builds[0].request_id!==sha256(encodeBuildRequest(prior.request))
    ||builds[0].environment!==owner.environment||builds[0].source_revision!==envelope.catalogRevision
    ||!builds[0].lease_token||!builds[0].run_reference||!builds[0].version_reference||!outbox[0].completed_token
    ||outbox[0].dispatch_reference!==`version:${builds[0].version_reference}`)fail();
  const intent=JSON.parse(String(receipts[0].manifest_json));
  if(encodePublicationIntent(intent)!==receipts[0].manifest_json||outbox[0].intent_json!==receipts[0].manifest_json
    ||intent.releaseId!==seal.publication.releaseId||intent.catalogRevision!==envelope.catalogRevision||intent.codeSha!==prior.request.codeSha
    ||receipts[0].catalog_revision!==intent.catalogRevision||receipts[0].code_sha!==intent.codeSha
    ||intent.catalogSnapshotSha256!==seal.snapshotSha256)fail();
  if(seal.kind==='approved-catalog-seal'){
    const p=seal.persistent!,native=seal.currentNative!;
    const saved=(await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').bind(native.source.deliveryId).all<Row>()).results;
    const proof=saved[0]&&JSON.parse(String(saved[0].request_json));
    if(saved.length!==1||sha256(canonicalJson(saved[0]))!==native.source.deliverySha256||!same(native.source.releaseId,seal.publication.releaseId)
      ||native.source.receiptSha256!==seal.publication.receiptSha256||saved[0].generation!==p.generation
      ||proof.kind!=='approved-cohort-plan'||proof.revisionSha256!==native.revisionSha256||proof.sourceRowsSha256!==p.sourceRowsSha256
      ||proof.planSha256!==native.planSha256||sha256(canonicalJson(proof.plan))!==native.planSha256
      ||proof.plan.catalogRevision!==envelope.catalogRevision||proof.plan.snapshotSha256!==seal.snapshotSha256
      ||!same(proof.plan.history,p.nativeHistory)||!same(native.ids,[...proof.plan.products.map((r:Row)=>r.publicId),...proof.plan.absentIds]))fail();
  }
  const check=async()=>{await db.batch([mutationAssertion(db,owner,[phase as 'freezing'|'activating']),exact('publication_receipts',receipts[0]),
    exact('catalog_build_requests',builds[0]),exact('publication_outbox',outbox[0]),exact('catalog_projection_receipts',seal.projectionReceipt),
    db.prepare("SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete') THEN 'true' ELSE 'permanent_seal_changed' END)"),
    db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_revisions WHERE revision=? AND status='published' AND source_export_sha256=?)
      AND (SELECT release_id FROM publication_receipts ORDER BY rowid DESC LIMIT 1)=? THEN 'true' ELSE 'permanent_seal_changed' END)`)
      .bind(prior.request.sourceRevision,seal.projectionReceipt.source_export_sha256,seal.publication.releaseId),
    mutationAssertion(db,owner,[phase as 'freezing'|'activating'])]);};
  const preservedDuplicate=options.ownerBaseReview?.publicDuplicate;
  if(preservedDuplicate){
    const duplicate=products.get(preservedDuplicate.publicId),keeper=inventory.find(p=>p.publicId===preservedDuplicate.keeperPublicId);
    if(!duplicate||duplicate.id!==preservedDuplicate.id||duplicate.duplicate_of_product_id!==preservedDuplicate.keeperId
      ||products.get(preservedDuplicate.keeperPublicId)?.id!==preservedDuplicate.keeperId
      ||!keeper||keeper.productSha256!==preservedDuplicate.keeperProductSha256||keeper.privateStateSha256!==preservedDuplicate.keeperPrivateStateSha256)fail();
  }
  const nativeHistory=prior.nativeHistory.map(group=>({...group,ids:group.ids.filter(id=>!changed.includes(id)||id===preservedDuplicate?.publicId)})).filter(group=>group.ids.length);
  await check();const preservedIds=adapters?await readNativeHistory({db,owner,history:nativeHistory,adapters}):[];
  await check();
  // Re-read the whole current capture, not an old source body from a workspace.
  if(!same(permanentSourceInventory(permanentSourceRows(await capture())),inventory))fail();
  // Changed members are candidates, not verified current input. The next cohort
  // removes actual replacements/absences before separately proving retained history.
  return{state:adapters?'verified' as const:'source_verified' as const,snapshotSha256:seal.snapshotSha256,preservedIds,changedIds:changed,inventory,nativeHistory,
    priorNativeHistory:structuredClone(prior.nativeHistory),
    priorNativeIds:prior.nativeHistory.flatMap(group=>group.ids),
    ...(options.servingOnly?{snapshot,sourceRows:current}: {})};
}
export function readPermanentCatalogPrior(options:Parameters<typeof readCatalogPredecessor>[0]&{seal:PermanentCatalogSeal;
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>}){
  return readCatalogPredecessor(options);
}
/** Full private-source CAS outside short native/provider observations. */
export async function assertApprovedCatalogInventory(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision,signal?:AbortSignal){
  if(!revision.persistent)return;
  const started=Date.now(),products=revision.persistent.inventory.length,progress=(stage:'start'|'complete')=>console.info(JSON.stringify({state:'publication_progress',phase:'inventory',
    stage,products,elapsedMs:Date.now()-started}));
  progress('start');
  signal?.throwIfAborted();
  if(owner.generation!==revision.persistent.generation||owner.operationKey!==revision.operationKey
    ||!same(revision.nativeHistory,revision.persistent.nativeHistory)
    ||!['freezing','activating'].includes(owner.phase))fail();
  const actual=await readOwnedLogicalRows(db,owner,{phase:owner.phase as 'freezing'|'activating',signal,
    tables:['products','catalog_maintenance_products','catalog_maintenance_operations'],...(owner.phase==='freezing'?{pendingVector:true as const}:{})});
  if(!same(permanentSourceInventory(permanentSourceRows(actual)),revision.persistent.inventory))fail();
  const fence=pendingVectorReadFence(owner);
  await db.prepare(`SELECT json(CASE WHEN ${fence.sql} THEN 'true' ELSE 'mutation_fenced' END)`).bind(...fence.params).all({signal});
  progress('complete');
}
