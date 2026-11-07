import { readHomepageEdition } from '../../lib/catalog/homepage-edition.ts';
import type { HomepageEdition } from '../../lib/catalog/homepage-edition.ts';
import {readMerchandising} from '../../lib/catalog/merchandising.ts';
import type {Merchandising} from '../../lib/catalog/merchandising.ts';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import type { MutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { mutationAssertion, readMutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { rollbackPreflight } from '../../lib/catalog/d1.ts';
import type { PrunedRevision } from '../../lib/catalog/prune-existing-revision.ts';
import { prunedVectorIds, prunedVectorPlan } from '../../lib/catalog/prune-existing-revision.ts';
import type { PermanentCatalogRevision } from '../../lib/catalog/freeze-permanent-catalog.ts';
import { assertPermanentCatalog } from '../../lib/catalog/freeze-permanent-catalog.ts';
import {assertApprovedCatalogInventory} from './permanent-catalog-seal.ts';
import type { ApprovedCohortRevision } from '../../lib/catalog/freeze-approved-cohort.ts';
import type { ActivationPermit, DeploymentIdentity, DeploymentObservation, BuildRecoveryApproval, ReviewedUploadActivationApproval, ReviewedUploadActivationApprovalV1, ReviewedUploadActivationInput } from '../../lib/catalog/build-requests.ts';
import { beginBuildActivation, claimBuildRequest, encodeBuildRequest, resolveBuildActivation, drainDeploymentObservation,
  encodeBuildRecoveryApproval, recoverUnstartedBuildRequest, readUnstartedBuildRecovery,
  encodeReviewedUploadActivationApproval, reviewedUploadActivationDeadline, beginReviewedUploadActivation, readReviewedUploadActivation,validatePublicationFinishAuthority } from '../../lib/catalog/build-requests.ts';
import { isAccountedPublicationFetch } from './publication-read-fetch.ts';
import { isAccountedPublicationUploadCommand, PublicationUploadCommandError } from './publication-upload-command.ts';
import { isCatalogD1Rest } from './d1-write-rest.ts';
import {readOnlyUploadEvidence,readOnlyTransportEvidence} from './upload-preflight-proof.ts';
import type {ReadOnlyUploadEvidence,ReadOnlyTransportEvidence} from './upload-preflight-proof.ts';
import {assetUploadRetryEvidence} from './routine-upload-retry.ts';
import type { PublicationIntent } from '../../lib/catalog/publication.ts';
import { claimPublication, completeActivatedPublication, completeActivatedPermanentPublication, completeActivatedApprovedCatalogPublication, completeActivatedServingPublication,
  completePublication, enqueuePublication, encodePublicationIntent, publicationStatus, servingPublicationStatus, recordPublicationDispatch } from '../../lib/catalog/publication.ts';
import type { SiteAssetManifest } from '../../lib/catalog/types.ts';
import type { ReleaseBuildContext } from '../staging/build.mts';
import { assertBuildSource, validateBuildContext } from '../staging/build.mts';
import { verifyReleaseIdentity } from '../staging/release-identity.mts';
import { verifyFeedPlan, verifyReleaseContext, verifySiteIdentity } from '../staging/verify-release.mts';
import { CLOUDFLARE_ASSET_LIMIT, readPriorRelease, verifyRetainedAssets } from '../staging/retention.mts';
import { siteIdentityFor } from '../../static-site/lib/site-identity.ts';
import { canonicalTime, validateCatalogSnapshot } from '../../lib/catalog/snapshot.ts';
import { canonicalJson } from './migration.ts';
import { readAcceptedActivatedCatalogNative, readActivatedCatalogVectors, readActivatedPermanentCatalogNative, readPermanentNativeProof, readPublishedCatalogVectors, readOwnedApprovedCohortVectors, readOwnedPermanentCohortNative, readOwnedPrunedVectors } from './owned-vector-delivery.ts';
import type { PublishedCatalogRead } from './owned-vector-delivery.ts';
import { createVectorizeRestAdapters } from './vectorize-rest.ts';
import type { RunWorkspace, PublicationControl, ArtifactRef } from './run-workspace.ts';
import { semanticBudgetConfig } from '../../workers/site/semantic-budget.ts';
import { verifySemanticCatalogIdentities, DERIVED_SEARCH_PROFILE } from '../../lib/catalog/semantic-profile.ts';
import {assertAcceptedCodeOnlyBinding,readAcceptedCodeOnlyCatalog,acceptedCodeOnlyOperationKey} from './accepted-code-only.ts';
import type {AcceptedCodeOnlyRead,AcceptedCodeOnlyControl} from './accepted-code-only.ts';

/** Explicit protected local operator path, NOT a scheduler or a cross-host lock.
 * The workspace holds concrete shared account/environment/database + Worker
 * locks; the D1 activating fence has no timeout/takeover. Before cross-host CI,
 * install one environment concurrency group and exclude out-of-band deployers.
 * Routine execution requires an existing verified catalog prior. First deploy
 * is a separate protected operator operation, never a versions-upload fallback.
 * API contract: developers.cloudflare.com/api/resources/workers/subresources/scripts/
 * versions/ and deployments/. Versions are immutable uploads, NOT publication.
 */
export interface PublicationConfig {
  schemaVersion:1; environment:'staging'|'production'; accountId:string; workerName:string;
  database:{id:string;name:string}; indexName:string; codeSha:string;
  sourceMode:SiteAssetManifest['sourceMode']; sourceRoot:string; releaseId:string;
  identityOrigin:string; compatibilityDate:string;
  /** null directory verifies the prior identity only, without retaining old
   * snapshot/assets. A purged/expired prior is never needed to build anew. */
  prior:{directory:string|null;manifestSha256:string;releaseId:string;versionReference:string}|null;
  /** Exact current code-only deployment of the same catalog, independently
   * observed before the run. The prior above remains the real D1 receipt. */
  servingPrior?:DeploymentIdentity;
  /** Serving-only release over this original genuine catalog authority. */
  acceptedCatalog?:{releaseId:string;receiptSha256:string;sealSha256:string};
  homepage?:HomepageEdition;
  merchandising?:Merchandising;
  /** Omission preserves historical config hashes and default-off behavior. */
  semanticSearch?:{enabled:boolean;
    /** Accepted only for retained historical configs, never sent to live search. */
    dailyRequestCap?:number;dailyTokenCap?:number;
    /** Canonical-JSON SHA, public hashes only. Separate from the original native index. */
    derivedCatalog?:{path:string;sha256:string;indexName:string}};
  /** Public build inputs only; omission preserves historical hashes/default-off. */
  publicAnalytics?:{enabled:boolean;posthogKey:string;posthogHost:string};
}
const KEY=/^[a-zA-Z0-9._-]{1,200}$/;
const HASH=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RESOURCE=/^[a-zA-Z0-9_-]{1,100}$/;
const WORKERS_DEV_NAME=/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const exact=(v:object,keys:string)=>Object.keys(v).sort().join(',')===keys;
const sameRef=(a:ArtifactRef|undefined,b:ArtifactRef|undefined)=>canonicalJson(a??null)===canonicalJson(b??null);
const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
export function validatePublicationConfig(input:PublicationConfig):Readonly<PublicationConfig> {
  if(!input||!exact(input,`${Object.hasOwn(input,'acceptedCatalog')?'acceptedCatalog,':''}accountId,codeSha,compatibilityDate,database,environment,${Object.hasOwn(input,'homepage')?'homepage,':''}identityOrigin,indexName,${Object.hasOwn(input,'merchandising')?'merchandising,':''}prior,${Object.hasOwn(input,'publicAnalytics')?'publicAnalytics,':''}releaseId,schemaVersion,${Object.hasOwn(input,'semanticSearch')?'semanticSearch,':''}${Object.hasOwn(input,'servingPrior')?'servingPrior,':''}sourceMode,sourceRoot,workerName`)
    ||input.schemaVersion!==1||!['staging','production'].includes(input.environment)||!/^[a-f0-9]{32}$/.test(input.accountId)
    ||!RESOURCE.test(input.workerName)||input.environment==='staging'&&!WORKERS_DEV_NAME.test(input.workerName)
    ||!RESOURCE.test(input.indexName)||!input.database||!exact(input.database,'id,name')
    ||!['preview','goose-production','stupid-production'].includes(input.sourceMode)
    ||!UUID.test(input.database.id)||!RESOURCE.test(input.database.name)||!/^[a-f0-9]{40}$/.test(input.codeSha)
    ||!KEY.test(input.releaseId)||!path.isAbsolute(input.sourceRoot)||!/^\d{4}-\d{2}-\d{2}$/.test(input.compatibilityDate)
    ||new Date(`${input.compatibilityDate}T00:00:00.000Z`).toISOString().slice(0,10)!==input.compatibilityDate)
    throw new Error('publication_configuration_invalid');
  if(Object.hasOwn(input,'homepage')&&!readHomepageEdition(input.homepage))throw new Error('publication_homepage_invalid');
  if(Object.hasOwn(input,'merchandising')&&!readMerchandising(input.merchandising))throw new Error('publication_merchandising_invalid');
  const identity=siteIdentityFor(input.sourceMode); const origin=new URL(input.identityOrigin);
  if(origin.protocol!=='https:'||origin.origin!==input.identityOrigin||origin.username||origin.password
    ||input.environment==='staging'&&input.sourceMode!=='preview'
    ||input.environment==='production'&&(input.sourceMode==='preview'||origin.origin!==identity.origin)
    ||input.prior!==null&&(!exact(input.prior,'directory,manifestSha256,releaseId,versionReference')
      ||input.prior.directory!==null&&!path.isAbsolute(input.prior.directory)||!HASH.test(input.prior.manifestSha256)||!KEY.test(input.prior.releaseId)
      ||!UUID.test(input.prior.versionReference)||input.prior.releaseId===input.releaseId))throw new Error('publication_configuration_invalid');
  if(Object.hasOwn(input,'servingPrior')){
    const s=input.servingPrior;
    if(!input.prior||!s||!exact(s,'catalogRevision,catalogSnapshotSha256,codeSha,manifestSha256,releaseId,versionReference')
      ||!KEY.test(s.releaseId)||s.releaseId===input.releaseId||!KEY.test(s.catalogRevision)
      ||!/^[a-f0-9]{40}$/.test(s.codeSha)||!HASH.test(s.catalogSnapshotSha256)||!HASH.test(s.manifestSha256)
      ||!UUID.test(s.versionReference))throw new Error('publication_configuration_invalid');
  }
  if(Object.hasOwn(input,'acceptedCatalog')){
    const accepted=input.acceptedCatalog;
    if(!accepted||!exact(accepted,'receiptSha256,releaseId,sealSha256')||!KEY.test(accepted.releaseId)
      ||!HASH.test(accepted.receiptSha256)||!HASH.test(accepted.sealSha256)||!input.servingPrior
      ||input.prior?.releaseId!==accepted.releaseId)throw Error('publication_accepted_catalog_invalid');
  }
  if(Object.hasOwn(input,'semanticSearch')){
    const policy=input.semanticSearch;
    const historical=policy&&(Object.hasOwn(policy,'dailyRequestCap')||Object.hasOwn(policy,'dailyTokenCap'));
    if(!policy||!exact(policy,`${historical?'dailyRequestCap,dailyTokenCap,':''}${Object.hasOwn(policy,'derivedCatalog')?'derivedCatalog,':''}enabled`)
      ||typeof policy.enabled!=='boolean'||input.environment==='staging'&&policy.enabled
      // Retained historical configs keep their exact validated bytes/hashes.
      ||historical&&(!Number.isInteger(policy.dailyRequestCap)||!Number.isInteger(policy.dailyTokenCap)
      ||!semanticBudgetConfig({ENVIRONMENT:input.environment,SEMANTIC_SEARCH_ENABLED:'true',
        SEMANTIC_SEARCH_DAILY_REQUEST_CAP:String(policy.dailyRequestCap),SEMANTIC_SEARCH_DAILY_TOKEN_CAP:String(policy.dailyTokenCap)},
      {environment:input.environment,index:input.indexName})))throw new Error('publication_configuration_invalid');
    if(Object.hasOwn(policy,'derivedCatalog')){const derived=policy.derivedCatalog;
      if(!derived||!exact(derived,'indexName,path,sha256')||typeof derived.path!=='string'||!path.isAbsolute(derived.path)||!HASH.test(derived.sha256)
        ||typeof derived.indexName!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(derived.indexName)||derived.indexName===input.indexName)
        throw new Error('publication_configuration_invalid');}
  }
  if(Object.hasOwn(input,'publicAnalytics')){
    const policy=input.publicAnalytics;let host:URL|undefined;
    try{if(typeof policy?.posthogHost==='string'&&policy.posthogHost.length<=255)host=new URL(policy.posthogHost);}catch{/* Invalid is not an ingest origin. */}
    if(!policy||!exact(policy,'enabled,posthogHost,posthogKey')||typeof policy.enabled!=='boolean'
      ||input.environment!=='production'&&policy.enabled||typeof policy.posthogKey!=='string'||!/^phc_[a-zA-Z0-9_-]{1,196}$/.test(policy.posthogKey)
      ||!host||host.protocol!=='https:'||host.origin!==policy.posthogHost||host.username||host.password||host.port)
      throw new Error('publication_configuration_invalid');
  }
  return Object.freeze({...input,database:Object.freeze({...input.database}),prior:input.prior&&Object.freeze({...input.prior}),
    ...(input.homepage?{homepage:readHomepageEdition(input.homepage)!}:{}),
    ...(input.merchandising?{merchandising:readMerchandising(input.merchandising)!}:{}),
    ...(input.servingPrior?{servingPrior:Object.freeze({...input.servingPrior})}:{}),
    ...(input.acceptedCatalog?{acceptedCatalog:Object.freeze({...input.acceptedCatalog})}:{}),
    ...(Object.hasOwn(input,'semanticSearch')?{semanticSearch:Object.freeze({...input.semanticSearch!,
      ...(input.semanticSearch?.derivedCatalog?{derivedCatalog:Object.freeze({...input.semanticSearch.derivedCatalog})}:{})})}:{}),
    ...(Object.hasOwn(input,'publicAnalytics')?{publicAnalytics:Object.freeze({...input.publicAnalytics!})}:{})});
}
function searchVars(config:PublicationConfig){
  return{SEMANTIC_SEARCH_ENABLED:String(Object.hasOwn(config,'semanticSearch')&&config.semanticSearch!.enabled)};
}
export type PublicationWorkspace=RunWorkspace;
export type { PublicationControl } from './run-workspace.ts';
export interface PublicationCommand { file:string;args:string[];cwd:string;env:NodeJS.ProcessEnv;timeoutMs:number }
// A separate READ-only sender never receives upload/activation dispatches.
type Dependencies={fetch?:typeof fetch;observationFetch?:typeof fetch;command?:(command:PublicationCommand)=>Promise<void>;now?:()=>Date};
export type PublicationResult={state:'pending';owner:MutationOwner;errorCode:string}|{
  state:'published';owner:null;releaseId:string;receiptSha256:string;receipt:Record<string,unknown>;
};
/** A trusted operator's actual retained bridge ledger/log + one independently
 * measured metadata session. Registered bytes are pinned BEFORE approval; this
 * does not claim recovery of the old sanitized/omitted POST body. */
export interface ReviewedUploadRetryEvidence {
  schemaVersion:1;kind:'metadata-only-session-failure';logSha256:string;
  requests:{kind:'service'|'secrets'|'assets-upload-session';requestSha256:string;settlement:'known'|'unknown'}[];
  assetContentRequests:0;versionPosts:0;
  diagnostic:{intentSha256:string;resultSha256:string;bodySha256:string;requestSha256:string;status:200;totalBytes:number;
    buckets:number;hashes:number;maxJwtLength:number;errorClass:null};
}
type RetryRecord={schemaVersion:1;approval:ReviewedUploadActivationApproval;evidence:ArtifactRef;oldPending:ArtifactRef;oldReview:ArtifactRef;
  owner:MutationOwner;control:PublicationControl;original:ReviewedUploadActivationInput['original'];priorApproval?:ReviewedUploadActivationApprovalV1;transport?:{previous:ArtifactRef}};
async function reviewedEvidence(value:unknown,config:PublicationConfig,w:RunWorkspace,pending:ArtifactRef,review:ArtifactRef,approval:ReviewedUploadActivationApproval,transport?:{previous:ArtifactRef},control?:PublicationControl) {
  if(approval.schemaVersion===5){
    if(!control||transport||canonicalJson(value)!==canonicalJson(await assetUploadRetryEvidence(w,control,approval.checkpointSha256,approval.attempt)))
      throw new Error('publication_upload_retry_evidence_invalid');
    return;
  }
  if(transport){
    const e=value as ReadOnlyTransportEvidence;
    if(approval.schemaVersion!==4||!exact(transport,'previous')||e?.schemaVersion!==3||e.kind!=='read-only-transport-failure'
      ||e.checkpointSha256!==approval.checkpointSha256||!sameRef(e.previous,transport.previous)
      ||canonicalJson(await readOnlyTransportEvidence(w,transport.previous,e.journal?.through))!==canonicalJson(e))
      throw new Error('publication_upload_retry_evidence_invalid');
    return;
  }
  if(approval.schemaVersion===4){
    const e=value as ReadOnlyUploadEvidence;
    if(e?.schemaVersion!==2||e.kind!=='read-only-preflight-failure'||e.checkpointSha256!==approval.checkpointSha256||!e.journal?.through
      ||canonicalJson(await readOnlyUploadEvidence(w,pending,review,e.journal.through))!==canonicalJson(e))
      throw new Error('publication_upload_retry_evidence_invalid');
    return;
  }
  const e=value as ReviewedUploadRetryEvidence,d=e?.diagnostic,base=`https://api.cloudflare.com/client/v4/accounts/${config.accountId}`;
  if(!e||!exact(e,'assetContentRequests,diagnostic,kind,logSha256,requests,schemaVersion,versionPosts')||e.schemaVersion!==1
    ||e.kind!=='metadata-only-session-failure'||!HASH.test(e.logSha256)||e.assetContentRequests!==0||e.versionPosts!==0
    ||!Array.isArray(e.requests)||e.requests.length!==3||e.requests.some((r,i)=>!exact(r,'kind,requestSha256,settlement')
      ||r.kind!==['service','secrets','assets-upload-session'][i]||r.settlement!==(i===2?'unknown':'known')||!HASH.test(r.requestSha256))
    ||e.requests[0].requestSha256!==sha256(`GET${base}/workers/services/${config.workerName}`)
    ||e.requests[1].requestSha256!==sha256(`GET${base}/workers/scripts/${config.workerName}/secrets`)
    ||!d||!exact(d,'bodySha256,buckets,errorClass,hashes,intentSha256,maxJwtLength,requestSha256,resultSha256,status,totalBytes')
    ||![d.bodySha256,d.intentSha256,d.requestSha256,d.resultSha256].every(v=>typeof v==='string'&&HASH.test(v))
    ||d.requestSha256===e.requests[2].requestSha256||d.status!==200||d.errorClass!==null
    ||!Number.isSafeInteger(d.totalBytes)||d.totalBytes<=512*1024||d.totalBytes>2*1024*1024
    ||![d.buckets,d.hashes,d.maxJwtLength].every(n=>Number.isSafeInteger(n)&&n>0)||d.buckets>d.hashes||d.hashes>20_000||d.maxJwtLength>d.totalBytes)
    throw new Error('publication_upload_retry_evidence_invalid');
}
const packageFiles=['asset-manifest.json','catalog.snapshot.json','release-context.json','release-identity.json','site-identity.json','feed-plan.json'];
async function privateBytes(file:string,max=32*1024*1024){
  const before=await fs.lstat(file);
  if(!before.isFile()||before.uid!==process.getuid?.()||before.nlink!==1||(before.mode&0o777)!==0o600||before.size>max
    ||await fs.realpath(file)!==path.resolve(file))throw new Error('publication_package_invalid');
  const handle=await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const opened=await handle.stat();if(opened.ino!==before.ino||opened.dev!==before.dev)throw new Error('publication_package_changed');
    const chunks:Buffer[]=[];let length=0;
    for(;;){const chunk=Buffer.alloc(Math.min(64*1024,max+1-length));const part=await handle.read(chunk);
      if(!part.bytesRead)break;length+=part.bytesRead;if(length>max)throw new Error('publication_package_bound');chunks.push(chunk.subarray(0,part.bytesRead));}
    const bytes=Buffer.concat(chunks);const after=await fs.lstat(file);
    if(after.ino!==before.ino||after.dev!==before.dev||after.nlink!==1||after.size!==before.size||after.mtimeMs!==before.mtimeMs
      ||after.ctimeMs!==before.ctimeMs||bytes.length>max)throw new Error('publication_package_changed');return bytes;
  }finally{await handle.close();}
}
async function privateDirectories(directory:string,boundary:string){
  if(!directory.startsWith(`${boundary}${path.sep}`)&&directory!==boundary)throw new Error('publication_package_invalid');
  for(let current=directory;;current=path.dirname(current)){
    const stat=await fs.lstat(current);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o777)!==0o700
      ||await fs.realpath(current)!==current)throw new Error('publication_package_invalid');if(current===boundary)break;
  }
}
async function write(file:string,value:string|Uint8Array){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  if(await fs.realpath(path.dirname(file))!==path.resolve(path.dirname(file)))throw new Error('publication_package_invalid');
  let handle;
  try{handle=await fs.open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
  catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||!(await privateBytes(file)).equals(Buffer.from(value)))throw new Error('publication_package_changed');return;}
  try{await handle.writeFile(value);await handle.sync();}finally{await handle.close();}
  if(!(await privateBytes(file)).equals(Buffer.from(value)))throw new Error('publication_package_changed');
}
async function json(file:string,max=32*1024*1024){return JSON.parse((await privateBytes(file,max)).toString('utf8'));}
async function files(directory:string){const entries=await fs.readdir(directory,{recursive:true,withFileTypes:true});
  if(entries.some(e=>!e.isFile()&&!e.isDirectory()))throw new Error('publication_package_invalid');
  return entries.filter(e=>e.isFile()).map(e=>path.relative(directory,path.join(e.parentPath,e.name)).split(path.sep).join('/')).sort();}
