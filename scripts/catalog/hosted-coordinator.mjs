import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createInterface} from 'node:readline';
import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {automationRuntime,CATALOG_SCOPE} from './automation-runtime.mjs';
import {currentHostedInputs,restoreHostedInputs,syncHostedCampaignFeed} from './hosted-inputs.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {checkCloudflareRunner} from './check-cloudflare-runner.ts';
import {catalogD1FailureDetail} from './d1-write-rest.ts';
import {hostedRunRecord,hostedRunKey,validAdmissionAsins,validSavedAdmissionRun} from './hosted-run-record.mjs';
import {loadSavedAdmission} from './saved-admission.mjs';
export {hostedRunRecord} from './hosted-run-record.mjs';

const exec=promisify(execFile),HASH=/^[a-f0-9]{64}$/,SOURCE=/^[a-f0-9]{40}$/,ASIN=/^[A-Z0-9]{10}$/;
const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url))),OPERATORS='/home/runner/stupid-gifts/operators';
const hash=value=>createHash('sha256').update(value).digest('hex');
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
const fail=reason=>{throw Error('catalog_hosted_'+reason);};
const json=bytes=>JSON.parse(Buffer.from(bytes).toString('utf8'));
async function optional(read){try{return await read();}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function day(value){const time=new Date(value+'T00:00:00Z');if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)
  ||!Number.isFinite(time.getTime())||time.toISOString().slice(0,10)!==value)fail('day');return value;}
function inputsReference(value){if(!exact(value,'schemaVersion,key,sha256')||value.schemaVersion!==1||!HASH.test(value.sha256)||value.key!==`inputs/${value.sha256}.json`)fail('inputs_reference');return value;}
export async function assertUnpreparedHostedAdmission(runtime,record){
  for(const file of ['operator.json','config.json','preparation.json','prepare-intent.json'])
    if(await optional(()=>runtime.state.bytes(runtime.care+'/runs/'+record.runKey+'/'+file)))fail('preparation_already_exists');
  const runId='daily-'+record.day+'-'+record.source.slice(0,8)+'-'+hash(record.runKey).slice(0,8);
  for(const file of ['manifest.json','head.json'])if(await runtime.durable.get('runs/'+runId+'/'+file))fail('workspace_already_exists');
}
/** Fixed existing read-only inspector: resolves only the reviewed Cloudflare
 * environment reference, never merchant/model credentials or write authority. */
export async function checkHostedProviderShadow(runtime,check=checkCloudflareRunner){
  return check({schemaVersion:1,environment:CATALOG_SCOPE.environment,accountId:CATALOG_SCOPE.accountId,
    database:{id:CATALOG_SCOPE.databaseId,name:CATALOG_SCOPE.databaseName},
    vectorIndex:{name:CATALOG_SCOPE.indexName,dimensions:1536,metric:'cosine'},
    catalog:{associateTag:'goose-gifts-37-20',marketplace:'www.amazon.com'},
    cloudflareReadToken:runtime.credentials.cloudflare},{timeoutMs:10000});
}
function shadowProviderFields(result){
  const resources={accountId:CATALOG_SCOPE.accountId,databaseId:CATALOG_SCOPE.databaseId,databaseName:CATALOG_SCOPE.databaseName,indexName:CATALOG_SCOPE.indexName};
  const metric=value=>value===null||Number.isSafeInteger(value)&&value>=0;
  if(result?.schemaVersion!==1||result.kind!=='cloudflare-runner-readiness'||result.environment!==CATALOG_SCOPE.environment
    ||canonicalJson(result.resources??null)!==canonicalJson(resources)||result.executionAvailable!==false
    ||!['blocked','checks_passed_execution_unavailable'].includes(result.status)||!Array.isArray(result.issues)
    ||result.issues.some(value=>typeof value!=='string'||! /^[a-z0-9_:.]+$/.test(value))
    ||!Number.isSafeInteger(result.metrics?.requests)||result.metrics.requests<0
    ||!metric(result.metrics.reportedRowsRead)||!metric(result.metrics.reportedRowsWritten)
    ||result.metrics.reportedRowsWritten!==null&&result.metrics.reportedRowsWritten!==0)fail('shadow_provider_result');
  return{providerScopeVerified:true,providerScope:'d1_native_vector_readonly',providerExecutionVerified:false,
    providerChecksPassed:result.status==='checks_passed_execution_unavailable'&&result.issues.length===0,
    providerReadiness:result.status,providerIssues:[...result.issues],providerMetrics:{requests:result.metrics.requests,
      reportedRowsRead:result.metrics.reportedRowsRead,reportedRowsWritten:result.metrics.reportedRowsWritten}};
}
export function hostedAdmissionAsins(mode,value){
  if(value&&mode!=='admit')fail('admission_asins');
  return value?value.split(',').map(id=>id.trim()).sort():undefined;
}
/** Evening Pacific photo wakes fall on the following UTC date. Use that stable
 * slot for both evening retries and delayed-after-midnight dispatches, so a late
 * prior-night run cannot reserve the following night's photo identity. Saved
 * pending records remain authoritative and are never relabeled. */
