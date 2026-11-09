import {validateCatalogSnapshot} from '../../lib/catalog/snapshot.ts';
import {earliestDisplayExpiry} from '../../lib/catalog/display.ts';
import {validateAutomationCohort} from '../../lib/catalog/automation-cohort.ts';
import {encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {canonicalJson,sha256} from './migration.ts';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {validatePermanentCatalogSeal} from './permanent-catalog-seal.ts';
import type {PermanentCatalogSeal} from './permanent-catalog-seal.ts';
import type {PublicationControl} from './run-workspace.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import type {approvedRevisionControl} from './approved-catalog-seal.ts';

const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const receiptKeys=['catalog_revision','snapshot_sha256','projection_sha256','source_export_sha256','product_count','created_at'];
const exact=(v:unknown,keys:string[])=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).sort().join(',')===[...keys].sort().join(','));
function fail():never{throw Error('run_workspace_permanent_control');}
function technical(value:unknown,depth=0):void{
  if(depth>20)fail();
  if(Array.isArray(value)){if(value.length>20000)fail();value.forEach(v=>technical(v,depth+1));}
  else if(value&&typeof value==='object')for(const [key,v]of Object.entries(value)){
    if(/^(?:sourceRows|sourceFacts|source_facts|source_record_json|embedding|nativeBase64|values|rawBody)$/.test(key))fail();
    technical(v,depth+1);
  }
}
function nativeHistory(value:unknown){
  if(!Array.isArray(value)||value.length>10000)fail();
  for(const v of value)if(!exact(v,['source','revisionSha256','planSha256','ids'])
    ||!exact(v.source,['releaseId','receiptSha256','deliveryId','deliverySha256'])
    ||![v.revisionSha256,v.planSha256,v.source.receiptSha256,v.source.deliveryId,v.source.deliverySha256].every(hash)
    ||typeof v.source.releaseId!=='string'||!/^[a-zA-Z0-9._:-]{1,200}$/.test(v.source.releaseId)
    ||!Array.isArray(v.ids)||v.ids.length>10000||!v.ids.every(uuid))fail();
}

/** Classify the existing registered control, not a supplier body or permission
 * to extend one. Full request/source hashes are independently rechecked when
 * current D1 rows reconstruct the original revision under the exact owner. */
