import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {automationRuntime,CATALOG_SCOPE as SCOPE} from './automation-runtime.mjs';
import {buildRuntimeApp} from './build-runtime-app.mjs';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {contentAdminSettings} from './content-admin-settings.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex');
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const fail=code=>{throw Error('runtime_app_'+code);};
const json=b=>JSON.parse(Buffer.from(b).toString('utf8'));
export function runtimeWranglerConfig(output,vars={}){
  return{name:SCOPE.workerName,account_id:SCOPE.accountId,main:output.entryPath,compatibility_date:'2026-10-19',
    workers_dev:false,preview_urls:false,upload_source_maps:false,keep_vars:true,observability:{enabled:false},
    assets:{directory:output.assetsDirectory,binding:'ASSETS',run_worker_first:true,html_handling:'none',not_found_handling:'none'},
    vars:{...vars,ENVIRONMENT:'production',RUNTIME_CATALOG_ENABLED:'true'},
    d1_databases:[{binding:'DB',database_name:SCOPE.databaseName,database_id:SCOPE.databaseId}],
    r2_buckets:[{binding:'CATALOG_DATA',bucket_name:'stupid-gifts-catalog-private'}],
    vectorize:[{binding:'VECTORIZE',index_name:SCOPE.indexName},{binding:'SEMANTIC_VECTORIZE',index_name:'stupid-gifts-search-serving'}]};
}
/** Separate app queue: no catalog owner claim, supplier, model or product write.
 * Dispatch intent precedes each external mutation; lost ACKs use exact provider
 * readback, never a second upload/deployment guessed from an empty response. */
