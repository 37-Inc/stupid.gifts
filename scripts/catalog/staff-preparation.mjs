// A staff preparation has no catalog owner or public pointer. Its immutable
// metadata names an ordinary, expiring RunWorkspace, never a supplier body.
import {canonicalJson,sha256} from './migration.ts';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {registerHostedWorkspaceCleanup} from './hosted-cleanup.mjs';
import {openRunWorkspace} from './run-workspace.ts';
import {createD1CatalogPreparationStore} from './maintenance-d1.ts';
import {createReviewedPhaseJournal} from './reviewed-provider-phases.mjs';
import {prepareCatalogProducts} from './prepare-products.mjs';
import {createCatalogProviderEvidence} from './provider-evidence.ts';
import {exactProductAdmissionPhase} from '../ops/catalog-daily.mjs';
import {isCatalogAsin} from '../../lib/catalog/automation-cohort.ts';
import {resolveReadToken} from './check-cloudflare-runner.ts';
const fail=()=>{throw Error('catalog_admin_preparation_invalid');};
const ref='staff/exact-product-preparation-v1';
export function staffPaths(runtime,day,asin){
  if(!isCatalogAsin(asin)||!/^\d{4}-\d\d-\d\d$/.test(day))fail();
  const base=runtime.care+'/staff-preparation/'+day+'/'+asin;
  return{intent:base+'/intent.json',ready:base+'/ready.json'};
}
async function opt(runtime,file){
  try{return JSON.parse(await runtime.state.bytes(file));}catch(e){if(e.code!=='ENOENT')throw e;return null;}
}
export async function staffIntent(runtime,day,asin){return opt(runtime,staffPaths(runtime,day,asin).intent);}
export async function staffReady(runtime,day,asin){return opt(runtime,staffPaths(runtime,day,asin).ready);}
function options(runtime,repository,i){
  if(!isCatalogAsin(i.asin)||!/^\d{4}-\d\d-\d\d$/.test(i.day)||! /^[a-zA-Z0-9_-]{16,100}$/.test(i.requestId)||! /^[a-f0-9]{40}$/.test(i.source)
    ||new Date(Date.parse(i.startedAt)+86400000).toISOString()!==i.expiresAt)fail();
  return{directory:runtime.base+'/staff-preparation-workspaces',repository,runId:'staff-'+sha256(i.requestId).slice(0,32),
    codeSha:i.source,configSha256:sha256(canonicalJson(i)),scope:CATALOG_SCOPE,budgetCaps:{httpRequests:6000,sqlStatements:12000},
    requestLimit:'observe',durable:runtime.durable,retention:{reviewReference:ref,rules:Object.fromEntries(
      ['amazon-observation','embedding-response','phase','publication','checkpoint'].map(k=>[k,{maxAgeMs:86400000,notAfter:i.expiresAt}]))}};
}
export async function prepareStaffProduct({runtime,repository,source,db,row,day,now=()=>new Date().toISOString(),prepare=prepareExact}){
  const asin=JSON.parse(row.payload_json).asin,paths=staffPaths(runtime,day,asin),prior=await staffIntent(runtime,day,asin);
  if(prior&&prior.requestId!==row.request_id)fail();
  const startedAt=now(),intent=prior??{day,asin,requestId:row.request_id,source,startedAt,expiresAt:new Date(Date.parse(startedAt)+86400000).toISOString()};
  if(!prior)await runtime.state.put(paths.intent,intent);
  if(Date.parse(now())>=Date.parse(intent.expiresAt))return{state:'expired',requestId:intent.requestId};
  if(await staffReady(runtime,day,asin))return{state:'ready',reused:true};
  if(intent.source!==source)throw Error('catalog_admin_preparation_original_source_required');
  const opts=options(runtime,repository,intent),manifest=await runtime.durable.get('runs/'+opts.runId+'/manifest.json');
  const ws=await openRunWorkspace({...opts,now,mode:manifest?'resume':'create'});
  try{
    await registerHostedWorkspaceCleanup(runtime,ws.manifest);
    const {putOrdered,readOrdered}=await import('./run-cloudflare-weekly.ts');
    let cp=await ws.readCheckpoint();
    const journal=createReviewedPhaseJournal({initial:cp&&await readOrdered(ws,cp.checkpoint.pins.journal)||undefined,
      read:r=>readOrdered(ws,r),readReceipt:r=>ws.readReceipt(r),put:v=>putOrdered(ws,v,now(),'phase'),
      save:async v=>{const pin=await putOrdered(ws,v,now(),'phase');cp=await ws.writeCheckpoint(cp?.sha256??null,{phase:'preparing',owner:null,state:{},pins:{journal:pin},phaseComplete:null});}});
    const tag='goose-gifts-37-20';
    const evidence=createCatalogProviderEvidence({associateTag:tag,now,readReceipt:r=>ws.readReceipt(r),
      saveReceipt:async v=>{const r=await ws.saveReceipt(v);await journal.receipt(r);return r;},
      saveReviewedShort:async v=>{const r=await ws.putArtifact({schemaVersion:1,kind:'reviewed-short-copy',...v},{kind:'phase',observedAt:v.reviewedAt});
        await journal.put('short-proof-'+r.sha256,r);return r;}});
    const store=createD1CatalogPreparationStore({db,runId:opts.runId,catalogRevision:opts.runId,preservePermanentListings:true});
    if(!await journal.read('phase-0-prepared')){
      await prepare({runtime,tag,phases:[exactProductAdmissionPhase([asin])],runId:opts.runId,journal,evidence,store,now});
    }
    const ready={...intent,manifestSha256:ws.manifestSha256,journal:cp.checkpoint.pins.journal,preparedAt:now()};
    await runtime.state.put(paths.ready,ready);return{state:'ready',elapsedMs:Date.parse(ready.preparedAt)-Date.parse(intent.startedAt)};
  }finally{await ws.close();}
}
async function prepareExact({runtime,tag,...input}){
  const {providerEnvironment,scopedProviders}=await import('./run-cloudflare-weekly.ts');
  const env=await providerEnvironment({credentials:{...runtime.credentials,amazonVersion:'3.1'},catalog:{associateTag:tag,marketplace:'www.amazon.com'},inputs:{}},resolveReadToken,true);
  return scopedProviders(env,async()=>{
    const {executeCatalog}=await import('../ops/prefetch-catalog.mjs');
    return prepareCatalogProducts({...input,execute:executeCatalog});
  });
}
/** No providers here. Copy original hash-bound proof, not a new observation.
 * Writer configuration is capped at the FIRST preparation's expiry. */
