import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationFenceQuery} from '../../lib/catalog/mutation-fence.ts';
import type {ApprovedCohortEnvelope} from '../../lib/catalog/freeze-approved-cohort.ts';
import type {CatalogSnapshot} from '../../lib/catalog/types.ts';
import {checkCurrent,readOwnerBaseOperationReceipts} from './export-d1-snapshot.ts';
import {readOwnedSourceVersion} from './owned-operational-import.ts';
import {readProductRows} from './read-product-rows.ts';
import {canonicalJson,sha256} from './migration.ts';
import {validatePublicCatalogProduct} from '../../lib/catalog/snapshot.ts';
import {persistentPublicProduct,resolvePublicProduct} from '../../lib/catalog/display.ts';
import {confirmedRetailAvailable,confirmedRetailUnavailable} from '../../lib/catalog/retail-availability.ts';
import {hasReviewedGiftShortCopy} from '../../lib/gift-slugs.ts';
import type {RuntimeCatalogChange} from './runtime-catalog-delta.ts';

type Row=Record<string,unknown>;
const HASH=/^[a-f0-9]{64}$/,UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function fail():never{throw Error('runtime_delta_source_changed');}
const triggerNames=['catalog_source_products_insert','catalog_source_products_update','catalog_source_products_delete',
  'catalog_source_private_insert','catalog_source_private_update','catalog_source_private_delete',
  'catalog_source_operations_insert','catalog_source_operations_update','catalog_source_operations_delete'];
/** Final transaction guard for the exact checked cohort. This is NOT a cached
 * whole-catalog proof: unchanged public gifts are inherited from accepted data.
 * All nine triggers must remain present; no source write can slip past the CAS. */
export function runtimeDeltaSourceFence(version:number){
  if(!Number.isSafeInteger(version)||version<0)fail();
  return{sql:`EXISTS(SELECT 1 FROM catalog_source_version WHERE singleton=1 AND version=?)
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN(${triggerNames.map(n=>`'${n}'`).join(',')}))=9`,params:[version]};
}

/** Authenticate only reviewed rows/operations, never an unrelated private
 * inventory or native index. The existing monotonic source counter encloses
 * these reads and must match again INSIDE the real head/receipt transaction. */
