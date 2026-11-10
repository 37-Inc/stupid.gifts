import type { CatalogReleaseManifest, CatalogSnapshot } from './types.ts';
import type { CatalogD1, D1Statement, D1ReadOptions } from './storage/d1.ts';
import { earliestDisplayExpiry } from './display.ts';
import { canonicalTime,validateCatalogSnapshot } from './snapshot.ts';
import { canonicalJson } from './canonical-json.ts';
import { rollbackPreflight, visibleRevisionCountQuery } from './d1.ts';
import { legacyMutationBatch, mutationAssertion, mutationFenceQuery } from './mutation-fence.ts';
import type { MutationOwner } from './mutation-fence.ts';
import type { ActivationPermit, CatalogBuildRequest } from './build-requests.ts';
import { encodeBuildRequest } from './build-requests.ts';
import type { PrunedRevision,AcceptedPublishedRevision } from './prune-existing-revision.ts';
import { pruningCurrentQueries, CATALOG_IDENTITY_LIMITS } from './pruning-current.ts';
import { approvedBaseChangeLimit } from './owner-base-review.ts';
import type { OwnerBaseCatalogReview } from './owner-base-review.ts';
import {validateAutomationCohort} from './automation-cohort.ts';
import type {AutomationCohortAuthority} from './automation-cohort.ts';

/** Compact identity of an independently verified immutable package, not another release registry. */
export type PublicationIntent = Pick<CatalogReleaseManifest, 'releaseId' | 'codeSha' | 'catalogRevision'
  | 'vectorSyncWatermark' | 'priorReleaseId' | 'nextExpiry'> & { catalogSnapshotSha256: string; manifestSha256: string };
export interface PublicationClaim { intentId: string; token: string; leaseUntil: string; intent: PublicationIntent }
/** NEW code over one genuinely accepted catalog. This authorizes serving
 * control only, never a replacement catalog receipt or product/vector writes. */
export interface AcceptedCatalogAuthority {
  schemaVersion:1;kind:'accepted-persistent-code-only';sealSha256:string;
  publication:{releaseId:string;receiptSha256:string};request:CatalogBuildRequest;
  observedAt:string;globalVectorWatermark:number;publicationReceiptWatermark:number;identityCount:number;
}
export function encodeAcceptedCatalogAuthority(value:AcceptedCatalogAuthority):string {
  const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
  if(!value||Object.keys(value).sort().join(',')!=='globalVectorWatermark,identityCount,kind,observedAt,publication,publicationReceiptWatermark,request,schemaVersion,sealSha256'
    ||value.schemaVersion!==1||value.kind!=='accepted-persistent-code-only'||!hash(value.sealSha256)
    ||!value.publication||Object.keys(value.publication).sort().join(',')!=='receiptSha256,releaseId'
    ||!KEY.test(value.publication.releaseId)||!hash(value.publication.receiptSha256)
    ||![value.globalVectorWatermark,value.publicationReceiptWatermark,value.identityCount].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||value.identityCount<1||value.identityCount>CATALOG_IDENTITY_LIMITS.identities
    ||!value.request||value.request.priorReleaseId!==value.publication.releaseId)throw Error('accepted_catalog_authority_invalid');
  encodeBuildRequest(value.request);canonicalTime(value.observedAt);
  if(value.observedAt<value.request.capturedAt||value.observedAt>=value.request.cutoff)throw Error('accepted_catalog_authority_invalid');
  return canonicalJson(value);
}
type Outbox = { intent_id: string; release_id: string; intent_json: string; state: string; lease_token: string | null;
  lease_until: string | null; attempts: number; dispatch_reference: string | null; error_code: string | null;completed_token:string|null };
const KEY = /^[a-zA-Z0-9._-]{1,200}$/;
const DATABASE_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

/** Explicit historical source + NEW code request; never an arbitrary owner-key
 * override. Fixed canonical order is shared with the Node proof reader. */
export interface PublishedCatalogBinding {
  source:{releaseId:string;receiptSha256:string;deliveryId:string;deliverySha256:string}; request:CatalogBuildRequest;
}
export function encodePublishedCatalogBinding({source,request}:PublishedCatalogBinding):string {
  if(!source||typeof source.releaseId!=='string'||!KEY.test(source.releaseId)
    ||Object.keys(source).sort().join(',')!=='deliveryId,deliverySha256,receiptSha256,releaseId'
    ||![source.receiptSha256,source.deliveryId,source.deliverySha256]
    .every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))throw new Error('invalid_published_catalog_binding');
  return JSON.stringify({kind:'published-catalog-read',request:encodeBuildRequest(request),schemaVersion:1,
    source:{deliveryId:source.deliveryId,deliverySha256:source.deliverySha256,receiptSha256:source.receiptSha256,releaseId:source.releaseId}});
}

