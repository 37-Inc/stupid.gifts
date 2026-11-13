import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProtectedDestination } from './export-postgres.ts';
import { canonicalJson, sha256 } from './migration.ts';
import { explicitMaintenanceTime } from './maintenance-state.ts';
import { openRunWorkspace, readRunWorkspace } from './run-workspace.ts';
import type { RunWorkspaceOptions, WorkspaceManifest, RunWorkspace, PublicationSuccess } from './run-workspace.ts';
import { isCatalogD1Rest } from './d1-write-rest.ts';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import {validatePublicationControlArtifact} from './publication-control.ts';
import type {DurablePublicationArtifact} from './publication-control.ts';

export const WORKSPACE_SWEEP_LIMITS=Object.freeze({runs:1000,entries:20_000,manifestBytes:32*1024,eventBytes:1024*1024});
const KEY=/^[A-Za-z0-9._-]{1,100}$/;
const OBJECT=/^(?:[a-f0-9]{64}\.json|\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/;
const fail=(code:string):never=>{throw new Error(`workspace_sweep_${code}`);};
const safeCode=(error:unknown)=>error instanceof Error&&/^(?:run_workspace|workspace_sweep)_[a-z_]+$/.test(error.message)?error.message:'workspace_sweep_review';
export interface WorkspaceSweepEntry {
  runId:string;state:'cleaned'|'retained'|'skipped'|'busy'|'review';purged:number;reasonCode?:string;
}
export interface WorkspaceSweepReport {schemaVersion:1;runs:WorkspaceSweepEntry[];reviewRequired:boolean;busy:boolean}

async function protectedPath(path:string,directory:boolean){
  const stat=await lstat(path);
  if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||stat.uid!==process.getuid?.()
    ||(stat.mode&0o777)!==(directory?0o700:0o600)||!directory&&stat.nlink!==1||await realpath(path)!==path)fail('private_path');
  return stat;
}
async function names(path:string,limit:number=WORKSPACE_SWEEP_LIMITS.entries){
  const result:string[]=[];
  for await(const entry of await opendir(path)){if(result.length>=limit)fail('entries');result.push(entry.name);}
  return result.sort();
}
async function canonicalFile(path:string,maximum:number):Promise<unknown>{
  const before=await protectedPath(path,false);if(before.size>maximum)fail('bytes');
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const opened=await file.stat();if(opened.ino!==before.ino||opened.dev!==before.dev||opened.nlink!==1)fail('file_changed');
    const bytes=Buffer.alloc(before.size+1);let length=0;
    while(length<bytes.length){const part=await file.read(bytes,length,bytes.length-length,null);if(!part.bytesRead)break;length+=part.bytesRead;}
    const after=await protectedPath(path,false);
    if(length!==before.size||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size
      ||after.mtimeMs!==before.mtimeMs||after.ctimeMs!==before.ctimeMs)fail('file_changed');
    const body=bytes.subarray(0,length);let value;try{value=JSON.parse(body.toString('utf8'));}catch{return fail('json');}
    if(!body.equals(Buffer.from(`${canonicalJson(value)}\n`)))fail('noncanonical');return value;
  }finally{await file.close();}
}
async function resumeOptions(directory:string,repository:string,runId:string,now:()=>string):Promise<RunWorkspaceOptions>{
  const manifest=await canonicalFile(join(directory,'runs',runId,'manifest.json'),WORKSPACE_SWEEP_LIMITS.manifestBytes) as WorkspaceManifest;
  if(!manifest||Object.keys(manifest).sort().join(',')!=='budgetCaps,codeSha,configSha256,createdAt,retention,runId,schemaVersion,scope'
    ||manifest.schemaVersion!==1||manifest.runId!==runId)fail('manifest');
  explicitMaintenanceTime(manifest.createdAt);
  // The workspace itself validates every scope/policy/cap field and the exact
  // immutable manifest. Cleanup never substitutes today's config/code/policy.
  return{directory,repository,mode:'resume',runId,configSha256:manifest.configSha256,codeSha:manifest.codeSha,
    scope:manifest.scope,retention:manifest.retention,budgetCaps:manifest.budgetCaps,requestLimit:'observe',
    expectedManifestSha256:sha256(canonicalJson(manifest)),now};
}
async function unregisteredOutputs(directory:string,success:PublicationSuccess|null){
  // openRunWorkspace has already independently validated/replayed the journal.
  // Extract registration identities only; do not maintain a second state machine.
  const registered=new Set<string>(),controls=new Set<string>();let unregistered=0;
  for(const name of await names(join(directory,'events'))){
    await protectedPath(join(directory,'events',name),false);
    if(name.startsWith('.pending-')){unregistered++;continue;}
    const record=await canonicalFile(join(directory,'events',name),WORKSPACE_SWEEP_LIMITS.eventBytes) as {event:{type:string;retention?:{releaseId:string};ref?:{reference:string}}};
    if(name.split('.')[1]!==sha256(canonicalJson(record)))fail('journal_changed');
    if(record.event.type==='publication-directories')registered.add(record.event.retention!.releaseId);
    if(record.event.type==='publication-artifact')controls.add(record.event.ref!.reference);
  }
  for(const parent of ['packages','publication-runtime']){
    const path=join(directory,parent);try{await protectedPath(path,true);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')continue;throw error;}
    for(const name of await names(path)){
      await protectedPath(join(path,name),true);
      if(!registered.has(name))unregistered++;
    }
  }
  for(const name of await names(join(directory,'objects'))){
    await protectedPath(join(directory,'objects',name),false);
    if(!OBJECT.test(name))unregistered++;
  }
  const controlDirectory=join(directory,'controls');await protectedPath(controlDirectory,true);
  for(const name of await names(controlDirectory)){
    const file=join(controlDirectory,name);await protectedPath(file,false);
    if(!controls.has('controls/'+name)){unregistered++;continue;}
    const artifact=validatePublicationControlArtifact(await canonicalFile(file,8*1024*1024) as DurablePublicationArtifact);
    if(name!==sha256(canonicalJson(artifact.value))+'.json')fail('control_changed');
  }
  for(const name of await names(directory))if(!['manifest.json','head.json','objects','controls','events','packages','publication-runtime'].includes(name)){
    const path=join(directory,name);await protectedPath(path,(await lstat(path)).isDirectory());
    // The workspace independently validates its completion-pinned inventory;
    // the name alone is never registration, and these controls are not deleted.
    if(!(success&&name==='publication-recovery-bounds'))unregistered++;
  }
  return unregistered;
}
function completed(checkpoint:Awaited<ReturnType<typeof readRunWorkspace>>['checkpoint'],success:PublicationSuccess|null){
  return success!==null||checkpoint?.checkpoint.phase==='finalized'&&checkpoint.checkpoint.owner===null
    &&(!checkpoint.checkpoint.control?.publication||checkpoint.checkpoint.control.publication.stage==='published');
}

/** Explicit observer only; never called by the offline sweep/CLI. Supply the
 * existing body-free seal's D1 receipt digest and exact publisher bindings.
 * ONE accounted primary SELECT batch proves receipt + resolved build + IDLE;
 * no upload, activation, D1 mutation, claim, budget grant or expiry renewal.
 * A historical ledger may exceed ordinary client caps: this API supplies no
 * new admission/allowance and is not permission to reopen a consumed profile. */
export async function recordSuccessfulPublication(input:{workspace:RunWorkspace;db:CatalogD1&{providerIdentity:string};
  expectedCheckpointSha256:string;receiptSha256:string;configSha256:string;packageSha256:string}):Promise<PublicationSuccess>{
  const {workspace:w,db}=input,cp=await w.readCheckpoint({controlOnly:true}),p=cp?.checkpoint.control?.publication;
  if(cp?.sha256!==input.expectedCheckpointSha256||!p||p.stage!=='published'||!p.permit
    ||input.configSha256!==p.configSha256||input.packageSha256!==p.packageSha256||!/^[a-f0-9]{64}$/.test(input.receiptSha256))fail('completion');
  const current=cp!,publication=p!,permit=publication.permit!;
  const prior=await w.publicationSuccess();
  if(prior){if(prior.receiptSha256!==input.receiptSha256)fail('completion');return prior;}
  if(!isCatalogD1Rest(db)||db.providerIdentity!==`cloudflare:${w.manifest.scope.accountId}:${w.manifest.scope.databaseId}`)fail('completion');
  const beforeHead=await canonicalFile(join(w.directory,'head.json'),1024) as {sequence:number;sha256:string},before=await w.budget(),rows=await db.batch([
    db.prepare('SELECT release_id,catalog_revision,code_sha,completed_at,manifest_json FROM publication_receipts WHERE release_id=?').bind(permit.releaseId),
    db.prepare('SELECT request_id,environment,source_revision,request_json,state,lease_token,lease_until,run_reference,release_id,version_reference,error_code FROM catalog_build_requests WHERE request_id=?').bind(publication.requestId),
    db.prepare("SELECT environment,index_name,generation,mutation_epoch,phase,owner_token,owner_reference,operation_key,captured_at,external_pending,activation_request_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') observed_at FROM catalog_mutation_scopes WHERE environment=? AND index_name=?")
      .bind(w.manifest.scope.environment,w.manifest.scope.indexName),
  ]) as {results:Record<string,unknown>[]}[],usage=await w.budget(),journal=await canonicalFile(join(w.directory,'head.json'),1024) as {sequence:number;sha256:string};
  if(!Array.isArray(rows)||rows.length!==3||rows.some(r=>!Array.isArray(r.results)||r.results.length!==1)
    ||usage.httpRequests!==before.httpRequests+1||usage.sqlStatements!==before.sqlStatements+3
    ||journal.sequence!==beforeHead.sequence+2
    ||usage.knownRowsWritten!==before.knownRowsWritten||usage.unconfirmedRequests!==before.unconfirmedRequests)fail('completion');
  return w.recordPublicationSuccess({schemaVersion:1,checkpointSha256:current.sha256,receiptSha256:input.receiptSha256,
    configSha256:input.configSha256,packageSha256:input.packageSha256,receipt:rows[0].results[0],build:rows[1].results[0],scope:rows[2].results[0],usage,journal});
}

/** One explicit canonical root/repository; no provider calls, PID takeover,
 * discovery of other roots or automatic adoption/deletion of imported history. */
export async function purgeCompletedWorkspaces(input:{directory:string;repository:string;now?:()=>string}):Promise<WorkspaceSweepReport>{
  const {directory,repository}=input,now=input.now||(()=>new Date().toISOString());explicitMaintenanceTime(now());
  if(!isAbsolute(directory)||normalize(directory)!==directory||!isAbsolute(repository)||normalize(repository)!==repository
    ||await realpath(repository)!==repository)fail('path');
  await protectedPath(directory,true);await assertProtectedDestination(directory,repository);
  await protectedPath(join(directory,'runs'),true);await protectedPath(join(directory,'locks'),true);
  const runIds=await names(join(directory,'runs'),WORKSPACE_SWEEP_LIMITS.runs);
  // Refuse unsafe inventory before deleting anything, including a linked sibling.
  for(const id of runIds){if(!KEY.test(id)||id==='.'||id==='..')fail('run_name');await protectedPath(join(directory,'runs',id),true);}
  const results:WorkspaceSweepEntry[]=[];
  for(const runId of runIds){
    let workspace:Awaited<ReturnType<typeof openRunWorkspace>>|undefined;
    const result:WorkspaceSweepEntry={runId,state:'review',purged:0};
    try{
      const options=await resumeOptions(directory,repository,runId,now);workspace=await openRunWorkspace(options);
      const checkpoint=await workspace.readCheckpoint({controlOnly:true});
      const success=await workspace.publicationSuccess();
      const hasWork=checkpoint!==null||(await workspace.budget()).httpRequests>0||(await names(join(workspace.directory,'objects'))).length>0;
      const unregistered=await unregisteredOutputs(workspace.directory,success);
      // Retention applies during interruption too. The existing purge journal
      // preserves checkpoint phase/owner/control and every budget reservation;
      // cleanup never settles a deployment or declares an unfinished run done.
      result.purged=(await workspace.purgeExpired()).length;
      const unfinished=!completed(checkpoint,success)&&hasWork;
      result.state=unregistered||unfinished?'review':result.purged?'cleaned':'retained';
      if(unregistered)result.reasonCode='unregistered_outputs';else if(unfinished)result.reasonCode='unfinished_run';
    }catch(error){
      const code=safeCode(error);result.state=code==='run_workspace_locked'?'busy':'review';
      result.reasonCode=code==='run_workspace_publication_scope'?'source_checkout_review':code;
    }finally{
      if(workspace)try{await workspace.close();}catch(error){result.state='review';result.reasonCode=safeCode(error);}
    }
    results.push(result);
  }
  return{schemaVersion:1,runs:results,reviewRequired:results.some(r=>r.state==='review'),busy:results.some(r=>r.state==='busy')};
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){console.log('Usage: node --experimental-strip-types scripts/catalog/purge-workspaces.ts --workspace /private/canonical/root --repository /canonical/checkout\nPurges verified expired bodies under their original retention, including interrupted runs. Unfinished state is preserved for review; no provider calls or lock takeover.');return;}
  if(args.length!==4||args[0]!=='--workspace'||args[2]!=='--repository')fail('arguments');
  const report=await purgeCompletedWorkspaces({directory:args[1],repository:args[3]});console.log(JSON.stringify(report));
  if(report.reviewRequired)process.exitCode=2;else if(report.busy)process.exitCode=3;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(safeCode(error));process.exitCode=1;});
