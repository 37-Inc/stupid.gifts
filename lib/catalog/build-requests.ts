import type { CatalogSnapshot } from './types.ts';
import type { CatalogD1 } from './storage/d1.ts';
import { catalogDisplayDeadline, earliestDisplayExpiry } from './display.ts';
import type { PublicationClaim, PublicationIntent } from './publication.ts';
import { encodePublicationIntent, publicationStatus, publicationActivationGate } from './publication.ts';
import { rollbackPreflight, visibleRevisionCountQuery } from './d1.ts';
import { canonicalTime } from './snapshot.ts';
import { canonicalJson } from './canonical-json.ts';
import { legacyMutationBatch, legacyMutationGuard, mutationAssertion, mutationFenceQuery, unabandonedImportsQuery } from './mutation-fence.ts';
import type { MutationOwner } from './mutation-fence.ts';
import type { D1Statement } from './storage/d1.ts';

/** Immutable build inputs, not a guessed future release manifest. cutoff is the
 * pruning horizon: a build may retain only products eligible strictly beyond it.
 */
export interface CatalogBuildRequest {
  schemaVersion: 1; environment: 'staging' | 'production'; sourceRevision: string; sourceDigest: string;
  codeSha: string; priorReleaseId: string | null; capturedAt: string; cutoff: string;
}
export interface CatalogBuildClaim {
  requestId: string; token: string; runReference: string; leaseUntil: string; request: CatalogBuildRequest;
}
/** Explicit continuation of a permanent, unchanged snapshot; not supplier rights. */
export interface PermanentPublicationAuthority {approvalReference:string;approvedAt:string;publicationUntil:string}
export async function permanentPublicationDeadline(request:CatalogBuildRequest,snapshot:CatalogSnapshot,
  authority:PermanentPublicationAuthority,now=new Date()):Promise<string>{
  const approved=Date.parse(canonicalTime(authority.approvedAt)),until=Date.parse(canonicalTime(authority.publicationUntil));
  if(Object.keys(authority).sort().join(',')!=='approvalReference,approvedAt,publicationUntil'||!HASH.test(authority.approvalReference)
    ||approved<Date.parse(request.capturedAt)||approved>now.getTime()||until-approved!==7200000||until<=now.getTime()
    ||snapshot.catalogRevision!==request.sourceRevision||!snapshot.products.length||snapshot.products.some(p=>p.eligibleUntil!==null)
    ||await digest(`${JSON.stringify(snapshot)}\n`)!==request.sourceDigest)throw Error('build_permanent_continuation_invalid');
  return authority.publicationUntil;
}
export interface BuildRecoveryApproval {
  schemaVersion:1;requestId:string;packageSha256:string;previousToken:string;checkpointSha256:string;reviewReference:string;
}
export interface DeploymentIdentity {
  releaseId: string; codeSha: string; catalogRevision: string; catalogSnapshotSha256: string; manifestSha256: string;
  versionReference: string;
}
/** Trusted external adapter, never an HTTP body asserting success. settled means
 * the serialized deployment owner has independently ruled out in-flight activation.
 * null is verified absence, not a failed read. No provider mutation is injected here.
 */