function encode(intent: PublicationIntent): string {
  if (!intent || typeof intent.releaseId !== 'string' || !KEY.test(intent.releaseId)
    || typeof intent.catalogRevision !== 'string' || !KEY.test(intent.catalogRevision)
    || typeof intent.codeSha !== 'string' || !/^[a-f0-9]{40}$/.test(intent.codeSha)
    || typeof intent.catalogSnapshotSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(intent.catalogSnapshotSha256)
    || typeof intent.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(intent.manifestSha256)
    || !Number.isSafeInteger(intent.vectorSyncWatermark) || intent.vectorSyncWatermark < 0
    || intent.priorReleaseId !== null && (typeof intent.priorReleaseId !== 'string' || !KEY.test(intent.priorReleaseId))) throw new Error('invalid_publication_intent');
  if (intent.nextExpiry !== null) canonicalTime(intent.nextExpiry);
  return JSON.stringify({ releaseId: intent.releaseId, codeSha: intent.codeSha, catalogRevision: intent.catalogRevision,
    catalogSnapshotSha256: intent.catalogSnapshotSha256, manifestSha256: intent.manifestSha256,
    vectorSyncWatermark: intent.vectorSyncWatermark, priorReleaseId: intent.priorReleaseId, nextExpiry: intent.nextExpiry });
}
// Preserve the original persisted wire order across private checkpoint codecs.
// Do not substitute canonicalJson or rewrite historical outbox/receipt bytes.
export { encode as encodePublicationIntent };
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function row(db: CatalogD1, releaseId: string, options?: D1ReadOptions): Promise<Outbox | undefined> {
  return (await db.prepare('SELECT * FROM publication_outbox WHERE release_id=?').bind(releaseId).all<Outbox>(options)).results[0];
}
function intentFrom(value: Outbox): PublicationIntent {
  const intent = JSON.parse(value.intent_json) as PublicationIntent;
  if (encode(intent) !== value.intent_json || intent.releaseId !== value.release_id) throw new Error('publication_intent_corrupt');
  return intent;
}
/** All mutable readiness predicates also run within the final receipt transaction. */
function gate(snapshot: CatalogSnapshot, intent: PublicationIntent,authority?:AcceptedCatalogAuthority) {
  if(authority){encodeAcceptedCatalogAuthority(authority);if(intent.catalogRevision!==authority.request.sourceRevision
    ||intent.catalogSnapshotSha256!==authority.request.sourceDigest||intent.priorReleaseId!==authority.publication.releaseId
    ||intent.codeSha!==authority.request.codeSha)throw Error('accepted_catalog_authority_invalid');}
  const visible = visibleRevisionCountQuery(intent.catalogRevision,undefined,Boolean(authority));
  return { sql: `EXISTS(SELECT 1 FROM catalog_revisions c JOIN catalog_projection_receipts r
      ON r.catalog_revision=c.revision AND r.source_export_sha256=c.source_export_sha256
      WHERE c.revision=? AND c.status IN ('reconciled','published') AND r.snapshot_sha256=? AND r.product_count=?)
    AND (${visible.sql})=?
    AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox WHERE source_revision=?)=?
    AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE source_revision=? AND status!='complete')
    AND (? IS NULL OR ?>${DATABASE_NOW})
    AND (? IS NULL OR EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?))`, params: [intent.catalogRevision, intent.catalogSnapshotSha256, snapshot.products.length,
      ...visible.params, snapshot.products.length, intent.catalogRevision, intent.vectorSyncWatermark,
      intent.catalogRevision, intent.nextExpiry, intent.nextExpiry, intent.priorReleaseId, intent.priorReleaseId] };
}
/** Same predicates for the explicit reviewed, original-token activation CAS. */
export { gate as publicationActivationGate,preflight as publicationPreflight };
async function preflight(db: CatalogD1, snapshot: CatalogSnapshot, intent: PublicationIntent, now: Date,authority?:AcceptedCatalogAuthority): Promise<void> {
  if(authority){await acceptedCatalogReceipt(db,authority);validateCatalogSnapshot(snapshot,now);
    if(await digest(JSON.stringify(snapshot)+'\n')!==authority.request.sourceDigest)throw Error('publication_preflight_failed');}
  const earliest = earliestDisplayExpiry(snapshot.products);
  if (snapshot.dataKind !== 'catalog' || snapshot.catalogRevision !== intent.catalogRevision || intent.nextExpiry !== earliest
    || !authority&&!(await rollbackPreflight(db, snapshot, now)).ok) throw new Error('publication_preflight_failed');
  const check = gate(snapshot, intent,authority);
  if (!(await db.prepare(`SELECT 1 WHERE ${check.sql}`).bind(...check.params).all()).results.length) throw new Error('publication_preflight_failed');
}
function owned(value: Outbox | undefined, token: string, now: Date, state?: string): value is Outbox {
  return Boolean(value && value.lease_token === token && value.lease_until! > now.toISOString()
    && (state ? value.state === state : ['claimed', 'dispatched'].includes(value.state)));
}
function completionStatements(db: CatalogD1, snapshot: CatalogSnapshot, value: Outbox, token: string, at: Date, requireLease: boolean): D1Statement[] {
  const intent = intentFrom(value), check = gate(snapshot, intent);
  return [
    db.prepare(`INSERT INTO publication_receipts(release_id,catalog_revision,code_sha,completed_at,manifest_json)
      SELECT ?,?,?,${DATABASE_NOW},? WHERE EXISTS(SELECT 1 FROM publication_outbox WHERE intent_id=? AND lease_token=?
        AND state='dispatched' ${requireLease ? `AND lease_until>${DATABASE_NOW}` : ''}) AND ${check.sql}`)
      .bind(value.release_id, intent.catalogRevision, intent.codeSha, value.intent_json, value.intent_id, token, ...check.params),
    db.prepare(`UPDATE catalog_revisions SET status='published' WHERE revision=? AND EXISTS(
      SELECT 1 FROM publication_receipts WHERE release_id=? AND manifest_json=?)`).bind(intent.catalogRevision, value.release_id, value.intent_json),
    db.prepare(`UPDATE publication_outbox SET state='verified',completed_token=?,lease_token=NULL,lease_until=NULL,error_code=NULL,updated_at=?
      WHERE intent_id=? AND lease_token=? AND state='dispatched' AND EXISTS(
        SELECT 1 FROM publication_receipts WHERE release_id=? AND manifest_json=?)`)
      .bind(token, at.toISOString(), value.intent_id, token, value.release_id, value.intent_json),
  ];
}
async function completed(db: CatalogD1, value: Outbox, token: string): Promise<void> {
  const result = await db.prepare('SELECT completed_token FROM publication_outbox WHERE intent_id=?')
    .bind(value.intent_id).all<{ completed_token: string | null }>();
  if (result.results[0]?.completed_token !== token || (await publicationStatus(db, value.release_id)).state !== 'published')
    throw new Error('publication_fenced_or_preflight_changed');
}

