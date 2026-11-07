import {createHash} from 'node:crypto';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {hostedRunRecord} from './hosted-coordinator.mjs';
import {validateCloudflareWeeklyConfig} from './run-cloudflare-weekly.ts';
import {openRunWorkspace} from './run-workspace.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';

const hash=b=>createHash('sha256').update(b).digest('hex'),json=b=>JSON.parse(Buffer.from(b));
const fail=()=>{throw Error('catalog_hosted_cleanup_identity');};
async function queue(runtime){
  let bytes=null;try{bytes=await runtime.state.readPointer('cleanup-runs',runtime.care+'/cleanup-runs.json');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const value=bytes?json(bytes):{schemaVersion:1,runs:[]};
  if(value.schemaVersion!==1||Object.keys(value).sort().join(',')!=='runs,schemaVersion'||!Array.isArray(value.runs)
    ||new Set(value.runs.map(r=>r.path)).size!==value.runs.length)fail();
  for(const ref of value.runs)if(Object.keys(ref).sort().join(',')!=='dueAt,path,sha256'
    ||! /^[a-f0-9]{64}$/.test(ref.sha256)||!Number.isFinite(Date.parse(ref.dueAt))
    ||!ref.path.startsWith(runtime.care+'/runs/')||! /^[A-Za-z0-9_-]+\/hosted-run\.json$/.test(ref.path.slice((runtime.care+'/runs/').length)))fail();
  return{bytes,value};
}
async function save(runtime,q){return runtime.state.pointer('cleanup-runs',runtime.care+'/cleanup-runs.json',q.value,q.bytes);}
async function original(runtime,record){
  const directory=runtime.care+'/runs/'+record.runKey,operator=json(await runtime.state.bytes(directory+'/operator.json'));
  if(operator.source!==record.source||operator.configPath!==directory+'/config.json')fail();
  const bytes=await runtime.state.bytes(operator.configPath);if(hash(bytes)!==operator.configSha256)fail();
  const config=validateCloudflareWeeklyConfig(json(bytes)),scope=CATALOG_SCOPE;
  if(config.codeSha!==record.source||config.runId!==operator.runId||config.environment!==scope.environment
    ||config.accountId!==scope.accountId||config.database.id!==scope.databaseId||config.database.name!==scope.databaseName
    ||config.vectorIndex.name!==scope.indexName||config.publication.workerName!==scope.workerName
    ||config.publication.sourceRoot!=='/home/runner/stupid-gifts/operators/'+record.source)fail();
  return{config,operator};
}
/** A small housekeeping list, not run/ownership state. Register before clearing
 * accepted pending work. Lost ACKs reuse the exact original record/deadline. */
export async function registerHostedCleanup(runtime,record){
  const q=await queue(runtime),path=runtime.care+'/runs/'+record.runKey+'/hosted-run.json',bytes=await runtime.state.bytes(path);
  if(canonicalJson(hostedRunRecord(json(bytes)))!==canonicalJson(record))fail();
  const {config}=await original(runtime,record),object=await runtime.durable.get('runs/'+config.runId+'/manifest.json');
  if(!object)fail();const manifest=json(object.bytes);
  if(manifest.runId!==config.runId||manifest.codeSha!==record.source||manifest.configSha256!==hash(await runtime.state.bytes(runtime.care+'/runs/'+record.runKey+'/config.json'))
    ||canonicalJson(manifest.retention)!==canonicalJson(config.retention))fail();
  const dueAt=new Date(Math.min(...Object.values(config.retention.rules).map(rule=>Math.min(Date.parse(rule.notAfter),Date.parse(manifest.createdAt)+rule.maxAgeMs)))).toISOString();
  const ref={path,sha256:hash(bytes),dueAt},prior=q.value.runs.find(r=>r.path===path);
  if(prior){if(canonicalJson(prior)!==canonicalJson(ref))fail();return;}
  q.value.runs.push(ref);await save(runtime,q);
}
/** One due original workspace per existing wake. No supplier, model, D1 or
 * public-site operation. Failures are advisory; the registration stays queued. */
export async function cleanupHostedRuns(runtime,checkout,{now=()=>new Date().toISOString(),open=openRunWorkspace}={}){
  const q=await queue(runtime),ref=q.value.runs.find(r=>Date.parse(r.dueAt)<=Date.parse(now()));
  if(!ref)return{state:'current',queued:q.value.runs.length};
  const bytes=await runtime.state.bytes(ref.path);if(hash(bytes)!==ref.sha256)fail();
  const record=hostedRunRecord(json(bytes));if(ref.path!==runtime.care+'/runs/'+record.runKey+'/hosted-run.json')fail();
  const {config,operator}=await original(runtime,record),repository=await checkout(record.source);
  if(repository!==config.publication.sourceRoot)fail();
  const workspace=await open({directory:runtime.workspace,repository,mode:'resume',runId:config.runId,codeSha:record.source,
    configSha256:operator.configSha256,scope:CATALOG_SCOPE,retention:config.retention,budgetCaps:{httpRequests:config.limits.requests,sqlStatements:config.limits.statements},
    requestLimit:'observe',durable:runtime.durable,now});
  try{
    const cp=await workspace.readCheckpoint({controlOnly:true});
    if(cp?.checkpoint.phase!=='finalized'||cp.checkpoint.owner!==null||!await workspace.publicationSuccess())fail();
    const purged=(await workspace.purgeExpired()).length,remaining=await workspace.retainedBodies();
    if(!remaining){q.value.runs=q.value.runs.filter(r=>r.path!==ref.path);await save(runtime,q);}
    return{state:'cleaned',runKey:record.runKey,purged,remaining};
  }finally{await workspace.close();}
}
