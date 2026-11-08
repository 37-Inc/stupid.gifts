import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {automationRuntime,CATALOG_SCOPE} from './automation-runtime.mjs';
import {readHomepageEdition} from '../../lib/catalog/homepage-edition.ts';
import defaultEdition from '../../content/homepage-edition.json' with {type:'json'};
import {PHOTO_EXPIRY_SQL} from './maintenance-d1.ts';
import {planRoutineAutomation} from './automation-plan.ts';
import {loadAutomationMerchandising,loadAutomationDiscoveryInputs} from './automation-inputs.mjs';
import {routineMerchandising} from './campaign-operator.mjs';
import path from 'node:path';

// Shared local/hosted operator; one active coordinator, never another publisher. The reviewed driver owns every
// merchant phase, reservation, write, vector operation and publication.
const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const SOURCE=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
const RUNTIME=automationRuntime(),BASE=RUNTIME.base,WORKSPACE=RUNTIME.workspace,CARE=RUNTIME.care;
const INITIAL={control:{path:BASE+'/existing-display-20261023-v2/catalog-control.json',sha256:'434c960466f42f71acce83b037a8a23cefef18e7f02d0a2f111c2a99e3a311e1'},
  versionReference:'1924de55-cc4b-46a9-8ca9-e30f21ea5028',manifestSha256:'5d64c77465da9e1eee065232d256172c7906a22505c9d6f2e8ae2c0fe28ef792'};
const SCOPE=CATALOG_SCOPE;
const FREE_LIMITS={requests:5000,statements:12000,reportedRowsRead:1500000,reportedRowsWritten:30000};
/** The accepted full-catalog run measured 1.83M reads. Keep a finite working
 * margin on the owner's existing paid plan, not the obsolete 1.5M Free guard.
 * Merchant counts, model policy and historical run budgets do not change. */
