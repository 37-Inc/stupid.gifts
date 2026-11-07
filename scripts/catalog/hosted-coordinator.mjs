import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {lstat,mkdir,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {automationRuntime,CATALOG_SCOPE} from './automation-runtime.mjs';
import {currentHostedInputs,restoreHostedInputs} from './hosted-inputs.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {checkCloudflareRunner} from './check-cloudflare-runner.ts';

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
export function hostedRunRecord(value){
  if(!exact(value,'schemaVersion,runKey,source,day,kind,inputsRef'+(value?.kind==='canary'?',canaryId':''))||value.schemaVersion!==1
    ||!SOURCE.test(value.source)||!['full','photos','canary'].includes(value.kind))fail('run_record');
  day(value.day);inputsReference(value.inputsRef);
  const key=value.kind==='full'?'scheduled-'+value.day:value.kind==='photos'?'photos-'+value.day:'canary-'+value.day+'-'+value.canaryId;
  if(value.runKey!==key||value.kind==='canary'&&!ASIN.test(value.canaryId))fail('run_record');return value;
}
export function hostedCommandEnvironment(environment=process.env,{credentials=true}={}){
  const clean={HOME:'/home/runner',PATH:[path.dirname(process.execPath),'/usr/local/bin','/usr/bin','/bin'].join(':'),
    LANG:'C.UTF-8',TZ:'UTC',CI:'true'};
  if(!credentials)return clean;
  for(const name of ['GITHUB_ACTIONS','GITHUB_REPOSITORY','GITHUB_REF','GITHUB_SHA'])clean[name]=environment[name];
  clean.STUPID_GIFTS_OPERATOR_MODE='hosted';
  for(const name of ['CLOUDFLARE_API_TOKEN','AMAZON_CREDENTIAL_ID','AMAZON_CREDENTIAL_SECRET','OPENAI_API_KEY',
    'R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY']){
    const key='STUPID_GIFTS_'+name;if(environment[key]!==undefined)clean[key]=environment[key];
  }
  return clean;
}
function parsedOutput(stdout){
  const records=[];for(const line of stdout.split('\n'))try{const value=JSON.parse(line);
    if(value&&(typeof value.state==='string'||SOURCE.test(value.source)&&HASH.test(value.configSha256)&&typeof value.runId==='string'))records.push(value);}catch{/* never echo raw child output */}
  if(!records.length)fail('operator_output');return records.at(-1);
}
/** Child diagnostics are machine codes only, never command lines, provider
 * bodies or raw output (which may contain credentials). */
export function hostedOperatorFailure(error){
  const codes=String(error.stderr??'').split('\n').map(line=>line.trim());
  if(codes.includes('semantic_delta_pending'))return{state:'pending',errorCode:'semantic_delta_pending'};
  const code=codes.findLast(value=>/^(?:routine|run_workspace|catalog_[a-z0-9]+|publication|weekly|vector_[a-z0-9]+|cohort|prune|owned_[a-z0-9]+|search_[a-z0-9]+)_[a-z0-9_]{1,100}$/.test(value));
  return{state:'attention',errorCode:code??(error.killed?'catalog_hosted_operator_timeout':'catalog_hosted_operator_failed')};
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
        ||! /^[a-z0-9][a-z0-9-]*$/.test(product.slug)||!HASH.test(product.sourceFactsHash))fail('review_summary');seen.add(product.publicId);
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
    currentInputs:()=>currentHostedInputs(runtime.durable),restoreInputs:ref=>restoreHostedInputs(runtime.durable,runtime.base,ref),
    shadowCheck:()=>checkHostedProviderShadow(runtime),
    async checkout(source){
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
      try{const result=await exec(process.execPath,['--import','tsx','scripts/catalog/daily-operator.mjs',...args],{
        cwd:directory,env:hostedCommandEnvironment(environment),timeout:90*60000,maxBuffer:5*1024*1024});return parsedOutput(result.stdout);}
      catch(error){return hostedOperatorFailure(error);}
    },
    async inspect(record,directory){
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
        phase:checkpoint?.checkpoint.phase??'created',owner:checkpoint?.checkpoint.owner??null,
        approvalPin:checkpoint?.checkpoint.pins.approval?.sha256,publication:checkpoint?.checkpoint.control?.publication};}
      finally{await workspace.close();}
    },
    async accepted(record,status){
      if(status.phase!=='finalized'||status.owner!==null||status.publication?.stage!=='published')return null;
      const saved=await optional(async()=>json(await runtime.state.bytes(stateFile(record.runKey)+'/success.json')));if(!saved)return null;
      const pointer=json(await runtime.state.readPointer('last-success',runtime.care+'/last-success.json'));
      if(saved.source!==record.source||canonicalJson(saved.next)!==canonicalJson(pointer)||!HASH.test(pointer.control?.sha256))fail('successor_identity');
      const bytes=await runtime.state.bytes(pointer.control.path);if(hash(bytes)!==pointer.control.sha256)fail('successor_digest');
      const seal=json(bytes),p=status.publication;
      if(seal.publication?.releaseId!==p.intent?.releaseId||!HASH.test(seal.publication?.receiptSha256)
        ||pointer.versionReference!==p.versionReference||pointer.manifestSha256!==p.intent.manifestSha256)fail('acceptance_identity');
      return{releaseId:p.intent.releaseId,receiptSha256:seal.publication.receiptSha256};
    },
    wait:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  };
}

