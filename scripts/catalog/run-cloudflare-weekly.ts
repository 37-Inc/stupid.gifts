import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createCatalogD1Rest } from './d1-write-rest.ts';
import { checkCloudflareRunner, resolveReadToken, resolveCloudflareCredential, validateRunnerCheckConfig } from './check-cloudflare-runner.ts';
import type { CloudflareCredentialReference } from './check-cloudflare-runner.ts';
import { createD1CatalogMaintenanceStore, loadMaintenanceVectorPayload } from './maintenance-d1.ts';
import { createD1CatalogTelemetryStore } from './telemetry-d1.ts';
import { createCatalogProviderEvidence } from './provider-evidence.ts';
import { createVectorizeRestAdapters } from './vectorize-rest.ts';
import { deliverOwnedOutboxEvent, deliverOwnedApprovedCohortVector, prepareOwnedApprovedCohortPlan, settleOwnedApprovedCohortVectorProof } from './owned-vector-delivery.ts';
import { canonicalJson, sha256 } from './migration.ts';
import { decodePgvectorSendBase64 } from './pgvector-binary.ts';
import { openRunWorkspace, readRunWorkspace, WORKSPACE_BLOB_LIMITS } from './run-workspace.ts';
import type { ArtifactRef, RetentionPolicy, RunWorkspace, RunWorkspaceOptions, WorkspaceCheckpoint, PublicationFinishBudget } from './run-workspace.ts';
import { executePublication, validatePublicationConfig } from './publish-release.ts';
import { accountedPublicationReadFetch, accountedPublicationFetch, isAccountedPublicationFetch } from './publication-read-fetch.ts';
import { accountedPublicationUploadCommand, isAccountedPublicationUploadCommand } from './publication-upload-command.ts';
import { approvedRequestControl, hydrateApprovedRequest, approvedRevisionControl, hydrateApprovedRevision,
  approvedArtifactObservedAt, readApprovedPrior, createPublishedApprovedCatalogSeal, createPublishedApprovedCatalogSealFromControl } from './approved-catalog-seal.ts';