/** Original catalog authority remains the latest genuine catalog receipt. */
export async function acceptedCatalogReceipt(db:CatalogD1,authority:AcceptedCatalogAuthority,options?:D1ReadOptions){
  encodeAcceptedCatalogAuthority(authority);
  const rows=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?')
    .bind(authority.publication.releaseId).all<Record<string,unknown>>(options)).results;
  const receipt=rows[0],intent=receipt&&JSON.parse(String(receipt.manifest_json));
  if(rows.length!==1||await digest(canonicalJson(receipt))!==authority.publication.receiptSha256
    ||encode(intent)!==receipt.manifest_json||intent.catalogRevision!==authority.request.sourceRevision
    ||intent.catalogSnapshotSha256!==authority.request.sourceDigest||receipt.catalog_revision!==intent.catalogRevision
    ||receipt.release_id!==intent.releaseId||receipt.code_sha!==intent.codeSha)throw Error('accepted_catalog_receipt_changed');
  return receipt;
}
export async function servingPublicationStatus(db:CatalogD1,releaseId:string,authority:AcceptedCatalogAuthority,options?:D1ReadOptions){
  await acceptedCatalogReceipt(db,authority,options);
  const value=await row(db,releaseId,options);
  if(!value)return{state:'missing'};
  const intent=intentFrom(value);
  if(intent.catalogRevision!==authority.request.sourceRevision||intent.catalogSnapshotSha256!==authority.request.sourceDigest
    ||intent.codeSha!==authority.request.codeSha||intent.priorReleaseId!==authority.publication.releaseId)
    throw Error('accepted_catalog_receipt_changed');
  if((await db.prepare('SELECT 1 FROM publication_receipts WHERE release_id=?').bind(releaseId).all(options)).results.length)
    throw Error('accepted_catalog_unexpected_receipt');
  return{state:value.state==='verified'&&value.completed_token?'published':value.state,intent};
}

