import {createCatalogProviderEvidence} from './provider-evidence.ts';
import {createD1CatalogMaintenanceStore} from './maintenance-d1.ts';
import {maintenanceEmbeddingText} from './maintenance-state.ts';
import {decodePgvectorSendBase64} from './pgvector-binary.ts';
import {sha256} from './migration.ts';
import {editorialSourceHash,SHORT_COPY_PROMPT_VERSION} from '../ops/catalog-editorial-core.mjs';

const fail=()=>{throw Error('saved_admission_repair_invalid');};
/** Reuse the actual approved short copy and native embedding. Currency is US
 * marketplace formatting, not an invented price. No provider/model capability. */
export function savedAdmissionRepairProduct({id,observation,review,embedding,associateTag}){
  const source=observation.products.find(p=>p.id===id&&p.sourceFactsHash===review.sourceFactsHash),
    vector=embedding.products.find(p=>p.id===id);
  if(!source||!vector||review.kind!=='reviewed-short-copy'||review.id!==id||review.quality<.8||review.quality>1
    ||embedding.kind!=='embedding-response'||embedding.model!=='text-embedding-3-small'
    ||vector.sourceFactsHash!==source.sourceFactsHash||source.availabilityStatus!=='IN_STOCK')fail();
  const product={...structuredClone(source.snapshot),id,source:'amazon',currency:'USD',price:0,
    affiliateUrl:`https://www.amazon.com/dp/${id}?tag=${associateTag}`,availabilityStatus:source.availabilityStatus,
    isActive:true,remotelyVerified:true,humorTags:[],qualityScore:.8,punnyTitle:review.title,wittyDescription:review.description,
    editorialStatus:'short_ready',editorialSourceHash:source.sourceFactsHash,sourceFactsHash:source.sourceFactsHash,
    editorialQualityScore:review.quality,editorialPromptVersion:SHORT_COPY_PROMPT_VERSION,editorialModel:'gpt-6-luna',
    editorialGeneratedAt:review.reviewedAt,embedding:decodePgvectorSendBase64(vector.nativeBase64)};
  if(editorialSourceHash(product)!==source.sourceFactsHash||maintenanceEmbeddingText(product)!==vector.text)fail();
  return product;
}
async function failedTelemetry(db,runId){
  const rows=(await db.prepare(`SELECT r.status,t.finish_json FROM catalog_runs r JOIN catalog_run_telemetry t ON t.run_id=r.id WHERE r.id=?`).bind(runId).all()).results;
  if(rows.length!==1||rows[0].status!=='failed'||!rows[0].finish_json)fail();
  const finish=JSON.parse(rows[0].finish_json);
  if(finish.status!=='failed'||finish.error_summary!=='Invalid maintenance input')fail();
  return{finish,sha256:sha256(rows[0].finish_json)};
}
/** Failed attempt stays failed forever; its genuine later catalog receipt and
 * hosted success are separate evidence, not a rewritten provider outcome. */
export async function retainedFailedAdmission(ws,db,config,configSha256){
  const cp=await ws.readCheckpoint({controlOnly:true}),ref=cp?.checkpoint.pins?.savedAdmissionRepair;
  if(!ref)return false;
  const plan=await ws.readArtifact(ref),prior=await failedTelemetry(db,config.runId);
  if(plan.kind!=='saved-admission-currency-repair'||plan.configSha256!==configSha256||plan.runId!==config.runId
    ||plan.failedTelemetrySha256!==prior.sha256||config.cadence?.admitAsins?.length!==1
    ||plan.id!==config.cadence.admitAsins[0])fail();
  return true;
}
/** Same original owner/config/journal; only the failed insertion is repaired.
 * Save deterministic product/intent/native bytes BEFORE the first mutation so
 * an uncertain ACK retries the exact existing D1 operation, not any AI stage. */