import {isPersistentCatalogSeal,reconstructPermanentSnapshot} from './permanent-catalog-seal.ts';
import type {PermanentCatalogSeal} from './permanent-catalog-seal.ts';
import type { ApprovedCatalogSeal } from './approved-catalog-seal.ts';
import type { PublicationConfig } from './publish-release.ts';
import { claimMutationOwnership, releaseMutationOwnership, readMutationOwner } from '../../lib/catalog/mutation-fence.ts';
import type { MutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { approvedCohortOperationKey, approvedCohortVectorPlan } from '../../lib/catalog/freeze-approved-cohort.ts';
import type { ApprovedCohortRequest, ApprovedCohortRevision } from '../../lib/catalog/freeze-approved-cohort.ts';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import { canonicalTime } from '../../lib/catalog/snapshot.ts';
import {repairApprovedNewSlugs} from './new-product-slug-repair.ts';
import {syncApprovedSearchDelta} from './sync-semantic-delta.ts';
import {routineUploadRetry} from './routine-upload-retry.ts';
import amazonCreators from '../../lib/amazon-creators.js';
import { dailyCatalogPhases, pacificCatalogCalendar, runDailyCatalogWithBackend, withCatalogCadence, validCatalogRunKey } from '../ops/catalog-daily.mjs';
import {validateExecutionAdoption,validateExecutionAdoptionConfigs} from './execution-adoption.ts';
import type {ExecutionAdoption} from './execution-adoption.ts';
import {encodeReviewedUploadActivationApproval,readReviewedUploadActivation} from '../../lib/catalog/build-requests.ts';

type KeychainRef={service:string;account:string};
type InputRef={path:string;sha256:string;observedAt:string};
export interface CloudflareWeeklyConfig {
  schemaVersion:1;runId:string;catalogRevision:string;codeSha:string;environment:'staging'|'production';accountId:string;
  database:{id:string;name:string};vectorIndex:{name:string;dimensions:1536;metric:'cosine'};
  catalog:{associateTag:string;marketplace:'www.amazon.com'};backfillLimit:number;
  cadence?:{day:string;featuredIds:string[];runKey?:string;photosOnly?:true;admitAsins?:string[]};
  credentials:{cloudflare:CloudflareCredentialReference;amazonId:KeychainRef;amazonSecret:KeychainRef;amazonVersion:string;openai?:KeychainRef;stagingAuthSecret?:KeychainRef};
  limits:{requests:number;statements:number;reportedRowsRead?:number;reportedRowsWritten?:number};retention:RetentionPolicy;
  inputs:{previous:InputRef;context:InputRef;rights:InputRef;originalVectors?:InputRef};publication:PublicationConfig;
}
export const WEEKLY_RESUME_STATES=Object.freeze({
  created:'No provider phase started; the exact initial claim can be recovered.',
  phases_running:'Ambiguous provider work: STOP for explicit review; never replay automatically.',
  phases_complete:'Providers finished; await a separately reviewed post-phase approval, then drain/freeze.',
  draining:'Resume only the pinned outbox event and immutable payload; unknown mutation stays owned.',
  freezing:'Resume the same full-catalog seal and genuine whole native plan; <=30 reviewed changes, not a30-vector truncation.',
  publishing:'Resume pinned build/upload/activation/readback only; no merchant/model phases.',
  published:'Verified receipt; deliberately reacquire writing solely for exact telemetry finalization.',
  finalized:'Terminal exact telemetry readback; never rerun.',
  phase_failed:'Terminal failed/partial provider phase; review retained receipts, never rerun.',
  attention:'Explicit reconciliation needed; never infer completion or take ownership.',
});
const KEY=/^[a-zA-Z0-9._-]{1,100}$/;const HASH=/^[a-f0-9]{64}$/;
const repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const exact=(value:unknown,keys:string)=>!!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
const keychain=(r:KeychainRef)=>r&&exact(r,'account,service')&&/^goose\.gifts\.[a-zA-Z0-9._:/-]{1,150}$/.test(r.service)
  &&/^[a-zA-Z0-9][a-zA-Z0-9._@:/-]{0,199}$/.test(r.account);
const safeCode=(error:unknown)=>error instanceof Error&&/^[a-z][a-z0-9_]{1,100}$/.test(error.message)?error.message:'weekly_requires_review';
const resolving=(checkpoint:{control?:WorkspaceCheckpoint['control']})=>Boolean(checkpoint.control?.publication
  &&(checkpoint.control.publication.permit||checkpoint.control.publication.stage==='activating'));
/** Only an exact separately approved upload continuation can leave attention.
 * The publisher still authenticates its journal, claims, owner and provider. */
export function reviewedUploadResume(saved:{sha256:string;checkpoint:Omit<WorkspaceCheckpoint,'state'>}|null,
  retry:Parameters<typeof executePublication>[0]['reviewedUploadRetry']):boolean {
  if(!saved||!retry||!exact(retry,retry.transport?'approval,evidence,transport':'approval,evidence')||!exact(retry.evidence,'reference,sha256')
    ||retry.evidence.reference!==`objects/${retry.evidence.sha256}.json`)return false;
  try{encodeReviewedUploadActivationApproval(retry.approval);}catch{return false;}
  const cp=saved.checkpoint,c=cp.control?.publication,a=retry.approval,p=cp.pins;
  if(![4,5].includes(a.schemaVersion)||!['attention',...(retry.transport||a.schemaVersion===5?['publishing']:[])].includes(cp.phase)||cp.owner?.phase!=='freezing'||!c||c.permit||c.deploymentId
    ||!p.publicationUploadPending||!p.publicationUploadReview||p.publicationUploadAcknowledged
    ||p.publicationUploadRetryAcknowledged&&!p.publicationUploadRetryPending
    ||a.requestId!==c.requestId||a.packageSha256!==c.packageSha256||a.configSha256!==c.configSha256
    ||a.reviewPinSha256!==p.publicationUploadReview.sha256||a.evidenceSha256!==retry.evidence?.sha256)return false;
  if(retry.transport&&(!exact(retry.transport,'previous')||!exact(retry.transport.previous,'reference,sha256')
    ||retry.transport.previous.reference!==`objects/${retry.transport.previous.sha256}.json`
    ||retry.transport.previous.sha256!==p.publicationUploadRetryPending?.sha256||p.publicationUploadRetryAcknowledged))return false;
  const label=a.schemaVersion===5?`publicationUploadRoutine${a.attempt}`:retry.transport?'publicationUploadTransport':'publicationUploadRetry';
  const pending=p[`${label}Pending`],ack=p[`${label}Acknowledged`];
  if(ack&&!pending)return false;
  return pending
    ?!!ack&&['uploading','uploaded'].includes(c.stage)
    :saved.sha256===a.checkpointSha256&&c.stage==='uploading'&&c.versionReference===null;
}
/** A committed CAS with a lost local permit must be reconciled BEFORE any
 * revision hydration/native proof using the stale freezing owner. Never retry
 * the CAS here, infer its result from elapsed time, or dispatch a provider call. */
export async function recoverMarkedReviewedActivation(options:{db:CatalogD1;workspace:Pick<RunWorkspace,'readArtifact'>;
  saved:{sha256:string;checkpoint:WorkspaceCheckpoint};config:PublicationConfig;
  retry:Parameters<typeof executePublication>[0]['reviewedUploadRetry'];
  finishAuthorization?:Parameters<typeof executePublication>[0]['finishAuthorization']}) {
  const {db,workspace,saved,config,retry}=options,cp=saved.checkpoint,c=cp.control?.publication,pins=cp.pins;
  if(!pins.reviewedUploadActivationPending||c?.permit||!retry||![4,5].includes(retry.approval.schemaVersion))return null;
  if(!c||c.stage!=='uploaded'||!c.publication||!c.versionReference||!cp.owner||!['publishing','attention'].includes(cp.phase)
    ||!reviewedUploadResume({...saved,checkpoint:{...cp,phase:'attention'}},retry))
    throw new Error('weekly_reviewed_activation_fenced');
  const label=retry.approval.schemaVersion===5?`publicationUploadRoutine${retry.approval.attempt}`:retry.transport?'publicationUploadTransport':'publicationUploadRetry';
  const pending=pins[`${label}Pending`],acknowledged=pins[`${label}Acknowledged`];
  const record=await workspace.readArtifact(pending) as {original:unknown};
  const input={claim:c.build,publication:c.publication,versionReference:c.versionReference,owner:cp.owner,
    approval:retry!.approval,original:record.original,
    ...(retry.approval.schemaVersion===5&&config.servingPrior?{servingPrior:config.servingPrior}:{}),
    ...(retry!.priorApproval?{priorApproval:retry!.priorApproval}:{}),
    ...(options.finishAuthorization?{finishAuthorization:options.finishAuthorization}:{})};
  const expected={schemaVersion:1,input,retryPending:pending,retryAcknowledged:acknowledged,configSha256:sha256(canonicalJson(config))};
  if(canonicalJson(await workspace.readArtifact(pins.reviewedUploadActivationPending))!==canonicalJson(expected))
    throw new Error('weekly_reviewed_activation_fenced');
  const permit=await readReviewedUploadActivation(db,input as Parameters<typeof readReviewedUploadActivation>[1]);
  // Hydrate under the actual owner, but leave the checkpoint untouched. The
  // publisher must perform its exact marked-permit read, durable dispatch marker
  // and FIRST POST together; an already saved permit is reconciliation-only.
  return permit.mutationOwner!;
}
let executing=false; // Environment isolation across differing DB/workspace scopes in ONE process.

export function validateCloudflareWeeklyConfig(input:unknown):CloudflareWeeklyConfig {
  const c=input as CloudflareWeeklyConfig;
  const rowBudget=c?.limits&&typeof c.limits==='object'&&('reportedRowsRead' in c.limits||'reportedRowsWritten' in c.limits);
  const credentialKeys=['amazonId','amazonSecret','amazonVersion','cloudflare',...(c?.credentials?.openai?['openai']:[]),...(c?.credentials?.stagingAuthSecret?['stagingAuthSecret']:[])].sort().join(',');
  if(!exact(c,['accountId','backfillLimit','catalog','catalogRevision','codeSha','credentials','database','environment','inputs','limits','publication','retention','runId','schemaVersion','vectorIndex',...(c?.cadence?['cadence']:[])].sort().join(','))
    ||c.schemaVersion!==1||!KEY.test(c.runId)||!KEY.test(c.catalogRevision)||c.catalogRevision.length>64||!/^[a-f0-9]{40}$/.test(c.codeSha)
    ||!Number.isInteger(c.backfillLimit)||c.backfillLimit<0||c.backfillLimit>25
    ||!exact(c.credentials,credentialKeys)||!c.cadence&&!c.credentials.openai
    ||c.environment==='staging'&&!c.credentials.stagingAuthSecret
    ||![c.credentials.amazonId,c.credentials.amazonSecret,...(c.credentials.openai?[c.credentials.openai]:[]),...(c.credentials.stagingAuthSecret?[c.credentials.stagingAuthSecret]:[])].every(keychain)
    ||!['2.1','2.2','2.3','3.1','3.2','3.3'].includes(c.credentials.amazonVersion)
    ||!exact(c.limits,rowBudget
      ?'reportedRowsRead,reportedRowsWritten,requests,statements':'requests,statements')
    ||!Number.isInteger(c.limits.requests)||c.limits.requests<2||c.limits.requests>10000
    ||!Number.isInteger(c.limits.statements)||c.limits.statements<1||c.limits.statements>25000
    ||rowBudget&&(!Number.isInteger(c.limits.reportedRowsRead)||!Number.isInteger(c.limits.reportedRowsWritten))
    ||c.limits.reportedRowsRead!==undefined&&(!Number.isInteger(c.limits.reportedRowsRead)||c.limits.reportedRowsRead<1||c.limits.reportedRowsRead>3_000_000)
    ||c.limits.reportedRowsWritten!==undefined&&(!Number.isInteger(c.limits.reportedRowsWritten)||c.limits.reportedRowsWritten<1||c.limits.reportedRowsWritten>50_000)
    ||!exact(c.inputs,c.inputs?.originalVectors?'context,originalVectors,previous,rights':'context,previous,rights'))throw new Error('weekly_configuration_invalid');
  if(c.cadence&&(!exact(c.cadence,`${Object.hasOwn(c.cadence,'admitAsins')?'admitAsins,':''}day,featuredIds${Object.hasOwn(c.cadence,'photosOnly')?',photosOnly':''}${c.cadence.runKey===undefined?'':',runKey'}`)
    ||c.cadence.admitAsins!==undefined&&(c.cadence.photosOnly||!c.cadence.runKey||!Array.isArray(c.cadence.admitAsins)
      ||!c.cadence.admitAsins.length||c.cadence.admitAsins.length>10||new Set(c.cadence.admitAsins).size!==c.cadence.admitAsins.length
      ||c.cadence.admitAsins.some(id=>! /^[A-Z0-9]{10}$/.test(id)))
    ||Object.hasOwn(c.cadence,'photosOnly')&&c.cadence.photosOnly!==true
    ||c.cadence.runKey!==undefined&&(!validCatalogRunKey(c.cadence.runKey)||c.cadence.runKey!==c.runId)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(c.cadence.day)
    ||pacificCatalogCalendar(`${c.cadence.day}T12:00:00Z`).day!==c.cadence.day||c.backfillLimit!==0
    ||!Array.isArray(c.cadence.featuredIds)||c.cadence.featuredIds.length>100||new Set(c.cadence.featuredIds).size!==c.cadence.featuredIds.length
    ||c.cadence.featuredIds.some(id=>!/^[A-Z0-9]{10}$/.test(id))))throw new Error('weekly_cadence_invalid');
  validateRunnerCheckConfig({schemaVersion:1,environment:c.environment,accountId:c.accountId,database:c.database,vectorIndex:c.vectorIndex,
    catalog:c.catalog,cloudflareReadToken:c.credentials.cloudflare});
  const p=validatePublicationConfig(c.publication);
  if(p.environment!==c.environment||p.accountId!==c.accountId||p.database.id!==c.database.id||p.database.name!==c.database.name
    ||p.indexName!==c.vectorIndex.name||p.codeSha!==c.codeSha)throw new Error('weekly_publication_scope');
  for(const ref of Object.values(c.inputs)){
    if(!exact(ref,'observedAt,path,sha256')||!isAbsolute(ref.path)||!HASH.test(ref.sha256))throw new Error('weekly_input_reference');canonicalTime(ref.observedAt);
  }
  return structuredClone(c);
}
async function reviewedBytes(path:string,digest:string,repo:string,max=512*1024,canonical=false) {
  if(!isAbsolute(path)||!HASH.test(digest))throw new Error('weekly_private_input');
  const stat=await lstat(path);const actual=await realpath(path);const rel=relative(await realpath(repo),actual);
  if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==process.getuid?.()||stat.mode&0o077||stat.size>max
    ||rel===''||!rel.startsWith('..')&&!isAbsolute(rel))throw new Error('weekly_private_input');
  const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const opened=await handle.stat();if(opened.ino!==stat.ino||opened.dev!==stat.dev)throw new Error('weekly_private_input');
    const chunks:Buffer[]=[];let length=0;const hasher=createHash('sha256');
    for(;;){const chunk=Buffer.alloc(Math.min(WORKSPACE_BLOB_LIMITS.chunkBytes,max+1-length)),part=await handle.read(chunk);
      if(!part.bytesRead)break;length+=part.bytesRead;if(length>max)throw new Error('weekly_private_input');
      const bytes=chunk.subarray(0,part.bytesRead);chunks.push(bytes);hasher.update(bytes);}
    const after=await handle.stat();
    const bytes=Buffer.concat(chunks),actualDigest=canonical?sha256(canonicalJson(JSON.parse(bytes.toString('utf8')))):hasher.digest('hex');
    if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs||actualDigest!==digest)throw new Error('weekly_input_digest');
    return bytes;
  }finally{await handle.close();}
}
async function reviewed(path:string,digest:string,repo:string,max=512*1024,canonical=false) {
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await reviewedBytes(path,digest,repo,max,canonical)));
}
// Strip product/candidate bodies and search-theme strings from phase counts.
// Token/cost usage remains exact private operational evidence, not analytics.
function numbers(value:unknown):unknown {
  if(typeof value==='number')return Number.isFinite(value)?value:null;
  if(typeof value==='boolean'||value===null)return value;
  if(value&&typeof value==='object'&&!Array.isArray(value))return Object.fromEntries(Object.entries(value)
    .filter(([,v])=>v===null||['number','boolean','object'].includes(typeof v)&&!Array.isArray(v)).map(([k,v])=>[k,numbers(v)]));
  return null;
}
function finalization(input:Record<string,unknown>) {
  return{counts:numbers(input.counts),timingsMs:input.timingsMs,usage:input.usage,
    warnings:(Array.isArray(input.warnings)?input.warnings:[]).map(w=>({phase:String(w.phase||'unknown').slice(0,40),reasonCode:String(w.reasonCode||'unknown').slice(0,80)}))};
}
// Snapshot/projection receipts bind JSON.stringify order, not canonicalJson.
// Preserve that reviewed byte order through the workspace's canonical store.
export async function putOrdered(ws:RunWorkspace,value:unknown,observedAt:string,kind:'phase'|'publication'='publication'){
  const bytes=JSON.stringify(value);
  return Buffer.byteLength(canonicalJson(bytes))<=WORKSPACE_BLOB_LIMITS.artifactBytes
    ?ws.putArtifact(bytes,{kind,observedAt}):ws.putBlob(Buffer.from(bytes,'utf8'),{kind,observedAt});
}
export async function readOrdered<T>(ws:RunWorkspace,ref:ArtifactRef):Promise<T>{
  const value=await ws.readArtifact(ref);
  return JSON.parse(typeof value==='string'?value:new TextDecoder('utf-8',{fatal:true}).decode(await ws.readBlob(ref))) as T;
}
async function readOriginalVectors(ws:RunWorkspace,ref:ArtifactRef):Promise<Record<string,unknown>> {
  const value=await ws.readArtifact(ref);
  return(value&&typeof value==='object'&&!Array.isArray(value)&&value.type==='run-workspace-blob'
    ?JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await ws.readBlob(ref))):value) as Record<string,unknown>;
}
async function providerEnvironment(config:CloudflareWeeklyConfig,resolveToken:(ref:KeychainRef)=>Promise<string>,needsModel:boolean) {
  if(needsModel&&!config.credentials.openai)throw new Error('weekly_model_credentials_missing');
  const names=Object.keys(process.env).filter(key=>/^(CATALOG_|AMAZON_|OPENAI_|GOOGLE_SEARCH_|POSTGRES_|VERCEL_)/.test(key));
  const values={...Object.fromEntries(names.map(key=>[key,undefined])),AMAZON_ASSOCIATE_TAG:config.catalog.associateTag,
    AMAZON_MARKETPLACE:config.catalog.marketplace,AMAZON_CREATORS_CREDENTIAL_VERSION:config.credentials.amazonVersion,
    AMAZON_CREATORS_CREDENTIAL_ID:await resolveToken(config.credentials.amazonId),AMAZON_CREATORS_CREDENTIAL_SECRET:await resolveToken(config.credentials.amazonSecret),
    OPENAI_API_KEY:needsModel?await resolveToken(config.credentials.openai!):undefined};
  return values;
}
async function scopedProviders<T>(values:Awaited<ReturnType<typeof providerEnvironment>>,action:()=>Promise<T>) {
  const old=Object.fromEntries(Object.keys(values).map(key=>[key,process.env[key]]));
  try{for(const [key,value]of Object.entries(values)){if(value===undefined)delete process.env[key];else process.env[key]=value;}amazonCreators.clearToken();return await action();}
  finally{amazonCreators.clearToken();for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
async function releaseExact(db:CatalogD1,owner:MutationOwner){
  try{await releaseMutationOwnership(db,owner);}catch{
    const rows=(await db.prepare(`SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND phase='idle'
      AND generation=? AND mutation_epoch=? AND external_pending=0`).bind(owner.environment,owner.indexName,owner.generation,owner.epoch).all()).results;
    if(rows.length!==1)throw new Error('weekly_release_uncertain');
  }
}
async function mutationKnown(db:CatalogD1,deliveryId:string){
  const row=(await db.prepare('SELECT mutation_reference FROM catalog_vector_deliveries WHERE delivery_id=?').bind(deliveryId).all()).results[0];
  return typeof row?.mutation_reference==='string';
}
export interface WeeklyDriverOptions {
  command:'preflight'|'start'|'resume'|'status';configPath:string;configSha256:string;workspace:string;
  /** Explicit already-recorded same-run recovery; never an implicit new run. */
  recovery?:{path:string;sha256:string;configPath:string;configSha256:string};
  approval?:{path:string;sha256:string};
  /** Separately reviewed continuation of one retained, failed upload. */
  reviewedUploadRetry?:{path:string;sha256:string};
  cadenceOnly?:boolean;
}
type Dependencies={repository?:string;fetch?:typeof fetch;resolveToken?:(ref:KeychainRef)=>Promise<string>;resolveWranglerOAuth?:()=>Promise<string>;now?:()=>string;
  finishRecovery?:{budget:PublicationFinishBudget;authorization:NonNullable<Parameters<typeof executePublication>[0]['finishAuthorization']>;terminalReceiptOnly?:true};
  publication?:Parameters<typeof executePublication>[0]['dependencies'];cadence?:Parameters<typeof dailyCatalogPhases>[0]};

/** Only an already admitted, activated permanent release can enter this path.
 * Normal supplier artifacts remain expired. No provider phase/build/upload or
 * activation is created; the ordinary publisher settles the existing permit. */
export async function settleActivatedPermanentWeekly(input:{db:CatalogD1 & {providerIdentity:string};ws:RunWorkspace;config:CloudflareWeeklyConfig;configSha256:string;
  token:string;publication:NonNullable<Dependencies['publication']>;reviewedUploadRetry:Parameters<typeof executePublication>[0]['reviewedUploadRetry'];
  finish:NonNullable<Dependencies['finishRecovery']>}){
  const {db,ws,config}=input;
  let saved=await ws.readCheckpoint({controlOnly:true});
  if(!saved?.checkpoint.control?.publication)throw Error('weekly_permanent_settlement_invalid');
  if(!saved.checkpoint.control.publication.permit&&!(await ws.publicationFinishBudget()))throw Error('weekly_permanent_settlement_invalid');
  const releaseId=saved.checkpoint.control.publication.intent?.releaseId;
  if(!releaseId||releaseId!==config.publication.releaseId)throw Error('weekly_permanent_settlement_invalid');
  const control=await ws.readPermanentFinalization('revision') as unknown as ReturnType<typeof approvedRevisionControl>;
  const save=async(phase:'published'|'finalized',owner:MutationOwner|null)=>{
    saved=await ws.readCheckpoint({controlOnly:true});if(!saved?.checkpoint.control)throw Error('weekly_checkpoint_missing');
    saved=await ws.writeControlCheckpoint(saved.sha256,{phase,owner,control:saved.checkpoint.control});
  };
  if(saved.checkpoint.phase!=='published'&&saved.checkpoint.phase!=='finalized'){
    const p=saved.checkpoint.control!.publication!,owner=saved.checkpoint.owner;
    if(!owner)throw Error('weekly_permanent_settlement_invalid');
    const revision=input.finish.terminalReceiptOnly||p.stage==='published'?null:await hydrateApprovedRevision(db,owner,control);
    const result=await executePublication({db,workspace:ws,owner,revision,...(revision?{approvedCatalog:revision}:{}),
      ...(input.finish.terminalReceiptOnly?{acceptedReceiptOnly:true as const}:{}),
      requestId:p.requestId,runReference:p.runReference,config:config.publication,credentials:{cloudflareToken:input.token},
      dependencies:input.publication,reviewedUploadRetry:input.reviewedUploadRetry,finishAuthorization:input.finish.authorization});
    if(result.state!=='published')return{...result,budget:await ws.budget()};
    if(result.releaseId!==releaseId)throw Error('weekly_publication_receipt_missing');
    const receipt=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(releaseId).all()).results;
    if(receipt.length!==1)throw Error('weekly_publication_receipt_missing');
    const seal=await createPublishedApprovedCatalogSealFromControl(db,control,
      {releaseId,receiptSha256:sha256(canonicalJson(receipt[0]))},p.vectorPlan);
    await ws.recordCatalogSuccessor(seal);await save('published',null);
  }
  if(saved!.checkpoint.phase==='finalized')return{state:'finalized',runId:config.runId,catalogSeal:await ws.catalogSuccessor(),budget:await ws.budget()};
  if(!await ws.catalogSuccessor())throw Error('weekly_permanent_successor_missing');
  const p=saved!.checkpoint.control!.publication!;
  const summary=await ws.readPermanentFinalization('summary') as Record<string,unknown>;
  const finish={...summary,status:'completed',counts:{...summary.counts as object,
    publication:{status:'published',releaseId,receiptSha256:p.receiptSha256}}};
  let owner=saved!.checkpoint.owner;
  const scope={environment:config.environment,indexName:config.vectorIndex.name};
  // A retained finalizer owner is reused; an idle scope after a lost release
  // response must never be claimed into yet another generation.
  if(!owner){owner=await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:config.runId+':finalize',
    operationKey:sha256(`finalize:${input.configSha256}`)});if(!owner)throw Error('weekly_finalize_owner');await save('published',owner);}
  const cursor={current:owner},telemetry=createD1CatalogTelemetryStore({db,owner,ownerCursor:cursor,runId:config.runId,catalogRevision:config.catalogRevision});
  const prior=await telemetry.loadCatalogRun(config.runId);
  if(prior?.run.status==='completed'){
    if(canonicalJson(prior.run.counts)!==canonicalJson(finish.counts))throw Error('weekly_finalization_mismatch');
    const actual=await readMutationOwner(db,scope);
    if(actual){
      if(canonicalJson({...actual,epoch:owner.epoch})!==canonicalJson(owner)||actual.epoch<owner.epoch||actual.epoch>owner.epoch+1)
        throw Error('weekly_finalize_owner');
      cursor.current=actual;await save('published',actual);
    }
  }else{
    await telemetry.finishCatalogRun(config.runId,finish);const actual=await telemetry.loadCatalogRun(config.runId);
    if(actual?.run.status!=='completed'||canonicalJson(actual.run.counts)!==canonicalJson(finish.counts))throw Error('weekly_finalization_mismatch');
    await save('published',cursor.current);
  }
  await releaseExact(db,cursor.current);await save('finalized',null);
  return{state:'finalized',runId:config.runId,releaseId,receiptSha256:p.receiptSha256,
    catalogSeal:await ws.catalogSuccessor(),budget:await ws.budget()};
}