/** Historical completion state, not a claim that this release is still active/fresh. */
export async function publicationStatus(db: CatalogD1, releaseId: string, options?: D1ReadOptions) {
  options?.signal?.throwIfAborted();
  const value = await row(db, releaseId, options);
  options?.signal?.throwIfAborted();
  const receipt = (await db.prepare('SELECT code_sha,catalog_revision,manifest_json FROM publication_receipts WHERE release_id=?')
    .bind(releaseId).all<{ code_sha: string; catalog_revision: string; manifest_json: string }>(options)).results[0];
  options?.signal?.throwIfAborted();
  if (receipt) {
    if (!value || receipt.manifest_json !== value.intent_json || receipt.code_sha !== intentFrom(value).codeSha
      || receipt.catalog_revision !== intentFrom(value).catalogRevision) throw new Error('publication_receipt_mismatch');
    return { state: 'published', attempts: value.attempts, leaseUntil: null, errorCode: null };
  }
  if (value?.state === 'verified') throw new Error('publication_receipt_missing');
  return { state: value?.state || 'missing', attempts: value?.attempts || 0, leaseUntil: value?.lease_until || null, errorCode: value?.error_code || null };
}
export async function enqueuePublication(db: CatalogD1, snapshot: CatalogSnapshot, intent: PublicationIntent, now = new Date(),authority?:AcceptedCatalogAuthority): Promise<string> {
  const bytes = encode(intent); const id = await digest(bytes);
  await preflight(db, snapshot, intent, now,authority);
  await db.prepare(`INSERT INTO publication_outbox(intent_id,release_id,catalog_revision,intent_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?) ON CONFLICT(release_id) DO NOTHING`)
    .bind(id, intent.releaseId, intent.catalogRevision, bytes, now.toISOString(), now.toISOString()).run();
  const value = await row(db, intent.releaseId);
  if (!value || value.intent_id !== id || value.intent_json !== bytes) throw new Error('publication_intent_conflict');
  return id;
}
export async function claimPublication(db: CatalogD1, snapshot: CatalogSnapshot, releaseId: string, now = new Date(), leaseMs = 600_000,authority?:AcceptedCatalogAuthority): Promise<PublicationClaim | null> {
  const value = await row(db, releaseId);
  if (!value) throw new Error('publication_intent_missing');
  const intent = intentFrom(value);
  await preflight(db, snapshot, intent, now,authority);
  const token = crypto.randomUUID();
  const leaseUntil = new Date(Math.min(now.getTime() + Math.max(1000, Math.min(leaseMs, 900_000)), intent.nextExpiry === null ? Infinity : Date.parse(intent.nextExpiry))).toISOString();
  const check = gate(snapshot, intent,authority);
  await db.batch([
    db.prepare(`UPDATE publication_outbox SET state='pending',lease_token=NULL,lease_until=NULL,updated_at=?
      WHERE catalog_revision=? AND state IN ('claimed','dispatched') AND lease_until<=${DATABASE_NOW}`).bind(now.toISOString(), intent.catalogRevision),
    db.prepare(`UPDATE publication_outbox SET state='claimed',lease_token=?,lease_until=?,attempts=attempts+1,
      dispatch_reference=NULL,error_code=NULL,updated_at=? WHERE intent_id=? AND state IN ('pending','failed') AND attempts<3
      AND NOT EXISTS(SELECT 1 FROM publication_outbox active WHERE active.catalog_revision=? AND active.state IN ('claimed','dispatched'))
      AND ?>${DATABASE_NOW} AND ${check.sql}`).bind(token, leaseUntil, now.toISOString(), value.intent_id, intent.catalogRevision, leaseUntil, ...check.params),
  ]);
  const claimed = await row(db, releaseId);
  return owned(claimed, token, now, 'claimed') ? { intentId: value.intent_id, token, leaseUntil, intent } : null;
}
export async function failPublication(db: CatalogD1, releaseId: string, token: string, now: Date): Promise<void> {
  await db.prepare(`UPDATE publication_outbox SET state='failed',lease_token=NULL,lease_until=NULL,error_code='dispatch_failed',updated_at=?
    WHERE release_id=? AND lease_token=? AND state='claimed' AND lease_until>${DATABASE_NOW}`)
    .bind(now.toISOString(), releaseId, token).run();
}
export async function recordPublicationDispatch(db: CatalogD1, snapshot: CatalogSnapshot, claim: PublicationClaim, reference: string, now: Date,authority?:AcceptedCatalogAuthority): Promise<void> {
  if (!/^[a-zA-Z0-9._:/-]{1,200}$/.test(reference)) throw new Error('invalid_dispatch_reference');
  // Lost acknowledgement after the original write: exact readback only, even
  // after lease expiry. This grants no activation authority or renewed lease.
  const existing=await row(db,claim.intent.releaseId);
  if(existing?.state==='dispatched'&&existing.intent_id===claim.intentId&&existing.lease_token===claim.token
    &&existing.intent_json===encode(claim.intent)&&existing.dispatch_reference===reference)return;
  if(authority)await preflight(db,snapshot,claim.intent,now,authority);
  const check = gate(snapshot, claim.intent,authority);
  await db.prepare(`UPDATE publication_outbox SET state='dispatched',dispatch_reference=?,updated_at=?
    WHERE intent_id=? AND lease_token=? AND intent_json=? AND state='claimed' AND lease_until>${DATABASE_NOW} AND ${check.sql}`)
    .bind(reference, now.toISOString(), claim.intentId, claim.token, encode(claim.intent), ...check.params).run();
  if (!owned(await row(db, claim.intent.releaseId), claim.token, now, 'dispatched')) throw new Error('publication_fenced');
}

/** readDeployed is trusted orchestration, not an HTTP body claiming a deploy succeeded.
 * It must independently verify deployed package identity AND Vectorize visibility at the watermark.
 * Real workflows must also check their lease before activation; fencing D1 cannot undo an external deploy.
 */