export function routineLimits(plan){
  if(!['free','standard'].includes(plan))refuse('plan_unavailable');
  return plan==='standard'?{requests:6000,statements:12000,reportedRowsRead:3000000,reportedRowsWritten:40000}:{...FREE_LIMITS};
}
const load=name=>import(pathToFileURL(ROOT+'/'+name).href);
const {canonicalJson,sha256}=await load('scripts/catalog/migration.ts');
const {runCloudflareWeekly,weeklyCommandSummary,validateCloudflareWeeklyConfig}=await load('scripts/catalog/run-cloudflare-weekly.ts');
const {createCatalogD1ReadOnlyRest}=await load('scripts/catalog/d1-write-rest.ts');
const {openRunWorkspace,openPublicationBuildCleanup}=await load('scripts/catalog/run-workspace.ts');
const {verifyPublicationSemanticCatalog}=await load('scripts/catalog/publish-release.ts');
const {mutationAssertion}=await load('lib/catalog/mutation-fence.ts');
const {pacificCatalogCalendar,validCatalogRunKey}=await load('scripts/ops/catalog-daily.mjs');
const HASH=/^[a-f0-9]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const self=digest(await fs.readFile(new URL(import.meta.url)));
function refuse(code){throw Error('routine_'+code);}
async function source(command,runKey,pending){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  if(process.versions.node.split('.')[0]!=='22'||process.cwd()!==ROOT||git('rev-parse','HEAD')!==SOURCE||git('status','--porcelain','--untracked-files=all'))refuse('source');
  if(Object.keys(process.env).some(k=>/^(AMAZON_|OPENAI_|POSTGRES_|VERCEL_|CATALOG_)/.test(k)))refuse('ambient_configuration');
  if(RUNTIME.hosted&&process.env.GITHUB_SHA!==SOURCE){
    if(!['prepare','start','resume','publish','review','status','recover'].includes(command)||!pending||!runKey)refuse('hosted_source');
    try{git('merge-base','--is-ancestor',SOURCE,process.env.GITHUB_SHA);}catch{refuse('hosted_source');}
    const saved=await optional(CARE+'/runs/'+runKey+'/operator.json');
    if(command==='prepare'&&!saved)return;
    if(!saved||saved.source!==SOURCE||saved.helperSha256!==self)refuse('hosted_source');
    const config=validateCloudflareWeeklyConfig(await json(saved.configPath,saved.configSha256));
    if(config.codeSha!==SOURCE||config.publication.sourceRoot!==ROOT||config.runId!==saved.runId)refuse('hosted_source');
    if(command==='start'){
      const run='runs/'+saved.runId+'/',local=[WORKSPACE+'/'+run+'manifest.json',WORKSPACE+'/'+run+'head.json'];
      if(local.some(existsSync))refuse('hosted_start_requires_resume');
      if(RUNTIME.durable&&(await RUNTIME.durable.get(run+'manifest.json')||await RUNTIME.durable.get(run+'head.json')))refuse('hosted_start_requires_resume');
    }
  }
}
async function bytes(file,expected){
  const body=await RUNTIME.state.bytes(file);if(expected&&digest(body)!==expected)refuse('private_digest');return body;
}
async function json(file,expected){return JSON.parse((await bytes(file,expected)).toString('utf8'));}
async function put(file,value){
  const body=await RUNTIME.state.put(file,value);if(!(await bytes(file)).equals(body))refuse('private_readback');return digest(body);
}
async function optional(file){try{return await json(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function priorSuccess(){try{return await RUNTIME.state.readPointer('last-success',CARE+'/last-success.json');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function routineHostedPending(runtime,source,runKey,{recovery=false}={}){
  const pointer=JSON.parse(await runtime.state.readPointer('pending-run',runtime.care+'/pending-run.json'));
  const ref=pointer?.pending;
  if(pointer?.schemaVersion!==1||Object.keys(pointer).sort().join(',')!=='pending,schemaVersion'||!ref
    ||Object.keys(ref).sort().join(',')!=='path,sha256'||ref.path!==runtime.care+'/runs/'+runKey+'/hosted-run.json'||!HASH.test(ref.sha256))refuse('hosted_pending');
  const body=await runtime.state.bytes(ref.path);if(digest(body)!==ref.sha256)refuse('hosted_pending');const record=JSON.parse(body),canary=record.kind==='canary';
  if(Object.keys(record).sort().join(',')!==`${canary?'canaryId,':''}day,inputsRef,kind,runKey,schemaVersion,source`||record.schemaVersion!==1
    ||record.source!==source&&!recovery||! /^[a-f0-9]{40}$/.test(source)||! /^[a-f0-9]{40}$/.test(record.source)||record.runKey!==runKey||!['full','photos','canary'].includes(record.kind)
    ||typeof record.day!=='string'||! /^\d{4}-\d{2}-\d{2}$/.test(record.day)||pacificCatalogCalendar(record.day+'T12:00:00Z').day!==record.day
    ||runKey!==(canary?'canary-'+record.day+'-'+record.canaryId:(record.kind==='photos'?'photos-':'scheduled-')+record.day)
    ||canary&&! /^[A-Z0-9]{10}$/.test(record.canaryId??'')||!record.inputsRef
    ||Object.keys(record.inputsRef).sort().join(',')!=='key,schemaVersion,sha256'||record.inputsRef.schemaVersion!==1||!HASH.test(record.inputsRef.sha256)
    ||record.inputsRef.key!=='inputs/'+record.inputsRef.sha256+'.json')refuse('hosted_pending');
  return record;
}
export function routineAutomationPolicy(value){
  if(value===null)return null;
  if(!value||Object.keys(value).sort().join(',')!=='discovery,enabled,homepage,schemaVersion'||value.schemaVersion!==1
    ||typeof value.enabled!=='boolean'||typeof value.discovery!=='boolean'||typeof value.homepage!=='boolean')refuse('automation_policy');
  return value.enabled?{schemaVersion:1,enabled:true,discovery:value.discovery,homepage:value.homepage}:null;
}
/** One durable technical bundle pins preparation timestamps and exact inputs.
 * Interrupted child-file writes replay this bundle, never provider collection. */
export async function materializeRoutinePreparation(directory,bundle,save=put){
  const {config,operator,inputs}=bundle;
  if(bundle.schemaVersion!==1||bundle.kind!=='routine-preparation'||bundle.source!==operator.source
    ||bundle.helperSha256!==operator.helperSha256||config.codeSha!==operator.source||config.runId!==operator.runId
    ||operator.configPath!==directory+'/config.json'||digest(JSON.stringify(config)+'\n')!==operator.configSha256
    ||Object.keys(inputs).sort().join(',')!=='context,rights'
    ||bundle.freshness&&canonicalJson(config.cadence?.automation?.refreshIds)!==canonicalJson(bundle.freshness.refreshIds))refuse('preparation_bundle');
  if(bundle.freshness)await save(directory+'/freshness-plan.json',bundle.freshness);
  if(bundle.preparationReceipt)await save(directory+'/preparation-receipt.json',bundle.preparationReceipt);
  for(const name of ['context','rights']){
    const ref=config.inputs[name];if(ref.path!==directory+'/'+name+'.json'||digest(JSON.stringify(inputs[name])+'\n')!==ref.sha256)refuse('preparation_bundle');
    await save(ref.path,inputs[name]);
  }
  await save(operator.configPath,config);await save(directory+'/operator.json',operator);return operator;
}
/** Paged metadata only; no product/provider bodies or ownership are captured. */
export async function routineFreshnessPool(db,canaryId){
  if(canaryId!==undefined&&! /^[A-Z0-9]{10}$/.test(canaryId))refuse('canary_identity');
  const products=[];let after='';
  for(;;){const rows=(await db.prepare(`SELECT p.id,p.source,p.is_active,p.duplicate_of_product_id,p.availability_status,p.availability_checked_at,
      ${PHOTO_EXPIRY_SQL} photo_expiry FROM products p WHERE p.source='amazon' AND p.public_display_json IS NOT NULL AND p.id${canaryId?'=':'>'}? ORDER BY p.id LIMIT 100`)
    .bind(canaryId??after).all()).results;
    if(!rows.length)return products;
    for(const row of rows){if(typeof row.id!=='string'||row.id<=after||products.length>=10000)refuse('freshness_capture');
      products.push({id:row.id,source:row.source,isActive:row.is_active===1,publiclyCleared:true,duplicateOfProductId:row.duplicate_of_product_id,
        availabilityStatus:row.availability_status,availabilityCheckedAt:row.availability_checked_at,photoExpiresAt:row.photo_expiry});after=row.id;}
    if(canaryId)return products;
  }
}
export async function hydrateRoutineInputs(config,read=bytes){
  for(const name of ['previous','context','rights']){const ref=config.inputs[name];await read(ref.path,ref.sha256);}
  const derived=config.publication?.semanticSearch?.derivedCatalog;
  if(derived){
    // Policy binds canonical catalog identities, not JSON whitespace. The
    // storage adapter independently preserves each original file's raw bytes.
    const catalog=JSON.parse((await read(derived.path)).toString('utf8'));
    await verifyPublicationSemanticCatalog({semanticCatalog:catalog},config.publication);
  }
}
export function routineSearchPolicy(value){
  if(value===null)return{enabled:false};
  const historical=value&&(Object.hasOwn(value,'dailyRequestCap')||Object.hasOwn(value,'dailyTokenCap'));
  if(!value||value.enabled!==true
    ||Object.keys(value).sort().join(',')!==`${historical?'dailyRequestCap,dailyTokenCap,':''}derivedCatalog,enabled`
    ||historical&&(value.dailyRequestCap!==50||value.dailyTokenCap!==32768)
    ||!value.derivedCatalog||Object.keys(value.derivedCatalog).sort().join(',')!=='indexName,path,sha256'
    ||value.derivedCatalog.indexName!=='stupid-gifts-semantic-v1'||!HASH.test(value.derivedCatalog.sha256)
    ||typeof value.derivedCatalog.path!=='string'||!value.derivedCatalog.path.startsWith(BASE+'/')
    ||value.derivedCatalog.path.split('/').includes('..'))refuse('semantic_policy');
  return{enabled:true,derivedCatalog:structuredClone(value.derivedCatalog)};
}
export async function currentD1Plan(token,send=fetch){
  const r=await send(`https://api.cloudflare.com/client/v4/accounts/${SCOPE.accountId}/workers/standard`,{redirect:'error',
    headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(15000)}),j=await r.json();
  if(!r.ok||j.success!==true||typeof j.result?.standard!=='boolean')refuse('plan_unavailable');
  return j.result.standard?'standard':'free';
}
export async function headroom(token,spent={knownRowsRead:0,knownRowsWritten:0},anchor=null,send=fetch,plan='free'){
  const limits=routineLimits(plan);
  if(!Number.isSafeInteger(spent.knownRowsRead)||spent.knownRowsRead<0
    ||!Number.isSafeInteger(spent.knownRowsWritten)||spent.knownRowsWritten<0
    ||!Number.isSafeInteger(spent.unconfirmedRequests??0)||(spent.unconfirmedRequests??0)<0)refuse('run_budget_exceeded');
  const at=new Date(),day=at.toISOString().slice(0,10);
  const r=await send('https://api.cloudflare.com/client/v4/graphql',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
    body:JSON.stringify({query:'query($a:string!,$d:Date!){viewer{accounts(filter:{accountTag:$a}){d1AnalyticsAdaptiveGroups(limit:1000,filter:{date_geq:$d,date_leq:$d}){sum{rowsRead rowsWritten}}}}}',variables:{a:SCOPE.accountId,d:day}})});
  const j=await r.json(),groups=j.data?.viewer?.accounts?.[0]?.d1AnalyticsAdaptiveGroups;
  if(r.status===429||Array.isArray(j.errors)&&j.errors.some(e=>e.extensions?.code==='budget'))refuse('headroom_rate_limited');
  if(!r.ok||j.errors!=null&&(!Array.isArray(j.errors)||j.errors.length>0)
    ||j.data?.viewer?.accounts?.length!==1||!Array.isArray(groups)||groups.length>=1000)refuse('headroom_unavailable');
  if(groups.some(g=>!Number.isSafeInteger(g.sum?.rowsRead)||g.sum.rowsRead<0||!Number.isSafeInteger(g.sum?.rowsWritten)||g.sum.rowsWritten<0))refuse('headroom_invalid');
  const rowsRead=groups.reduce((n,g)=>n+g.sum.rowsRead,0),rowsWritten=groups.reduce((n,g)=>n+g.sum.rowsWritten,0);
  if(!Number.isSafeInteger(rowsRead)||!Number.isSafeInteger(rowsWritten)||rowsRead<0||rowsWritten<0)refuse('headroom_invalid');
  // Includes separate bounded preparation reads, unknown/overshoot reserve,
  // and untouched shared capacity. This is NOT a prepaid per-query promise.
  const chargedRead=Math.max(rowsRead,(anchor?.rowsRead??rowsRead)+spent.knownRowsRead);
  const chargedWrite=Math.max(rowsWritten,(anchor?.rowsWritten??rowsWritten)+spent.knownRowsWritten);
  if(plan==='free'&&(chargedRead+Math.max(0,limits.reportedRowsRead-spent.knownRowsRead)+20000+500000+300000>5000000
    ||chargedWrite+Math.max(0,limits.reportedRowsWritten-spent.knownRowsWritten)+5000+10000>100000))refuse('free_headroom');
  return{observedAt:new Date().toISOString(),utcDay:day,rowsRead,rowsWritten,unknownReadReserve:500000,unknownWriteReserve:5000,untouchedReads:300000,untouchedWrites:10000};
}
export async function observeHeadroom(token,spent,anchor,send,plan){
  try{return await headroom(token,spent,anchor,send,plan);}
  catch(error){
    if(plan!=='standard'||error?.message==='routine_run_budget_exceeded')throw error;
    const code=/^routine_headroom_(?:rate_limited|unavailable|invalid)$/.test(error?.message??'')?error.message:'routine_headroom_unavailable';
    console.warn(JSON.stringify({usageAlert:code,usage:'unknown',releaseBlocked:false}));
    return{observedAt:new Date().toISOString(),usageUnknown:true};
  }
}
export async function routineServingPrior(token,seal,send=fetch){
  const deployments=`https://api.cloudflare.com/client/v4/accounts/${SCOPE.accountId}/workers/scripts/${SCOPE.workerName}/deployments`;
  const deployed=async()=>{
    const response=await send(deployments,{headers:{Authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(15000)});
    const data=await response.json(),value=data?.result?.deployments?.[0];
    if(!response.ok||data.success!==true||!value||!Array.isArray(value.versions)||value.versions.length!==1
      ||value.versions[0].percentage!==100||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id)
      ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.versions[0].version_id))refuse('serving_deployment');
    return {id:value.id,versionReference:value.versions[0].version_id};
  };
  const first=await deployed();
  const response=await send('https://stupid.gifts/.well-known/catalog-release.json',{headers:{'Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(15000)});
  const raw=await response.json(),last=await deployed();
  if(!response.ok||canonicalJson(first)!==canonicalJson(last)||!raw
    ||Object.keys(raw).sort().join(',')!=='catalog_revision,catalog_snapshot_sha256,code_sha,manifest_sha256,release_id'
    ||raw.catalog_revision!==seal.projectionReceipt.catalog_revision||raw.catalog_snapshot_sha256!==seal.snapshotSha256
    ||typeof raw.release_id!=='string'||!/^[a-zA-Z0-9._-]{1,200}$/.test(raw.release_id)
    ||typeof raw.code_sha!=='string'||!/^[a-f0-9]{40}$/.test(raw.code_sha)||!HASH.test(raw.manifest_sha256))refuse('serving_identity');
  return{releaseId:raw.release_id,codeSha:raw.code_sha,catalogRevision:raw.catalog_revision,
    catalogSnapshotSha256:raw.catalog_snapshot_sha256,manifestSha256:raw.manifest_sha256,versionReference:first.versionReference};
}
/** Detect a previously interrupted product write before reserving a merchant batch. */
export async function assertNoUnsealedMaintenance(db,seal,scope=SCOPE){
  const generation=seal.kind==='approved-catalog-seal'?seal.persistent?.generation
    :seal.kind==='permanent-catalog-seal'?seal.control?.installationOwner?.generation+1:NaN;
  if(!Number.isSafeInteger(generation)||generation<1)refuse('prior_generation');
  const rows=(await db.prepare(`SELECT 1 FROM catalog_maintenance_operations
    WHERE environment=? AND index_name=? AND generation>? AND json_array_length(changes_json)>0 LIMIT 1`)
    .bind(scope.environment,scope.indexName,generation).all()).results;
  if(rows.length)refuse('unsealed_maintenance');
}
function options(config,configPath,configSha256){return{config,driver:{configPath,configSha256,workspace:WORKSPACE,cadenceOnly:true,...(RUNTIME.durable?{durable:RUNTIME.durable}:{})},workspace:{directory:WORKSPACE,repository:ROOT,mode:'resume',runId:config.runId,codeSha:SOURCE,configSha256,scope:SCOPE,retention:config.retention,budgetCaps:{httpRequests:config.limits.requests,sqlStatements:config.limits.statements},requestLimit:'observe',...(RUNTIME.durable?{durable:RUNTIME.durable}:{})}};}
async function prepare(directory,calendar,photosOnly=false,admitAsins,canaryId){
  const old=await optional(directory+'/operator.json');
  if(old&&await optional(directory+'/success.json'))return{state:'skipped',reason:'run_already_completed',runId:old.runId};
  if(old?.source===SOURCE&&old.helperSha256===self){const bundle=await optional(directory+'/preparation.json');
    return bundle?materializeRoutinePreparation(directory,bundle):old;}
  if(old)refuse('operator_changed');
  const savedPreparation=await optional(directory+'/preparation.json');
  if(savedPreparation){if(savedPreparation.source!==SOURCE||savedPreparation.helperSha256!==self)refuse('operator_changed');
    return materializeRoutinePreparation(directory,savedPreparation);}
  const automation=canaryId?{schemaVersion:1,enabled:true,discovery:false,homepage:false}
    :admitAsins?null:routineAutomationPolicy(await optional(CARE+'/automation-policy.json')),bundled=RUNTIME.hosted||Boolean(automation);
  if(await optional(directory+'/prepare-intent.json'))refuse('preparation_interrupted');
  const priorBytes=await priorSuccess();if(RUNTIME.hosted&&!priorBytes)refuse('hosted_catalog_bootstrap');
  const prior=priorBytes?JSON.parse(priorBytes.toString('utf8')):INITIAL,seal=await json(prior.control.path,prior.control.sha256);
  if(!['permanent-catalog-seal','approved-catalog-seal'].includes(seal.kind))refuse('prior_kind');
  const token=await RUNTIME.token(),plan=await currentD1Plan(token),limits=routineLimits(plan),capacity=await observeHeadroom(token,undefined,null,fetch,plan);
  const db=await createCatalogD1ReadOnlyRest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,
    ...(bundled?{requestLimit:'observe'}:{}),
    limits:{requests:automation?160:10,statements:automation?240:12,reportedRowsRead:20000,reportedRowsWritten:1}});
  const rows=await db.batch([
    db.prepare('SELECT coalesce(max(sequence),0) n FROM vector_sync_outbox WHERE source_revision=?').bind(seal.projectionReceipt.catalog_revision),
    db.prepare('SELECT coalesce(max(rowid),0) n FROM publication_receipts'),
    db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(seal.publication.releaseId),
    db.prepare('SELECT phase,external_pending FROM catalog_mutation_scopes WHERE environment=? AND index_name=?').bind(SCOPE.environment,SCOPE.indexName),
  ]);
  if(rows[2].results.length!==1||sha256(canonicalJson(rows[2].results[0]))!==seal.publication.receiptSha256||rows[3].results.length!==1||rows[3].results[0].phase!=='idle'||rows[3].results[0].external_pending!==0)refuse('prior_or_owner');
  await assertNoUnsealedMaintenance(db,seal);
  if(photosOnly){
    const due=(await db.prepare(`SELECT p.id FROM products p WHERE p.source='amazon' AND p.is_active=1
      AND p.duplicate_of_product_id IS NULL AND p.public_display_json IS NOT NULL AND ${PHOTO_EXPIRY_SQL}<=? LIMIT 1`)
      .bind(new Date(Date.now()+18*3600000).toISOString()).all()).results;
    if(!due.length)return{state:'skipped',reason:'photos_current'};
  }
  if(!bundled)await put(directory+'/prepare-intent.json',{source:SOURCE,helperSha256:self,createdAt:new Date().toISOString(),prior,preparationMaximumReads:20000,preparationMaximumWrites:0});
  const servingPrior=await routineServingPrior(token,seal);
  const preparationReceipt={capacity,metrics:db.metrics(),servingPrior,prior,source:SOURCE,helperSha256:self};
  if(!bundled)await put(directory+'/preparation-receipt.json',preparationReceipt);
  const now=new Date().toISOString(),cutoff=new Date(Date.now()+(RUNTIME.hosted&&automation?24:2)*3600000).toISOString(),notAfter=new Date(Date.now()+86400000).toISOString();
  const context={envelopeSha256:sha256(seal.envelopeJson+'\n'),snapshotSha256:seal.snapshotSha256,projectionSha256:seal.projectionReceipt.projection_sha256,sourceExportSha256:seal.projectionReceipt.source_export_sha256,vectorSyncWatermark:rows[0].results[0].n,publicationReceiptWatermark:rows[1].results[0].n,cutoff,priorPublication:seal.publication};
  const inputValues={context,rights:{rightsById:{}}},inputs={previous:{path:prior.control.path,sha256:prior.control.sha256,observedAt:now}};
  for(const [name,value]of Object.entries(inputValues)){const file=directory+'/'+name+'.json';inputs[name]={path:file,
    sha256:bundled?digest(JSON.stringify(value)+'\n'):await put(file,value),observedAt:now};}
  const runId='daily-'+calendar.day+'-'+SOURCE.slice(0,8)+'-'+digest(path.basename(directory)).slice(0,8);
  let homepageEdition=await routineHomepageEdition(calendar.day,prior.control.path,canaryId?file=>
    file===path.dirname(prior.control.path)+'/homepage-edition.json'?optional(file):null:optional);
  const semanticSearch=routineSearchPolicy(await optional(CARE+'/semantic-search.json'));
  const merchandising=bundled?await loadAutomationMerchandising({runtime:RUNTIME,db,seal}):await routineMerchandising();
  if(automation?.homepage&&!photosOnly){try{
    const {curateAutomationHomepage}=await import('./automated-homepage.mjs');
    const result=await curateAutomationHomepage({runtime:RUNTIME,db,seal,prior:homepageEdition,day:calendar.day,merchandising,repository:ROOT,source:SOURCE});
    if(readHomepageEdition(result.edition))homepageEdition=result.edition;
    if(result.attention)console.warn(JSON.stringify({notice:result.attention,catalogBlocked:false}));
  }catch{console.warn(JSON.stringify({notice:'homepage_editor_unavailable',catalogBlocked:false}));}}
  const pool=automation?await routineFreshnessPool(db,canaryId):null;
  if(canaryId&&(pool.length!==1||pool[0].id!==canaryId||!pool[0].isActive||pool[0].duplicateOfProductId))refuse('canary_not_cleared_public');
  if(canaryId&&(await db.prepare('SELECT product_id FROM catalog_public_products WHERE catalog_revision=? AND product_id=?')
    .bind(seal.projectionReceipt.catalog_revision,canaryId).all()).results.length!==1)refuse('canary_not_cleared_public');
  const freshness=automation?planRoutineAutomation(pool,now,{exposedIds:[...homepageEdition.anchors,...homepageEdition.rotation],
    promotedIds:Object.entries(merchandising).filter(([,value])=>value.commissionPriority&&Date.parse(value.commissionUntil)>Date.parse(now)).map(([id])=>id),photosOnly}):null;
  if(canaryId){freshness.refreshIds=[canaryId];freshness.canaryId=canaryId;}
  const automated=freshness?{schemaVersion:1,refreshIds:freshness.refreshIds,discovery:!photosOnly&&automation.discovery}:null;
  const needsModel=!canaryId&&(admitAsins||!photosOnly&&(automated?automated.discovery:calendar.monday));
  let discoveryInputs;
  if(automated?.discovery){try{discoveryInputs=await loadAutomationDiscoveryInputs({runtime:RUNTIME,db});}
    catch{discoveryInputs={leadAsins:[],searchTopics:[]};console.warn(JSON.stringify({notice:'discovery_leads_unavailable',catalogBlocked:false}));}}
  if(discoveryInputs?.leadAsins.length)automated.leadAsins=discoveryInputs.leadAsins;
  if(discoveryInputs?.searchTopics.length)automated.searchTopics=discoveryInputs.searchTopics;
  if(bundled)preparationReceipt.metrics=db.metrics();
  const config=validateCloudflareWeeklyConfig({schemaVersion:1,runId,catalogRevision:runId,codeSha:SOURCE,environment:SCOPE.environment,accountId:SCOPE.accountId,database:{id:SCOPE.databaseId,name:SCOPE.databaseName},vectorIndex:{name:SCOPE.indexName,dimensions:1536,metric:'cosine'},catalog:{associateTag:'goose-gifts-37-20',marketplace:'www.amazon.com'},backfillLimit:0,cadence:{day:calendar.day,featuredIds:[...homepageEdition.anchors,...homepageEdition.rotation],runKey:runId,...(photosOnly?{photosOnly:true}:{}),...(admitAsins?{admitAsins}:{}),...(automated?{automation:automated}:{})},credentials:{cloudflare:RUNTIME.credentials.cloudflare,amazonId:RUNTIME.credentials.amazonId,amazonSecret:RUNTIME.credentials.amazonSecret,amazonVersion:'3.1',...(needsModel?{openai:RUNTIME.credentials.openai}:{})},limits,retention:{reviewReference:'owner/2026-11-02/per-run-catalog-bounds',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint'].map(k=>[k,{maxAgeMs:86400000,notAfter}]))},inputs,
    publication:{schemaVersion:1,environment:SCOPE.environment,accountId:SCOPE.accountId,workerName:SCOPE.workerName,database:{id:SCOPE.databaseId,name:SCOPE.databaseName},indexName:SCOPE.indexName,codeSha:SOURCE,sourceMode:'stupid-production',sourceRoot:ROOT,releaseId:runId,identityOrigin:'https://stupid.gifts',compatibilityDate:'2026-10-19',prior:{directory:null,releaseId:seal.publication.releaseId,manifestSha256:prior.manifestSha256,versionReference:prior.versionReference},servingPrior,semanticSearch,homepage:homepageEdition,merchandising,publicAnalytics:{enabled:true,posthogHost:'https://us.i.posthog.com',posthogKey:'phc_ATVKSPwDYTRfX9qDtDVLzZuXQcNdV9d55SjC8bHtuU8w'}}});
  const configPath=directory+'/config.json',configSha256=bundled?digest(JSON.stringify(config)+'\n'):await put(configPath,config),record={source:SOURCE,helperSha256:self,configPath,configSha256,runId,capacity};
  if(bundled){const bundle={schemaVersion:1,kind:'routine-preparation',source:SOURCE,helperSha256:self,config,inputs:inputValues,operator:record,preparationReceipt,
    ...(freshness?{freshness}:{}),...(discoveryInputs?{discoveryInputs}:{})};
    await put(directory+'/preparation.json',bundle);return materializeRoutinePreparation(directory,bundle);}
  await put(directory+'/operator.json',record);return record;
}
export function routineReviewProduct(p,display=JSON.parse(p.public_display_json??'null')){
  return{id:p.id,publicId:p.public_id,slug:p.slug,editorialStatus:p.editorial_status,publicTitle:display?.title,
    description:display?.description,imageUrl:display?.imageUrl,publicAffiliateUrl:display?.affiliateUrl,
    persistent:display?.eligibleUntil===null||Boolean(display?.persistent),sourceFactsHash:p.source_facts_hash};
}
async function review(entry,config,directory){
  const w=await openRunWorkspace(entry.workspace);
  try{const cp=await w.readCheckpoint(),owner=cp?.checkpoint.owner;if(cp?.checkpoint.phase!=='phases_complete'||!owner||owner.phase!=='writing')refuse('review_phase');
    const token=await RUNTIME.token(),db=await createCatalogD1ReadOnlyRest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,limits:config.limits,requestLimit:'observe',accounting:{scope:{accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName},initial:await w.budget(),reserve:r=>w.reserveBudget(r),settle:(id,s)=>w.settleBudget(id,s)}});
    await mutationAssertion(db,owner,['writing']).all();
    const ops=(await db.prepare('SELECT operation_id,input_sha256,changes_json,next_epoch,generation,environment,index_name FROM catalog_maintenance_operations WHERE run_id=? ORDER BY next_epoch').bind(config.runId).all()).results;
    const latest=new Map();for(const op of ops){if(op.generation>owner.generation||op.environment!==SCOPE.environment||op.index_name!==SCOPE.indexName)refuse('operation_scope');for(const change of JSON.parse(op.changes_json))latest.set(change.productId,{op,change});}
    // Automated mutations are bounded by their exact saved phase receipts and
    // admission decisions, not a second unrelated truncation of approved work.
    if(!config.cadence.automation&&latest.size>10+(pacificCatalogCalendar(config.cadence.day+'T12:00:00Z').monday?20:0))refuse('review_bound');
    const changes=[],summary=[];
    for(const [id,{op,change}]of latest){const rows=(await db.prepare('SELECT * FROM products WHERE id=?').bind(id).all()).results,p=rows[0];
      if(rows.length!==1||p.catalog_revision!==config.catalogRevision||sha256(canonicalJson(p))!==change.afterSha256)refuse('changed_product');
      const display=JSON.parse(p.public_display_json??'null');
      if(display?.price!==undefined&&display.price!==0)refuse('public_price');
      changes.push({publicId:p.public_id,operationId:op.operation_id,inputSha256:op.input_sha256,productSha256:sha256(canonicalJson(p)),displaySha256:sha256(p.public_display_json??'null')});
      summary.push(routineReviewProduct(p,display));
    }
    await mutationAssertion(db,owner,['writing']).all();
    const proposal={schemaVersion:1,runId:config.runId,catalogRevision:config.catalogRevision,changes:changes.sort((a,b)=>a.publicId.localeCompare(b.publicId))};
    const proposalPath=directory+'/reviewed-proposal.json',proposalSha256=await put(proposalPath,proposal);
    console.log(JSON.stringify({state:'requires_agent_review',proposalPath,proposalSha256,summary,budget:await w.budget()}));
  }finally{await w.close();}
}
export async function routineHomepageEdition(day,priorControl,read=optional){
  for(const file of [CARE+'/homepage/'+day+'.json',path.dirname(priorControl)+'/homepage-edition.json']){
    try{const edition=readHomepageEdition(await read(file));
      if(edition&&(!file.endsWith('/'+day+'.json')||edition.day===day))return edition;
    }catch{/* Optional editorial input must not strand maintenance. */}
  }
  return readHomepageEdition(defaultEdition);
}
export async function remember(result,entry,config,directory){
  if(result.state!=='finalized'||!result.catalogSeal)return;
  const w=await openRunWorkspace(entry.workspace);
  try{const cp=await w.readCheckpoint({controlOnly:true});if(cp?.checkpoint.phase!=='finalized'||cp.checkpoint.owner!==null)refuse('final_state');const control=cp.checkpoint.control.publication;
  if(control.stage!=='published'||!control.intent||control.intent.releaseId!==config.publication.releaseId||!control.versionReference)refuse('final_identity');
  const file=directory+'/catalog-control.json',hash=await put(file,result.catalogSeal),next={control:{path:file,sha256:hash},versionReference:control.versionReference,manifestSha256:control.intent.manifestSha256};
  if(config.publication.homepage)await put(directory+'/homepage-edition.json',config.publication.homepage);
  await put(directory+'/success.json',{next,result:weeklyCommandSummary(result),source:config.codeSha,operatorSource:SOURCE,helperSha256:self});
  const pointer=CARE+'/last-success.json',oldBytes=await priorSuccess(),old=oldBytes?JSON.parse(oldBytes.toString('utf8')):null;
  if(old&&old.control.sha256!==config.inputs.previous.sha256&&old.control.sha256!==hash)refuse('successor_pointer_changed');
  if(old?.control.sha256===hash)return;
  await RUNTIME.state.pointer('last-success',pointer,next,oldBytes);
  }finally{await w.close();}
}
/** Acceptance is durable before source-only output cleanup. Opening/closing a
 * cleanup handle can fail too; neither turns an accepted release into failure. */
export async function cleanupAcceptedPublication(options,releaseId,open=openPublicationBuildCleanup,warn=console.warn){
  let workspace,pending=false;
  try{workspace=await open(options);await workspace.cleanPublicationBuild(releaseId);}
  catch{pending=true;}
  finally{try{await workspace?.close();}catch{pending=true;}}
  const result={cleanupPending:pending,releaseAccepted:true};
  if(pending)warn(JSON.stringify(result));
  return result;
}
export function operatorInvocation(argv,calendar){
  const args=[...argv],photoFlag=args.indexOf('--photos-only'),photosOnly=photoFlag>=0;
  if(photosOnly)args.splice(photoFlag,1);
  const admitFlag=args.indexOf('--admit-asins');
  const admitAsins=admitFlag>=0?args[admitFlag+1]?.split(','):undefined;
  if(admitFlag>=0)args.splice(admitFlag,2);
  const canaryFlag=args.indexOf('--canary-id'),canaryId=canaryFlag>=0?args[canaryFlag+1]:undefined;
  if(canaryFlag>=0)args.splice(canaryFlag,2);
  const flag=args.indexOf('--run');
  let runKey='scheduled-'+calendar.day;
  if(flag>=0){runKey=args[flag+1];args.splice(flag,2);}
  const [command,approvalSha]=args;
  if(!validCatalogRunKey(runKey)
    ||!['prepare','review','start','resume','publish','recover','status','reconcile-availability'].includes(command)
    ||(command==='resume'?args.length<1||args.length>2:args.length!==(['publish','recover'].includes(command)?2:1))
    ||command==='resume'&&approvalSha!==undefined&&!HASH.test(approvalSha)||photosOnly&&command!=='prepare'||photosOnly&&flag<0
    ||canaryFlag>=0&&(command!=='prepare'||flag<0||photosOnly||admitAsins||! /^[A-Z0-9]{10}$/.test(canaryId??'')
      ||runKey!=='canary-'+calendar.day+'-'+canaryId)
    ||admitFlag>=0&&(command!=='prepare'||flag<0||photosOnly||!admitAsins?.length||admitAsins.length>10
      ||new Set(admitAsins).size!==admitAsins.length||admitAsins.some(id=>! /^[A-Z0-9]{10}$/.test(id))))refuse('command');
  return{command,approvalSha,runKey,...(photosOnly?{photosOnly:true}:{}),...(admitAsins?{admitAsins}:{}),...(canaryId?{canaryId}:{})};
}
/** A reviewed descendant may resume the original finite cohort with its exact
 * config digest. Saved provider/model stages are reused, never re-collected.
 * Post-provider recovery still requires the original approval pin. */
export function routineRecoveryPhase(cp,config,configSha256,digest){
  const originalWriter=config.cadence?.automation&&HASH.test(configSha256??'')
    &&cp?.owner?.phase==='writing'&&cp.owner.ownerReference===config.runId
    &&cp.owner.operationKey===sha256(`weekly:${configSha256}`);
  if(originalWriter&&digest===configSha256){
    if(cp.phase==='phases_running')return 'provider';
    if(cp.phase==='phases_complete')return 'review';
  }
  if(originalWriter&&cp.phase==='phases_complete'&&HASH.test(digest??''))return 'publication';
  if(!cp||!['freezing','publishing','attention','published','finalized'].includes(cp.phase)||!cp.pins?.approval)
    refuse('provider_replay_forbidden');
  return 'publication';
}
export async function main(argv=process.argv.slice(2)){
if(argv[0]==='code-only'){
  const operator=await import('./code-only-operator.mjs');operator.codeOnlyInvocation(argv.slice(1));
  await source('code-only');await operator.codeOnlyMain(argv.slice(1));return;
}
let calendar=pacificCatalogCalendar();
// Parse the stable run key first. A captured prior day is trusted ONLY through
// the immutable hosted pending record, never a CLI date/environment override.
const rawRun=argv.indexOf('--run'),pending=RUNTIME.hosted?await routineHostedPending(RUNTIME,SOURCE,rawRun>=0?argv[rawRun+1]:'scheduled-'+calendar.day,{recovery:argv[0]==='recover'}):null;
if(pending)calendar=pacificCatalogCalendar(pending.day+'T12:00:00Z');
const {command,approvalSha,runKey,photosOnly,admitAsins,canaryId}=operatorInvocation(argv,calendar),directory=CARE+'/runs/'+runKey;
if(canaryId&&(!pending||pending.kind!=='canary'||pending.canaryId!==canaryId)||pending?.kind==='canary'&&command==='prepare'&&!canaryId)refuse('canary_authority');
if(pending&&command==='prepare'&&(Boolean(photosOnly)!==(pending.kind==='photos')||admitAsins))refuse('hosted_pending');
await source(command,runKey,pending);
if(command==='prepare'||command==='reconcile-availability'){
  if(command==='reconcile-availability'&&(!argv.includes('--run')||photosOnly||admitAsins))refuse('availability_command');
  const record=await prepare(directory,calendar,photosOnly,admitAsins,canaryId);
  if(command==='prepare'||record.state==='skipped')console.log(JSON.stringify(record));
  else{
    const config=validateCloudflareWeeklyConfig(await json(record.configPath,record.configSha256)),entry=options(config,record.configPath,record.configSha256);
    const w=await openRunWorkspace({...entry.workspace,mode:existsSync(WORKSPACE+'/runs/'+config.runId+'/manifest.json')?'resume':'create'});
    try{const token=await RUNTIME.token(),db=await (await load('scripts/catalog/d1-write-rest.ts')).createCatalogD1Rest({
      accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,limits:config.limits,requestLimit:'observe',
      accounting:{scope:{accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName},initial:await w.budget(),reserve:r=>w.reserveBudget(r),settle:(id,s)=>w.settleBudget(id,s)}});
      await (await load('scripts/catalog/availability-publication.ts')).beginAvailabilityPublication({workspace:w,db,config,configSha256:record.configSha256});
      console.log(JSON.stringify({state:'requires_agent_review',runId:config.runId,supplierRequests:0,modelRequests:0,productMutations:0}));
    }finally{await w.close();}
  }
}
else{
  const record=await json(directory+'/operator.json'),recovering=command==='recover';
  if(!recovering&&(record.helperSha256!==self||record.source!==SOURCE))refuse('operator_changed');
  const config=validateCloudflareWeeklyConfig(await json(record.configPath,record.configSha256)),entry=options(config,record.configPath,record.configSha256);
  await hydrateRoutineInputs(config);
  let recoveryPhase=null;
  if(recovering){
    const old=config.publication.sourceRoot,git=(...args)=>execFileSync('git',args,{cwd:old,encoding:'utf8'}).trim();
    if(RUNTIME.hosted&&pending?.source!==record.source||config.codeSha!==record.source||git('rev-parse','HEAD')!==record.source||git('status','--porcelain','--untracked-files=all')
      ||digest(await fs.readFile(old+'/scripts/catalog/daily-operator.mjs'))!==record.helperSha256)refuse('original_source');
    try{git('merge-base','--is-ancestor',record.source,SOURCE);}catch{refuse('original_source');}
    entry.workspace.repository=old;entry.workspace.codeSha=record.source;
    const w=await openRunWorkspace(entry.workspace);
    try{const cp=await w.readCheckpoint({controlOnly:true});
      recoveryPhase=routineRecoveryPhase(cp?.checkpoint,config,record.configSha256,approvalSha);
    }finally{await w.close();}
  }
  if(command==='review'||recoveryPhase==='review')await review(entry,config,directory);
  else if(['start','resume','publish','recover','status'].includes(command)){
    if(['publish','recover'].includes(command)&&!HASH.test(approvalSha??''))refuse('explicit_review_digest');
    if(command==='start'){const token=await RUNTIME.token();await observeHeadroom(token,undefined,record.capacity,fetch,await currentD1Plan(token));}
    if(['resume','publish'].includes(command)||recovering){
      const w=await openRunWorkspace(entry.workspace);let spent;try{spent=await w.budget();}finally{await w.close();}
      const token=await RUNTIME.token();await observeHeadroom(token,spent,record.capacity,fetch,await currentD1Plan(token));
    }
    const result=await runCloudflareWeekly({...entry.driver,command:command==='publish'||recovering?'resume':command,
      ...(approvalSha&&recoveryPhase!=='provider'?{approval:{path:directory+'/reviewed-proposal.json',sha256:approvalSha}}:{})},
      recovering?{repository:config.publication.sourceRoot}:{});
    await remember(result,entry,config,directory);console.log(JSON.stringify(weeklyCommandSummary(result)));
    if(result.state==='finalized'){
      await cleanupAcceptedPublication(entry.workspace,config.runId);
    }
  }else refuse('command');
}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{
  for(let cause=error instanceof Error?error.cause:null,depth=0;cause instanceof Error&&depth++<4;cause=cause.cause)
    if(/^catalog_object_store_[a-z_]{1,80}$/.test(cause.message))console.error(cause.message);
  const code=error instanceof Error?error.message:'';
  console.error(/^[a-z][a-z0-9_]{0,149}$/.test(code)?code:'catalog_care_failed');process.exitCode=1;
});

