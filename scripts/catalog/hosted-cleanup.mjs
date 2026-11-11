import {createHash} from 'node:crypto';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {openRunWorkspace} from './run-workspace.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';

const hash=b=>createHash('sha256').update(b).digest('hex'),json=b=>JSON.parse(Buffer.from(b));
const fail=()=>{throw Error('catalog_hosted_cleanup_identity');};
async function queue(runtime){
  let bytes=null;try{bytes=await runtime.state.readPointer('cleanup-runs',runtime.care+'/cleanup-runs.json');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const value=bytes?json(bytes):{schemaVersion:1,runs:[]};
  if(value.schemaVersion!==1||Object.keys(value).sort().join(',')!=='runs,schemaVersion'||!Array.isArray(value.runs)
    ||new Set(value.runs.map(r=>r.runId)).size!==value.runs.length)fail();
  for(const ref of value.runs)if(Object.keys(ref).sort().join(',')!=='dueAt,manifestSha256,runId,source'
    ||! /^[a-f0-9]{64}$/.test(ref.manifestSha256)||!Number.isFinite(Date.parse(ref.dueAt))
    ||! /^[A-Za-z0-9_-]{1,100}$/.test(ref.runId)||! /^[a-f0-9]{40}$/.test(ref.source))fail();
  return{bytes,value};
}
async function save(runtime,q){return runtime.state.pointer('cleanup-runs',runtime.care+'/cleanup-runs.json',q.value,q.bytes);}
/** Catalog registration and housekeeping now run in separate job queues. CAS
 * conflicts must merge against a fresh pointer, never overwrite a new run. */
async function changeQueue(runtime,change){
  for(let attempt=0;attempt<3;attempt++){
    const q=await queue(runtime);if(change(q.value.runs)===false)return;
    try{return await save(runtime,q);}catch(error){
      if(!['catalog_operator_state_pointer_conflict','catalog_object_store_conflict'].includes(error.message)||attempt===2)throw error;
    }
  }
}
async function manifestFor(runtime,runId){
  const object=await runtime.durable.get('runs/'+runId+'/manifest.json');if(!object)fail();
  const manifest=json(object.bytes);
  if(Object.keys(manifest).sort().join(',')!=='budgetCaps,codeSha,configSha256,createdAt,retention,runId,schemaVersion,scope')fail();
  if(manifest.schemaVersion!==1||manifest.runId!==runId||canonicalJson(manifest.scope)!==canonicalJson(CATALOG_SCOPE)
    ||! /^[a-f0-9]{40}$/.test(manifest.codeSha)||! /^[a-f0-9]{64}$/.test(manifest.configSha256))fail();
  return manifest;
}
/** Catalog and optional homepage journals share this same cleanup registration.
 * It carries only a hash of the ORIGINAL manifest, never a new retention policy. */
export async function registerHostedWorkspaceCleanup(runtime,manifest){
  const actual=await manifestFor(runtime,manifest.runId);if(canonicalJson(actual)!==canonicalJson(manifest))fail();
  const dueAt=new Date(Math.min(...Object.values(manifest.retention.rules).map(rule=>
    Math.min(Date.parse(rule.notAfter),Date.parse(manifest.createdAt)+rule.maxAgeMs)))).toISOString();
  const ref={runId:manifest.runId,source:manifest.codeSha,manifestSha256:hash(canonicalJson(manifest)),dueAt};
  await changeQueue(runtime,runs=>{const prior=runs.find(r=>r.runId===ref.runId);
    if(prior){if(canonicalJson(prior)!==canonicalJson(ref))fail();return false;}runs.push(ref);});
}
export async function registerHostedCleanup(runtime,record){
  const directory=runtime.care+'/runs/'+record.runKey,operator=json(await runtime.state.bytes(directory+'/operator.json'));
  if(operator.source!==record.source||operator.configPath!==directory+'/config.json')fail();
  const bytes=await runtime.state.bytes(operator.configPath);if(hash(bytes)!==operator.configSha256)fail();
  const config=json(bytes);
  if(config.codeSha!==record.source||config.runId!==operator.runId
    ||config.publication.sourceRoot!=='/home/runner/stupid-gifts/operators/'+record.source)fail();
  const manifest=await manifestFor(runtime,config.runId);
  if(manifest.codeSha!==record.source||manifest.configSha256!==operator.configSha256||canonicalJson(manifest.retention)!==canonicalJson(config.retention))fail();
  await registerHostedWorkspaceCleanup(runtime,manifest);
}
/** One due original workspace per existing wake. No supplier, model, D1 or
 * public-site operation. Failures are advisory; the registration stays queued. */
export async function cleanupHostedRuns(runtime,checkout,{now=()=>new Date().toISOString(),open=openRunWorkspace}={}){
  const q=await queue(runtime),ref=q.value.runs.find(r=>Date.parse(r.dueAt)<=Date.parse(now()));
  if(!ref)return{state:'current',queued:q.value.runs.length};
  let workspace;
  try{
    const manifest=await manifestFor(runtime,ref.runId);if(hash(canonicalJson(manifest))!==ref.manifestSha256||manifest.codeSha!==ref.source)fail();
    const repository=await checkout(ref.source);if(repository!=='/home/runner/stupid-gifts/operators/'+ref.source)fail();
    workspace=await open({directory:runtime.workspace,repository,mode:'resume',runId:manifest.runId,codeSha:manifest.codeSha,
      configSha256:manifest.configSha256,scope:manifest.scope,retention:manifest.retention,budgetCaps:manifest.budgetCaps,
      expectedManifestSha256:ref.manifestSha256,requestLimit:'observe',durable:runtime.durable,now});
    const cp=await workspace.readCheckpoint({controlOnly:true});
    const editorial=manifest.runId.match(/^homepage-(\d{4}-\d{2}-\d{2})-([a-f0-9]{8})$/);
    if(editorial){
      if(editorial[2]!==ref.source.slice(0,8)||cp&&cp.checkpoint.owner!==null
        ||manifest.retention.reviewReference!=='catalog-automation-spec/homepage-v1')fail();
    }else if(manifest.retention.reviewReference==='maintained/accepted-catalog-code-only'){
      const suffix='-'+ref.source.slice(0,8);
      if(!manifest.runId.startsWith('code-')||!manifest.runId.endsWith(suffix))fail();
      const key=manifest.runId.slice(5,-suffix.length),success=json(await runtime.state.bytes(runtime.care+'/code-only/'+key+'/success.json'));
      if(cp?.checkpoint.phase!=='published'||cp.checkpoint.owner!==null||success.kind!=='serving-only'
        ||success.releaseId!==manifest.runId||success.source!==ref.source||success.configSha256!==manifest.configSha256
        ||success.checkpointSha256!==cp.sha256||success.receiptSha256!==cp.checkpoint.control?.publication?.receiptSha256
        ||success.idle?.phase!=='idle'||success.idle.externalPending!==0)fail();
    }else if(cp?.checkpoint.phase!=='finalized'||cp.checkpoint.owner!==null||!await workspace.catalogSuccessor())fail();
    const purged=(await workspace.purgeExpired()).length,remaining=await workspace.retainedBodies();
    await changeQueue(runtime,runs=>{const index=runs.findIndex(r=>r.runId===ref.runId);if(index<0)return false;
      if(canonicalJson(runs[index])!==canonicalJson(ref))fail();runs.splice(index,1);if(remaining)runs.push(ref);});
    return{state:'cleaned',runId:ref.runId,purged,remaining};
  }catch(error){
    // One broken historical source must not starve other due registrations.
    try{await changeQueue(runtime,runs=>{const index=runs.findIndex(r=>r.runId===ref.runId);if(index<0)return false;
      if(canonicalJson(runs[index])!==canonicalJson(ref))fail();runs.push(...runs.splice(index,1));});}
    catch{/* Original durable registration remains. */}throw error;
  }finally{await workspace?.close();}
}
