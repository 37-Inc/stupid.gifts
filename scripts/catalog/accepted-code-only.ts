import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion} from '../../lib/catalog/mutation-fence.ts';
import type {AcceptedCatalogAuthority} from '../../lib/catalog/publication.ts';
import {acceptedCatalogReceipt,encodeAcceptedCatalogAuthority} from '../../lib/catalog/publication.ts';
import {createProjectionPacket} from '../../lib/catalog/d1.ts';
import type {AcceptedPublishedRevision} from '../../lib/catalog/prune-existing-revision.ts';
import {prunedVectorIds} from '../../lib/catalog/prune-existing-revision.ts';
import type {ApprovedCatalogSeal} from './approved-catalog-seal.ts';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {readOwnedProjection} from './export-d1-snapshot.ts';
import {validateCatalogSnapshot} from '../../lib/catalog/snapshot.ts';
import type {OwnedVectorAdapters} from './owned-vector-delivery.ts';
import {canonicalJson,sha256} from './migration.ts';

/** Authenticated unchanged catalog input for the serving-only publisher mode.
 * This is not PublishedCatalogRead's historical finite <=20 contract. */
export interface AcceptedCodeOnlyRead {
  authority:AcceptedCatalogAuthority;seal:ApprovedCatalogSeal;revision:AcceptedPublishedRevision;
}
/** Exact resolved-control replay only. It cannot build, upload or finish an
 * activating publication and contains no newly retained catalog bodies. */
export type AcceptedCodeOnlyControl=Omit<AcceptedCodeOnlyRead,'revision'>&{revision:null};
export function acceptedCodeOnlyOperationKey(authority:AcceptedCatalogAuthority){return sha256(encodeAcceptedCatalogAuthority(authority));}
export function assertAcceptedCodeOnlyBinding(input:AcceptedCodeOnlyRead|AcceptedCodeOnlyControl){
  const {authority,seal,revision}=input;
  encodeAcceptedCatalogAuthority(authority);
  const envelope=JSON.parse(seal.envelopeJson);
  if(sha256(catalogSuccessorBytes(seal).toString('utf8'))!==authority.sealSha256||!seal.persistent||!seal.currentNative
    ||canonicalJson(authority.publication)!==canonicalJson(seal.publication)
    ||seal.snapshotSha256!==authority.request.sourceDigest
    ||seal.projectionReceipt.catalog_revision!==authority.request.sourceRevision
    ||seal.projectionReceipt.created_at!==authority.request.capturedAt
    ||envelope.products.length+envelope.heldProducts.length!==authority.identityCount)throw Error('accepted_code_only_binding_changed');
  if(revision===null)return;
  const identities=[...revision.snapshot.products,...revision.snapshot.heldProducts].map(p=>p.publicId).sort();
  if(revision.operationKey!==acceptedCodeOnlyOperationKey(authority)
    ||revision.snapshot.catalogRevision!==authority.request.sourceRevision
    ||revision.snapshot.generatedAt!==authority.request.capturedAt
    ||sha256(`${JSON.stringify(revision.snapshot)}\n`)!==authority.request.sourceDigest
    ||revision.snapshot.products.length+revision.snapshot.heldProducts.length!==authority.identityCount
    ||revision.evidence!=='accepted-public-projection'||'sourceRows' in revision
    ||canonicalJson(identities)!==canonicalJson([...envelope.products,...envelope.heldProducts.map((p:{publicId:string})=>p.publicId)].sort())
    ||canonicalJson(revision.packet.receipt)!==canonicalJson(seal.projectionReceipt)
    ||revision.sourceDigest!==seal.projectionReceipt.source_export_sha256
    ||canonicalJson(revision.nativeHistory)!==canonicalJson([...seal.persistent.nativeHistory,...(seal.currentNative.ids.length?[seal.currentNative]:[])])
    ||revision.globalVectorWatermark!==authority.globalVectorWatermark
    ||revision.request.context.publicationReceiptWatermark!==authority.publicationReceiptWatermark)
    throw Error('accepted_code_only_binding_changed');
}
export function acceptedCodeOnlyControl(seal:ApprovedCatalogSeal,authority:AcceptedCatalogAuthority):AcceptedCodeOnlyControl{
  const input={seal,authority,revision:null};assertAcceptedCodeOnlyBinding(input);return input;
}

/** Fresh accepted PUBLIC bytes, not mutable unpublished source. Original native
 * journals stay authenticated behind unchanged index/publication barriers. */