export async function importStaffPreparation({runtime,repository,pin,ws,journal,runId,now}){
  const ready=await staffReady(runtime,pin.day,pin.asin);
  if(canonicalJson(ready)!==canonicalJson(pin)||Date.parse(now())>=Date.parse(pin.expiresAt))fail();
  const opts=options(runtime,repository,pinIntent(pin));
  const source=await openRunWorkspace({...opts,now,mode:'resume',expectedManifestSha256:pin.manifestSha256});
  try{
    const {readOrdered}=await import('./run-cloudflare-weekly.ts');
    const cp=await source.readCheckpoint();
    if(cp?.checkpoint.owner!==null||canonicalJson(cp.checkpoint.pins.journal)!==canonicalJson(pin.journal))fail();
    const snapshot=await readOrdered(source,pin.journal);
    const saved=createReviewedPhaseJournal({initial:snapshot,read:r=>readOrdered(source,r),readReceipt:r=>source.readReceipt(r)});
    for(const r of snapshot.receipts){
      const receipt=await source.readReceipt(r);
      if(receipt.products.some(p=>p.id!==pin.asin))fail();
      const actual=await ws.saveReceipt({sha256:r.sha256,receipt});if(actual.sha256!==r.sha256)fail();
    }
    for(const k of Object.keys(snapshot.entries).filter(k=>k.startsWith('short-proof-'))){
      const r=await saved.read(k),v=await source.readArtifact(r);
      if(v.id!==pin.asin||v.kind!=='reviewed-short-copy')fail();
      const actual=await ws.putArtifact(v,{kind:'phase',observedAt:v.reviewedAt});if(actual.sha256!==r.sha256)fail();
    }
    const prepared=await saved.read('phase-0-prepared');
    for(const m of prepared.mutations){
      if(m.method==='upsertProduct'&&m.args[0].id===pin.asin&&m.intent.expectedSourceById?.[pin.asin]===null)continue;
      if(m.method!=='recordEditorialEvent'||m.args[0].productId!==pin.asin||m.args[0].runId!==opts.runId)fail();
      m.args[0].runId=runId;
    }
    await journal.put('staff-usage',await saved.usage());
    await journal.put('phase-0-prepared',prepared);
  }finally{await source.close();}
}
function pinIntent({day,asin,requestId,source,startedAt,expiresAt}){return {day,asin,requestId,source,startedAt,expiresAt};}