export function hostedInvocationDay(mode,now=new Date()){
  if(mode==='photos')return now.toISOString().slice(0,10);
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'})
    .format(now);
}
export function hostedCommandEnvironment(environment=process.env,{credentials=true,providers=true}={}){
  const clean={HOME:'/home/runner',PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':'),
    LANG:'C.UTF-8',TZ:'UTC',CI:'true'};
  if(!credentials)return clean;
  for(const name of ['GITHUB_ACTIONS','GITHUB_REPOSITORY','GITHUB_REF','GITHUB_SHA'])clean[name]=environment[name];
  clean.STUPID_GIFTS_OPERATOR_MODE='hosted';
  for(const name of ['CLOUDFLARE_API_TOKEN','AMAZON_CREDENTIAL_ID','AMAZON_CREDENTIAL_SECRET','OPENAI_API_KEY',
    'R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY']){
    const key='STUPID_GIFTS_'+name;if(environment[key]!==undefined&&(providers||!/(?:AMAZON|OPENAI)/.test(name)))clean[key]=environment[key];
  }
  return clean;
}
function parsedOutput(stdout){
  const records=[];for(const line of stdout.split('\n'))try{const value=JSON.parse(line);
    if(value&&(typeof value.state==='string'||SOURCE.test(value.source)&&HASH.test(value.configSha256)&&typeof value.runId==='string'))records.push(value);}catch{/* never echo raw child output */}
  if(!records.length)fail('operator_output');return records.at(-1);
}
/** Stream only typed numeric progress. Raw child output stays private. */
export function hostedPublicationProgress(line){
  if(typeof line!=='string'||line.length>1024)return;
  let value;try{value=JSON.parse(line);}catch{return;}
  if(exact(value,'state,phase,totalPhases,stage,elapsedMs')&&value.state==='catalog_phase_progress'
    &&['start','complete'].includes(value.stage)&&[value.phase,value.totalPhases,value.elapsedMs].every(n=>Number.isSafeInteger(n)&&n>=0)
    &&value.phase>0&&value.phase<=value.totalPhases)
    return{...value,state:'progress',step:'catalog'};
  if(exact(value,'state,phase,stage,products,elapsedMs')&&value.state==='publication_progress'&&value.phase==='inventory'
    &&['start','complete'].includes(value.stage)&&[value.products,value.elapsedMs].every(n=>Number.isSafeInteger(n)&&n>=0))
    return{state:'progress',step:'publication',phase:'inventory',stage:value.stage,products:value.products,elapsedMs:value.elapsedMs};
  const metrics=['completedBytes','completedFiles','totalFiles','blocks','elapsedMs'];
  if(!exact(value,'state,phase,'+metrics.join(','))||value.state!=='publication_progress'||value.phase!=='package'
    ||metrics.some(k=>!Number.isSafeInteger(value[k])||value[k]<0)||value.completedFiles>value.totalFiles)return;
  return{state:'progress',step:'publication',phase:'package',...Object.fromEntries(metrics.map(k=>[k,value[k]]))};
}
export function hostedProgressReader(stream,emit){
  const reader=createInterface({input:stream,crlfDelay:Infinity});
  reader.on('line',line=>{const value=hostedPublicationProgress(line);if(value)emit(value);});return reader;
}
/** Child diagnostics are machine codes only, never command lines, provider
 * bodies or raw output (which may contain credentials). */