async function inventory(directory:string){const names=await files(directory);let bytes=0;
  // Count actual files, including private package metadata, within the same
  // conservative Free asset bound already enforced by the static assembler.
  if(names.length>CLOUDFLARE_ASSET_LIMIT)throw new Error('publication_package_bound');const hashes:Record<string,string>={};
  for(const name of names){const file=path.join(directory,name);await privateDirectories(path.dirname(file),directory);
    const body=await privateBytes(file);bytes+=body.length;
    if(bytes>384*1024*1024)throw new Error('publication_package_bound');hashes[name]=sha256(body);}
  return hashes;}
export { inventory as inventoryPublicationPackage };
const safePath=(name:string)=>name.startsWith('/')&&!name.includes('\\')&&!name.split('/').some(part=>part==='.'||part==='..')&&!name.includes('\0');
function childEnv():NodeJS.ProcessEnv{return{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:process.env.TMPDIR,
  CI:'true',NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED:'false',WRANGLER_SEND_METRICS:'false'};}
function publicAnalyticsEnv(config:PublicationConfig):Record<string,string>{
  const policy=Object.hasOwn(config,'publicAnalytics')?config.publicAnalytics:undefined;
  return config.environment==='production'&&policy?.enabled?{NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED:'true',
    NEXT_PUBLIC_POSTHOG_KEY:policy.posthogKey,NEXT_PUBLIC_POSTHOG_HOST:policy.posthogHost}:{};
}
async function commandDefault(command:PublicationCommand){
  // Build/cache/package copies are private from their first byte, including
  // subprocess-created Next/Wrangler files. Positional args never enter shell source.
  try{await promisify(execFile)('/bin/sh',['-c','umask 077; exec "$@"','publication',command.file,...command.args],
    {cwd:command.cwd,env:command.env,timeout:command.timeoutMs,maxBuffer:1024*1024});}
  catch{throw new Error('publication_command_unknown');} // Never log stdout/stderr/provider errors.
}

/** Paged whole-catalog checks need a job-sized window, not a single-request
 * timeout. Individual D1 requests remain bounded and original deadlines win. */
export async function withPublicationInventorySignal<T>(routineCare:boolean,remaining:number,check:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(remaining<=0)throw new Error('publication_upload_retry_cutoff');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(routineCare?900_000:120_000,remaining));
  try{return await check(controller.signal);}finally{clearTimeout(timer);}
}

/** No retries, redirects or uncertain-write replay in this REST client. The API
 * budget is per invocation. Wrangler separately retries asset/immutable VERSION
 * upload internally; duplicate matching versions are ambiguous, never activated.
 */
