import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion,mutationAdvance} from '../../lib/catalog/mutation-fence.ts';
import type {ApprovedChange,ApprovedCohortRequest} from '../../lib/catalog/freeze-approved-cohort.ts';
import {maintenanceEmbeddingText,maintenanceProjection,maintenanceState} from './maintenance-state.ts';
import {canonicalJson,sha256} from './migration.ts';
import {createHash} from 'node:crypto';

type Row=Record<string,unknown>;
const KIND='new-product-slug-repair-v1';
const SLUG_TRIGGER=`CREATE TRIGGER products_maintenance_slug_immutable BEFORE UPDATE OF slug ON products
WHEN OLD.slug IS NOT NEW.slug BEGIN
  SELECT RAISE(ABORT,'Maintenance preserves existing slugs');
END`;
const hash=(value:unknown)=>sha256(canonicalJson(value));
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const slug=(v:unknown)=>typeof v==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v);
function fail():never{throw Error('new_product_slug_repair_refused');}
/** Only the truncation defect in a newly admitted, never-published identity.
 * Reuse its exact reviewed copy, grants, observation and native input. */
export function planNewProductSlugRepair(input:{row:Row;state:Row;operation:Row;change:ApprovedChange;
  request:ApprovedCohortRequest;owner:MutationOwner;now:string}){
  const {row,state,operation,change,request,owner}=input,oldSlug=String(row.slug),nextSlug=oldSlug.replace(/-+$/,'');
  const prior=[...request.previous.products,...request.previous.heldProducts];
  if(owner.phase!=='freezing'||prior.some(p=>p.publicId===row.public_id)||oldSlug.length!==120||!oldSlug.endsWith('-')||!slug(nextSlug)
    ||row.public_display_json!==null||row.is_active!==1||row.duplicate_of_product_id!==null||row.editorial_status!=='short_ready'
    ||row.catalog_revision!==request.approval.catalogRevision||row.public_id!==change.publicId||hash(row)!==change.productSha256
    ||change.displaySha256!==sha256('null')||operation.operation_id!==change.operationId||operation.input_sha256!==change.inputSha256
    ||operation.run_id!==request.approval.runId||operation.catalog_revision!==request.approval.catalogRevision
    ||operation.environment!==owner.environment||operation.index_name!==owner.indexName||Number(operation.generation)>=owner.generation
    ||!JSON.parse(String(operation.changes_json)).some((c:Row)=>c.productId===row.id&&c.afterSha256===change.productSha256)
    ||state.product_id!==row.id||state.embedding_present!==1||typeof state.embedding_native_base64!=='string')fail();
  const product=maintenanceState({...row,maintenance_semantic:state.semantic_json});
  const proof=JSON.parse(String(state.embedding_provenance_json)),text=maintenanceEmbeddingText(product);
  if(proof.input!=='verified'||proof.model!=='text-embedding-3-small'||proof.text!==text||proof.embeddingTextHash!==sha256(text)
    ||row.embedding_text_hash!==proof.embeddingTextHash||proof.sourceFactsHash!==row.source_facts_hash
    ||proof.vectorBytesSha256!==createHash('sha256').update(Buffer.from(state.embedding_native_base64,'base64')).digest('hex'))fail();
  const provenance=JSON.parse(String(row.timestamp_provenance_json));
  const evidence=provenance.fields?.availability_checked_at;
  if(evidence?.state!=='evidenced'||evidence.basis!=='maintenance_operation'||evidence.sourceFactsHash!==row.source_facts_hash
    ||evidence.observedAt!==row.availability_checked_at)fail();
  const fixed={...product,slug:nextSlug},projection=maintenanceProjection(fixed,JSON.parse(String(row.rights_json)),
    String(row.catalog_revision),input.now,true,String(evidence.observedAt),undefined,true);
  if(!projection.row.public_display_json||!projection.persistentBase||projection.row.rights_json!==row.rights_json)fail();
  fixed.persistentBase=projection.persistentBase;
  // The original source archive (including its bad proposed URL) is history.
  // Only the canonical URL and derived presentation are repaired.
  const after:Row={...row,slug:nextSlug,...Object.fromEntries(['title','description','tags','public_display_json','eligible_until'].map(k=>[k,projection.row[k as keyof typeof projection.row]]))};
  const nextState={...state,version:Number(state.version)+1,semantic_json:canonicalJson(fixed)};
  return{kind:KIND,owner,runId:request.approval.runId,catalogRevision:request.approval.catalogRevision,
    original:change,before:row,after,state,nextState,operation};
}
export type NewProductSlugRepair=ReturnType<typeof planNewProductSlugRepair>;