export async function repairSavedAdmission({ws,db,config,configSha256,now,checkpoint,write}){
  if(!config.inputs.savedAdmission||config.catalog.marketplace!=='www.amazon.com'||config.cadence?.admitAsins?.length!==1
    ||checkpoint.phase!=='phase_failed'||checkpoint.control?.publication||checkpoint.owner?.phase!=='writing'
    ||checkpoint.owner.ownerReference!==config.runId||checkpoint.owner.operationKey!==sha256(`weekly:${configSha256}`))fail();
  const id=config.cadence.admitAsins[0],prior=await failedTelemetry(db,config.runId);
  let ref=checkpoint.pins.savedAdmissionRepair,plan=ref?await ws.readArtifact(ref):null;
  if(!plan){
    const entries=await ws.registeredArtifacts();let review,observation,observationRef,embedding,embeddingRef;
    for(const entry of entries){
      if(entry.kind==='phase'){
        const value=await ws.readArtifact(entry.ref);
        if(value?.kind==='reviewed-short-copy'&&value.id===id){review=value;}
      }else if(entry.kind==='amazon-observation'||entry.kind==='embedding-response'){
        const value=await ws.readReceipt(entry.ref);
        if(value.kind==='amazon-observation'&&value.products.some(p=>p.id===id)){observation=value;observationRef=entry.ref;}
        if(value.kind==='embedding-response'&&value.products.some(p=>p.id===id)){embedding=value;embeddingRef=entry.ref;}
      }
    }
    if(!review||!observation||!embedding||review.observationReference!==observationRef.reference)fail();
    const product=savedAdmissionRepairProduct({id,observation,review,embedding,associateTag:config.catalog.associateTag});
    const evidence=createCatalogProviderEvidence({associateTag:config.catalog.associateTag,now,readReceipt:r=>ws.readReceipt(r),
      saveReceipt:()=>{throw Error('supplier_model_replay_forbidden');},
      saveReviewedShort:input=>ws.putArtifact({schemaVersion:1,kind:'reviewed-short-copy',...input},{kind:'phase',observedAt:input.reviewedAt})});
    await evidence.restoreReceipt(observationRef);await evidence.restoreReceipt(embeddingRef);
    if(!await evidence.reviewedShort(product,{approved:true,qualityScore:review.quality}))fail();
    const intent=evidence.intent('upsertProduct',[product,review.sourceFactsHash]);
    const {embedding:unused,...fields}=product;void unused;
    plan={schemaVersion:1,kind:'saved-admission-currency-repair',runId:config.runId,configSha256,id,
      failedTelemetrySha256:prior.sha256,owner:checkpoint.owner,product:fields,intent,embeddingRef,
      nativeBase64:embedding.products.find(p=>p.id===id).nativeBase64,sourceFactsHash:review.sourceFactsHash};
    ref=await ws.putArtifact(plan,{kind:'phase',observedAt:now()});
    await write({pins:{...checkpoint.pins,savedAdmissionRepair:ref}});
  }
  if(plan.configSha256!==configSha256||plan.runId!==config.runId||plan.id!==id||plan.failedTelemetrySha256!==prior.sha256)fail();
  const cursor={current:plan.owner},store=createD1CatalogMaintenanceStore({db,owner:plan.owner,ownerCursor:cursor,
    runId:config.runId,catalogRevision:config.catalogRevision,preservePermanentListings:true,intent:()=>plan.intent});
  await store.upsertProduct({...plan.product,embedding:decodePgvectorSendBase64(plan.nativeBase64)},plan.sourceFactsHash);
  const phaseComplete=await ws.putArtifact({counts:{admitted:1,inserted:1},timingsMs:prior.finish.timings_ms,usage:prior.finish.usage,
    warnings:[{phase:'recovery',reasonCode:'original_failed_attempt_retained'}]},{kind:'publication',observedAt:now()});
  await write({phase:'phases_complete',owner:cursor.current,phaseComplete,pins:{...checkpoint.pins,savedAdmissionRepair:ref}});
  return{state:'repaired',supplierRequests:0,modelRequests:0};
}