function provider(config:PublicationConfig,token:string,send:typeof fetch,identityAuthorization?:string,observationSend=send,readTimeoutMs=2500){
  if(!token||token.length>4096||/[^\x21-\x7e]/.test(token)
    ||identityAuthorization!==undefined&&(identityAuthorization.length>4096||/[\r\n]/.test(identityAuthorization)))throw new Error('publication_credentials_invalid');
  const base=`https://api.cloudflare.com/client/v4/accounts/${config.accountId}`;let calls=0;
  async function request(url:string,body?:unknown,identity=false,allow404=false,signal?:AbortSignal):Promise<unknown>{
    signal?.throwIfAborted();
    const readSend=signal&&body===undefined?observationSend:send;
    if(++calls>100)throw new Error('publication_provider_bound');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let sent:Promise<Response>|undefined,pending:Promise<unknown>|undefined,cancellation:Promise<unknown>|undefined,rejectAbort:(error:Error)=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const abort=()=>{controller.abort();cancellation??=reader?.cancel().catch(()=>{});rejectAbort(new Error());};
    signal?.addEventListener('abort',abort,{once:true});
    try{pending=(async()=>{const response=await(sent=readSend(url,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,
      headers:identity?{...(identityAuthorization?{Authorization:identityAuthorization}:{}), 'Cache-Control':'no-cache'}:
        {Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}));
      if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new Error();}
      if(response.status===404&&allow404){await response.body?.cancel();return null;}
      if(!response.ok||!response.body)throw new Error();reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>512*1024){await reader.cancel();throw new Error();}chunks.push(part.value);}}finally{reader.releaseLock();}
      const raw=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(identity)return raw;if(!raw||raw.success!==true||!Object.hasOwn(raw,'result'))throw new Error();return raw.result;
    })();return await Promise.race([pending,aborted,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort();reject(new Error());},body===undefined?readTimeoutMs:2500);})]);
    }catch{throw new Error(body===undefined?'publication_provider_unavailable':'publication_activation_unknown');}
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(controller.signal.aborted&&pending&&(body===undefined||isAccountedPublicationFetch(readSend))){
      if(isAccountedPublicationFetch(readSend)&&sent)await sent.catch(()=>{});
      await drainDeploymentObservation(Promise.allSettled([pending,cancellation]));}}
  }
  const script=`${base}/workers/scripts/${config.workerName}`;
  return{
    async check(){const database=await request(`${base}/d1/database/${config.database.id}`) as Record<string,unknown>;
      const vector=await request(`${base}/vectorize/v2/indexes/${config.indexName}`) as {name?:unknown;config?:{dimensions?:unknown;metric?:unknown}};
      if(database?.uuid!==config.database.id||database.name!==config.database.name
        ||(database.read_replication as {mode?:unknown})?.mode!=='disabled'||vector?.name!==config.indexName
        ||vector.config?.dimensions!==1536||vector.config.metric!=='cosine')throw new Error('publication_provider_identity_mismatch');
      if(config.semanticSearch?.derivedCatalog){
        const name=config.semanticSearch.derivedCatalog.indexName;
        const derived=await request(`${base}/vectorize/v2/indexes/${name}`) as {name?:unknown;config?:{dimensions?:unknown;metric?:unknown}};
        if(derived?.name!==name||derived.config?.dimensions!==DERIVED_SEARCH_PROFILE.dimensions||derived.config.metric!=='cosine')
          throw new Error('publication_provider_identity_mismatch');
      }},
    async version(id:string){if(!UUID.test(id))throw new Error('publication_version_invalid');return await request(`${script}/versions/${id}`) as Record<string,unknown>;},
    async findVersion(marker:string){const found:string[]=[];
      for(let page=1;page<=10;page++){const result=await request(`${script}/versions?page=${page}&per_page=10`) as {items?:{id:string}[]};
        if(!Array.isArray(result?.items)||result.items.length>10)throw new Error('publication_provider_invalid');
        for(const item of result.items){if(!UUID.test(item.id))throw new Error('publication_provider_invalid');
          const version=await this.version(item.id);if((version.annotations as Record<string,unknown>)?.['workers/tag']===marker)found.push(item.id);}
        if(result.items.length<10){if(found.length>1)throw new Error('publication_version_ambiguous');return found[0]??null;}}
      throw new Error('publication_version_lookup_bound');},
    async deployed(signal?:AbortSignal){const result=await request(`${script}/deployments`,undefined,false,true,signal) as {deployments?:unknown[]}|null;
      if(result===null)return null;if(!Array.isArray(result?.deployments))throw new Error('publication_provider_invalid');
      const value=result.deployments[0] as {id?:string;versions?:{version_id:string;percentage:number}[];annotations?:Record<string,unknown>}|undefined;
      if(!value)return null;if(!UUID.test(value.id??'')||!Array.isArray(value.versions)||value.versions.length!==1
        ||value.versions[0].percentage!==100||!UUID.test(value.versions[0].version_id))throw new Error('publication_deployment_not_settled');
      return{id:value.id!,version:value.versions[0].version_id,marker:value.annotations?.['workers/message']};},
    async identity(signal?:AbortSignal){return await request(`${config.identityOrigin}/.well-known/catalog-release.json`,undefined,true,false,signal);},
    async activate(version:string,marker:string){const result=await request(`${script}/deployments`,{strategy:'percentage',
      versions:[{version_id:version,percentage:100}],annotations:{'workers/message':marker}}) as {id?:string};
      if(!UUID.test(result?.id??''))throw new Error('publication_activation_unknown');return result.id!;},
  };
}

function identity(intent:PublicationIntent,versionReference:string):DeploymentIdentity{return{releaseId:intent.releaseId,codeSha:intent.codeSha,
  catalogRevision:intent.catalogRevision,catalogSnapshotSha256:intent.catalogSnapshotSha256,manifestSha256:intent.manifestSha256,versionReference};}
function matchesIdentity(raw:unknown,intent:PublicationIntent){return canonicalJson(raw)===canonicalJson({release_id:intent.releaseId,code_sha:intent.codeSha,
  catalog_revision:intent.catalogRevision,catalog_snapshot_sha256:intent.catalogSnapshotSha256,manifest_sha256:intent.manifestSha256});}
function verifyUploadedVersion(value:Record<string,unknown>,config:PublicationConfig,version:string,control:PublicationControl){
  const resources=value.resources as {bindings?:Record<string,unknown>[];script_runtime?:{compatibility_date?:unknown}}|undefined;
  const bindings=resources?.bindings;
  if(value.id!==version||!Array.isArray(bindings)||bindings.length>100||resources?.script_runtime?.compatibility_date!==config.compatibilityDate
    ||(value.annotations as Record<string,unknown>)?.['workers/tag']!==control.uploadMarker
    ||(value.annotations as Record<string,unknown>)?.['workers/message']!==`package:${control.packageSha256}`)throw new Error('publication_version_mismatch');
  const named=new Map(bindings.map(binding=>[binding.name,binding]));
  const expectedSearch=searchVars(config);
  const derivedIndex=config.semanticSearch?.derivedCatalog?.indexName;
  if(named.size!==bindings.length||named.get('DB')?.type!=='d1'||named.get('DB')?.id!==config.database.id
    ||named.get('VECTORIZE')?.type!=='vectorize'||named.get('VECTORIZE')?.index_name!==config.indexName||named.get('ASSETS')?.type!=='assets'
    ||named.get('ENVIRONMENT')?.type!=='plain_text'||named.get('ENVIRONMENT')?.text!==config.environment
    ||Object.entries(expectedSearch).some(([name,text])=>named.get(name)?.type!=='plain_text'||named.get(name)?.text!==text)
    ||(derivedIndex?named.get('SEMANTIC_VECTORIZE')?.type!=='vectorize'||named.get('SEMANTIC_VECTORIZE')?.index_name!==derivedIndex
      :named.has('SEMANTIC_VECTORIZE'))
    ||config.environment==='staging'&&named.get('STAGING_AUTH_SECRET')?.type!=='secret_text')throw new Error('publication_version_scope_mismatch');
}

export async function verifyPublicationSemanticCatalog(manifest:Pick<SiteAssetManifest,'semanticCatalog'>,config:PublicationConfig){
  const derived=config.semanticSearch?.derivedCatalog;
  if(!derived){if(Object.hasOwn(manifest,'semanticCatalog'))throw new Error('publication_semantic_catalog_unconfigured');return;}
  const catalog=await verifySemanticCatalogIdentities(manifest.semanticCatalog);
  if(catalog.indexName!==derived.indexName||sha256(canonicalJson(catalog))!==derived.sha256)
    throw new Error('publication_semantic_catalog_changed');
}

async function loadPackage(directory:string,config:PublicationConfig,expectedHash:string,now:Date,settlement?:ActivationPermit){
  const hashes=await inventory(directory);if(sha256(canonicalJson(hashes))!==expectedHash)throw new Error('publication_package_changed');
  const bytes=await privateBytes(path.join(directory,'asset-manifest.json'));const manifest=JSON.parse(bytes.toString()) as SiteAssetManifest;
  const snapshot=validateCatalogSnapshot(await json(path.join(directory,'catalog.snapshot.json')),now);const context=await json(path.join(directory,'release-context.json'));
  verifyReleaseIdentity(bytes,await json(path.join(directory,'release-identity.json')));
  await verifyPublicationSemanticCatalog(manifest,config);
  if(manifest.releaseId!==config.releaseId||manifest.codeSha!==config.codeSha||manifest.sourceMode!==config.sourceMode||manifest.dataKind!=='catalog'
    ||sha256(await privateBytes(path.join(directory,'catalog.snapshot.json')))!==manifest.catalogSnapshotSha256
    ||manifest.nextExpiry!==null&&manifest.nextExpiry<=now.toISOString())throw new Error('publication_package_unready');
  verifyReleaseContext(context,manifest,snapshot,config.codeSha,now);
  // This exact package passed semantic verification BEFORE its upload. Newer
  // controller code must not regenerate an activated permanent release's feed
  // or routing rules. Its original immutable bytes remain fully hash-bound;
  // current deployment/native/source proof still gates receipt completion.
  const permanentSettlement=settlement?.releaseId===manifest.releaseId&&manifest.nextExpiry===null
    &&snapshot.products.every(product=>product.eligibleUntil===null);
  const siteBytes=await privateBytes(path.join(directory,'site-identity.json'));
  if(permanentSettlement){if(sha256(siteBytes)!==manifest.siteIdentitySha256)throw new Error('publication_package_changed');}
  else{verifySiteIdentity(siteBytes,manifest);verifyFeedPlan(snapshot,manifest.catalogSnapshotSha256,await json(path.join(directory,'feed-plan.json')));}
  const assets=new Map<string,Uint8Array>();
  for(const [name,hash] of Object.entries(manifest.checksums)){
    if(!safePath(name)||hashes[`assets${name}`]!==hash)throw new Error('publication_package_changed');assets.set(name,await privateBytes(path.join(directory,'assets',name.slice(1))));}
  if(Object.keys(hashes).filter(name=>name.startsWith('assets/')).length!==assets.size)throw new Error('publication_package_changed');
  if(!permanentSettlement){const prior=await readPriorRelease(context,config.prior?.directory??undefined);verifyRetainedAssets(snapshot,assets,manifest,context,prior);}
  return{manifest,snapshot,context,bytes};
}
export {loadPackage as readPublicationPackage};
function intentFrom(manifest:SiteAssetManifest,bytes:Uint8Array):PublicationIntent{return{releaseId:manifest.releaseId,codeSha:manifest.codeSha,catalogRevision:manifest.catalogRevision,
  catalogSnapshotSha256:manifest.catalogSnapshotSha256,manifestSha256:sha256(bytes),vectorSyncWatermark:manifest.vectorSyncWatermark,
  priorReleaseId:manifest.priorReleaseId,nextExpiry:manifest.nextExpiry};}

/** Actual Node composition. Test seams replace only command/HTTP/clock, never
 * publication predicates. Ambiguous external steps are reconciled, not resent.
 * Credentials never enter checkpoints, artifacts, command args or returned errors.
 */