export interface DeploymentObservation {
  environment: CatalogBuildRequest['environment']; settled: boolean; active: DeploymentIdentity | null;
}
export interface ActivationPermit { requestId: string; token: string; runReference: string; releaseId: string; versionReference: string; mutationOwner?: MutationOwner }
type BuildRow = { request_id: string; environment: string; source_revision: string; request_json: string; state: string;
  lease_token: string | null; lease_until: string | null; attempts: number; dispatch_reference: string | null;
  run_reference: string | null; release_id: string | null; version_reference: string | null };
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const KEY = /^[a-zA-Z0-9._-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;
const REFERENCE = /^[a-zA-Z0-9._:/-]{1,200}$/;

export function encodeBuildRequest(value: CatalogBuildRequest): string {
  if (!value || Object.keys(value).sort().join(',') !== 'capturedAt,codeSha,cutoff,environment,priorReleaseId,schemaVersion,sourceDigest,sourceRevision'
    || value.schemaVersion !== 1 || !['staging', 'production'].includes(value.environment)
    || typeof value.sourceRevision !== 'string' || !KEY.test(value.sourceRevision)
    || typeof value.sourceDigest !== 'string' || !HASH.test(value.sourceDigest)
    || typeof value.codeSha !== 'string' || !/^[a-f0-9]{40}$/.test(value.codeSha)
    || value.priorReleaseId !== null && (typeof value.priorReleaseId !== 'string' || !KEY.test(value.priorReleaseId))) throw new Error('invalid_build_request');
  const captured = Date.parse(canonicalTime(value.capturedAt)); const cutoff = Date.parse(canonicalTime(value.cutoff));
  if (cutoff <= captured || cutoff - captured > 26 * 3600000) throw new Error('invalid_build_request_horizon');
  return JSON.stringify({ schemaVersion: 1, environment: value.environment, sourceRevision: value.sourceRevision,
    sourceDigest: value.sourceDigest, codeSha: value.codeSha, priorReleaseId: value.priorReleaseId,
    capturedAt: value.capturedAt, cutoff: value.cutoff });
}
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function row(db: CatalogD1, id: string): Promise<BuildRow | undefined> {
  return (await db.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').bind(id).all<BuildRow>()).results[0];
}
function input(value: BuildRow): CatalogBuildRequest {
  const request = JSON.parse(value.request_json) as CatalogBuildRequest;
  if (encodeBuildRequest(request) !== value.request_json || request.environment !== value.environment
    || request.sourceRevision !== value.source_revision) throw new Error('build_request_corrupt');
  return request;
}
function sourceGate(request: CatalogBuildRequest, deadline=request.cutoff) {
  return { sql: `EXISTS(SELECT 1 FROM catalog_revisions c JOIN catalog_projection_receipts p ON p.catalog_revision=c.revision
      AND p.source_export_sha256=c.source_export_sha256 WHERE c.revision=? AND c.status IN ('reconciled','published') AND p.snapshot_sha256=?)
    AND ?<=${NOW} AND ?>${NOW}
    AND (? IS NULL OR EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?))`,
  params: [request.sourceRevision, request.sourceDigest, request.capturedAt, deadline, request.priorReleaseId, request.priorReleaseId] };
}

/** Only the confirmed creator may dispatch. Unknown/lost writes require explicit
 * dispatch reconciliation; blindly repeating an external dispatch is not safe.
 */
export async function enqueueBuildRequest(db: CatalogD1, request: CatalogBuildRequest) {
  const bytes = encodeBuildRequest(request); const requestId = await digest(bytes); const gate = sourceGate(request);
  const result = await db.prepare(`INSERT INTO catalog_build_requests(request_id,environment,source_revision,request_json)
    SELECT ?,?,?,? WHERE ${gate.sql} ON CONFLICT(request_id) DO NOTHING`)
    .bind(requestId, request.environment, request.sourceRevision, bytes, ...gate.params).run() as { success?: boolean; meta?: { changes?: number } };
  const stored = await row(db, requestId);
  if (!stored || stored.request_json !== bytes) throw new Error('build_source_unavailable_or_expired');
  return { requestId, created: result.success === true && result.meta?.changes === 1 };
}
export async function recordBuildDispatch(db: CatalogD1, requestId: string, reference: string | null): Promise<void> {
  if (reference !== null && (typeof reference !== 'string' || !REFERENCE.test(reference))) throw new Error('invalid_build_reference');
  await db.prepare(`UPDATE catalog_build_requests SET dispatch_reference=?,error_code=? WHERE request_id=?
    AND dispatch_reference IS NULL AND state IN ('pending','building')`)
    .bind(reference, reference === null ? 'dispatch_unconfirmed' : null, requestId).run();
}
/** Queue wait consumes no lease. A protected workflow claims only when it starts.
 * Expired building owners may retry at most3 times; activating owners never expire.
 */
export async function claimBuildRequest(db: CatalogD1, requestId: string, runReference: string, now = new Date(), leaseMs = 600000,
  continuation?:{authority:PermanentPublicationAuthority;snapshot:CatalogSnapshot;owner:MutationOwner}): Promise<CatalogBuildClaim | null> {
  if (typeof runReference !== 'string' || !REFERENCE.test(runReference)) throw new Error('invalid_build_reference');
  const stored = await row(db, requestId); if (!stored) throw new Error('build_request_missing');
  const request = input(stored),deadline=continuation?await permanentPublicationDeadline(request,continuation.snapshot,continuation.authority,now):request.cutoff;
  if(continuation&&(continuation.owner.environment!==request.environment||continuation.owner.phase!=='freezing'
    ||stored.run_reference!==runReference||stored.dispatch_reference!==null))throw Error('build_permanent_continuation_invalid');
  const gate = sourceGate(request,deadline); const token = crypto.randomUUID();
  const leaseUntil = new Date(Math.min(now.getTime() + Math.max(1000, Math.min(leaseMs, 3600000)), Date.parse(deadline))).toISOString();
  await db.batch([
    ...(continuation?[mutationAssertion(db,continuation.owner,['freezing'])]:[]),
    ...(continuation?[db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_vector_deliveries
      WHERE environment=? AND index_name=? AND generation=? AND status='complete' AND disposition='verified'
      AND json_extract(request_json,'$.kind')='approved-cohort-plan' AND json_extract(request_json,'$.catalogRevision')=?
      AND json_extract(owner_json,'$.operationKey')=?) THEN 'true' ELSE 'build_permanent_continuation_invalid' END)`)
      .bind(continuation.owner.environment,continuation.owner.indexName,continuation.owner.generation,request.sourceRevision,continuation.owner.operationKey)]:[]),
    db.prepare(`UPDATE catalog_build_requests SET state='failed',lease_token=NULL,lease_until=NULL,error_code='build_failed'
      WHERE environment=? AND source_revision=? AND state='building' AND lease_until<=${NOW}`).bind(request.environment, request.sourceRevision),
    db.prepare(`UPDATE catalog_build_requests SET state='building',lease_token=?,lease_until=?,run_reference=?,attempts=attempts+1,
      release_id=NULL,version_reference=NULL,error_code=NULL WHERE request_id=? AND state IN ('pending','failed') AND attempts<3
      AND NOT EXISTS(SELECT 1 FROM catalog_build_requests WHERE environment=? AND
        (state='activating' OR (source_revision=? AND state='building')))
      AND ?>${NOW} AND ${gate.sql}`)
      .bind(token, leaseUntil, runReference, requestId, request.environment, request.sourceRevision, leaseUntil, ...gate.params),
    ...(continuation?[mutationAssertion(db,continuation.owner,['freezing'])]:[]),
  ]);
  const claimed = await row(db, requestId);
  return claimed?.state === 'building' && claimed.lease_token === token
    ? { requestId, token, runReference, leaseUntil, request } : null;
}

export function encodeBuildRecoveryApproval(value:BuildRecoveryApproval):string {
  if(!value||Object.keys(value).sort().join(',')!=='checkpointSha256,packageSha256,previousToken,requestId,reviewReference,schemaVersion'
    ||value.schemaVersion!==1||![value.requestId,value.packageSha256,value.checkpointSha256].every(v=>typeof v==='string'&&HASH.test(v))
    ||typeof value.previousToken!=='string'||!KEY.test(value.previousToken)||typeof value.reviewReference!=='string'||!REFERENCE.test(value.reviewReference))
    throw new Error('build_operator_recovery_invalid');
  return JSON.stringify({schemaVersion:1,requestId:value.requestId,packageSha256:value.packageSha256,previousToken:value.previousToken,
    checkpointSha256:value.checkpointSha256,reviewReference:value.reviewReference});
}
type BuildRecoveryReceipt={schemaVersion:1;kind:'unstarted-build-operator-recovery';approval:BuildRecoveryApproval;owner:MutationOwner;
  releaseId:string;previous:Record<string,unknown>;normalAttempts:3;operatorAttempts:1;totalAttempts:4;observedAt:string;token:string;leaseUntil:string};
const flat=(value:object)=>JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))));
async function operatorBuildRecovery(db:CatalogD1,claim:CatalogBuildClaim,owner:MutationOwner,releaseId:string,approval:BuildRecoveryApproval,create:boolean):Promise<CatalogBuildClaim> {
  ({claim,owner,approval}=structuredClone({claim,owner,approval}));
  const approvalBytes=encodeBuildRecoveryApproval(approval),requestBytes=encodeBuildRequest(claim.request),gate=sourceGate(claim.request);
  mutationFenceQuery(owner,['freezing']);
  if(owner.phase!=='freezing'||claim.request.environment!==owner.environment||approval.requestId!==claim.requestId
    ||await digest(requestBytes)!==claim.requestId||!KEY.test(releaseId)||!REFERENCE.test(claim.runReference))throw new Error('build_operator_recovery_fenced');
  const observed=(await db.prepare(`SELECT *,${NOW} observation_time FROM catalog_build_requests WHERE request_id=?`)
    .bind(claim.requestId).all<Record<string,unknown>>()).results[0];
  if(!observed)throw new Error('build_operator_recovery_fenced');
  const {observation_time,...stored}=observed,at=canonicalTime(String(observation_time));let receipt:BuildRecoveryReceipt;
  if(stored.operator_recovery_json===null){
    if(!create||claim.token!==approval.previousToken||stored.lease_token!==claim.token||stored.lease_until!==claim.leaseUntil)
      throw new Error('build_operator_recovery_fenced');
    receipt={schemaVersion:1,kind:'unstarted-build-operator-recovery',approval,owner,releaseId,previous:stored,normalAttempts:3,operatorAttempts:1,totalAttempts:4,
      observedAt:at,token:crypto.randomUUID(),leaseUntil:new Date(Math.min(Date.parse(at)+900000,Date.parse(claim.request.cutoff))).toISOString()};
  }else{
    try{receipt=JSON.parse(String(stored.operator_recovery_json));}catch{throw new Error('build_operator_recovery_fenced');}
  }
  const p=receipt?.previous,receiptBytes=JSON.stringify(receipt);
  if(!receipt||Object.keys(receipt).sort().join(',')!=='approval,kind,leaseUntil,normalAttempts,observedAt,operatorAttempts,owner,previous,releaseId,schemaVersion,token,totalAttempts'
    ||receipt.schemaVersion!==1||receipt.kind!=='unstarted-build-operator-recovery'||encodeBuildRecoveryApproval(receipt.approval)!==approvalBytes
    ||flat(receipt.owner)!==flat(owner)||receipt.releaseId!==releaseId||receipt.normalAttempts!==3||receipt.operatorAttempts!==1||receipt.totalAttempts!==4
    ||!p||p.operator_recovery_json!==null||p.request_id!==claim.requestId||p.request_json!==requestBytes||p.environment!==claim.request.environment
    ||p.source_revision!==claim.request.sourceRevision||p.state!=='building'||p.attempts!==3||p.run_reference!==claim.runReference
    ||p.lease_token!==approval.previousToken||p.dispatch_reference!==null||p.error_code!==null||p.release_id!==null||p.version_reference!==null
    ||typeof receipt.token!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(receipt.token)||receipt.token===p.lease_token
    ||canonicalTime(String(p.lease_until))>receipt.observedAt||canonicalTime(receipt.observedAt)>at
    ||canonicalTime(receipt.leaseUntil)<=at||receipt.leaseUntil>claim.request.cutoff||Date.parse(receipt.leaseUntil)>Date.parse(receipt.observedAt)+900000
    ||claim.token!==p.lease_token&&claim.token!==receipt.token
    ||claim.leaseUntil!==(claim.token===p.lease_token?p.lease_until:receipt.leaseUntil))throw new Error('build_operator_recovery_fenced');
  const expected={...p,lease_token:receipt.token,lease_until:receipt.leaseUntil,operator_recovery_json:receiptBytes};
  if(stored.operator_recovery_json!==null&&(stored.operator_recovery_json!==receiptBytes||flat(stored)!==flat(expected)))throw new Error('build_operator_recovery_fenced');
  const columns=Object.keys(stored).sort();if(columns.some(k=>!/^[_a-z][_a-z0-9]*$/.test(k)))throw new Error('build_operator_recovery_fenced');
  const exact=(row:Record<string,unknown>,fresh=false)=>db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_build_requests
    WHERE ${columns.map(k=>`${k} IS ?`).join(' AND ')}${fresh?` AND lease_until>${NOW}`:''}) AND ${gate.sql} THEN 'true' ELSE 'build_operator_recovery_fenced' END)`)
    .bind(...columns.map(k=>row[k]),...gate.params);
  const undispatched=()=>db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM publication_outbox WHERE release_id=?)
    AND NOT EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?) THEN 'true' ELSE 'build_operator_recovery_fenced' END)`).bind(releaseId,releaseId);
  await db.batch([mutationAssertion(db,owner,['freezing']),exact(stored),undispatched(),
    ...(stored.operator_recovery_json===null?[db.prepare(`UPDATE catalog_build_requests SET lease_token=?,lease_until=?,operator_recovery_json=?
      WHERE request_id=? AND operator_recovery_json IS NULL AND attempts=3 AND state='building' AND lease_until<=${NOW}`)
      .bind(receipt.token,receipt.leaseUntil,receiptBytes,claim.requestId)]:[]),exact(expected,true),undispatched(),mutationAssertion(db,owner,['freezing'])]);
  return{...claim,token:receipt.token,leaseUntil:receipt.leaseUntil};
}
/** Trusted operator only: caller proves the exact current checkpoint, sealed
 * package and exhaustive provider absence, then persists a dispatch marker
 * before this sole write. Existing markers must use the read-only API instead.
 * Three normal attempts remain;
 * the immutable receipt records ONE separate operator attempt, never a reset. */
export const recoverUnstartedBuildRequest=(db:CatalogD1,claim:CatalogBuildClaim,owner:MutationOwner,releaseId:string,approval:BuildRecoveryApproval)=>
  operatorBuildRecovery(db,claim,owner,releaseId,approval,true);
/** Unknown write ACKs may read this exact receipt, never repeat a missing grant
 * or adopt a foreign replacement token. Initial checkpoint binding is retained
 * in approval; later matching-receipt replay does not rebind it to a new head. */
export const readUnstartedBuildRecovery=(db:CatalogD1,claim:CatalogBuildClaim,owner:MutationOwner,releaseId:string,approval:BuildRecoveryApproval)=>
  operatorBuildRecovery(db,claim,owner,releaseId,approval,false);
export async function failBuildRequest(db: CatalogD1, claim: CatalogBuildClaim): Promise<void> {
  await db.prepare(`UPDATE catalog_build_requests SET state='failed',lease_token=NULL,lease_until=NULL,error_code='build_failed'
    WHERE request_id=? AND lease_token=? AND run_reference=? AND state='building' AND lease_until>${NOW}`)
    .bind(claim.requestId, claim.token, claim.runReference).run();
}
/** Bounded cleanup only. Never wait forever for an arbitrary injected adapter. */
export async function drainDeploymentObservation(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([pending.catch(() => undefined), new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('deployment_observation_cleanup_pending')), 10_000);
  })]); }
  finally { clearTimeout(timer); }
}
async function observe(adapter: (signal: AbortSignal) => Promise<DeploymentObservation>, timeoutMs = 3000): Promise<DeploymentObservation> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([adapter(controller.signal), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('deployment_observation_failed')); }, timeoutMs);
    })]);
  } catch { controller.abort(); throw new Error('deployment_observation_failed'); } finally { clearTimeout(timer); }
}
function matches(active: DeploymentIdentity, intent: PublicationIntent) {
  return active.releaseId === intent.releaseId && active.codeSha === intent.codeSha && active.catalogRevision === intent.catalogRevision
    && active.catalogSnapshotSha256 === intent.catalogSnapshotSha256 && active.manifestSha256 === intent.manifestSha256
    && typeof active.versionReference === 'string' && REFERENCE.test(active.versionReference);
}
async function priorMatches(db: CatalogD1, request: CatalogBuildRequest, active: DeploymentIdentity | null,
  servingPrior?: DeploymentIdentity): Promise<boolean> {
  if (request.priorReleaseId === null) return active === null;
  const prior = (await db.prepare('SELECT code_sha,catalog_revision,manifest_json FROM publication_receipts WHERE release_id=?')
    .bind(request.priorReleaseId).all<{ code_sha: string; catalog_revision: string; manifest_json: string }>()).results[0];
  if (!active || !prior) return false;
  const intent = JSON.parse(prior.manifest_json) as PublicationIntent;
  if (intent.releaseId !== request.priorReleaseId || intent.codeSha !== prior.code_sha
    || intent.catalogRevision !== prior.catalog_revision) return false;
  if (!servingPrior) return matches(active, intent);
  // A code-only deployment may serve the same accepted catalog. It is not a
  // D1 receipt: bind the exact independently observed deployment separately.
  return servingPrior.catalogRevision === intent.catalogRevision
    && servingPrior.catalogSnapshotSha256 === intent.catalogSnapshotSha256
    && canonicalJson(active) === canonicalJson(servingPrior);
}

/** Returns permission to activate exactly one already-uploaded version, NOT proof
 * of activation. The protected local workflow holds a cooperative same-host
 * deployment-scope lock; cross-host CI requires one environment concurrency group
 * before use. All writers must honor importing/activating barriers. There is no cross-system
 * atomicity: after this CAS, unknown provider outcomes stay fenced until resolved.
 */
export async function beginBuildActivation(db: CatalogD1, claim: CatalogBuildClaim, snapshot: CatalogSnapshot,
  publication: PublicationClaim, versionReference: string, readDeployment: (signal: AbortSignal) => Promise<DeploymentObservation>, now = new Date(), mutationOwner?: MutationOwner,
  servingPrior?: DeploymentIdentity,continuation?:PermanentPublicationAuthority): Promise<ActivationPermit> {
  if (typeof versionReference !== 'string' || !REFERENCE.test(versionReference)) throw new Error('invalid_build_reference');
  const stored = await row(db, claim.requestId);
  if (!stored || stored.state !== 'building' || stored.lease_token !== claim.token
    || stored.request_json !== encodeBuildRequest(claim.request) || stored.run_reference !== claim.runReference) throw new Error('build_fenced');
  const request = input(stored); const intent = publication.intent;
  if (mutationOwner && mutationOwner.environment !== request.environment) throw new Error('build_fenced');
  const mutation = mutationOwner ? mutationFenceQuery(mutationOwner, ['freezing']) : await legacyMutationGuard(db);
  // Receipts are append-only in this protocol; reject publication completed during readback.
  const receiptEpoch = (await db.prepare('SELECT coalesce(max(rowid),0) epoch FROM publication_receipts')
    .all<{ epoch: number }>()).results[0].epoch;
  const observed = await observe(readDeployment,30_000);
  if (observed.environment !== request.environment || observed.settled !== true || !(await priorMatches(db, request, observed.active, servingPrior))) throw new Error('build_prior_deployment_changed');
  const earliest = earliestDisplayExpiry(snapshot.products);
  if (intent.codeSha !== request.codeSha || intent.priorReleaseId !== request.priorReleaseId || snapshot.catalogRevision !== intent.catalogRevision
    || intent.nextExpiry !== earliest || snapshot.products.some(product => catalogDisplayDeadline(product) <= Date.parse(request.cutoff))
    || !(await rollbackPreflight(db, snapshot, now)).ok) throw new Error('build_publication_unready');
  if(continuation&&(!mutationOwner||mutationOwner.phase!=='freezing'))throw Error('build_permanent_continuation_invalid');
  const gate = sourceGate(request,continuation?await permanentPublicationDeadline(request,snapshot,continuation,now):request.cutoff);
  const visible = visibleRevisionCountQuery(intent.catalogRevision);
  const imports = await unabandonedImportsQuery(db,request.environment);
  const statement = db.prepare(`UPDATE catalog_build_requests SET state='activating',lease_until=NULL,release_id=?,version_reference=?
    WHERE request_id=? AND request_json=? AND lease_token=? AND run_reference=? AND state='building' AND (lease_until>${NOW} OR ?=1)
      AND ${gate.sql}
      AND NOT EXISTS(SELECT 1 FROM catalog_build_requests WHERE environment=? AND state='activating')
      AND (SELECT coalesce(max(rowid),0) FROM publication_receipts)=?
      AND ${imports.sql}
      AND EXISTS(SELECT 1 FROM publication_outbox WHERE intent_id=? AND release_id=? AND intent_json=? AND lease_token=?
        AND state='dispatched' AND (lease_until>${NOW} OR ?=1) AND (?=0 OR dispatch_reference=?))
      AND EXISTS(SELECT 1 FROM catalog_projection_receipts p JOIN catalog_revisions c ON c.revision=p.catalog_revision
        AND c.source_export_sha256=p.source_export_sha256 WHERE p.catalog_revision=? AND p.snapshot_sha256=? AND p.product_count=?
        AND c.status IN ('reconciled','published'))
      AND (${visible.sql})=?
      AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox WHERE source_revision=?)=?
      AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE source_revision=? AND status!='complete')
      AND (? IS NULL OR ?>${NOW}) AND ${mutation.sql}`)
    .bind(intent.releaseId, versionReference, claim.requestId, stored.request_json, claim.token, claim.runReference,continuation?1:0,
      ...gate.params, request.environment, receiptEpoch, ...imports.params, publication.intentId, intent.releaseId, encodePublicationIntent(intent), publication.token,
      continuation?1:0,continuation?1:0,`version:${versionReference}`,
      intent.catalogRevision, intent.catalogSnapshotSha256, snapshot.products.length, ...visible.params, snapshot.products.length,
      intent.catalogRevision, intent.vectorSyncWatermark, intent.catalogRevision, intent.nextExpiry, intent.nextExpiry, ...mutation.params);
  if (mutationOwner) {
    const activeOwner: MutationOwner = { ...mutationOwner, phase: 'activating' };
    await db.batch([mutationAssertion(db, mutationOwner, ['freezing']), statement,
      db.prepare(`UPDATE catalog_mutation_scopes SET phase='activating',external_pending=1,activation_request_id=?
        WHERE environment=? AND index_name=? AND ${mutation.sql} AND EXISTS(SELECT 1 FROM catalog_build_requests
          WHERE request_id=? AND state='activating' AND lease_token=? AND run_reference=? AND version_reference=?)`)
        .bind(claim.requestId, mutationOwner.environment, mutationOwner.indexName, ...mutation.params,
          claim.requestId, claim.token, claim.runReference, versionReference), mutationAssertion(db, activeOwner, ['activating'])]);
    return { requestId: claim.requestId, token: claim.token, runReference: claim.runReference, releaseId: intent.releaseId, versionReference, mutationOwner: activeOwner };
  }
  const result = await statement.run() as { success?: boolean; meta?: { changes?: number } };
  if (result.success !== true || result.meta?.changes !== 1) throw new Error('build_fenced_or_preflight_changed');
  return { requestId: claim.requestId, token: claim.token, runReference: claim.runReference, releaseId: intent.releaseId, versionReference };
}

export interface ReviewedUploadActivationApprovalV1 {
  schemaVersion:1;requestId:string;packageSha256:string;configSha256:string;checkpointSha256:string;
  reviewPinSha256:string;evidenceSha256:string;reviewReference:string;
}
/** A verified read-only upload preflight may continue under the ORIGINAL
 * publication cutoff. This is not a new build claim or a deadline extension. */
export type ReviewedUploadActivationApprovalV4=Omit<ReviewedUploadActivationApprovalV1,'schemaVersion'>&{
  schemaVersion:4;reviewedAt:string;authorizationSha256:string};
export type ReviewedUploadActivationApproval=ReviewedUploadActivationApprovalV1|(
  Omit<ReviewedUploadActivationApprovalV1,'schemaVersion'>&{schemaVersion:2;priorApprovalSha256:string;activationDeadline:string})|(
  Omit<ReviewedUploadActivationApprovalV1,'schemaVersion'>&{schemaVersion:3;priorApprovalSha256:string;activationDeadline:string;
    reviewedAt:string;authorizationSha256:string})|ReviewedUploadActivationApprovalV4;
export interface ReviewedUploadActivationInput {
  claim:CatalogBuildClaim;publication:PublicationClaim;versionReference:string;owner:MutationOwner;
  approval:ReviewedUploadActivationApproval;priorApproval?:ReviewedUploadActivationApprovalV1;
  original:{build:Record<string,unknown>;publication:Record<string,unknown>};
  /** Separate fresh dispatch authority for an already acknowledged immutable
   * upload. Original build/source/retention times are never rewritten. */
  finishAuthorization?:{authorizationSha256:string;reviewedAt:string;activationDeadline:string;versionReference:string};
}
export function validatePublicationFinishAuthority(f:NonNullable<ReviewedUploadActivationInput['finishAuthorization']>,originalCutoff:string,versionReference:string){
  if(!f||Object.keys(f).sort().join(',')!=='activationDeadline,authorizationSha256,reviewedAt,versionReference'
    ||typeof f.authorizationSha256!=='string'||!HASH.test(f.authorizationSha256)||f.versionReference!==versionReference
    ||canonicalTime(f.reviewedAt)<canonicalTime(originalCutoff)||canonicalTime(f.activationDeadline)<=f.reviewedAt
    ||Date.parse(f.activationDeadline)-Date.parse(f.reviewedAt)>2*3600000)throw new Error('publication_finish_authorization_invalid');
  return f.activationDeadline;
}
export function encodeReviewedUploadActivationApproval(value:ReviewedUploadActivationApproval):string {
  const keys='checkpointSha256,configSha256,evidenceSha256,packageSha256,requestId,reviewPinSha256,reviewReference,schemaVersion';
  const expected=[...keys.split(','),...([2,3].includes(value?.schemaVersion)?['activationDeadline','priorApprovalSha256']:[]),
    ...([3,4].includes(value?.schemaVersion)?['reviewedAt','authorizationSha256']:[])].sort().join(',');
  if(!value||![1,2,3,4].includes(value.schemaVersion)||Object.keys(value).sort().join(',')!==expected
    ||!['requestId','packageSha256','configSha256','checkpointSha256','reviewPinSha256','evidenceSha256']
      .every(k=>typeof value[k as keyof typeof value]==='string'&&HASH.test(String(value[k as keyof typeof value])))
    ||(value.schemaVersion===2||value.schemaVersion===3)&&(typeof value.priorApprovalSha256!=='string'||!HASH.test(value.priorApprovalSha256))
    ||(value.schemaVersion===3||value.schemaVersion===4)&&(typeof value.authorizationSha256!=='string'||!HASH.test(value.authorizationSha256))
    ||typeof value.reviewReference!=='string'||!REFERENCE.test(value.reviewReference))throw new Error('build_reviewed_activation_invalid');
  if(value.schemaVersion===2||value.schemaVersion===3)canonicalTime(value.activationDeadline);
  if(value.schemaVersion===3||value.schemaVersion===4)canonicalTime(value.reviewedAt);
  return flat(value);
}
/** A separate dispatch grant, never rewritten build inputs or renewed rights.
 * The prior digest is over the original canonical v1 encoding, without newline.
 * V3 records fresh owner authority; v1/v2 deadlines and encodings stay intact. */
export async function reviewedUploadActivationDeadline(approval:ReviewedUploadActivationApproval,originalCutoff:string,
  priorApproval?:ReviewedUploadActivationApprovalV1):Promise<string>{
  encodeReviewedUploadActivationApproval(approval);canonicalTime(originalCutoff);
  if(approval.schemaVersion===1||approval.schemaVersion===4){
    if(priorApproval!==undefined||approval.schemaVersion===4&&approval.reviewedAt>=originalCutoff)
      throw new Error('build_reviewed_activation_invalid');
    return originalCutoff;
  }
  if(!priorApproval||priorApproval.schemaVersion!==1||await digest(encodeReviewedUploadActivationApproval(priorApproval))!==approval.priorApprovalSha256
    ||(['requestId','packageSha256','configSha256','reviewPinSha256','evidenceSha256'] as const).some(k=>approval[k]!==priorApproval[k])
    ||approval.activationDeadline<=originalCutoff
    ||approval.schemaVersion===2&&Date.parse(approval.activationDeadline)-Date.parse(originalCutoff)>2*3600000
    ||approval.schemaVersion===3&&(approval.reviewedAt<originalCutoff||approval.reviewedAt.slice(0,10)!==originalCutoff.slice(0,10)
      ||approval.activationDeadline<=approval.reviewedAt||Date.parse(approval.activationDeadline)-Date.parse(approval.reviewedAt)>2*3600000
      ||approval.activationDeadline>`${originalCutoff.slice(0,10)}T21:00:00.000Z`))
    throw new Error('build_reviewed_activation_invalid');
  return approval.activationDeadline;
}
type ReviewedRow=Record<string,unknown>;
const reviewedRefuse=():never=>{throw new Error('build_reviewed_activation_fenced');};
async function reviewedInput(value:ReviewedUploadActivationInput){
  const i=structuredClone(value),{claim:c,publication:p,owner:o,approval:a,original:r}=i;
  encodeReviewedUploadActivationApproval(a);mutationFenceQuery(o,['freezing']);
  const bytes=encodeBuildRequest(c.request),intent=encodePublicationIntent(p.intent),b=r.build,u=r.publication;
  if(a.requestId!==c.requestId||await digest(bytes)!==c.requestId||o.environment!==c.request.environment||!c.request.priorReleaseId
    ||typeof i.versionReference!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(i.versionReference)
    ||b.request_id!==c.requestId||b.request_json!==bytes||b.environment!==o.environment||b.source_revision!==c.request.sourceRevision
    ||b.state!=='building'||b.lease_token!==c.token||b.lease_until!==c.leaseUntil||b.run_reference!==c.runReference
    ||!Number.isInteger(b.attempts)||Number(b.attempts)<1||Number(b.attempts)>3
    ||[b.release_id,b.version_reference,b.dispatch_reference,b.error_code].some(v=>v!==null)
    ||u.intent_id!==p.intentId||u.intent_id!==await digest(intent)||u.intent_json!==intent||u.release_id!==p.intent.releaseId
    ||u.catalog_revision!==c.request.sourceRevision||u.state!=='claimed'||u.lease_token!==p.token||u.lease_until!==p.leaseUntil
    ||!Number.isInteger(u.attempts)||Number(u.attempts)<1||Number(u.attempts)>3
    ||[u.dispatch_reference,u.completed_token,u.error_code].some(v=>v!==null)
    ||p.intent.codeSha!==c.request.codeSha||p.intent.catalogRevision!==c.request.sourceRevision
    ||p.intent.catalogSnapshotSha256!==c.request.sourceDigest||p.intent.priorReleaseId!==c.request.priorReleaseId)reviewedRefuse();
  if(a.schemaVersion===4){
    if(b.operator_recovery_json!==null||a.reviewedAt<c.request.capturedAt)reviewedRefuse();
  }else{
    let receipt:BuildRecoveryReceipt;try{receipt=JSON.parse(String(b.operator_recovery_json));encodeBuildRecoveryApproval(receipt.approval);}catch{return reviewedRefuse();}
    if(b.attempts!==3||receipt.schemaVersion!==1||receipt.kind!=='unstarted-build-operator-recovery'||receipt.releaseId!==p.intent.releaseId
      ||receipt.normalAttempts!==3||receipt.operatorAttempts!==1||receipt.totalAttempts!==4
      ||receipt.token!==c.token||receipt.leaseUntil!==c.leaseUntil||flat(receipt.owner)!==flat(o)
      ||receipt.approval.requestId!==c.requestId||receipt.approval.packageSha256!==a.packageSha256)reviewedRefuse();
  }
  canonicalTime(c.leaseUntil);canonicalTime(p.leaseUntil);
  let activationDeadline=await reviewedUploadActivationDeadline(a,c.request.cutoff,i.priorApproval);
  if(i.finishAuthorization){
    if(a.schemaVersion!==4)reviewedRefuse();
    activationDeadline=validatePublicationFinishAuthority(i.finishAuthorization,c.request.cutoff,i.versionReference);
  }
  return{...i,activationDeadline};
}
function reviewedAssertion(db:CatalogD1,sql:string,params:unknown[]=[]){
  return db.prepare(`SELECT json(CASE WHEN ${sql} THEN 'true' ELSE 'build_reviewed_activation_fenced' END)`).bind(...params);
}
function reviewedExact(db:CatalogD1,table:string,r:ReviewedRow){
  const keys=Object.keys(r);if(!keys.length||keys.length>65||keys.some(k=>!/^[_a-z][_a-z0-9]*$/.test(k)
    ||r[k]!==null&&!['string','number'].includes(typeof r[k])))reviewedRefuse();
  return reviewedAssertion(db,`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>r[k]));
}
function reviewedApplied(i:ReviewedUploadActivationInput){
  return{build:{...i.original.build,state:'activating',lease_until:null,release_id:i.publication.intent.releaseId,version_reference:i.versionReference},
    publication:{...i.original.publication,state:'dispatched',dispatch_reference:`version:${i.versionReference}`}};
}
function reviewedOwner(db:CatalogD1,i:ReviewedUploadActivationInput,active:boolean){
  const o=active?{...i.owner,phase:'activating' as const}:i.owner;
  return[mutationAssertion(db,o,[o.phase]),reviewedAssertion(db,`EXISTS(SELECT 1 FROM catalog_mutation_scopes
    WHERE environment=? AND index_name=? AND captured_at=? AND activation_request_id IS ?)`,
    [o.environment,o.indexName,o.capturedAt,active?i.claim.requestId:null])];
}
function reviewedPermit(i:ReviewedUploadActivationInput):ActivationPermit{return{requestId:i.claim.requestId,token:i.claim.token,
  runReference:i.claim.runReference,releaseId:i.publication.intent.releaseId,versionReference:i.versionReference,mutationOwner:{...i.owner,phase:'activating'}};}