/** One manual/scheduled invocation, one existing run. The ONLY mutable progress
 * pointer refers to immutable intent; actual phases/dispatches stay in RunWorkspace. */
export async function coordinateHostedCatalog({mode='shadow',canaryId,source,day:capturedDay,runtime,environment=process.env},injected={}){
  if(!['shadow','full','photos','canary'].includes(mode)||!SOURCE.test(source)||!runtime.hosted||!runtime.durable)fail('invocation');
  day(capturedDay);if(mode==='canary'?!ASIN.test(canaryId):canaryId!==undefined)fail('canary');
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
  if(!record){
    if(mode==='shadow'){const inputsRef=inputsReference(await deps.currentInputs());await deps.restoreInputs(inputsRef);await deps.checkout(source);
      return{state:'shadow',source,inputsVerified:true,workspace:'not_verified_readonly',pending:false,...shadowProviderFields(await deps.shadowCheck())};}
    const runKey=mode==='full'?'scheduled-'+capturedDay:mode==='photos'?'photos-'+capturedDay:'canary-'+capturedDay+'-'+canaryId;
    const file=runtime.care+'/runs/'+runKey+'/hosted-run.json';let bytes=await optional(()=>runtime.state.bytes(file));
    if(bytes){record=hostedRunRecord(json(bytes));if(record.runKey!==runKey)fail('run_record');resumed=true;}
    else{record=hostedRunRecord({schemaVersion:1,runKey,source,day:capturedDay,kind:mode,inputsRef:inputsReference(await deps.currentInputs()),...(mode==='canary'?{canaryId}:{})});
      bytes=await runtime.state.put(file,record);}
    pointerBytes=await runtime.state.pointer('pending-run',pointerFile,{schemaVersion:1,pending:{path:file,sha256:hash(bytes)}},pointerBytes);
  }
  await deps.restoreInputs(record.inputsRef);const directory=await deps.checkout(record.source);
  if(mode==='shadow')return{state:'shadow',source:record.source,runKey:record.runKey,inputsVerified:true,workspace:'not_verified_readonly',pending:true,
    ...shadowProviderFields(await deps.shadowCheck())};
  const finish=async result=>{await runtime.state.pointer('pending-run',pointerFile,{schemaVersion:1,pending:null},pointerBytes);return{...result,runKey:record.runKey,kind:record.kind,resumed};};
  const invoke=(command,extra=[])=>deps.invoke(directory,[command,...extra,'--run',record.runKey]);
  const publish=(status,sha)=>record.source!==source&&['freezing','publishing','attention','published'].includes(status.phase)
    ?deps.invoke(ROOT,['recover',sha,'--run',record.runKey]):invoke('publish',[sha]);
  let visibilityRetries=0;
  for(let transitions=0;transitions<16;transitions++){
    const status=await deps.inspect(record,directory);
    if(status.phase==='finalized'){
      const accepted=await deps.accepted(record,status);if(accepted)return finish({state:'accepted',...accepted});
      // Finalized means provider/publication work is over. At most one normal
      // resume repairs existing successor bookkeeping; never re-publish here.
      await invoke('resume');const checked=await deps.inspect(record,directory),repaired=await deps.accepted(record,checked);
      return repaired?finish({state:'accepted',...repaired}):{state:'attention',runKey:record.runKey,errorCode:'catalog_hosted_successor_pending'};
    }
    let result;
    if(!status.prepared){result=await invoke('prepare',record.kind==='photos'?['--photos-only']:record.kind==='canary'?['--canary-id',record.canaryId]:[]);
      if(result.state==='skipped'&&['photos_current','run_already_completed'].includes(result.reason)){
        if(result.reason==='photos_current')return finish({state:'skipped',reason:result.reason});
        const checked=await deps.inspect(record,directory),accepted=await deps.accepted(record,checked);if(accepted)return finish({state:'accepted',...accepted});
        fail('completed_without_acceptance');}
      if(result.source!==record.source||!HASH.test(result.configSha256)||!(await deps.inspect(record,directory)).prepared)fail('prepare_incomplete');
      continue;
    }
    if(!status.started)result=await invoke('start');
    else if(status.phase==='phases_complete'&&!status.approvalPin){
      const review=await invoke('review'),file=runtime.care+'/runs/'+record.runKey+'/reviewed-proposal.json';
      if(review.state!=='requires_agent_review'||review.proposalPath!==file)fail('review_output');
      const checked=validateHostedProposal({bytes:await runtime.state.bytes(file),sha256:review.proposalSha256,
        runId:status.config.runId,catalogRevision:status.config.catalogRevision,summary:review.summary});
      result=await publish(status,checked.sha256);
    }else if(status.approvalPin){
      const bytes=await runtime.state.bytes(runtime.care+'/runs/'+record.runKey+'/reviewed-proposal.json');
      const checked=validateHostedProposal({bytes,sha256:hash(bytes),runId:status.config.runId,catalogRevision:status.config.catalogRevision,approvalPin:status.approvalPin});
      result=await publish(status,checked.sha256);
    }else if(['created','phases_running'].includes(status.phase))result=await invoke('resume');
    else return{state:'attention',runKey:record.runKey,phase:status.phase,errorCode:'catalog_hosted_checkpoint_requires_attention'};
    if(result.state==='finalized')continue;
    if(result.reason==='awaiting_reviewed_approval')continue;
    // publication_provider_unavailable is GET-only; uncertain writes stay held.
    if(result.state==='pending'&&['semantic_delta_pending','not_visible','publication_provider_unavailable'].includes(result.errorCode)&&visibilityRetries++<8){
      const pending=await deps.inspect(record,directory);
      if(pending.approvalPin&&['draining','freezing','publishing'].includes(pending.phase)){await deps.wait(45000);continue;}
    }
    return{state:'attention',runKey:record.runKey,phase:result.phase??status.phase,errorCode:result.errorCode??result.reason??'catalog_hosted_run_pending'};
  }
  return{state:'attention',runKey:record.runKey,errorCode:'catalog_hosted_run_pending'};
}
async function main(){
  process.umask(0o077);
  if(process.platform!=='linux'||process.versions.node.split('.')[0]!=='22'||homedir()!=='/home/runner')fail('runner');
  const [mode='shadow',canaryId]=process.argv.slice(2);if(process.argv.length>4)fail('invocation');
  const runtime=automationRuntime(),source=process.env.GITHUB_SHA;
  if((await exec('git',['rev-parse','HEAD'],{cwd:ROOT,env:hostedCommandEnvironment(process.env,{credentials:false})})).stdout.trim()!==source)fail('reviewed_source');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'})
    .formatToParts(new Date()).map(p=>[p.type,p.value]));
  const result=await coordinateHostedCatalog({mode,...(canaryId?{canaryId}:{}),source,day:`${parts.year}-${parts.month}-${parts.day}`,runtime});
  console.log(JSON.stringify(result));if(result.state==='attention'){console.error('::warning::Catalog run remains pending; resume its existing identity.');process.exitCode=1;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{
  const code=/^catalog_(?:hosted|operator_state|object_store)_[a-z_]{1,100}$/.test(error.message)?error.message:'catalog_hosted_coordinator_failed';
  console.error(JSON.stringify({state:'attention',errorCode:code,pendingPreserved:true}));process.exitCode=1;
});