/** Concrete opt-in local command; no scheduling, schema enablement or ambient
 * credential fallback. A post-phase approval is independently reviewed/pinned.
 * The default Goose CLI/backend and its schedule are intentionally untouched.
 */
export async function runCloudflareWeekly(options:WeeklyDriverOptions,dependencies:Dependencies={}) {
  const repo=dependencies.repository||repository;const now=dependencies.now||(()=>new Date().toISOString());
  const original=validateCloudflareWeeklyConfig(await reviewed(options.configPath,options.configSha256,repo,32768));
  let config=original,adoption:ExecutionAdoption|null=null;
  if(options.recovery){
    if(!['resume','status'].includes(options.command))throw new Error('weekly_recovery_command');
    adoption=await reviewed(options.recovery.path,options.recovery.sha256,repo) as ExecutionAdoption;
    validateExecutionAdoption(adoption);
    config=validateCloudflareWeeklyConfig(await reviewed(options.recovery.configPath,options.recovery.configSha256,repo,32768));
    validateExecutionAdoptionConfigs(original,config,adoption);
    if(adoption.original.configSha256!==options.configSha256||adoption.effective.configSha256!==options.recovery.configSha256)
      throw new Error('weekly_recovery_config');
  }
  if(options.cadenceOnly&&!config.cadence)throw new Error('weekly_daily_cadence_required');
  if(config.cadence&&['start','resume'].includes(options.command)&&!dependencies.cadence)
    return withCatalogCadence({workspace:options.workspace,repository:repo,now,runKey:config.cadence.runKey},(cadence:Dependencies['cadence'])=>runCloudflareWeekly(options,{...dependencies,cadence}));
  if(options.approval&&options.command!=='resume')throw new Error('weekly_approval_requires_phase_resume');
  if(options.reviewedUploadRetry&&options.command!=='resume')throw new Error('weekly_upload_retry_requires_resume');
  let reviewedUploadRetry=options.reviewedUploadRetry
    ?await reviewed(options.reviewedUploadRetry.path,options.reviewedUploadRetry.sha256,repo) as Parameters<typeof executePublication>[0]['reviewedUploadRetry']:undefined;
  const scope={environment:config.environment,indexName:config.vectorIndex.name};const resolveToken=dependencies.resolveToken||resolveReadToken;
  const workspaceOptions:RunWorkspaceOptions={directory:options.workspace,repository:adoption?original.publication.sourceRoot:repo,mode:options.command==='start'?'create':'resume',
    runId:original.runId,configSha256:options.configSha256,codeSha:original.codeSha,
    scope:{...scope,accountId:config.accountId,databaseId:config.database.id,databaseName:config.database.name,workerName:config.publication.workerName},
    retention:original.retention,budgetCaps:{httpRequests:original.limits.requests,sqlStatements:original.limits.statements},
    ...(config.cadence?{requestLimit:'observe' as const}:{}),
    ...(adoption?{expectedManifestSha256:adoption.original.manifestSha256}:{}),now};
  if(options.command==='status'){
    const report=await readRunWorkspace(workspaceOptions);
    return{state:'status',runId:config.runId,phase:report.checkpoint?.checkpoint.phase??'created',
      resumeStates:WEEKLY_RESUME_STATES,...report};
  }
  // Creating the first verified Worker/catalog prior is a separate audited
  // operator step, never an implicit side effect of a routine weekly run.
  if(config.publication.prior===null){
    let prior;
    try{prior=options.command==='resume'?(await readRunWorkspace(workspaceOptions)).checkpoint?.checkpoint:null;}
    catch{throw new Error('weekly_bootstrap_required');}
    if(!prior||!(['publishing','attention'].includes(prior.phase)&&resolving(prior))
      &&!['published','finalized'].includes(prior.phase))throw new Error('weekly_bootstrap_required');
  }
  if(options.command==='preflight')return checkCloudflareRunner({schemaVersion:1,environment:config.environment,accountId:config.accountId,
    database:config.database,vectorIndex:config.vectorIndex,catalog:config.catalog,cloudflareReadToken:config.credentials.cloudflare},
  {resolveToken,resolveWranglerOAuth:dependencies.resolveWranglerOAuth,fetch:dependencies.fetch});
  if(!['start','resume'].includes(options.command))throw new Error('weekly_command');
  // This driver supplies the ledger and owns the sender's lifetime. A caller's
  // already-accounted sender may belong to another run; never double-charge or
  // silently adopt its workspace. The injection seam here is raw transport only.
  const observationSend=dependencies.publication?.observationFetch??dependencies.publication?.fetch??dependencies.fetch??fetch;
  if([dependencies.fetch,dependencies.publication?.fetch,observationSend].some(isAccountedPublicationFetch))
    throw new Error('weekly_observation_fetch_already_accounted');
  if(isAccountedPublicationUploadCommand(dependencies.publication?.command))throw new Error('weekly_upload_command_already_accounted');
  if(executing)throw new Error('weekly_process_busy');executing=true;
  let workspace:RunWorkspace|undefined;
  try{
    const head=execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
    if(head!==config.codeSha||resolve(config.publication.sourceRoot)!==resolve(repo)
      ||execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:repo,encoding:'utf8'}).trim())throw new Error('weekly_source_mismatch');
    workspace=await openRunWorkspace(workspaceOptions);const ws=workspace;
    if(adoption?canonicalJson(ws.execution)!==canonicalJson(adoption):ws.execution!==null)
      throw new Error('weekly_execution_adoption_required');
    const finish=dependencies.finishRecovery;
    if(finish){
      const normal=await ws.readCheckpoint({controlOnly:true});
      const acknowledged=normal?.checkpoint.pins.publicationUploadAcknowledged&&!normal.checkpoint.pins.publicationUploadReview;
      if(options.command!=='resume'||(!adoption||!reviewedUploadRetry)&&!acknowledged||finish.budget.approvalReference!==finish.authorization.authorizationSha256
        ||finish.budget.versionReference!==finish.authorization.versionReference
        ||!acknowledged&&finish.authorization.activationDeadline>original.retention.rules.publication.notAfter)
        throw new Error('weekly_finish_recovery_invalid');
    }
    if(adoption){
      const oldRoot=original.publication.sourceRoot;
      if(execFileSync('git',['rev-parse','HEAD'],{cwd:oldRoot,encoding:'utf8'}).trim()!==original.codeSha
        ||execFileSync('git',['status','--porcelain','--untracked-files=all'],{cwd:oldRoot,encoding:'utf8'}).trim())throw new Error('weekly_original_source_mismatch');
      const prior=await ws.readCheckpoint({controlOnly:true});
      if(!prior?.checkpoint.control?.publication?.permit&&now()>=adoption.contexts.replacement.cutoff&&!finish)throw new Error('weekly_recovery_context_elapsed');
    }
    if(finish)await ws.grantPublicationFinishBudget(finish.budget);
    // The owned read sender uses this exact durable ledger. It is separate
    // from normal publication mutation traffic; it can never activate a Worker.
    const networkScope={accountId:config.accountId,workerName:config.publication.workerName,indexName:config.vectorIndex.name,
      databaseId:config.database.id,identityOrigin:config.publication.identityOrigin,
      ...(config.publication.semanticSearch?.derivedCatalog?{derivedIndexName:config.publication.semanticSearch.derivedCatalog.indexName}:{})};
    const generalSend=accountedPublicationFetch(ws,dependencies.fetch??fetch,networkScope);
    const publication={...dependencies.publication,fetch:accountedPublicationFetch(ws,dependencies.publication?.fetch??dependencies.fetch??fetch,networkScope),
      command:accountedPublicationUploadCommand({workspace:ws,scope:networkScope,
        send:dependencies.publication?.fetch??dependencies.fetch,command:dependencies.publication?.command}),
      observationFetch:accountedPublicationReadFetch(ws,observationSend,networkScope)};
    const permanentFinalization=Boolean(finish&&(await ws.budgetRowsReadCeiling()!==null||!adoption));
    if(finish?.terminalReceiptOnly&&!permanentFinalization)throw Error('weekly_terminal_scope_required');
    if(!permanentFinalization)await ws.purgeExpired();
    let saved=await ws.readCheckpoint({controlOnly:true});
    if(config.cadence&&!reviewedUploadRetry&&saved?.checkpoint.control?.publication){
      try{reviewedUploadRetry=await routineUploadRetry(ws,now());}
      catch(error){return{state:'attention',phase:saved.checkpoint.phase,errorCode:safeCode(error),budget:await ws.budget()};}
    }
    if(!permanentFinalization&&saved&&['phases_running','phase_failed','attention','finalized'].includes(saved.checkpoint.phase)
      &&!(saved.checkpoint.phase==='attention'&&(resolving(saved.checkpoint)||reviewedUploadResume(saved,reviewedUploadRetry))))
      return{state:saved.checkpoint.phase==='finalized'?'finalized':'attention',phase:saved.checkpoint.phase,
        ...(saved.checkpoint.phase==='finalized'?{catalogSeal:await ws.catalogSuccessor()??undefined}:{}),budget:await ws.budget()};
    const token=await resolveCloudflareCredential(config.credentials.cloudflare,resolveToken,dependencies.resolveWranglerOAuth);
    const identityAuthorization=async()=>config.credentials.stagingAuthSecret
      ?`Basic ${Buffer.from(`staging:${await resolveToken(config.credentials.stagingAuthSecret)}`).toString('base64')}`:undefined;
    const admittedReadCap=await ws.budgetRowsReadCeiling()??finish?.budget.reportedRowsRead;
    const db=await createCatalogD1Rest({accountId:config.accountId,databaseId:config.database.id,databaseName:config.database.name,
      token,fetch:dependencies.fetch,...(config.cadence?{requestLimit:'observe' as const}:{}),limits:finish?{...config.limits,requests:(await ws.budgetCeiling()).httpRequests,
        statements:(await ws.budgetCeiling()).sqlStatements,reportedRowsRead:admittedReadCap}:config.limits,accounting:{scope:{accountId:config.accountId,databaseId:config.database.id,databaseName:config.database.name},
        initial:await ws.budget(),reserve:async value=>{
          // Broad proof batches retain80k headroom. The explicit receipt-only
          // lane forbids hydration/scans and bounds its keyed/native batches at
          // 5k; both retain the SAME absolute admitted read ceiling.
          if(finish&&value.units.sqlStatements&&(await ws.budget()).knownRowsRead+(finish.terminalReceiptOnly?5000:80000)>admittedReadCap!)
            throw new Error('weekly_finish_read_margin');
          await ws.reserveBudget(value);
        },settle:(id,value)=>ws.settleBudget(id,value)}});
    if(permanentFinalization)return await settleActivatedPermanentWeekly({db,ws,config,configSha256:options.configSha256,token,
      publication,reviewedUploadRetry,finish:finish!});
    // Expiry never hides the minimal control identity required to resolve an
    // already-dispatched activation. No expired snapshot/evidence is read here.
    let cp:WorkspaceCheckpoint;
    try{const full=await ws.readCheckpoint();cp=full?.checkpoint||{phase:'created',owner:null,state:{},pins:{},phaseComplete:null};saved=full;}
    catch(error){
      if(!saved||!resolving(saved.checkpoint)||!saved.checkpoint.owner)throw error;
      const result=await executePublication({db,owner:saved.checkpoint.owner,revision:null,requestId:saved.checkpoint.control!.publication!.requestId,
        runReference:saved.checkpoint.control!.publication!.runReference,workspace:ws,config:config.publication,credentials:{cloudflareToken:token,
          identityAuthorization:await identityAuthorization()},dependencies:publication,reviewedUploadRetry,finishAuthorization:finish?.authorization});
      return result.state==='published'?{state:'attention',phase:'published',reason:'finalization_requires_review',releaseId:result.releaseId,
        receiptSha256:result.receiptSha256,budget:await ws.budget()}:{...result,budget:await ws.budget()};
    }
    const hydrationOwner=saved?await recoverMarkedReviewedActivation({db,workspace:ws,saved:{sha256:saved.sha256,checkpoint:cp},config:config.publication,
      retry:reviewedUploadRetry,finishAuthorization:finish?.authorization}):null;
    const write=async(patch:Partial<WorkspaceCheckpoint>)=>{const value={...cp,...patch};const next=await ws.writeCheckpoint(saved?.sha256||null,value);
      saved=next;cp=next.checkpoint;};
    if(cp.phase==='attention'&&(resolving(cp)||reviewedUploadResume(saved,reviewedUploadRetry)))cp={...cp,phase:'publishing'};
    const state=()=>cp.state as Record<string,unknown>;
    if(!saved){
      if(options.command!=='start')throw new Error('weekly_checkpoint_missing');
      if((await db.prepare('SELECT id FROM catalog_runs WHERE id=?').bind(config.runId).all()).results.length)throw new Error('weekly_run_exists');
      const pins:Record<string,ArtifactRef>={};
      for(const [label,ref]of Object.entries(config.inputs)){
        if(label==='originalVectors'||label==='previous'){
          // The approved digest binds the RAW file (including order/whitespace),
          // not a reconstructed JS-number vector or a canonical JSON rewrite.
          const bytes=await reviewedBytes(ref.path,ref.sha256,repo,WORKSPACE_BLOB_LIMITS.bytes);
          const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
          pins[label]=bytes.length>WORKSPACE_BLOB_LIMITS.artifactBytes||Buffer.byteLength(canonicalJson(label==='previous'?JSON.stringify(value):value))>WORKSPACE_BLOB_LIMITS.artifactBytes
            ?await ws.putBlob(bytes,{kind:'phase',observedAt:ref.observedAt})
            :label==='previous'?await putOrdered(ws,value,ref.observedAt,'phase'):await ws.putArtifact(value,{kind:'phase',observedAt:ref.observedAt});continue;
        }
        const value=await reviewed(ref.path,ref.sha256,repo);
        pins[label]=await ws.putArtifact(value,{kind:'phase',observedAt:ref.observedAt});
      }
      await write({pins});
    }
    if(cp.phase==='created'){
      let needsModel=!config.cadence;
      if(config.cadence){
        if(pacificCatalogCalendar(now()).day!==config.cadence.day)throw new Error('weekly_cadence_day_changed');
        const phases=await dailyCatalogPhases(dependencies.cadence!,config.cadence.featuredIds,config.cadence.photosOnly,config.cadence.admitAsins);
        if(!phases.length)return{state:'skipped',reason:'cadence_already_reserved'};
        needsModel=phases.some(p=>p.discoveryNewOnly||p.enrichSelectedExisting);
        if(needsModel&&!config.credentials.openai)throw new Error('weekly_model_credentials_missing');
      }
      // Resolve once before any DB ownership/telemetry write or daily reservation.
      // An unreadable existing Keychain item must not strand a writing owner or
      // consume the merchant allowance. Values remain in this invocation only;
      // resume after completed phases never resolves merchant/model credentials.
      const environment=await providerEnvironment(config,resolveToken,needsModel);
      const owner=await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:config.runId,operationKey:sha256(`weekly:${options.configSha256}`)});
      if(!owner)throw new Error('weekly_owner_busy');const cursor={current:owner};await write({phase:'phases_running',owner});
      const intent=await ws.readArtifact(cp.pins.rights) as unknown as {rightsById:Record<string,never>;reviewedDeleteReference?:string};
      const evidence=createCatalogProviderEvidence({reviewedRightsById:intent.rightsById,reviewedDeleteReference:intent.reviewedDeleteReference,associateTag:config.catalog.associateTag,saveReceipt:input=>ws.saveReceipt(input),
        saveReviewedShort:async input=>ws.putArtifact({schemaVersion:1,kind:'reviewed-short-copy',...input},{kind:'phase',observedAt:input.reviewedAt}),now});
      const maintenance=createD1CatalogMaintenanceStore({db,owner,ownerCursor:cursor,runId:config.runId,catalogRevision:config.catalogRevision,
        intent:evidence.intent,preservePermanentListings:Boolean(config.cadence)});
      const telemetry=createD1CatalogTelemetryStore({db,owner,ownerCursor:cursor,runId:config.runId,catalogRevision:config.catalogRevision});
      try{await scopedProviders(environment,async()=>{
        const {runWeeklyCatalogWithBackend}=await import('../ops/catalog-weekly.mjs');
        const backend={runId:config.runId,gitSha:config.codeSha,backfillLimit:config.backfillLimit,
          maintenanceStore:maintenance,telemetryStore:telemetry,providerEvidence:evidence,deferPublicationFinalization:true,
          async publish(input:{finalization:Record<string,unknown>}){
            const phaseComplete=await ws.putArtifact(finalization(input.finalization),{kind:'publication',observedAt:now()});
            await write({phase:'phases_complete',owner:cursor.current,phaseComplete});return{status:'pending'};
          },async finalizeRun(id:string,input:Record<string,unknown>){await telemetry.finishCatalogRun(id,input);return telemetry.loadCatalogRun(id);}};
        if(config.cadence)await runDailyCatalogWithBackend({...backend,cadence:dependencies.cadence!,featuredIds:config.cadence.featuredIds,
          photosOnly:config.cadence.photosOnly,admitAsins:config.cadence.admitAsins,preservePermanentListings:true});
        else await runWeeklyCatalogWithBackend(backend);
      });}catch(error){
        const durable=await ws.readCheckpoint();if(durable){saved=durable;cp=durable.checkpoint;}
        // Exhaustion can also be the accounting half of the backend's paired
        // phase/finalization failure. Do not spend another D1 read to diagnose
        // it or leave phases_running as if the merchant batch could be retried.
        const budgetError=[error,...(error instanceof AggregateError?error.errors:[])].find(value=>value instanceof Error
          &&['catalog_d1_budget_exhausted','catalog_d1_reported_usage_exceeded'].includes(value.message)) as Error|undefined;
        const errorCode=budgetError?.message??safeCode(error);
        if(cp.phase==='phases_running'){
          const row=budgetError?null:await telemetry.loadCatalogRun(config.runId);
          await write({phase:row&&['partial','failed'].includes(String(row.run.status))?'phase_failed':'attention',owner:cursor.current,
            state:{errorCode}});
        }
        return{state:'attention',phase:cp.phase,errorCode,budget:await ws.budget()};
      }
    }
    const adapters=createVectorizeRestAdapters({...scope,accountId:config.accountId,token,fetch:generalSend});
    if(cp.phase==='phases_complete'||cp.phase==='draining'){
      // Review is separate from running paid phases. Never synthesize an envelope
      // from whichever mutable rows happen to be ready when this command resumes.
      if(!cp.pins.approval){
        if(!options.approval)return{state:'pending',phase:cp.phase,reason:'awaiting_reviewed_approval',budget:await ws.budget()};
        const approval=await reviewed(options.approval.path,options.approval.sha256,repo);
        if(approval.runId!==config.runId||approval.catalogRevision!==config.catalogRevision)throw new Error('weekly_approval_run');
        const pin=await ws.putArtifact(approval,{kind:'publication',observedAt:now()});await write({pins:{...cp.pins,approval:pin}});
      }else if(options.approval){const approval=await reviewed(options.approval.path,options.approval.sha256,repo);
        if(sha256(canonicalJson(approval))!==cp.pins.approval.sha256)throw new Error('weekly_approval_rewrite');}
      await write({phase:'draining'});
      for(let n=0;n<200;n++){
        const sequence=Number(state().outboxSequence)||Number((await db.prepare("SELECT sequence FROM vector_sync_outbox WHERE source_revision=? AND status='pending' ORDER BY sequence LIMIT 1")
          .bind(config.catalogRevision).all()).results[0]?.sequence)||0;
        if(!sequence)break;
        await write({state:{...state(),outboxSequence:sequence}});
        for(let pass=0;pass<4;pass++){
          const result=await deliverOwnedOutboxEvent({db,owner:cp.owner!,sequence,catalogRevision:config.catalogRevision,adapters,
            loadPayload:event=>loadMaintenanceVectorPayload(db,event)});await write({owner:result.owner});
          if(result.state==='expired')return{state:'attention',phase:cp.phase,reason:'expired_vector',budget:await ws.budget()};
          if(result.state==='complete'){await write({state:{...state(),outboxSequence:null}});break;}
          if(pass===3||result.errorCode==='mutation_unknown'&&!await mutationKnown(db,result.deliveryId))
            return{state:'pending',phase:cp.phase,errorCode:result.errorCode,budget:await ws.budget()};
        }
        if(n===199)throw new Error('weekly_outbox_bound');
      }
      const prior=await readOrdered(ws,cp.pins.previous) as ApprovedCatalogSeal|PermanentCatalogSeal;
      const context=await ws.readArtifact(ws.execution?.contexts.ref??cp.pins.context) as unknown as ApprovedCohortRequest['context'];
      const previous=prior.kind==='permanent-catalog-seal'?await reconstructPermanentSnapshot(db,cp.owner!,prior)
        :['approved-catalog-seal'].includes(prior.kind)
        ?await readApprovedPrior(db,cp.owner!,prior,context):prior as unknown as ApprovedCohortRequest['previous'];
      const request={previous,context,scope,codeSha:config.codeSha,
        ...(isPersistentCatalogSeal(prior)?{predecessor:prior}:{}),
        approval:await ws.readArtifact(cp.pins.approval),approvalSha256:cp.pins.approval.sha256} as unknown as ApprovedCohortRequest;
      approvedCohortOperationKey(request);
      const pin=await putOrdered(ws,approvedRequestControl(request),now());await write({phase:'freezing',pins:{...cp.pins,request:pin}});
    }
    let revision:ApprovedCohortRevision|undefined;
    if(cp.phase==='freezing'){
      const stored=await readOrdered<ReturnType<typeof approvedRequestControl>>(ws,cp.pins.request);
      const request=stored.kind==='approved-request-control'?await hydrateApprovedRequest(db,cp.owner!,stored):stored as unknown as ApprovedCohortRequest;
      if(cp.pins.preparedRevision)revision=await hydrateApprovedRevision(db,cp.owner!,
        await readOrdered<ReturnType<typeof approvedRevisionControl>>(ws,cp.pins.preparedRevision));
      else{
        const claim={phase:'freezing' as const,ownerReference:`${config.runId}:freeze`,operationKey:approvedCohortOperationKey(request)};
        let owner=await claimMutationOwnership(db,scope,claim);
        if(!owner){if(cp.owner?.phase!=='writing')throw new Error('weekly_freeze_claim');await releaseExact(db,cp.owner);owner=await claimMutationOwnership(db,scope,claim);}
        if(!owner)throw new Error('weekly_freeze_claim');await write({owner});
        owner=await repairApprovedNewSlugs(db,owner,request,now());await write({owner});
        const prepared=await prepareOwnedApprovedCohortPlan({db,owner,request,adapters});revision=prepared.revision;
        const pin=await putOrdered(ws,approvedRevisionControl(revision),approvedArtifactObservedAt(revision.snapshot,now(),config.retention.rules.publication.maxAgeMs));
        await write({owner:prepared.owner,pins:{...cp.pins,preparedRevision:pin},state:{...state(),vectorOffset:0,vectorIds:prepared.remainingIds}});
      }
      const plan=approvedCohortVectorPlan(revision);
      const originals=cp.pins.originalVectors?await readOriginalVectors(ws,cp.pins.originalVectors):{};
      const vectorIds=state().vectorIds as string[];
      if(!Array.isArray(vectorIds)||new Set(vectorIds).size!==vectorIds.length
        ||vectorIds.some(id=>!plan.products.some(p=>p.publicId===id)&&!plan.absentIds.includes(id)))throw new Error('weekly_vector_plan_changed');
      for(let index=Number(state().vectorOffset)||0;index<vectorIds.length;index++){
        const publicId=vectorIds[index];
        // Replaying complete earlier journal entries recovers only their own
        // recorded epoch; the exact current checkpoint owner is never replaced
        // with an arbitrary DB cursor. Original signed zero stays native bytes.
        const raw=originals[publicId] as Record<string,unknown>|undefined;
        const {nativeBase64,...fields}=raw||{};
        const original=raw?{...fields,values:decodePgvectorSendBase64(nativeBase64)}:undefined;
        for(let pass=0;pass<4;pass++){
          const result=await deliverOwnedApprovedCohortVector({db,owner:cp.owner!,revision,publicId,adapters,
            ...(!request.approval.changes.some(c=>c.publicId===publicId)&&plan.products.some(p=>p.publicId===publicId)&&original
              ?{original:{sha256:sha256(canonicalJson(original)),async load(){return original as never;}}}:{})});
          await write({owner:result.owner});
          if(result.state==='expired')return{state:'attention',phase:cp.phase,reason:'expired_vector',budget:await ws.budget()};
          if(result.state==='complete'){await write({state:{...state(),vectorOffset:index+1}});break;}
          if(pass===3||result.errorCode==='mutation_unknown'&&!await mutationKnown(db,result.deliveryId))
            return{state:'pending',phase:cp.phase,errorCode:result.errorCode,budget:await ws.budget()};
        }
      }
      const derived=config.publication.semanticSearch?.derivedCatalog;
      if(derived&&!cp.pins.searchDelta){
        const catalog=await reviewed(derived.path,derived.sha256,repo,8*1024*1024,true);
        const result=await syncApprovedSearchDelta({db,owner:cp.owner!,revision,catalog,
          accountId:config.accountId,token,fetch:generalSend});
        const pin=await putOrdered(ws,{catalogRevision:revision.snapshot.catalogRevision,...result},now());
        await write({pins:{...cp.pins,searchDelta:pin}});
      }
      const queued=await settleOwnedApprovedCohortVectorProof({db,owner:cp.owner!,revision,adapters});
      const pin=await putOrdered(ws,approvedRevisionControl(revision),approvedArtifactObservedAt(revision.snapshot,now(),config.retention.rules.publication.maxAgeMs));
      await write({phase:'publishing',owner:queued.owner,pins:{...cp.pins,revision:pin},state:{...state(),requestId:queued.requestId}});
    }
    if(cp.phase==='publishing'){
      revision=revision||await hydrateApprovedRevision(db,hydrationOwner??cp.owner!,await readOrdered<ReturnType<typeof approvedRevisionControl>>(ws,cp.pins.revision));
      const result=await executePublication({db,owner:cp.owner!,revision,approvedCatalog:revision,requestId:String(state().requestId),runReference:config.runId,workspace:ws,
        config:config.publication,routineCare:Boolean(config.cadence),credentials:{cloudflareToken:token,identityAuthorization:await identityAuthorization()},dependencies:publication,reviewedUploadRetry,finishAuthorization:finish?.authorization});
      const changed=await ws.readCheckpoint();if(!changed)throw new Error('weekly_checkpoint_missing');saved=changed;cp=changed.checkpoint;
      if(result.state!=='published')return{...result,phase:cp.phase,budget:await ws.budget()};
      const actual=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(result.releaseId).all()).results;
      if(actual.length!==1)throw new Error('weekly_publication_receipt_missing');
      const seal=await createPublishedApprovedCatalogSeal(db,revision,{releaseId:result.releaseId,receiptSha256:sha256(canonicalJson(actual[0]))});
      if(revision.persistent)await ws.recordCatalogSuccessor(seal);
      const pin=await ws.putArtifact(result,{kind:'publication',observedAt:now()}),sealPin=revision.persistent?null:await putOrdered(ws,seal,now());
      await write({phase:'published',owner:null,pins:{...cp.pins,published:pin,...(sealPin?{publishedSeal:sealPin}:{})}});
    }
    if(cp.phase==='published'){
      const receipt=await ws.readArtifact(cp.pins.published) as Record<string,unknown>;
      const owner=await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:`${config.runId}:finalize`,operationKey:sha256(`finalize:${options.configSha256}`)});
      if(!owner)throw new Error('weekly_finalize_owner');await write({owner});
      const cursor={current:owner};const telemetry=createD1CatalogTelemetryStore({db,owner,ownerCursor:cursor,runId:config.runId,catalogRevision:config.catalogRevision});
      const summary=await ws.readArtifact(cp.phaseComplete!) as Record<string,unknown>;
      const input={...summary,status:'completed',counts:{...summary.counts as object,publication:{status:'published',releaseId:receipt.releaseId,receiptSha256:receipt.receiptSha256}}};
      await telemetry.finishCatalogRun(config.runId,input);const actual=await telemetry.loadCatalogRun(config.runId);
      if(actual?.run.id!==config.runId||actual.run.status!=='completed'||canonicalJson(actual.run.counts)!==canonicalJson(input.counts))throw new Error('weekly_finalization_mismatch');
      await write({owner:cursor.current});await releaseExact(db,cursor.current);await write({phase:'finalized',owner:null});
      return{state:'finalized',runId:config.runId,releaseId:receipt.releaseId,receiptSha256:receipt.receiptSha256,
        catalogSeal:await ws.catalogSuccessor()??(cp.pins.publishedSeal?await readOrdered(ws,cp.pins.publishedSeal):undefined),budget:await ws.budget()};
    }
    throw new Error('weekly_checkpoint_phase');
  }finally{try{await workspace?.close();}finally{executing=false;}}
}