/** Explicit operator authority, not an inference from expired tokens/opaque
 * hashes. The executor binds approval + full original rows in its durable marker
 * and independently proves real upload ACK/package/full native in the SAME
 * owned invocation before the short version/prior readDeployment observation.
 * Its beforeCommit hook rechecks inventory and MUST durably mark the one CAS; marked
 * retries call ONLY readReviewedUploadActivation. No provider dispatch is here. */
export async function beginReviewedUploadActivation(db:CatalogD1,value:ReviewedUploadActivationInput,snapshotInput:CatalogSnapshot,
  readDeployment:(signal:AbortSignal)=>Promise<DeploymentObservation>,beforeCommit:()=>Promise<void>):Promise<ActivationPermit>{
  if(typeof beforeCommit!=='function')throw new Error('build_reviewed_activation_invalid');
  const i=await reviewedInput(value),snapshot=structuredClone(snapshotInput),{claim:c,publication:p,owner:o}=i;
  const read=async(sql:string,params:unknown[]=[])=> (await db.prepare(sql).bind(...params).all<ReviewedRow>()).results;
  const b=await read('SELECT * FROM catalog_build_requests WHERE request_id=?',[c.requestId]);
  const u=await read('SELECT * FROM publication_outbox WHERE intent_id=?',[p.intentId]);
  if(b.length!==1||u.length!==1||flat(b[0])!==flat(i.original.build)||flat(u[0])!==flat(i.original.publication))reviewedRefuse();
  const prior=await read('SELECT * FROM publication_receipts WHERE release_id=?',[c.request.priorReleaseId]);
  const header=(await read(`SELECT ${NOW} now,coalesce(max(rowid),0) epoch FROM publication_receipts`))[0],at=canonicalTime(String(header.now));
  if(prior.length!==1||c.leaseUntil>at||p.leaseUntil>at||i.activationDeadline<=at
    ||i.finishAuthorization&&i.finishAuthorization.reviewedAt>at
    ||(i.approval.schemaVersion===3||i.approval.schemaVersion===4)&&i.approval.reviewedAt>at||p.intent.nextExpiry!==earliestDisplayExpiry(snapshot.products)
    ||await digest(`${JSON.stringify(snapshot)}\n`)!==c.request.sourceDigest||snapshot.products.some(x=>catalogDisplayDeadline(x)<=Date.parse(i.activationDeadline))
    ||!(await rollbackPreflight(db,snapshot,new Date(at))).ok)reviewedRefuse();
  const observed=await observe(readDeployment,30_000);
  if(observed.environment!==o.environment||observed.settled!==true||!(await priorMatches(db,c.request,observed.active)))reviewedRefuse();
  const source=sourceGate(c.request,i.activationDeadline),visible=publicationActivationGate(snapshot,p.intent),imports=await unabandonedImportsQuery(db,o.environment);
  // Separate assertions in the SAME transaction preserve the full shared gate
  // while keeping its nested current-rights predicate below D1 depth100.
  const ready=()=>[reviewedAssertion(db,source.sql,source.params),reviewedAssertion(db,visible.sql,visible.params),reviewedAssertion(db,`${imports.sql}
    AND (SELECT coalesce(max(rowid),0) FROM publication_receipts)=?
    AND NOT EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?)
    AND NOT EXISTS(SELECT 1 FROM catalog_build_requests WHERE environment=? AND state='activating' AND request_id!=?)
    AND NOT EXISTS(SELECT 1 FROM publication_outbox WHERE catalog_revision=? AND state IN ('claimed','dispatched') AND intent_id!=?)
    AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete') AND ?<=${NOW} AND ?<=${NOW}
    ${i.approval.schemaVersion===4?`AND ?<=${NOW}`:''}${i.finishAuthorization?` AND ?<=${NOW}`:''}`,
    [...imports.params,header.epoch,p.intent.releaseId,o.environment,c.requestId,
      p.intent.catalogRevision,p.intentId,c.leaseUntil,p.leaseUntil,...(i.approval.schemaVersion===4?[i.approval.reviewedAt]:[]),
      ...(i.finishAuthorization?[i.finishAuthorization.reviewedAt]:[])])];
  const applied=reviewedApplied(i),fence=mutationFenceQuery(o,['freezing']);
  const statements=[...reviewedOwner(db,i,false),reviewedExact(db,'catalog_build_requests',i.original.build),
    reviewedExact(db,'publication_outbox',i.original.publication),reviewedExact(db,'publication_receipts',prior[0]),...ready(),
    db.prepare("UPDATE publication_outbox SET state='dispatched',dispatch_reference=? WHERE intent_id=? AND state='claimed' AND lease_token=?")
      .bind(`version:${i.versionReference}`,p.intentId,p.token),
    db.prepare("UPDATE catalog_build_requests SET state='activating',lease_until=NULL,release_id=?,version_reference=? WHERE request_id=? AND state='building' AND lease_token=?")
      .bind(p.intent.releaseId,i.versionReference,c.requestId,c.token),
    db.prepare(`UPDATE catalog_mutation_scopes SET phase='activating',external_pending=1,activation_request_id=?
      WHERE environment=? AND index_name=? AND ${fence.sql}`).bind(c.requestId,o.environment,o.indexName,...fence.params),
    reviewedExact(db,'catalog_build_requests',applied.build),reviewedExact(db,'publication_outbox',applied.publication),
    reviewedExact(db,'publication_receipts',prior[0]),...ready(),...reviewedOwner(db,i,true)];
  await beforeCommit(); // No subsequent read/proof before the sole atomic CAS.
  await db.batch(statements);return reviewedPermit(i);
}
/** Read-only exact applied-state recovery, even after cutoff; it is NOT authority
 * to send/re-send activation. Missing/foreign CAS remains fenced forever. */