export function activatedPermanentRevisionControl(value:unknown,p:PublicationControl,owner:MutationOwner|undefined=p.permit?.mutationOwner){
  const v=value as ReturnType<typeof approvedRevisionControl>,r=v?.revision,q=v?.request;
  if(!exact(v,['schemaVersion','kind','revision','request','sourceIds','sourceRowsSha256','revisionSha256'])
    ||v.schemaVersion!==1||v.kind!=='approved-revision-control'||!hash(v.sourceRowsSha256)||!hash(v.revisionSha256)
    ||!r||!exact(r,['snapshot','packet','priorRow','sourceDigest','globalVectorWatermark','vectorSyncWatermark','operationKey',
      'persistent',...(r.additionalAbsentIds===undefined?[]:['additionalAbsentIds']),...(r.nativeHistory===undefined?[]:['nativeHistory'])])
    ||!r.persistent||!exact(r.persistent,['generation','inventory','nativeHistory'])
    ||r.persistent.generation!==owner?.generation||r.operationKey!==owner?.operationKey
    ||!Array.isArray(v.sourceIds)||v.sourceIds.length>10000||new Set(v.sourceIds).size!==v.sourceIds.length
    ||!v.sourceIds.every(uuid)
    ||!q||!exact(q,['schemaVersion','kind','request','previous','requestSha256'])
    ||q.schemaVersion!==1||q.kind!=='approved-request-control'||!hash(q.requestSha256)
    ||!exact(q.request,['scope','codeSha','context','approval','approvalSha256',...(q.request.predecessor?['predecessor']:[]),...(q.request.automation?['automation']:[])])
    ||!exact(q.request.scope,['environment','indexName'])
    ||!exact(q.request.context,['envelopeSha256','snapshotSha256','projectionSha256','sourceExportSha256',
      'vectorSyncWatermark','publicationReceiptWatermark','cutoff','priorPublication'])
    ||q.request.codeSha!==p.intent?.codeSha||!hash(q.request.approvalSha256)
    ||sha256(canonicalJson(q.request.approval))!==q.request.approvalSha256
    ||!exact(q.previous,['envelopeJson','snapshotSha256','projectionReceipt'])||!hash(q.previous.snapshotSha256)
    ||!exact(q.previous.projectionReceipt,receiptKeys))fail();
  technical(q);technical(r.persistent);technical(r.priorRow);
  if(q.request.predecessor){
    if(q.request.predecessor.kind==='approved-catalog-seal')catalogSuccessorBytes(q.request.predecessor);
    else{
      if(!exact(q.request.predecessor,['schemaVersion','kind','control','operationKey','envelopeJson','snapshotSha256',
        'projectionReceipt','globalVectorWatermark','inventory','priorRow','request','publication']))fail();
      validatePermanentCatalogSeal(q.request.predecessor as PermanentCatalogSeal);
    }
  }
  nativeHistory(r.nativeHistory??[]);nativeHistory(r.persistent.nativeHistory);
  if(canonicalJson(r.nativeHistory??[])!==canonicalJson(r.persistent.nativeHistory)
    ||!Array.isArray(r.persistent.inventory)||r.persistent.inventory.length!==v.sourceIds.length
    ||r.persistent.inventory.some(v=>!exact(v,['publicId','sourceRowSha256','productSha256','privateStateSha256'])
      ||!uuid(v.publicId)||![v.sourceRowSha256,v.productSha256,v.privateStateSha256].every(hash))
    ||r.additionalAbsentIds!==undefined&&(!Array.isArray(r.additionalAbsentIds)||!r.additionalAbsentIds.every(uuid))
    ||!exact(r.priorRow,['release_id','catalog_revision','code_sha','completed_at','manifest_json'])
    ||typeof r.priorRow.manifest_json!=='string'
    ||encodePublicationIntent(JSON.parse(r.priorRow.manifest_json))!==r.priorRow.manifest_json)fail();
  if(!exact(q.request.approval,['schemaVersion','runId','catalogRevision','changes'])||q.request.approval.schemaVersion!==1
    ||!Array.isArray(q.request.approval.changes)||!q.request.automation&&q.request.approval.changes.length>30
    ||q.request.approval.changes.some(v=>!exact(v,['publicId','operationId','inputSha256','productSha256','displaySha256'])
      ||![v.operationId,v.inputSha256,v.productSha256,v.displaySha256].every(hash)))fail();
  if(q.request.automation)validateAutomationCohort(q.request.automation,q.request.approval);
  const snapshot=validateCatalogSnapshot(r.snapshot,new Date(r.snapshot.generatedAt));
  if(!snapshot.products.length||earliestDisplayExpiry(snapshot.products)!==null
    ||snapshot.catalogRevision!==p.intent?.catalogRevision||sha256(JSON.stringify(snapshot)+'\n')!==p.intent.catalogSnapshotSha256
    ||p.build.request.sourceDigest!==p.intent.catalogSnapshotSha256||p.intent.nextExpiry!==null
    ||!exact(r.packet,['rows','receipt'])||!exact(r.packet.receipt,receiptKeys)||!Array.isArray(r.packet.rows)||r.packet.rows.length!==snapshot.products.length
    ||r.packet.receipt.snapshot_sha256!==p.intent.catalogSnapshotSha256||r.packet.receipt.source_export_sha256!==r.sourceDigest
    ||r.packet.receipt.product_count!==snapshot.products.length||r.packet.receipt.catalog_revision!==snapshot.catalogRevision
    ||snapshot.products.length+snapshot.heldProducts.length!==v.sourceIds.length
    ||sha256(JSON.stringify(r.packet.rows))!==r.packet.receipt.projection_sha256)fail();
  for(const row of r.packet.rows){
    const product=snapshot.products.find(product=>product.publicId===row.public_id);
    if(!exact(row,['catalog_revision','public_id','product_id','slug','title','description','tags','source_facts_hash','eligible_until','public_display_json','display_sha256'])
      ||!product||row.eligible_until!==product.eligibleUntil||row.public_display_json!==JSON.stringify(product)
      ||row.display_sha256!==sha256(String(row.public_display_json)))fail();
  }
  const old=JSON.parse(q.previous.envelopeJson);
  if(!exact(old,['schemaVersion','dataKind','catalogRevision','generatedAt','products','heldProducts','slugHistory'])
    ||!Array.isArray(old.products)||!old.products.every(uuid)
    ||!Array.isArray(old.heldProducts)||!Array.isArray(old.slugHistory)
    ||old.slugHistory.some((v:Record<string,unknown>)=>!exact(v,['slug','canonicalSlug','publicId'])||!uuid(v.publicId)
      ||![v.slug,v.canonicalSlug].every(value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,199}$/.test(value)))
    ||old.heldProducts.some((v:Record<string,unknown>)=>!exact(v,['id','publicId','slug','path','title','description','reason',
      ...(v.affiliateUrl===undefined?[]:['affiliateUrl'])])||v.title!=='Gift currently unavailable'
      ||v.description!=='This gift is not currently available in the curated catalog. Browse other gifts instead.'))fail();
  return v;
}

/** Numeric run statistics, model identifiers and bounded reason codes only;
 * never recover candidate/product/provider bodies from an expired phase. */
export function activatedPermanentSummary(value:unknown):Record<string,unknown>{
  if(!exact(value,['counts','timingsMs','usage','warnings']))fail();
  const walk=(v:unknown,depth=0):void=>{
    if(depth>12)fail();
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(typeof v==='string'&&/^[a-zA-Z0-9_.:/+-]{0,200}$/.test(v)&&!v.includes('://'))return;
    if(Array.isArray(v)){if(v.length>100)fail();v.forEach(item=>walk(item,depth+1));return;}
    if(v&&typeof v==='object'&&Object.keys(v).length<=100){for(const [key,entry]of Object.entries(v)){
      // Model telemetry counts embedding operations; it does not contain vector
      // values. Keep raw objects/arrays/text excluded without rejecting a count.
      const embeddingCount=key==='embedding'&&Number.isSafeInteger(entry)&&Number(entry)>=0;
      if(!/^[a-zA-Z0-9_.:-]{1,100}$/.test(key)
        ||/^(?:sourceFacts|source_facts|source_record_json|nativeBase64|embedding|title|description|products|candidates)$/.test(key)&&!embeddingCount)fail();
      walk(entry,depth+1);
    }return;}fail();
  };
  walk(value);return value as Record<string,unknown>;
}
