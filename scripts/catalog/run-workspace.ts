import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, link, unlink, readdir, rename, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse, sep } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { assertProtectedDestination } from './export-postgres.ts';
import { canonicalJson, sha256 } from './migration.ts';
import { explicitMaintenanceTime } from './maintenance-state.ts';
import { mutationFenceQuery } from '../../lib/catalog/mutation-fence.ts';
import type { MutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { encodeBuildRequest } from '../../lib/catalog/build-requests.ts';
import type { CatalogBuildClaim, ActivationPermit } from '../../lib/catalog/build-requests.ts';
import type { PublicationClaim, PublicationIntent } from '../../lib/catalog/publication.ts';
import type {ApprovedCatalogSeal} from './approved-catalog-seal.ts';
import { encodePublicationIntent } from '../../lib/catalog/publication.ts';
import type { ProviderReceipt } from './provider-evidence.ts';
import { validateExecutionAdoption } from './execution-adoption.ts';
import type { ExecutionAdoption } from './execution-adoption.ts';
import {activatedPermanentRevisionControl,activatedPermanentSummary} from './activated-permanent-control.ts';
import type {CatalogObjectStore,DurableObject} from './r2-object-store.ts';

type Json = null | boolean | number | string | Json[] | { [key:string]:Json };
type Kind = ProviderReceipt['kind'] | 'phase' | 'publication' | 'checkpoint';
export interface ArtifactRef { sha256:string; reference:string }
export interface WorkspaceScope {
  environment:'staging'|'production'; accountId:string; databaseId:string; databaseName:string; workerName:string; indexName:string;
}
export interface RetentionPolicy {
  reviewReference:string;
  rules:Record<Kind,{maxAgeMs:number;notAfter:string}>;
}
export interface PublicationControl {
  schemaVersion:1; configSha256:string; requestId:string; runReference:string;
  stage:'claimed'|'built'|'uploading'|'uploaded'|'activating'|'published';
  build:CatalogBuildClaim; publication:PublicationClaim|null; intent:PublicationIntent|null; permit:ActivationPermit|null;
  vectorPlan:{catalogRevision:string;planSha256:string;ids:string[]}; packageSha256:string|null;
  uploadMarker:string; versionReference:string|null; deploymentMarker:string; deploymentId:string|null;
  receiptSha256?:string;
}
export interface WorkspaceControl { publication?:PublicationControl }
export interface WorkspaceCheckpoint {
  phase:string; owner:MutationOwner|null; state:Json; pins:Record<string,ArtifactRef>;
  phaseComplete:ArtifactRef|null; control?:WorkspaceControl;
}
export type CheckpointControl = Omit<WorkspaceCheckpoint,'state'>;
export interface BudgetTotals {
  httpRequests:number; sqlStatements:number; knownRowsRead:number; knownRowsWritten:number; unconfirmedRequests:number;
}
/** Body-free successor evidence. Historical checkpoints/markers are not changed.
 * Only the accounted DB observer in purge-workspaces should create this input. */
export interface PublicationSuccessInput {
  schemaVersion:1;checkpointSha256:string;receiptSha256:string;configSha256:string;packageSha256:string;usage:BudgetTotals;
  journal:{sequence:number;sha256:string};
  receipt:Record<string,unknown>;build:Record<string,unknown>;scope:Record<string,unknown>;
}
export interface PublicationSuccess extends PublicationSuccessInput {recoveryBounds:{count:number;sha256:string}}
export interface BudgetCeiling { httpRequests:number; sqlStatements:number }
export interface ActivationRecoveryBudget {
  expectedCheckpointSha256:string; approvalReference:string; allowance:BudgetCeiling;
  /** Separately approved settlement of an ALREADY activated permanent catalog. */
  scope?:'approved-permanent-finalization';reportedRowsRead?:number;
}
type RecoveryGrant=ActivationRecoveryBudget&{permitSha256:string;usage:BudgetTotals};
export interface PublicationFinishBudget {
  expectedCheckpointSha256:string;approvalReference:string;versionReference:string;
  allowance:BudgetCeiling;reportedRowsRead:number;
}
type FinishGrant=PublicationFinishBudget&{usage:BudgetTotals};
export interface PublicationRequestBudget {
  expectedCheckpointSha256:string;approvalReference:string;additionalHttpRequests:number;
  approvedAt:string;publicationUntil:string;
}
type RequestGrant=PublicationRequestBudget&{usage:BudgetTotals};
export interface BudgetReservation { id:string; requestSha256:string; units:{httpRequests:number;sqlStatements:number} }
export type BudgetSettlement = {status:'known';usage:{rowsRead:number;rowsWritten:number}} | {status:'unknown';usage:null};
export interface RunWorkspaceOptions {
  /** One canonical shared PRIVATE root, not the per-run directory. Separate
   * roots/hosts do NOT share filesystem locks. No implicit default. */
  directory:string; repository:string; mode:'create'|'resume'; runId:string; configSha256:string; codeSha:string;
  scope:WorkspaceScope; retention:RetentionPolicy; budgetCaps:{httpRequests:number;sqlStatements:number};
  /** Routine catalog care records request counts but budgets actual SQL/rows.
   * Historical manifest estimates and every charge remain unchanged. */
  requestLimit?:'enforce'|'observe';
  expectedManifestSha256?:string; now?:()=>string;
  /** Runtime capability only: never changes historical manifest/config bytes.
   * Each journal ACK is durable before the caller can dispatch externally. */
  durable?:CatalogObjectStore;
}
export interface WorkspaceManifest {
  schemaVersion:1; runId:string; configSha256:string; codeSha:string; scope:WorkspaceScope;
  retention:RetentionPolicy; budgetCaps:{httpRequests:number;sqlStatements:number}; createdAt:string;
}
type Stored = { schemaVersion:1; sha256:string; kind:Kind; observedAt:string; expiresAt:string; policySha256:string; value:Json };
type PurgedArtifact = {ref:ArtifactRef;kind:Kind;observedAt:string;expiresAt:string;policySha256:string;storedSha256:string};
type PublicationDirectories={releaseId:string;sourceRoot:string;observedAt:string;nextExpiry:string|null;expiresAt:string;policySha256:string};
/** Private per-blob 32MiB cap accommodates ~28MiB of 3,383 native 1,536-vector
 * evidence. 256KiB native chunks encode to 349528B, below the unchanged 512KiB
 * artifact limit including metadata. NOT a public/REST/proof cap increase. */
export const WORKSPACE_BLOB_LIMITS=Object.freeze({bytes:32*1024*1024,chunkBytes:256*1024,artifactBytes:512*1024});
/** Manifest identity is ArtifactRef.sha256; sha256 below binds ORIGINAL opaque
 * bytes, not parsed/re-serialized JSON. Parts are hashes, never filesystem paths. */
export interface WorkspaceBlobManifest {
  schemaVersion:1;type:'run-workspace-blob';sha256:string;byteLength:number;chunkBytes:number;parts:string[];
}
type BlobChunk={schemaVersion:1;type:'run-workspace-chunk';blobSha256:string;blobByteLength:number;
  index:number;count:number;sha256:string;byteLength:number;base64:string};
type CheckpointView = {sha256:string;checkpoint:CheckpointControl};
type Event = {type:'artifact';ref:ArtifactRef} | {type:'checkpoint';ref:ArtifactRef;previous:string|null;control:CheckpointControl}
  | {type:'execution-adoption';adoption:ExecutionAdoption}
  | {type:'control';sha256:string;previous:string;control:CheckpointControl}
  | {type:'purge';artifact:PurgedArtifact;purgedAt:string}
  | {type:'publication-directories';retention:PublicationDirectories}
  | {type:'publication-build-cleaned';releaseId:string}
  | {type:'publication-purged';releaseId:string;purgedAt:string}
  | {type:'activation-recovery-budget';grant:RecoveryGrant}
  | {type:'publication-finish-budget';grant:FinishGrant}
  | {type:'publication-request-budget';grant:RequestGrant}
  | {type:'publication-success';proof:PublicationSuccess}
  | {type:'catalog-successor-part';sha256:string;index:number;count:number;data:string}
  | {type:'reserve';reservation:BudgetReservation} | {type:'settle';id:string;settlement:BudgetSettlement};
type RecordFile = {schemaVersion:1;sequence:number;parent:string|null;event:Event};
type JournalHead={sequence:number;sha256:string|null};
type State = {manifest:WorkspaceManifest;requestLimit:'enforce'|'observe';execution:ExecutionAdoption|null;recovery:RecoveryGrant|null;finish:FinishGrant|null;requestGrant:RequestGrant|null;success:PublicationSuccess|null;head:string|null;count:number;bytes:number;checkpoint:CheckpointView|null;body:ArtifactRef|null;previous:string|null;totals:BudgetTotals;
  successor:{sha256:string;count:number;parts:string[]}|null;
  refs:Map<string,ArtifactRef>;purged:Map<string,PurgedArtifact>;
  publications:Map<string,{retention:PublicationDirectories;buildCleaned:boolean;purged:boolean}>;
  reservations:Map<string,{reservation:BudgetReservation;settlement?:BudgetSettlement}>};
export interface WorkspaceStatus {
  directory:string;manifest:WorkspaceManifest;manifestSha256:string;checkpoint:CheckpointView|null;budget:BudgetTotals;budgetCeiling:BudgetCeiling;
  requestLimit:'enforce'|'observe';
  expired:{reference:string;kind:Kind;expiresAt:string}[];
  successfulPublication:PublicationSuccess|null;
  execution:ExecutionAdoption|null;
}
export interface RunWorkspace {
  readonly directory:string;readonly repository:string;readonly manifest:WorkspaceManifest;readonly manifestSha256:string;
  readonly execution:ExecutionAdoption|null;
  /** Explicit once-only reviewed continuation. Never rewrites manifest, pins,
   * prior source/config, counters or original supplier-body deadlines. */
  adoptExecution(value:ExecutionAdoption):Promise<ExecutionAdoption>;
  assertHeld():Promise<void>;assertScope(scope:WorkspaceScope):Promise<void>;
  putArtifact(value:unknown,options:{kind:'phase'|'publication';observedAt:string}):Promise<ArtifactRef>;
  readArtifact(ref:ArtifactRef):Promise<Json>;
  putBlob(bytes:Uint8Array,options:{kind:'phase'|'publication';observedAt:string}):Promise<ArtifactRef>;
  readBlob(ref:ArtifactRef):Promise<Uint8Array>;
  /** Immutable body-free catalog control, retained in the existing journal. */
  recordCatalogSuccessor(seal:ApprovedCatalogSeal):Promise<void>;
  catalogSuccessor():Promise<ApprovedCatalogSeal|null>;
  saveReceipt(input:Readonly<{sha256:string;receipt:ProviderReceipt}>):Promise<ArtifactRef>;
  readReceipt(ref:ArtifactRef):Promise<ProviderReceipt>;
  readCheckpoint(options?:{controlOnly?:false}):Promise<{sha256:string;checkpoint:WorkspaceCheckpoint}|null>;
  readCheckpoint(options:{controlOnly:true}):Promise<CheckpointView|null>;
  writeCheckpoint(expectedSha256:string|null,checkpoint:WorkspaceCheckpoint):Promise<{sha256:string;checkpoint:WorkspaceCheckpoint}>;
  /** Only records reconciliation of an ALREADY dispatched activation. Cannot
   * introduce new claims/content or renew any artifact's original deadline. */
  writeControlCheckpoint(expectedSha256:string,input:{phase:'attention'|'published'|'finalized';owner:MutationOwner|null;control:WorkspaceControl}):Promise<CheckpointView>;
  /** Exact registered permanent-public/technical proof only, never provider bodies. */
  readPermanentFinalization(label:'revision'|'summary'):Promise<Json>;
  reserveBudget(input:BudgetReservation):Promise<void>;settleBudget(id:string,input:BudgetSettlement):Promise<void>;
  /** Explicit, once-only reconciliation allowance. Does not change the manifest,
   * old charges, claims, leases or retention. Requires separately approved NEW
   * operator code; old readers deliberately reject its unknown journal event. */
  grantActivationRecoveryBudget(input:ActivationRecoveryBudget):Promise<BudgetCeiling>;
  /** Once-only owner-approved finish of an already acknowledged upload. */
  grantPublicationFinishBudget(input:PublicationFinishBudget):Promise<BudgetCeiling>;
  publicationFinishBudget():Promise<PublicationFinishBudget|null>;
  /** Once-only explicit pre-upload request allowance; no SQL/row/cadence reset. */
  grantPublicationRequestBudget(input:PublicationRequestBudget):Promise<BudgetCeiling>;
  publicationRequestBudget():Promise<PublicationRequestBudget|null>;
  /** Append once after an accounted actual receipt/resolved-build/idle snapshot.
   * Seals this run against any later charge or execution; never renews bodies. */
  recordPublicationSuccess(input:PublicationSuccessInput):Promise<PublicationSuccess>;
  publicationSuccess():Promise<PublicationSuccess|null>;
  budget():Promise<BudgetTotals>;budgetCeiling():Promise<BudgetCeiling>;budgetRowsReadCeiling():Promise<number|null>;close():Promise<void>;
  /** Claims only absent exact package/build-output paths before generation. */
  preparePublicationDirectories(releaseId:string,observedAt:string,nextExpiry:string|null):Promise<void>;
  /** Called only after the package has been sealed and independently verified. */
  cleanPublicationBuild(releaseId:string):Promise<void>;
  /** Journal retention metadata BEFORE unlinking verified object bodies and
   * explicitly owned publication outputs; never imported history/other runs. */
  purgeExpired():Promise<WorkspaceStatus['expired']>;
}
const HASH=/^[a-f0-9]{64}$/;const KEY=/^[A-Za-z0-9._-]{1,100}$/;const REF=/^[A-Za-z0-9._:/-]{1,200}$/;
const KINDS:Kind[]=['amazon-observation','embedding-response','phase','publication','checkpoint'];
const MAX_JSON=512*1024, MAX_EVENTS=20_000, MAX_JOURNAL=32*1024*1024;
const MAX_PUBLICATION_CLEANUP_ENTRIES=100_000;
function fail(code:string):never {throw new Error(`run_workspace_${code}`);}
const same=(a:unknown,b:unknown)=>canonicalJson(a)===canonicalJson(b);
const hash=(value:unknown)=>typeof value==='string'&&HASH.test(value);
const byteHash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const key=(value:unknown)=>typeof value==='string'&&KEY.test(value)&&value!=='.'&&value!=='..';
const refString=(value:unknown)=>typeof value==='string'&&REF.test(value);
const integer=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>=0;
/** Combined owned build/package/runtime trees, not journal, object or upload limits. */
export function assertPublicationCleanupEntryCount(count:number):void {
  if(!integer(count)||count>MAX_PUBLICATION_CLEANUP_ENTRIES)fail('publication_tree');
}
const exact=(value:unknown,keys:string[])=>!!value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
function json(value:unknown,max=MAX_JSON):Json {
  const encoded=canonicalJson(value);if(Buffer.byteLength(encoded)>max)fail('bytes');return JSON.parse(encoded);
}
function time(value:unknown):string {try{return explicitMaintenanceTime(value);}catch{return fail('time');}}
function scope(value:WorkspaceScope) {
  if(!exact(value,['environment','accountId','databaseId','databaseName','workerName','indexName'])
    ||!['staging','production'].includes(value.environment)||![value.accountId,value.databaseId,value.databaseName,value.workerName,value.indexName].every(key))fail('scope');
}
function options(value:RunWorkspaceOptions) {
  if(!value||!key(value.runId)||!hash(value.configSha256)||typeof value.codeSha!=='string'||!/^[a-f0-9]{40}$/.test(value.codeSha)
    ||!['create','resume'].includes(value.mode)||value.expectedManifestSha256!==undefined&&!hash(value.expectedManifestSha256)
    ||value.requestLimit!==undefined&&!['enforce','observe'].includes(value.requestLimit))fail('configuration');
  if(value.durable&&!['get','putImmutable','compareAndSwap','remove'].every(k=>typeof value.durable![k as keyof CatalogObjectStore]==='function'))fail('durable_configuration');
  scope(value.scope);
  if(!exact(value.retention,['reviewReference','rules'])||!refString(value.retention.reviewReference)
    ||!exact(value.retention.rules,KINDS))fail('retention_policy');
  for(const kind of KINDS){const rule=value.retention.rules[kind];
    if(!exact(rule,['maxAgeMs','notAfter'])||!integer(rule.maxAgeMs)||rule.maxAgeMs<1)fail('retention_policy');time(rule.notAfter);}
  if(!exact(value.budgetCaps,['httpRequests','sqlStatements'])||!Object.values(value.budgetCaps).every(integer))fail('budget_caps');
}
function artifactRef(value:ArtifactRef) {
  if(!exact(value,['sha256','reference'])||!hash(value.sha256)||value.reference!==`objects/${value.sha256}.json`)fail('reference');
}
const blobRef=(digest:string):ArtifactRef=>({sha256:digest,reference:`objects/${digest}.json`});
function blobManifest(value:unknown):WorkspaceBlobManifest {
  const v=value as WorkspaceBlobManifest;
  if(!exact(v,['schemaVersion','type','sha256','byteLength','chunkBytes','parts'])||v.schemaVersion!==1||v.type!=='run-workspace-blob'
    ||!hash(v.sha256)||!integer(v.byteLength)||v.byteLength>WORKSPACE_BLOB_LIMITS.bytes||v.chunkBytes!==WORKSPACE_BLOB_LIMITS.chunkBytes
    ||!Array.isArray(v.parts)||v.parts.length!==Math.ceil(v.byteLength/v.chunkBytes)||v.parts.some(p=>!hash(p))
    ||new Set(v.parts).size!==v.parts.length)fail('blob_manifest');
  return v;
}
function blobChunk(value:unknown,manifest:WorkspaceBlobManifest,index:number):Buffer {
  const v=value as BlobChunk;const expected=Math.min(manifest.chunkBytes,manifest.byteLength-index*manifest.chunkBytes);
  if(!exact(v,['schemaVersion','type','blobSha256','blobByteLength','index','count','sha256','byteLength','base64'])||v.schemaVersion!==1
    ||v.type!=='run-workspace-chunk'||v.blobSha256!==manifest.sha256||v.blobByteLength!==manifest.byteLength
    ||v.index!==index||v.count!==manifest.parts.length||v.byteLength!==expected||!hash(v.sha256)
    ||typeof v.base64!=='string'||v.base64.length!==4*Math.ceil(expected/3))fail('blob_chunk');
  const bytes=Buffer.from(v.base64,'base64');
  if(bytes.length!==expected||bytes.toString('base64')!==v.base64||byteHash(bytes)!==v.sha256)fail('blob_chunk');return bytes;
}
const retentionIdentity=(v:Pick<Stored,'kind'|'observedAt'|'expiresAt'|'policySha256'>)=>({kind:v.kind,observedAt:v.observedAt,expiresAt:v.expiresAt,policySha256:v.policySha256});
function purgeIdentity(value:PurgedArtifact,manifest:WorkspaceManifest) {
  if(!exact(value,['ref','kind','observedAt','expiresAt','policySha256','storedSha256'])||!KINDS.includes(value.kind)||!hash(value.storedSha256))fail('purge');
  artifactRef(value.ref);
  if(!same(retentionIdentity(value),retentionIdentity(stored(null,value.kind,value.observedAt,manifest))))fail('purge');
}
function publicationDirectories(releaseId:string,sourceRoot:string,observedAt:string,nextExpiry:string|null,manifest:WorkspaceManifest):PublicationDirectories {
  if(!key(releaseId)||!isAbsolute(sourceRoot))fail('publication_directories');
  const v=stored(null,'publication',observedAt,manifest);if(nextExpiry!==null)time(nextExpiry);
  return{releaseId,sourceRoot,observedAt:v.observedAt,nextExpiry,expiresAt:new Date(Math.min(Date.parse(v.expiresAt),nextExpiry===null?Infinity:Date.parse(nextExpiry))).toISOString(),policySha256:v.policySha256};
}
function intent(value:PublicationIntent) {
  if(!exact(value,['releaseId','codeSha','catalogRevision','vectorSyncWatermark','priorReleaseId','nextExpiry','catalogSnapshotSha256','manifestSha256'])
    ||!key(value.releaseId)||!key(value.catalogRevision)||!/^[a-f0-9]{40}$/.test(value.codeSha)||!integer(value.vectorSyncWatermark)
    ||value.priorReleaseId!==null&&!key(value.priorReleaseId)||!hash(value.catalogSnapshotSha256)||!hash(value.manifestSha256))fail('control');
  if(value.nextExpiry!==null)time(value.nextExpiry);
}
function owner(value:MutationOwner) {
  if(!exact(value,['environment','indexName','token','generation','epoch','phase','ownerReference','operationKey','capturedAt']))fail('owner');
  mutationFenceQuery(value,[value.phase]);
}
function control(value:WorkspaceControl|undefined) {
  if(value===undefined)return;
  if(!exact(value,value.publication===undefined?[]:['publication']))fail('control');
  if(!value.publication)return;
  json(value,MAX_JSON);const p=value.publication;
  if(!exact(p,['schemaVersion','configSha256','requestId','runReference','stage','build','publication','intent','permit','vectorPlan','packageSha256','uploadMarker','versionReference','deploymentMarker','deploymentId',...(p.receiptSha256===undefined?[]:['receiptSha256'])])
    ||p.schemaVersion!==1||!hash(p.configSha256)||!key(p.requestId)||!refString(p.runReference)
    ||!['claimed','built','uploading','uploaded','activating','published'].includes(p.stage)
    ||!exact(p.build,['requestId','token','runReference','leaseUntil','request'])||!key(p.build.requestId)||!key(p.build.token)||!refString(p.build.runReference))fail('control');
  time(p.build.leaseUntil);encodeBuildRequest(p.build.request);
  if(p.intent!==null)intent(p.intent);
  if(p.publication!==null){if(!exact(p.publication,['intentId','token','leaseUntil','intent'])||!key(p.publication.intentId)||!key(p.publication.token))fail('control');
    time(p.publication.leaseUntil);intent(p.publication.intent);}
  if(p.permit!==null){const q=p.permit;if(!exact(q,q.mutationOwner?['requestId','token','runReference','releaseId','versionReference','mutationOwner']:['requestId','token','runReference','releaseId','versionReference'])
      ||![q.requestId,q.token,q.releaseId].every(key)||![q.runReference,q.versionReference].every(refString))fail('control');
    if(q.mutationOwner)owner(q.mutationOwner);}
  if(!exact(p.vectorPlan,['catalogRevision','planSha256','ids'])||!key(p.vectorPlan.catalogRevision)||!hash(p.vectorPlan.planSha256)
    ||!Array.isArray(p.vectorPlan.ids)||p.vectorPlan.ids.length>10000||p.vectorPlan.ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))
    ||new Set(p.vectorPlan.ids).size!==p.vectorPlan.ids.length||p.packageSha256!==null&&!hash(p.packageSha256)
    ||![p.uploadMarker,p.deploymentMarker].every(refString)||[p.versionReference,p.deploymentId].some(v=>v!==null&&!refString(v))
    ||p.receiptSha256!==undefined&&!hash(p.receiptSha256))fail('control');
  if(p.requestId!==p.build.requestId||p.runReference!==p.build.runReference
    ||p.publication&&p.intent&&!same(p.publication.intent,p.intent)
    ||p.permit&&(p.permit.requestId!==p.requestId||p.permit.token!==p.build.token||p.permit.runReference!==p.runReference
      ||p.permit.releaseId!==p.intent?.releaseId||p.permit.versionReference!==p.versionReference))fail('control');
}
function checkpoint(value:WorkspaceCheckpoint) {
  if(!exact(value,value.control===undefined?['phase','owner','state','pins','phaseComplete']:['phase','owner','state','pins','phaseComplete','control'])||!key(value.phase))fail('checkpoint');
  json(value);if(value.owner!==null)owner(value.owner);
  if(!value.pins||typeof value.pins!=='object'||Array.isArray(value.pins)||Object.keys(value.pins).length>100)fail('pins');
  for(const [label,ref]of Object.entries(value.pins)){if(!key(label))fail('pins');artifactRef(ref);}
  if(value.phaseComplete!==null)artifactRef(value.phaseComplete);control(value.control);
}
function reservation(value:BudgetReservation) {
  if(!exact(value,['id','requestSha256','units'])||!key(value.id)||!hash(value.requestSha256)||!exact(value.units,['httpRequests','sqlStatements'])
    ||!Object.values(value.units).every(integer)||value.units.httpRequests!==1||value.units.sqlStatements>50)fail('budget_reservation');
}
function settlement(value:BudgetSettlement) {
  if(!exact(value,['status','usage'])||!['known','unknown'].includes(value.status)||value.status==='unknown'&&value.usage!==null
    ||value.status==='known'&&(!exact(value.usage,['rowsRead','rowsWritten'])||!Object.values(value.usage).every(integer)))fail('budget_settlement');
}
function totals(state:State):BudgetTotals {
  const result={...state.totals};
  if(!Object.values(result).every(integer))fail('budget_overflow');return result;
}
function recoveryInput(value:ActivationRecoveryBudget) {
  const finalizing=value.scope==='approved-permanent-finalization';
  if(!exact(value,['expectedCheckpointSha256','approvalReference','allowance',...(finalizing?['scope','reportedRowsRead']:[])])||!hash(value.expectedCheckpointSha256)||!hash(value.approvalReference)
    ||!exact(value.allowance,['httpRequests','sqlStatements'])||!Object.values(value.allowance).every(integer)
    ||value.allowance.httpRequests>(finalizing?1000:150)||value.allowance.sqlStatements>(finalizing?8000:300)
    ||finalizing&&(!integer(value.reportedRowsRead)||Number(value.reportedRowsRead)<1||Number(value.reportedRowsRead)>3000000))fail('recovery_allowance');
}
function recoveryPermit(state:State,reconciled=false,finalizing=state.recovery?.scope==='approved-permanent-finalization'):ActivationPermit {
  const cp=state.checkpoint?.checkpoint,p=cp?.control?.publication,a=p?.permit?.mutationOwner;
  const f=cp?.owner,telemetry=finalizing&&p?.stage==='published'&&cp?.phase==='published'&&f?.phase==='writing'&&a
    &&f.environment===a.environment&&f.indexName===a.indexName&&f.generation===a.generation+1
    &&[a.epoch,a.epoch+1].includes(f.epoch)&&f.ownerReference===`${state.manifest.runId}:finalize`
    &&f.operationKey===sha256(`finalize:${state.manifest.configSha256}`)&&f.token!==a.token&&f.capturedAt>=a.capturedAt;
  if(!cp||!p||!p.permit||!a||a.phase!=='activating'||!p.publication||!p.intent||!p.packageSha256||!p.versionReference
    ||p.runReference!==state.manifest.runId||![state.manifest.runId,`${state.manifest.runId}:freeze`].includes(a.ownerReference)
    ||p.requestId!==sha256(encodeBuildRequest(p.build.request))
    ||!(p.stage==='activating'&&same(cp.owner,a)||reconciled&&p.stage==='published'&&hash(p.receiptSha256)
      &&(cp.phase==='attention'&&same(cp.owner,a)||cp.phase==='published'&&cp.owner===null||telemetry
        ||finalizing&&cp.phase==='finalized'&&cp.owner===null)))fail('recovery_control');
  if(finalizing&&(!state.finish||state.finish.versionReference!==p.versionReference||p.intent.nextExpiry!==null||!p.deploymentId))fail('recovery_control');
  bindCheckpoint(cp,state.manifest,state.execution);return p.permit;
}
function ceiling(state:State):BudgetCeiling {
  const g=state.recovery,f=state.finish,result=g?{httpRequests:g.usage.httpRequests+g.allowance.httpRequests,sqlStatements:g.usage.sqlStatements+g.allowance.sqlStatements}:{...state.manifest.budgetCaps};
  if(f)for(const k of ['httpRequests','sqlStatements'] as const)result[k]=Math.max(result[k],state.manifest.budgetCaps[k],f.usage[k]+f.allowance[k]);
  if(state.requestGrant)result.httpRequests=Math.max(result.httpRequests,state.manifest.budgetCaps.httpRequests+state.requestGrant.additionalHttpRequests);
  if(!Object.values(result).every(integer))fail('budget_overflow');return result;
}
function budgetReservation(state:State,value:BudgetReservation) {
  const current=totals(state),limit=ceiling(state);
  if(state.recovery&&sha256(canonicalJson(recoveryPermit(state,true)))!==state.recovery.permitSha256)fail('recovery_control');
  if(state.recovery?.scope==='approved-permanent-finalization'
    &&([...state.reservations.values()].filter(r=>r.settlement?.status==='unknown').length!==state.recovery.usage.unconfirmedRequests
      ||value.units.sqlStatements&&current.knownRowsRead>=state.recovery.reportedRowsRead!))fail('recovery_read_budget');
  // Routine care records usage; historical estimates are not permission gates.
  if(state.requestLimit==='enforce'&&(current.httpRequests+value.units.httpRequests>limit.httpRequests
    ||current.sqlStatements+value.units.sqlStatements>limit.sqlStatements))fail('budget_exceeded');
}
async function pathWithoutLinks(path:string) {
  if(!isAbsolute(path)||normalize(path)!==path||path.endsWith(sep)||path.includes('\0'))fail('path');
  const parts=path.slice(parse(path).root.length).split(sep);let current=parse(path).root;
  for(const part of parts){current=join(current,part);try{if((await lstat(current)).isSymbolicLink())fail('symlink');}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
}
async function protectedStat(path:string,directory:boolean) {
  const s=await lstat(path);if(s.isSymbolicLink()||(directory?!s.isDirectory():!s.isFile())||s.uid!==process.getuid?.()
    ||(s.mode&0o777)!==(directory?0o700:0o600)||!directory&&s.nlink!==1)fail('permissions');return s;
}
async function syncDirectory(path:string) {const fd=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await fd.sync();}finally{await fd.close();}}
async function privateDirectory(path:string,create:boolean) {
  if(create){try{await mkdir(path,{mode:0o700});await syncDirectory(dirname(path));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  return protectedStat(path,true);
}
async function readBytes(path:string,max=MAX_JSON*2) {
  const before=await protectedStat(path,false);if(before.size>max)fail('bytes');
  const fd=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{
    const stat=await fd.stat();if(stat.ino!==before.ino||stat.dev!==before.dev||stat.nlink!==1)fail('file_changed');
    // Bound allocation/read even if a same-UID process grows the file after stat.
    const buffer=Buffer.alloc(before.size+1);let size=0;
    while(size<buffer.length){const result=await fd.read(buffer,size,buffer.length-size,null);if(!result.bytesRead)break;size+=result.bytesRead;}
    const bytes=buffer.subarray(0,size),after=await protectedStat(path,false);
    if(bytes.length!==before.size||after.ino!==before.ino||after.dev!==before.dev||after.size!==before.size)fail('file_changed');return bytes;
  }finally{await fd.close();}
}
async function readJson(path:string,max?:number):Promise<unknown> {
  const bytes=await readBytes(path,max);let value;try{value=JSON.parse(bytes.toString('utf8'));}catch{return fail('json');}
  if(!bytes.equals(Buffer.from(`${canonicalJson(value)}\n`)))fail('noncanonical');return value;
}
/** File and directory fsync + no-overwrite link publication + independent readback.
 * An interrupted link/unlink may leave nlink=2: reopening refuses it, never guesses
 * success or repairs a lock/archive automatically. Private same-UID tampering is
 * detected where possible, not a replacement for OS account isolation. */
async function immutable(path:string,value:unknown) {
  const bytes=Buffer.from(`${canonicalJson(value)}\n`);if(bytes.length>MAX_JSON*2)fail('bytes');
  try{if(!(await readBytes(path)).equals(bytes))fail('immutable_conflict');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temp=join(dirname(path),`.pending-${randomUUID()}`);const fd=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await fd.writeFile(bytes);await fd.sync();}finally{await fd.close();}
  if(!(await readBytes(temp)).equals(bytes))fail('write_readback');
  try{await link(temp,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  await syncDirectory(dirname(path));await unlink(temp);await syncDirectory(dirname(path));
  if(!(await readBytes(path)).equals(bytes))fail('write_readback');
}
async function replaceHead(directory:string,expected:{sequence:number;sha256:string|null},next:{sequence:number;sha256:string|null}) {
  const path=join(directory,'head.json');if(!same(await readJson(path),expected))fail('head_changed');
  const temp=join(directory,`.pending-${randomUUID()}`);await immutable(temp,next);
  if(!same(await readJson(path),expected))fail('head_changed');
  await rename(temp,path);await syncDirectory(directory);if(!same(await readJson(path),next))fail('head_readback');
}
function refFor(value:unknown):ArtifactRef {const digest=sha256(canonicalJson(value));return{sha256:digest,reference:`objects/${digest}.json`};}
function stored(value:unknown,kind:Kind,observedAt:string,manifest:WorkspaceManifest):Stored {
  const original=time(observedAt);const rule=manifest.retention.rules[kind];
  const expiresAt=new Date(Math.min(Date.parse(original)+rule.maxAgeMs,Date.parse(rule.notAfter))).toISOString();
  if(!Number.isFinite(Date.parse(expiresAt)))fail('retention_policy');
  return{schemaVersion:1,sha256:refFor(value).sha256,kind,observedAt:original,expiresAt,policySha256:sha256(canonicalJson(manifest.retention)),value:json(value)};
}
async function loadStored(directory:string,ref:ArtifactRef,manifest:WorkspaceManifest,reference=ref.reference):Promise<Stored> {
  artifactRef(ref);const value=await readJson(join(directory,reference)) as Stored;
  return validateStored(value,ref,manifest);
}
function validateStored(value:Stored,ref:ArtifactRef,manifest:WorkspaceManifest):Stored {
  if(!exact(value,['schemaVersion','sha256','kind','observedAt','expiresAt','policySha256','value'])||value.schemaVersion!==1
    ||!KINDS.includes(value.kind)||!same(value,stored(value.value,value.kind,value.observedAt,manifest))||value.sha256!==ref.sha256)fail('artifact_hash');
  return value;
}
function fresh(value:Stored,now:string) {if(Date.parse(value.observedAt)>Date.parse(now)||Date.parse(value.expiresAt)<=Date.parse(now))fail('expired');}
const empty=(manifest:WorkspaceManifest,requestLimit:'enforce'|'observe'):State=>({manifest,requestLimit,execution:null,recovery:null,finish:null,requestGrant:null,success:null,successor:null,head:null,count:0,bytes:0,checkpoint:null,body:null,previous:null,
  totals:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},refs:new Map(),purged:new Map(),publications:new Map(),reservations:new Map()});
function publicationSuccess(state:State,p:PublicationSuccess) {
  const cp=state.checkpoint,c=cp?.checkpoint.control?.publication,o=c?.permit?.mutationOwner;
  if(!exact(p,['schemaVersion','checkpointSha256','receiptSha256','configSha256','packageSha256','usage','journal','receipt','build','scope','recoveryBounds'])||p.schemaVersion!==1
    ||!cp||p.checkpointSha256!==cp.sha256||!c||c.stage!=='published'||!hash(c.receiptSha256)||!c.intent||!c.permit||!o||o.phase!=='activating'
    ||!c.packageSha256||!c.versionReference||p.packageSha256!==c.packageSha256||p.configSha256!==c.configSha256
    ||!hash(p.receiptSha256)||p.receiptSha256!==sha256(canonicalJson(p.receipt))||!same(p.usage,totals(state))
    ||!exact(p.journal,['sequence','sha256'])||p.journal.sequence!==state.count||p.journal.sha256!==state.head
    ||[...state.reservations.values()].some(r=>!r.settlement)
    ||!exact(p.recoveryBounds,['count','sha256'])||!integer(p.recoveryBounds.count)||p.recoveryBounds.count>MAX_EVENTS||!hash(p.recoveryBounds.sha256))fail('publication_success');
  const r=p.receipt,b=p.build,s=p.scope;
  const completedAt=Date.parse(time(r.completed_at)),observedAt=Date.parse(time(s.observed_at));
  if(c.receiptSha256!==sha256(canonicalJson({schemaVersion:1,environment:state.manifest.scope.environment,
    accountId:state.manifest.scope.accountId,workerName:state.manifest.scope.workerName,releaseId:c.intent.releaseId,
    versionReference:c.versionReference,requestId:c.requestId,intent:c.intent}))
    ||c.build.request.sourceRevision!==c.intent.catalogRevision||c.build.request.sourceDigest!==c.intent.catalogSnapshotSha256
    ||c.build.request.codeSha!==c.intent.codeSha)fail('publication_success');
  if(!exact(r,['release_id','catalog_revision','code_sha','completed_at','manifest_json'])
    ||r.release_id!==c.intent.releaseId||r.catalog_revision!==c.intent.catalogRevision||r.code_sha!==c.intent.codeSha
    ||r.manifest_json!==encodePublicationIntent(c.intent)
    ||!exact(b,['request_id','environment','source_revision','request_json','state','lease_token','lease_until','run_reference','release_id','version_reference','error_code'])
    ||b.request_id!==c.requestId||b.environment!==state.manifest.scope.environment||b.source_revision!==c.intent.catalogRevision
    ||b.request_json!==encodeBuildRequest(c.build.request)||c.requestId!==sha256(encodeBuildRequest(c.build.request))
    ||b.state!=='resolved'||b.lease_token!==c.permit.token||b.lease_until!==null||b.run_reference!==c.permit.runReference
    ||b.release_id!==c.permit.releaseId||b.version_reference!==c.permit.versionReference||b.error_code!==null
    ||!exact(s,['environment','index_name','generation','mutation_epoch','phase','owner_token','owner_reference','operation_key','captured_at','external_pending','activation_request_id','observed_at'])
    ||s.environment!==state.manifest.scope.environment||s.index_name!==state.manifest.scope.indexName||s.generation!==o.generation||s.mutation_epoch!==o.epoch
    ||s.phase!=='idle'||s.external_pending!==0||['owner_token','owner_reference','operation_key','captured_at','activation_request_id'].some(k=>s[k]!==null)
    ||completedAt>observedAt||completedAt<Date.parse(c.build.request.capturedAt)||observedAt<Date.parse(o.capturedAt))fail('publication_success');
}
/** This directory is body-free but not trusted by its name. Bind every exact
 * immutable wrapper to its real reservation/known cost, then pin the inventory. */
async function recoveryBoundsInventory(directory:string,state:State) {
  const root=join(directory,'publication-recovery-bounds'),inventory=[];
  try{await protectedStat(root,true);await pathWithoutLinks(root);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return{count:0,sha256:sha256(canonicalJson([]))};throw e;}
  const names=(await readdir(root)).sort();if(names.length>MAX_EVENTS)fail('publication_success_metadata');
  for(const name of names){
    if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(name))fail('publication_success_metadata');
    const v=await readJson(join(root,name),16*1024) as {schemaVersion:number;kind:string;recoveryBudgetSha256:string;helperSha256:string;bound:{id:string;requestSha256:string;sqlStatements:number;statementSha256s:string[];rowsReadBound:number;rowsWrittenBound:number}};
    if(!exact(v,['schemaVersion','kind','recoveryBudgetSha256','helperSha256','bound']))fail('publication_success_metadata');
    const b=v.bound,r=state.reservations.get(name.slice(0,-5));
    if(v.schemaVersion!==1||v.kind!=='publication-recovery-reservation-bound'
      ||!hash(v.recoveryBudgetSha256)||!hash(v.helperSha256)||!exact(b,['id','requestSha256','sqlStatements','statementSha256s','rowsReadBound','rowsWrittenBound'])
      ||!r?.settlement||b.id!==name.slice(0,-5)||b.requestSha256!==r.reservation.requestSha256||b.sqlStatements!==r.reservation.units.sqlStatements
      ||!Array.isArray(b.statementSha256s)||b.statementSha256s.length!==b.sqlStatements||!b.statementSha256s.every(hash)
      ||!integer(b.rowsReadBound)||b.rowsReadBound>80000||!integer(b.rowsWrittenBound)||b.rowsWrittenBound>1000
      ||!b.sqlStatements&&(b.rowsReadBound!==0||b.rowsWrittenBound!==0)
      ||r.settlement.status==='known'&&(r.settlement.usage.rowsRead>b.rowsReadBound||r.settlement.usage.rowsWritten>b.rowsWrittenBound))fail('publication_success_metadata');
    inventory.push({name,sha256:sha256(canonicalJson(v))});
  }
  return{count:inventory.length,sha256:sha256(canonicalJson(inventory))};
}
async function verifySuccessMetadata(directory:string,state:State){
  if(state.success&&!same(state.success.recoveryBounds,await recoveryBoundsInventory(directory,state)))fail('publication_success_metadata');
}
async function verifyExecutionMetadata(directory:string,state:State,repository:string){
  const a=state.execution;if(!a)return;
  if(a.original.sourceRoot!==repository)fail('execution_repository');
  for(const [ref,value]of [[a.original.context,a.contexts.original],[a.contexts.ref,a.contexts.replacement]] as const){
    const body=state.purged.get(ref.sha256)??await loadStored(directory,ref,state.manifest);
    if(body.kind!=='phase'||body.observedAt!==a.observedAt||body.expiresAt!==a.notAfter
      ||'value'in body&&!same(body.value,value))fail('execution_retention');
  }
}
function apply(state:State,event:Event,dry=false) {
  if(state.success&&!['purge','publication-build-cleaned','publication-purged'].includes(event.type))fail('publication_completed');
  if(event.type==='execution-adoption'){
    if(!exact(event,['type','adoption']))fail('execution_adoption');
    const a=event.adoption;validateExecutionAdoption(a);
    const o=a.original,cp=state.checkpoint;
    if(state.execution||state.success||state.successor||state.publications.size||state.recovery||!cp||cp.checkpoint.phase!=='phases_complete'
      ||cp.checkpoint.control?.publication||['approval','request','preparedRevision','revision','published','publishedSeal'].some(label=>cp.checkpoint.pins[label])
      ||[...state.reservations.values()].some(value=>!value.settlement)||cp.checkpoint.phaseComplete===null
      ||!same(cp.checkpoint.owner,o.owner)||o.owner.ownerReference!==state.manifest.runId
      ||o.owner.environment!==state.manifest.scope.environment||o.owner.indexName!==state.manifest.scope.indexName
      ||o.manifestSha256!==sha256(canonicalJson(state.manifest))||o.configSha256!==state.manifest.configSha256
      ||o.codeSha!==state.manifest.codeSha||o.checkpointSha256!==cp.sha256
      ||!same(o.budgetCaps,state.manifest.budgetCaps)||!same(o.journal,{sequence:state.count,sha256:state.head})
      ||!same(cp.checkpoint.pins.context,o.context)||!state.refs.has(o.context.sha256)
      ||state.purged.size)fail('execution_adoption_binding');
    if(!dry){state.execution=structuredClone(a);state.refs.set(a.contexts.ref.sha256,structuredClone(a.contexts.ref));}
  }
  else if(event.type==='artifact'){if(!exact(event,['type','ref']))fail('event');artifactRef(event.ref);if(!dry)state.refs.set(event.ref.sha256,event.ref);}
  else if(event.type==='purge'){
    if(!exact(event,['type','artifact','purgedAt'])||Date.parse(time(event.purgedAt))<Date.parse(event.artifact.expiresAt)
      ||state.purged.has(event.artifact.ref.sha256))fail('purge');
    if(!dry){state.purged.set(event.artifact.ref.sha256,event.artifact);state.refs.set(event.artifact.ref.sha256,event.artifact.ref);}
  }
  else if(event.type==='publication-directories'){
    if(!exact(event,['type','retention'])||state.publications.has(event.retention.releaseId))fail('publication_directories');
    if(!dry)state.publications.set(event.retention.releaseId,{retention:event.retention,buildCleaned:false,purged:false});
  }else if(event.type==='publication-build-cleaned'||event.type==='publication-purged'){
    const p=state.publications.get(event.releaseId);
    if(!p||!exact(event,event.type==='publication-build-cleaned'?['type','releaseId']:['type','releaseId','purgedAt'])
      ||event.type==='publication-build-cleaned'&&p.buildCleaned
      ||event.type==='publication-purged'&&(p.purged||Date.parse(time(event.purgedAt))<Date.parse(p.retention.expiresAt)))fail('publication_directories');
    if(!dry){if(event.type==='publication-build-cleaned')p.buildCleaned=true;else p.purged=true;}
  }
  else if(event.type==='checkpoint'){
    if(!exact(event,['type','ref','previous','control'])||event.previous!==(state.checkpoint?.sha256||null))fail('checkpoint_cas');
    artifactRef(event.ref);checkpoint({...event.control,state:null});const old=state.checkpoint?.checkpoint;
    if(old){for(const [label,ref]of Object.entries(old.pins))if(!same(event.control.pins[label]||null,ref))fail('pin_rewrite');
      if(old.phaseComplete!==null&&!same(old.phaseComplete,event.control.phaseComplete))fail('phase_complete_rewrite');
      controlEvolution(old,event.control,state.requestGrant?.publicationUntil);}
    if(!dry){state.previous=event.previous;state.checkpoint={sha256:event.ref.sha256,checkpoint:event.control};state.body=event.ref;state.refs.set(event.ref.sha256,event.ref);}
  }else if(event.type==='control'){
    if(!exact(event,['type','sha256','previous','control'])||!state.checkpoint||event.previous!==state.checkpoint.sha256
      ||event.sha256!==sha256(canonicalJson({previous:event.previous,control:event.control})))fail('control_cas');
    validateControlTransition(state.checkpoint.checkpoint,event.control,state);
    if(!dry){state.previous=event.previous;state.checkpoint={sha256:event.sha256,checkpoint:event.control};}
  }else if(event.type==='activation-recovery-budget'){
    const finalizing=event.grant.scope==='approved-permanent-finalization';
    if(!exact(event,['type','grant'])||!exact(event.grant,['expectedCheckpointSha256','approvalReference','allowance','permitSha256','usage',...(finalizing?['scope','reportedRowsRead']:[])]))fail('recovery_allowance');
    const {permitSha256,usage,...input}=event.grant;recoveryInput(input);
    if(state.recovery)fail('recovery_duplicate');
    if(state.checkpoint?.sha256!==input.expectedCheckpointSha256)fail('checkpoint_cas');
    if(!hash(permitSha256)||permitSha256!==sha256(canonicalJson(recoveryPermit(state,false,finalizing)))||!same(usage,totals(state)))fail('recovery_binding');
    if(finalizing&&(input.reportedRowsRead!<=usage.knownRowsRead||input.reportedRowsRead!>usage.knownRowsRead+500000
      ||usage.unconfirmedRequests>1||[...state.reservations.values()].some(r=>!r.settlement)))fail('recovery_binding');
    if(!integer(usage.httpRequests+input.allowance.httpRequests)||!integer(usage.sqlStatements+input.allowance.sqlStatements))fail('budget_overflow');
    if(!dry)state.recovery=event.grant;
  }else if(event.type==='publication-request-budget'){
    const g=event.grant,c=state.checkpoint,p=c?.checkpoint.control?.publication;
    if(!exact(event,['type','grant'])||!exact(g,['expectedCheckpointSha256','approvalReference','additionalHttpRequests','approvedAt','publicationUntil','usage'])
      ||state.requestGrant||state.recovery||state.finish||!c||c.sha256!==g.expectedCheckpointSha256||!hash(g.approvalReference)
      ||c.checkpoint.phase!=='publishing'||c.checkpoint.owner?.phase!=='freezing'||p?.stage!=='claimed'||p.permit||p.versionReference
      ||!integer(g.additionalHttpRequests)||g.additionalHttpRequests<1||g.additionalHttpRequests>750
      ||Date.parse(time(g.approvedAt))<Date.parse(p.build.request.capturedAt)
      ||Date.parse(time(g.publicationUntil))-Date.parse(g.approvedAt)!==7200000
      ||!same(g.usage,totals(state))||g.usage.unconfirmedRequests!==0
      ||[...state.reservations.values()].some(r=>!r.settlement))fail('request_budget_binding');
    if(!dry)state.requestGrant=structuredClone(g);
  }else if(event.type==='publication-finish-budget'){
    const g=event.grant,cp=state.checkpoint,p=cp?.checkpoint.control?.publication;
    if(!exact(event,['type','grant'])||!exact(g,['expectedCheckpointSha256','approvalReference','versionReference','allowance','reportedRowsRead','usage'])
      ||state.finish||state.recovery||!cp||cp.sha256!==g.expectedCheckpointSha256||!hash(g.approvalReference)
      ||!p||!['uploaded','activating'].includes(p.stage)||p.permit||p.versionReference!==g.versionReference||cp.checkpoint.owner?.phase!=='freezing'
      ||!(cp.checkpoint.pins.publicationUploadTransportAcknowledged||cp.checkpoint.pins.publicationUploadAcknowledged)
      ||cp.checkpoint.pins.reviewedUploadActivationPending
      ||!exact(g.allowance,['httpRequests','sqlStatements'])||!Object.values(g.allowance).every(integer)
      ||g.allowance.httpRequests>5000||g.allowance.sqlStatements>2000||!same(g.usage,totals(state))
      ||[...state.reservations.values()].some(r=>!r.settlement)
      ||!integer(g.reportedRowsRead)||g.reportedRowsRead<=g.usage.knownRowsRead||g.reportedRowsRead>3000000)fail('finish_budget_binding');
    if(!dry)state.finish=structuredClone(g);
  }else if(event.type==='catalog-successor-part'){
    const prior=state.successor;
    if(!exact(event,['type','sha256','index','count','data'])||!hash(event.sha256)||!integer(event.index)||!integer(event.count)
      ||event.count<1||event.count>128||event.index>=event.count||typeof event.data!=='string'||event.data.length>87384
      ||Buffer.from(event.data,'base64').toString('base64')!==event.data||Buffer.from(event.data,'base64').length>65536
      ||event.index!==(prior?.parts.length??0)||prior&&(prior.sha256!==event.sha256||prior.count!==event.count))fail('catalog_successor');
    const parts=[...(prior?.parts??[]),event.data];
    if(parts.length===event.count&&byteHash(Buffer.concat(parts.map(p=>Buffer.from(p,'base64'))))!==event.sha256)fail('catalog_successor');
    if(!dry)state.successor={sha256:event.sha256,count:event.count,parts};
  }else if(event.type==='publication-success'){
    if(!exact(event,['type','proof']))fail('publication_success');publicationSuccess(state,event.proof);
    if(!dry)state.success=event.proof;
  } else if(event.type==='reserve'){
    if(!exact(event,['type','reservation']))fail('event');reservation(event.reservation);
    if(state.reservations.has(event.reservation.id))fail('budget_duplicate');
    budgetReservation(state,event.reservation);
    if(!dry){state.reservations.set(event.reservation.id,{reservation:event.reservation});state.totals.httpRequests+=event.reservation.units.httpRequests;
      state.totals.sqlStatements+=event.reservation.units.sqlStatements;state.totals.unconfirmedRequests++;}
  }else if(event.type==='settle'){
    if(!exact(event,['type','id','settlement']))fail('event');settlement(event.settlement);const r=state.reservations.get(event.id);
    if(!r||r.settlement)fail('budget_settlement');
    if(event.settlement.status==='known'&&(!integer(state.totals.knownRowsRead+event.settlement.usage.rowsRead)
      ||!integer(state.totals.knownRowsWritten+event.settlement.usage.rowsWritten)))fail('budget_overflow');
    if(!dry){r.settlement=event.settlement;if(event.settlement.status==='known'){state.totals.knownRowsRead+=event.settlement.usage.rowsRead;
      state.totals.knownRowsWritten+=event.settlement.usage.rowsWritten;state.totals.unconfirmedRequests--;}}
  }else fail('event');
}
function validateControlTransition(old:CheckpointControl,next:CheckpointControl,state:State) {
  checkpoint({...next,state:null});
  if(!same(old.pins,next.pins)||!same(old.phaseComplete,next.phaseComplete)
    ||!old.control?.publication||!next.control?.publication)fail('control_reconciliation');
  const prior=old.control.publication,current=next.control.publication;
  if((state.recovery?.scope==='approved-permanent-finalization'||state.finish)&&prior.stage==='published'
    &&same(prior,current)&&hash(prior.receiptSha256)&&['published','finalized'].includes(next.phase)){
    recoveryPermit({...state,checkpoint:{sha256:state.checkpoint!.sha256,checkpoint:next}},true,true);
    const a=prior.permit!.mutationOwner!,before=old.owner,after=next.owner;
    if(next.phase==='finalized'){
      if(after!==null||!(old.phase==='finalized'&&before===null||old.phase==='published'&&before?.phase==='writing'
        &&before.generation===a.generation+1&&before.epoch===a.epoch+1))fail('control_owner');
    }else if(old.phase==='finalized'||after?.phase==='writing'&&before?.phase!=='writing'&&(old.phase!=='published'||before!==null)
      ||before?.phase==='writing'&&(!after||!same({...before,epoch:after.epoch},after)
      ||after.epoch<before.epoch||after.epoch>before.epoch+1))fail('control_owner');
    return;
  }
  if(!['attention','published'].includes(next.phase))fail('control_reconciliation');
  const recoveredPermit=prior.permit===null&&prior.stage==='activating'&&current.permit;
  if(recoveredPermit){
    const p=current.permit!;
    if(p.requestId!==prior.build.requestId||p.token!==prior.build.token||p.runReference!==prior.build.runReference
      ||p.releaseId!==prior.intent?.releaseId||p.versionReference!==prior.versionReference)fail('control_reconciliation');
    const a=old.owner,b=p.mutationOwner;
    if(!a||!b||a.phase!=='freezing'||b.phase!=='activating'||!same({...a,phase:'activating'},b)||!same(next.owner,b))fail('control_reconciliation');
  }
  else if(!same(old.owner,next.owner)&&!(next.owner===null&&next.phase==='published'&&current.stage==='published'))fail('control_owner');
  if(prior.stage!=='activating'&&prior.stage!=='published'||current.stage!=='published'&&current.stage!==prior.stage
    ||!same({...prior,stage:current.stage,deploymentId:current.deploymentId,...(recoveredPermit?{permit:current.permit}:{}),...(current.receiptSha256?{receiptSha256:current.receiptSha256}:{})},current)
    ||prior.deploymentId!==null&&prior.deploymentId!==current.deploymentId)fail('control_reconciliation');
  if(prior.receiptSha256!==undefined&&prior.receiptSha256!==current.receiptSha256)fail('control_reconciliation');
}
function controlEvolution(old:CheckpointControl,next:CheckpointControl,publicationUntil?:string) {
  const a=old.control?.publication,b=next.control?.publication;if(!a)return;if(!b)fail('control_rewrite');
  // Shape permission only: the protected publisher separately proves actual
  // DB expiry, attempt increment and ownership. Never a control-only recovery.
  const reclaimed=(a.stage==='claimed'||a.stage==='built')&&b.stage===a.stage&&old.phase==='publishing'&&next.phase==='publishing'
    &&old.owner?.phase==='freezing'&&same(old.owner,next.owner)&&same(old.pins,next.pins)&&same(old.phaseComplete,next.phaseComplete)
    &&['publication','intent','permit','versionReference','deploymentId'].every(k=>a[k as keyof PublicationControl]===null&&b[k as keyof PublicationControl]===null)
    &&(a.stage==='claimed'?a.packageSha256===null:hash(a.packageSha256))&&a.packageSha256===b.packageSha256
    &&a.receiptSha256===undefined&&b.receiptSha256===undefined
    &&!['publicationUploadAcknowledged','publicationUploadReview'].some(k=>old.pins[k]||next.pins[k])
    &&(!old.pins.publicationUploadPending||a.stage==='built') // Exact unchanged preflight pin; publisher proves its binding and explicit recovery receipt.
    &&same({...a,build:b.build},b)&&same({...a.build,token:b.build.token,leaseUntil:b.build.leaseUntil},b.build)
    &&a.build.token!==b.build.token&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(b.build.token)
    &&b.build.leaseUntil>a.build.leaseUntil&&b.build.leaseUntil<=(publicationUntil??a.build.request.cutoff);
  // Shape permission for an explicitly reviewed, proven UNACTIVATED upload.
  // The protected operator verifies actual idle provider/freezing D1 state,
  // original full rows and capped normal reclaims before acknowledging. This
  // never authorizes another upload, a new version or an activating permit.
  const uploadedReclaim=a.stage==='activating'&&b.stage===a.stage&&old.phase==='publishing'&&next.phase==='publishing'
    &&old.owner?.phase==='freezing'&&same(old.owner,next.owner)&&same(old.phaseComplete,next.phaseComplete)
    &&!!old.pins.publicationUploadAcknowledged&&!!old.pins.leaseRecoveryPending&&!old.pins.leaseRecoveryAcknowledged
    &&!!next.pins.leaseRecoveryAcknowledged&&same({...old.pins,leaseRecoveryAcknowledged:next.pins.leaseRecoveryAcknowledged},next.pins)
    &&a.permit===null&&b.permit===null&&a.deploymentId===null&&b.deploymentId===null&&a.receiptSha256===undefined&&b.receiptSha256===undefined
    &&!!a.versionReference&&hash(a.packageSha256)&&!!a.publication&&!!b.publication
    &&same({...a,build:b.build,publication:b.publication},b)
    &&same({...a.build,token:b.build.token,leaseUntil:b.build.leaseUntil},b.build)
    &&same({...a.publication,token:b.publication.token,leaseUntil:b.publication.leaseUntil},b.publication)
    &&a.build.token!==b.build.token&&a.publication.token!==b.publication.token
    &&[b.build.token,b.publication.token].every(v=>/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v))
    &&b.build.leaseUntil>a.build.leaseUntil&&b.publication.leaseUntil>a.publication.leaseUntil
    &&b.build.leaseUntil<=a.build.request.cutoff&&b.publication.leaseUntil<=a.build.request.cutoff;
  for(const field of ['schemaVersion','configSha256','requestId','runReference','build','vectorPlan','uploadMarker','deploymentMarker'] as const)
    if(!(field==='build'&&(reclaimed||uploadedReclaim))&&!same(a[field],b[field]))fail('control_rewrite');
  for(const field of ['packageSha256','publication','intent','permit','versionReference','deploymentId','receiptSha256'] as const)
    if(!(field==='publication'&&uploadedReclaim)&&a[field]!==null&&a[field]!==undefined&&!same(a[field],b[field]??null))fail('control_rewrite');
  const stages=['claimed','built','uploading','uploaded','activating','published'];if(stages.indexOf(b.stage)<stages.indexOf(a.stage))fail('control_rewrite');
}
function bindCheckpoint(value:CheckpointControl,manifest:WorkspaceManifest,execution:ExecutionAdoption|null=null) {
  if(value.owner&&(value.owner.environment!==manifest.scope.environment||value.owner.indexName!==manifest.scope.indexName))fail('owner_scope');
  const p=value.control?.publication;if(p&&(p.build.request.environment!==manifest.scope.environment
    ||p.build.request.codeSha!==(execution?.effective.codeSha??manifest.codeSha)
    ||p.intent&&p.intent.codeSha!==(execution?.effective.codeSha??manifest.codeSha)
    ||execution&&p.configSha256!==execution.effective.publicationConfigSha256))fail('control_scope');
}
function applyRecord(state:State,record:RecordFile,filename:string) {
  const digest=sha256(canonicalJson(record)),manifest=state.manifest;
  if(!exact(record,['schemaVersion','sequence','parent','event'])||record.schemaVersion!==1||record.sequence!==state.count+1||record.parent!==state.head
    ||filename!==`${String(record.sequence).padStart(6,'0')}.${digest}.json`)fail('journal_chain');
  if(record.event.type==='checkpoint'||record.event.type==='control')bindCheckpoint(record.event.control,manifest,state.execution);
  if(record.event.type==='purge')purgeIdentity(record.event.artifact,manifest);
  if(record.event.type==='publication-directories'){
    const p=record.event.retention;
    if(!same(p,publicationDirectories(p.releaseId,p.sourceRoot,p.observedAt,p.nextExpiry,manifest)))fail('publication_directories');
  }
  apply(state,record.event);state.count++;state.head=digest;
}
async function loadState(directory:string,manifest:WorkspaceManifest,repairHead=false,requestLimit:'enforce'|'observe'='enforce'):Promise<State> {
  const entries=await readdir(join(directory,'events'));if(entries.length>MAX_EVENTS+32)fail('entries');
  if((await readdir(join(directory,'objects'))).length>MAX_EVENTS)fail('entries');
  const files=entries.filter(name=>!name.startsWith('.pending-')).sort();
  if(files.length>MAX_EVENTS)fail('entries');const state=empty(manifest,requestLimit),checkpoints:Extract<Event,{type:'checkpoint'}>[]=[];
  let previousHead={sequence:0,sha256:null as string|null};
  for(const filename of files){
    if(!/^\d{6}\.[a-f0-9]{64}\.json$/.test(filename))fail('journal_name');
    state.bytes+=(await protectedStat(join(directory,'events',filename),false)).size;if(state.bytes>MAX_JOURNAL)fail('journal_bytes');
    const record=await readJson(join(directory,'events',filename)) as RecordFile;
    if(record.event.type==='checkpoint')checkpoints.push(record.event);
    previousHead={sequence:state.count,sha256:state.head};
    applyRecord(state,record,filename);
  }
  for(const event of checkpoints){
    if(!state.purged.has(event.ref.sha256)){
      const sealed=await loadStored(directory,event.ref,manifest);if(sealed.kind!=='checkpoint')fail('checkpoint_body');
      checkpoint(sealed.value as unknown as WorkspaceCheckpoint);
      const {state:unused,...view}=sealed.value as unknown as WorkspaceCheckpoint;void unused;
      if(!same(view,event.control))fail('checkpoint_body');
    }
  }
  const head=await readJson(join(directory,'head.json')),next={sequence:state.count,sha256:state.head};
  if(!same(head,next)){
    // A fully fsynced trailing record is authoritative after lost head/ack.
    // Only one append can be in flight; gaps, forks or older heads still fail.
    if(!state.count||!same(head,previousHead))fail('journal_head');
    if(repairHead)await replaceHead(directory,previousHead,next);
  }
  const usage=totals(state),limit=ceiling(state);if(requestLimit==='enforce'&&(usage.httpRequests>limit.httpRequests||usage.sqlStatements>limit.sqlStatements))fail('budget_exceeded');
  return state;
}
function receipt(value:ProviderReceipt) {
  if(!value||value.schemaVersion!==1||!['amazon-observation','embedding-response'].includes(value.kind)||!Array.isArray(value.products)||value.products.length>20)fail('receipt');
  const amazon=value.kind==='amazon-observation';
  if(!exact(value,amazon?['schemaVersion','kind','operation','observedAt','products','returnedIds',...(value.requestedIds===undefined?[]:['requestedIds'])]
    :['schemaVersion','kind','observedAt','model','products']))fail('receipt');
  time(value.observedAt);
  if(amazon){if(!['getItems','searchItems'].includes(value.operation)||![value.returnedIds,...(value.requestedIds?[value.requestedIds]:[])].every(ids=>Array.isArray(ids)&&ids.length<=10
      &&ids.every(id=>typeof id==='string'&&/^[A-Z0-9]{10}$/.test(id))&&new Set(ids).size===ids.length)||value.requestedIds&&value.operation!=='getItems')fail('receipt');}
  else if(value.model!=='text-embedding-3-small')fail('receipt');
  // Raw HTTP headers, credentials and arbitrary provider response envelopes are
  // not accepted: only the existing reviewed, bounded semantic receipt kinds.
  for(const product of value.products){if(!exact(product,amazon?['id','availabilityStatus','sourceFactsHash','snapshot']:['id','sourceFactsHash','text','nativeBase64','vectorBytesSha256'])
    ||typeof product.id!=='string'||!/^[A-Z0-9]{10}$/.test(product.id)||!hash(product.sourceFactsHash))fail('receipt');}
  json(value);
}
async function location(input:RunWorkspaceOptions,create:boolean) {
  options(input);await pathWithoutLinks(input.directory);await assertProtectedDestination(input.directory,input.repository);
  await protectedStat(dirname(input.directory),true);
  await privateDirectory(input.directory,create);for(const name of ['runs','locks'])await privateDirectory(join(input.directory,name),create);
  const directory=join(input.directory,'runs',input.runId);if(create){await mkdir(directory,{mode:0o700});await syncDirectory(dirname(directory));}
  await privateDirectory(directory,false);for(const name of ['objects','events'])await privateDirectory(join(directory,name),create);
  return directory;
}
async function readManifest(directory:string,input:RunWorkspaceOptions) {
  const manifest=await readJson(join(directory,'manifest.json')) as WorkspaceManifest;
  return manifestInfo(manifest,input);
}
function manifestInfo(manifest:WorkspaceManifest,input:RunWorkspaceOptions) {
  if(!exact(manifest,['schemaVersion','runId','configSha256','codeSha','scope','retention','budgetCaps','createdAt'])||manifest.schemaVersion!==1)fail('manifest');
  const expected={schemaVersion:1,runId:input.runId,configSha256:input.configSha256,codeSha:input.codeSha,scope:input.scope,retention:input.retention,budgetCaps:input.budgetCaps,createdAt:manifest.createdAt};
  time(manifest.createdAt);const digest=sha256(canonicalJson(manifest));
  if(!same(manifest,expected)||input.expectedManifestSha256!==undefined&&input.expectedManifestSha256!==digest)fail('manifest_mismatch');
  return{manifest,manifestSha256:digest};
}
const encoded=(value:unknown)=>Buffer.from(`${canonicalJson(value)}\n`);
function remoteJson(object:DurableObject,max=MAX_JSON*2):unknown {
  if(!(object.bytes instanceof Uint8Array)||object.bytes.length>max)fail('durable_bytes');
  const bytes=Buffer.from(object.bytes);let value;
  try{value=JSON.parse(bytes.toString('utf8'));}catch{return fail('durable_json');}
  if(!bytes.equals(encoded(value)))fail('durable_noncanonical');return value;
}
function journalHead(value:unknown):JournalHead {
  const v=value as JournalHead;
  if(!exact(v,['sequence','sha256'])||!integer(v.sequence)||v.sequence>MAX_EVENTS
    ||(v.sequence===0?v.sha256!==null:!hash(v.sha256)))fail('durable_head');return v;
}
const eventName=(sequence:number,digest:string)=>`${String(sequence).padStart(6,'0')}.${digest}.json`;
/** Remote durability uses this very journal and its hash chain. There is no
 * second workflow state, owner lease, saved config or host lock in the bucket. */
async function durableJournal(input:RunWorkspaceOptions,directory:string,create:boolean) {
  const store=input.durable!,prefix=`runs/${input.runId}/`,headKey=prefix+'head.json';
  const get=async(name:string)=>{const object=await store.get(prefix+name);if(!object)fail('durable_missing');return object;};
  const put=async(name:string,bytes:Uint8Array)=>{
    const actual=await store.putImmutable(prefix+name,bytes);
    if(!Buffer.from(actual.bytes).equals(Buffer.from(bytes)))fail('durable_readback');
  };
  let remote:DurableObject;
  async function cas(expected:string|null,next:JournalHead):Promise<DurableObject>{
    const bytes=encoded(next);let actual:DurableObject;
    try{actual=await store.compareAndSwap(headKey,expected,bytes);}
    catch(error){const readback=await store.get(headKey);
      if(!readback||!Buffer.from(readback.bytes).equals(bytes))throw error;actual=readback;}
    if(!Buffer.from(actual.bytes).equals(bytes))fail('durable_readback');return actual;
  }
  async function commit(record:RecordFile) {
    const event=record.event,refs=event.type==='artifact'||event.type==='checkpoint'?[event.ref]
      :event.type==='execution-adoption'?[event.adoption.contexts.ref]:[];
    for(const ref of refs){artifactRef(ref);await put(ref.reference,await readBytes(join(directory,ref.reference)));}
    const digest=sha256(canonicalJson(record));
    await put('events/'+eventName(record.sequence,digest),encoded(record));
    remote=await cas(remote.etag,{sequence:record.sequence,sha256:digest});
  }
  if(create){
    await put('manifest.json',await readBytes(join(directory,'manifest.json')));
    remote=await cas(null,{sequence:0,sha256:null});
  }else{
    remote=await get('head.json');const head=journalHead(remoteJson(remote));
    const manifest=remoteJson(await get('manifest.json')) as WorkspaceManifest;manifestInfo(manifest,input);
    const records:{name:string;record:RecordFile}[]=[];let digest=head.sha256,bytes=0;
    for(let sequence=head.sequence;sequence>0;sequence--){
      const name=eventName(sequence,digest!),object=await get('events/'+name);bytes+=object.bytes.length;
      if(bytes>MAX_JOURNAL)fail('journal_bytes');
      const record=remoteJson(object) as RecordFile;
      if(sha256(canonicalJson(record))!==digest||record.sequence!==sequence)fail('journal_chain');
      records.push({name,record});digest=record.parent;
      if(sequence===1?digest!==null:!hash(digest))fail('journal_chain');
    }
    const state=empty(manifest,input.requestLimit??'enforce');
    for(const {name,record}of records.reverse())applyRecord(state,record,name);
    if(state.head!==head.sha256||state.count!==head.sequence)fail('journal_chain');
    // Fresh files only. Never restore local inode identities, .pending files,
    // source outputs or locks; D1 checkpoint ownership remains byte-identical.
    await immutable(join(directory,'manifest.json'),manifest);
    for(const {name,record}of records)await immutable(join(directory,'events',name),record);
    for(const ref of state.refs.values())if(!state.purged.has(ref.sha256)){
      const body=remoteJson(await get(ref.reference)) as Stored;validateStored(body,ref,manifest);
      await immutable(join(directory,ref.reference),body);
    }
    let local:JournalHead;
    try{local=journalHead(await readJson(join(directory,'head.json')));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
      await immutable(join(directory,'head.json'),head);local=head;}
    if(local.sequence<=head.sequence){
      const expected=local.sequence===0?null:sha256(canonicalJson(records[local.sequence-1].record));
      if(local.sha256!==expected)fail('durable_local_fork');
      if(!same(local,head))await replaceHead(directory,local,head);
    }
    const loaded=await loadState(directory,manifest,false,input.requestLimit);
    if(loaded.count!==head.sequence){
      // A failed remote CAS may leave ONE local fsynced tail. Reconcile its
      // original bytes/reservation remotely before permitting local head repair.
      if(loaded.count!==head.sequence+1)fail('durable_local_fork');
      const tail=await readJson(join(directory,'events',eventName(loaded.count,loaded.head!))) as RecordFile;
      if(tail.parent!==head.sha256)fail('durable_local_fork');await commit(tail);
    }
    const current=await get('head.json');
    if(!Buffer.from(current.bytes).equals(remote.bytes)||current.etag!==remote.etag)fail('durable_head_changed');
  }
  return{commit,async purge(artifact:PurgedArtifact){
    const object=await store.get(prefix+artifact.ref.reference);if(!object)return;
    const body=remoteJson(object) as Stored;validateStored(body,artifact.ref,(await readManifest(directory,input)).manifest);
    if(sha256(canonicalJson(body))!==artifact.storedSha256||Date.parse(body.expiresAt)>Date.parse(time((input.now||(()=>new Date().toISOString()))())))fail('purge_body');
    await store.remove(prefix+artifact.ref.reference,object.etag);
  }};
}
async function expired(directory:string,state:State,manifest:WorkspaceManifest,now:string) {
  const result:WorkspaceStatus['expired']=[];
  for(const ref of state.refs.values()){const v=state.purged.get(ref.sha256)||await loadStored(directory,ref,manifest);
    if(state.purged.has(ref.sha256)||Date.parse(v.observedAt)>Date.parse(now)||Date.parse(v.expiresAt)<=Date.parse(now))result.push({reference:ref.reference,kind:v.kind,expiresAt:v.expiresAt});}
  for(const p of state.publications.values())if(p.purged||Date.parse(p.retention.expiresAt)<=Date.parse(now))result.push({reference:`packages/${p.retention.releaseId}`,kind:'publication',expiresAt:p.retention.expiresAt});
  return result;
}
/** Read-only metadata/status. Never acquires/removes a lock or returns artifact
 * bodies/state. Expired content does not hide identities needed to reconcile an
 * already dispatched activation. This is NOT permission to build/publish anew. */
export async function readRunWorkspace(input:RunWorkspaceOptions):Promise<WorkspaceStatus> {
  input={...input,scope:structuredClone(input.scope),retention:structuredClone(input.retention),budgetCaps:structuredClone(input.budgetCaps)};
  const directory=await location({...input,mode:'resume'},false);const info=await readManifest(directory,input);
  const before=(await readdir(join(directory,'events'))).sort();const state=await loadState(directory,info.manifest,false,input.requestLimit);
  if(input.durable){
    const head=await input.durable.get(`runs/${input.runId}/head.json`),manifest=await input.durable.get(`runs/${input.runId}/manifest.json`);
    if(!head||!manifest||!same(journalHead(remoteJson(head)),{sequence:state.count,sha256:state.head})
      ||!same(remoteJson(manifest),info.manifest))fail('durable_head_changed');
  }
  await verifyExecutionMetadata(directory,state,await realpath(input.repository));
  await verifySuccessMetadata(directory,state);
  const expiredRefs=await expired(directory,state,info.manifest,time((input.now||(()=>new Date().toISOString()))()));
  if(!same(before,(await readdir(join(directory,'events'))).sort()))fail('concurrent_read');
  return{directory,...info,requestLimit:state.requestLimit,checkpoint:state.checkpoint,budget:totals(state),budgetCeiling:ceiling(state),expired:expiredRefs,
    successfulPublication:structuredClone(state.success),execution:structuredClone(state.execution)};
}
/** Host-local resource locks (D1 + Worker + build checkout), sorted to avoid lock-order
 * deadlocks across run IDs IN THE SAME CANONICAL WORKSPACE ROOT. Separate roots
 * and hosts do not share these files. No PID/age takeover, heartbeat, provider
 * credential, or global authority: callers still need the exact D1 owner. */
export async function openRunWorkspace(input:RunWorkspaceOptions):Promise<RunWorkspace> {
  return openWorkspace(input);
}

/** Completed source outputs need only their source lock, not the shared D1 and
 * Worker locks. This capability cannot fetch, mutate, publish or purge evidence.
 * The original journal/source binding is still independently checked. */
export async function openPublicationBuildCleanup(input:RunWorkspaceOptions):Promise<Pick<RunWorkspace,'cleanPublicationBuild'|'close'>> {
  if(input.mode!=='resume')fail('cleanup_requires_completed_publication');
  const workspace=await openWorkspace(input,true);
  return Object.freeze({cleanPublicationBuild:workspace.cleanPublicationBuild,close:workspace.close});
}

async function openWorkspace(input:RunWorkspaceOptions,cleanupOnly=false):Promise<RunWorkspace> {
  input={...input,scope:structuredClone(input.scope),retention:structuredClone(input.retention),budgetCaps:structuredClone(input.budgetCaps)};
  options(input);await pathWithoutLinks(input.directory);await assertProtectedDestination(input.directory,input.repository);
  await protectedStat(dirname(input.directory),true);
  const repository=await realpath(input.repository);
  await privateDirectory(input.directory,true);await privateDirectory(join(input.directory,'locks'),true);
  const resources:Array<Record<string,string>>=[...(!cleanupOnly?[
    {accountId:input.scope.accountId,environment:input.scope.environment,databaseId:input.scope.databaseId},
    {accountId:input.scope.accountId,environment:input.scope.environment,workerName:input.scope.workerName},
  ]:[]),{sourceRoot:repository}];
  const locks:{path:string;ino:number;dev:number;body:unknown}[]=[];const token=randomUUID();
  async function acquire(resource:Record<string,string>){
    if(locks.some(lock=>same((lock.body as {resource:unknown}).resource,resource)))return;
    const path=join(input.directory,'locks',`${sha256(canonicalJson(resource))}.lock`);let fd;
    try{fd=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')fail('locked');throw error;}
    const body={schemaVersion:1,token,runId:input.runId,resource};
    try{await fd.writeFile(`${canonicalJson(body)}\n`);await fd.sync();const s=await fd.stat();locks.push({path,ino:s.ino,dev:s.dev,body});}
    finally{await fd.close();}await syncDirectory(dirname(path));
  }
  async function acquireExecutionRoot(a:ExecutionAdoption){
    await pathWithoutLinks(a.effective.sourceRoot);
    if(await realpath(a.effective.sourceRoot)!==a.effective.sourceRoot||!(await lstat(a.effective.sourceRoot)).isDirectory())fail('execution_repository');
    await acquire({sourceRoot:a.effective.sourceRoot});
  }
  try{
    for(const resource of resources.map(r=>({key:sha256(canonicalJson(r)),resource:r})).sort((a,b)=>a.key.localeCompare(b.key))){
      await acquire(resource.resource);
    }
    if(input.durable&&input.mode==='resume'){
      // A new runner may restore into an absent private local workspace. The
      // fresh local locks above are never taken from the remote checkpoint.
      for(const path of [join(input.directory,'runs'),join(input.directory,'runs',input.runId),
        join(input.directory,'runs',input.runId,'objects'),join(input.directory,'runs',input.runId,'events')])await privateDirectory(path,true);
    }
    const directory=await location(input,input.mode==='create');
    if(input.mode==='create'){
      await immutable(join(directory,'manifest.json'),{schemaVersion:1,runId:input.runId,configSha256:input.configSha256,codeSha:input.codeSha,
        scope:input.scope,retention:input.retention,budgetCaps:input.budgetCaps,createdAt:time((input.now||(()=>new Date().toISOString()))())});
      await immutable(join(directory,'head.json'),{sequence:0,sha256:null});
    }
    const durability=input.durable?await durableJournal(input,directory,input.mode==='create'):undefined;
    const info=await readManifest(directory,input);const manifest=JSON.parse(canonicalJson(info.manifest)) as WorkspaceManifest;
    // Runtime freeze prevents accidental caller scope/policy mutation.
    const freeze=(v:unknown):void=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}};freeze(manifest);
    const state=await loadState(directory,manifest,true,input.requestLimit);let closed=false,poisoned=false;let queue:Promise<unknown>=Promise.resolve();
    await verifyExecutionMetadata(directory,state,repository);
    if(state.execution)await acquireExecutionRoot(state.execution);
    await verifySuccessMetadata(directory,state);
    const completedRelease=state.success?.receipt.release_id??(
      ['published','finalized'].includes(state.checkpoint?.checkpoint.phase??'')&&state.checkpoint?.checkpoint.owner===null
      &&state.checkpoint.checkpoint.control?.publication?.stage==='published'
      &&hash(state.checkpoint.checkpoint.control.publication.receiptSha256)
        ?state.checkpoint.checkpoint.control.publication.intent?.releaseId:null);
    if(cleanupOnly&&!completedRelease)fail('cleanup_requires_completed_publication');
    for(const p of state.publications.values())if(p.retention.sourceRoot!==(state.execution?.effective.sourceRoot??repository))fail('publication_scope');
    let usableUntil=Infinity,usableAfter=-Infinity;
    // Verify every registered body once on open; held-lock operations retain
    // immutable deadline metadata, not O(receipts × HTTP requests) body rescans.
    for(const ref of state.refs.values()){const v=state.purged.get(ref.sha256)||await loadStored(directory,ref,manifest);usableUntil=Math.min(usableUntil,Date.parse(v.expiresAt));usableAfter=Math.max(usableAfter,Date.parse(v.observedAt));}
    for(const p of state.publications.values()){usableUntil=Math.min(usableUntil,Date.parse(p.retention.expiresAt));usableAfter=Math.max(usableAfter,Date.parse(p.retention.observedAt));}
    const guards=await Promise.all([input.directory,join(input.directory,'runs'),join(input.directory,'locks'),directory,join(directory,'objects'),join(directory,'events')]
      .map(async path=>({path,stat:await protectedStat(path,true)})));
    async function assertHeld(){if(closed)fail('closed');await pathWithoutLinks(input.directory);
      for(const guard of guards){const s=await protectedStat(guard.path,true);if(s.ino!==guard.stat.ino||s.dev!==guard.stat.dev)fail('directory_changed');}
      for(const l of locks){const s=await protectedStat(l.path,false);if(s.ino!==l.ino||s.dev!==l.dev||!same(await readJson(l.path),l.body))fail('lock_lost');}}
    const serial=<T>(action:()=>Promise<T>,allowPoisoned=false):Promise<T>=>{const result=queue.then(async()=>{await assertHeld();if(poisoned&&!allowPoisoned)fail('journal_uncertain');return action();});queue=result.catch(()=>{});return result;};
    const now=()=>time((input.now||(()=>new Date().toISOString()))());
    async function usable(){const instant=Date.parse(now());if(state.purged.size||[...state.publications.values()].some(p=>p.purged)||usableUntil<=instant||usableAfter>instant)fail('expired');}
    async function append(event:Event){
      event=json(event) as unknown as Event;
      if(state.count>=MAX_EVENTS)fail('entries');const next={schemaVersion:1 as const,sequence:state.count+1,parent:state.head,event};
      // Validate the transition BEFORE publishing immutable journal bytes.
      apply(state,event,true);const digest=sha256(canonicalJson(next)),bytes=Buffer.byteLength(canonicalJson(next))+1;
      if(state.bytes+bytes>MAX_JOURNAL)fail('journal_bytes');
      try{await immutable(join(directory,'events',`${String(next.sequence).padStart(6,'0')}.${digest}.json`),next);
        await durability?.commit(next);
        await replaceHead(directory,{sequence:state.count,sha256:state.head},{sequence:next.sequence,sha256:digest});
      }catch(error){poisoned=true;throw error;}
      apply(state,event);state.count=next.sequence;state.head=digest;state.bytes+=bytes;
    }
    async function catalogSuccessor(){
      const saved=state.successor;if(!saved)return null;if(saved.parts.length!==saved.count)fail('catalog_successor_incomplete');
      const bytes=Buffer.concat(saved.parts.map(p=>Buffer.from(p,'base64'))),value=JSON.parse(bytes.toString('utf8')) as ApprovedCatalogSeal;
      const encoded=(await import('./approved-catalog-seal.ts')).catalogSuccessorBytes(value);
      if(byteHash(encoded)!==saved.sha256||!encoded.equals(bytes)
        ||value.persistent?.request.codeSha!==(state.execution?.effective.codeSha??manifest.codeSha)
        ||value.persistent.request.environment!==manifest.scope.environment)fail('catalog_successor');return value;
    }
    async function put(value:unknown,kind:Kind,observedAt:string,reuseOriginal=false){
      if(state.success)fail('publication_completed');
      const ref=refFor(value);let sealed=stored(value,kind,observedAt,manifest);
      if(reuseOriginal)try{const previous=await loadStored(directory,ref,manifest);if(previous.kind!==kind)fail('kind');sealed=previous;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      fresh(sealed,now());
      await immutable(join(directory,ref.reference),sealed);
      const readback=await loadStored(directory,ref,manifest);fresh(readback,now());
      if(!state.refs.has(ref.sha256))await append({type:'artifact',ref});usableUntil=Math.min(usableUntil,Date.parse(sealed.expiresAt));usableAfter=Math.max(usableAfter,Date.parse(sealed.observedAt));return structuredClone(ref);
    }
    async function registered(ref:ArtifactRef){artifactRef(ref);if(!state.refs.has(ref.sha256))fail('unregistered_artifact');if(state.purged.has(ref.sha256))fail('expired');return loadStored(directory,ref,manifest);}
    async function read(ref:ArtifactRef){const v=await registered(ref);fresh(v,now());return v;}
    const buildPaths=()=>['build/stupid-gifts','static-site/out','static-site/.next'].map(name=>join(state.execution?.effective.sourceRoot??repository,name));
    const packagePath=(releaseId:string)=>join(directory,'packages',releaseId);
    const runtimePath=(releaseId:string)=>join(directory,'publication-runtime',releaseId);
    async function absent(path:string){try{await lstat(path);fail('publication_path_exists');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
    async function preparePublicationDirectories(releaseId:string,observedAt:string,nextExpiry:string|null){
      if(state.success)fail('publication_completed');
      await usable();const retention=publicationDirectories(releaseId,state.execution?.effective.sourceRoot??repository,observedAt,nextExpiry,manifest),prior=state.publications.get(releaseId);
      if(prior){if(!same(prior.retention,retention)||prior.purged)fail('publication_directories');}
      if(Date.parse(retention.expiresAt)<=Date.parse(now())||Date.parse(retention.observedAt)>Date.parse(now()))fail('expired');
      if(!prior){
        for(const path of [packagePath(releaseId),runtimePath(releaseId),...buildPaths()]){await pathWithoutLinks(path);await absent(path);}
        await privateDirectory(join(directory,'packages'),true);await privateDirectory(join(directory,'publication-runtime'),true);
        await append({type:'publication-directories',retention});
      }
      await privateDirectory(runtimePath(releaseId),true);await privateDirectory(join(runtimePath(releaseId),'tmp'),true);
      usableUntil=Math.min(usableUntil,Date.parse(retention.expiresAt));usableAfter=Math.max(usableAfter,Date.parse(retention.observedAt));
    }
    async function tree(paths:string[]){
      const entries:{path:string;directory:boolean;ino:number;dev:number;size:number;mtimeMs:number;ctimeMs:number}[]=[];
      async function visit(path:string){
        let stat;try{stat=await lstat(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
        assertPublicationCleanupEntryCount(entries.length+1);
        if(stat.isSymbolicLink()||stat.uid!==process.getuid?.()||!stat.isFile()&&!stat.isDirectory()
          ||!stat.isDirectory()&&stat.nlink!==1)fail('publication_tree');
        const directory=stat.isDirectory();entries.push({path,directory,ino:stat.ino,dev:stat.dev,size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs});
        if(directory)for(const name of (await readdir(path)).sort())await visit(join(path,name));
      }
      for(const path of paths){await pathWithoutLinks(path);await visit(path);}return entries;
    }
    async function removeTree(entries:Awaited<ReturnType<typeof tree>>){
      for(const entry of [...entries].reverse()){
        await assertHeld();const stat=await lstat(entry.path);
        if(stat.ino!==entry.ino||stat.dev!==entry.dev||stat.isSymbolicLink()||stat.isDirectory()!==entry.directory
          ||!entry.directory&&(stat.nlink!==1||stat.size!==entry.size||stat.mtimeMs!==entry.mtimeMs||stat.ctimeMs!==entry.ctimeMs))fail('publication_tree_changed');
        if(entry.directory)await rmdir(entry.path);else await unlink(entry.path);
        await syncDirectory(dirname(entry.path));
      }
    }
    async function cleanPublicationBuild(releaseId:string){
      if(cleanupOnly&&releaseId!==completedRelease)fail('cleanup_release');
      const p=state.publications.get(releaseId);if(!p||p.purged)fail('publication_directories');if(p.buildCleaned)return;
      const entries=await tree(buildPaths());
      try{await removeTree(entries);
        // Keep the source lock until this durable relinquishment. Interrupted
        // deletion/append leaves the existing no-takeover lock blocking.
        await append({type:'publication-build-cleaned',releaseId});
      }catch(error){poisoned=true;throw error;}
    }
    async function purgeExpired():Promise<WorkspaceStatus['expired']>{
      const instant=now(),plan:{artifact:PurgedArtifact;reference:string}[]=[];
      // Validate the complete bounded inventory before deleting anything. Only
      // exact object envelopes are classified; partial/temp/unrelated files stay.
      for(const name of (await readdir(join(directory,'objects'))).sort()){
        const pending=/^\.pending-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name);
        if(!pending&&!/^[a-f0-9]{64}\.json$/.test(name))continue;
        const reference=`objects/${name}`;
        // Complete interrupted temporary envelopes carry the same explicit
        // policy/deadline. Partial/unclassifiable bytes require operator review;
        // they are never assigned an invented retention or swept by age.
        const digest=pending?(await readJson(join(directory,reference)) as Stored).sha256:name.slice(0,-5);
        const ref=blobRef(digest),v=await loadStored(directory,ref,manifest,reference);
        const prior=state.purged.get(ref.sha256);
        if(prior&&prior.storedSha256!==sha256(canonicalJson(v)))fail('purge_body');
        if(prior||Date.parse(v.expiresAt)<=Date.parse(instant))plan.push({reference,artifact:prior||{ref,...retentionIdentity(v),storedSha256:sha256(canonicalJson(v))}});
      }
      const publications=[];
      for(const p of state.publications.values())if(Date.parse(p.retention.expiresAt)<=Date.parse(instant)){
        const paths=[packagePath(p.retention.releaseId),runtimePath(p.retention.releaseId),...(!p.buildCleaned?buildPaths():[])];
        publications.push({p,entries:await tree(paths)});
      }
      for(const {artifact}of plan)if(!state.purged.has(artifact.ref.sha256))await append({type:'purge',artifact,purgedAt:instant});
      for(const {p}of publications)if(!p.purged)await append({type:'publication-purged',releaseId:p.retention.releaseId,purgedAt:instant});
      try{
        // The remote tombstone commits before removal; a lost runner can
        // retry deletion from retained original expiry metadata, without bodies.
        for(const artifact of state.purged.values())await durability?.purge(artifact);
        for(const {artifact:v,reference}of plan){await assertHeld();const path=join(directory,reference);
          if(sha256(canonicalJson(await loadStored(directory,v.ref,manifest,reference)))!==v.storedSha256)fail('purge_body');
          await unlink(path);await syncDirectory(join(directory,'objects'));
        }
        for(const {p,entries}of publications){await removeTree(entries);
          if(!p.buildCleaned)await append({type:'publication-build-cleaned',releaseId:p.retention.releaseId});}
      }catch(error){poisoned=true;throw error;}
      return[...plan.map(({artifact:v,reference})=>({reference,kind:v.kind,expiresAt:v.expiresAt})),
        ...publications.filter(v=>v.entries.length).map(({p})=>({reference:`packages/${p.retention.releaseId}`,kind:'publication' as const,expiresAt:p.retention.expiresAt}))];
    }
    async function loadBlob(ref:ArtifactRef,reader=read):Promise<Buffer> {
      const sealed=await reader(ref);if(!['phase','publication'].includes(sealed.kind))fail('kind');
      const descriptor=blobManifest(sealed.value),bytes=Buffer.alloc(descriptor.byteLength);
      for(let index=0;index<descriptor.parts.length;index++){
        const part=await reader(blobRef(descriptor.parts[index]));
        if(!same(retentionIdentity(part),retentionIdentity(sealed)))fail('blob_retention');
        blobChunk(part.value,descriptor,index).copy(bytes,index*descriptor.chunkBytes);
      }
      if(byteHash(bytes)!==descriptor.sha256)fail('blob_hash');return bytes;
    }
    async function putBlob(input:Uint8Array,o:{kind:'phase'|'publication';observedAt:string}):Promise<ArtifactRef> {
      if(!(input instanceof Uint8Array)||input.byteLength>WORKSPACE_BLOB_LIMITS.bytes)fail('blob_bytes');
      if(!exact(o,['kind','observedAt'])||!['phase','publication'].includes(o.kind))fail('kind');await usable();time(o.observedAt);
      const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength),digest=byteHash(bytes),count=Math.ceil(bytes.length/WORKSPACE_BLOB_LIMITS.chunkBytes);
      const parts:BlobChunk[]=Array.from({length:count},(_,index)=>{
        const part=bytes.subarray(index*WORKSPACE_BLOB_LIMITS.chunkBytes,(index+1)*WORKSPACE_BLOB_LIMITS.chunkBytes);
        return{schemaVersion:1,type:'run-workspace-chunk',blobSha256:digest,blobByteLength:bytes.length,index,count,
          sha256:byteHash(part),byteLength:part.length,base64:part.toString('base64')};
      });
      const descriptor:WorkspaceBlobManifest={schemaVersion:1,type:'run-workspace-blob',sha256:digest,byteLength:bytes.length,
        chunkBytes:WORKSPACE_BLOB_LIMITS.chunkBytes,parts:parts.map(p=>refFor(p).sha256)};
      const ref=refFor(descriptor);let original:Stored|undefined,complete=false;
      try{original=await loadStored(directory,ref,manifest);complete=true;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      // Partial writes may have committed only chunks. Recover their ORIGINAL
      // retention before continuing; never refresh their age on a later retry.
      for(const digest of descriptor.parts){let previous:Stored;
        try{previous=await loadStored(directory,blobRef(digest),manifest);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;if(complete)fail('blob_missing');continue;}
        if(!original)original=previous;
        if(!same(retentionIdentity(previous),retentionIdentity(original)))fail('blob_retention');fresh(previous,now());
      }
      original??=stored(descriptor,o.kind,o.observedAt,manifest);
      if(original.kind!==o.kind)fail('kind');fresh(original,now());
      for(const part of parts)await put(part,o.kind,original.observedAt,true);
      await put(descriptor,o.kind,original.observedAt,true);
      // A manifest is published LAST, after every part has durable independent
      // readback. Re-read the aggregate before acknowledging a usable blob.
      await loadBlob(ref);return ref;
    }
    const api={directory,repository,manifest,manifestSha256:info.manifestSha256,assertHeld,
      get execution(){return structuredClone(state.execution);},
      adoptExecution:(value:ExecutionAdoption)=>serial(async()=>{
        validateExecutionAdoption(value);
        if(state.execution){if(!same(state.execution,value))fail('execution_adoption_rewrite');return structuredClone(state.execution);}
        await usable();
        if(value.original.sourceRoot!==repository||Date.parse(now())<Date.parse(value.approvedAt)
          ||Date.parse(now())>=Math.min(Date.parse(value.notAfter),Date.parse(value.contexts.replacement.cutoff)))fail('execution_adoption_window');
        const event:Event={type:'execution-adoption',adoption:structuredClone(value)};
        apply(state,event,true); // Exact original head/checkpoint BEFORE new artifacts.
        const old=await read(value.original.context);
        if(old.kind!=='phase'||!same(old.value,value.contexts.original)||old.observedAt!==value.observedAt||old.expiresAt!==value.notAfter)
          fail('execution_retention');
        const body=stored(value.contexts.replacement,'phase',old.observedAt,manifest);
        if(body.expiresAt!==old.expiresAt||body.sha256!==value.contexts.ref.sha256)fail('execution_retention');
        await acquireExecutionRoot(value);
        await immutable(join(directory,value.contexts.ref.reference),body);
        const verified=await loadStored(directory,value.contexts.ref,manifest);fresh(verified,now());
        if(!same(verified,body))fail('execution_retention');
        // ONE event registers the replacement ref and execution authority. An
        // orphan exact body after a lost pre-event ACK is safe to reuse.
        await append(event);usableUntil=Math.min(usableUntil,Date.parse(body.expiresAt));
        return structuredClone(state.execution!);
      }),
      assertScope:async(expected:WorkspaceScope)=>{await assertHeld();scope(expected);if(!same(manifest.scope,expected))fail('scope_mismatch');},
      putArtifact:(value:unknown,o:{kind:'phase'|'publication';observedAt:string})=>serial(async()=>{if(!o||!['phase','publication'].includes(o.kind))fail('kind');await usable();return put(json(value),o.kind,o.observedAt,true);}),
      readArtifact:(ref:ArtifactRef)=>serial(async()=>{const v=await read(ref);if(!['phase','publication'].includes(v.kind))fail('kind');return structuredClone(v.value);}),
      putBlob:async(bytes:Uint8Array,o:{kind:'phase'|'publication';observedAt:string})=>{
        if(!(bytes instanceof Uint8Array)||bytes.byteLength>WORKSPACE_BLOB_LIMITS.bytes)fail('blob_bytes');
        // Snapshot before joining the queue; later caller mutation cannot alter
        // exact ordered bytes while another durable operation is pending.
        const captured=Buffer.from(bytes),settings={...o};return serial(()=>putBlob(captured,settings));
      },
      readBlob:(ref:ArtifactRef)=>serial(()=>loadBlob(ref)),
      saveReceipt:(o:Readonly<{sha256:string;receipt:ProviderReceipt}>)=>serial(async()=>{receipt(o.receipt);if(o.sha256!==refFor(o.receipt).sha256)fail('receipt_hash');
        await usable();return put(o.receipt,o.receipt.kind,o.receipt.observedAt);}),
      readReceipt:(ref:ArtifactRef)=>serial(async()=>{const v=await read(ref);if(!['amazon-observation','embedding-response'].includes(v.kind))fail('kind');
        receipt(v.value as unknown as ProviderReceipt);return structuredClone(v.value) as unknown as ProviderReceipt;}),
      catalogSuccessor:()=>serial(catalogSuccessor),
      recordCatalogSuccessor:(value:ApprovedCatalogSeal)=>serial(async()=>{
        const bytes=(await import('./approved-catalog-seal.ts')).catalogSuccessorBytes(value),digest=byteHash(bytes),count=Math.ceil(bytes.length/65536);
        if(value.persistent!.request.environment!==manifest.scope.environment
          ||value.persistent!.request.codeSha!==(state.execution?.effective.codeSha??manifest.codeSha))fail('catalog_successor_scope');
        if(state.successor&&(state.successor.sha256!==digest||state.successor.count!==count))fail('catalog_successor_rewrite');
        for(let index=state.successor?.parts.length??0;index<count;index++)await append({type:'catalog-successor-part',sha256:digest,index,count,
          data:bytes.subarray(index*65536,(index+1)*65536).toString('base64')});
        if(!same(await catalogSuccessor(),value))fail('catalog_successor');
      }),
      readCheckpoint:(o?:{controlOnly?:boolean})=>serial(async()=>{if(!state.checkpoint)return null;
        if(o?.controlOnly===true)return structuredClone(state.checkpoint);await usable();
        const v=await read(state.body!);
        if(v.kind!=='checkpoint')fail('kind');checkpoint(v.value as unknown as WorkspaceCheckpoint);
        const body=v.value as unknown as WorkspaceCheckpoint;
        return{sha256:state.checkpoint.sha256,checkpoint:{...structuredClone(body),...structuredClone(state.checkpoint.checkpoint)}};}),
      writeCheckpoint:(expected:string|null,value:WorkspaceCheckpoint)=>serial(async()=>{
        checkpoint(value);bindCheckpoint(value,manifest,state.execution);await usable();const digest=refFor(value).sha256;
        if(state.checkpoint?.sha256===digest&&(state.previous===expected||expected===digest)){return{sha256:digest,checkpoint:structuredClone(value)};}
        if(expected!==(state.checkpoint?.sha256||null))fail('checkpoint_cas');
        for(const ref of [...Object.values(value.pins),...(value.phaseComplete?[value.phaseComplete]:[])]){
          const v=await read(ref);if(v.value&&typeof v.value==='object'&&!Array.isArray(v.value)&&v.value.type==='run-workspace-blob')await loadBlob(ref);
        }
        const {state:unused,...view}=value;void unused;
        // First validate immutable pins/phase-complete before writing the body.
        const event:Event={type:'checkpoint',ref:refFor(value),previous:expected,control:json(view) as unknown as CheckpointControl};apply(state,event,true);
        const ref=await put(value,'checkpoint',now(),true);await append({...event,ref});return{sha256:ref.sha256,checkpoint:structuredClone(value)};
      }),
      writeControlCheckpoint:(expected:string,value:{phase:'attention'|'published'|'finalized';owner:MutationOwner|null;control:WorkspaceControl})=>serial(async()=>{
        if(!exact(value,['phase','owner','control'])||!state.checkpoint)fail('control_reconciliation');
        const view={...state.checkpoint.checkpoint,...structuredClone(value)} as CheckpointControl;bindCheckpoint(view,manifest,state.execution);
        const digest=sha256(canonicalJson({previous:expected,control:view}));
        if(state.checkpoint.sha256===digest&&state.previous===expected)return structuredClone(state.checkpoint);
        if(state.checkpoint.sha256!==expected)fail('checkpoint_cas');
        await append({type:'control',previous:expected,sha256:digest,control:view});return structuredClone(state.checkpoint!);
      }),
      readPermanentFinalization:(label:'revision'|'summary')=>serial(async()=>{
        if((state.recovery?.scope!=='approved-permanent-finalization'&&!state.finish)||!['revision','summary'].includes(label))fail('permanent_control');
        const cp=state.checkpoint!.checkpoint,p=cp.control!.publication!;
        if(p.permit)recoveryPermit(state,true,true);
        else if(!state.finish||!cp.pins.publicationUploadAcknowledged||cp.pins.publicationUploadReview
          ||cp.owner?.phase!=='freezing'||p.stage!=='activating'||p.versionReference!==state.finish.versionReference)fail('permanent_control');
        const ref=label==='revision'?cp.pins.revision:cp.phaseComplete;if(!ref)fail('permanent_control');
        const body=await registered(ref);if(body.kind!=='publication')fail('permanent_control');
        const value=typeof body.value==='string'?JSON.parse(body.value)
          :body.value&&typeof body.value==='object'&&!Array.isArray(body.value)&&body.value.type==='run-workspace-blob'
            ?JSON.parse((await loadBlob(ref,registered)).toString('utf8')):body.value;
        return structuredClone(label==='revision'?activatedPermanentRevisionControl(value,p,p.permit?.mutationOwner??cp.owner??undefined):activatedPermanentSummary(value)) as unknown as Json;
      }),
      reserveBudget:(value:BudgetReservation)=>serial(async()=>{reservation(value);const old=state.reservations.get(value.id);
        if(old){if(!same(old.reservation,value))fail('budget_replay');return;}budgetReservation(state,value);
        await append({type:'reserve',reservation:json(value) as unknown as BudgetReservation});}),
      settleBudget:(id:string,value:BudgetSettlement)=>serial(async()=>{settlement(value);const old=state.reservations.get(id);if(!old)fail('budget_reservation_missing');
        if(old.settlement){if(!same(old.settlement,value))fail('budget_settlement_replay');return;}await append({type:'settle',id,settlement:json(value) as unknown as BudgetSettlement});}),
      grantActivationRecoveryBudget:(input:ActivationRecoveryBudget)=>serial(async()=>{
        recoveryInput(input);
        if(state.recovery){const {permitSha256:unused,usage:unusedUsage,...original}=state.recovery;void unused;void unusedUsage;
          if(!same(original,input))fail('recovery_replay');return ceiling(state);}
        if(state.checkpoint?.sha256!==input.expectedCheckpointSha256)fail('checkpoint_cas');
        const finalizing=input.scope==='approved-permanent-finalization',permit=recoveryPermit(state,false,finalizing);
        if(finalizing){
          // Inspect only the original hash-bound immutable package, never a new
          // supplier observation or a renewed body/publication deadline.
          const p=state.checkpoint!.checkpoint.control!.publication!,registered=state.publications.get(p.intent!.releaseId);
          // Already activated permanent public fields do not become supplier
          // bodies when unrelated original observation retention elapses.
          if(!registered||registered.purged||registered.retention.nextExpiry!==null||registered.retention.observedAt>now())fail('recovery_snapshot');
          const file=join(packagePath(p.intent!.releaseId),'catalog.snapshot.json');await pathWithoutLinks(file);
          const bytes=await readBytes(file,WORKSPACE_BLOB_LIMITS.bytes),snapshot=JSON.parse(bytes.toString('utf8'));
          if(byteHash(bytes)!==p.intent!.catalogSnapshotSha256||p.build.request.sourceDigest!==p.intent!.catalogSnapshotSha256
            ||snapshot.catalogRevision!==p.intent!.catalogRevision||!Array.isArray(snapshot.products)||!snapshot.products.length
            ||snapshot.products.some((v:unknown)=>!v||typeof v!=='object'||Array.isArray(v)||(v as {eligibleUntil?:unknown}).eligibleUntil!==null))fail('recovery_snapshot');
        }
        const grant={...structuredClone(input),permitSha256:sha256(canonicalJson(permit)),usage:totals(state)};
        await append({type:'activation-recovery-budget',grant});return ceiling(state);
      }),
      grantPublicationFinishBudget:(input:PublicationFinishBudget)=>serial(async()=>{
        if(state.finish){const {usage:unused,...original}=state.finish;void unused;
          if(!same(original,input))fail('finish_budget_replay');return ceiling(state);}
        await append({type:'publication-finish-budget',grant:{...structuredClone(input),usage:totals(state)}});return ceiling(state);
      }),
      publicationFinishBudget:()=>serial(async()=>{
        if(!state.finish)return null;const {usage:unused,...grant}=state.finish;void unused;return structuredClone(grant);
      }),
      grantPublicationRequestBudget:(input:PublicationRequestBudget)=>serial(async()=>{
        if(state.requestGrant){const {usage:unused,...original}=state.requestGrant;void unused;
          if(!same(original,input))fail('request_budget_replay');return ceiling(state);}
        if(time(input.approvedAt)>now()||time(input.publicationUntil)<=now())fail('request_budget_window');
        await append({type:'publication-request-budget',grant:{...structuredClone(input),usage:totals(state)}});return ceiling(state);
      }),
      publicationRequestBudget:()=>serial(async()=>{
        if(!state.requestGrant)return null;const {usage:unused,...grant}=state.requestGrant;void unused;return structuredClone(grant);
      }),
      publicationSuccess:()=>serial(async()=>{await verifySuccessMetadata(directory,state);return structuredClone(state.success);}),
      recordPublicationSuccess:(value:PublicationSuccessInput)=>serial(async()=>{
        const proof:PublicationSuccess={...structuredClone(value),recoveryBounds:await recoveryBoundsInventory(directory,state)};
        if(state.success){if(!same(state.success,proof))fail('publication_completed');return structuredClone(state.success);}
        const age=Date.parse(now())-Date.parse(time(value.scope.observed_at));
        if(age<0||age>30_000)fail('publication_success_stale');
        await append({type:'publication-success',proof});return structuredClone(proof);
      }),
      budget:()=>serial(async()=>totals(state)),budgetCeiling:()=>serial(async()=>ceiling(state)),
      budgetRowsReadCeiling:()=>serial(async()=>state.recovery?.scope==='approved-permanent-finalization'?state.recovery.reportedRowsRead!:null),
      preparePublicationDirectories:(releaseId:string,observedAt:string,nextExpiry:string|null)=>serial(()=>preparePublicationDirectories(releaseId,observedAt,nextExpiry)),
      cleanPublicationBuild:(releaseId:string)=>serial(()=>cleanPublicationBuild(releaseId)),
      purgeExpired:()=>serial(purgeExpired),
      // A live durable handle may release ONLY its independently verified local
      // locks after failed mirroring. Reopen reconciles remote CAS first; this
      // neither clears D1 ownership nor changes the uncertain journal/charges.
      close:()=>serial(async()=>{for(const lock of [...locks].reverse()){await unlink(lock.path);await syncDirectory(dirname(lock.path));}closed=true;},!!input.durable),
    };
    return Object.freeze(api) as RunWorkspace;
  }catch(error){
    // Remove only locks whose exact inode AND token remain ours. Any uncertain
    // acquisition/crash residue remains blocking for explicit operator review.
    for(const l of locks.reverse())try{const s=await protectedStat(l.path,false);if(s.ino===l.ino&&s.dev===l.dev&&same(await readJson(l.path),l.body)){await unlink(l.path);await syncDirectory(dirname(l.path));}}catch{/* fail closed */}
    throw error;
  }
}