export async function readAcceptedCodeOnlyCatalog(options:{db:CatalogD1;owner:MutationOwner;seal:ApprovedCatalogSeal;
  authority:AcceptedCatalogAuthority;runReference:string;
  adapters?:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>}):Promise<AcceptedCodeOnlyRead>{
  const {db,owner,seal,authority,adapters}=options,operationKey=acceptedCodeOnlyOperationKey(authority);
  if(owner.operationKey!==operationKey||!['freezing','activating'].includes(owner.phase)
    ||owner.environment!==authority.request.environment||sha256(catalogSuccessorBytes(seal).toString('utf8'))!==authority.sealSha256
    ||canonicalJson(seal.publication)!==canonicalJson(authority.publication))throw Error('accepted_code_only_binding_changed');
  void options.runReference;void adapters;
  await mutationAssertion(db,owner,[owner.phase]).all();
  const original=await acceptedCatalogReceipt(db,authority);
  const envelope=JSON.parse(seal.envelopeJson),rows=await readOwnedProjection(db,owner,envelope.catalogRevision,envelope.products,
    {...(owner.phase==='activating'?{phase:'activating' as const}:{}),approvedRecovery:true});
  const byId=new Map(rows.map(row=>[row.public_id,row]));
  const snapshot=validateCatalogSnapshot({...envelope,products:envelope.products.map((id:string)=>JSON.parse(String(byId.get(id)?.public_display_json)))},new Date(envelope.generatedAt));
  const receiptRows=(await db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?').bind(envelope.catalogRevision).all()).results;
  if(sha256(JSON.stringify(snapshot)+'\n')!==seal.snapshotSha256||receiptRows.length!==1
    ||canonicalJson(receiptRows[0])!==canonicalJson(seal.projectionReceipt))throw Error('accepted_code_only_source_changed');
  const nativeHistory=[...seal.persistent!.nativeHistory,...(seal.currentNative!.ids.length?[seal.currentNative!]:[])];
  // Journal hashes authenticate all original plan/owner/evidence bytes without
  // retrieving product source or vector payloads. No historical proof is relabeled.
  for(const binding of nativeHistory){
    const result=await db.batch([db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').bind(binding.source.deliveryId),
      db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(binding.source.releaseId)]) as Array<{results:Record<string,unknown>[]}>;
    if(!Array.isArray(result)||result.length!==2)throw Error('accepted_code_only_native_changed');
    const [journals,receipts]=result;
    const row=journals.results[0],receipt=receipts.results[0],request=row&&JSON.parse(String(row.request_json));
    const base=row&&JSON.parse(String(row.owner_json));
    if(journals.results.length!==1||receipts.results.length!==1||sha256(canonicalJson(row))!==binding.source.deliverySha256
      ||sha256(canonicalJson(receipt))!==binding.source.receiptSha256||row.status!=='complete'||row.disposition!=='verified'
      ||row.environment!==owner.environment||row.index_name!==owner.indexName||base.generation>=owner.generation
      ||request.revisionSha256!==binding.revisionSha256||request.planSha256!==binding.planSha256
      ||sha256(canonicalJson(request.plan))!==binding.planSha256||binding.ids.some(id=>!prunedVectorIds(request.plan).includes(id)))
      throw Error('accepted_code_only_native_changed');
  }
  const header=(await db.prepare(`SELECT coalesce((SELECT max(sequence) FROM vector_sync_outbox),0) watermark,
    coalesce((SELECT max(rowid) FROM publication_receipts),0) receipts,
    (SELECT count(*) FROM vector_sync_outbox WHERE status!='complete') pending`).all<Record<string,unknown>>()).results[0];
  if(header?.watermark!==authority.globalVectorWatermark
    ||header.receipts!==authority.publicationReceiptWatermark||header.pending!==0)throw Error('accepted_code_only_source_changed');
  const receipt=seal.projectionReceipt;
  // Reconstruct the already authenticated projection without another unpaged
  // full-catalog SELECT or any projection/source writes.
  const packet=await createProjectionPacket(snapshot,Object.fromEntries(rows.map(row=>[String(row.public_id),
    row.source_facts_hash===null?null:String(row.source_facts_hash)])),receipt.source_export_sha256,new Date(snapshot.generatedAt));
  if(canonicalJson(packet.receipt)!==canonicalJson(receipt)||canonicalJson(packet.rows)!==canonicalJson([...rows].sort((a,b)=>String(a.public_id).localeCompare(String(b.public_id)))))
    throw Error('accepted_code_only_source_changed');
  const context={envelopeSha256:sha256(seal.envelopeJson+'\n'),snapshotSha256:seal.snapshotSha256,
    projectionSha256:receipt.projection_sha256,sourceExportSha256:receipt.source_export_sha256,
    vectorSyncWatermark:Number(JSON.parse(String(original.manifest_json)).vectorSyncWatermark),
    publicationReceiptWatermark:authority.publicationReceiptWatermark,cutoff:authority.request.cutoff,priorPublication:seal.publication};
  const revision:AcceptedPublishedRevision={evidence:'accepted-public-projection',request:{previous:snapshot,context,scope:{environment:owner.environment,indexName:owner.indexName},codeSha:authority.request.codeSha},
    snapshot,packet,sourceDigest:receipt.source_export_sha256,priorRow:original,
    operationKey,vectorSyncWatermark:context.vectorSyncWatermark,globalVectorWatermark:authority.globalVectorWatermark,
    nativeHistory};
  const input={authority:structuredClone(authority),seal:structuredClone(seal),revision};assertAcceptedCodeOnlyBinding(input);
  await db.batch([mutationAssertion(db,owner,[owner.phase])]);return input;
}
