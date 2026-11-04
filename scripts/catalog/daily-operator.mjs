import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {readHomepageEdition} from '../../lib/catalog/homepage-edition.ts';
import defaultEdition from '../../content/homepage-edition.json' with {type:'json'};
import homepage from '../../content/homepage.json' with {type:'json'};
import path from 'node:path';

// Sole daily Codex operator; no hosted Cron or additional publisher. Normal reviewed driver owns every
// merchant phase, reservation, write, vector operation and publication.
const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url)));
const SOURCE=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();
const BASE=path.join(homedir(),'.codex/private/goose-gifts-migration');
const WORKSPACE=BASE+'/weekly-runs',CARE=BASE+'/daily-catalog-care';
const INITIAL={control:{path:BASE+'/existing-display-20261023-v2/catalog-control.json',sha256:'434c960466f42f71acce83b037a8a23cefef18e7f02d0a2f111c2a99e3a311e1'},
  versionReference:'1924de55-cc4b-46a9-8ca9-e30f21ea5028',manifestSha256:'5d64c77465da9e1eee065232d256172c7906a22505c9d6f2e8ae2c0fe28ef792'};
const SCOPE={environment:'production',accountId:'7f05a1dcb6e16f9c239564a0293bbe74',databaseId:'77b30f85-c57c-4acb-a0df-53368806c2a6',databaseName:'stupid-gifts-production',workerName:'stupid-gifts-production',indexName:'stupid-gifts-production'};
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
const {resolveWranglerOAuth}=await load('scripts/catalog/check-cloudflare-runner.ts');
const {createCatalogD1ReadOnlyRest}=await load('scripts/catalog/d1-write-rest.ts');
const {openRunWorkspace}=await load('scripts/catalog/run-workspace.ts');
const {mutationAssertion}=await load('lib/catalog/mutation-fence.ts');
const {pacificCatalogCalendar,validCatalogRunKey}=await load('scripts/ops/catalog-daily.mjs');
const HASH=/^[a-f0-9]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const self=digest(await fs.readFile(new URL(import.meta.url)));
function refuse(code){throw Error('routine_'+code);}
function source(){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  if(process.versions.node.split('.')[0]!=='22'||process.cwd()!==ROOT||git('rev-parse','HEAD')!==SOURCE||git('status','--porcelain','--untracked-files=all'))refuse('source');
  if(Object.keys(process.env).some(k=>/^(AMAZON_|OPENAI_|POSTGRES_|VERCEL_|CATALOG_)/.test(k)))refuse('ambient_configuration');
}
async function bytes(file,expected){
  if(!file.startsWith(BASE+'/')||await fs.realpath(file)!==file)refuse('private_path');
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size>10*1024*1024)refuse('private_file');
  const body=await fs.readFile(file);if(expected&&digest(body)!==expected)refuse('private_digest');return body;
}
async function json(file,expected){return JSON.parse((await bytes(file,expected)).toString('utf8'));}
async function put(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const stat=await fs.lstat(path.dirname(file));if((stat.mode&0o777)!==0o700||await fs.realpath(path.dirname(file))!==path.dirname(file))refuse('private_directory');
  const body=Buffer.from(JSON.stringify(value)+'\n');
  let handle;try{handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(e){if(e.code!=='EEXIST'||!(await bytes(file)).equals(body))refuse('immutable_changed');return digest(body);}
  try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}
  if(!(await bytes(file)).equals(body))refuse('private_readback');return digest(body);
}
async function optional(file){try{return await json(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
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
  if(!Number.isSafeInteger(spent.knownRowsRead)||spent.knownRowsRead<0||spent.knownRowsRead>limits.reportedRowsRead
    ||!Number.isSafeInteger(spent.knownRowsWritten)||spent.knownRowsWritten<0||spent.knownRowsWritten>limits.reportedRowsWritten
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
function options(config,configPath,configSha256){return{config,driver:{configPath,configSha256,workspace:WORKSPACE,cadenceOnly:true},workspace:{directory:WORKSPACE,repository:ROOT,mode:'resume',runId:config.runId,codeSha:SOURCE,configSha256,scope:SCOPE,retention:config.retention,budgetCaps:{httpRequests:config.limits.requests,sqlStatements:config.limits.statements},requestLimit:'observe'}};}
async function prepare(directory,calendar){
  const old=await optional(directory+'/operator.json');
  if(old&&await optional(directory+'/success.json'))return{state:'skipped',reason:'run_already_completed',runId:old.runId};
  if(old?.source===SOURCE&&old.helperSha256===self)return old;
  if(old)refuse('operator_changed');
  if(await optional(directory+'/prepare-intent.json'))refuse('preparation_interrupted');
  const prior=await optional(CARE+'/last-success.json')??INITIAL,seal=await json(prior.control.path,prior.control.sha256);
  if(!['permanent-catalog-seal','approved-catalog-seal'].includes(seal.kind))refuse('prior_kind');
  const token=await resolveWranglerOAuth(),plan=await currentD1Plan(token),limits=routineLimits(plan),capacity=await headroom(token,undefined,null,fetch,plan);
  const db=await createCatalogD1ReadOnlyRest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,limits:{requests:10,statements:12,reportedRowsRead:20000,reportedRowsWritten:1}});
  const rows=await db.batch([
    db.prepare('SELECT coalesce(max(sequence),0) n FROM vector_sync_outbox WHERE source_revision=?').bind(seal.projectionReceipt.catalog_revision),
    db.prepare('SELECT coalesce(max(rowid),0) n FROM publication_receipts'),
    db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(seal.publication.releaseId),
    db.prepare('SELECT phase,external_pending FROM catalog_mutation_scopes WHERE environment=? AND index_name=?').bind(SCOPE.environment,SCOPE.indexName),
  ]);
  if(rows[2].results.length!==1||sha256(canonicalJson(rows[2].results[0]))!==seal.publication.receiptSha256||rows[3].results.length!==1||rows[3].results[0].phase!=='idle'||rows[3].results[0].external_pending!==0)refuse('prior_or_owner');
  await assertNoUnsealedMaintenance(db,seal);
  await put(directory+'/prepare-intent.json',{source:SOURCE,helperSha256:self,createdAt:new Date().toISOString(),prior,preparationMaximumReads:20000,preparationMaximumWrites:0});
  const servingPrior=await routineServingPrior(token,seal);
  await put(directory+'/preparation-receipt.json',{capacity,metrics:db.metrics(),servingPrior,prior,source:SOURCE,helperSha256:self});
  const now=new Date().toISOString(),cutoff=new Date(Date.now()+2*3600000).toISOString(),notAfter=new Date(Date.now()+86400000).toISOString();
  const context={envelopeSha256:sha256(seal.envelopeJson+'\n'),snapshotSha256:seal.snapshotSha256,projectionSha256:seal.projectionReceipt.projection_sha256,sourceExportSha256:seal.projectionReceipt.source_export_sha256,vectorSyncWatermark:rows[0].results[0].n,publicationReceiptWatermark:rows[1].results[0].n,cutoff,priorPublication:seal.publication};
  const inputs={previous:{path:prior.control.path,sha256:prior.control.sha256,observedAt:now}};
  for(const [name,value]of Object.entries({context,rights:{rightsById:{}}})){const file=directory+'/'+name+'.json';inputs[name]={path:file,sha256:await put(file,value),observedAt:now};}
  const key=service=>({service:'goose.gifts.'+service,account:'goose.gifts'}),runId='daily-'+calendar.day+'-'+SOURCE.slice(0,8)+'-'+digest(path.basename(directory)).slice(0,8);
  const homepageEdition=await routineHomepageEdition(calendar.day,prior.control.path);
  const semanticSearch=routineSearchPolicy(await optional(CARE+'/semantic-search.json'));
  const config=validateCloudflareWeeklyConfig({schemaVersion:1,runId,catalogRevision:runId,codeSha:SOURCE,environment:SCOPE.environment,accountId:SCOPE.accountId,database:{id:SCOPE.databaseId,name:SCOPE.databaseName},vectorIndex:{name:SCOPE.indexName,dimensions:1536,metric:'cosine'},catalog:{associateTag:'goose-gifts-37-20',marketplace:'www.amazon.com'},backfillLimit:0,cadence:{day:calendar.day,featuredIds:homepage.featuredIds,runKey:runId},credentials:{cloudflare:{type:'wrangler_oauth'},amazonId:key('AMAZON_CREATORS_CREDENTIAL_ID'),amazonSecret:key('AMAZON_CREATORS_CREDENTIAL_SECRET'),amazonVersion:'3.1',...(calendar.monday?{openai:key('OPENAI_API_KEY')}:{})},limits,retention:{reviewReference:'owner/2026-11-02/per-run-catalog-bounds',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint'].map(k=>[k,{maxAgeMs:86400000,notAfter}]))},inputs,
    publication:{schemaVersion:1,environment:SCOPE.environment,accountId:SCOPE.accountId,workerName:SCOPE.workerName,database:{id:SCOPE.databaseId,name:SCOPE.databaseName},indexName:SCOPE.indexName,codeSha:SOURCE,sourceMode:'stupid-production',sourceRoot:ROOT,releaseId:runId,identityOrigin:'https://stupid.gifts',compatibilityDate:'2026-10-19',prior:{directory:null,releaseId:seal.publication.releaseId,manifestSha256:prior.manifestSha256,versionReference:prior.versionReference},servingPrior,semanticSearch,homepage:homepageEdition,publicAnalytics:{enabled:true,posthogHost:'https://us.i.posthog.com',posthogKey:'phc_ATVKSPwDYTRfX9qDtDVLzZuXQcNdV9d55SjC8bHtuU8w'}}});
  const configPath=directory+'/config.json',configSha256=await put(configPath,config),record={source:SOURCE,helperSha256:self,configPath,configSha256,runId,capacity};await put(directory+'/operator.json',record);return record;
}
async function review(entry,config,directory){
  const w=await openRunWorkspace(entry.workspace);
  try{const cp=await w.readCheckpoint(),owner=cp?.checkpoint.owner;if(cp?.checkpoint.phase!=='phases_complete'||!owner||owner.phase!=='writing')refuse('review_phase');
    const token=await resolveWranglerOAuth(),db=await createCatalogD1ReadOnlyRest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,limits:config.limits,accounting:{scope:{accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName},initial:await w.budget(),reserve:r=>w.reserveBudget(r),settle:(id,s)=>w.settleBudget(id,s)}});
    await mutationAssertion(db,owner,['writing']).all();
    const ops=(await db.prepare('SELECT operation_id,input_sha256,changes_json,next_epoch,generation,environment,index_name FROM catalog_maintenance_operations WHERE run_id=? ORDER BY next_epoch').bind(config.runId).all()).results;
    const latest=new Map();for(const op of ops){if(op.generation>owner.generation||op.environment!==SCOPE.environment||op.index_name!==SCOPE.indexName)refuse('operation_scope');for(const change of JSON.parse(op.changes_json))latest.set(change.productId,{op,change});}
    if(latest.size>10+(pacificCatalogCalendar(config.cadence.day+'T12:00:00Z').monday?20:0))refuse('review_bound');
    const changes=[],summary=[];
    for(const [id,{op,change}]of latest){const rows=(await db.prepare('SELECT * FROM products WHERE id=?').bind(id).all()).results,p=rows[0];
      if(rows.length!==1||p.catalog_revision!==config.catalogRevision||sha256(canonicalJson(p))!==change.afterSha256)refuse('changed_product');
      const display=JSON.parse(p.public_display_json??'null');
      if(display?.price!==undefined&&display.price!==0)refuse('public_price');
      changes.push({publicId:p.public_id,operationId:op.operation_id,inputSha256:op.input_sha256,productSha256:sha256(canonicalJson(p)),displaySha256:sha256(p.public_display_json??'null')});
      summary.push({id,publicId:p.public_id,slug:p.slug,editorialStatus:p.editorial_status,publicTitle:display?.title,description:display?.description,imageUrl:display?.imageUrl,persistent:display?.eligibleUntil===null||Boolean(display?.persistent),sourceFactsHash:p.source_facts_hash});
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
  const pointer=CARE+'/last-success.json',old=await optional(pointer);
  if(old&&old.control.sha256!==config.inputs.previous.sha256&&old.control.sha256!==hash)refuse('successor_pointer_changed');
  if(old?.control.sha256===hash)return;
  const temporary=directory+'/next-success.json';await put(temporary,next);await fs.rename(temporary,pointer);
  }finally{await w.close();}
}
export function operatorInvocation(argv,calendar){
  const args=[...argv],flag=args.indexOf('--run');
  let runKey='scheduled-'+calendar.day;
  if(flag>=0){runKey=args[flag+1];args.splice(flag,2);}
  const [command,approvalSha]=args;
  if(!validCatalogRunKey(runKey)
    ||!['prepare','review','start','publish','status'].includes(command)
    ||args.length!==(command==='publish'?2:1))refuse('command');
  return{command,approvalSha,runKey};
}
export async function main(){
source();const calendar=pacificCatalogCalendar(),{command,approvalSha,runKey}=operatorInvocation(process.argv.slice(2),calendar),directory=CARE+'/runs/'+runKey;
if(command==='prepare'){console.log(JSON.stringify(await prepare(directory,calendar)));}
else{
  const record=await json(directory+'/operator.json');if(record.helperSha256!==self||record.source!==SOURCE)refuse('operator_changed');
  const config=validateCloudflareWeeklyConfig(await json(record.configPath,record.configSha256)),entry=options(config,record.configPath,record.configSha256);
  if(command==='review')await review(entry,config,directory);
  else if(['start','publish','status'].includes(command)){
    if(command==='publish'&&!HASH.test(approvalSha??''))refuse('explicit_review_digest');
    if(command==='start'){const token=await resolveWranglerOAuth();await headroom(token,undefined,record.capacity,fetch,await currentD1Plan(token));}
    if(command==='publish'){
      const w=await openRunWorkspace(entry.workspace);let spent;try{spent=await w.budget();}finally{await w.close();}
      const token=await resolveWranglerOAuth();await headroom(token,spent,record.capacity,fetch,await currentD1Plan(token));
    }
    const result=await runCloudflareWeekly({...entry.driver,command:command==='publish'?'resume':command,...(command==='publish'?{approval:{path:directory+'/reviewed-proposal.json',sha256:approvalSha}}:{})});
    await remember(result,entry,config,directory);console.log(JSON.stringify(weeklyCommandSummary(result)));
  }else refuse('command');
}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();