export async function readReviewedRuntimeDelta(input:{db:CatalogD1;owner:MutationOwner;approval:ApprovedCohortEnvelope;
  approvalSha256:string;previous:CatalogSnapshot;now:Date}){
  const {db,owner,approval,previous,now}=input,fence=mutationFenceQuery(owner,['writing']);
  if(!Number.isFinite(now.getTime())||now.getTime()<Date.parse(owner.capturedAt)
    ||!approval||Object.keys(approval).sort().join(',')!=='catalogRevision,changes,runId,schemaVersion'
    ||approval.schemaVersion!==1||sha256(canonicalJson(approval))!==input.approvalSha256
    ||!Array.isArray(approval.changes)||approval.changes.length>10000
    ||new Set(approval.changes.map(c=>c.publicId)).size!==approval.changes.length
    ||approval.changes.some(c=>Object.keys(c).sort().join(',')!=='displaySha256,inputSha256,operationId,productSha256,publicId'
      ||!UUID.test(c.publicId)||![c.operationId,c.inputSha256,c.productSha256,c.displaySha256].every(v=>HASH.test(v))))fail();
  const version=await readOwnedSourceVersion(db,owner,undefined,fence);
  if(version===null)throw Error('runtime_delta_source_version_required');
  const publicIds=approval.changes.map(c=>c.publicId),mapping:Row[]=[];
  for(let offset=0;offset<publicIds.length;offset+=80)mapping.push(...(await db.prepare(`SELECT p.id,p.public_id
    FROM json_each(?) requested JOIN products p ON p.public_id=requested.value`)
    .bind(JSON.stringify(publicIds.slice(offset,offset+80))).all<Row>()).results);
  if(mapping.length!==publicIds.length||new Set(mapping.map(p=>p.id)).size!==mapping.length)fail();
  const joined=await readProductRows(db,mapping.map(p=>String(p.id)),{semantic:true});
  const rows=new Map(joined.map(row=>[String(row.public_id),row]));
  const opIds=new Set(approval.changes.map(c=>c.operationId));
  for(const row of joined){
    const provenance=JSON.parse(String(row.timestamp_provenance_json));
    const id=provenance.fields?.availability_checked_at?.operationId;
    if(typeof id==='string'&&HASH.test(id))opIds.add(id);
  }
  const ops:Row[]=[];for(let offset=0;offset<opIds.size;offset+=80)
    ops.push(...await readOwnerBaseOperationReceipts(db,owner,[...opIds].slice(offset,offset+80),false,undefined,'writing'));
  const operations=new Map(ops.map(op=>[String(op.operation_id),op]));
  const accepted=new Set([...previous.products,...previous.heldProducts].map(p=>p.publicId));
  const changes:RuntimeCatalogChange[]=[],deferred:string[]=[],factsByPublicId:Record<string,string|null>={};
  for(const change of approval.changes){
    const joined=rows.get(change.publicId);if(!joined)fail();
    const row=Object.fromEntries(Object.entries(joined).filter(([key])=>!key.startsWith('maintenance_'))),op=operations.get(change.operationId);
    if(row.catalog_revision!==approval.catalogRevision||sha256(canonicalJson(row))!==change.productSha256
      ||sha256(String(row.public_display_json??'null'))!==change.displaySha256||!op||op.input_sha256!==change.inputSha256
      ||op.run_id!==approval.runId||op.catalog_revision!==approval.catalogRevision||op.environment!==owner.environment
      ||op.index_name!==owner.indexName||op.generation!==owner.generation||Number(op.next_epoch)>owner.epoch
      ||!JSON.parse(String(op.changes_json)).some((c:Row)=>c.productId===row.id&&c.afterSha256===change.productSha256))fail();
    const identity={id:String(row.id),publicId:String(row.public_id),slug:String(row.slug)};
    const evidenceId=JSON.parse(String(row.timestamp_provenance_json)).fields?.availability_checked_at?.operationId;
    const current={...row,maintenance_semantic:joined.maintenance_semantic,
      verification_operation_json:operations.has(evidenceId)?canonicalJson(operations.get(evidenceId)):null};
    if(confirmedRetailUnavailable(current)){
      if(accepted.has(identity.publicId))changes.push({...identity,kind:'unavailable'});else deferred.push(identity.publicId);
      continue;
    }
    if(row.public_display_json===null){if(accepted.has(identity.publicId))changes.push({...identity,kind:'preserve'});else deferred.push(identity.publicId);continue;}
    const display=validatePublicCatalogProduct(JSON.parse(String(row.public_display_json)),now);
    const product=resolvePublicProduct(display,now);
    if(!product||!persistentPublicProduct(product))fail();
    checkCurrent(product,{source_facts_hash:row.source_facts_hash},current,now);
    const base=persistentPublicProduct(display);
    const changedText=base&&(display.title!==base.title||display.description!==base.description);
    if(row.editorial_status==='short_ready'&&(!accepted.has(identity.publicId)||changedText)){
      const semantic=JSON.parse(String(joined.maintenance_semantic));
      if(!hasReviewedGiftShortCopy(semantic)||semantic.wittyDescription!==display.description)fail();
    }
    const available=confirmedRetailAvailable(current);
    if(!accepted.has(identity.publicId)&&(!available||Number(row.quality_score)<.55))fail();
    changes.push({...identity,kind:'publish',product,...(available?{restoreUnavailable:true as const}:{})});
    factsByPublicId[identity.publicId]=row.source_facts_hash===null?null:String(row.source_facts_hash);
  }
  if(await readOwnedSourceVersion(db,owner,undefined,fence)!==version)fail();
  return{sourceVersion:version,changes,deferred,factsByPublicId};
}
