import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion} from '../../lib/catalog/mutation-fence.ts';
import type {AcceptedCatalogAuthority} from '../../lib/catalog/publication.ts';
import {acceptedCatalogReceipt,encodeAcceptedCatalogAuthority} from '../../lib/catalog/publication.ts';
import {createProjectionPacket} from '../../lib/catalog/d1.ts';
import type {PrunedRevision} from '../../lib/catalog/prune-existing-revision.ts';
import type {ApprovedCatalogSeal} from './approved-catalog-seal.ts';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {readCatalogPredecessor} from './permanent-catalog-seal.ts';
import type {OwnedVectorAdapters} from './owned-vector-delivery.ts';
import {canonicalJson,sha256} from './migration.ts';

/** Authenticated unchanged catalog input for the serving-only publisher mode.
 * This is not PublishedCatalogRead's historical finite <=20 contract. */
export interface AcceptedCodeOnlyRead {
  authority:AcceptedCatalogAuthority;seal:ApprovedCatalogSeal;revision:PrunedRevision;
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
    ||revision.snapshot.products.some(p=>p.eligibleUntil!==null)
    ||revision.snapshot.products.length+revision.snapshot.heldProducts.length!==authority.identityCount
    ||revision.sourceRows.length!==authority.identityCount
    ||canonicalJson(revision.sourceRows.map(row=>row.public_id).sort())!==canonicalJson(identities)
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

/** Full existing source/native proof under the actual new writer. No source,
 * vector, observation, catalog receipt or successor write occurs. */
export async function readAcceptedCodeOnlyCatalog(options:{db:CatalogD1;owner:MutationOwner;seal:ApprovedCatalogSeal;
  authority:AcceptedCatalogAuthority;runReference:string;
  adapters?:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>}):Promise<AcceptedCodeOnlyRead>{
  const {db,owner,seal,authority,adapters}=options,operationKey=acceptedCodeOnlyOperationKey(authority);
  if(owner.operationKey!==operationKey||!['freezing','activating'].includes(owner.phase)
    ||owner.environment!==authority.request.environment||sha256(catalogSuccessorBytes(seal).toString('utf8'))!==authority.sealSha256
    ||canonicalJson(seal.publication)!==canonicalJson(authority.publication))throw Error('accepted_code_only_binding_changed');
  const approval={schemaVersion:1 as const,runId:options.runReference,catalogRevision:authority.request.sourceRevision,changes:[]};
  const original=await acceptedCatalogReceipt(db,authority);
  const proof=await readCatalogPredecessor({db,owner,seal,approval,approvalSha256:sha256(canonicalJson(approval)),servingOnly:true,adapters});
  const header=(await db.prepare(`SELECT coalesce((SELECT max(sequence) FROM vector_sync_outbox),0) watermark,
    coalesce((SELECT max(rowid) FROM publication_receipts),0) receipts,
    (SELECT count(*) FROM vector_sync_outbox WHERE status!='complete') pending`).all<Record<string,unknown>>()).results[0];
  if(!proof.snapshot||!proof.sourceRows||header?.watermark!==authority.globalVectorWatermark
    ||header.receipts!==authority.publicationReceiptWatermark||header.pending!==0)throw Error('accepted_code_only_source_changed');
  const receipt=seal.projectionReceipt,snapshot=proof.snapshot;
  // Reconstruct the already authenticated projection without another unpaged
  // full-catalog SELECT or any projection/source writes.
  const packet=await createProjectionPacket(snapshot,Object.fromEntries(proof.sourceRows.map(row=>[String(row.public_id),
    row.source_facts_hash===null?null:String(row.source_facts_hash)])),receipt.source_export_sha256,new Date(snapshot.generatedAt));
  const context={envelopeSha256:sha256(seal.envelopeJson+'\n'),snapshotSha256:seal.snapshotSha256,
    projectionSha256:receipt.projection_sha256,sourceExportSha256:receipt.source_export_sha256,
    vectorSyncWatermark:Number(JSON.parse(String(original.manifest_json)).vectorSyncWatermark),
    publicationReceiptWatermark:authority.publicationReceiptWatermark,cutoff:authority.request.cutoff,priorPublication:seal.publication};
  const revision:PrunedRevision={request:{previous:snapshot,context,scope:{environment:owner.environment,indexName:owner.indexName},codeSha:authority.request.codeSha},
    snapshot,sourceRows:proof.sourceRows,packet,sourceDigest:receipt.source_export_sha256,priorRow:original,
    operationKey,vectorSyncWatermark:context.vectorSyncWatermark,globalVectorWatermark:authority.globalVectorWatermark,
    nativeHistory:proof.nativeHistory};
  const input={authority:structuredClone(authority),seal:structuredClone(seal),revision};assertAcceptedCodeOnlyBinding(input);
  await db.batch([mutationAssertion(db,owner,[owner.phase])]);return input;
}
