import fs from 'node:fs/promises';
import {constants,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {canonicalJson,sha256} from './migration.ts';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {readAcceptedCodeOnlyCatalog,acceptedCodeOnlyOperationKey,acceptedCodeOnlyControl} from './accepted-code-only.ts';
import {encodeAcceptedCatalogAuthority,acceptedCatalogReceipt,servingPublicationStatus} from '../../lib/catalog/publication.ts';
import {enqueueBuildRequest,encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import {claimMutationOwnership,readMutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {createCatalogD1Rest,createCatalogD1ReadOnlyRest} from './d1-write-rest.ts';
import {openRunWorkspace} from './run-workspace.ts';
import {executePublication,validatePublicationConfig} from './publish-release.ts';
import {accountedPublicationFetch,accountedPublicationReadFetch} from './publication-read-fetch.ts';
import {accountedPublicationUploadCommand} from './publication-upload-command.ts';
import {resolveWranglerOAuth} from './check-cloudflare-runner.ts';
import {routineServingPrior,currentD1Plan,observeHeadroom,routineLimits,routineSearchPolicy,assertNoUnsealedMaintenance,cleanupAcceptedPublication} from './daily-operator.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url))),BASE=path.join(homedir(),'.codex/private/goose-gifts-migration');
const SCOPE=Object.freeze({environment:'production',accountId:'7f05a1dcb6e16f9c239564a0293bbe74',databaseId:'77b30f85-c57c-4acb-a0df-53368806c2a6',
  databaseName:'stupid-gifts-production',workerName:'stupid-gifts-production',indexName:'stupid-gifts-production'});
const LABEL=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;
const refuse=code=>{throw Error('code_only_'+code);};
async function scopeState(db){
  const rows=(await db.prepare('SELECT phase,generation,mutation_epoch,external_pending FROM catalog_mutation_scopes WHERE environment=? AND index_name=?')
    .bind(SCOPE.environment,SCOPE.indexName).all()).results;
  if(rows.length!==1)refuse('scope_unavailable');return rows[0];
}

export function codeOnlyInvocation(argv){
  const args=[...argv],flag=args.indexOf('--run');
  if(flag<0||!LABEL.test(args[flag+1]??''))refuse('arguments');
  const runKey=args[flag+1];args.splice(flag,2);const command=args[0]??'start';
  if(args.length>1||!['prepare','start','resume','status'].includes(command))refuse('arguments');
  return{command,runKey};
}
/** Protected immutable technical records only. No supplier bodies or keys. */
export function createCodeOnlyStore(base){
  const inside=file=>path.isAbsolute(file)&&file.startsWith(base+'/')&&!path.relative(base,file).split(path.sep).includes('..');
  const directory=async file=>{
    if(file!==base&&!inside(file))refuse('private_path');
    const relative=path.relative(base,file),parts=[base,...relative.split(path.sep).filter(Boolean)];let current=parts.shift();
    for(const part of [null,...parts]){if(part)current=path.join(current,part);await fs.mkdir(current,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
      const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.uid!==process.getuid()||(stat.mode&0o777)!==0o700||await fs.realpath(current)!==current)refuse('private_directory');}
  };
  const bytes=async(file,expected)=>{if(!inside(file)||await fs.realpath(file)!==file)refuse('private_path');const stat=await fs.lstat(file);
    if(!stat.isFile()||stat.uid!==process.getuid()||stat.nlink!==1||(stat.mode&0o777)!==0o600||stat.size>10*1024*1024)refuse('private_file');
    const body=await fs.readFile(file);if(expected&&sha256(body)!==expected)refuse('private_digest');return body;};
  const json=async(file,expected)=>JSON.parse((await bytes(file,expected)).toString('utf8'));
  const optional=async file=>{try{return await json(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const put=async(file,value)=>{if(!inside(file))refuse('private_path');await directory(path.dirname(file));const body=Buffer.from(JSON.stringify(value)+'\n');let handle;
    try{handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    catch(error){if(error.code!=='EEXIST'||!(await bytes(file)).equals(body))refuse('immutable_changed');return sha256(body);}
    try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}if(!(await bytes(file)).equals(body))refuse('private_readback');return sha256(body);};
  return{bytes,json,optional,put};
}
/** An explicitly released, never-dispatched attempt is historical, not resumable. */
export async function codeOnlyTerminal(store,directory,record){
  const abandoned=await store.optional(directory+'/abandoned.json');
  if(!abandoned)return null;
  if(!record||abandoned.schemaVersion!==1||abandoned.state!=='abandoned_prebuild'||abandoned.runId!==record.runId
    ||abandoned.source!==record.source||abandoned.operatorSha256!==sha256(await store.bytes(directory+'/operator.json'))
    ||![abandoned.builds,abandoned.uploads,abandoned.activations].every(value=>value===0)
    ||abandoned.idle?.phase!=='idle'||abandoned.idle.external_pending!==0||await store.optional(directory+'/success.json'))refuse('abandonment_changed');
  return{state:'abandoned_prebuild',runId:record.runId,source:record.source,historicalAcceptance:false,supplierCalls:0,modelCalls:0};
}
export function codeOnlyAuthority({seal,codeSha,observedAt,cutoff,globalVectorWatermark,publicationReceiptWatermark}){
  const envelope=JSON.parse(seal.envelopeJson),authority={schemaVersion:1,kind:'accepted-persistent-code-only',
    sealSha256:sha256(catalogSuccessorBytes(seal)),publication:seal.publication,request:{schemaVersion:1,environment:'production',
      sourceRevision:seal.projectionReceipt.catalog_revision,sourceDigest:seal.snapshotSha256,codeSha,priorReleaseId:seal.publication.releaseId,
      capturedAt:envelope.generatedAt,cutoff},observedAt,globalVectorWatermark,publicationReceiptWatermark,
    identityCount:envelope.products.length+envelope.heldProducts.length};
  encodeAcceptedCatalogAuthority(authority);return authority;
}
export function codeOnlyPublication({saved,sourceRoot,codeSha,releaseId,prior,seal,authority,servingPrior,semanticSearch}){
  if(!saved||saved.environment!==SCOPE.environment||saved.accountId!==SCOPE.accountId||saved.database?.id!==SCOPE.databaseId
    ||saved.database.name!==SCOPE.databaseName||saved.workerName!==SCOPE.workerName||saved.indexName!==SCOPE.indexName
    ||saved.sourceMode!=='stupid-production'||saved.identityOrigin!=='https://stupid.gifts')refuse('accepted_configuration');
  return validatePublicationConfig({...saved,sourceRoot,codeSha,releaseId,prior:{directory:null,releaseId:seal.publication.releaseId,
    manifestSha256:prior.manifestSha256,versionReference:prior.versionReference},servingPrior,semanticSearch,
    acceptedCatalog:{...seal.publication,sealSha256:authority.sealSha256}});
}
function source(){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  if(process.versions.node.split('.')[0]!=='22'||process.cwd()!==ROOT||git('status','--porcelain','--untracked-files=all'))refuse('source');
  if(Object.keys(process.env).some(key=>/^(?:AMAZON_|OPENAI_|POSTGRES_|VERCEL_|CATALOG_|CLOUDFLARE_)/.test(key)))refuse('ambient_configuration');
  return git('rev-parse','HEAD');
}
/** One maintained route. Only existing OAuth, production scope and protected
 * local journal are selected; no merchant/model credentials or phases exist. */
export async function codeOnlyMain(argv=process.argv.slice(2)){
  const {command,runKey}=codeOnlyInvocation(argv),codeSha=source(),store=createCodeOnlyStore(BASE),care=BASE+'/daily-catalog-care',
    directory=care+'/code-only/'+runKey,recordPath=directory+'/operator.json',helperSha256=sha256(await fs.readFile(new URL(import.meta.url)));
  let record=await store.optional(recordPath);
  const terminal=await codeOnlyTerminal(store,directory,record);if(terminal){console.log(JSON.stringify(terminal));return;}
  if(command==='status'){console.log(JSON.stringify(record?{state:await store.optional(directory+'/success.json')?'published':'prepared',runId:record.runId,source:record.source}:{state:'not_prepared'}));return;}
  if(record&&(record.source!==codeSha||record.helperSha256!==helperSha256))refuse('source_changed');
  if(record&&await store.optional(directory+'/success.json')){
    await cleanupAcceptedPublication({directory:BASE+'/weekly-runs',repository:ROOT,mode:'resume',runId:record.runId,codeSha,
      configSha256:record.config.sha256,scope:SCOPE,retention:record.retention,budgetCaps:{httpRequests:record.limits.requests,sqlStatements:record.limits.statements},requestLimit:'observe'},record.runId);
    console.log(JSON.stringify({state:'already_completed',runId:record.runId,historicalAcceptance:true,supplierCalls:0,modelCalls:0}));return;
  }
  if(!record){
    if(command==='resume')refuse('not_prepared');
    const pointerPath=care+'/last-success.json',pointerBytes=await store.bytes(pointerPath),prior=JSON.parse(pointerBytes.toString('utf8')),
      seal=await store.json(prior.control.path,prior.control.sha256);catalogSuccessorBytes(seal);
    const token=await resolveWranglerOAuth(),plan=await currentD1Plan(token),limits=routineLimits(plan),capacity=await observeHeadroom(token,undefined,null,fetch,plan),
      db=await createCatalogD1ReadOnlyRest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,requestLimit:'observe',
        limits:{requests:20,statements:30,reportedRowsRead:20000,reportedRowsWritten:1}});
    const rows=await db.batch([db.prepare('SELECT coalesce(max(sequence),0) n FROM vector_sync_outbox'),
      db.prepare('SELECT coalesce(max(rowid),0) n FROM publication_receipts'),db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(seal.publication.releaseId),
      db.prepare('SELECT phase,external_pending FROM catalog_mutation_scopes WHERE environment=? AND index_name=?').bind(SCOPE.environment,SCOPE.indexName),
      db.prepare("SELECT count(*) n FROM vector_sync_outbox WHERE status!='complete'"),db.prepare('SELECT release_id FROM publication_receipts ORDER BY rowid DESC LIMIT 1')]);
    if(rows[2].results.length!==1||sha256(canonicalJson(rows[2].results[0]))!==seal.publication.receiptSha256
      ||rows[3].results.length!==1||rows[3].results[0].phase!=='idle'||rows[3].results[0].external_pending!==0
      ||rows[4].results[0].n!==0||rows[5].results[0]?.release_id!==seal.publication.releaseId)refuse('catalog_or_owner_changed');
    await assertNoUnsealedMaintenance(db,seal);
    const servingPrior=await routineServingPrior(token,seal),latest=await store.optional(care+'/code-only/last-serving.json');
    const saved=latest?.releaseId===servingPrior.releaseId?(await store.json(latest.operator.path,latest.operator.sha256)).config.value
      :(await store.json(path.dirname(prior.control.path)+'/config.json')).publication;
    const observedAt=new Date().toISOString(),cutoff=new Date(Date.now()+2*3600000).toISOString(),notAfter=new Date(Date.now()+86400000).toISOString(),
      authority=codeOnlyAuthority({seal,codeSha,observedAt,cutoff,globalVectorWatermark:rows[0].results[0].n,publicationReceiptWatermark:rows[1].results[0].n}),
      runId='code-'+runKey+'-'+codeSha.slice(0,8),semanticSearch=routineSearchPolicy(await store.optional(care+'/semantic-search.json')),
      config=codeOnlyPublication({saved,sourceRoot:ROOT,codeSha,releaseId:runId,prior,seal,authority,servingPrior,semanticSearch});
    // One immutable preparation record avoids partial config/authority writes
    // forcing a new timestamp or another preparation after interruption.
    const configSha256=sha256(JSON.stringify(config)+'\n'),authoritySha256=sha256(JSON.stringify(authority)+'\n');
    record={schemaVersion:1,kind:'accepted-persistent-code-only',source:codeSha,helperSha256,runId,prior,pointerSha256:sha256(pointerBytes),
      config:{value:config,sha256:configSha256},authority:{value:authority,sha256:authoritySha256},capacity,plan,limits,
      preparation:db.metrics(),retention:{reviewReference:'maintained/accepted-catalog-code-only',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
        .map(kind=>[kind,{maxAgeMs:86400000,notAfter}]))}};await store.put(recordPath,record);
  }
  if(command==='prepare'){console.log(JSON.stringify({state:'prepared',runId:record.runId,source:codeSha,supplierCalls:0,modelCalls:0}));return;}
  if(sha256(JSON.stringify(record.config.value)+'\n')!==record.config.sha256||sha256(JSON.stringify(record.authority.value)+'\n')!==record.authority.sha256)refuse('preparation_changed');
  const config=validatePublicationConfig(record.config.value),authority=record.authority.value,
    seal=await store.json(record.prior.control.path,record.prior.control.sha256),pointer=await store.bytes(care+'/last-success.json',record.pointerSha256);
  void pointer;encodeAcceptedCatalogAuthority(authority);
  const workspaceOptions={directory:BASE+'/weekly-runs',repository:ROOT,mode:existsSync(BASE+'/weekly-runs/runs/'+record.runId+'/manifest.json')?'resume':'create',
    runId:record.runId,codeSha,configSha256:record.config.sha256,scope:SCOPE,retention:record.retention,
    budgetCaps:{httpRequests:record.limits.requests,sqlStatements:record.limits.statements},requestLimit:'observe'};
  let workspace=await openRunWorkspace(workspaceOptions),result,success;
  try{
    const token=await resolveWranglerOAuth(),budget=await workspace.budget();await observeHeadroom(token,budget,record.capacity,fetch,await currentD1Plan(token));
    const db=await createCatalogD1Rest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,limits:record.limits,requestLimit:'observe',
      accounting:{scope:{accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName},initial:await workspace.budget(),reserve:r=>workspace.reserveBudget(r),settle:(id,value)=>workspace.settleBudget(id,value)}}),
      scope={accountId:SCOPE.accountId,workerName:SCOPE.workerName,indexName:SCOPE.indexName,databaseId:SCOPE.databaseId,identityOrigin:config.identityOrigin},
      send=accountedPublicationFetch(workspace,fetch,scope),observationSend=accountedPublicationReadFetch(workspace,fetch,scope);
    let cp=await workspace.readCheckpoint({controlOnly:true});
    if(!cp){cp=await workspace.writeCheckpoint(null,{phase:'created',owner:null,state:{kind:'serving-only'},pins:{},phaseComplete:null,control:{}});}
    let owner=cp.checkpoint.owner;
    if(!owner){const actual=await readMutationOwner(db,SCOPE),state=await scopeState(db);
      if(state.phase==='idle'&&cp.checkpoint.control?.publication?.stage==='published')owner=cp.checkpoint.control.publication.permit?.mutationOwner;
      else if(actual?.phase==='freezing'&&actual.ownerReference===record.runId&&actual.operationKey===acceptedCodeOnlyOperationKey(authority))owner=actual;
      else if(state.phase==='idle'&&!cp.checkpoint.control?.publication){
        try{owner=await claimMutationOwnership(db,SCOPE,{phase:'freezing',ownerReference:record.runId,operationKey:acceptedCodeOnlyOperationKey(authority)});}
        catch{const observed=await readMutationOwner(db,SCOPE);if(observed?.phase!=='freezing'||observed.ownerReference!==record.runId
          ||observed.operationKey!==acceptedCodeOnlyOperationKey(authority))refuse('claim_unconfirmed');owner=observed;}
      }else refuse('owner_changed');if(!owner)refuse('claim_unconfirmed');
      if(cp.checkpoint.control?.publication?.stage!=='published')cp=await workspace.writeCheckpoint(cp.sha256,{...cp.checkpoint,owner,phase:'freezing',state:{kind:'serving-only'}});
    }
    const observedOwner=await readMutationOwner(db,SCOPE);
    if(observedOwner?.phase==='activating'&&owner&&cp.checkpoint.control?.publication?.stage==='activating'
      &&canonicalJson({...observedOwner,phase:owner.phase})===canonicalJson(owner))owner=observedOwner;
    const actual=await scopeState(db),completed=actual.phase==='idle'&&cp.checkpoint.control?.publication?.stage==='published',
      input=completed?acceptedCodeOnlyControl(seal,authority):await readAcceptedCodeOnlyCatalog({db,owner,seal,authority,runReference:record.runId});
    const requestId=sha256(encodeBuildRequest(authority.request));if(!cp.checkpoint.control?.publication)await enqueueBuildRequest(db,authority.request);
    result=await executePublication({db,owner,revision:input.revision,acceptedCatalog:input,requestId,runReference:record.runId,workspace,config,
      credentials:{cloudflareToken:token},routineCare:true,dependencies:{fetch:send,observationFetch:observationSend,
        command:accountedPublicationUploadCommand({workspace,scope:{accountId:SCOPE.accountId,workerName:SCOPE.workerName}})}});
    if(result.state==='published'){
      cp=await workspace.readCheckpoint({controlOnly:true});const control=cp.checkpoint.control.publication,
        state=await servingPublicationStatus(db,record.runId,authority),original=await acceptedCatalogReceipt(db,authority),
        build=(await db.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').bind(requestId).all()).results[0],
        idle=await scopeState(db),serving=await routineServingPrior(token,seal,observationSend);
      if(state.state!=='published'||!build||build.state!=='resolved'||build.release_id!==record.runId||build.version_reference!==control.versionReference
        ||idle.phase!=='idle'||idle.external_pending!==0||idle.generation!==control.permit.mutationOwner.generation
        ||idle.mutation_epoch!==control.permit.mutationOwner.epoch||serving.releaseId!==record.runId||serving.manifestSha256!==control.intent.manifestSha256
        ||sha256(canonicalJson(original))!==seal.publication.receiptSha256)refuse('acceptance_changed');
      await store.bytes(care+'/last-success.json',record.pointerSha256);
      if(cp.checkpoint.owner!==null)cp=await workspace.writeControlCheckpoint(cp.sha256,{phase:'published',owner:null,control:cp.checkpoint.control});
      success={schemaVersion:1,kind:'serving-only',releaseId:record.runId,source:codeSha,catalogPublication:seal.publication,acceptedCatalogPointerSha256:record.pointerSha256,
        operator:{path:recordPath,sha256:sha256(await store.bytes(recordPath))},configSha256:record.config.sha256,authoritySha256:record.authority.sha256,
        receiptSha256:result.receiptSha256,receipt:result.receipt,checkpointSha256:cp.sha256,build,
        idle:{phase:idle.phase,generation:idle.generation,epoch:idle.mutation_epoch,externalPending:idle.external_pending},serving,usage:await workspace.budget()};
      await store.put(directory+'/success.json',success);
    }
  }finally{await workspace.close();workspace=null;}
  if(success){
    const servingPointer={releaseId:record.runId,operator:success.operator},previous=await store.optional(care+'/code-only/last-serving.json');
    if(previous?.releaseId!==record.runId){const temporary=directory+'/next-serving.json';await store.put(temporary,servingPointer);await fs.rename(temporary,care+'/code-only/last-serving.json');}
    await cleanupAcceptedPublication({...workspaceOptions,mode:'resume'},record.runId);
  }
  console.log(JSON.stringify({state:success?'published':result.state,runId:record.runId,...(result.errorCode?{errorCode:result.errorCode}:{}),supplierCalls:0,modelCalls:0,catalogPointerChanged:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await codeOnlyMain();