export async function applyNewProductSlugRepair(db:CatalogD1,plan:NewProductSlugRepair){
  const input=hash(plan),operationId=sha256(KIND+':'+input),owner=plan.owner;
  const exact=(table:string,row:Row)=>{const keys=Object.keys(row);
    if(keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))fail();
    return db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})
      THEN 'true' ELSE 'new_product_slug_repair_conflict' END)`).bind(...keys.map(k=>row[k]));};
  const found=(await db.prepare('SELECT input_sha256 FROM catalog_maintenance_operations WHERE operation_id=?').bind(operationId).all()).results;
  if(found.length){
    if(found.length!==1||found[0].input_sha256!==input)fail();
    await db.batch([mutationAssertion(db,{...owner,epoch:owner.epoch+1},['freezing']),exact('products',plan.after),exact('catalog_maintenance_products',plan.nextState)]);
    return{...owner,epoch:owner.epoch+1};
  }
  const effective={...plan.original,operationId,inputSha256:input,productSha256:hash(plan.after),displaySha256:sha256(String(plan.after.public_display_json))};
  const result={kind:KIND,original:plan.original,effective,oldSlug:plan.before.slug,slug:plan.after.slug};
  const columns=['slug','title','description','tags','public_display_json','eligible_until'];
  const triggers=(await db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='products_maintenance_slug_immutable'").all()).results;
  if(triggers.length!==1||String(triggers[0].sql).replace(/\s+/g,' ').trim()!==SLUG_TRIGGER.replace(/\s+/g,' ').trim())fail();
  // D1 batches are atomic. Temporarily lift ONLY the exact known slug trigger
  // inside this fenced transaction, restore it before commit, and retain the
  // original unused URL in history. No published permalink may enter this path.
  await db.batch([mutationAssertion(db,owner,['freezing']),exact('products',plan.before),exact('catalog_maintenance_products',plan.state),
    exact('catalog_maintenance_operations',plan.operation),
    db.prepare("SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM product_slug_history WHERE slug=? AND product_id<>?) THEN 'true' ELSE 'new_product_slug_repair_conflict' END)").bind(plan.after.slug,plan.before.id),
    db.prepare(`INSERT OR IGNORE INTO product_slug_history(slug,product_id,created_at,source_record_json)
      VALUES(?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?)`).bind(plan.before.slug,plan.before.id,canonicalJson({kind:KIND,operationId})),
    db.prepare('DROP TRIGGER products_maintenance_slug_immutable'),
    db.prepare(`UPDATE products SET ${columns.map(k=>k+'=?').join(',')} WHERE id=?`).bind(...columns.map(k=>plan.after[k]),plan.before.id),
    db.prepare(SLUG_TRIGGER),
    db.prepare('UPDATE catalog_maintenance_products SET semantic_json=?,version=? WHERE product_id=?').bind(plan.nextState.semantic_json,plan.nextState.version,plan.before.id),
    exact('products',plan.after),exact('catalog_maintenance_products',plan.nextState),
    db.prepare(`INSERT INTO catalog_maintenance_operations(operation_id,input_sha256,run_id,catalog_revision,environment,index_name,generation,
      prior_epoch,next_epoch,database_time,result_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),?,?)`)
      .bind(operationId,input,plan.runId,plan.catalogRevision,owner.environment,owner.indexName,owner.generation,owner.epoch,owner.epoch+1,
        canonicalJson(result),canonicalJson([{productId:plan.before.id,beforeSha256:hash(plan.before),afterSha256:hash(plan.after),
          privateStateSha256:sha256(plan.nextState.semantic_json),supersededUnsentSequences:[],vectorOperation:null}])),
    mutationAdvance(db,owner,{sql:'SELECT 1 FROM catalog_maintenance_operations WHERE operation_id=? AND input_sha256=?',params:[operationId,input]}),
    mutationAssertion(db,{...owner,epoch:owner.epoch+1},['freezing'])]);
  return{...owner,epoch:owner.epoch+1};
}
/** Resolve only the exact appended same-owner repair. The original agent
 * approval and ingestion operation remain immutable. */
export function effectiveSlugApproval(change:ApprovedChange,operations:Row[],row:Row,owner:MutationOwner,
  request:{approval:ApprovedCohortRequest['approval'];previous:{products:ReadonlyArray<{publicId:string}>;heldProducts:ReadonlyArray<{publicId:string}>}}):ApprovedChange{
  const fail=():never=>{throw Error('cohort_approval_changed');};
  if(hash(row)===change.productSha256)return change;
  if([...request.previous.products,...request.previous.heldProducts].some(p=>p.publicId===change.publicId))fail();
  const repairs=operations.filter(op=>{
    const r=JSON.parse(String(op.result_json));
    return r?.kind===KIND&&same(r.original,change)&&op.run_id===request.approval.runId&&op.catalog_revision===request.approval.catalogRevision
      &&op.environment===owner.environment&&op.index_name===owner.indexName&&op.generation===owner.generation&&Number(op.next_epoch)<=owner.epoch;
  });
  if(repairs.length!==1)fail();
  const op=repairs[0],r=JSON.parse(String(op.result_json)),c=r.effective;
  const link=JSON.parse(String(op.changes_json));
  if(!c||c.publicId!==change.publicId||c.operationId!==op.operation_id||c.inputSha256!==op.input_sha256||c.productSha256!==hash(row)
    ||c.displaySha256!==sha256(String(row.public_display_json))||change.displaySha256!==sha256('null')
    ||typeof r.oldSlug!=='string'||r.oldSlug.length!==120||!r.oldSlug.endsWith('-')||r.slug!==r.oldSlug.replace(/-+$/,'')||row.slug!==r.slug||!slug(r.slug)
    ||link.length!==1||link[0].productId!==row.id||link[0].beforeSha256!==change.productSha256||link[0].afterSha256!==c.productSha256
    ||link[0].vectorOperation!==null)fail();
  return c;
}
export async function repairApprovedNewSlugs(db:CatalogD1,owner:MutationOwner,request:ApprovedCohortRequest,now:string){
  const ids=request.approval.changes.map(c=>c.publicId);
  if(!ids.length)return owner;
  const rows=(await db.prepare('SELECT p.* FROM products p WHERE public_id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(ids)).all()).results;
  for(const row of rows){
    if(slug(row.slug))continue;
    const change=request.approval.changes.find(c=>c.publicId===row.public_id)!;
    const states=(await db.prepare('SELECT * FROM catalog_maintenance_products WHERE product_id=?').bind(row.id).all()).results;
    const ops=(await db.prepare('SELECT * FROM catalog_maintenance_operations WHERE operation_id=?').bind(change.operationId).all()).results;
    if(states.length!==1||ops.length!==1)fail();
    owner=await applyNewProductSlugRepair(db,planNewProductSlugRepair({row,state:states[0],operation:ops[0],change,request,owner,now}));
  }
  return owner;
}
