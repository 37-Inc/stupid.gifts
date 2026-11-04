import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson,sha256} from './migration.ts';
import type {ArtifactRef,PublicationControl,RunWorkspace} from './run-workspace.ts';
import type {RoutineUploadActivationApproval} from '../../lib/catalog/build-requests.ts';

export interface AssetUploadRetryEvidence {
  schemaVersion:1;kind:'asset-content-transfer-failure';checkpointSha256:string;attempt:number;
  packageSha256:string;configSha256:string;logSha256:string;outputSha256:string;
  assetContentRequests:number;versionPosts:0;
}
function refuse():never{throw Error('publication_asset_retry_unproven');}
async function privateBytes(file:string,max=2*1024*1024){
  const s=await fs.lstat(file);
  if(!s.isFile()||s.nlink!==1||s.uid!==process.getuid?.()||(s.mode&0o777)!==0o600||s.size>max||await fs.realpath(file)!==file)refuse();
  return fs.readFile(file);
}
/** Asset uploads are content addressed. A failed version POST is NOT covered.
 * Preserve the actual failed command and its charged/unknown attempts; inspect
 * only the exact registered runtime, never a caller-supplied log path. */
export async function assetUploadRetryEvidence(w:RunWorkspace,c:PublicationControl,checkpointSha256:string,attempt:number):Promise<AssetUploadRetryEvidence>{
  await w.assertHeld();
  if(!Number.isInteger(attempt)||attempt<1||attempt>3||!c.packageSha256)refuse();
  const runtime=path.join(w.directory,'publication-runtime',w.manifest.runId,...(attempt>1?[`routine-retry-${attempt-1}`]:[]));
  const output=await privateBytes(path.join(runtime,'upload.ndjson'));
  const lines=output.toString().trim().split('\n').map(l=>JSON.parse(l));
  const session=lines.find(l=>l.type==='wrangler-session');
  if(!session||lines.some(l=>l.type==='version-upload')||!Array.isArray(session.command_line_args)
    ||!session.command_line_args.includes(c.uploadMarker)||path.dirname(session.log_file_path)!==path.join(runtime,'logs')
    ||!/^wrangler-[0-9_-]+\.log$/.test(path.basename(session.log_file_path)))refuse();
  const log=await privateBytes(session.log_file_path);
  const account=`/client/v4/accounts/${w.manifest.scope.accountId}/workers`;
  const script=`${account}/scripts/${w.manifest.scope.workerName}`;
  let assets=0,requests=0;
  for(const line of log.toString().split('\n')){
    if(!line.startsWith('-- START CF API REQUEST: '))continue;
    requests++;
    const m=line.match(/^-- START CF API REQUEST: (GET|POST) (\S+)$/);if(!m)refuse();
    const url=new URL(m[2]),offset=url.pathname.indexOf('/client/v4/');
    if(url.hostname!=='127.0.0.1'||offset<0)refuse();
    const endpoint=url.pathname.slice(offset);
    if(m[1]==='GET'&&!url.search&&[`${account}/services/${w.manifest.scope.workerName}`,`${script}/secrets`,`${account}/workers/${w.manifest.scope.workerName}`].includes(endpoint))continue;
    if(m[1]==='POST'&&!url.search&&endpoint===`${script}/assets-upload-session`)continue;
    if(m[1]==='POST'&&(endpoint===`${account}/assets/upload`&&url.search==='?base64=true'
      ||new RegExp(`^${account}/assets/upload/[a-f0-9]{32}$`).test(endpoint)&&!url.search)){assets++;continue;}
    // Includes every version write, foreign endpoint and unknown dispatch.
    refuse();
  }
  // Read-only preflight and upload-session setup are also safe before any
  // version dispatch. Empty/truncated logs prove nothing.
  if(!requests)refuse();
  const digest=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
  return{schemaVersion:1,kind:'asset-content-transfer-failure',checkpointSha256,attempt,
    packageSha256:c.packageSha256,configSha256:c.configSha256,logSha256:digest(log),outputSha256:digest(output),assetContentRequests:assets,versionPosts:0};
}

/** Normal maintenance retries its saved package, never its supplier phases.
 * Each bounded continuation gets append-only pins; earlier attempts survive. */
export async function routineUploadRetry(w:RunWorkspace,at:string):Promise<{
  approval:RoutineUploadActivationApproval;evidence:ArtifactRef;
}|undefined>{
  const saved=await w.readCheckpoint({controlOnly:true});if(!saved)return;
  const cp=saved.checkpoint,c=cp.control?.publication,p=cp.pins;
  if(cp.phase==='finalized')return;
  const attempts=Object.keys(p).flatMap(k=>{const m=k.match(/^publicationUploadRoutine([1-3])Pending$/);return m?[Number(m[1])]:[];});
  const latest=Math.max(0,...attempts);
  if(latest&&p[`publicationUploadRoutine${latest}Acknowledged`]){
    const record=await w.readArtifact(p[`publicationUploadRoutine${latest}Pending`]) as unknown as {approval:RoutineUploadActivationApproval;evidence:ArtifactRef};
    return{approval:record.approval,evidence:record.evidence};
  }
  if(!c||!['attention','publishing'].includes(cp.phase)||cp.owner?.phase!=='freezing'||c.stage!=='uploading'
    ||!p.publicationUploadReview||!p.publicationUploadPending||p.publicationUploadAcknowledged||c.permit||c.versionReference)return;
  const review=await w.readArtifact(p.publicationUploadReview) as {code:string;detail?:{versionDispatched:boolean}};
  if(!['publication_upload_unknown','publication_upload_command_failed'].includes(review.code)||review.detail?.versionDispatched)refuse();
  if(latest>=3)throw Error('publication_asset_retry_exhausted');
  const attempt=latest+1,e=await assetUploadRetryEvidence(w,c,saved.sha256,attempt);
  const evidence=await w.putArtifact(e,{kind:'publication',observedAt:at});
  const end=Math.min(Date.parse(at)+6*3600000,Date.parse(w.manifest.retention.rules.publication.notAfter),
    c.intent?.nextExpiry?Date.parse(c.intent.nextExpiry)-1000:Infinity);
  if(!Number.isFinite(end)||end<=Date.parse(at))throw Error('publication_asset_retry_expired');
  const approval:RoutineUploadActivationApproval={schemaVersion:5,attempt,requestId:c.requestId,
    packageSha256:c.packageSha256!,configSha256:c.configSha256,checkpointSha256:saved.sha256,
    reviewPinSha256:p.publicationUploadReview.sha256,evidenceSha256:evidence.sha256,
    reviewReference:'routine/owner-2026-11-04/content-addressed-retry',reviewedAt:at,activationDeadline:new Date(end).toISOString(),
    authorizationSha256:sha256(canonicalJson({policy:'owner/2026-11-04/routine-retry',runId:w.manifest.runId,attempt,evidence:evidence.sha256}))};
  return{approval,evidence};
}