/** Exit zero may mean waiting/reconciliation, not a publication receipt. */
export function weeklyCommandSummary(result:Record<string,unknown>){
  const output:Record<string,unknown>={state:result.state??result.status};
  for(const key of ['runId','phase','reason','errorCode','releaseId','receiptSha256']){
    const value=result[key];if(typeof value==='string'&&/^[a-zA-Z0-9._-]{1,200}$/.test(value))output[key]=value;
  }
  if(result.budget)output.budget=result.budget;
  if(result.budget&&typeof result.budget==='object'){
    const b=result.budget as Record<string,number>;
    const estimates={httpRequests:6000,sqlStatements:12000,knownRowsRead:3000000,knownRowsWritten:40000};
    const alerts=Object.entries(estimates).filter(([k,n])=>b[k]>n).map(([k,n])=>`${k}_above_estimate_${n}`);
    if(alerts.length)output.usageAlerts=alerts;
  }
  return output;
}
async function main(){
  const args=process.argv.slice(2);
  if(args.length===1&&args[0]==='--help'){console.log('Opt-in protected weekly driver: <preflight|start|resume|status> --config /private/reviewed.json --config-sha256 SHA --workspace /private/weekly-runs [--approval /private/post-phase.json --approval-sha256 SHA]\nExit zero may mean pending review/reconciliation; it is not a completion receipt.\n'+JSON.stringify(WEEKLY_RESUME_STATES));return;}
  if(!['preflight','start','resume','status'].includes(args[0])||![7,11].includes(args.length)||args[1]!=='--config'||args[3]!=='--config-sha256'||args[5]!=='--workspace'
    ||args.length===11&&(args[7]!=='--approval'||args[9]!=='--approval-sha256'))throw new Error('weekly_arguments');
  const result=await runCloudflareWeekly({command:args[0] as WeeklyDriverOptions['command'],configPath:resolve(args[2]),configSha256:args[4],workspace:resolve(args[6]),
    ...(args.length===11?{approval:{path:resolve(args[8]),sha256:args[10]}}:{})});
  // Never print candidate bodies, credentials, private checkpoints or provider errors.
  console.log(JSON.stringify(weeklyCommandSummary(result)));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(safeCode(error));process.exitCode=1;});