export async function executePublication(options:{db:CatalogD1&{providerIdentity:string};owner:MutationOwner;revision:PrunedRevision|null;published?:PublishedCatalogRead;permanent?:PermanentCatalogRevision;approvedCatalog?:ApprovedCohortRevision;requestId:string;runReference:string;
  acceptedCatalog?:AcceptedCodeOnlyRead|AcceptedCodeOnlyControl;
  workspace:PublicationWorkspace;config:PublicationConfig;credentials:{cloudflareToken:string;identityAuthorization?:string};dependencies?:Dependencies;buildRecovery?:BuildRecoveryApproval;
  acceptedReceiptOnly?:true;
  finishAuthorization?:ReviewedUploadActivationInput['finishAuthorization'];
  routineCare?:boolean;
  reviewedUploadRetry?:{approval:ReviewedUploadActivationApproval;evidence:ArtifactRef;priorApproval?:ReviewedUploadActivationApprovalV1;transport?:{previous:ArtifactRef}}}):Promise<PublicationResult>{
  const {db,workspace,revision}=options;const config=validatePublicationConfig(options.config);const now=options.dependencies?.now??(()=>new Date());
  const serving=options.acceptedCatalog;
  if(Boolean(config.acceptedCatalog)!==Boolean(serving))throw Error('publication_accepted_catalog_invalid');
  if(serving){
    assertAcceptedCodeOnlyBinding(serving);
    if(options.published||options.permanent||options.approvedCatalog||canonicalJson(revision)!==canonicalJson(serving.revision)
      ||options.owner.operationKey!==acceptedCodeOnlyOperationKey(serving.authority)
      ||options.requestId!==sha256(encodeBuildRequest(serving.authority.request))
      ||canonicalJson(config.acceptedCatalog)!==canonicalJson({...serving.authority.publication,sealSha256:serving.authority.sealSha256})
      ||serving.authority.request.codeSha!==config.codeSha||serving.authority.request.environment!==config.environment
      ||config.servingPrior?.catalogRevision!==serving.authority.request.sourceRevision
      ||config.servingPrior.catalogSnapshotSha256!==serving.authority.request.sourceDigest)throw Error('publication_accepted_catalog_invalid');
  }
  if(options.buildRecovery)encodeBuildRecoveryApproval(options.buildRecovery);
  const reviewed=options.reviewedUploadRetry;
  if(options.finishAuthorization&&!reviewed?.transport&&!options.approvedCatalog?.persistent)throw new Error('publication_finish_authorization_invalid');
  const routine=reviewed?.approval.schemaVersion===5?`publicationUploadRoutine${reviewed.approval.attempt}`:null;
  const pendingLabel=routine?`${routine}Pending`:reviewed?.transport?'publicationUploadTransportPending':'publicationUploadRetryPending';
  const ackLabel=routine?`${routine}Acknowledged`:reviewed?.transport?'publicationUploadTransportAcknowledged':'publicationUploadRetryAcknowledged';
  if(reviewed)encodeReviewedUploadActivationApproval(reviewed.approval);
  if(options.permanent&&(options.published||!revision||canonicalJson(options.permanent)!==canonicalJson(revision))
    ||revision?.nativePreservation&&!options.permanent)throw new Error('publication_permanent_input_invalid');
  if(options.approvedCatalog&&(options.permanent||options.published||!revision||canonicalJson(options.approvedCatalog)!==canonicalJson(revision)))
    throw new Error('publication_approved_input_invalid');
  if(revision?.nativeHistory&&!serving&&(!options.approvedCatalog?.persistent
    ||canonicalJson(revision.nativeHistory)!==canonicalJson(options.approvedCatalog.persistent.nativeHistory)))
    throw new Error('publication_approved_input_invalid');
  if(db.providerIdentity!==`cloudflare:${config.accountId}:${config.database.id}`)throw new Error('publication_database_scope_mismatch');
  await workspace.assertHeld();await workspace.assertScope({accountId:config.accountId,environment:config.environment,databaseId:config.database.id,
    databaseName:config.database.name,workerName:config.workerName,indexName:config.indexName});
  const execution=workspace.execution;
  if((execution?.effective.codeSha??workspace.manifest.codeSha)!==config.codeSha
    ||(execution?.effective.sourceRoot??workspace.repository)!==await fs.realpath(config.sourceRoot)
    ||execution&&execution.effective.publicationConfigSha256!==sha256(canonicalJson(config)))throw new Error('publication_workspace_mismatch');
  const observationSend=options.dependencies?.observationFetch??options.dependencies?.fetch??fetch;
  const api=provider(config,options.credentials.cloudflareToken,options.dependencies?.fetch??fetch,options.credentials.identityAuthorization,observationSend,10_000);
  const command=options.dependencies?.command??commandDefault;const configSha256=sha256(canonicalJson(config));
  let checkpoint=await workspace.readCheckpoint({controlOnly:true});let control=checkpoint?.checkpoint.control?.publication;
  const requestBudget=await workspace.publicationRequestBudget?.();
  let continuation=requestBudget&&options.approvedCatalog?.persistent&&revision?.snapshot.products.every(p=>p.eligibleUntil===null)
    ?{approvalReference:requestBudget.approvalReference,approvedAt:requestBudget.approvedAt,publicationUntil:requestBudget.publicationUntil}:undefined;
  if(options.finishAuthorization&&!reviewed){
    const f=options.finishAuthorization,grant=await workspace.publicationFinishBudget?.();
    if(!control||!grant||grant.approvalReference!==f.authorizationSha256||grant.versionReference!==control.versionReference
      ||!checkpoint?.checkpoint.pins.publicationUploadAcknowledged||checkpoint.checkpoint.pins.publicationUploadReview
      ||!revision?.snapshot.products.every(p=>p.eligibleUntil===null))throw new Error('publication_finish_authorization_invalid');
    validatePublicationFinishAuthority(f,control.build.request.cutoff,control.versionReference!);
    continuation={approvalReference:f.authorizationSha256,approvedAt:f.reviewedAt,publicationUntil:f.activationDeadline};
  }
  let owner=options.owner;const directory=path.join(workspace.directory,'packages',config.releaseId);
  // Preserve the original failed command's logs/output byte-for-byte. The
  // continuation remains inside the already registered retention directory.
  const runtime=path.join(workspace.directory,'publication-runtime',config.releaseId,...(reviewed?.approval.schemaVersion===5?[`routine-retry-${reviewed.approval.attempt}`]:reviewed?.transport?['read-only-transport']:reviewed?.approval.schemaVersion===4?['read-only-retry']:[]));
  const uploadBinding=()=>({schemaVersion:1,releaseId:config.releaseId,requestId:options.requestId,configSha256,
    packageSha256:control!.packageSha256,uploadMarker:control!.uploadMarker});
  let retryRecord:RetryRecord|undefined,activationDeadline:string|undefined;
  if(continuation)activationDeadline=continuation.publicationUntil;
  const retryAck=(pending:ArtifactRef)=>({schemaVersion:1,approval:reviewed!.approval,evidence:reviewed!.evidence,pending,
    oldPending:checkpoint!.checkpoint.pins.publicationUploadPending,oldReview:checkpoint!.checkpoint.pins.publicationUploadReview,upload:uploadBinding(),
    ...(reviewed!.transport?{transport:reviewed!.transport}:{})});
  const runUpload=()=>command({file:process.execPath,args:['node_modules/wrangler/bin/wrangler.js','versions','upload','--config',path.join(directory,'wrangler.json'),
    '--outdir',path.join(runtime,'bundle'),'--tag',control!.uploadMarker,'--message',`package:${control!.packageSha256}`],cwd:config.sourceRoot,
    env:{...childEnv(),TMPDIR:path.join(runtime,'tmp'),CLOUDFLARE_ACCOUNT_ID:config.accountId,CLOUDFLARE_API_TOKEN:options.credentials.cloudflareToken,
      WRANGLER_LOG_PATH:path.join(runtime,'logs'),WRANGLER_OUTPUT_FILE_PATH:path.join(runtime,'upload.ndjson')},timeoutMs:900_000});
  const save=async(patch:Partial<PublicationControl>,nextOwner=owner,appendPins?:Record<string,ArtifactRef>)=>{
    await workspace.assertHeld();control={...control!,...patch};owner=nextOwner;
    // Read normal state only before activation; control-only settlement must not
    // turn expired merchant artifacts back into usable content.
    const view=await workspace.readCheckpoint({controlOnly:true});if(!view)throw new Error('publication_checkpoint_missing');
    if(options.finishAuthorization&&!reviewed||view.checkpoint.control?.publication?.permit||control.permit&&view.checkpoint.control?.publication?.stage==='activating'){
      if(appendPins)throw new Error('publication_upload_review_required');
      await workspace.writeControlCheckpoint(view.sha256,{phase:'attention',owner,control:{publication:control}});
    }else{
      const current=await workspace.readCheckpoint();if(!current)throw new Error('publication_checkpoint_missing');
      const state=current.checkpoint.state;
      if(!state||typeof state!=='object'||Array.isArray(state))throw new Error('publication_checkpoint_invalid');
      await workspace.writeCheckpoint(current.sha256,{...current.checkpoint,phase:'publishing',owner,
        ...(appendPins?{pins:{...current.checkpoint.pins,...appendPins}}:{}),
        state:JSON.parse(JSON.stringify({...state,publication:control})),control:{publication:control}});
    }
    checkpoint=await workspace.readCheckpoint({controlOnly:true});
  };
  try{
    if(serving&&!revision){
      // A resolved CAS may have committed after its response was lost. This
      // body-free replay can ONLY reach the existing exact resolved return.
      const finished=control&&(await db.prepare('SELECT state,lease_token,run_reference,release_id,version_reference FROM catalog_build_requests WHERE request_id=?')
        .bind(control.requestId).all<Record<string,unknown>>()).results[0];
      if(!control?.permit||control.stage!=='published'||!control.receiptSha256||finished?.state!=='resolved'
        ||control.permit.mutationOwner?.operationKey!==acceptedCodeOnlyOperationKey(serving.authority)
        ||finished.lease_token!==control.build.token||finished.run_reference!==control.runReference
        ||finished.release_id!==config.releaseId||finished.version_reference!==control.versionReference)throw Error('publication_serving_settlement_scope');
    }
    if(options.acceptedReceiptOnly&&(revision!==null||!control?.permit||control.intent?.nextExpiry!==null
      ||!options.finishAuthorization||!reviewed?.transport||await workspace.budgetRowsReadCeiling()===null))
      throw new Error('publication_receipt_settlement_scope');
    if(!HASH.test(options.requestId)||!/^[a-zA-Z0-9._:/-]{1,200}$/.test(options.runReference))throw new Error('publication_input_invalid');
    if(control&&(control.configSha256!==configSha256||control.requestId!==options.requestId||control.runReference!==options.runReference))throw new Error('publication_checkpoint_mismatch');
    // A rejected protected upload is an operator-review gate, not an uncertain
    // ordinary CLI exit. Its body-free pin survives content expiry and prevents
    // a later uploading-stage resume from bypassing scope/accounting refusal.
    if(checkpoint?.checkpoint.pins.publicationUploadReview&&!reviewed)throw new Error('publication_upload_review_required');
    if(checkpoint?.checkpoint.pins.buildOperatorRecoveryPending&&control?.stage==='built'&&!options.buildRecovery)
      throw new Error('publication_build_recovery_fenced');
    const pendingUpload=checkpoint?.checkpoint.pins.publicationUploadPending,acknowledgedUpload=checkpoint?.checkpoint.pins.publicationUploadAcknowledged;
    if(reviewed){
      const a=reviewed.approval,pins=checkpoint?.checkpoint.pins,marker=pins?.[pendingLabel],ack=pins?.[ackLabel];
      if(reviewed.transport){
        if(a.schemaVersion!==4||!pins||!exact(reviewed.transport,'previous')||!sameRef(pins.publicationUploadRetryPending,reviewed.transport.previous)
          ||pins.publicationUploadRetryAcknowledged)throw new Error('publication_upload_review_required');
        if(!control?.permit){
          const prior=await workspace.readArtifact(reviewed.transport.previous) as unknown as RetryRecord;
          if(prior.approval.schemaVersion!==4||prior.transport||prior.approval.authorizationSha256!==a.authorizationSha256
            ||prior.approval.reviewedAt>=a.reviewedAt||canonicalJson(prior.owner)!==canonicalJson(owner)
            ||canonicalJson({...prior.control,stage:control?.stage,versionReference:control?.versionReference})!==canonicalJson(control))
            throw new Error('publication_upload_retry_fenced');
        }
      }
      if(!control||!checkpoint||!pins?.publicationUploadReview||!pendingUpload||acknowledgedUpload||options.buildRecovery
        ||a.requestId!==control.requestId||a.packageSha256!==control.packageSha256||a.configSha256!==configSha256
        ||a.reviewPinSha256!==pins.publicationUploadReview.sha256||a.evidenceSha256!==reviewed.evidence.sha256
        ||pendingUpload.sha256!==sha256(canonicalJson(uploadBinding()))||!isAccountedPublicationUploadCommand(command)
        ||marker&&(!ack||ack.sha256!==sha256(canonicalJson(retryAck(marker))))||!marker&&ack)
        throw new Error('publication_upload_review_required');
      activationDeadline=await reviewedUploadActivationDeadline(a,control.build.request.cutoff,reviewed.priorApproval);
      if(options.finishAuthorization){
        const f=options.finishAuthorization;
        validatePublicationFinishAuthority(f,control.build.request.cutoff,control.versionReference??'');
        if(!reviewed.transport||!marker||!ack||!control.versionReference||f.versionReference!==control.versionReference
          ||f.reviewedAt<control.build.request.cutoff||f.reviewedAt>now().toISOString()||f.activationDeadline<=f.reviewedAt
          ||Date.parse(f.activationDeadline)-Date.parse(f.reviewedAt)>2*3600000
          ||f.activationDeadline>workspace.manifest.retention.rules.publication.notAfter)throw new Error('publication_finish_authorization_invalid');
        activationDeadline=f.activationDeadline;
      }
      if((a.schemaVersion===3||a.schemaVersion===4||a.schemaVersion===5)&&now().toISOString()<a.reviewedAt)throw new Error('publication_upload_retry_cutoff');
      if(!control.permit&&!marker&&now().toISOString()>=activationDeadline)throw new Error('publication_upload_retry_cutoff');
      // A marker without genuine command ACK is ALWAYS held before provider IO;
      // a visible version can never mint that acknowledgement on resume.
      if(!control.permit){
        const e=await workspace.readArtifact(reviewed.evidence);await reviewedEvidence(e,config,workspace,pendingUpload,pins.publicationUploadReview,a,reviewed.transport,control);
        if(!marker){
          if(control.stage!=='uploading'||checkpoint.sha256!==a.checkpointSha256||control.versionReference!==null||control.permit!==null
            ||control.deploymentId!==null||control.receiptSha256!==undefined||owner.phase!=='freezing')throw new Error('publication_upload_retry_fenced');
          const review=await workspace.readArtifact(pins.publicationUploadReview) as Record<string,unknown>;
          if((a.schemaVersion===5?!['publication_upload_unknown','publication_upload_command_failed'].includes(String(review.code)):
            review.code!==(a.schemaVersion===4?'publication_upload_command_failed':'publication_upload_unknown'))||review.requestId!==control.requestId||review.releaseId!==config.releaseId
            ||review.configSha256!==configSha256)throw new Error('publication_upload_retry_fenced');
        }else{
          retryRecord=await workspace.readArtifact(marker) as unknown as RetryRecord;
          if(!exact(retryRecord,`approval,control,evidence,oldPending,oldReview,original,owner,${[2,3].includes(a.schemaVersion)?'priorApproval,':''}schemaVersion${reviewed.transport?',transport':''}`)||retryRecord.schemaVersion!==1
            ||encodeReviewedUploadActivationApproval(retryRecord.approval)!==encodeReviewedUploadActivationApproval(a)
            ||canonicalJson(retryRecord.priorApproval??null)!==canonicalJson(reviewed.priorApproval??null)
            ||canonicalJson(retryRecord.transport??null)!==canonicalJson(reviewed.transport??null)
            ||canonicalJson(retryRecord.evidence)!==canonicalJson(reviewed.evidence)||canonicalJson(retryRecord.oldPending)!==canonicalJson(pendingUpload)
            ||canonicalJson(retryRecord.oldReview)!==canonicalJson(pins.publicationUploadReview)
            ||canonicalJson({...retryRecord.control,stage:control.stage,versionReference:control.versionReference})!==canonicalJson(control)
            ||canonicalJson(retryRecord.owner)!==canonicalJson(owner))throw new Error('publication_upload_retry_fenced');
        }
      }
    }
    // Old code pinned BEFORE preflight. Only this built-stage shape can prove
    // no CLI invocation; actual owner/build/package/D1/provider checks follow.
    const preflightPending=!!(pendingUpload&&!acknowledgedUpload&&control?.stage==='built'
      &&pendingUpload.sha256===sha256(canonicalJson(uploadBinding()))&&isAccountedPublicationUploadCommand(command));
    // Pins are append-only. A durable exact acknowledgement logically clears
    // pending; no artifact-body read (or new content rights) is needed on expiry.
    if(!reviewed&&!preflightPending&&(pendingUpload||acknowledgedUpload)&&(!control||!pendingUpload||!acknowledgedUpload
      ||pendingUpload.sha256!==sha256(canonicalJson(uploadBinding()))
      ||acknowledgedUpload.sha256!==sha256(canonicalJson({...uploadBinding(),pending:pendingUpload}))))
      throw new Error('publication_upload_review_required');
    if(config.prior===null){
      // Old first-deploy checkpoints may still need settlement. A local marker
      // alone cannot grant that exception or permission for a new activation.
      const historical=control&&(await db.prepare('SELECT state,lease_token,run_reference,release_id,version_reference FROM catalog_build_requests WHERE request_id=?')
        .bind(control.requestId).all<Record<string,unknown>>()).results[0];
      if(!control||!historical||!['activating','resolved'].includes(String(historical.state))
        ||control.build.request.priorReleaseId!==null||historical.lease_token!==control.build.token
        ||historical.run_reference!==control.runReference||historical.release_id!==config.releaseId
        ||!control.versionReference||historical.version_reference!==control.versionReference)throw new Error('publication_bootstrap_required');
    }
    await api.check();
    if(!control){
      if(!revision||owner.phase!=='freezing'||owner.environment!==config.environment||owner.indexName!==config.indexName)throw new Error('publication_revision_required');
      await db.batch([mutationAssertion(db,owner,['freezing'])]);
      let build;
      try{build=await claimBuildRequest(db,options.requestId,options.runReference,now(),options.approvedCatalog?.persistent?3600000:undefined);}catch{/* Recover only this exact persisted run's claim. */}
      if(!build){const row=(await db.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').bind(options.requestId).all<Record<string,unknown>>()).results[0];
        if(row?.state==='building'&&row.run_reference===options.runReference&&typeof row.lease_until==='string'&&row.lease_until>now().toISOString()){
          build={requestId:options.requestId,token:String(row.lease_token),runReference:options.runReference,leaseUntil:row.lease_until,
            request:JSON.parse(String(row.request_json))};
        }
      }
      if(!build)throw new Error('publication_build_not_claimed');
      if(build.request.codeSha!==config.codeSha||build.request.sourceRevision!==revision.snapshot.catalogRevision
        ||build.request.sourceDigest!==sha256(`${JSON.stringify(revision.snapshot)}\n`)||build.request.environment!==config.environment
        ||build.request.priorReleaseId!==(config.prior?.releaseId??null))throw new Error('publication_build_mismatch');
      const plan=prunedVectorPlan(revision);const marker=`catalog-${sha256(`${options.requestId}:${config.releaseId}`).slice(0,40)}`;
      control={schemaVersion:1,configSha256,requestId:options.requestId,runReference:options.runReference,stage:'claimed',build,
        publication:null,intent:null,permit:null,vectorPlan:{catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),
          ids:prunedVectorIds(plan)},packageSha256:null,uploadMarker:marker,
        versionReference:null,deploymentMarker:`${marker}-activate`,deploymentId:null};
      await save({});
    }
    // A lost activation-CAS response is recoverable ONLY for the exact claim.
    const actual=await readMutationOwner(db,owner);
    let buildRow=(await db.prepare("SELECT *,strftime('%Y-%m-%dT%H:%M:%fZ','now') observed_at FROM catalog_build_requests WHERE request_id=?")
      .bind(control.requestId).all<Record<string,unknown>>()).results[0];
    const verifyBuiltPackage=async()=>{
      const c=control!,sealed=await loadPackage(directory,config,c.packageSha256!,now()),request=c.build.request;
      if(!revision||sealed.manifest.catalogSnapshotSha256!==request.sourceDigest
        ||sealed.manifest.catalogRevision!==request.sourceRevision||sealed.manifest.priorReleaseId!==request.priorReleaseId
        ||sealed.manifest.vectorSyncWatermark!==revision.vectorSyncWatermark
        ||canonicalJson(sealed.snapshot)!==canonicalJson(revision.snapshot))throw new Error('publication_package_changed');
    };
    const vectorProof=async(signal?:AbortSignal)=>{
      if(!revision)throw new Error('publication_revision_required');
      // The accepted seal authenticates immutable native delivery bytes. An
      // unchanged global watermark/no-pending barrier under this sole owner is
      // sufficient for code-only reuse; do not download/rewrite the vectors.
      if(serving){signal?.throwIfAborted();const proof=await readAcceptedCodeOnlyCatalog({db,owner,seal:serving.seal,
        authority:serving.authority,runReference:options.runReference});signal?.throwIfAborted();return proof;}
      const adapters=createVectorizeRestAdapters({environment:config.environment,indexName:config.indexName,
        accountId:config.accountId,token:options.credentials.cloudflareToken,fetch:observationSend});
      if(options.permanent){
        return readPermanentNativeProof({db,owner,revision:options.permanent,adapters,signal});
      }
      if(options.published)return readPublishedCatalogVectors({db,owner,published:options.published,adapters,signal});
      // A routine same-package continuation has its own execution window.
      // Observe the original native proof without reapplying the expired
      // queueing cutoff; permanentProof still verifies the complete inventory
      // immediately before upload/activation under the unchanged owner.
      if(options.approvedCatalog?.persistent&&(options.finishAuthorization||continuation||reviewed?.approval.schemaVersion===5))
        return readOwnedPermanentCohortNative(db,owner,options.approvedCatalog,adapters);
      return 'approval' in revision.request?readOwnedApprovedCohortVectors(db,owner,revision as ApprovedCohortRevision,adapters):readOwnedPrunedVectors(db,owner,revision,adapters);
    };
    // Full-catalog scans are sequential owned D1 reads, not a short provider
    // observation. No proof survives this invocation or crosses an owner change.
    const permanentProof=async()=>{
      if(serving){await readAcceptedCodeOnlyCatalog({db,owner,seal:serving.seal,authority:serving.authority,runReference:options.runReference});return;}
      if(!options.permanent&&!options.approvedCatalog?.persistent)return;
      const remaining=control!.permit?(options.routineCare?900_000:120_000):Date.parse(activationDeadline??control!.build.request.cutoff)-now().getTime();
      await withPublicationInventorySignal(Boolean(options.routineCare),remaining,async signal=>{
        if(options.permanent)await assertPermanentCatalog(db,owner,options.permanent,control!.permit??undefined,signal);
        else await assertApprovedCatalogInventory(db,owner,options.approvedCatalog!,signal);
      }); // The concrete D1 sender joins its own ledger before returning.
    };
    const readPrior=async(signal:AbortSignal):Promise<DeploymentObservation>=>{
      signal.throwIfAborted();await workspace.assertHeld();signal.throwIfAborted();
      const deployed=await api.deployed(signal);signal.throwIfAborted();
      if(config.prior===null)throw new Error('publication_bootstrap_required');
      if(deployed?.version!==(config.servingPrior?.versionReference??config.prior.versionReference))throw new Error('publication_prior_changed');
      let prior:PublicationIntent;
      if(config.prior.directory!==null){
        const priorBytes=await fs.readFile(path.join(config.prior.directory,'asset-manifest.json'),{signal});signal.throwIfAborted();
        if(sha256(priorBytes)!==config.prior.manifestSha256)throw new Error('publication_prior_changed');
        prior=intentFrom(JSON.parse(priorBytes.toString()),priorBytes);
      }else{
        if((await publicationStatus(db,config.prior.releaseId,{signal})).state!=='published')throw new Error('publication_prior_changed');signal.throwIfAborted();
        const row=(await db.prepare('SELECT manifest_json FROM publication_receipts WHERE release_id=?')
          .bind(config.prior.releaseId).all<{manifest_json:string}>({signal})).results[0];signal.throwIfAborted();
        if(!row)throw new Error('publication_prior_changed');
        prior=JSON.parse(row.manifest_json);
        if(encodePublicationIntent(prior)!==row.manifest_json||prior.manifestSha256!==config.prior.manifestSha256)throw new Error('publication_prior_changed');
      }
      if(prior.releaseId!==config.prior.releaseId)throw new Error('publication_prior_changed');
      const serving=config.servingPrior;
      if(serving&&(serving.catalogRevision!==prior.catalogRevision||serving.catalogSnapshotSha256!==prior.catalogSnapshotSha256))throw new Error('publication_prior_changed');
      if(serving ? canonicalJson(await api.identity(signal))!==canonicalJson({release_id:serving.releaseId,code_sha:serving.codeSha,
        catalog_revision:serving.catalogRevision,catalog_snapshot_sha256:serving.catalogSnapshotSha256,manifest_sha256:serving.manifestSha256})
        : !matchesIdentity(await api.identity(signal),prior))throw new Error('publication_prior_changed');signal.throwIfAborted();
      return{environment:config.environment,settled:true,active:serving??identity(prior,config.prior.versionReference)};
    };
    // Fail before build/upload if the captured code-only storefront has since
    // changed; activation still performs the same fresh check under the fence.
    if(config.servingPrior&&control.stage==='claimed')await readPrior(AbortSignal.timeout(30_000));
    if(reviewed&&!retryRecord&&!control.permit){
      if(!revision||!control.publication||!control.intent||owner.phase!=='freezing'||canonicalJson(actual)!==canonicalJson(owner))throw new Error('publication_upload_retry_fenced');
      const publication=(await db.prepare('SELECT * FROM publication_outbox WHERE intent_id=?').bind(control.publication.intentId).all<Record<string,unknown>>()).results[0];
      const b=control.build,p=control.publication;
      let originalClaim=false;
      if(reviewed.approval.schemaVersion===4||reviewed.approval.schemaVersion===5){
        originalClaim=!!buildRow&&buildRow.operator_recovery_json===null&&Number.isInteger(buildRow.attempts)
          &&Number(buildRow.attempts)>=1&&Number(buildRow.attempts)<=3;
      }else{
        try{const operator=JSON.parse(String(buildRow?.operator_recovery_json));encodeBuildRecoveryApproval(operator.approval);
          originalClaim=buildRow?.attempts===3&&operator.schemaVersion===1&&operator.kind==='unstarted-build-operator-recovery'
            &&operator.normalAttempts===3&&operator.operatorAttempts===1&&operator.totalAttempts===4&&operator.releaseId===config.releaseId
            &&operator.token===b.token&&operator.leaseUntil===b.leaseUntil&&canonicalJson(operator.owner)===canonicalJson(owner)
            &&operator.approval.requestId===b.requestId&&operator.approval.packageSha256===control.packageSha256;
        }catch{throw new Error('publication_upload_retry_fenced');}
      }
      if(!buildRow||!publication||buildRow.state!=='building'||buildRow.lease_token!==b.token||buildRow.lease_until!==b.leaseUntil
        ||typeof buildRow.observed_at!=='string'||b.leaseUntil>buildRow.observed_at||p.leaseUntil>buildRow.observed_at
        ||!originalClaim
        ||buildRow.request_json!==encodeBuildRequest(b.request)||buildRow.run_reference!==b.runReference||buildRow.release_id!==null||buildRow.version_reference!==null
        ||buildRow.dispatch_reference!==null||buildRow.error_code!==null||publication.state!=='claimed'||publication.lease_token!==p.token
        ||publication.lease_until!==p.leaseUntil||publication.intent_json!==encodePublicationIntent(p.intent)||publication.release_id!==config.releaseId
        ||publication.dispatch_reference!==null||publication.completed_token!==null||publication.error_code!==null)throw new Error('publication_upload_retry_fenced');
      const {observed_at:ignored,...build}=buildRow;void ignored;
      retryRecord={schemaVersion:1,approval:reviewed.approval,evidence:reviewed.evidence,oldPending:pendingUpload!,
        oldReview:checkpoint!.checkpoint.pins.publicationUploadReview,owner,control:structuredClone(control),original:{build,publication},
        ...(reviewed.priorApproval?{priorApproval:reviewed.priorApproval}:{}),...(reviewed.transport?{transport:reviewed.transport}:{})};
      await verifyBuiltPackage();if(!(await rollbackPreflight(db,revision.snapshot,now())).ok)throw new Error('publication_upload_retry_fenced');
      await vectorProof();if(await api.findVersion(control.uploadMarker)!==null)throw new Error('publication_upload_review_required');
      await permanentProof();
      // The original live prior must still be active BEFORE the retry upload,
      // not merely when the final atomic activation is considered.
      if(reviewed.approval.schemaVersion===4||reviewed.approval.schemaVersion===5)await readPrior(AbortSignal.timeout(30_000));
      const exactRow=(table:string,row:Record<string,unknown>)=>{
        const keys=Object.keys(row).sort();if(keys.some(k=>!/^[_a-z][_a-z0-9]*$/.test(k)))throw new Error('publication_upload_retry_fenced');
        return db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})
          AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?)
          THEN 'true' ELSE 'publication_upload_retry_fenced' END)`).bind(...keys.map(k=>row[k]),activationDeadline!,config.releaseId);
      };
      await db.batch([mutationAssertion(db,owner,['freezing']),exactRow('catalog_build_requests',build),exactRow('publication_outbox',publication),mutationAssertion(db,owner,['freezing'])]);
      const current=await workspace.readCheckpoint();if(current?.sha256!==reviewed.approval.checkpointSha256)throw new Error('publication_upload_retry_fenced');
      assertBuildSource(config.sourceRoot,config.codeSha);
      if(reviewed.approval.schemaVersion===4||reviewed.approval.schemaVersion===5){
        await fs.mkdir(path.join(runtime,'tmp'),{recursive:true,mode:0o700});
        await privateDirectories(path.join(runtime,'tmp'),workspace.directory);
      }
      const marker=await workspace.putArtifact(retryRecord,{kind:'publication',observedAt:now().toISOString()});
      await save({},owner,{[pendingLabel]:marker});
      await workspace.assertHeld();await runUpload(); // Genuine factory success is required; no unknown reconciliation can create this ACK.
      const ack=await workspace.putArtifact(retryAck(marker),{kind:'publication',observedAt:now().toISOString()});
      await save({},owner,{[ackLabel]:ack});
    }
    let operatorRecovered=false;
    if(options.buildRecovery&&control.stage==='built'){
      const approval=options.buildRecovery,recoveryPending=checkpoint?.checkpoint.pins.buildOperatorRecoveryPending;
      const recoveryBinding={schemaVersion:1,approval,owner,releaseId:config.releaseId,configSha256,upload:uploadBinding()};
      if(!preflightPending||owner.phase!=='freezing'||canonicalJson(actual)!==canonicalJson(owner)||!buildRow
        ||approval.requestId!==control.requestId||approval.packageSha256!==control.packageSha256
        ||control.publication!==null||control.intent!==null||control.permit!==null||control.versionReference!==null
        ||control.deploymentId!==null||control.receiptSha256!==undefined
        ||(recoveryPending?recoveryPending.sha256!==sha256(canonicalJson(recoveryBinding)):
          buildRow.operator_recovery_json!==null||checkpoint?.sha256!==approval.checkpointSha256||control.build.token!==approval.previousToken))
        throw new Error('publication_build_recovery_fenced');
      await verifyBuiltPackage();
      if(await api.findVersion(control.uploadMarker)!==null)throw new Error('publication_upload_review_required');
      let recovered;
      if(recoveryPending)recovered=await readUnstartedBuildRecovery(db,control.build,owner,config.releaseId,approval);
      else{
        // Persist dispatch intent BEFORE the only grant write. A lost marker ACK
        // (even before SQL) stays held; reopening can ONLY read an exact receipt.
        const current=await workspace.readCheckpoint();if(!current||current.sha256!==approval.checkpointSha256)
          throw new Error('publication_build_recovery_fenced');
        const marker=await workspace.putArtifact(recoveryBinding,{kind:'publication',observedAt:now().toISOString()});
        await workspace.writeCheckpoint(current.sha256,{...current.checkpoint,
          pins:{...current.checkpoint.pins,buildOperatorRecoveryPending:marker}});
        checkpoint=await workspace.readCheckpoint({controlOnly:true});
        try{recovered=await recoverUnstartedBuildRequest(db,control.build,owner,config.releaseId,approval);}
        catch{recovered=await readUnstartedBuildRecovery(db,control.build,owner,config.releaseId,approval);}
      }
      if(canonicalJson(recovered)!==canonicalJson(control.build))await save({build:recovered});
      buildRow=(await db.prepare("SELECT *,strftime('%Y-%m-%dT%H:%M:%fZ','now') observed_at FROM catalog_build_requests WHERE request_id=?")
        .bind(control.requestId).all<Record<string,unknown>>()).results[0];
      operatorRecovered=true;
    }
    if(control.stage==='claimed'||control.stage==='built'){
      // No external step exists yet. Reclaim an expired BUILDING lease through
      // the ordinary bounded API, never renew its token or adopt a foreign one.
      const old=control.build,requestBytes=encodeBuildRequest(old.request);
      if(owner.phase!=='freezing'||canonicalJson(actual)!==canonicalJson(owner)||old.requestId!==control.requestId
        ||old.runReference!==control.runReference||sha256(requestBytes)!==control.requestId||!buildRow
        ||buildRow.state!=='building'||buildRow.lease_token!==old.token||buildRow.lease_until!==old.leaseUntil
        ||buildRow.run_reference!==old.runReference||buildRow.request_json!==requestBytes
        ||buildRow.environment!==config.environment||buildRow.source_revision!==old.request.sourceRevision
        ||buildRow.dispatch_reference!==null||buildRow.error_code!==null||buildRow.release_id!==null||buildRow.version_reference!==null
        ||control.publication!==null||control.intent!==null||control.permit!==null
        ||(control.stage==='claimed'?control.packageSha256!==null:!control.packageSha256||!HASH.test(control.packageSha256))
        ||control.versionReference!==null||control.deploymentId!==null||control.receiptSha256!==undefined
        ||pendingUpload&&!preflightPending||acknowledgedUpload)throw new Error('publication_build_reclaim_fenced');
      const columns=Object.keys(buildRow).filter(key=>key!=='observed_at');
      const exact=(row:Record<string,unknown>)=>db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_build_requests
        WHERE ${columns.map(key=>`${key} IS ?`).join(' AND ')}${preflightPending?" AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')":''}) THEN 'true' ELSE 'publication_build_reclaim_fenced' END)`)
        .bind(...columns.map(key=>row[key]));
      const undispatched=()=>db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM publication_outbox WHERE release_id=?)
        AND NOT EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?) THEN 'true' ELSE 'publication_build_reclaim_fenced' END)`)
        .bind(config.releaseId,config.releaseId);
      await db.batch([mutationAssertion(db,owner,['freezing']),exact(buildRow),undispatched(),mutationAssertion(db,owner,['freezing'])]);
      const at=canonicalTime(String(buildRow.observed_at));
      if(preflightPending&&(canonicalTime(old.leaseUntil)<=at||old.leaseUntil<=now().toISOString()))throw new Error('publication_upload_review_required');
      if(!operatorRecovered&&(preflightPending||canonicalTime(old.leaseUntil)<=at&&control.stage==='built'))await verifyBuiltPackage();
      if(preflightPending&&!operatorRecovered){
        if(await api.findVersion(control.uploadMarker)!==null)throw new Error('publication_upload_review_required');
        await db.batch([mutationAssertion(db,owner,['freezing']),exact(buildRow),undispatched(),mutationAssertion(db,owner,['freezing'])]);
      }
      if(canonicalTime(old.leaseUntil)<=at){
        const leaseMs=options.approvedCatalog?.persistent?3600000:900000;
        const attempts=Number(buildRow.attempts),leaseUntil=new Date(Math.min(Date.parse(at)+leaseMs,Date.parse(activationDeadline??old.request.cutoff))).toISOString();
        if(!Number.isInteger(attempts)||attempts<1||attempts>=3||leaseUntil<=at)throw new Error('publication_build_reclaim_fenced');
        let reclaimed:Awaited<ReturnType<typeof claimBuildRequest>>=null,uncertain=false;
        try{reclaimed=await claimBuildRequest(db,old.requestId,old.runReference,new Date(at),leaseMs,
          continuation?{authority:continuation,snapshot:revision!.snapshot,owner}:undefined);}catch{uncertain=true;}
        if(!reclaimed&&!uncertain)throw new Error('publication_build_reclaim_fenced');
        const row=(await db.prepare("SELECT *,strftime('%Y-%m-%dT%H:%M:%fZ','now') observed_at FROM catalog_build_requests WHERE request_id=?")
          .bind(old.requestId).all<Record<string,unknown>>()).results[0];
        if(!row||row.state!=='building'||row.request_json!==requestBytes||row.environment!==buildRow.environment
          ||row.source_revision!==buildRow.source_revision||row.run_reference!==old.runReference||row.attempts!==attempts+1
          ||typeof row.lease_token!=='string'||!UUID.test(row.lease_token)||row.lease_token===old.token||row.lease_until!==leaseUntil
          ||reclaimed&&(reclaimed.token!==row.lease_token||encodeBuildRequest(reclaimed.request)!==requestBytes)
          ||leaseUntil<=canonicalTime(String(row.observed_at))||leaseUntil<=now().toISOString()
          ||row.dispatch_reference!==null||row.error_code!==null||row.release_id!==null||row.version_reference!==null)
          throw new Error('publication_build_reclaim_fenced');
        await db.batch([mutationAssertion(db,owner,['freezing']),exact(row),undispatched(),mutationAssertion(db,owner,['freezing'])]);
        if(canonicalJson(await readMutationOwner(db,owner))!==canonicalJson(owner))throw new Error('publication_build_reclaim_fenced');
        // A failed pre-write checkpoint leaves a fenced token mismatch. Never
        // infer ownership from a different token on a later invocation.
        await save({build:{...old,token:row.lease_token,leaseUntil}});
      }
    }
    const receipt=()=>({schemaVersion:1,environment:config.environment,accountId:config.accountId,workerName:config.workerName,
      releaseId:config.releaseId,versionReference:control!.versionReference,requestId:control!.requestId,intent:control!.intent,
      ...(serving?{kind:'serving-only',catalogPublication:serving.authority.publication}:{})});
    const status=()=>serving?servingPublicationStatus(db,config.releaseId,serving.authority):publicationStatus(db,config.releaseId);
    // A lost resolve response must not reacquire a writer or reactivate. The
    // durable receipt was saved before resolve, whose D1 transaction proves idle.
    if(buildRow?.state==='resolved'&&buildRow.lease_token===control.build.token&&buildRow.run_reference===control.runReference
      &&buildRow.release_id===config.releaseId&&buildRow.version_reference===control.versionReference&&control.receiptSha256
      &&(await status()).state==='published'){
      const storedRow=serving?undefined:(await db.prepare('SELECT manifest_json FROM publication_receipts WHERE release_id=?').bind(config.releaseId).all<{manifest_json:string}>()).results[0];
      const stored=serving?(await servingPublicationStatus(db,config.releaseId,serving.authority)).intent
        :storedRow?JSON.parse(storedRow.manifest_json):null;
      if(!stored||canonicalJson(stored)!==canonicalJson(control.intent)
        ||sha256(canonicalJson(receipt()))!==control.receiptSha256)throw new Error('publication_receipt_mismatch');
      return{state:'published',owner:null,releaseId:config.releaseId,receiptSha256:control.receiptSha256,receipt:receipt()};
    }
    if(!reviewed&&!control.permit&&actual?.phase==='activating'&&buildRow?.state==='activating'&&buildRow.lease_token===control.build.token
      &&buildRow.run_reference===control.runReference&&buildRow.release_id===config.releaseId&&buildRow.version_reference===control.versionReference
      &&canonicalJson({...actual,phase:owner.phase})===canonicalJson(owner)){
      await save({stage:'activating',permit:{requestId:control.requestId,token:control.build.token,runReference:control.runReference,
        releaseId:config.releaseId,versionReference:control.versionReference!,mutationOwner:actual}},actual);
    }
    if(control.permit){
      owner=control.permit.mutationOwner!;
      const receiptOnly=options.acceptedReceiptOnly===true;
      let receiptInventoryOwner:MutationOwner|undefined;
      const observed=async(signal?:AbortSignal):Promise<DeploymentObservation>=>{
        signal?.throwIfAborted();await workspace.assertHeld();signal?.throwIfAborted();const deployed=await api.deployed(signal);signal?.throwIfAborted();
        if(!deployed||deployed.version!==control!.versionReference||deployed.marker!==control!.deploymentMarker
          ||control!.deploymentId!==null&&deployed.id!==control!.deploymentId)throw new Error('publication_activation_pending');
        if(!matchesIdentity(await api.identity(signal),control!.intent!))throw new Error('publication_identity_mismatch');signal?.throwIfAborted();
        const adapters=createVectorizeRestAdapters({environment:config.environment,indexName:config.indexName,accountId:config.accountId,
          token:options.credentials.cloudflareToken,fetch:observationSend});
        // Serving-only full catalog/native proof runs outside this short
        // deployment observation, under the same owner and final compact CAS.
        if(serving){signal?.throwIfAborted();}
        else if(receiptOnly)await readAcceptedActivatedCatalogNative(db,control!.permit!,control!.vectorPlan,adapters,{intent:control!.intent!,signal});
        else if(options.permanent)await readActivatedPermanentCatalogNative(db,control!.permit!,control!.vectorPlan,options.permanent,adapters,signal);
        else await readActivatedCatalogVectors(db,control!.permit!,control!.vectorPlan,adapters,
          {signal,published:options.published,permanent:options.permanent});signal?.throwIfAborted();
        // Re-read deployment after independent identity/vector reads. Never infer
        // not-submitted from elapsed time or an observed prior deployment.
        const after=await api.deployed(signal);signal?.throwIfAborted();if(canonicalJson(after)!==canonicalJson(deployed))throw new Error('publication_activation_pending');
        return{environment:config.environment,settled:true,active:identity(control!.intent!,control!.versionReference!)};
      };
      const accepted=(await status()).state==='published';
      if(receiptOnly){
        if(!accepted)throw new Error('publication_fresh_evidence_required');
        const sealed=await loadPackage(directory,config,control.packageSha256!,now(),control.permit);
        const receipts=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(config.releaseId).all()).results;
        if(receipts.length!==1||receipts[0].manifest_json!==encodePublicationIntent(control.intent!)
          ||receipts[0].catalog_revision!==control.intent!.catalogRevision||receipts[0].code_sha!==control.intent!.codeSha
          ||sealed.snapshot.products.some(p=>p.eligibleUntil!==null)
          ||canonicalJson(intentFrom(sealed.manifest,sealed.bytes))!==canonicalJson(control.intent))throw new Error('publication_receipt_mismatch');
      }
      if(!accepted){
        if(!revision)throw new Error('publication_fresh_evidence_required');
        const sealed=await loadPackage(directory,config,control.packageSha256!,now(),control.permit);
        if(canonicalJson(intentFrom(sealed.manifest,sealed.bytes))!==canonicalJson(control.intent)
          ||canonicalJson(sealed.snapshot)!==canonicalJson(revision.snapshot))throw new Error('publication_package_changed');
        const readDeployed=async()=>{
          // Approved persistent completion already checks all source/projection
          // rows on both sides of this callback. Retain one full private/held
          // inventory AFTER the independent native/deployment observation.
          if(serving)await vectorProof();
          else if(!options.approvedCatalog?.persistent)await permanentProof();
          await observed();await permanentProof();receiptInventoryOwner={...owner};return control!.intent!;
        };
        if(serving)await completeActivatedServingPublication(db,revision,control.publication!,control.permit,serving.authority,readDeployed,now);
        else if(options.approvedCatalog||control.publication!.leaseUntil<=now().toISOString())
          if(options.permanent)await completeActivatedPermanentPublication(db,revision,control.publication!,control.permit,readDeployed,now);
          else if(options.approvedCatalog)await completeActivatedApprovedCatalogPublication(db,revision,control.publication!,control.permit,readDeployed,now);
          else await completeActivatedPublication(db,revision,control.publication!,control.permit,readDeployed,now,options.published);
        else await completePublication(db,sealed.snapshot,config.releaseId,control.publication!.token,readDeployed,now,owner);
      }
      const proof=receipt();
      let ref={sha256:control.receiptSha256??sha256(canonicalJson(proof))};
      if(!control.receiptSha256){try{ref=await workspace.putArtifact(proof,{kind:'publication',observedAt:now().toISOString()});}
        catch(error){if(!(error instanceof Error)||error.message!=='run_workspace_expired')throw error;
          // Only an ALREADY accepted D1 publication can reach this path. Its
          // receipt is reconstructible entirely from immutable control; record
          // that digest in the protected control journal, never renew content.
        }}
      await save({stage:'published',receiptSha256:ref.sha256});
      // Ordinary permanent completion proves all source/projection rows here.
      // The explicitly admitted accepted receipt already commits those proofs;
      // it retains the bounded fresh native/deployment gate without rescanning.
      // Otherwise reuse only this invocation's exact unchanged-owner inventory.
      if(serving){if(canonicalJson(receiptInventoryOwner??null)!==canonicalJson(owner))await vectorProof();}
      else if(!receiptOnly&&(!options.approvedCatalog?.persistent||canonicalJson(receiptInventoryOwner??null)!==canonicalJson(owner)))await permanentProof();
      let observation:Promise<DeploymentObservation>|undefined;
      try{if(await resolveBuildActivation(db,control.permit,signal=>(observation=observed(signal)),{observationTimeoutMs:30_000,
        ...(serving?{acceptedCatalog:serving.authority}:{})})!=='resolved')
        throw new Error('publication_activation_pending');}
      finally{if(observation){
        // Only concrete bounded read transports can own durable ledger cleanup.
        // Arbitrary injected adapters never acquire an unbounded join.
        if(isAccountedPublicationFetch(observationSend)&&isCatalogD1Rest(db))await observation.catch(()=>{});
        else await drainDeploymentObservation(observation);}}
      return{state:'published',owner:null,releaseId:config.releaseId,receiptSha256:ref.sha256,receipt:proof};
    }
    if(config.prior===null)throw new Error('publication_bootstrap_required'); // Historical reconciliation only; never a new external action.
    if(!revision||owner.phase!=='freezing')throw new Error('publication_revision_required');
    // The routine whole-catalog mode requires its genuine COMPLETE policy and
    // every native/absence proof BEFORE a build/upload, not only at completion.
    if((options.approvedCatalog||serving)&&!(reviewed&&checkpoint?.checkpoint.pins.reviewedUploadActivationPending)){
      if(continuation)await permanentProof();await vectorProof();
    }
    assertBuildSource(config.sourceRoot,config.codeSha);
    if(control.stage==='claimed'){
      const context:ReleaseBuildContext={schemaVersion:1,sourceMode:config.sourceMode,releaseId:config.releaseId,codeSha:config.codeSha,
        catalogRevision:revision.snapshot.catalogRevision,catalogSnapshotSha256:sha256(`${JSON.stringify(revision.snapshot)}\n`),
        generatedAt:serving?.authority.observedAt??revision.snapshot.generatedAt,vectorSyncWatermark:revision.vectorSyncWatermark,priorReleaseId:config.prior?.releaseId??null,
        retainedManifestSha256:config.prior?.directory?config.prior.manifestSha256:null,...(config.homepage?{homepage:config.homepage}:{}),
        ...(config.merchandising?{merchandising:config.merchandising}:{})};
      validateBuildContext(context,revision.snapshot,config.codeSha,context.catalogSnapshotSha256,now());
      let observedAt=serving?.authority.observedAt??revision.snapshot.generatedAt;
      const deadlines=revision.snapshot.products.map(p=>p.eligibleUntil);
      if(config.prior?.directory&&!serving){
        // Repackaging a permitted historical shard must not renew its original
        // observation/expiry. Identity-only prior mode reads/copies no old body.
        const bytes=await privateBytes(path.join(config.prior.directory,'asset-manifest.json'));
        if(sha256(bytes)!==config.prior.manifestSha256)throw new Error('publication_prior_changed');
        const prior=JSON.parse(bytes.toString()) as SiteAssetManifest;
        if(prior.releaseId!==config.prior.releaseId)throw new Error('publication_prior_changed');
        const original=canonicalTime(prior.generatedAt);if(original<observedAt)observedAt=original;
        if(prior.nextExpiry!==null)deadlines.push(canonicalTime(prior.nextExpiry));
        for(const route of Object.values(prior.routes))if(route.state==='ready'&&route.eligibleUntil
          &&/^\/catalog\/[a-f0-9]{64}\/(?:random|feed-[1-9][0-9]*)\.json$/.test(route.assetPath))deadlines.push(canonicalTime(route.eligibleUntil));
      }
      await workspace.preparePublicationDirectories(config.releaseId,observedAt,deadlines.sort()[0]??null);
      await write(path.join(directory,'input.snapshot.json'),`${JSON.stringify(revision.snapshot)}\n`);
      await write(path.join(directory,'input.context.json'),`${JSON.stringify(context)}\n`);
      const env={...childEnv(),...publicAnalyticsEnv(config),TMPDIR:path.join(runtime,'tmp'),CATALOG_SITE_MODE:config.sourceMode,CATALOG_SNAPSHOT_PATH:path.join(directory,'input.snapshot.json'),
        CATALOG_RELEASE_CONTEXT_PATH:path.join(directory,'input.context.json'),...(config.prior?.directory?{CATALOG_PRIOR_RELEASE_PATH:config.prior.directory}:{})};
      if(config.semanticSearch?.derivedCatalog){const input=config.semanticSearch.derivedCatalog;
        const catalog=await verifySemanticCatalogIdentities(await json(input.path));
        await verifyPublicationSemanticCatalog({semanticCatalog:catalog},config);
        Object.assign(env,{CATALOG_SEMANTIC_CATALOG_PATH:input.path,CATALOG_SEMANTIC_CATALOG_SHA256:input.sha256});}
      let built=false;
      try{const previous=JSON.parse(await fs.readFile(path.join(config.sourceRoot,'build/stupid-gifts/asset-manifest.json'),'utf8'));built=previous.releaseId===config.releaseId;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw new Error('publication_build_requires_operator_review');}
      for(const script of [...(built?[]:['build.mts']),'verify-release.mts'])await command({file:process.execPath,args:['--import','tsx',`scripts/staging/${script}`],
        cwd:config.sourceRoot,env,timeoutMs:300_000});
      for(const name of packageFiles)await write(path.join(directory,name),await fs.readFile(path.join(config.sourceRoot,'build/stupid-gifts',name)));
      const manifest=await json(path.join(directory,'asset-manifest.json')) as SiteAssetManifest;
      for(const name of Object.keys(manifest.checksums)){if(!safePath(name))throw new Error('publication_package_invalid');
        await write(path.join(directory,'assets',name.slice(1)),await fs.readFile(path.join(config.sourceRoot,'static-site/out',name.slice(1))));}
      const entry=path.join(directory,'entry.mts');const imports=packageFiles.filter(name=>!['release-context.json'].includes(name));
      const variables=['manifest','snapshot','releaseIdentity','siteIdentity','feedPlan'];
      const entryBytes=imports.map((name,i)=>`import ${variables[i]} from ${JSON.stringify(path.join(directory,name))};`).join('\n')+
        `\nimport {createSiteWorker} from ${JSON.stringify(path.join(config.sourceRoot,'workers/site/index.ts'))};\n`+
        `import {d1SearchAdapters} from ${JSON.stringify(path.join(config.sourceRoot,'workers/site/d1-search.ts'))};\n`+
        `export default createSiteWorker({snapshot,manifest,releaseIdentity,feedPlan,canonicalOrigin:siteIdentity.origin,searchAdapters:d1SearchAdapters,`+
        `semanticBudgetScope:${JSON.stringify({environment:config.environment,index:config.indexName})}});\n`;
      await write(entry,entryBytes);
      await write(path.join(directory,'wrangler.json'),JSON.stringify({name:config.workerName,account_id:config.accountId,main:entry,
        compatibility_date:config.compatibilityDate,workers_dev:config.environment==='staging',preview_urls:false,upload_source_maps:false,
        observability:{enabled:false},assets:{directory:path.join(directory,'assets'),binding:'ASSETS',run_worker_first:true,html_handling:'none',not_found_handling:'none'},
        vars:{ENVIRONMENT:config.environment,...searchVars(config)},
        d1_databases:[{binding:'DB',database_name:config.database.name,database_id:config.database.id}],
        vectorize:[{binding:'VECTORIZE',index_name:config.indexName},
          ...(config.semanticSearch?.derivedCatalog?[{binding:'SEMANTIC_VECTORIZE',index_name:config.semanticSearch.derivedCatalog.indexName}]:[])]}));
      const packageSha256=sha256(canonicalJson(await inventory(directory)));
      await save({stage:'built',packageSha256});
    }
    const sealed=await loadPackage(directory,config,control.packageSha256!,now());
    // Source intermediates are regenerable. Cleanup runs AFTER acceptance, not
    // between a successful build and its time-sensitive upload/activation.
    // Legacy migration/recovery contracts keep their original cleanup behavior.
    if(!options.routineCare)await workspace.cleanPublicationBuild(config.releaseId);
    // A large static build/guarded cleanup may outlive its original lease.
    // Re-enter the existing capped, fenced built-stage reclaim BEFORE upload.
    if(control.stage==='built'&&control.build.leaseUntil<=now().toISOString())
      return executePublication({...options,owner,dependencies:options.dependencies});
    const intent=intentFrom(sealed.manifest,sealed.bytes);
    if(control.intent&&canonicalJson(control.intent)!==canonicalJson(intent))throw new Error('publication_package_changed');
    if(control.stage==='built'){
      const protectedUpload=isAccountedPublicationUploadCommand(command);
      await enqueuePublication(db,sealed.snapshot,intent,now());
      const publication=await claimPublication(db,sealed.snapshot,intent.releaseId,now());if(!publication)throw new Error('publication_claim_unavailable');
      const pending=protectedUpload?await workspace.putArtifact(uploadBinding(),{kind:'publication',observedAt:now().toISOString()}):undefined;
      // One checkpoint binds the first possible CLI invocation to both its
      // exact publication claim and pending pin, never a preflight-only read.
      await save({intent,publication,stage:'uploading'},owner,pending?{publicationUploadPending:pending}:undefined);
      assertBuildSource(config.sourceRoot,config.codeSha);await workspace.assertHeld();
      // Intent is durable before the only upload CLI invocation (Wrangler may
      // internally retry immutable version POST). Duplicate tags stay pending.
      try{await runUpload();}catch(error){
        if(error instanceof PublicationUploadCommandError){
          const current=await workspace.readCheckpoint();if(!current)throw new Error('publication_checkpoint_missing');
          const review=await workspace.putArtifact({schemaVersion:1,code:error.code,releaseId:config.releaseId,
            requestId:options.requestId,configSha256,...(error.detail?{detail:error.detail}:{})},{kind:'publication',observedAt:now().toISOString()});
          await workspace.writeCheckpoint(current.sha256,{...current.checkpoint,phase:'attention',owner,
            pins:{...current.checkpoint.pins,publicationUploadReview:review}});
          throw error;
        }
        if(protectedUpload)throw error;
        // An ordinary legacy CLI's unknown result retains read-only reconciliation.
      }
      if(protectedUpload){
        const current=await workspace.readCheckpoint();if(!current)throw new Error('publication_checkpoint_missing');
        if(current.checkpoint.pins.publicationUploadReview)throw new Error('publication_upload_review_required');
        const pending=current.checkpoint.pins.publicationUploadPending;
        if(!pending||pending.sha256!==sha256(canonicalJson(uploadBinding())))throw new Error('publication_upload_review_required');
        const acknowledged=await workspace.putArtifact({...uploadBinding(),pending},{kind:'publication',observedAt:now().toISOString()});
        await workspace.writeCheckpoint(current.sha256,{...current.checkpoint,pins:{...current.checkpoint.pins,publicationUploadAcknowledged:acknowledged}});
      }
    }
    if(control.stage==='uploading'){
      const version=await api.findVersion(control.uploadMarker);if(!version)throw new Error('publication_upload_pending');
      const uploaded=await api.version(version);
      verifyUploadedVersion(uploaded,config,version,control);
      await save({stage:'uploaded',versionReference:version});
    }
    // Detect changed code/package during an upload before granting activation.
    assertBuildSource(config.sourceRoot,config.codeSha);
    await loadPackage(directory,config,control.packageSha256!,now());
    verifyUploadedVersion(await api.version(control.versionReference!),config,control.versionReference!,control);
    if(!reviewed)await recordPublicationDispatch(db,sealed.snapshot,control.publication!,`version:${control.versionReference}`,now());
    // Persist exact deployment intent BEFORE the D1 CAS and actual POST. A crash
    // after this point is reconciled from the exact claim, never automatically POSTed.
    if(!reviewed)await save({stage:'activating'});
    let observation:Promise<DeploymentObservation>|undefined,permit:ActivationPermit;
    try{
      if(reviewed){
        if(!retryRecord)throw new Error('publication_upload_retry_fenced');
        const input:ReviewedUploadActivationInput={claim:control.build,publication:control.publication!,versionReference:control.versionReference!,
          owner:retryRecord.owner,approval:reviewed.approval,original:retryRecord.original,
          ...(reviewed.approval.schemaVersion===5&&config.servingPrior?{servingPrior:config.servingPrior}:{}),
          ...(options.finishAuthorization?{finishAuthorization:options.finishAuthorization}:{}),
          ...(retryRecord.priorApproval?{priorApproval:retryRecord.priorApproval}:{})};
        const pins=checkpoint!.checkpoint.pins,expected={schemaVersion:1,input,retryPending:pins[pendingLabel],
          retryAcknowledged:pins[ackLabel],configSha256};
        const marked=pins.reviewedUploadActivationPending;
        if(marked){
          if(marked.sha256!==sha256(canonicalJson(expected)))throw new Error('publication_upload_retry_fenced');
          permit=await readReviewedUploadActivation(db,input); // Never repeat a marked/missing/unknown CAS.
        }else{
          // Whole-catalog mode already proved native state above. Legacy modes
          // need the same fresh proof outside30s, ONLY before an unmarked CAS.
          // A marked/lost-ACK CAS is strictly read-only reconciliation.
          if(!options.approvedCatalog)await vectorProof();
          let dispatched=false;
          try{permit=await beginReviewedUploadActivation(db,input,sealed.snapshot,signal=>(observation=(async()=>{
            // Slow full package/native checks already ran in this invocation
            // under this same owner. Do not repeat them inside the short
            // provider observation; inventory is rechecked before the CAS.
            signal.throwIfAborted();
            verifyUploadedVersion(await api.version(control!.versionReference!),config,control!.versionReference!,control!);
            signal.throwIfAborted();return readPrior(signal);
          })()),async()=>{
            await permanentProof(); // All rows/held/private/projection proof immediately precedes the action marker.
            const marker=await workspace.putArtifact(expected,{kind:'publication',observedAt:now().toISOString()});
            await save({},owner,{reviewedUploadActivationPending:marker});dispatched=true;
          });}catch(error){
            if(!dispatched)throw error;
            permit=await readReviewedUploadActivation(db,input); // ACK loss: exact readback only, no write retry.
          }
        }
      }else{
        if(continuation)await permanentProof();
        permit=await beginBuildActivation(db,control.build,sealed.snapshot,control.publication!,control.versionReference!,
          signal=>(observation=readPrior(signal)),now(),owner,config.servingPrior,continuation,{observationTimeoutMs:30_000});
      }
    }
    finally{if(observation){
      if(isAccountedPublicationFetch(observationSend)&&isCatalogD1Rest(db))await observation.catch(()=>{});
      else await drainDeploymentObservation(observation);}}
    // CAS pending is NOT provider dispatch pending. A recovered permit may
    // authorize its FIRST POST only while its explicit dispatch grant is future.
    if(reviewed&&now().toISOString()>=activationDeadline!)throw new Error('publication_upload_retry_cutoff');
    await save(reviewed?{stage:'activating',permit}:{permit},permit.mutationOwner!);
    await workspace.assertHeld(); // Exact owner fence immediately precedes real activation.
    if(reviewed&&now().toISOString()>=activationDeadline!)throw new Error('publication_upload_retry_cutoff');
    const deploymentId=await api.activate(control.versionReference!,control.deploymentMarker);
    await save({deploymentId});
    // One invocation performs the readback too; recursive entry only reuses the
    // exact durable control/package and has no second activation path.
    return executePublication({...options,owner,dependencies:options.dependencies});
  }catch(error){
    const code=error instanceof Error&&/^(?:publication_|catalog_d1_|run_workspace_|build_|cohort_|vector_|accepted_code_only_|accepted_catalog_|serving_publication_)[a-z_]+$/.test(error.message)?error.message:'publication_pending';
    return{state:'pending',owner,errorCode:code};
  }
}