export async function completePublication(db: CatalogD1, snapshot: CatalogSnapshot, releaseId: string, token: string,
  readDeployed: (intent: PublicationIntent) => Promise<PublicationIntent>, now: () => Date = () => new Date(), mutationOwner?: MutationOwner): Promise<void> {
  const value = await row(db, releaseId);
  if (!owned(value, token, now(), 'dispatched')) throw new Error('publication_fenced');
  const intent = intentFrom(value);
  let deployed: PublicationIntent;
  try { deployed = await readDeployed(intent); }
  catch { throw new Error('publication_readback_failed'); } // Leave dispatched/retryable, never log adapter errors.
  if (encode(deployed) !== value.intent_json) throw new Error('publication_readback_mismatch');
  const at = now();
  await preflight(db, snapshot, intent, at);
  const statements = completionStatements(db, snapshot, value, token, at, true);
  if (mutationOwner) await db.batch([mutationAssertion(db, mutationOwner, ['activating']),
    db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_mutation_scopes s JOIN catalog_build_requests b
      ON b.request_id=s.activation_request_id WHERE s.environment=? AND s.index_name=? AND b.environment=s.environment
      AND b.state='activating' AND b.release_id=?) THEN 'true' ELSE 'mutation_fenced' END)`)
      .bind(mutationOwner.environment, mutationOwner.indexName, releaseId), ...statements]);
  else await legacyMutationBatch(db, statements);
  await completed(db, value, token);
}

/** Settle ONLY an already independently observed original activation. Activation
 * ownership does not expire: elapsed build/publication leases grant neither a
 * takeover nor another deployment. This bounded path renews no lease or rights;
 * fresh original package/current-source/native proof is still mandatory. */
async function completeActivated(db: CatalogD1, revision: PrunedRevision, publication: PublicationClaim, permit: ActivationPermit,
  readDeployed: (intent: PublicationIntent) => Promise<PublicationIntent>, now: () => Date, published?:PublishedCatalogBinding,bulk=false,approved=false): Promise<void> {
  ({ revision, publication, permit, published } = structuredClone({ revision, publication, permit, published }));
  const owner = permit.mutationOwner, snapshot = revision.snapshot, intent = publication.intent;
  const operationKey=published?await digest(encodePublishedCatalogBinding(published)):revision.operationKey;
  const streamed=bulk||approved;
  if (!owner || owner.phase !== 'activating' || permit.releaseId !== intent.releaseId || snapshot.products.length > (streamed?CATALOG_IDENTITY_LIMITS.ready:10)
    || revision.sourceRows.length > (streamed?CATALOG_IDENTITY_LIMITS.identities:20)
    ||bulk&&(!revision.nativePreservation||published||snapshot.products.length+snapshot.heldProducts.length!==revision.sourceRows.length)
    ||approved&&(bulk||published||revision.nativePreservation||!('approval' in revision.request))
    || new Set(revision.sourceRows.map(row => row.public_id)).size !== revision.sourceRows.length
    || [...snapshot.products, ...snapshot.heldProducts].some(product => !revision.sourceRows.some(row => row.public_id === product.publicId))
    || revision.request.scope.environment !== owner.environment || revision.request.scope.indexName !== owner.indexName
    || operationKey !== owner.operationKey || !Number.isSafeInteger(revision.globalVectorWatermark) || revision.globalVectorWatermark < 0)
    throw new Error('publication_activation_fenced');
  mutationFenceQuery(owner, ['activating']); // Validate the full owner before any provider read.
  const value = await row(db, intent.releaseId);
  if (!value || value.state !== 'dispatched' || value.lease_token !== publication.token || value.lease_until !== publication.leaseUntil
    || value.intent_id !== publication.intentId || value.intent_json !== encode(intent) || await digest(value.intent_json) !== value.intent_id
    || value.dispatch_reference !== `version:${permit.versionReference}`) throw new Error('publication_activation_fenced');
  const build = (await db.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').bind(permit.requestId).all<Record<string, unknown>>()).results[0];
  const request = build && JSON.parse(String(build.request_json)) as CatalogBuildRequest;
  if (!build || encodeBuildRequest(request) !== build.request_json || await digest(String(build.request_json)) !== permit.requestId
    || request.environment !== owner.environment || request.sourceRevision !== intent.catalogRevision || request.sourceDigest !== intent.catalogSnapshotSha256
    || request.codeSha !== intent.codeSha || request.priorReleaseId !== intent.priorReleaseId) throw new Error('publication_activation_fenced');
  const assertion = (sql: string, params: unknown[]) => db.prepare(`SELECT json(CASE WHEN ${sql} THEN 'true' ELSE 'publication_activation_fenced' END)`).bind(...params);
  const historical:D1Statement[]=[];
  if(approved){
    // Only the independently constructed immutable WHOLE policy receipt grants
    // the streamed path. A caller hash/large snapshot alone grants nothing.
    const deliveryId=await digest(canonicalJson({environment:owner.environment,indexName:owner.indexName,generation:owner.generation,
      operationKey:owner.operationKey,identity:{kind:'approved-cohort-plan'}}));
    const journals=(await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?')
      .bind(deliveryId).all<Record<string,unknown>>()).results;
    if(journals.length!==1)throw new Error('publication_activation_fenced');
    const row=journals[0],proof=JSON.parse(String(row.request_json)),base=JSON.parse(String(row.owner_json));
    if(proof.automation){
      if(proof.ownerBaseReview)throw Error('publication_activation_fenced');
      validateAutomationCohort(proof.automation,proof.approval);
    }
    if(proof.kind!=='approved-cohort-plan'||proof.schemaVersion!==1||proof.catalogRevision!==intent.catalogRevision
      ||proof.revisionSha256!==await digest(canonicalJson(revision))||proof.sourceRowsSha256!==await digest(canonicalJson(revision.sourceRows))
      ||canonicalJson(proof.projectionReceipt)!==canonicalJson(revision.packet.receipt)
      ||(proof.ownerBaseReview ? proof.approval.changes.length!==0||!Number.isSafeInteger(proof.ownerBaseApprovalCount)
        ||proof.ownerBaseApprovalCount<0||proof.ownerBaseApprovalCount>approvedBaseChangeLimit(proof.ownerBaseReview)
        ||proof.ownerBaseApprovalCount!==(revision.request as typeof revision.request&{approval:{changes:unknown[]}}).approval.changes.length
        ||canonicalJson(proof.approval)!==canonicalJson({...((revision.request as typeof revision.request&{approval:Record<string,unknown>}).approval),changes:[]})
        :canonicalJson(proof.approval)!==canonicalJson((revision.request as typeof revision.request&{approval:unknown}).approval))
      ||proof.approvalSha256!==await digest(canonicalJson((revision.request as typeof revision.request&{approval:unknown}).approval))
      ||!proof.ownerBaseReview&&!proof.automation&&proof.approval.changes.length>30
      ||canonicalJson(proof.automation??null)!==canonicalJson((revision.request as typeof revision.request&{automation?:AutomationCohortAuthority}).automation??null)
      ||canonicalJson(proof.ownerBaseReview??null)!==canonicalJson((revision.request as typeof revision.request&{ownerBaseReview?:OwnerBaseCatalogReview}).ownerBaseReview??null)
      ||proof.ownerBaseReview&&(proof.sources.length!==0||proof.plan.products.length!==0||proof.plan.absentIds.length!==0)
      ||proof.planSha256!==await digest(canonicalJson(proof.plan))
      ||base.phase!=='freezing'||canonicalJson({...owner,phase:'freezing',epoch:base.epoch})!==canonicalJson(base)
      ||owner.epoch<base.epoch+2||row.environment!==owner.environment||row.index_name!==owner.indexName
      ||row.generation!==base.generation||row.prior_epoch!==base.epoch||row.status!=='complete'||row.disposition!=='verified'
      ||row.attempts!==0||row.dispatch_token!==null||row.mutation_reference!==null
      ||row.product_json!==canonicalJson({schemaVersion:1,kind:'approved-cohort-plan',revisionSha256:proof.revisionSha256,
        ...(proof.automation?{automationSha256:await digest(canonicalJson(proof.automation))}:{}),
        ...(proof.ownerBaseReview?{compactApprovalSha256:await digest(canonicalJson(proof.approval)),
          ownerBaseReviewSha256:await digest(canonicalJson(proof.ownerBaseReview)),ownerBaseApprovalCount:proof.ownerBaseApprovalCount}:{})})
      ||row.evidence_json!==canonicalJson([{state:'policy_and_source_verification',
        sources:proof.sources.map((s:{deliveryId:string;reference:string|null})=>({deliveryId:s.deliveryId,reference:s.reference}))}]))
      throw new Error('publication_activation_fenced');
    const keys=Object.keys(row);
    historical.push(assertion(`EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k])));
  }
  if(published||bulk){
    if(published&&encodeBuildRequest(published.request)!==build.request_json)throw new Error('publication_activation_fenced');
    const binding=published?.source??revision.nativePreservation!.source;
    encodePublishedCatalogBinding({source:binding,request}); // Same exact bounded source identity.
    const journal=(await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').bind(binding.deliveryId)
      .all<Record<string,unknown>>()).results;
    const receipts=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(binding.releaseId)
      .all<Record<string,unknown>>()).results;
    if(journal.length!==1||receipts.length!==1)throw new Error('publication_activation_fenced');
    const prior=journal[0],receipt=receipts[0],captured=JSON.parse(String(prior.owner_json)),proof=JSON.parse(String(prior.request_json));
    // These are flat D1 control rows. Hash/compare exact original bytes without
    // importing Node code or rewriting the original captured revision.
    const canonicalRow=(r:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a],[b])=>a.localeCompare(b))));
    const oldCatalog=bulk?revision.nativePreservation!.plan.catalogRevision:snapshot.catalogRevision;
    if(await digest(canonicalRow(prior))!==binding.deliverySha256||await digest(canonicalRow(receipt))!==binding.receiptSha256
      ||prior.status!=='complete'||prior.disposition!=='verified'||proof.kind!=='approved-cohort-reuse'
      ||proof.catalogRevision!==oldCatalog||prior.environment!==owner.environment||prior.index_name!==owner.indexName
      ||!bulk&&captured.operationKey!==revision.operationKey||captured.environment!==owner.environment||captured.indexName!==owner.indexName
      ||captured.generation!==prior.generation||Number(prior.generation)>=owner.generation
      ||receipt.catalog_revision!==oldCatalog||!bulk&&receipt.code_sha!==revision.request.codeSha
      ||bulk&&(proof.revisionSha256!==revision.nativePreservation!.revisionSha256
        ||JSON.parse(String(receipt.manifest_json)).catalogSnapshotSha256!==revision.nativePreservation!.plan.snapshotSha256))
      throw new Error('publication_activation_fenced');
    for(const [table,r]of [['catalog_vector_deliveries',prior],['publication_receipts',receipt]] as const){
      const keys=Object.keys(r);if(keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw new Error('publication_activation_fenced');
      historical.push(assertion(`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>r[k])));
    }
    // Mandatory readDeployed below must still verify the exact original captured
    // revision/current sources/native proof under the NEW permit before writes.
  }
  const check = gate(snapshot, intent), receipt = revision.packet.receipt;
  if (receipt.catalog_revision !== intent.catalogRevision || receipt.snapshot_sha256 !== intent.catalogSnapshotSha256
    || receipt.source_export_sha256 !== revision.sourceDigest || receipt.product_count !== snapshot.products.length
    || revision.packet.rows.length !== receipt.product_count || new Set(revision.packet.rows.map(row => row.public_id)).size !== receipt.product_count
    || snapshot.products.some(product => !revision.packet.rows.some(row => row.public_id === product.publicId)))
    throw new Error('publication_activation_fenced');
  const receiptColumns = ['catalog_revision','snapshot_sha256','projection_sha256','source_export_sha256','product_count','created_at'] as const;
  const projectionColumns = ['catalog_revision','public_id','product_id','slug','title','description','tags','source_facts_hash','eligible_until','public_display_json','display_sha256'];
  const assertions = () => [mutationAssertion(db, owner, ['activating']),...historical,
    assertion(`EXISTS(SELECT 1 FROM catalog_mutation_scopes s JOIN catalog_build_requests b ON b.request_id=s.activation_request_id
      WHERE s.environment=? AND s.index_name=? AND s.captured_at=? AND s.activation_request_id=? AND b.environment=s.environment AND b.state='activating'
      AND b.lease_token=? AND b.lease_until IS ? AND b.run_reference=? AND b.release_id=? AND b.version_reference=? AND b.request_json=? AND b.source_revision=?)
      AND EXISTS(SELECT 1 FROM publication_outbox WHERE intent_id=? AND intent_json=? AND state='dispatched' AND lease_token=? AND lease_until=? AND dispatch_reference=?)
      AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox)=? AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete')
      AND EXISTS(SELECT 1 FROM catalog_projection_receipts WHERE ${receiptColumns.map(key => `${key} IS ?`).join(' AND ')})
      AND (SELECT count(*) FROM catalog_public_products WHERE catalog_revision=?)=?
      ${streamed?`AND (SELECT count(*) FROM products)=? AND EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=? AND catalog_revision=?
        AND code_sha=? AND completed_at IS ? AND manifest_json=?) AND (SELECT coalesce(max(rowid),0) FROM publication_receipts)=?`
        :`AND (SELECT count(*) FROM json_each(?) e JOIN catalog_public_products p ON p.catalog_revision=? AND p.public_id=json_extract(e.value,'$.public_id')
        WHERE ${projectionColumns.map(key => `p.${key} IS json_extract(e.value,'$.${key}')`).join(' AND ')})=?`} AND ${check.sql}`,
    [owner.environment, owner.indexName, owner.capturedAt, permit.requestId, permit.token, build.lease_until, permit.runReference, permit.releaseId, permit.versionReference, build.request_json, request.sourceRevision,
      value.intent_id, value.intent_json, publication.token, publication.leaseUntil, value.dispatch_reference, revision.globalVectorWatermark,
      ...receiptColumns.map(key => receipt[key]), intent.catalogRevision, receipt.product_count,
      ...(streamed?[revision.sourceRows.length,...['release_id','catalog_revision','code_sha','completed_at','manifest_json'].map(k=>revision.priorRow[k]),revision.request.context.publicationReceiptWatermark]
        :[JSON.stringify(revision.packet.rows),intent.catalogRevision,receipt.product_count]),...check.params]),
    ...(!streamed?pruningCurrentQueries(revision.sourceRows).map(query => assertion(`(${query.sql})=?`, [...query.params, query.count])):[])];
  const fullRows=async()=>{
    // One cooperative owner excludes application catalog writers between pages.
    // Repeating the full visibility scan in every byte-page is not a stronger
    // fence; retain it at both boundaries and in the final receipt transaction.
    const compact=()=>[mutationAssertion(db,owner,['activating']),assertion(`EXISTS(
      SELECT 1 FROM catalog_mutation_scopes s JOIN catalog_build_requests b ON b.request_id=s.activation_request_id
      WHERE s.environment=? AND s.index_name=? AND s.captured_at=? AND s.activation_request_id=?
      AND b.state='activating' AND b.lease_token=? AND b.run_reference=? AND b.release_id=? AND b.version_reference=? AND b.request_json=?)`,
      [owner.environment,owner.indexName,owner.capturedAt,permit.requestId,permit.token,permit.runReference,permit.releaseId,permit.versionReference,build.request_json])];
    await db.batch(assertions());
    const queries=pruningCurrentQueries(revision.sourceRows).map(q=>({sql:`(${q.sql})=?`,params:[...q.params,q.count]}));
    const add=(rows:typeof revision.packet.rows)=>{
      const q={sql:`(SELECT count(*) FROM json_each(?) e CROSS JOIN catalog_public_products p ON p.catalog_revision=?
        AND p.public_id=json_extract(e.value,'$.public_id') WHERE ${projectionColumns.map(k=>`p.${k} IS json_extract(e.value,'$.${k}')`).join(' AND ')})=?`,
        params:[JSON.stringify(rows),intent.catalogRevision,rows.length]};
      if(new TextEncoder().encode(JSON.stringify(q)).length>384*1024){if(rows.length<2)throw new Error('publication_activation_fenced');
        const n=Math.floor(rows.length/2);add(rows.slice(0,n));add(rows.slice(n));}else queries.push(q);
    };
    for(let i=0;i<revision.packet.rows.length;i+=20)add(revision.packet.rows.slice(i,i+20));
    // Same cooperative owner excludes application writers between bounded pages
    // and final compact receipt CAS. Privileged out-of-band SQL is not a barrier.
    let batch:typeof queries=[],bytes=0;
    const flush=async()=>{await db.batch([...compact(),...batch.map(q=>assertion(q.sql,q.params)),...compact()]);batch=[];bytes=0;};
    for(const q of queries){const n=new TextEncoder().encode(JSON.stringify(q)).length;if(batch.length>=40||bytes+n>400*1024)await flush();batch.push(q);bytes+=n;}
    if(batch.length)await flush();await db.batch(assertions());
  };
  // Owner/source assertions run before the trusted provider read and again in
  // the final receipt transaction. There is no upload/activate/claim callback.
  if(streamed)await fullRows();else await db.batch(assertions());
  let deployed: PublicationIntent;
  try { deployed = await readDeployed(intent); } catch { throw new Error('publication_readback_failed'); }
  if (encode(deployed) !== value.intent_json) throw new Error('publication_readback_mismatch');
  const at = now(); await preflight(db, snapshot, intent, at);
  if(streamed)await fullRows();
  await db.batch([...assertions(), ...completionStatements(db, snapshot, value, publication.token, at, false)]);
  await completed(db, value, publication.token);
}
export function completeActivatedPublication(db:CatalogD1,revision:PrunedRevision,publication:PublicationClaim,permit:ActivationPermit,
  readDeployed:(intent:PublicationIntent)=>Promise<PublicationIntent>,now:()=>Date=()=>new Date(),published?:PublishedCatalogBinding){
  return completeActivated(db,revision,publication,permit,readDeployed,now,published);
}
/** One-time permanent catalog only; original native proof and all full rows are
 * independently rechecked. This is not a larger recurring change allowance. */
export function completeActivatedPermanentPublication(db:CatalogD1,revision:PrunedRevision,publication:PublicationClaim,permit:ActivationPermit,
  readDeployed:(intent:PublicationIntent)=>Promise<PublicationIntent>,now:()=>Date=()=>new Date()){
  return completeActivated(db,revision,publication,permit,readDeployed,now,undefined,true);
}
/** Routine full-catalog completion; authentic whole-plan attestation and fresh
 * native coverage are mandatory. No installer proof or new delivery is inferred. */
export function completeActivatedApprovedCatalogPublication(db:CatalogD1,revision:PrunedRevision,publication:PublicationClaim,permit:ActivationPermit,
  readDeployed:(intent:PublicationIntent)=>Promise<PublicationIntent>,now:()=>Date=()=>new Date()){
  return completeActivated(db,revision,publication,permit,readDeployed,now,undefined,false,true);
}

/** Compact final CAS after same-owner accepted-public/native-anchor verification. No
 * catalog row is inserted/updated; the outbox is serving acceptance only. */
export async function completeActivatedServingPublication(db:CatalogD1,revision:AcceptedPublishedRevision,publication:PublicationClaim,permit:ActivationPermit,
  authority:AcceptedCatalogAuthority,readDeployed:(intent:PublicationIntent)=>Promise<PublicationIntent>,now:()=>Date=()=>new Date()){
  const owner=permit.mutationOwner,intent=publication.intent,snapshot=revision.snapshot;
  const encoded=encodeAcceptedCatalogAuthority(authority),requestBytes=encodeBuildRequest(authority.request);
  if(!owner||owner.phase!=='activating'||owner.operationKey!==await digest(encoded)||revision.operationKey!==owner.operationKey
    ||owner.environment!==authority.request.environment||owner.indexName!==revision.request.scope.indexName
    ||permit.requestId!==await digest(requestBytes)||permit.releaseId!==intent.releaseId||permit.versionReference.length<1
    ||snapshot.products.length<1
    ||snapshot.products.length+snapshot.heldProducts.length!==authority.identityCount
    ||revision.evidence!=='accepted-public-projection'||'sourceRows' in revision||intent.nextExpiry!==earliestDisplayExpiry(snapshot.products)
    ||snapshot.catalogRevision!==authority.request.sourceRevision||intent.catalogRevision!==snapshot.catalogRevision
    ||await digest(`${JSON.stringify(snapshot)}\n`)!==authority.request.sourceDigest
    ||intent.catalogSnapshotSha256!==authority.request.sourceDigest||intent.codeSha!==authority.request.codeSha
    ||intent.priorReleaseId!==authority.publication.releaseId)throw Error('serving_publication_fenced');
  const original=await acceptedCatalogReceipt(db,authority),value=await row(db,intent.releaseId);
  const build=(await db.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').bind(permit.requestId).all<Record<string,unknown>>()).results[0];
  if(!value||!build||value.intent_id!==publication.intentId||value.intent_json!==encode(intent)
    ||value.state!=='dispatched'||value.lease_token!==publication.token||value.lease_until!==publication.leaseUntil
    ||value.dispatch_reference!==`version:${permit.versionReference}`||build.state!=='activating'
    ||build.lease_token!==permit.token||build.run_reference!==permit.runReference||build.release_id!==permit.releaseId
    ||build.version_reference!==permit.versionReference||build.request_json!==requestBytes)throw Error('serving_publication_fenced');
  const columns=Object.keys(original);if(columns.some(k=>!/^[a-z_]+$/.test(k)))throw Error('serving_publication_fenced');
  const check=()=>[
    mutationAssertion(db,owner,['activating']),
    db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM publication_receipts WHERE ${columns.map(k=>`${k} IS ?`).join(' AND ')})
      AND (SELECT coalesce(max(rowid),0) FROM publication_receipts)=?
      AND NOT EXISTS(SELECT 1 FROM publication_receipts WHERE release_id=?)
      AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox)=?
      AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete')
      AND (SELECT count(*) FROM catalog_public_products WHERE catalog_revision=?)=?
      AND EXISTS(SELECT 1 FROM catalog_build_requests WHERE request_id=? AND request_json=? AND state='activating'
        AND lease_token=? AND run_reference=? AND release_id=? AND version_reference=?)
      AND EXISTS(SELECT 1 FROM publication_outbox WHERE intent_id=? AND intent_json=? AND state='dispatched'
        AND lease_token=? AND dispatch_reference=?) THEN 'true' ELSE 'serving_publication_fenced' END)`)
      .bind(...columns.map(k=>original[k]),authority.publicationReceiptWatermark,intent.releaseId,authority.globalVectorWatermark,
        snapshot.catalogRevision,snapshot.products.length,permit.requestId,requestBytes,permit.token,permit.runReference,permit.releaseId,permit.versionReference,
        publication.intentId,encode(intent),publication.token,`version:${permit.versionReference}`),
  ];
  await preflight(db,snapshot,intent,now(),authority);await db.batch(check());
  // This trusted callback owns fresh accepted-public/native-anchor + exact live readback.
  // The held owner and compact CAS fence the unchanged catalog on both sides.
  if(encode(await readDeployed(intent))!==encode(intent))throw Error('publication_readback_mismatch');
  await db.batch([...check(),db.prepare(`UPDATE publication_outbox SET state='verified',completed_token=?,lease_token=NULL,
      lease_until=NULL,error_code=NULL,updated_at=? WHERE intent_id=? AND state='dispatched' AND lease_token=?`)
    .bind(publication.token,now().toISOString(),publication.intentId,publication.token)]);
  const accepted=await row(db,intent.releaseId);
  if(accepted?.state!=='verified'||accepted.completed_token!==publication.token)throw Error('serving_publication_fenced');
}