export function hostedOperatorFailure(error){
  const codes=String(error.stderr??'').split('\n').map(line=>line.trim());
  // The maintained operator emits a typed, already-redacted record. Do not
  // maintain a second namespace allowlist which hides newly introduced errors.
  let tagged,diagnostic;for(const line of codes)try{const value=JSON.parse(line);
    if(exact(value,'state,errorCode'+(Object.hasOwn(value,'diagnostic')?',diagnostic':''))&&value.state==='operator_error'
      &&typeof value.errorCode==='string'&&/^[a-z][a-z0-9_]{0,149}$/.test(value.errorCode)){
      tagged=value.errorCode;diagnostic=catalogD1FailureDetail(value.diagnostic);
    }
  }catch{/* Never echo unstructured child output. */}
  const code=tagged??codes.findLast(value=>/^(?:routine|run_workspace|catalog_[a-z0-9]+|publication|weekly|vector_[a-z0-9]+|cohort|prune|owned_[a-z0-9]+|search_[a-z0-9]+|semantic_delta|permanent)_[a-z0-9_]{1,100}$/.test(value));
  if(code==='semantic_delta_pending')return{state:'pending',errorCode:code};
  if(code==='catalog_d1_identity_unavailable')return{state:'pending',errorCode:code}; // Initial GET only, before SQL dispatch.
  const causeCode=code==='run_workspace_journal_uncertain'?codes.findLast(value=>/^catalog_object_store_[a-z_]{1,80}$/.test(value)):null;
  return{state:'attention',errorCode:code??(error.killed?'catalog_hosted_operator_timeout':'catalog_hosted_operator_failed'),
    ...(diagnostic?{diagnostic}:{}),...(causeCode?{causeCode}:{})};
}
export function reportHostedCleanupFailure(error,warn=console.warn){
  const code=error instanceof Error?error.message:'',errorCode=/^(?:catalog_(?:hosted_cleanup|operator_state|object_store)|run_workspace)_[a-z0-9_]{1,100}$/.test(code)
    ?code:'catalog_hosted_cleanup_failed';
  const report={notice:'catalog_hosted_cleanup_pending',errorCode,catalogBlocked:false};
  warn(JSON.stringify(report));warn(`::warning::Expired catalog cleanup needs attention (${errorCode}); original registration retained.`);
  return report;
}
export function validateHostedProposal({bytes,sha256,runId,catalogRevision,summary,approvalPin}){
  if(!HASH.test(sha256)||hash(bytes)!==sha256)fail('proposal_digest');const value=json(bytes);
  if(!exact(value,'schemaVersion,runId,catalogRevision,changes')||value.schemaVersion!==1||value.runId!==runId
    ||value.catalogRevision!==catalogRevision||!Array.isArray(value.changes))fail('proposal');
  const ids=new Set();for(const change of value.changes){
    if(!exact(change,'publicId,operationId,inputSha256,productSha256,displaySha256')||typeof change.publicId!=='string'||!change.publicId||ids.has(change.publicId)
      ||typeof change.operationId!=='string'||!change.operationId||!['inputSha256','productSha256','displaySha256'].every(key=>HASH.test(change[key])))fail('proposal');ids.add(change.publicId);
  }
  if(approvalPin&&hash(canonicalJson(value))!==approvalPin)fail('approval_rewrite');
  if(summary!==undefined){
    if(!Array.isArray(summary)||summary.length!==ids.size)fail('review_summary');const seen=new Set();
    for(const product of summary){
      if(!product||!ids.has(product.publicId)||seen.has(product.publicId)||!ASIN.test(product.id)||typeof product.slug!=='string'
        ||! /^[a-z0-9][a-z0-9-]*$/.test(product.slug))fail('review_summary_identity');seen.add(product.publicId);
      // Legacy facts may truthfully be unknown. The proposal already binds the
      // complete current row; never invent facts merely to publish its update.
      if(product.sourceFactsHash!==null&&!HASH.test(product.sourceFactsHash))fail('review_source_facts_hash');
      const publicFields=['publicTitle','description','imageUrl','publicAffiliateUrl'];
      if(publicFields.some(key=>product[key]!==undefined)){
        if(publicFields.some(key=>typeof product[key]!=='string'||!product[key].trim()))fail('review_copy');
        let image,destination;try{image=new URL(product.imageUrl,'https://stupid.gifts');destination=new URL(product.publicAffiliateUrl);}catch{fail('review_link');}
        if(image.protocol!=='https:'||image.username||image.password
          ||product.imageUrl.startsWith('/')&&image.origin!=='https://stupid.gifts')fail('review_image');
        const asin=destination.pathname.match(/^\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:\/|$)/)?.[1];
        if(destination.protocol!=='https:'||!['www.amazon.com','amazon.com'].includes(destination.hostname)
          ||destination.username||destination.password||asin!==product.id||destination.searchParams.getAll('tag').length!==1
          ||destination.searchParams.get('tag')!=='goose-gifts-37-20')fail('review_link');
      }
    }
  }else if(!approvalPin)fail('review_required');
  return{sha256,changes:ids.size};
}
function defaults(runtime,environment){
  const stateFile=runKey=>path.join(runtime.care,'runs',runKey);
  const load=async(source,name)=>import(pathToFileURL(path.join(source,name)).href);
  return{
    async currentInputs({refreshCampaigns=false}={}){
      if(refreshCampaigns&&environment.STUPID_GIFTS_WEBSITE_CAMPAIGNS){
        try{return await syncHostedCampaignFeed(runtime.durable,environment.STUPID_GIFTS_WEBSITE_CAMPAIGNS);}
        catch{console.warn(JSON.stringify({notice:'campaign_metadata_unavailable',catalogBlocked:false}));}
      }
      return currentHostedInputs(runtime.durable);
    },restoreInputs:ref=>restoreHostedInputs(runtime.durable,runtime.base,ref),
    shadowCheck:()=>checkHostedProviderShadow(runtime),
    savedAdmission:record=>loadSavedAdmission(runtime,record.admitSavedRun,record.admitAsins),
    assertUnprepared:record=>assertUnpreparedHostedAdmission(runtime,record),
    async checkout(source){
      console.log(JSON.stringify({state:'progress',step:'checkout',source}));
      const clean=hostedCommandEnvironment(environment,{credentials:false});
      await exec('git',['merge-base','--is-ancestor',source,environment.GITHUB_SHA],{cwd:ROOT,env:clean});
      const directory=path.join(OPERATORS,source);await mkdir(OPERATORS,{recursive:true,mode:0o700});
      if(!await optional(()=>lstat(directory)))await exec('git',['worktree','add','--detach',directory,source],{cwd:ROOT,env:clean});
      const git=async(...args)=>(await exec('git',args,{cwd:directory,env:clean})).stdout.trim();
      if(await realpath(directory)!==directory||await git('rev-parse','HEAD')!==source||await git('status','--porcelain','--untracked-files=all'))fail('operator_source');
      await exec('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:directory,env:clean,timeout:600000,maxBuffer:1024*1024});
      if(await git('status','--porcelain','--untracked-files=all'))fail('operator_source');return directory;
    },
    async invoke(directory,args){
      console.log(JSON.stringify({state:'progress',step:'operator',command:args[0]}));
      let progress;
      try{const child=exec(process.execPath,['--import','tsx','scripts/catalog/daily-operator.mjs',...args],{
        cwd:directory,env:hostedCommandEnvironment(environment,{providers:args[0]!=='code-only'}),maxBuffer:5*1024*1024});
        progress=hostedProgressReader(child.child.stdout,value=>console.log(JSON.stringify(value)));
        const result=await child;return parsedOutput(result.stdout);}
      catch(error){return hostedOperatorFailure(error);}
      finally{progress?.close();}
    },
    async inspect(record,directory){
      console.log(JSON.stringify({state:'progress',step:'inspect',runKey:record.runKey}));
      const operator=await optional(async()=>json(await runtime.state.bytes(stateFile(record.runKey)+'/operator.json')));
      if(!operator)return{prepared:false};
      if(operator.source!==record.source||operator.configPath!==stateFile(record.runKey)+'/config.json'||!HASH.test(operator.configSha256)
        ||operator.helperSha256!==hash(await readFile(path.join(directory,'scripts/catalog/daily-operator.mjs'))))fail('operator_identity');
      const bytes=await runtime.state.bytes(operator.configPath);if(hash(bytes)!==operator.configSha256)fail('config_digest');
      const {validateCloudflareWeeklyConfig}=await load(directory,'scripts/catalog/run-cloudflare-weekly.ts'),config=validateCloudflareWeeklyConfig(json(bytes));
      if(config.codeSha!==record.source||config.publication.sourceRoot!==directory||config.runId!==operator.runId||config.cadence?.day!==record.day
        ||Boolean(config.cadence.photosOnly)!==(record.kind==='photos')||config.catalog.associateTag!=='goose-gifts-37-20'
        ||config.environment!==CATALOG_SCOPE.environment||config.accountId!==CATALOG_SCOPE.accountId||config.database.id!==CATALOG_SCOPE.databaseId
        ||config.database.name!==CATALOG_SCOPE.databaseName||config.publication.workerName!==CATALOG_SCOPE.workerName||config.vectorIndex.name!==CATALOG_SCOPE.indexName
        ||config.publication.accountId!==CATALOG_SCOPE.accountId||config.publication.database.id!==CATALOG_SCOPE.databaseId
        ||config.publication.database.name!==CATALOG_SCOPE.databaseName||config.publication.indexName!==CATALOG_SCOPE.indexName
        ||config.publication.codeSha!==record.source||config.publication.identityOrigin!=='https://stupid.gifts'||config.publication.sourceMode!=='stupid-production')fail('config_identity');
      if(record.kind==='canary'&&(canonicalJson(config.cadence.automation?.refreshIds??null)!==canonicalJson([record.canaryId])
        ||config.cadence.automation.discovery!==false||config.credentials.openai))fail('canary_config');
      if(canonicalJson(config.cadence.admitAsins??null)!==canonicalJson(record.kind==='admit'?record.admitAsins:null)
        ||record.kind==='admit'&&config.cadence.automation||Boolean(config.inputs.savedAdmission)!==Boolean(record.admitSavedRun))fail('admission_config');
      if(record.admitSavedRun){const bytes=await runtime.state.bytes(config.inputs.savedAdmission.path),pin=json(bytes);
        if(hash(bytes)!==config.inputs.savedAdmission.sha256
          ||pin.runKey!==record.admitSavedRun||canonicalJson(pin.ids)!==canonicalJson(record.admitAsins))fail('admission_config');}
      for(const role of ['cloudflare','amazonId','amazonSecret','openai'])if(config.credentials[role]&&canonicalJson(config.credentials[role])!==canonicalJson(runtime.credentials[role]))fail('credential_reference');
      const remote=await Promise.all(['manifest.json','head.json'].map(name=>runtime.durable.get(`runs/${config.runId}/${name}`)));
      const local=await Promise.all(['manifest.json','head.json'].map(name=>optional(()=>lstat(path.join(runtime.workspace,'runs',config.runId,name)))));
      if(remote.every(v=>v===null)&&local.every(v=>v===null))return{prepared:true,started:false,config};
      if(remote.some(v=>v===null))fail('workspace_uncertain');
      const {openRunWorkspace}=await import('./run-workspace.ts');
      const workspace=await openRunWorkspace({directory:runtime.workspace,repository:directory,mode:'resume',runId:config.runId,
        codeSha:record.source,configSha256:operator.configSha256,scope:CATALOG_SCOPE,retention:config.retention,
        budgetCaps:{httpRequests:config.limits.requests,sqlStatements:config.limits.statements},requestLimit:'observe',durable:runtime.durable});
      try{const checkpoint=await workspace.readCheckpoint({controlOnly:true});return{prepared:true,started:true,config,
        phase:checkpoint?.checkpoint.phase??'created',owner:checkpoint?.checkpoint.owner??null,configSha256:operator.configSha256,
        approvalPin:checkpoint?.checkpoint.pins.approval?.sha256,publication:checkpoint?.checkpoint.control?.publication,runtimeCatalog:checkpoint?.checkpoint.control?.runtimeCatalog};}
      finally{await workspace.close();}
    },
    async accepted(record,status){
      if(status.phase!=='finalized'||status.owner!==null||(status.runtimeCatalog??status.publication)?.stage!=='published')return null;
      const saved=await optional(async()=>json(await runtime.state.bytes(stateFile(record.runKey)+'/success.json')));if(!saved)return null;
      const pointer=json(await runtime.state.readPointer('last-success',runtime.care+'/last-success.json'));
      if(saved.source!==record.source||canonicalJson(saved.next)!==canonicalJson(pointer)||!HASH.test(pointer.control?.sha256))fail('successor_identity');
      const bytes=await runtime.state.bytes(pointer.control.path);if(hash(bytes)!==pointer.control.sha256)fail('successor_digest');
      const seal=json(bytes),p=status.publication,r=status.runtimeCatalog;
      if(r){if(seal.publication?.releaseId!==r.releaseId||seal.publication?.receiptSha256!==r.receiptSha256||pointer.transport!=='runtime-data'
        ||pointer.manifestSha256!==r.dataSha256)fail('acceptance_identity');return{releaseId:r.releaseId,receiptSha256:r.receiptSha256};}
      if(seal.publication?.releaseId!==p.intent?.releaseId||!HASH.test(seal.publication?.receiptSha256)
        ||pointer.versionReference!==p.versionReference||pointer.manifestSha256!==p.intent.manifestSha256)fail('acceptance_identity');
      return{releaseId:p.intent.releaseId,receiptSha256:seal.publication.receiptSha256};
    },
    wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    async codeOnly(record,directory){
      const saved=await optional(()=>runtime.state.bytes(runtime.care+'/code-only/'+record.runKey+'/operator.json'));
      // A saved preparation is not yet an owned publication. If a runner was
      // lost before its journal existed, start that SAME original source/intent;
      // descendant recovery intentionally requires an existing checkpoint.
      const recovering=record.source!==environment.GITHUB_SHA&&Boolean(saved)
        &&Boolean(await runtime.durable.get('runs/code-'+record.runKey+'-'+record.source.slice(0,8)+'/manifest.json'));
      const result=await this.invoke(recovering?ROOT:directory,['code-only',recovering?'recover':'start','--run',record.runKey]);
      if(!['published','already_completed'].includes(result.state))return result;
      const success=json(await runtime.state.bytes(runtime.care+'/code-only/'+record.runKey+'/success.json'));
      if(success.kind!=='serving-only'||success.releaseId!==result.runId||success.source!==record.source
        ||!HASH.test(success.receiptSha256)||success.idle?.phase!=='idle'||success.idle.externalPending!==0)fail('code_acceptance');
      return result;
    },
    registerCleanup:async record=>(await import('./hosted-cleanup.mjs')).registerHostedCleanup(runtime,record),
  };
}

/** One manual/scheduled invocation, one existing run. The ONLY mutable progress
 * pointer refers to immutable intent; actual phases/dispatches stay in RunWorkspace. */
export async function coordinateHostedCatalog({mode='shadow',canaryId,admitAsins,admitSavedRun,source,day:capturedDay,runtime,environment=process.env},injected={}){
  if(!['shadow','full','photos','canary','code','admit'].includes(mode)||!SOURCE.test(source)||!runtime.hosted||!runtime.durable)fail('invocation');
  day(capturedDay);if(mode==='canary'?!ASIN.test(canaryId):canaryId!==undefined)fail('canary');
  if(mode==='admit'?!validAdmissionAsins(admitAsins):admitAsins!==undefined)fail('admission_asins');
  if(admitSavedRun!==undefined&&(mode!=='admit'||!validSavedAdmissionRun(admitSavedRun)))fail('admission_source');
  const deps={...defaults(runtime,environment),...injected},pointerFile=runtime.care+'/pending-run.json';
  let pointerBytes=await optional(()=>runtime.state.readPointer('pending-run',pointerFile)),record;
  if(pointerBytes){const pointer=json(pointerBytes);
    if(!exact(pointer,'schemaVersion,pending')||pointer.schemaVersion!==1)fail('pending_pointer');
    if(pointer.pending!==null){const ref=pointer.pending;if(!exact(ref,'path,sha256')||!HASH.test(ref.sha256))fail('pending_pointer');
      if(typeof ref.path!=='string'||!ref.path.startsWith(runtime.care+'/runs/')
        ||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}\/hosted-run\.json$/.test(ref.path.slice((runtime.care+'/runs/').length)))fail('pending_path');
      const bytes=await runtime.state.bytes(ref.path);if(hash(bytes)!==ref.sha256)fail('pending_digest');record=hostedRunRecord(json(bytes));
      if(ref.path!==runtime.care+'/runs/'+record.runKey+'/hosted-run.json')fail('pending_path');}
  }
  let resumed=Boolean(record);
  // A requested code-only release must never resume supplier/model phases.
  if(mode==='code'&&record&&record.kind!=='code')return{state:'attention',runKey:record.runKey,errorCode:'catalog_hosted_catalog_pending'};
  // Owner-picked admission never substitutes another cohort or resumes unrelated
  // provider work. Scheduled wakes may still finish this saved exact intent.
  if(mode==='admit'&&record&&(record.kind!=='admit'||canonicalJson(record.admitAsins)!==canonicalJson(admitAsins)||record.admitSavedRun!==admitSavedRun))
    return{state:'attention',runKey:record.runKey,errorCode:'catalog_hosted_catalog_pending'};
  if(!record){
    if(mode==='shadow'){const inputsRef=inputsReference(await deps.currentInputs());await deps.restoreInputs(inputsRef);await deps.checkout(source);
      return{state:'shadow',source,inputsVerified:true,workspace:'not_verified_readonly',pending:false,...shadowProviderFields(await deps.shadowCheck())};}
    const runKey=hostedRunKey(mode,capturedDay,source,canaryId,admitAsins,admitSavedRun);
    const file=runtime.care+'/runs/'+runKey+'/hosted-run.json';let bytes=await optional(()=>runtime.state.bytes(file));
    if(bytes){record=hostedRunRecord(json(bytes));if(record.runKey!==runKey)fail('run_record');resumed=true;}
    else{record=hostedRunRecord({schemaVersion:1,runKey,source,day:capturedDay,kind:mode,inputsRef:inputsReference(await deps.currentInputs({refreshCampaigns:true})),...(mode==='canary'?{canaryId}:mode==='admit'?{admitAsins,...(admitSavedRun?{admitSavedRun}:{})}:{})});
      bytes=await runtime.state.put(file,record);}
    pointerBytes=await runtime.state.pointer('pending-run',pointerFile,{schemaVersion:1,pending:{path:file,sha256:hash(bytes)}},pointerBytes);
  }
  await deps.restoreInputs(record.inputsRef);let directory=await deps.checkout(record.source);
  if(mode!=='shadow'&&record.admitSavedRun&&record.source!==source&&!(await deps.inspect(record,directory)).prepared){
    // No config, reservation or provider phase exists: retain the empty failed
    // intent, then atomically hand off to the fixed source. Never rebase work.
    await deps.assertUnprepared(record);
    const next={...record,source,runKey:hostedRunKey(record.kind,record.day,source,undefined,record.admitAsins,record.admitSavedRun)},
      file=runtime.care+'/runs/'+next.runKey+'/hosted-run.json';hostedRunRecord(next);
    const bytes=await runtime.state.put(file,next);
    await runtime.state.put(runtime.care+'/runs/'+record.runKey+'/abandoned-unprepared.json',
      {schemaVersion:1,reason:'unprepared_source_upgrade',originalRunKey:record.runKey,successorRunKey:next.runKey,source});
    pointerBytes=await runtime.state.pointer('pending-run',pointerFile,{schemaVersion:1,pending:{path:file,sha256:hash(bytes)}},pointerBytes);
    record=next;directory=await deps.checkout(record.source);
  }
  if(record.admitSavedRun&&!(await deps.inspect(record,directory)).started){
    const original=hostedRunRecord(json(await runtime.state.bytes(runtime.care+'/runs/'+record.admitSavedRun+'/hosted-run.json')));
    if(original.kind!=='admit'||record.admitAsins.some(id=>!original.admitAsins.includes(id)))fail('admission_source');
    await deps.checkout(original.source);
    // Only preparation/start needs the original run cache. Once started, this
    // run already owns the exact copied receipt; recovery/publication must not
    // download the old catalog/package history again.
    await deps.savedAdmission(record);
  }
  if(mode==='shadow')return{state:'shadow',source:record.source,runKey:record.runKey,inputsVerified:true,workspace:'not_verified_readonly',pending:true,
    ...shadowProviderFields(await deps.shadowCheck())};
  const finish=async result=>{
    if(result.state==='accepted'&&record.kind!=='code')await deps.registerCleanup(record);
    await runtime.state.pointer('pending-run',pointerFile,{schemaVersion:1,pending:null},pointerBytes);
    // A dependent job handles expired bodies after catalog-production releases.
    // Generated checkout output belongs to this ephemeral runner; no full
    // workspace rehydration is needed merely to delete a departed runner's files.
    return{...result,runKey:record.runKey,kind:record.kind,resumed};};
  if(record.kind==='code'){
    const result=await deps.codeOnly(record,directory);
    if(['published','already_completed'].includes(result.state)&&result.supplierCalls===0&&result.modelCalls===0
      &&(result.state==='already_completed'||result.catalogPointerChanged===false))
      return finish({state:'accepted',releaseId:result.runId,codeOnly:true,historicalAcceptance:result.historicalAcceptance===true,
        supplierCalls:0,modelCalls:0,catalogPointerChanged:false});
    return{state:'attention',runKey:record.runKey,errorCode:result.errorCode??'catalog_hosted_code_pending'};
  }
  const invoke=(command,extra=[])=>deps.invoke(directory,[command,...extra,'--run',record.runKey]);
  const publish=(status,sha)=>record.source!==source
    ?deps.invoke(ROOT,['recover',sha,'--run',record.runKey]):invoke('publish',[sha]);
  const savedApproval=async status=>{
    const bytes=await runtime.state.bytes(runtime.care+'/runs/'+record.runKey+'/reviewed-proposal.json');
    return validateHostedProposal({bytes,sha256:hash(bytes),runId:status.config.runId,catalogRevision:status.config.catalogRevision,approvalPin:status.approvalPin});
  };
  let visibilityRetries=0,transitions=0,lastProgress,terminalRecoveryRetried=false;
  const observeProgress=status=>{
    const key=JSON.stringify([status.prepared,status.started,status.phase,status.owner?.generation,status.owner?.epoch]);
    // Bound a stalled operation, not the number of gifts in the saved cohort.
    // Durable request charges and the original finite work remain untouched.
    if(key!==lastProgress){lastProgress=key;visibilityRetries=0;transitions=0;}
  };
  while(transitions++<16){
    const status=await deps.inspect(record,directory);
    observeProgress(status);
    if(status.phase==='finalized'){
      const accepted=await deps.accepted(record,status);if(accepted)return finish({state:'accepted',...accepted});
      // Finalized means provider/publication work is over. At most one normal
      // resume repairs existing successor bookkeeping; never re-publish here.
      if(record.source!==source)await publish(status,(await savedApproval(status)).sha256);else await invoke('resume');
      const checked=await deps.inspect(record,directory),repaired=await deps.accepted(record,checked);
      return repaired?finish({state:'accepted',...repaired}):{state:'attention',runKey:record.runKey,errorCode:'catalog_hosted_successor_pending'};
    }
    let result;
    if(!status.prepared){result=await invoke('prepare',record.kind==='photos'?['--photos-only']:record.kind==='canary'?['--canary-id',record.canaryId]
      :record.kind==='admit'?['--admit-asins',record.admitAsins.join(','),...(record.admitSavedRun?['--admit-saved-run',record.admitSavedRun]:[])]:[]);
      if(['attention','pending'].includes(result.state))return{...result,runKey:record.runKey};
      if(result.state==='skipped'&&['photos_current','run_already_completed'].includes(result.reason)){
        if(result.reason==='photos_current')return finish({state:'skipped',reason:result.reason});
        const checked=await deps.inspect(record,directory),accepted=await deps.accepted(record,checked);if(accepted)return finish({state:'accepted',...accepted});
        fail('completed_without_acceptance');}
      if(result.source!==record.source||!HASH.test(result.configSha256)||!(await deps.inspect(record,directory)).prepared)fail('prepare_incomplete');
      continue;
    }
    if(!status.started)result=await invoke('start');
    else if(status.phase==='phase_failed'&&record.admitSavedRun)
      result=await deps.invoke(ROOT,['recover',status.configSha256,'--run',record.runKey]);
    else if(status.phase==='phases_complete'&&!status.approvalPin){
      const review=record.source!==source?await deps.invoke(ROOT,['recover',status.configSha256,'--run',record.runKey]):await invoke('review'),
        file=runtime.care+'/runs/'+record.runKey+'/reviewed-proposal.json';
      if(review.state!=='requires_agent_review'||review.proposalPath!==file)fail('review_output');
      const checked=validateHostedProposal({bytes:await runtime.state.bytes(file),sha256:review.proposalSha256,
        runId:status.config.runId,catalogRevision:status.config.catalogRevision,summary:review.summary});
      result=await publish(status,checked.sha256);
    }else if(status.approvalPin){
      const checked=await savedApproval(status);
      result=await publish(status,checked.sha256);
    }else if(['created','phases_running'].includes(status.phase))result=record.source!==source&&status.phase==='phases_running'
      ?await deps.invoke(ROOT,['recover',status.configSha256,'--run',record.runKey]):await invoke('resume');
    else return{state:'attention',runKey:record.runKey,phase:status.phase,errorCode:'catalog_hosted_checkpoint_requires_attention'};
    if(result.state==='finalized')continue;
    if(result.reason==='awaiting_reviewed_approval')continue;
    if(result.errorCode==='catalog_d1_result_unknown'&&!terminalRecoveryRetried){
      const terminal=await deps.inspect(record,directory),p=terminal.publication;
      if(terminal.phase)result={...result,phase:terminal.phase};
      // Only an already-receipted permanent publication may retry bookkeeping.
      // The normal finalizer independently reads back the completed run/owner;
      // it cannot repeat upload, activation, suppliers or model work.
      if(result.diagnostic?.reason!=='response_bytes'&&['published','finalized'].includes(terminal.phase)&&terminal.approvalPin&&p?.stage==='published'&&HASH.test(p.receiptSha256??'')
        &&p.intent?.releaseId===terminal.config.publication.releaseId&&p.intent?.nextExpiry===null){
        terminalRecoveryRetried=true;await deps.wait(45000);continue;
      }
    }
    // publication_provider_unavailable is GET-only; uncertain writes stay held.
    if(result.state==='pending'&&['semantic_delta_pending','not_visible','publication_provider_unavailable','catalog_d1_identity_unavailable'].includes(result.errorCode)){
      const pending=await deps.inspect(record,directory);
      observeProgress(pending);
      if(pending.approvalPin&&['draining','freezing','publishing'].includes(pending.phase)&&visibilityRetries++<8){await deps.wait(45000);continue;}
    }
    return{state:'attention',runKey:record.runKey,phase:result.phase??status.phase,errorCode:result.errorCode??result.reason??'catalog_hosted_run_pending',
      ...(catalogD1FailureDetail(result.diagnostic)?{diagnostic:catalogD1FailureDetail(result.diagnostic)}:{}),
      ...(result.budget?{budget:result.budget}:{}),
      ...(/^catalog_object_store_[a-z_]{1,80}$/.test(result.causeCode??'')?{causeCode:result.causeCode}:{})};
  }
  return{state:'attention',runKey:record.runKey,errorCode:'catalog_hosted_run_pending'};
}
async function main(){
  process.umask(0o077);
  if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22'||homedir()!=='/home/runner')fail('runner');
  const [mode='shadow',canaryId,admissionList,savedRun]=process.argv.slice(2);if(process.argv.length>6)fail('invocation');
  const admitAsins=hostedAdmissionAsins(mode,admissionList);
  const admitSavedRun=savedRun||undefined;
  const runtime=automationRuntime(),source=process.env.GITHUB_SHA;
  if((await exec('git',['rev-parse','HEAD'],{cwd:ROOT,env:hostedCommandEnvironment(process.env,{credentials:false})})).stdout.trim()!==source)fail('reviewed_source');
  const now=new Date(),capturedDay=hostedInvocationDay(mode,now);
  console.log(JSON.stringify({state:'started',mode,scheduledEvent:process.env.CATALOG_SCHEDULE||null,runDay:capturedDay,startedAt:now.toISOString()}));
  if(mode==='cleanup'){
    if(canaryId||admissionList||savedRun)fail('invocation');
    const {cleanupHostedRuns}=await import('./hosted-cleanup.mjs'),checkout=defaults(runtime,process.env).checkout;
    try{
      console.log(JSON.stringify(await cleanupHostedRuns(runtime,checkout)));
    }catch(error){reportHostedCleanupFailure(error);}
    try{const {cleanupRuntimeCatalog}=await import('./cleanup-runtime-catalog.mjs');console.log(JSON.stringify({runtimeCleanup:await cleanupRuntimeCatalog(runtime)}));}
    catch{console.warn(JSON.stringify({notice:'runtime_cleanup_pending',catalogBlocked:false}));}
    return;
  }
  if(mode==='activate'){
    const {activateHostedPolicy}=await import('./hosted-policy.mjs');
    console.log(JSON.stringify(await activateHostedPolicy(runtime,canaryId)));return;
  }
  if(mode==='editorial'){
    if(canaryId)fail('invocation');
    const {previewHostedHomepage}=await import('./hosted-policy.mjs');
    const repository=await defaults(runtime,process.env).checkout(source);
    console.log(JSON.stringify(await previewHostedHomepage(runtime,{repository,source,day:capturedDay})));return;
  }
  const result=await coordinateHostedCatalog({mode,...(canaryId?{canaryId}:{}),...(admitAsins?{admitAsins}:{}),...(admitSavedRun?{admitSavedRun}:{}),source,day:capturedDay,runtime});
  console.log(JSON.stringify(result));if(result.state==='attention'){console.error('::warning::Catalog run remains pending; resume its existing identity.');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{
  const code=/^(?:catalog_(?:hosted|operator_state|object_store)|run_workspace|routine|weekly|publication)_[a-z0-9_]{1,100}$/.test(error.message)?error.message:'catalog_hosted_coordinator_failed';
  console.error(JSON.stringify({state:'attention',errorCode:code,pendingPreserved:true}));process.exitCode=1;
});