export async function readReviewedUploadActivation(db:CatalogD1,value:ReviewedUploadActivationInput):Promise<ActivationPermit>{
  const i=await reviewedInput(value),applied=reviewedApplied(i);
  for(const [table,key,id,expected]of [['catalog_build_requests','request_id',i.claim.requestId,applied.build],
    ['publication_outbox','intent_id',i.publication.intentId,applied.publication]] as const){
    const rows=(await db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).bind(id).all<ReviewedRow>()).results;
    if(rows.length!==1||flat(rows[0])!==flat(expected))reviewedRefuse();
  }
  await db.batch([...reviewedOwner(db,i,true),reviewedExact(db,'catalog_build_requests',applied.build),
    reviewedExact(db,'publication_outbox',applied.publication),...reviewedOwner(db,i,true)]);
  return reviewedPermit(i);
}

/** No timeout/takeover shortcut for an uncertain activation. The injected adapter
 * must prove settled provider/run state; a target identity alone is not a receipt.
 */
export async function resolveBuildActivation(db: CatalogD1, permit: ActivationPermit,
  readDeployment: (signal: AbortSignal) => Promise<DeploymentObservation>, options: { observationTimeoutMs?: number } = {}): Promise<'awaiting_receipt' | 'resolved' | 'not_activated'> {
  const timeout = options.observationTimeoutMs ?? 3000;
  if (!Number.isInteger(timeout) || timeout < 10 || timeout > 30_000) throw new Error('invalid_observation_timeout');
  const stored = await row(db, permit.requestId);
  if (!stored || stored.state !== 'activating' || stored.lease_token !== permit.token || stored.run_reference !== permit.runReference
    || stored.release_id !== permit.releaseId || stored.version_reference !== permit.versionReference) throw new Error('build_fenced');
  const request = input(stored); const observed = await observe(readDeployment, timeout);
  if (observed.environment !== request.environment || observed.settled !== true) throw new Error('activation_still_uncertain');
  const finish = async (statement: D1Statement) => {
    if (!permit.mutationOwner) {
      await legacyMutationBatch(db, [statement]);
      const resolved = await row(db, permit.requestId);
      return { success: true, meta: { changes: resolved && ['resolved','failed'].includes(resolved.state) ? 1 : 0 } };
    }
    const owner = permit.mutationOwner; const gate = mutationFenceQuery(owner, ['activating']);
    if (owner.environment !== request.environment) throw new Error('build_fenced');
    await db.batch([mutationAssertion(db, owner, ['activating']), statement,
      db.prepare(`UPDATE catalog_mutation_scopes SET phase='idle',owner_token=NULL,owner_reference=NULL,operation_key=NULL,
        captured_at=NULL,external_pending=0,activation_request_id=NULL WHERE environment=? AND index_name=? AND activation_request_id=?
        AND ${gate.sql} AND EXISTS(SELECT 1 FROM catalog_build_requests WHERE request_id=? AND state IN ('resolved','failed'))`)
        .bind(owner.environment, owner.indexName, permit.requestId, ...gate.params, permit.requestId),
      db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=?
        AND phase='idle' AND generation=? AND mutation_epoch=?) THEN 'true' ELSE 'mutation_fenced' END)`)
        .bind(owner.environment, owner.indexName, owner.generation, owner.epoch)]);
    return { success: true, meta: { changes: 1 } };
  };
  const outbox = (await db.prepare('SELECT intent_json FROM publication_outbox WHERE release_id=?').bind(permit.releaseId)
    .all<{ intent_json: string }>()).results[0];
  if (!outbox) throw new Error('build_publication_missing');
  if (observed.active && matches(observed.active, JSON.parse(outbox.intent_json)) && observed.active.versionReference === permit.versionReference) {
    const receipt = (await db.prepare('SELECT manifest_json FROM publication_receipts WHERE release_id=?').bind(permit.releaseId)
      .all<{ manifest_json: string }>()).results[0];
    if (!receipt) return 'awaiting_receipt';
    if (receipt.manifest_json !== outbox.intent_json || (await publicationStatus(db, permit.releaseId)).state !== 'published') throw new Error('build_receipt_mismatch');
    const expected = JSON.parse(outbox.intent_json) as PublicationIntent;
    const result = await finish(db.prepare(`UPDATE catalog_build_requests SET state='resolved' WHERE request_id=? AND lease_token=? AND state='activating'
      AND EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=? AND manifest_json=? AND code_sha=? AND catalog_revision=?)`)
      .bind(permit.requestId, permit.token, permit.releaseId, outbox.intent_json, expected.codeSha, expected.catalogRevision)
    );
    if (result.success !== true || result.meta?.changes !== 1) throw new Error('build_fenced');
    return 'resolved';
  }
  if (!(await priorMatches(db, request, observed.active))) throw new Error('activation_resolution_mismatch');
  const result = await finish(db.prepare(`UPDATE catalog_build_requests SET state='failed',lease_token=NULL,error_code='activation_not_applied'
    WHERE request_id=? AND lease_token=? AND state='activating'`).bind(permit.requestId, permit.token));
  if (result.success !== true || result.meta?.changes !== 1) throw new Error('build_fenced');
  return 'not_activated';
}