export async function deployRuntimeApp({runtime,source,root=ROOT,send=fetch,command=promisify(execFile),bootstrap=false}){
  if(!runtime.hosted||!runtime.durable||!/^[a-f0-9]{40}$/.test(source))fail('hosted_required');
  const token=await runtime.token(),base=`https://api.cloudflare.com/client/v4/accounts/${SCOPE.accountId}/workers/scripts/${SCOPE.workerName}`;
  let httpRequests=0,unknownRequests=0;
  async function api(suffix,body){httpRequests++;let response;
    try{response=await send(base+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{unknownRequests++;fail('provider_unknown');}
    const value=await response.json();if(!response.ok||value.success!==true)fail('provider_refused');return value.result;
  }
  const active=async()=>{const v=(await api('/deployments')).deployments?.[0];
    if(!v||v.versions?.length!==1||v.versions[0].percentage!==100||!UUID.test(v.id)||!UUID.test(v.versions[0].version_id))fail('deployment_unsettled');
    return{id:v.id,version:v.versions[0].version_id,marker:v.annotations?.['workers/message']};};
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stupid-runtime-app-'));
  try{
    if(!bootstrap){let contract;
      try{const r=await send('https://stupid.gifts/.well-known/runtime-catalog.json',{redirect:'error',signal:AbortSignal.timeout(15000)});contract=r.ok?await r.json():null;}catch{/* Must establish cutover before promotion. */}
      if(contract?.contract!=='runtime-catalog-v1')fail('bootstrap_required');
    }
    const output=await buildRuntimeApp({root,outdir:directory,source,codeSha:source,releaseId:'app-'+source.slice(0,16),
      publicAnalytics:{enabled:true,posthogHost:'https://us.i.posthog.com',posthogKey:'phc_ATVKSPwDYTRfX9qDtDVLzZuXQcNdV9d55SjC8bHtuU8w'}});
    const current=await api('/versions/'+(await active()).version),bindings=current.resources?.bindings;
    if(!Array.isArray(bindings)||bindings.some(b=>!['DB','ASSETS','VECTORIZE','SEMANTIC_VECTORIZE','OPENAI_API_KEY','ENVIRONMENT','SEMANTIC_SEARCH_ENABLED','RUNTIME_CATALOG_ENABLED',
      'CONTENT_ADMIN_ENABLED','CONTENT_ADMIN_TEAM_DOMAIN','CONTENT_ADMIN_AUD','CONTENT_ADMIN_STAFF_EMAILS','CATALOG_DATA'].includes(b.name)))fail('bindings_need_review');
    const variables={...Object.fromEntries(bindings.filter(b=>b.type==='plain_text').map(b=>[b.name,b.text])),...contentAdminSettings,ENVIRONMENT:'production',RUNTIME_CATALOG_ENABLED:'true'};
    const settingsSha256=hash(canonicalJson({variables,derived:bindings.find(b=>b.name==='SEMANTIC_VECTORIZE')?.index_name}));
    const key='app-releases/'+source+'/'+output.manifestSha256+'/'+settingsSha256+'/',save=(name,v)=>runtime.durable.putImmutable(key+name+'.json',Buffer.from(JSON.stringify(v)+'\n')),
      read=async name=>{const value=await runtime.durable.get(key+name+'.json');return value?json(value.bytes):null;};
    const before=await active();
    const workerSha256=hash(await fs.readFile(output.entryPath));
    const config=runtimeWranglerConfig(output,variables),configPath=path.join(directory,'wrangler.json');
    const derived=bindings.find(b=>b.name==='SEMANTIC_VECTORIZE');if(!derived||derived.type!=='vectorize')fail('semantic_binding_missing');
    config.vectorize[1].index_name=derived.index_name;
    if(bindings.find(b=>b.name==='DB')?.id!==SCOPE.databaseId||bindings.find(b=>b.name==='VECTORIZE')?.index_name!==SCOPE.indexName
      ||!bindings.some(b=>b.name==='OPENAI_API_KEY'&&b.type==='secret_text'))fail('bindings_need_review');
    await fs.writeFile(configPath,JSON.stringify(config));
    const marker='runtime-app-'+source.slice(0,12)+'-'+output.manifestSha256.slice(0,12)+'-'+settingsSha256.slice(0,12),deploymentMarker=marker+'-activate';
    const original=await read('prepared');if(original&&(original.manifestSha256!==output.manifestSha256||original.workerSha256!==workerSha256||original.settingsSha256!==settingsSha256))fail('package_changed');
    await save('prepared',original??{schemaVersion:1,source,manifestSha256:output.manifestSha256,workerSha256,settingsSha256,previous:before,metrics:output.metrics});
    const find=async()=>{const matches=[];
      for(let page=1;page<=10;page++){const list=await api('/versions?page='+page+'&per_page=10');
        if(!Array.isArray(list.items))fail('version_list');
        for(const v of list.items)if(v.annotations?.['workers/tag']===marker)matches.push(v.id);
        if(list.items.length<10)break;}
      if(matches.length>1)fail('ambiguous_version');return matches[0]??null;};
    const acknowledged=await read('uploaded');
    if(acknowledged&&(acknowledged.source!==source||acknowledged.manifestSha256!==output.manifestSha256
      ||acknowledged.workerSha256!==workerSha256||acknowledged.settingsSha256!==settingsSha256||!UUID.test(acknowledged.version)))fail('uploaded_record_changed');
    const dispatch=await read('upload-dispatched');
    let version=acknowledged?.version??(dispatch?await find():null);
    if(!version){
      if(dispatch)fail('upload_unknown_requires_readback');
      await save('upload-dispatched',{schemaVersion:1,source,manifestSha256:output.manifestSha256,workerSha256,settingsSha256,marker});
      let error;
      try{await command(process.execPath,['node_modules/wrangler/bin/wrangler.js','versions','upload','--config',configPath,'--tag',marker,'--message','runtime-app:'+output.manifestSha256+'/'+workerSha256],
        {cwd:root,timeout:180000,maxBuffer:2*1024*1024,env:{HOME:process.env.HOME,PATH:process.env.PATH,CI:'true',NODE_ENV:'production',CLOUDFLARE_API_TOKEN:token,
          WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG:'error'}});}catch(cause){error=cause;}
      version=await find();if(!version)fail(error?'upload_unknown_requires_readback':'version_missing');
    }
    const uploaded=await api('/versions/'+version),actualBindings=uploaded.resources?.bindings;
    if(uploaded.annotations?.['workers/tag']!==marker||uploaded.annotations?.['workers/message']!=='runtime-app:'+output.manifestSha256+'/'+workerSha256||!Array.isArray(actualBindings)
      ||actualBindings.find(b=>b.name==='DB')?.id!==SCOPE.databaseId||actualBindings.find(b=>b.name==='CATALOG_DATA')?.bucket_name!=='stupid-gifts-catalog-private'
      ||actualBindings.find(b=>b.name==='RUNTIME_CATALOG_ENABLED')?.text!=='true'
      ||Object.entries(contentAdminSettings).some(([name,text])=>actualBindings.find(b=>b.name===name)?.text!==text)
      ||!actualBindings.some(b=>b.name==='OPENAI_API_KEY'&&b.type==='secret_text'))fail('uploaded_binding_changed');
    await save('uploaded',{schemaVersion:1,source,version,manifestSha256:output.manifestSha256,workerSha256,settingsSha256});
    let deployed=await active();
    if(deployed.version!==version){
      const prepared=await read('prepared');if(deployed.version!==prepared.previous.version)fail('newer_deployment_exists');
      if(await read('activation-dispatched'))fail('activation_unknown_requires_readback');
      await save('activation-dispatched',{schemaVersion:1,source,version,marker:deploymentMarker});
      try{await api('/deployments',{strategy:'percentage',versions:[{version_id:version,percentage:100}],annotations:{'workers/message':deploymentMarker}});}catch{/* Exact GET below settles a lost POST acknowledgement. */}
      deployed=await active();if(deployed.version!==version||deployed.marker!==deploymentMarker)fail('activation_unknown_requires_readback');
    }
    let catalog;
    for(let attempt=0;attempt<5;attempt++){
      try{const response=await send('https://stupid.gifts/.well-known/catalog-release.json',{headers:{'Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(20000)}),identity=await response.json();
        const contract=await send('https://stupid.gifts/.well-known/runtime-catalog.json',{headers:{'Cache-Control':'no-cache'},redirect:'error',signal:AbortSignal.timeout(20000)}),value=await contract.json();
        if(response.ok&&contract.ok&&identity.code_sha===source&&identity.release_id===output.metadata.releaseId&&identity.manifest_sha256===output.manifestSha256
          &&value.contract==='runtime-catalog-v1'&&/^[a-f0-9]{64}$/.test(value.dataSha256)){catalog=value;break;}
      }catch{/* An acknowledged deployment may still be propagating. Only retry GETs. */}
      if(attempt<4)await new Promise(resolve=>setTimeout(resolve,2000));
    }
    if(!catalog)fail('public_readback');
    if((await active()).version!==version)fail('newer_deployment_exists');
    const success={schemaVersion:1,state:'deployed',source,version,deployment:deployed.id,manifestSha256:output.manifestSha256,
      catalogReleaseId:catalog.catalogReleaseId,catalogDataSha256:catalog.dataSha256,workerSha256,settingsSha256,build:output.metrics,httpRequests,unknownRequests,
      uploaderRequestCount:'not_reported',supplierCalls:0,modelCalls:0};
    const priorSuccess=await read('success');if(!priorSuccess)await save('success',success);
    return success;
  }finally{await fs.rm(directory,{recursive:true,force:true});}
}
async function main(){
  const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim(),runtime=automationRuntime();
  if(git('status','--porcelain','--untracked-files=all')||process.versions.node.split('.')[0]!=='22'||process.env.GITHUB_SHA!==git('rev-parse','HEAD')
    ||git('rev-parse','origin/main')!==git('rev-parse','HEAD'))fail('source_not_clean_or_current_main');
  console.log(JSON.stringify(await deployRuntimeApp({runtime,source:process.env.GITHUB_SHA})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{
  console.error(JSON.stringify({state:'attention',errorCode:/^runtime_app_[a-z_]+$/.test(error.message)?error.message:'runtime_app_failed'}));process.exitCode=1;
});
