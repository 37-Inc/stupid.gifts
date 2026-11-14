import { randomUUID } from 'node:crypto';
import {isCatalogD1Rest} from './d1-write-rest.ts';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import { getProductsByPublicIds } from '../../lib/catalog/storage/d1.ts';
import { mutationAdvance, mutationAssertion, mutationFenceQuery, readMutationOwner } from '../../lib/catalog/mutation-fence.ts';
import type { MutationOwner, MutationScope } from '../../lib/catalog/mutation-fence.ts';
import type { ActivationPermit, CatalogBuildRequest } from '../../lib/catalog/build-requests.ts';
import { drainDeploymentObservation, encodeBuildRequest } from '../../lib/catalog/build-requests.ts';
import { encodePublicationIntent, encodePublishedCatalogBinding } from '../../lib/catalog/publication.ts';
import type { PublicationIntent, PublishedCatalogBinding } from '../../lib/catalog/publication.ts';
import { validateCatalogSnapshot,publicProductRightsExpiry,persistentDisplayRights } from '../../lib/catalog/snapshot.ts';
import {persistentPublicProduct} from '../../lib/catalog/display.ts';
import { hasAccountedVectorReadback,hasAccountedVectorTransport } from './vectorize-rest.ts';
import { pruneExistingRevision, prunedVectorIds, prunedVectorPlan, settleCapturedRevision, capturedRevisionBuildRequest, permanentCapturedRevision } from '../../lib/catalog/prune-existing-revision.ts';
import type { HistoricalNativeBinding, NativeHistoryBinding, PrunedRevision, PrunedVectorObservation, PrunedVectorPlan } from '../../lib/catalog/prune-existing-revision.ts';
import type { PermanentCatalogRevision } from '../../lib/catalog/freeze-permanent-catalog.ts';
import { permanentCatalogOperationKey } from '../../lib/catalog/freeze-permanent-catalog.ts';
import { prepareApprovedCohort } from '../../lib/catalog/freeze-approved-cohort.ts';
import {validateAutomationCohort,automationContains} from '../../lib/catalog/automation-cohort.ts';
import type {AutomationCohortAuthority} from '../../lib/catalog/automation-cohort.ts';
import type { ApprovedCohortEnvelope, ApprovedCohortRequest, ApprovedCohortRevision } from '../../lib/catalog/freeze-approved-cohort.ts';
import { loadMaintenanceVectorPayload } from './maintenance-d1.ts';
import { canonicalJson, sha256 } from './migration.ts';
import { decodePgvectorSendBase64, encodePgvectorSendBase64 } from './pgvector-binary.ts';
import { assertPruningCurrent, readOwnedProjection, readApprovedCurrentRows, SNAPSHOT_READ_LIMITS, checkCurrent, pruningCurrentQueries, readJournaledPruneDeleteSource } from './export-d1-snapshot.ts';
import { nativeHash, payloadVector, visible } from './vector-outbox.ts';
import type { ImmutableVectorPayload, SyncVector, VectorEvent } from './vector-outbox.ts';
import { approvedBaseChangeLimit } from '../../lib/catalog/owner-base-review.ts';
import type { OwnerBaseCatalogReview } from '../../lib/catalog/owner-base-review.ts';
import {repairedSlugOriginalVector} from './new-product-slug-repair.ts';
import {preservedPhotoVector,readPreservedPhotoVector} from './photo-vector-reuse.ts';
import {semanticPublicFields} from '../../lib/catalog/semantic-profile.ts';
import {readResolvedPublicationTransport} from './resolved-publication-transport.ts';

type Row = Record<string, unknown>;
type Code = 'provider_failed' | 'not_visible' | 'mutation_unknown' | 'attempts_exhausted';
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const HASH = /^[a-f0-9]{64}$/;
const REF = /^[a-zA-Z0-9._:/-]{1,200}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Current bounded protected-cohort proof, NOT full-catalog provider headroom.
 * Large catalogs need a reviewed batched/chunked readback proof before activation.
 */
export const OWNED_VECTOR_PROOF_LIMIT = 20;

export interface VectorDispatch {
  deliveryId: string; attempt: number; publicId: string; vector: SyncVector | null;
}
/** Provider-neutral, OFF by default. A real REST adapter must use exact-ID
 * getByIds and prove the known mutation processed (e.g. info's exact mutationId
 * under exclusive ownership). Never order opaque mutation IDs or use a clock.
 * Unknown responses have NO automatic replay. An optional independent resolver
 * can recover a reference or conclusively prove this attempt was not submitted.
 */
export interface OwnedVectorAdapters extends MutationScope {
  /** Immutable account/index identity, checked again when recovering a journal. */
  providerIdentity: string;
  dispatch(input: Readonly<VectorDispatch>, signal: AbortSignal): Promise<{ reference: string }>;
  /** One acknowledged native mutation for a homogeneous, bounded cohort. */
  dispatchBatch?(input: ReadonlyArray<Readonly<VectorDispatch>>, signal:AbortSignal):Promise<{reference:string}>;
  resolve(input: Readonly<{ deliveryId: string; attempt: number; reference: string | null }>, signal: AbortSignal): Promise<
    { state: 'pending' } | { state: 'settled' | 'not_submitted'; reference: string }>;
  readback(publicId: string, signal: AbortSignal): Promise<SyncVector | null>;
  /** Bounded exact-ID native read; order and NULL absence must match the request. */
  readbacks?(ids:string[], signal:AbortSignal):Promise<Array<SyncVector|null>>;
}
/** The hash is independently reviewed immutable input, not a checksum invented
 * from a provider read. Legacy migration payloads keep their input hash NULL.
 */
export interface OriginalVector {
  publicId: string; catalogRevision: string; sourceFactsHash: string; embeddingTextHash: string | null;
  values: number[]; vectorBytesSha256: string;
}
export interface OriginalVectorSource {
  sha256: string;
  load(signal: AbortSignal): Promise<OriginalVector>;
}
interface Request {
  kind: 'outbox' | 'prune' | 'historical_restore'; publicId: string; catalogRevision: string; vector: SyncVector | null;
  event: VectorEvent | null; payloadSha256: string | null; planSha256: string | null;
  globalWatermark: number | null; projectionReceipt: Row | null; eligibleUntil: string | null; pruneCurrent: Row | null;
  providerIdentity: string;
  /** New prune DELETEs retain hashes, never expired merchant bodies. Legacy
   * journals without this field keep their original exact-row replay format. */
  pruneDeleteControl?: { schemaVersion:1; productSha256:string; sourceSha256:string };
  historicalRestore?: {original:Row;deletion:Row};
  /** All members share one real provider mutation and atomic owner transition. */
  batchIds?:string[];
}
interface PruneDeleteSource { planSha256:string; current:Row; projectionReceipt:Row }
interface Journal extends Row {
  delivery_id: string; owner_json: string; request_json: string; product_json: string;
  status: 'pending' | 'complete'; attempts: number; dispatch_token: string | null;
  mutation_reference: string | null; evidence_json: string;
  disposition: 'verified' | 'expired' | 'expired_unsubmitted' | null;
}
export interface DeliveryResult {
  deliveryId: string; owner: MutationOwner; state: 'complete' | 'pending' | 'expired'; errorCode: Code | null;
}
function assertion(db: CatalogD1, sql: string, params: unknown[] = []) {
  return db.prepare(`SELECT json(CASE WHEN (${sql}) THEN 'true' ELSE 'vector_delivery_fenced' END)`).bind(...params);
}
function gate(owner: MutationOwner, pending: boolean) {
  const query = mutationFenceQuery(owner, ['writing','freezing']);
  // Same authoritative scope/token/epoch predicate; only the external marker
  // differs while this journal's durable dispatch intent is unresolved.
  return { sql: query.sql, params: [...query.params.slice(0,-1), pending ? 1 : 0] };
}
function owned(db: CatalogD1, owner: MutationOwner, pending: boolean) {
  const query = gate(owner, pending); return assertion(db, query.sql, query.params);
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeout: number,transportOwnsTimeout=false): Promise<T> {
  // The genuine accounted transport bounds headers/body separately from its
  // durable journal I/O. Do not add a second clock around that bookkeeping.
  if(transportOwnsTimeout)return operation(new AbortController().signal);
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation(controller.signal), new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('vector_provider_timeout')); }, timeout);
  })]); } finally { clearTimeout(timer); }
}
function timeoutOf(value?: number): number {
  // Explicit background maintenance only; request-time search has its own caps.
  if (value !== undefined && (!Number.isInteger(value) || value < 10 || value > 30_000)) throw new Error('invalid_vector_timeout');
  return value ?? 10_000;
}
function adapterScope(owner: MutationOwner, adapters: Pick<OwnedVectorAdapters,'environment'|'indexName'|'providerIdentity'>) {
  if (adapters.environment !== owner.environment || adapters.indexName !== owner.indexName
    || typeof adapters.providerIdentity !== 'string' || !REF.test(adapters.providerIdentity)) throw new Error('vector_provider_scope_mismatch');
}
function productAssertion(db: CatalogD1, product: Row, request: Request, requireFresh = true) {
  const columns = Object.keys(product);
  if (!columns.length || columns.length > 65 || columns.some(key => !/^[a-z_]+$/.test(key))) throw new Error('vector_product_changed');
  return assertion(db, `EXISTS(SELECT 1 FROM products WHERE ${columns.map(key => `${key} IS ?`).join(' AND ')}
    ${request.vector && requireFresh && request.kind!=='historical_restore' ? `AND eligible_until>${NOW} AND ?>${NOW}` : ''})`,
  [...columns.map(key => product[key]), ...(request.vector && requireFresh && request.kind!=='historical_restore' ? [request.eligibleUntil] : [])]);
}
function encodeRequest(request: Request): string {
  // JSON cannot preserve float32 negative zero. Persist the native vector_send
  // payload, then restore exact float32 bits before dispatch/readback comparison.
  return canonicalJson({ ...request, vector:request.vector ? { id:request.vector.id,metadata:request.vector.metadata,
    nativeBase64:encodePgvectorSendBase64(request.vector.values) } : null });
}
function decodeRequest(bytes: string): Request {
  const request = JSON.parse(bytes);
  if (request.vector) request.vector = { id:request.vector.id,metadata:request.vector.metadata,
    values:decodePgvectorSendBase64(request.vector.nativeBase64) };
  return request;
}
function requestAssertions(db: CatalogD1, request: Request) {
  if(request.kind==='historical_restore'){
    if(!request.historicalRestore||!request.vector||request.eligibleUntil!==null)throw Error('vector_restore_invalid');
    return Object.values(request.historicalRestore).map(row=>{
      const keys=Object.keys(row);
      if(keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw Error('vector_restore_invalid');
      return assertion(db,`EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k]));
    });
  }
  if (request.event) {
    const event = request.event;
    return [assertion(db, `EXISTS(SELECT 1 FROM vector_sync_outbox WHERE sequence=? AND public_id=? AND source_revision=?
      AND embedding_text_hash IS ? AND operation=? AND delete_mutation_sha256 IS ? AND status='pending')`,
    [event.sequence, event.publicId, event.catalogRevision, event.embeddingTextHash, event.operation, event.deleteMutationSha256 ?? null])];
  }
  const receipt = request.projectionReceipt!;
  return [...pruningCurrentQueries([request.pruneCurrent!]).map(query => assertion(db, `(${query.sql})=?`, [...query.params,query.count])),
  assertion(db, `EXISTS(SELECT 1 FROM catalog_projection_receipts WHERE catalog_revision=? AND snapshot_sha256=?
    AND projection_sha256=?) AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox)=?
    AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete')`,
  [request.catalogRevision, receipt.snapshot_sha256, receipt.projection_sha256, request.globalWatermark])];
}
async function journal(db: CatalogD1, id: string,signal?:AbortSignal): Promise<Journal | undefined> {
  return (await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').bind(id).all<Journal>({signal})).results[0];
}
function idFor(owner: MutationOwner, identity: unknown): string {
  mutationFenceQuery(owner, ['writing','freezing']);
  return sha256(canonicalJson({ environment: owner.environment, indexName: owner.indexName,
    generation: owner.generation, operationKey: owner.operationKey, identity }));
}

/** Reuse a previously accepted native upsert as HISTORY, not a new vector.
 * Only photo renewals with identical public search input, bytes, and metadata
 * qualify. Unknown/old receipt shapes take the ordinary delivery path. */
export async function unchangedPhotoNativeIds(db:CatalogD1,history:NativeHistoryBinding[],changed:Set<string>,
  previous:ApprovedCohortRequest['previous'],products:Map<unknown,Row>,states:Row[],revision:string){
  const result=new Set<string>(),priorById=new Map(previous.products.map(p=>[p.publicId,p])),byId=new Map(states.map(s=>[s.product_id,s]));
  for(const binding of history){
    const ids=binding.ids.filter(id=>changed.has(id)&&priorById.has(id));
    if(!ids.length)continue;
    const saved=await journal(db,binding.source.deliveryId);
    if(!saved||sha256(canonicalJson(saved))!==binding.source.deliverySha256)throw Error('vector_history_changed');
    const request=JSON.parse(saved.request_json),owner=JSON.parse(saved.owner_json) as MutationOwner;
    if(request.kind!==PLAN_KIND)continue;
    if(sha256(canonicalJson(request.plan))!==binding.planSha256||request.revisionSha256!==binding.revisionSha256)throw Error('vector_history_changed');
    const candidates=[];
    for(const id of ids){
      const row=products.get(id),prior=priorById.get(id)!,state=row&&byId.get(row.id),member=request.plan.products.find((m:{publicId:string})=>m.publicId===id);
      if(!row||!state||!member||member.sourceFactsHash!==row.source_facts_hash||member.embeddingTextHash!==row.embedding_text_hash
        ||!row.public_display_json)continue;
      const display=JSON.parse(String(row.public_display_json));
      if(!display||typeof display!=='object'||Array.isArray(display)
        ||canonicalJson(semanticPublicFields(prior))!==canonicalJson(semanticPublicFields(display))
        ||canonicalJson(semanticPublicFields(prior,'canonical-short-description-v2'))!==canonicalJson(semanticPublicFields(display,'canonical-short-description-v2')))continue;
      try{preservedPhotoVector(row,state,prior,member,revision);}
      catch(error){if(error instanceof Error&&error.message==='vector_original_unproven')continue;throw error;}
      candidates.push({id,delivery:idFor(owner,{kind:'prune',planHash:binding.planSha256,publicId:id})});
    }
    if(!candidates.length)continue;
    const rows=(await db.prepare(`SELECT p.public_id FROM json_each(?) i
      CROSS JOIN catalog_vector_deliveries d ON d.delivery_id=json_extract(i.value,'$.delivery')
      CROSS JOIN products p ON p.public_id=json_extract(i.value,'$.id')
      JOIN catalog_maintenance_products s ON s.product_id=p.id
      WHERE d.status='complete' AND d.disposition='verified' AND json_extract(d.request_json,'$.kind')='prune'
        AND json_extract(d.request_json,'$.planSha256')=? AND json_extract(d.request_json,'$.providerIdentity')=?
        AND json_extract(d.request_json,'$.vector.id')=p.public_id AND json_extract(d.request_json,'$.vector.metadata.eligible')=1
        AND json_extract(d.request_json,'$.vector.metadata.sourceFactsHash')=p.source_facts_hash
        AND json_extract(d.request_json,'$.vector.metadata.embeddingTextHash') IS p.embedding_text_hash
        AND json_extract(d.request_json,'$.vector.metadata.vectorBytesSha256')=json_extract(s.embedding_provenance_json,'$.vectorBytesSha256')
        AND json_extract(d.request_json,'$.vector.nativeBase64')=s.embedding_native_base64
        AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox o WHERE o.public_id=p.public_id AND o.source_revision=?)`)
      .bind(JSON.stringify(candidates),binding.planSha256,request.providerIdentity,revision).all<{public_id:string}>()).results;
    for(const row of rows)result.add(row.public_id);
  }
  return result;
}
async function recoveredOwner(db: CatalogD1, input: MutationOwner, row: Journal): Promise<MutationOwner> {
  const base = JSON.parse(row.owner_json) as MutationOwner;
  const actual = await readMutationOwner(db, input);
  const expected = { ...base, epoch: base.epoch + (row.status === 'complete' ? 2 : 1) };
  const completedCurrent = row.status === 'complete' && actual && input.epoch === actual.epoch && actual.epoch >= expected.epoch;
  const ownCompletion = row.status === 'complete' && input.epoch === base.epoch + 1 && actual?.epoch === base.epoch + 2;
  if (canonicalJson({ ...input, epoch: base.epoch }) !== canonicalJson(base)
    || !actual || canonicalJson({ ...actual,epoch:expected.epoch }) !== canonicalJson(expected)
    || input.epoch !== base.epoch && input.epoch !== actual.epoch && !ownCompletion
    || actual.epoch !== expected.epoch && !completedCurrent) throw new Error('vector_owner_changed');
  await db.batch([owned(db, actual, row.status === 'pending')]);
  return actual;
}
async function pendingResult(db: CatalogD1, input: MutationOwner, row: Journal, errorCode: Code): Promise<DeliveryResult> {
  return { deliveryId: row.delivery_id, owner: await recoveredOwner(db, input, row), state: 'pending', errorCode };
}
/** Read under the SAME held journal owner, then bind the independently matched
 * full values into the original atomic SQL CAS. D1 has no SHA SQL function:
 * a hash check alone, a subset predicate or an unverified reread is insufficient.
 * Only transient SQL parameters contain bodies; immutable control stays small.
 */
async function hydratePruneDelete(db:CatalogD1,owner:MutationOwner,row:Journal,request:Request,source?:PruneDeleteSource) {
  source=source&&structuredClone(source);
  const control=request.pruneDeleteControl;
  const productControl=JSON.parse(row.product_json);
  if(!control||Object.keys(control).sort().join(',')!=='productSha256,schemaVersion,sourceSha256'||control.schemaVersion!==1
    ||!HASH.test(control.productSha256)||!HASH.test(control.sourceSha256)||request.kind!=='prune'||request.vector!==null||request.event!==null
    ||request.pruneCurrent!==null||!source||source.planSha256!==request.planSha256
    ||source.current.public_id!==request.publicId||sha256(canonicalJson(source.current))!==control.sourceSha256
    ||canonicalJson(source.projectionReceipt)!==canonicalJson(request.projectionReceipt)
    ||canonicalJson(productControl)!==canonicalJson({schemaVersion:1,kind:'prune-delete-product-control',publicId:request.publicId,
      sha256:control.productSha256}))throw new Error('vector_prune_control_changed');
  const pending=row.status==='pending';const fence=gate(owner,pending);
  await db.batch([owned(db,owner,pending)]);
  const products=(await db.prepare(`SELECT p.* FROM products p WHERE p.public_id=? AND ${fence.sql}`)
    .bind(request.publicId,...fence.params).all<Row>()).results;
  if(products.length!==1||sha256(canonicalJson(products[0]))!==control.productSha256)throw new Error('vector_product_changed');
  const receipt=(await db.prepare(`SELECT r.* FROM catalog_projection_receipts r WHERE r.catalog_revision=? AND ${fence.sql}`)
    .bind(request.catalogRevision,...fence.params).all<Row>()).results;
  if(receipt.length!==1||canonicalJson(receipt[0])!==canonicalJson(request.projectionReceipt))throw new Error('vector_prune_control_changed');
  const hydrated={...request,pruneCurrent:structuredClone(source.current)};const product=products[0];
  await db.batch([owned(db,owner,pending),productAssertion(db,product,hydrated,false),...requestAssertions(db,hydrated),owned(db,owner,pending)]);
  return{request:hydrated,product};
}
async function execute(options: { db: CatalogD1; owner: MutationOwner; id: string; adapters: OwnedVectorAdapters; timeout: number;
  expectedPayloadSha256?: string | null;
  pruneDeleteSource?:PruneDeleteSource;
  resumeOnly?:boolean;
  prepare(): Promise<{ request: Omit<Request,'providerIdentity'>; product: Row }> }): Promise<DeliveryResult> {
  const { db, owner: input, id, adapters, timeout } = options;
  adapterScope(input,adapters);
  let row = await journal(db, id);
  if (!row) {
    if(options.resumeOnly)throw new Error('vector_resume_invalid');
    await db.batch([mutationAssertion(db, input, ['writing','freezing'])]);
    const prepared = await options.prepare(); const product = prepared.product;
    const request: Request = { ...prepared.request,providerIdentity:adapters.providerIdentity };
    const bodyFree=request.kind==='prune'&&request.vector===null;
    const productSha256=bodyFree?sha256(canonicalJson(product)):null;
    const persisted:Request=bodyFree?{...request,pruneCurrent:null,pruneDeleteControl:{schemaVersion:1,
      productSha256:productSha256!,sourceSha256:sha256(canonicalJson(request.pruneCurrent))}}:request;
    const requestBytes = encodeRequest(persisted);
    const productBytes = canonicalJson(bodyFree?{schemaVersion:1,kind:'prune-delete-product-control',publicId:request.publicId,sha256:productSha256}:product);
    if (Buffer.byteLength(requestBytes) > 200_000 || Buffer.byteLength(productBytes) > 768_000) throw new Error('vector_payload_bound');
    const owner = { ...input, epoch: input.epoch + 1 }; const query = gate(input, false);
    try {
      await db.batch([owned(db, input, false), productAssertion(db, product, request), ...requestAssertions(db, request),
        ...(request.event ? [assertion(db, `EXISTS(SELECT 1 FROM vector_sync_outbox WHERE sequence=? AND attempts=0
          AND lease_token IS NULL AND lease_until IS NULL AND mutation_reference IS NULL)`, [request.event.sequence]),
        db.prepare('UPDATE vector_sync_outbox SET lease_token=? WHERE sequence=?').bind(id, request.event.sequence)] : []),
        db.prepare(`INSERT INTO catalog_vector_deliveries(delivery_id,environment,index_name,generation,prior_epoch,owner_json,request_json,product_json)
          VALUES(?,?,?,?,?,?,?,?)`).bind(id, input.environment, input.indexName, input.generation, input.epoch,
          canonicalJson(input), requestBytes, productBytes),
        db.prepare(`UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1,external_pending=1
          WHERE environment=? AND index_name=? AND ${query.sql}`).bind(input.environment, input.indexName, ...query.params),
        owned(db, owner, true),
      ]);
    } catch { /* Recover only exact committed intent; never infer a failed batch succeeded. */ }
    row = await journal(db, id);
    if (!row || row.request_json !== requestBytes || row.product_json !== productBytes) throw new Error('vector_intent_unconfirmed');
  }
  const saved = decodeRequest(row.request_json);
  if(saved.batchIds)throw Error('vector_batch_resume_required');
  let owner = await recoveredOwner(db, input, row);
  if (saved.providerIdentity !== adapters.providerIdentity) throw new Error('vector_provider_scope_mismatch');
  if (options.expectedPayloadSha256 !== undefined && saved.payloadSha256 !== options.expectedPayloadSha256)
    throw new Error('vector_original_changed');
  const hydrated=saved.pruneDeleteControl!==undefined?await hydratePruneDelete(db,owner,row,saved,options.pruneDeleteSource):null;
  if (row.status === 'complete') return { deliveryId: id, owner, state: row.disposition === 'verified' ? 'complete' : 'expired', errorCode: null };
  const request = hydrated?.request??saved; const product = hydrated?.product??JSON.parse(row.product_json) as Row;
  // A clock crossing alone must never prevent observing an already-dispatched
  // mutation. Freshness is checked separately immediately BEFORE dispatch.
  const checks = () => [owned(db, owner, true), productAssertion(db, product, request, false), ...requestAssertions(db, request),
    ...(request.event ? [assertion(db, `EXISTS(SELECT 1 FROM vector_sync_outbox WHERE sequence=? AND lease_token=? AND attempts=?)`,
      [request.event.sequence,id,row!.attempts])] : [])];
  await db.batch(checks());
  let settled = false;
  if (row.dispatch_token) {
    let observation;
    try { observation = await bounded(signal => adapters.resolve({ deliveryId: id, attempt: row!.attempts,
      reference: row!.mutation_reference }, signal), timeout,hasAccountedVectorTransport(adapters)); }
    catch { return pendingResult(db, input, row, 'provider_failed'); }
    if (observation.state === 'pending') return pendingResult(db, input, row, 'mutation_unknown');
    if (!REF.test(observation.reference) || (observation.state === 'settled' && row.mutation_reference
      && observation.reference !== row.mutation_reference)) throw new Error('vector_resolution_invalid');
    if (observation.state === 'not_submitted') {
      if(options.resumeOnly)throw new Error('vector_resolution_invalid');
      if (row.mutation_reference) throw new Error('vector_resolution_invalid');
      // This is independent conclusive evidence, NOT an HTTP exception/timeout.
      // Retain all bounded attempt evidence and retry only on a subsequent call.
      const evidence = canonicalJson([...JSON.parse(row.evidence_json), { attempt: row.attempts, state: 'not_submitted', reference: observation.reference }]);
      await db.batch([...checks(), db.prepare(`UPDATE catalog_vector_deliveries SET dispatch_token=NULL,mutation_reference=NULL,evidence_json=?
        WHERE delivery_id=? AND dispatch_token=? AND evidence_json=?`).bind(evidence, id, row.dispatch_token, row.evidence_json),
      assertion(db, 'EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND dispatch_token IS NULL AND evidence_json=?)', [id, evidence])]);
      return pendingResult(db, input, (await journal(db,id))!, row.attempts >= 3 ? 'attempts_exhausted' : 'mutation_unknown');
    }
    settled = true;
    // Recovered unknown reference is retained before visibility/finalization.
    await db.batch([...checks(), db.prepare(`UPDATE catalog_vector_deliveries SET mutation_reference=?
      WHERE delivery_id=? AND dispatch_token=? AND mutation_reference IS ?`).bind(observation.reference, id, row.dispatch_token, row.mutation_reference),
    ...(request.event ? [db.prepare('UPDATE vector_sync_outbox SET mutation_reference=? WHERE sequence=? AND lease_token=?')
      .bind(observation.reference,request.event.sequence,id)] : []),
    assertion(db, 'EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND mutation_reference=?)', [id, observation.reference])]);
    row = (await journal(db,id))!;
  }
  let actual: SyncVector | null;
  try { actual = await bounded(signal => adapters.readback(request.publicId, signal), timeout,hasAccountedVectorTransport(adapters)); }
  catch { return pendingResult(db, input, row, 'provider_failed'); }
  const isVisible = visible(request.vector, actual);
  const fresh = !request.vector || request.kind==='historical_restore'
    || (await db.prepare(`SELECT ?>${NOW} fresh`).bind(request.eligibleUntil).all<{ fresh:number }>()).results[0].fresh === 1;
  if (!isVisible && !row.dispatch_token && fresh) {
    if(options.resumeOnly)throw new Error('vector_resume_dispatch_forbidden');
    if (row.attempts >= 3) return pendingResult(db, input, row, 'attempts_exhausted');
    const token = randomUUID();
    // Persist the unique dispatch marker BEFORE external code. Only its winning
    // live caller may send; a restarted/concurrent caller can only resolve it.
    await db.batch([...checks(),productAssertion(db,product,request), db.prepare(`UPDATE catalog_vector_deliveries SET dispatch_token=?,attempts=attempts+1
      WHERE delivery_id=? AND dispatch_token IS NULL AND attempts=?`).bind(token,id,row.attempts),
    assertion(db, 'EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND dispatch_token=?)', [id,token]),
    ...(request.event ? [db.prepare('UPDATE vector_sync_outbox SET attempts=attempts+1 WHERE sequence=? AND lease_token=?')
      .bind(request.event.sequence,id)] : [])]);
    row = (await journal(db,id))!;
    let accepted;
    try { accepted = await bounded(signal => adapters.dispatch({ deliveryId: id, attempt: row!.attempts,
      publicId: request.publicId, vector: structuredClone(request.vector) }, signal), timeout,hasAccountedVectorTransport(adapters)); }
    catch { return pendingResult(db, input, row, 'mutation_unknown'); }
    if (!accepted || !REF.test(accepted.reference)) return pendingResult(db, input, row, 'mutation_unknown');
    // A lost D1 response here leaves the persisted dispatch token, so retry still
    // resolves and NEVER blindly sends again.
    try {
      await db.batch([...checks(), db.prepare(`UPDATE catalog_vector_deliveries SET mutation_reference=?
        WHERE delivery_id=? AND dispatch_token=? AND mutation_reference IS NULL`).bind(accepted.reference,id,token),
      ...(request.event ? [db.prepare('UPDATE vector_sync_outbox SET mutation_reference=? WHERE sequence=? AND lease_token=?')
        .bind(accepted.reference,request.event.sequence,id)] : []),
      assertion(db, 'EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND mutation_reference=?)', [id,accepted.reference])]);
    } catch { /* Exact journal readback below; unknown acceptance remains owned. */ }
    row = (await journal(db,id))!;
    return pendingResult(db, input, row, 'mutation_unknown'); // Acceptance is never completion.
  }
  if (row.dispatch_token && !settled) return pendingResult(db, input, row, 'mutation_unknown');
  if (!isVisible && (row.dispatch_token || fresh)) return pendingResult(db, input, row, 'not_visible');
  const unsentExpired = !isVisible && !row.dispatch_token && !fresh;
  if(unsentExpired){const history=JSON.parse(row.evidence_json);
    if(!Array.isArray(history)||history.length!==row.attempts||history.some((item,i)=>item.state!=='not_submitted'||item.attempt!==i+1))
      throw new Error('vector_non_submission_unproven');}
  const next = { ...owner, epoch: owner.epoch + 1 }; const query = gate(owner, true);
  const evidence = canonicalJson([...JSON.parse(row.evidence_json), { attempt: row.attempts,
    state: unsentExpired ? 'expired_unsubmitted' : row.dispatch_token ? 'settled_visible' : 'already_visible', reference: row.mutation_reference }]);
  try {
    await db.batch([...checks(),
      ...(request.event && !unsentExpired ? [db.prepare(`UPDATE vector_sync_outbox SET status='complete',completed_at=${NOW},lease_until=NULL,error_code=NULL
        WHERE sequence=? AND status='pending' AND lease_token=?`).bind(request.event.sequence,id),
      assertion(db, "EXISTS(SELECT 1 FROM vector_sync_outbox WHERE sequence=? AND status='complete' AND lease_token=?)", [request.event.sequence,id])]
        :request.event ? [db.prepare(`UPDATE vector_sync_outbox SET lease_token=NULL WHERE sequence=? AND status='pending'
          AND lease_token=? AND attempts=? AND mutation_reference IS NULL`).bind(request.event.sequence,id,row.attempts),
        assertion(db,"EXISTS(SELECT 1 FROM vector_sync_outbox WHERE sequence=? AND status='pending' AND attempts=? AND lease_token IS NULL)",
          [request.event.sequence,row.attempts])] : []),
      db.prepare(`UPDATE catalog_vector_deliveries SET status='complete',completed_at=${NOW},evidence_json=?,
        disposition=CASE WHEN ? THEN 'expired_unsubmitted' WHEN ? AND ?<=${NOW} THEN 'expired' ELSE 'verified' END
        WHERE delivery_id=? AND status='pending' AND dispatch_token IS ? AND evidence_json=?`)
        .bind(evidence,unsentExpired?1:0,request.vector?1:0,request.eligibleUntil,id,row.dispatch_token,row.evidence_json),
      assertion(db, "EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND status='complete' AND evidence_json=?)", [id,evidence]),
      db.prepare(`UPDATE catalog_mutation_scopes SET external_pending=0,mutation_epoch=mutation_epoch+1
        WHERE environment=? AND index_name=? AND ${query.sql}`).bind(owner.environment,owner.indexName,...query.params),
      owned(db,next,false),
    ]);
  } catch { /* Exact completion/owner reconciliation, including response loss. */ }
  row = (await journal(db,id))!; owner = await recoveredOwner(db,input,row);
  return { deliveryId: id, owner, state: row.status === 'complete' ? row.disposition === 'verified' ? 'complete' : 'expired' : 'pending',
    errorCode: row.status === 'complete' ? null : 'not_visible' };
}

/** One explicit immutable event. No provider mutation is attempted for a legacy
 * attempted/leased event lacking an owned journal: its overlap needs review.
 */
async function outboxDelivery(options: { db: CatalogD1; owner: MutationOwner; sequence: number; catalogRevision: string;
  loadPayload(event: Readonly<VectorEvent>, signal: AbortSignal): Promise<ImmutableVectorPayload>;
  adapters: OwnedVectorAdapters; timeoutMs?: number }): Promise<DeliveryResult> {
  const { db, owner, sequence, catalogRevision } = options; const timeout = timeoutOf(options.timeoutMs);
  if (owner.phase !== 'writing' || !Number.isSafeInteger(sequence) || sequence < 1 || typeof catalogRevision !== 'string'
    || !catalogRevision.trim() || Buffer.byteLength(catalogRevision) > 64) throw new Error('invalid_owned_vector_event');
  const id = idFor(owner,{ kind:'outbox', sequence,catalogRevision });
  return execute({ ...options, id, timeout, async prepare() {
    const eventRow = (await db.prepare('SELECT * FROM vector_sync_outbox WHERE sequence=?').bind(sequence).all()).results[0];
    if (!eventRow || eventRow.status !== 'pending' || eventRow.source_revision !== catalogRevision
      || !UUID.test(String(eventRow.public_id))) throw new Error('vector_event_changed');
    const event: VectorEvent = { sequence, publicId: String(eventRow.public_id), catalogRevision: String(eventRow.source_revision),
      ...(eventRow.embedding_text_hash === null ? { embeddingTextHash:null, operation:'delete' as const, deleteMutationSha256:String(eventRow.delete_mutation_sha256) }
        : { embeddingTextHash:String(eventRow.embedding_text_hash), operation:eventRow.operation as 'upsert'|'delete' }) };
    const product = (await db.prepare('SELECT * FROM products WHERE public_id=?').bind(event.publicId).all()).results[0];
    if (!product || product.catalog_revision !== event.catalogRevision || product.embedding_text_hash !== event.embeddingTextHash
      || event.embeddingTextHash !== null && !HASH.test(event.embeddingTextHash)) throw new Error('vector_product_changed');
    const now = (await db.prepare(`SELECT ${NOW} now`).all<{ now:string }>()).results[0].now;
    const eligible = await getProductsByPublicIds(db,[event.publicId],new Date(now),event.catalogRevision);
    if ((event.operation === 'upsert') !== Boolean(eligible.length)) throw new Error('vector_product_changed');
    const payload = await bounded(signal => options.loadPayload(event,signal),timeout);
    const review = event.embeddingTextHash === null ? (await db.prepare('SELECT mutation_json FROM vector_delete_mutations WHERE mutation_sha256=? AND public_id=? AND source_revision=?')
      .bind(event.deleteMutationSha256,event.publicId,event.catalogRevision).all<{ mutation_json:string }>()).results[0]?.mutation_json : undefined;
    const vector = payloadVector(event,payload,product,review,Date.parse(now));
    return { product, request: { kind:'outbox',publicId:event.publicId,catalogRevision:event.catalogRevision,vector,event,
      payloadSha256:sha256(canonicalJson(payload)),planSha256:null,globalWatermark:null,projectionReceipt:null,
      eligibleUntil:eligible[0]?.eligibleUntil ?? null,pruneCurrent:null } };
  } });
}

/** One UUID from the strict prune plan. Its deletion authority is the sealed
 * removed-ID plan, not an invented legacy embedding hash or manual approval.
 * Upserts replace ONLY metadata while preserving reviewed original float32s.
 */
async function pruneDelivery(options: { db: CatalogD1; owner: MutationOwner; revision: PrunedRevision;
  publicId: string; original?: OriginalVectorSource; adapters: OwnedVectorAdapters; timeoutMs?: number }, approved = false,policy?:CohortPlanRequest): Promise<DeliveryResult> {
  const { db,owner,revision,publicId } = options; const timeout = timeoutOf(options.timeoutMs);
  const plan = prunedVectorPlan(revision); const planHash = sha256(canonicalJson(plan));
  const member = plan.products.find(product => product.publicId === publicId); const absent = plan.absentIds.includes(publicId);
  if (plan.products.length + plan.absentIds.length > (policy?SNAPSHOT_READ_LIMITS.identities:OWNED_VECTOR_PROOF_LIMIT)) throw new Error('vector_plan_invalid');
  if (owner.phase !== 'freezing' || !UUID.test(publicId) || (!member && !absent) || (member && !HASH.test(options.original?.sha256 ?? ''))
    || (absent && options.original)) throw new Error('invalid_owned_prune_vector');
  const id = idFor(owner,{ kind:'prune',planHash,publicId });
  const captured=revision.sourceRows.find(row=>row.public_id===publicId);
  return execute({ ...options,id,timeout,expectedPayloadSha256:options.original?.sha256 ?? null,
    ...(absent&&captured?{pruneDeleteSource:{planSha256:planHash,current:structuredClone(captured),projectionReceipt:revision.packet.receipt}}:{}),async prepare() {
    if(policy)await db.batch(planChecks(db,owner,revision as ApprovedCohortRevision));
    else {const rebuilt = approved ? await prepareApprovedCohort(db,owner,(revision as ApprovedCohortRevision).request)
      : await pruneExistingRevision(db,owner,revision.request);
      if (rebuilt.state === 'unchanged' || canonicalJson(rebuilt.revision) !== canonicalJson(revision)) throw new Error('vector_prune_changed');}
    return preparePruneRequest(options,approved);
  } });
}
async function preparePruneRequest(options:Parameters<typeof pruneDelivery>[0],approved:boolean):Promise<{product:Row;request:Omit<Request,'providerIdentity'>}>{
    const {db,revision,publicId}=options,plan=prunedVectorPlan(revision),planHash=sha256(canonicalJson(plan));
    const captured=revision.sourceRows.find(row=>row.public_id===publicId),member=plan.products.find(p=>p.publicId===publicId);
    // Captured rows also have archived_* JSON aliases, not physical columns.
    // Bind those through the canonical pruning predicate and separately capture
    // the complete operational row for the delivery's final exact-row CAS.
    const product = (await db.prepare('SELECT * FROM products WHERE public_id=?').bind(publicId).all()).results[0];
    if (!captured || !product) throw new Error('vector_product_changed');
    let vector: SyncVector | null = null;
    if (member) {
      const original = await bounded(signal => options.original!.load(signal),timeoutOf(options.timeoutMs));
      if (sha256(canonicalJson(original)) !== options.original!.sha256 || original.publicId !== publicId
        || original.catalogRevision !== (approved && (revision as ApprovedCohortRevision).request.approval.changes.some(change=>change.publicId===publicId)
          ? revision.snapshot.catalogRevision : revision.request.previous.catalogRevision)
        || original.sourceFactsHash !== member.sourceFactsHash || original.embeddingTextHash !== member.embeddingTextHash
        || !Array.isArray(original.values) || original.values.length !== 1536
        || !Array.from(original.values).every(value => typeof value === 'number' && Number.isFinite(value))
        || !HASH.test(original.vectorBytesSha256) || nativeHash(original.values) !== original.vectorBytesSha256)
        throw new Error('vector_original_unproven');
      vector = { id:publicId,values:[...original.values],metadata:{ catalogRevision:plan.catalogRevision,eligible:true,
        sourceFactsHash:member.sourceFactsHash,vectorBytesSha256:original.vectorBytesSha256,
        ...(member.embeddingTextHash === null ? { legacyInputProvenance:'unverified' } :
          { embeddingTextHash:member.embeddingTextHash,embeddingModel:'text-embedding-3-small' }) } };
    }
    return { product,request:{ kind:'prune',publicId,catalogRevision:plan.catalogRevision,vector,event:null,
      payloadSha256:options.original?.sha256 ?? null,planSha256:planHash,globalWatermark:plan.globalWatermark,
      projectionReceipt:revision.packet.receipt,pruneCurrent:captured,
      eligibleUntil:revision.snapshot.products.find(value => value.publicId === publicId)?.eligibleUntil ?? null } };
}

/** Concrete read-only proof callback for settlePrunedRevision. Invoke only after
 * every planned UUID completed under THIS ownership generation. Current source
 * and publication CAS are still enforced by settlePrunedRevision, not this read.
 * Stable-ID transition makes old semantic search use keyword fallback; rollback
 * requires owned restoration + exact proof of prior original vectors first.
 */
async function readPrunedVectors(db: CatalogD1, owner: MutationOwner, revision: PrunedRevision,
  adapters: Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>): Promise<PrunedVectorObservation> {
  adapterScope(owner,adapters);
  const plan = prunedVectorPlan(revision); const hash = sha256(canonicalJson(plan));
  if (owner.phase !== 'freezing' || plan.environment !== owner.environment || plan.indexName !== owner.indexName
    || plan.products.length + plan.absentIds.length > OWNED_VECTOR_PROOF_LIMIT) throw new Error('vector_plan_invalid');
  await db.batch([mutationAssertion(db,owner,['freezing'])]);
  const rows = (await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
    AND json_extract(request_json,'$.kind')='prune' AND json_extract(request_json,'$.planSha256')=? LIMIT 21`)
    .bind(owner.environment,owner.indexName,owner.generation,hash).all<Journal>()).results;
  const ids = [...plan.products.map(product => product.publicId),...plan.absentIds];
  const requests = new Map(rows.map(row => [String(decodeRequest(row.request_json).publicId),decodeRequest(row.request_json)]));
  if (rows.length !== ids.length || requests.size !== ids.length || rows.some(row => row.status !== 'complete' || row.disposition !== 'verified')
    || ids.some(id => !requests.has(id) || requests.get(id)!.providerIdentity !== adapters.providerIdentity)) throw new Error('vector_plan_incomplete');
  await bounded(async signal => {
    for (let offset=0;offset<ids.length;offset+=10) await Promise.all(ids.slice(offset,offset+10).map(async id => {
      if (signal.aborted || !visible(requests.get(id)!.vector,await adapters.readback(id,signal))) throw new Error('vector_not_visible');
    }));
  },3000);
  await db.batch([mutationAssertion(db,owner,['freezing'])]);
  return { environment:owner.environment,indexName:owner.indexName,settled:true,planSha256:hash,
    reference:`owned-vectors:${sha256(canonicalJson(rows.map(row => row.delivery_id).sort()))}` };
}
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    throw new Error(error instanceof Error && /^(vector_[a-z_]+|cohort_[a-z_]+|automation_cohort_[a-z_]+|prune_[a-z_]+|invalid_owned_[a-z_]+|invalid_vector_timeout)$/.test(error.message)
      ? error.message : 'vector_delivery_failed',{cause:error});
  }
}
export function deliverOwnedOutboxEvent(options: Parameters<typeof outboxDelivery>[0]): Promise<DeliveryResult> {
  return safe(() => outboxDelivery(options));
}
export function deliverOwnedPrunedVector(options: Parameters<typeof pruneDelivery>[0]): Promise<DeliveryResult> {
  return safe(() => pruneDelivery(options));
}
/** Undo one confirmed erroneous DELETE using its exact previously verified
 * native payload. This restores OLD metadata/bits, never a fresh supplier/input
 * claim. Ordinary promotion retains all original expiry checks. */
export function restoreOwnedHistoricalVector(options:{db:CatalogD1;owner:MutationOwner;publicId:string;
  originalDeliveryId:string;originalSha256:string;deletionDeliveryId:string;deletionSha256:string;adapters:OwnedVectorAdapters}){
  return safe(async()=>{
    const {db,owner,adapters}=options;adapterScope(owner,adapters);
    const original=await journal(db,options.originalDeliveryId),deletion=await journal(db,options.deletionDeliveryId);
    if(!original||!deletion||owner.phase!=='freezing'||sha256(canonicalJson(original))!==options.originalSha256
      ||sha256(canonicalJson(deletion))!==options.deletionSha256||original.status!=='complete'||original.disposition!=='verified'
      ||deletion.status!=='complete'||deletion.disposition!=='verified'||deletion.generation!==owner.generation
      ||Number(original.generation)>=owner.generation||!deletion.mutation_reference)throw Error('vector_restore_invalid');
    const old=decodeRequest(original.request_json),removed=decodeRequest(deletion.request_json);
    const evidence=JSON.parse(String(deletion.evidence_json)).at(-1);
    const latest=(await db.prepare(`SELECT delivery_id FROM catalog_vector_deliveries WHERE environment=? AND index_name=?
      AND status='complete' AND disposition='verified' AND json_extract(request_json,'$.publicId')=?
      AND json_extract(request_json,'$.kind') IN('outbox','prune') AND json_type(request_json,'$.vector')='object'
      ORDER BY generation DESC,prior_epoch DESC LIMIT 1`).bind(owner.environment,owner.indexName,options.publicId).all()).results;
    if(!old.vector||old.publicId!==options.publicId||removed.publicId!==options.publicId||removed.vector!==null||removed.kind!=='prune'
      ||latest.length!==1||latest[0].delivery_id!==original.delivery_id||evidence?.state!=='settled_visible'
      ||evidence.reference!==deletion.mutation_reference
      ||old.providerIdentity!==adapters.providerIdentity||removed.providerIdentity!==adapters.providerIdentity
      ||[original,deletion].some(r=>r.environment!==owner.environment||r.index_name!==owner.indexName))throw Error('vector_restore_invalid');
    const product=(await db.prepare('SELECT * FROM products WHERE public_id=?').bind(options.publicId).all<Row>()).results[0];
    const base=typeof product?.public_display_json==='string'?persistentPublicProduct(JSON.parse(product.public_display_json)):null;
    if(!base||product.is_active!==1||product.duplicate_of_product_id!==null
      ||publicProductRightsExpiry(base,persistentDisplayRights(JSON.parse(String(product.rights_json))),new Date())!==Infinity)
      throw Error('vector_restore_invalid');
    const id=idFor(owner,{kind:'historical_restore',original:options.originalSha256,deletion:options.deletionSha256});
    return execute({db,owner,id,adapters,timeout:10000,prepare:async()=>({product,request:{kind:'historical_restore',publicId:options.publicId,
      catalogRevision:old.catalogRevision,vector:old.vector,event:null,payloadSha256:null,planSha256:null,globalWatermark:null,
      projectionReceipt:null,eligibleUntil:null,pruneCurrent:null,historicalRestore:{original,deletion}}})});
  });
}
/** Settle an existing accepted body-free DELETE only. The independently pinned
 * sealed plan is control data, not an invented/partial PrunedRevision. No new
 * journal, prune, non-submission inference, dispatch or source-body persistence.
 */
export function resumeOwnedPrunedDelete(options:{db:CatalogD1;owner:MutationOwner;deliveryId:string;plan:PrunedVectorPlan;
  adapters:Omit<OwnedVectorAdapters,'dispatch'>;timeoutMs?:number}):Promise<DeliveryResult> {
  return safe(async()=>{
    const {db,adapters,deliveryId}=options,owner=structuredClone(options.owner),plan=structuredClone(options.plan);
    adapterScope(owner,adapters);const timeout=timeoutOf(options.timeoutMs);
    const policy=owner.phase==='freezing'?await journal(db,idFor(owner,{kind:PLAN_KIND})):undefined;
    if(policy)validatePlan(policy,owner,plan,adapters.providerIdentity);
    if(owner.phase!=='freezing'||!HASH.test(deliveryId)||plan.environment!==owner.environment||plan.indexName!==owner.indexName
      ||!Array.isArray(plan.products)||!Array.isArray(plan.absentIds)||!HASH.test(plan.snapshotSha256)
      ||!Number.isSafeInteger(plan.globalWatermark)||plan.globalWatermark<0
      ||plan.products.length+plan.absentIds.length>(policy?SNAPSHOT_READ_LIMITS.identities:OWNED_VECTOR_PROOF_LIMIT))throw new Error('vector_resume_invalid');
    const ids=[...plan.products.map(p=>p.publicId),...plan.absentIds];
    if(ids.some(id=>!UUID.test(id))||new Set(ids).size!==ids.length)throw new Error('vector_resume_invalid');
    const row=await journal(db,deliveryId);if(!row)throw new Error('vector_resume_invalid');
    const request=decodeRequest(row.request_json),base=JSON.parse(row.owner_json),planHash=sha256(canonicalJson(plan));
    if(request.kind!=='prune'||request.vector!==null||request.event!==null||request.payloadSha256!==null
      ||request.pruneCurrent!==null||!request.pruneDeleteControl||!row.dispatch_token||!REF.test(row.mutation_reference??'')
      ||!Number.isSafeInteger(row.attempts)||row.attempts<1||row.attempts>3
      ||request.providerIdentity!==adapters.providerIdentity||request.planSha256!==planHash
      ||request.catalogRevision!==plan.catalogRevision||request.globalWatermark!==plan.globalWatermark
      ||request.projectionReceipt?.snapshot_sha256!==plan.snapshotSha256||!plan.absentIds.includes(request.publicId)
      ||idFor(owner,{kind:'prune',planHash,publicId:request.publicId})!==deliveryId
      ||canonicalJson({...owner,epoch:base.epoch})!==canonicalJson(base))throw new Error('vector_resume_invalid');
    if(row.status==='complete'){
      if(owner.epoch!==base.epoch+2||row.disposition!=='verified')throw new Error('vector_owner_changed');
      const evidence=JSON.parse(row.evidence_json),last=Array.isArray(evidence)&&evidence.at(-1);
      if(!last||last.state!=='settled_visible'||last.attempt!==row.attempts||last.reference!==row.mutation_reference)
        throw new Error('vector_resume_invalid');
      const current=await readJournaledPruneDeleteSource(db,owner,deliveryId,request.publicId,true);
      await hydratePruneDelete(db,owner,row,request,{planSha256:planHash,current,projectionReceipt:request.projectionReceipt!});
      // Original completion reconciliation only, not a fresh native vector proof.
      return{deliveryId,owner,state:'complete',errorCode:null};
    }
    if(row.status!=='pending'||owner.epoch!==base.epoch+1)throw new Error('vector_owner_changed');
    const current=await readJournaledPruneDeleteSource(db,owner,deliveryId,request.publicId);
    return execute({db,owner,id:deliveryId,timeout,resumeOnly:true,expectedPayloadSha256:null,
      pruneDeleteSource:{planSha256:planHash,current,projectionReceipt:request.projectionReceipt!},
      adapters:{...adapters,dispatch:async()=>{throw new Error('vector_resume_dispatch_forbidden');}},
      prepare:async()=>{throw new Error('vector_resume_invalid');}});
  });
}
/** Same sealed-plan journal/expiry recovery as pruning (the persisted kind stays
 * "prune" for compatibility). Changed products MUST use their immutable owned
 * maintenance payload, never a caller-supplied replacement or regenerated vector.
 * Unchanged legacy products still require independently pinned original bytes.
 */
export function deliverOwnedApprovedCohortVector(options: Omit<Parameters<typeof pruneDelivery>[0],'revision'> & { revision:ApprovedCohortRevision }): Promise<DeliveryResult> {
  return safe(async()=>{
    const plan=prunedVectorPlan(options.revision);
    const policy=await policyReceipt(options.db,options.owner,options.revision,options.adapters.providerIdentity);
    if(policy?.sources.some(s=>s.publicId===options.publicId))throw new Error('vector_plan_already_reused');
    if(plan.products.length+plan.absentIds.length>(policy?SNAPSHOT_READ_LIMITS.identities:OWNED_VECTOR_PROOF_LIMIT))throw new Error('vector_plan_invalid');
    return pruneDelivery(await approvedVectorOptions(options),true,policy??undefined);
  });
}
async function approvedVectorOptions(options:Omit<Parameters<typeof pruneDelivery>[0],'revision'>&{revision:ApprovedCohortRevision}){
    const change=options.revision.request.approval.changes.find(value=>value.publicId===options.publicId),plan=prunedVectorPlan(options.revision);
    if(!change || !plan.products.some(value=>value.publicId===options.publicId))return options;
    if(options.original)throw new Error('vector_original_unproven');
    const product=(await options.db.prepare('SELECT * FROM products WHERE public_id=?').bind(options.publicId).all()).results[0];
    if(!product)throw new Error('vector_product_changed');
    if(sha256(canonicalJson(product))!==change.productSha256){
      const original=await repairedSlugOriginalVector(options.db,options.owner,options.revision,change,product);
      return {...options,original:{sha256:sha256(canonicalJson(original)),async load(){return original;}}};
    }
    const rows=(await options.db.prepare(`SELECT o.* FROM catalog_maintenance_vector_payloads p CROSS JOIN vector_sync_outbox o
      ON o.sequence=p.sequence WHERE p.operation_id=? AND o.public_id=? AND o.source_revision=? AND o.status='complete' AND o.operation='upsert' LIMIT 2`)
      .bind(change.operationId,options.publicId,options.revision.snapshot.catalogRevision).all()).results;
    if(rows.length===0){
      const state=(await options.db.prepare('SELECT * FROM catalog_maintenance_products WHERE product_id=?').bind(product.id).all()).results;
      if(state.length!==1)throw Error('vector_original_unproven');
      const original=await readPreservedPhotoVector(options.db,product,state[0],options.revision.request.previous,
        plan.products.find(p=>p.publicId===options.publicId)!,options.revision.snapshot.catalogRevision);
      return {...options,original:{sha256:sha256(canonicalJson(original)),async load(){return original;}}};
    }
    if(rows.length!==1)throw new Error('vector_original_unproven');
    const row=rows[0];const event:VectorEvent={sequence:Number(row.sequence),publicId:String(row.public_id),catalogRevision:String(row.source_revision),
      embeddingTextHash:String(row.embedding_text_hash),operation:'upsert'};
    const payload=await loadMaintenanceVectorPayload(options.db,event);
    // Decoding an existing immutable payload is not an embedding/model call.
    const vector=payloadVector(event,payload,product,undefined,Date.parse(options.revision.snapshot.generatedAt));
    if(!vector)throw new Error('vector_original_unproven');
    const original:OriginalVector={publicId:options.publicId,catalogRevision:event.catalogRevision,
      sourceFactsHash:String(product.source_facts_hash),embeddingTextHash:event.embeddingTextHash,values:vector.values,
      vectorBytesSha256:nativeHash(vector.values)};
    return {...options,original:{sha256:sha256(canonicalJson(original)),async load(){return original;}}};
}

interface ReusedSource { publicId:string; operationId:string; sequence:number; deliveryId:string; reference:string|null; sha256:string }

/** Homogeneous native UPSERTs share one provider ACK and atomic owner transition.
 * Per-product original journals remain genuine and readable by existing proof/
 * history readers. An uncertain batch is never retried as individual writes.
 * Deletions and frozen single-item intents retain the original path.
 */
export function deliverOwnedApprovedCohortBatch(options:{db:CatalogD1;owner:MutationOwner;revision:ApprovedCohortRevision;
  publicIds:string[];adapters:OwnedVectorAdapters;originals?:Record<string,OriginalVectorSource>}):Promise<DeliveryResult&{publicIds:string[]}>{
  return safe(async()=>{
    const {db,adapters,revision}=options,input=structuredClone(options.owner);
    let ids=[...options.publicIds];
    adapterScope(input,adapters);
    if(!adapters.dispatchBatch||!adapters.readbacks||ids.length<1||ids.length>8||new Set(ids).size!==ids.length
      ||input.phase!=='freezing')throw Error('vector_batch_invalid');
    const plan=prunedVectorPlan(revision),planHash=sha256(canonicalJson(plan));
    let keys=ids.map(publicId=>idFor(input,{kind:'prune',planHash,publicId}));
    if(ids.some(id=>!plan.products.some(p=>p.publicId===id)))throw Error('vector_batch_invalid');
    const existing=await journal(db,keys[0]);
    if(existing){
      const saved=decodeRequest(existing.request_json).batchIds;
      if(!saved?.length||canonicalJson(ids.slice(0,saved.length))!==canonicalJson(saved))throw Error('vector_batch_changed');
      ids=saved;keys=keys.slice(0,ids.length);
    }
    const load=async()=> (await db.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id IN(SELECT value FROM json_each(?))')
      .bind(JSON.stringify(keys)).all<Journal>()).results.sort((a,b)=>keys.indexOf(a.delivery_id)-keys.indexOf(b.delivery_id));
    const batchOwner=async(journals:Journal[])=>{
      const first=journals[0],base=JSON.parse(first.owner_json) as MutationOwner,actual=await readMutationOwner(db,input);
      const expected={...base,epoch:base.epoch+ids.length+(first.status==='complete'?1:0)};
      if(journals.length!==ids.length||canonicalJson({...input,epoch:base.epoch})!==canonicalJson(base)
        ||input.epoch!==base.epoch&&input.epoch!==expected.epoch&&!(first.status==='complete'&&input.epoch===expected.epoch-1)||canonicalJson(actual)!==canonicalJson(expected)
        ||journals.some((r,i)=>r.prior_epoch!==base.epoch+i||r.generation!==base.generation
          ||r.owner_json!==canonicalJson({...base,epoch:base.epoch+i})||r.status!==first.status))throw Error('vector_owner_changed');
      await db.batch([owned(db,expected,first.status==='pending')]);return expected;
    };
    const pending=async(journals:Journal[],errorCode:Code):Promise<DeliveryResult&{publicIds:string[]} >=>({deliveryId:journals[0].delivery_id,publicIds:ids,
      owner:await batchOwner(journals),state:'pending',errorCode});
    let rows=await load();
    if(!rows.length){
      const policy=await policyReceipt(db,input,revision,adapters.providerIdentity);
      if(!policy||ids.some(id=>policy.sources.some(s=>s.publicId===id)))throw Error('vector_batch_invalid');
      await db.batch(planChecks(db,input,revision));
      const prepared:Array<{product:Row;request:Request;requestBytes:string;productBytes:string}>=[];
      let wireBytes=0;
      for(const publicId of ids){
        const original=await approvedVectorOptions({...options,publicId,original:options.originals?.[publicId]});
        const p=await preparePruneRequest(original,true);
        if(!p.request.vector)throw Error('vector_batch_invalid');
        const request:Request={...p.request,providerIdentity:adapters.providerIdentity,batchIds:ids};
        const requestBytes=encodeRequest(request),productBytes=canonicalJson(p.product);
        // Include repeated CAS values, escaping and statement overhead. Stop at
        // the first row that won't fit; don't read/prove the unused tail again
        // on every batch. The final, shorter membership only reduces this size.
        wireBytes+=2*(Buffer.byteLength(JSON.stringify(productBytes))+Buffer.byteLength(JSON.stringify(requestBytes)))+16384;
        if(prepared.length&&wireBytes>480*1024)break;
        prepared.push({product:p.product,request,requestBytes,productBytes});
      }
      ids=ids.slice(0,prepared.length);keys=keys.slice(0,ids.length);
      for(const p of prepared){p.request.batchIds=ids;p.requestBytes=encodeRequest(p.request);}
      // Reserve one epoch per immutable member within ONE transaction. This
      // retains the existing unique generation/epoch identity and old readers.
      const token=randomUUID(),next={...input,epoch:input.epoch+ids.length},fence=gate(input,false);
      // The token is generated by this live caller before any provider call.
      // Exact readback can recover a lost intent ACK; a restarted caller has no
      // such token and can only observe, never resend an uncertain mutation.
      try{await db.batch([owned(db,input,false),...prepared.flatMap(p=>[productAssertion(db,p.product,p.request),...requestAssertions(db,p.request)]),
        ...prepared.map((p,i)=>db.prepare(`INSERT INTO catalog_vector_deliveries(delivery_id,environment,index_name,generation,prior_epoch,
          owner_json,request_json,product_json,dispatch_token,attempts) VALUES(?,?,?,?,?,?,?,?,?,1)`)
          .bind(keys[i],input.environment,input.indexName,input.generation,input.epoch+i,canonicalJson({...input,epoch:input.epoch+i}),p.requestBytes,p.productBytes,token)),
        db.prepare(`UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+?,external_pending=1 WHERE environment=? AND index_name=? AND ${fence.sql}`)
          .bind(ids.length,input.environment,input.indexName,...fence.params),owned(db,next,true)]);
      }catch{/* Recover only this live caller's exact unique intent below. */}
      rows=await load();
      if(rows.length!==ids.length||rows.some((r,i)=>r.request_json!==prepared[i].requestBytes||r.product_json!==prepared[i].productBytes||r.dispatch_token!==token))
        throw Error('vector_intent_unconfirmed');
      {
        await batchOwner(rows);
        let ack;
        try{ack=await bounded(signal=>adapters.dispatchBatch!(prepared.map((p,i)=>({deliveryId:keys[i],attempt:1,publicId:ids[i],vector:p.request.vector})),signal),30000,hasAccountedVectorTransport(adapters));}
        catch{return pending(rows,'mutation_unknown');}
        if(!ack||!REF.test(ack.reference))return pending(rows,'mutation_unknown');
        try{await db.batch([owned(db,next,true),...rows.map(r=>db.prepare(`UPDATE catalog_vector_deliveries SET mutation_reference=?
          WHERE delivery_id=? AND dispatch_token=? AND mutation_reference IS NULL`).bind(ack.reference,r.delivery_id,token)),
          assertion(db,`(SELECT count(*) FROM catalog_vector_deliveries WHERE delivery_id IN(SELECT value FROM json_each(?)) AND mutation_reference=? AND dispatch_token=?)=?`,
          [JSON.stringify(keys),ack.reference,token,ids.length]),owned(db,next,true)]);}catch{/* Exact readback retains any acknowledged batch. */}
        rows=await load();
      }
      return pending(rows,'mutation_unknown');
    }
    if(rows.length!==ids.length)throw Error('vector_batch_changed');
    const first=rows[0],owner=await batchOwner(rows),requests=rows.map(r=>decodeRequest(r.request_json));
    if(rows.some((r,i)=>r.status!==first.status||r.attempts!==1||r.dispatch_token!==first.dispatch_token
      ||!r.dispatch_token||r.mutation_reference!==first.mutation_reference||r.evidence_json!==first.evidence_json
      ||requests[i].kind!=='prune'||requests[i].providerIdentity!==adapters.providerIdentity||requests[i].publicId!==ids[i]
      ||requests[i].planSha256!==planHash||canonicalJson(requests[i].batchIds)!==canonicalJson(ids)||!requests[i].vector))throw Error('vector_batch_changed');
    if(first.status==='complete')return{deliveryId:first.delivery_id,publicIds:ids,owner,state:rows.every(r=>r.disposition==='verified')?'complete':'expired',errorCode:null};
    const checks=()=>[owned(db,owner,true),...rows.flatMap((r,i)=>[productAssertion(db,JSON.parse(r.product_json),requests[i],false),...requestAssertions(db,requests[i]),
      assertion(db,'EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND request_json=? AND product_json=? AND dispatch_token=? AND mutation_reference IS ? AND status=?)',
        [r.delivery_id,r.request_json,r.product_json,r.dispatch_token,r.mutation_reference,'pending'])])];
    await db.batch(checks());
    if(!first.mutation_reference)return pending(rows,'mutation_unknown');
    try{
      const settled=await bounded(signal=>adapters.resolve({deliveryId:first.delivery_id,attempt:1,reference:first.mutation_reference},signal),30000,hasAccountedVectorTransport(adapters));
      if(settled.state!=='settled')return pending(rows,'not_visible');
      if(settled.reference!==first.mutation_reference)throw Error('vector_resolution_invalid');
      for(let i=0;i<ids.length;i+=2){
        const actual=await bounded(signal=>adapters.readbacks!(ids.slice(i,i+2),signal),30000,hasAccountedVectorTransport(adapters));
        if(actual.length!==Math.min(2,ids.length-i)||actual.some((v,j)=>!visible(requests[i+j].vector,v)))return pending(rows,'not_visible');
      }
    }catch(error){if(error instanceof Error&&error.message==='vector_resolution_invalid')throw error;return pending(rows,'provider_failed');}
    const next={...owner,epoch:owner.epoch+1},fence=gate(owner,true),evidence=canonicalJson([{attempt:1,state:'settled_visible',reference:first.mutation_reference}]);
    try{await db.batch([...checks(),...rows.map((r,i)=>db.prepare(`UPDATE catalog_vector_deliveries SET status='complete',completed_at=${NOW},evidence_json=?,
      disposition=CASE WHEN ?<=${NOW} THEN 'expired' ELSE 'verified' END WHERE delivery_id=? AND status='pending' AND dispatch_token=?`)
        .bind(evidence,requests[i].eligibleUntil,r.delivery_id,first.dispatch_token)),
      assertion(db,`(SELECT count(*) FROM catalog_vector_deliveries WHERE delivery_id IN(SELECT value FROM json_each(?)) AND status='complete' AND evidence_json=?)=?`,[JSON.stringify(keys),evidence,ids.length]),
      db.prepare(`UPDATE catalog_mutation_scopes SET external_pending=0,mutation_epoch=mutation_epoch+1 WHERE environment=? AND index_name=? AND ${fence.sql}`)
        .bind(owner.environment,owner.indexName,...fence.params),owned(db,next,false)]);}catch{/* Read back the exact atomic completion. */}
    rows=await load();const actualOwner=await batchOwner(rows);
    return{deliveryId:first.delivery_id,publicIds:ids,owner:actualOwner,state:rows.every(r=>r.status==='complete')?(rows.every(r=>r.disposition==='verified')?'complete':'expired'):'pending',errorCode:rows.every(r=>r.status==='complete')?null:'not_visible'};
  });
}
interface ReuseRequest {
  schemaVersion:1; kind:'approved-cohort-reuse'; catalogRevision:string; providerIdentity:string;
  plan:PrunedVectorPlan; planSha256:string; projectionReceipt:Row; approval:ApprovedCohortEnvelope; approvalSha256:string;
  revisionSha256:string; sourceRowsSha256:string; sources:ReusedSource[];
  ownerBaseReview?:OwnerBaseCatalogReview;
  automation?:AutomationCohortAuthority;
  /** Bulk owner reviews have no current native members. Retain the full
   * approval's hash/count, not a370KB duplicate of its product row hashes. */
  ownerBaseApprovalCount?:number;
}
const REUSE_KIND='approved-cohort-reuse';
function reuseIds(plan:PrunedVectorPlan) { return [...plan.products.map(p=>p.publicId),...plan.absentIds]; }
/** Read the actual immutable source receipts in ONE bounded query. In particular,
 * neither a present vector nor a caller-supplied mutation reference is settlement.
 * The maintenance run remains approval.runId, independently of the publisher run.
 */
async function reuseSources(db:CatalogD1,approval:ApprovedCohortEnvelope,signal?:AbortSignal,paged=false,automation?:AutomationCohortAuthority) {
  signal?.throwIfAborted();
  if(automation&&!automationContains(automation,approval.changes.map(c=>c.publicId)))throw Error('vector_reuse_source_changed');
  const select=`SELECT o.*,p.operation_id,p.payload_json,m.input_sha256,m.run_id,m.catalog_revision maintenance_revision,
    m.environment maintenance_environment,m.index_name maintenance_index,m.changes_json,
    d.delivery_id,d.environment delivery_environment,d.index_name delivery_index,d.generation delivery_generation,d.prior_epoch,
    d.owner_json,d.request_json,d.product_json,d.status delivery_status,d.disposition,d.attempts delivery_attempts,
    d.dispatch_token,d.mutation_reference delivery_reference,d.evidence_json,d.completed_at delivery_completed_at,
    v.mutation_json review_json FROM json_each(?) a CROSS JOIN catalog_maintenance_vector_payloads p
    ON p.operation_id=json_extract(a.value,'$.operationId') CROSS JOIN vector_sync_outbox o ON o.sequence=p.sequence
    AND o.public_id=json_extract(a.value,'$.publicId')
    JOIN catalog_maintenance_operations m ON m.operation_id=p.operation_id
    LEFT JOIN catalog_vector_deliveries d ON d.delivery_id=o.lease_token
    LEFT JOIN vector_delete_mutations v ON v.mutation_sha256=o.delete_mutation_sha256
    AND v.public_id=o.public_id AND v.source_revision=o.source_revision`;
  if(!paged)return(await db.prepare(`${select} LIMIT 21`).bind(JSON.stringify(approval.changes)).all<Row>({signal})).results;
  const columns=['sequence','public_id','source_revision','embedding_text_hash','operation','status','attempts','created_at','completed_at',
    'lease_token','lease_until','mutation_reference','error_code','delete_mutation_sha256','operation_id','payload_json','input_sha256','run_id',
    'maintenance_revision','maintenance_environment','maintenance_index','changes_json','delivery_id','delivery_environment','delivery_index',
    'delivery_generation','prior_epoch','owner_json','request_json','product_json','delivery_status','disposition','delivery_attempts',
    'dispatch_token','delivery_reference','evidence_json','delivery_completed_at','review_json'];
  const rows:Row[]=[];let after='';
  const limit=automation?approval.changes.length:30;
  for(let page=0;page<=limit;page++){
    signal?.throwIfAborted();
    const found=(await db.prepare(`SELECT data FROM (WITH source AS (${select}), encoded AS(SELECT public_id,
      json_object(${columns.map(k=>`'${k}',r.${k}`).join(',')}) data FROM source r WHERE public_id>?),
      sized AS(SELECT *,row_number() OVER(ORDER BY public_id) ordinal,
        sum(length(CAST(json_object('data',data||'') AS BLOB))) OVER(ORDER BY public_id) bytes FROM encoded)
      SELECT public_id,CASE WHEN bytes>384*1024 THEN NULL ELSE data END data FROM sized WHERE bytes<=384*1024 OR ordinal=1) ORDER BY public_id`)
      .bind(JSON.stringify(approval.changes),after).all<{data:string}>({signal})).results;
    if(!found.length)return rows;
    if(found.some(r=>typeof r.data!=='string')||Buffer.byteLength(JSON.stringify(found))>384*1024)throw new Error('vector_payload_bound');
    const decoded=found.map(r=>JSON.parse(r.data) as Row);
    if(decoded.some(r=>typeof r.public_id!=='string'||String(r.public_id)<=after)||rows.length+decoded.length>limit)throw new Error('vector_reuse_source_changed');
    rows.push(...decoded);after=String(rows.at(-1)!.public_id);
  }
  throw new Error('vector_payload_bound');
}
function reuseVectors(owner:MutationOwner,request:ReuseRequest,rows:Row[],allowUnsupported=false):Map<string,SyncVector|null> {
  const ids=reuseIds(request.plan),vectors=new Map<string,SyncVector|null>();
  let unsupported=false;
  if(rows.length!==ids.length||request.sources.length!==ids.length)throw new Error('vector_reuse_source_changed');
  for(const publicId of ids){
    const change=request.approval.changes.find(c=>c.publicId===publicId),link=request.sources.find(s=>s.publicId===publicId);
    const matches=rows.filter(r=>r.public_id===publicId),row=matches[0];
    if(!change||!link||matches.length!==1||link.operationId!==change.operationId||row.operation_id!==change.operationId
      ||row.sequence!==link.sequence||row.delivery_id!==link.deliveryId||row.delivery_reference!==link.reference
      ||sha256(canonicalJson(row))!==link.sha256||row.input_sha256!==change.inputSha256
      ||row.run_id!==request.approval.runId||row.maintenance_revision!==request.catalogRevision
      ||row.maintenance_environment!==owner.environment||row.maintenance_index!==owner.indexName
      ||row.source_revision!==request.catalogRevision||row.status!=='complete'||row.delivery_status!=='complete'||row.disposition!=='verified'
      ||row.delivery_environment!==owner.environment||row.delivery_index!==owner.indexName
      ||!Number.isSafeInteger(row.delivery_attempts)||Number(row.delivery_attempts)<0||Number(row.delivery_attempts)>3
      ||row.attempts!==row.delivery_attempts||row.mutation_reference!==row.delivery_reference
      ||row.lease_token!==row.delivery_id||!Number.isFinite(Date.parse(String(row.delivery_completed_at)))
      ||!Number.isFinite(Date.parse(String(row.completed_at))))throw new Error('vector_reuse_source_changed');
    const product=JSON.parse(String(row.product_json)) as Row,source=decodeRequest(String(row.request_json));
    const base=JSON.parse(String(row.owner_json)) as MutationOwner,evidence=JSON.parse(String(row.evidence_json));
    const last=Array.isArray(evidence)&&evidence.at(-1),event=source.event;
    const processed=Number(row.delivery_attempts)>0&&typeof row.dispatch_token==='string'&&REF.test(row.dispatch_token)
      &&typeof row.delivery_reference==='string'&&REF.test(row.delivery_reference)&&last?.state==='settled_visible';
    const alreadyVisible=row.delivery_attempts===0&&row.dispatch_token===null&&row.delivery_reference===null&&last?.state==='already_visible';
    if(base.phase!=='writing'||base.environment!==owner.environment||base.indexName!==owner.indexName
      ||base.generation!==row.delivery_generation||base.epoch!==row.prior_epoch||base.generation>=owner.generation
      ||idFor(base,{kind:'outbox',sequence:row.sequence,catalogRevision:request.catalogRevision})!==row.delivery_id
      ||!last||!processed&&!alreadyVisible||last.attempt!==row.delivery_attempts||last.reference!==row.delivery_reference
      ||sha256(canonicalJson(product))!==change.productSha256||product.public_id!==publicId
      ||product.catalog_revision!==request.catalogRevision||sha256(String(product.public_display_json??'null'))!==change.displaySha256
      ||!JSON.parse(String(row.changes_json)).some((c:Row)=>c.productId===product.id&&c.afterSha256===change.productSha256)
      ||source.kind!=='outbox'||source.providerIdentity!==request.providerIdentity||source.publicId!==publicId
      ||source.catalogRevision!==request.catalogRevision||!event||event.sequence!==row.sequence||event.publicId!==publicId
      ||event.catalogRevision!==request.catalogRevision||event.operation!==row.operation||event.embeddingTextHash!==row.embedding_text_hash
      ||(event.deleteMutationSha256??null)!==row.delete_mutation_sha256)throw new Error('vector_reuse_source_changed');
    const payload=JSON.parse(String(row.payload_json));
    if(payload.operation==='upsert'&&Object.hasOwn(payload,'nativeBase64')){
      if(Object.hasOwn(payload,'values')||typeof payload.nativeBase64!=='string')throw new Error('vector_reuse_source_changed');
      payload.values=decodePgvectorSendBase64(payload.nativeBase64);delete payload.nativeBase64;
    }
    const vector=payloadVector(event,payload,product,row.review_json===null?undefined:String(row.review_json),Date.parse(String(row.delivery_completed_at)));
    const member=request.plan.products.find(p=>p.publicId===publicId);
    if(sha256(canonicalJson(payload))!==source.payloadSha256||!visible(vector,source.vector)
      ||vector&&(source.eligibleUntil!==product.eligible_until||source.eligibleUntil!==JSON.parse(String(product.public_display_json)).eligibleUntil
        ||vector.metadata.catalogRevision!==request.plan.catalogRevision||vector.metadata.embeddingModel!=='text-embedding-3-small'
        ||source.eligibleUntil===null||!Number.isFinite(Date.parse(source.eligibleUntil))
        ||Date.parse(source.eligibleUntil)<=Date.parse(String(row.delivery_completed_at)))
      ||member&&vector&&(member.sourceFactsHash!==vector.metadata.sourceFactsHash||member.embeddingTextHash!==vector.metadata.embeddingTextHash))
      throw new Error('vector_reuse_source_changed');
    if(!processed||(member?!vector:vector!==null||!request.plan.absentIds.includes(publicId)))unsupported=true;
    vectors.set(publicId,vector);
  }
  if(unsupported)throw new Error(allowUnsupported?'vector_reuse_unsupported':'vector_reuse_source_changed');
  return vectors;
}
function reuseControl(request:ReuseRequest){return canonicalJson({schemaVersion:1,kind:'approved-cohort-reuse-control',revisionSha256:request.revisionSha256});}
function reuseEvidence(request:ReuseRequest){return canonicalJson([{state:'verification_only',sources:request.sources.map(s=>({deliveryId:s.deliveryId,reference:s.reference}))}]);}
function validateReuse(row:Journal,owner:MutationOwner,plan:PrunedVectorPlan|ActivatedVectorPlan,providerIdentity:string):ReuseRequest {
  const request=JSON.parse(row.request_json) as ReuseRequest,base=JSON.parse(row.owner_json) as MutationOwner;
  const planHash='planSha256' in plan?plan.planSha256:sha256(canonicalJson(plan));
  const ids='ids' in plan?plan.ids:reuseIds(plan);
  if(request.schemaVersion!==1||request.kind!==REUSE_KIND||request.catalogRevision!==plan.catalogRevision
    ||request.planSha256!==planHash||sha256(canonicalJson(request.plan))!==planHash||request.providerIdentity!==providerIdentity
    ||request.plan.environment!==owner.environment||request.plan.indexName!==owner.indexName
    ||ids.length<1||ids.length>10||new Set(ids).size!==ids.length||canonicalJson([...ids].sort())!==canonicalJson(reuseIds(request.plan).sort())
    ||request.approval.catalogRevision!==plan.catalogRevision||request.approval.schemaVersion!==1
    ||sha256(canonicalJson(request.approval))!==request.approvalSha256||!HASH.test(request.revisionSha256)||!HASH.test(request.sourceRowsSha256)
    ||request.sources.length!==ids.length||new Set(request.sources.map(s=>s.publicId)).size!==ids.length
    ||request.sources.some(s=>!ids.includes(s.publicId)||!HASH.test(s.sha256)||!HASH.test(s.deliveryId)||typeof s.reference!=='string'||!REF.test(s.reference))
    ||base.phase!=='freezing'||canonicalJson({...owner,phase:'freezing',epoch:base.epoch})!==canonicalJson(base)
    ||owner.epoch<base.epoch+1||row.generation!==base.generation||row.prior_epoch!==base.epoch
    ||row.delivery_id!==idFor(base,{kind:REUSE_KIND,planHash})||row.status!=='complete'||row.disposition!=='verified'
    ||row.attempts!==0||row.dispatch_token!==null||row.mutation_reference!==null
    ||row.product_json!==reuseControl(request)||row.evidence_json!==reuseEvidence(request))throw new Error('vector_reuse_invalid');
  return request;
}
function reuseSourceAssertions(db:CatalogD1,rows:Row[]) {
  // Completed journals and payload/operation identities are immutable. Bind the
  // remaining mutable outbox fields, rather than trusting their earlier hash.
  const columns=['sequence','public_id','source_revision','embedding_text_hash','operation','delete_mutation_sha256',
    'status','attempts','lease_token','lease_until','mutation_reference','error_code','created_at','completed_at'];
  return assertion(db,`(SELECT count(*) FROM json_each(?) e JOIN vector_sync_outbox o
    ON o.sequence=json_extract(e.value,'$.sequence') WHERE ${columns.map(k=>`o.${k} IS json_extract(e.value,'$.${k}')`).join(' AND ')})=?`,
  [JSON.stringify(rows.map(row=>Object.fromEntries(columns.map(k=>[k,row[k]])))),rows.length]);
}
/** New opt-in full-plan receipt. Historical reuse/prune request bytes and IDs
 * are unchanged. This attests policy + ONLY the listed genuine source proofs;
 * it never pretends that remaining promotions/deletions were dispatched. */
const PLAN_KIND='approved-cohort-plan';
interface CohortPlanRequest extends Omit<ReuseRequest,'kind'> { kind:typeof PLAN_KIND }
function planControl(request:CohortPlanRequest){return canonicalJson({schemaVersion:1,kind:PLAN_KIND,revisionSha256:request.revisionSha256,
  ...(request.automation?{automationSha256:sha256(canonicalJson(request.automation))}:{}),
  ...(request.ownerBaseReview?{compactApprovalSha256:sha256(canonicalJson(request.approval)),
    ownerBaseReviewSha256:sha256(canonicalJson(request.ownerBaseReview)),ownerBaseApprovalCount:request.ownerBaseApprovalCount}:{})});}
function planEvidence(request:CohortPlanRequest){return canonicalJson([{state:'policy_and_source_verification',
  sources:request.sources.map(s=>({deliveryId:s.deliveryId,reference:s.reference}))}]);}
function sourceSubset(request:CohortPlanRequest):ReuseRequest {
  const ids=new Set(request.sources.map(s=>s.publicId));
  return {...request,kind:REUSE_KIND,plan:{...request.plan,products:request.plan.products.filter(p=>ids.has(p.publicId)),
    absentIds:request.plan.absentIds.filter(id=>ids.has(id))}};
}
function validatePlan(row:Journal,owner:MutationOwner,plan:PrunedVectorPlan|ActivatedVectorPlan,providerIdentity:string,revision?:ApprovedCohortRevision){
  const request=JSON.parse(row.request_json) as CohortPlanRequest,base=JSON.parse(row.owner_json) as MutationOwner;
  if(request.automation){if(request.ownerBaseReview)throw Error('vector_plan_receipt_invalid');validateAutomationCohort(request.automation,request.approval);}
  validateNativeHistory(request.plan?.history??[],request.plan?reuseIds(request.plan):[]);
  const ids='ids' in plan?plan.ids:prunedVectorIds(plan),hash='planSha256' in plan?plan.planSha256:sha256(canonicalJson(plan));
  if(request.schemaVersion!==1||request.kind!==PLAN_KIND||request.catalogRevision!==plan.catalogRevision
    ||request.planSha256!==hash||sha256(canonicalJson(request.plan))!==hash||request.providerIdentity!==providerIdentity
    ||request.plan.environment!==owner.environment||request.plan.indexName!==owner.indexName
    ||ids.length>SNAPSHOT_READ_LIMITS.identities||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id))
    ||canonicalJson([...ids].sort())!==canonicalJson(prunedVectorIds(request.plan).sort())
    ||!request.approval||Object.keys(request.approval).sort().join(',')!=='catalogRevision,changes,runId,schemaVersion'
    ||request.approval.schemaVersion!==1||!Array.isArray(request.approval.changes)
    // Publication-only recovery retains the original ingestion approval. A
    // split revision never grants native work; the immutable policy binds the
    // complete independently verified revision, including its explicit target.
    ||request.approval.catalogRevision!==plan.catalogRevision&&(reuseIds(request.plan).length!==0||request.sources.length!==0
      ||revision&&(revision.request.publicationRevision!==plan.catalogRevision
        ||canonicalJson(request.approval)!==canonicalJson(revision.request.approval)))
    ||(request.ownerBaseReview ? request.approval.changes.length!==0||!Number.isSafeInteger(request.ownerBaseApprovalCount)
      ||request.ownerBaseApprovalCount!<0||request.ownerBaseApprovalCount!>approvedBaseChangeLimit(request.ownerBaseReview)
      :!request.automation&&request.approval.changes.length>30||sha256(canonicalJson(request.approval))!==request.approvalSha256)
    ||!HASH.test(request.approvalSha256)||!HASH.test(request.revisionSha256)||!HASH.test(request.sourceRowsSha256)
    ||!request.automation&&request.sources.length>30||new Set(request.sources.map(s=>s.publicId)).size!==request.sources.length
    ||request.sources.some(s=>!ids.includes(s.publicId)||!request.approval.changes.some(c=>c.publicId===s.publicId)
      ||!HASH.test(s.sha256)||!HASH.test(s.deliveryId)||typeof s.reference!=='string'||!REF.test(s.reference))
    ||base.phase!=='freezing'||canonicalJson({...owner,phase:'freezing',epoch:base.epoch})!==canonicalJson(base)
    ||owner.epoch<base.epoch+1||row.generation!==base.generation||row.prior_epoch!==base.epoch
    ||row.delivery_id!==idFor(base,{kind:PLAN_KIND})||row.status!=='complete'||row.disposition!=='verified'
    ||row.attempts!==0||row.dispatch_token!==null||row.mutation_reference!==null
    ||row.product_json!==planControl(request)||row.evidence_json!==planEvidence(request)
    ||request.ownerBaseReview&&(request.sources.length!==0||request.plan.products.length!==0||request.plan.absentIds.length!==0)
    ||revision&&(request.revisionSha256!==sha256(canonicalJson(revision))||request.sourceRowsSha256!==sha256(canonicalJson(revision.sourceRows))
      ||canonicalJson(request.ownerBaseReview??null)!==canonicalJson(revision.request.ownerBaseReview??null)
      ||canonicalJson(request.automation??null)!==canonicalJson(revision.request.automation??null)
      ||request.ownerBaseReview&&(request.approvalSha256!==revision.request.approvalSha256
        ||request.ownerBaseApprovalCount!==revision.request.approval.changes.length
        ||canonicalJson(request.approval)!==canonicalJson({...revision.request.approval,changes:[]}))))
    throw new Error('vector_plan_receipt_invalid');
  return request;
}
async function policyReceipt(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision,providerIdentity:string){
  const row=await journal(db,idFor(owner,{kind:PLAN_KIND}));
  if(!row)return null;
  return validatePlan(row,owner,prunedVectorPlan(revision),providerIdentity,revision);
}
function planChecks(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision){
  const receipt=revision.packet.receipt,prior=revision.priorRow;
  const rc=['catalog_revision','snapshot_sha256','projection_sha256','source_export_sha256','product_count','created_at'];
  const pc=['release_id','catalog_revision','code_sha','completed_at','manifest_json'];
  return[mutationAssertion(db,owner,['freezing']),assertion(db,`EXISTS(SELECT 1 FROM catalog_projection_receipts WHERE ${rc.map(k=>`${k} IS ?`).join(' AND ')})
    AND EXISTS(SELECT 1 FROM catalog_revisions WHERE revision=? AND source_export_sha256=? AND status IN('importing','reconciled') AND abandonment_delivery_id IS NULL)
    AND (SELECT coalesce(max(rowid),0) FROM publication_receipts)=? AND (? IS NULL OR EXISTS(SELECT 1 FROM publication_receipts WHERE ${pc.map(k=>`${k} IS ?`).join(' AND ')}))
    AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox)=? AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete') AND (? OR ?>${NOW})`,
    [...rc.map(k=>receipt[k]),revision.snapshot.catalogRevision,revision.sourceDigest,revision.request.context.publicationReceiptWatermark,
      revision.request.context.priorPublication?.releaseId??null,...pc.map(k=>prior[k]),revision.globalVectorWatermark,permanentCapturedRevision(revision)?1:0,revision.request.context.cutoff])];
}
export {planChecks as approvedCatalogPlanChecks};
async function assertPlanSource(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision){
  if(revision.persistent)await (await import('./permanent-catalog-seal.ts')).assertApprovedCatalogInventory(db,owner,revision);
  await assertPruningCurrent(db,owner,revision.sourceRows);
  const rows=await readOwnedProjection(db,owner,revision.snapshot.catalogRevision,revision.packet.rows.map(r=>String(r.public_id)).sort());
  if(canonicalJson(rows)!==canonicalJson(revision.packet.rows))throw new Error('vector_prune_changed');
  await db.batch(planChecks(db,owner,revision));
}
/** The ONLY constructor of the new policy receipt independently executes the
 * complete approved policy once. Full source/projection reads are streamed under
 * the exclusive fence; the compact final transaction retains prior/cutoff/CAS.
 * Return every remaining ID; callers must not silently skip ordinary work. */
export function prepareOwnedApprovedCohortPlan(options:{db:CatalogD1;owner:MutationOwner;request:ApprovedCohortRequest;
  adapters:Pick<OwnedVectorAdapters,'readback'|'readbacks'|'environment'|'indexName'|'providerIdentity'>;timeoutMs?:number;
  beforeSeal?:(owner:MutationOwner,revision:ApprovedCohortRevision)=>Promise<void>;
  sealed?:{owner:MutationOwner;revision:ApprovedCohortRevision}}){
  return safe(async()=>{
    const {db,adapters}=options;let owner=structuredClone(options.owner);adapterScope(owner,adapters);
    if(owner.phase!=='freezing')throw new Error('vector_plan_invalid');
    const id=idFor(owner,{kind:PLAN_KIND}),saved=await journal(db,id);
    if(saved){const base=JSON.parse(saved.owner_json) as MutationOwner,actual=await readMutationOwner(db,owner);
      if(!actual||canonicalJson({...owner,epoch:base.epoch})!==canonicalJson(base)
        ||owner.epoch!==actual.epoch&&!(actual.epoch===base.epoch+1&&[base.epoch-1,base.epoch].includes(owner.epoch)))throw new Error('vector_owner_changed');
      owner=actual;}
    // A committed zero-effect policy already attests the exact full revision.
    // Resume its pinned candidate with fresh complete source/projection checks,
    // not another policy reconstruction and staging pass.
    if(saved&&options.sealed){
      const revision=structuredClone(options.sealed.revision),plan=prunedVectorPlan(revision);
      if(canonicalJson(revision.request)!==canonicalJson(options.request)||revision.operationKey!==owner.operationKey)
        throw Error('vector_owner_changed');
      if(reuseIds(plan).length===0){
        const request=validatePlan(saved,owner,plan,adapters.providerIdentity,revision);
        await assertPlanSource(db,owner,revision);
        return{state:revision.snapshot.products.length?'prepared' as const:'all_held' as const,
          owner,revision,reusedIds:request.sources.map(s=>s.publicId),remainingIds:[]};
      }
    }
    // The projection seal can commit before the policy journal exists. Only a
    // pre-dispatch saved full revision plus its exact seal/current/prior proof
    // may recover that single epoch; an arbitrary live cursor is not authority.
    if(!saved&&options.sealed){
      const intent=options.sealed,actual=await readMutationOwner(db,owner),next={...intent.owner,epoch:intent.owner.epoch+1};
      if(canonicalJson(intent.revision.request)!==canonicalJson(options.request)||intent.revision.operationKey!==owner.operationKey
        ||canonicalJson({...owner,epoch:intent.owner.epoch})!==canonicalJson(intent.owner))throw Error('vector_owner_changed');
      if(canonicalJson(actual)===canonicalJson(next)){
        await assertPlanSource(db,next,intent.revision);owner=next;
      }else if(canonicalJson(actual)!==canonicalJson(owner))throw Error('vector_owner_changed');
    }
    const prepared=await prepareApprovedCohort(db,owner,options.request,options.beforeSeal);owner=prepared.owner;
    const revision=prepared.revision,plan=prunedVectorPlan(revision),ids=reuseIds(plan);
    if(ids.length>SNAPSHOT_READ_LIMITS.identities||options.request.publicationRevision&&ids.length)
      throw new Error('vector_plan_invalid');
    let request:CohortPlanRequest;
    if(saved)request=validatePlan(saved,owner,plan,adapters.providerIdentity,revision);
    else{
      if(revision.request.ownerBaseReview&&ids.length)throw Error('vector_owner_base_native_work_forbidden');
      const candidates=revision.request.ownerBaseReview?[]:await reuseSources(db,revision.request.approval,undefined,true,revision.request.automation);
      request={schemaVersion:1,kind:PLAN_KIND,catalogRevision:plan.catalogRevision,providerIdentity:adapters.providerIdentity,
        plan,planSha256:sha256(canonicalJson(plan)),projectionReceipt:revision.packet.receipt,
        approval:revision.request.ownerBaseReview?{...revision.request.approval,changes:[]}:revision.request.approval,
        approvalSha256:revision.request.approvalSha256,revisionSha256:sha256(canonicalJson(revision)),sourceRowsSha256:sha256(canonicalJson(revision.sourceRows)),sources:[],
        ...(revision.request.ownerBaseReview?{ownerBaseReview:revision.request.ownerBaseReview,ownerBaseApprovalCount:revision.request.approval.changes.length}:{})};
      if(revision.request.automation)request.automation=revision.request.automation;
      const vectors=new Map<string,SyncVector|null>();
      for(const change of request.approval.changes){
        if(!ids.includes(change.publicId))continue; // A cleared listing is not a semantic/native member.
        const rows=candidates.filter(r=>r.public_id===change.publicId);if(!rows.length)continue;
        if(rows.length!==1)throw new Error('vector_reuse_source_changed');const row=rows[0];
        const link:ReusedSource={publicId:change.publicId,operationId:change.operationId,sequence:Number(row.sequence),deliveryId:String(row.delivery_id),
          reference:row.delivery_reference===null?null:String(row.delivery_reference),sha256:sha256(canonicalJson(row))};
        try{const found=reuseVectors(owner,sourceSubset({...request,sources:[link]}),rows,true);
          request.sources.push(link);for(const entry of found)vectors.set(...entry);}
        catch(error){if(!(error instanceof Error)||error.message!=='vector_reuse_unsupported')throw error;}
      }
      const bytes=canonicalJson(request);if(Buffer.byteLength(bytes)>200000)throw new Error('vector_payload_bound');
      const reusedRows=candidates.filter(r=>request.sources.some(s=>s.publicId===r.public_id));
      await assertPlanSource(db,owner,revision);await reuseReadback(adapters,vectors,timeoutOf(options.timeoutMs));
      await readNativeHistory({db,owner,history:plan.history??[],adapters,acceptedOnly:Boolean(revision.persistent)});
      await assertPlanSource(db,owner,revision);
      const next={...owner,epoch:owner.epoch+1};
      try{await db.batch([...planChecks(db,owner,revision),reuseSourceAssertions(db,reusedRows),
        db.prepare(`INSERT INTO catalog_vector_deliveries(delivery_id,environment,index_name,generation,prior_epoch,owner_json,request_json,product_json,status,disposition,evidence_json,completed_at)
          VALUES(?,?,?,?,?,?,?,?,'complete','verified',?,${NOW})`).bind(id,owner.environment,owner.indexName,owner.generation,owner.epoch,
          canonicalJson(owner),bytes,planControl(request),planEvidence(request)),
        mutationAdvance(db,owner,{sql:"SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND request_json=? AND status='complete'",params:[id,bytes]}),
        mutationAssertion(db,next,['freezing'])]);}catch{/* Only exact committed receipt/epoch recovers a lost acknowledgement. */}
      const stored=await journal(db,id),actual=await readMutationOwner(db,owner);
      if(!stored||stored.request_json!==bytes||!actual||canonicalJson(actual)!==canonicalJson(next))throw new Error('vector_plan_unconfirmed');
      validatePlan(stored,actual,plan,adapters.providerIdentity,revision);owner=actual;
    }
    const reusedIds=request.sources.map(s=>s.publicId);
    return{...prepared,owner,reusedIds,remainingIds:ids.filter(id=>!reusedIds.includes(id))};
  });
}
async function reuseReadback(adapters:Pick<OwnedVectorAdapters,'readback'|'readbacks'>,vectors:Map<string,SyncVector|null>,timeout=3000,signal?:AbortSignal){
  signal?.throwIfAborted();const controller=new AbortController();let rejectAbort:(error:Error)=>void=()=>{};
  const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
  const abort=(error=new Error('vector_provider_timeout'))=>{controller.abort();rejectAbort(error);};
  const cancel=()=>abort();signal?.addEventListener('abort',cancel,{once:true});
  const timer=hasAccountedVectorReadback(adapters)?undefined:setTimeout(cancel,timeout);
  const pending=(async()=>{const entries=[...vectors];
    const size=adapters.readbacks?8:1,windowSize=adapters.readbacks?40:10;
    for(let offset=0;offset<entries.length;offset+=windowSize){controller.signal.throwIfAborted();
      const groups:Array<Array<[string,SyncVector|null]>>=[];
      const window=entries.slice(offset,offset+windowSize);
      for(let i=0;i<window.length;i+=size)groups.push(window.slice(i,i+size));
      const results=await Promise.allSettled(groups.map(async group=>{
        try{controller.signal.throwIfAborted();const actual=adapters.readbacks?await adapters.readbacks(group.map(([id])=>id),controller.signal)
          :[await adapters.readback(group[0][0],controller.signal)];
          if(actual.length!==group.length||group.some(([,vector],i)=>!visible(vector,actual[i])))throw new Error('vector_not_visible');}
        catch(error){abort(error instanceof Error?error:new Error('vector_not_visible'));throw error;}
      }));controller.signal.throwIfAborted();
      if(results.some(result=>result.status==='rejected'))throw new Error('vector_not_visible');
    }
  })();
  try{await Promise.race([pending,aborted]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);controller.abort();
    if(hasAccountedVectorReadback(adapters))await pending.catch(()=>{});else await drainDeploymentObservation(pending);}
}
/** Optional whole-cohort optimization, never a substitute for an uncertain
 * source dispatch. Every ID must have an explicitly approved SAME-revision
 * genuine settled source operation. Unsupported shapes keep the ordinary path.
 * The receipt truthfully records verification only: zero attempts, no dispatch
 * token/reference, no external_pending transition, and one fenced epoch advance.
 */
export function reuseOwnedApprovedCohortVectorProof(options:{db:CatalogD1;owner:MutationOwner;revision:ApprovedCohortRevision;
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>;timeoutMs?:number}):Promise<
  {state:'unsupported';owner:MutationOwner}|{state:'complete';owner:MutationOwner;deliveryId:string}> {
  return safe(async()=>{
    const {db,adapters}=options,revision=structuredClone(options.revision);let owner=structuredClone(options.owner);
    adapterScope(owner,adapters);if(owner.phase!=='freezing')throw new Error('vector_plan_invalid');
    const plan=prunedVectorPlan(revision),ids=reuseIds(plan),planHash=sha256(canonicalJson(plan));
    if(!ids.length||ids.length>10||ids.some(id=>!revision.request.approval.changes.some(c=>c.publicId===id))){
      await db.batch([mutationAssertion(db,owner,['freezing'])]);return{state:'unsupported',owner};}
    const id=idFor(owner,{kind:REUSE_KIND,planHash});let saved=await journal(db,id);
    if(saved){
      const base=JSON.parse(saved.owner_json) as MutationOwner,actual=await readMutationOwner(db,owner);
      if(!actual||canonicalJson({...owner,epoch:base.epoch})!==canonicalJson(base)
        ||owner.epoch!==base.epoch&&owner.epoch!==actual.epoch||actual.epoch!==base.epoch+1)throw new Error('vector_owner_changed');
      owner=actual;const request=validateReuse(saved,owner,plan,adapters.providerIdentity);
      if(request.revisionSha256!==sha256(canonicalJson(revision)))throw new Error('vector_reuse_source_changed');
      await readReuseVectors(db,owner,saved,plan,adapters,revision);return{state:'complete',owner,deliveryId:id};
    }
    await db.batch([mutationAssertion(db,owner,['freezing'])]);
    const rebuilt=await prepareApprovedCohort(db,owner,revision.request);
    if(canonicalJson(rebuilt.revision)!==canonicalJson(revision)||canonicalJson(rebuilt.owner)!==canonicalJson(owner))throw new Error('vector_prune_changed');
    const rows=await reuseSources(db,{...revision.request.approval,changes:revision.request.approval.changes.filter(c=>ids.includes(c.publicId))});
    const request:ReuseRequest={schemaVersion:1,kind:REUSE_KIND,catalogRevision:plan.catalogRevision,providerIdentity:adapters.providerIdentity,
      plan,planSha256:planHash,projectionReceipt:revision.packet.receipt,approval:revision.request.approval,
      approvalSha256:revision.request.approvalSha256,revisionSha256:sha256(canonicalJson(revision)),sourceRowsSha256:sha256(canonicalJson(revision.sourceRows)),
      sources:rows.map(r=>({publicId:String(r.public_id),operationId:String(r.operation_id),sequence:Number(r.sequence),
        deliveryId:String(r.delivery_id),reference:r.delivery_reference===null?null:String(r.delivery_reference),sha256:sha256(canonicalJson(r))}))};
    let vectors:Map<string,SyncVector|null>;
    try{vectors=reuseVectors(owner,request,rows,true);}catch(error){
      // A policy-held upsert needs a real DELETE. A truthful already-visible
      // completion has no processed dispatch to reuse. Only these fully checked
      // source classes fall back; malformed/unknown partial matches fail closed.
      if(error instanceof Error&&error.message==='vector_reuse_unsupported')return{state:'unsupported',owner};throw error;}
    const receiptColumns=['catalog_revision','snapshot_sha256','projection_sha256','source_export_sha256','product_count','created_at'];
    const priorColumns=['release_id','catalog_revision','code_sha','completed_at','manifest_json'];
    const projectionColumns=Object.keys(revision.packet.rows[0]??{});
    const checks=()=>[mutationAssertion(db,owner,['freezing']),
      ...pruningCurrentQueries(revision.sourceRows).map(q=>assertion(db,`(${q.sql})=?`,[...q.params,q.count])),
      reuseSourceAssertions(db,rows),assertion(db,`(SELECT coalesce(max(rowid),0) FROM publication_receipts)=?
        AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox)=? AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete')
        AND (? IS NULL OR EXISTS(SELECT 1 FROM publication_receipts WHERE ${priorColumns.map(k=>`${k} IS ?`).join(' AND ')}))
        AND EXISTS(SELECT 1 FROM catalog_projection_receipts WHERE ${receiptColumns.map(k=>`${k} IS ?`).join(' AND ')})
        AND EXISTS(SELECT 1 FROM catalog_revisions WHERE revision=? AND source_export_sha256=? AND status IN('importing','reconciled')
          AND abandonment_delivery_id IS NULL)
        AND (SELECT count(*) FROM catalog_public_products WHERE catalog_revision=?)=?
        ${projectionColumns.length?`AND (SELECT count(*) FROM json_each(?) e JOIN catalog_public_products p
          ON p.public_id=json_extract(e.value,'$.public_id') AND p.catalog_revision=?
          WHERE ${projectionColumns.map(k=>`p.${k} IS json_extract(e.value,'$.${k}')`).join(' AND ')})=?`:''}
        AND ?>${NOW} AND NOT EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
          AND json_extract(request_json,'$.catalogRevision')=?)`,[revision.request.context.publicationReceiptWatermark,plan.globalWatermark,
      revision.request.context.priorPublication?.releaseId??null,...priorColumns.map(k=>revision.priorRow[k]),
      ...receiptColumns.map(k=>revision.packet.receipt[k]),plan.catalogRevision,revision.sourceDigest,plan.catalogRevision,revision.packet.rows.length,
      ...(projectionColumns.length?[JSON.stringify(revision.packet.rows),plan.catalogRevision,revision.packet.rows.length]:[]),revision.request.context.cutoff,
      owner.environment,owner.indexName,owner.generation,plan.catalogRevision])];
    await db.batch(checks());await reuseReadback(adapters,vectors,timeoutOf(options.timeoutMs));
    const next={...owner,epoch:owner.epoch+1},bytes=canonicalJson(request),receipt={sql:`SELECT 1 FROM catalog_vector_deliveries
      WHERE delivery_id=? AND request_json=? AND status='complete' AND disposition='verified'`,params:[id,bytes]};
    try{await db.batch([...checks(),db.prepare(`INSERT INTO catalog_vector_deliveries(delivery_id,environment,index_name,generation,prior_epoch,
      owner_json,request_json,product_json,status,disposition,evidence_json,completed_at) VALUES(?,?,?,?,?,?,?,?,'complete','verified',?,${NOW})`)
      .bind(id,owner.environment,owner.indexName,owner.generation,owner.epoch,canonicalJson(owner),bytes,reuseControl(request),reuseEvidence(request)),
      mutationAdvance(db,owner,receipt),mutationAssertion(db,next,['freezing'])]);}catch{/* Exact immutable receipt + owner readback, never resend. */}
    saved=await journal(db,id);const actual=await readMutationOwner(db,owner);
    if(!saved||saved.request_json!==bytes||!actual||canonicalJson(actual)!==canonicalJson(next))throw new Error('vector_reuse_unconfirmed');
    validateReuse(saved,actual,plan,adapters.providerIdentity);return{state:'complete',owner:actual,deliveryId:id};
  });
}
async function readReuseVectors(db:CatalogD1,owner:MutationOwner,row:Journal,plan:PrunedVectorPlan|ActivatedVectorPlan,
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>,revision?:ApprovedCohortRevision,signal?:AbortSignal) {
  signal?.throwIfAborted();
  const request=validateReuse(row,owner,plan,adapters.providerIdentity),rows=await reuseSources(db,
    {...request.approval,changes:request.approval.changes.filter(c=>reuseIds(request.plan).includes(c.publicId))},signal);
  signal?.throwIfAborted();
  if(revision&&(request.revisionSha256!==sha256(canonicalJson(revision))||request.sourceRowsSha256!==sha256(canonicalJson(revision.sourceRows))))
    throw new Error('vector_reuse_source_changed');
  const vectors=reuseVectors(owner,request,rows);
  const checks=()=>[mutationAssertion(db,owner,[owner.phase]),reuseSourceAssertions(db,rows),
    ...(revision?pruningCurrentQueries(revision.sourceRows).map(q=>assertion(db,`(${q.sql})=?`,[...q.params,q.count])):[])];
  await db.batch(checks(),{signal});signal?.throwIfAborted();await reuseReadback(adapters,vectors,3000,signal);signal?.throwIfAborted();
  await db.batch(checks(),{signal});signal?.throwIfAborted();
  return{environment:owner.environment,indexName:owner.indexName,settled:true as const,planSha256:request.planSha256,
    reference:`owned-vectors:${sha256(canonicalJson([row.delivery_id]))}`};
}
async function planJournals(db:CatalogD1,owner:MutationOwner,catalogRevision:string,signal?:AbortSignal){
  const keys=['delivery_id','environment','index_name','generation','prior_epoch','owner_json','request_json','product_json','status',
    'disposition','attempts','dispatch_token','mutation_reference','evidence_json','completed_at'];
  const output:Journal[]=[];let after='';
  for(let page=0;page<=SNAPSHOT_READ_LIMITS.identities;page++){
    signal?.throwIfAborted();
    const found=(await db.prepare(`SELECT data FROM (WITH encoded AS(SELECT delivery_id,json_object(${keys.map(k=>`'${k}',${k}`).join(',')}) data
      FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=? AND delivery_id>?
      AND json_extract(request_json,'$.catalogRevision')=? AND json_extract(request_json,'$.kind') IN('prune','approved-cohort-reuse','approved-cohort-plan')),
      sized AS(SELECT *,row_number() OVER(ORDER BY delivery_id) ordinal,
        sum(length(CAST(json_object('data',data||'') AS BLOB))) OVER(ORDER BY delivery_id) bytes FROM encoded)
      SELECT delivery_id,CASE WHEN bytes>384*1024 THEN NULL ELSE data END data FROM sized WHERE bytes<=384*1024 OR ordinal=1) ORDER BY delivery_id`)
      .bind(owner.environment,owner.indexName,owner.generation,after,catalogRevision).all<{data:string}>({signal})).results;
    if(!found.length)return output;
    if(found.some(r=>typeof r.data!=='string')||Buffer.byteLength(JSON.stringify(found))>384*1024)throw new Error('vector_payload_bound');
    const rows=found.map(r=>JSON.parse(r.data) as Journal);
    if(rows.some(r=>r.delivery_id<=after)||output.length+rows.length>SNAPSHOT_READ_LIMITS.identities+1)throw new Error('vector_plan_incomplete');
    output.push(...rows);after=rows.at(-1)!.delivery_id;
  }
  throw new Error('vector_payload_bound');
}
/** Independent exact coverage, never a subset hash supplied by a caller. All
 * native values come from genuine source journals or actual ordinary journals;
 * policy evidence alone does not settle a single remaining UUID. */
async function readPlanVectors(db:CatalogD1,owner:MutationOwner,rows:Journal[],plan:PrunedVectorPlan|ActivatedVectorPlan,
  adapters:Pick<OwnedVectorAdapters,'readback'|'readbacks'|'environment'|'indexName'|'providerIdentity'>,revision?:ApprovedCohortRevision,signal?:AbortSignal,timeout=3000,
  historical?:{selected:string[];owner:MutationOwner},auditHistory=false){
  const policies=rows.filter(r=>JSON.parse(r.request_json).kind===PLAN_KIND);
  if(policies.length!==1)throw new Error('vector_plan_incomplete');
  const request=validatePlan(policies[0],owner,plan,adapters.providerIdentity,revision),ids=reuseIds(request.plan);
  const sources=await reuseSources(db,{...request.approval,changes:request.approval.changes.filter(c=>request.sources.some(s=>s.publicId===c.publicId))},signal,true,request.automation);
  const vectors=request.ownerBaseReview?new Map<string,SyncVector|null>():reuseVectors(owner,sourceSubset(request),sources);
  const members=new Map(request.plan.products.map(p=>[p.publicId,p]));
  for(const row of rows.filter(r=>r!==policies[0])){
    const value=decodeRequest(row.request_json),base=JSON.parse(row.owner_json) as MutationOwner;
    const evidence=JSON.parse(row.evidence_json),last=Array.isArray(evidence)&&evidence.at(-1),member=members.get(value.publicId);
    if(value.kind!=='prune'||!ids.includes(value.publicId)||vectors.has(value.publicId)
      ||value.catalogRevision!==request.catalogRevision||value.planSha256!==request.planSha256||value.providerIdentity!==adapters.providerIdentity
      ||value.globalWatermark!==request.plan.globalWatermark||canonicalJson(value.projectionReceipt)!==canonicalJson(request.projectionReceipt)
      ||row.status!=='complete'||row.disposition!=='verified'||base.phase!=='freezing'
      ||canonicalJson({...owner,phase:'freezing',epoch:base.epoch})!==canonicalJson(base)||owner.epoch<base.epoch+2
      ||row.generation!==base.generation||row.prior_epoch!==base.epoch
      ||row.delivery_id!==idFor(base,{kind:'prune',planHash:request.planSha256,publicId:value.publicId})
      ||!last||last.attempt!==row.attempts||last.reference!==row.mutation_reference
      ||!(row.attempts===0&&row.dispatch_token===null&&row.mutation_reference===null&&last.state==='already_visible'
        ||row.attempts>0&&row.dispatch_token!==null&&REF.test(row.mutation_reference??'')&&last.state==='settled_visible')
      ||(member?!value.vector||value.vector.id!==value.publicId||value.vector.metadata.catalogRevision!==request.catalogRevision
        ||value.vector.metadata.eligible!==true||value.vector.metadata.sourceFactsHash!==member.sourceFactsHash
        ||(member.embeddingTextHash===null?value.vector.metadata.legacyInputProvenance!=='unverified'
          :value.vector.metadata.embeddingTextHash!==member.embeddingTextHash||value.vector.metadata.embeddingModel!=='text-embedding-3-small')
        ||nativeHash(value.vector.values)!==value.vector.metadata.vectorBytesSha256:value.vector!==null))throw new Error('vector_plan_incomplete');
    vectors.set(value.publicId,value.vector);
  }
  if(vectors.size!==ids.length||ids.some(id=>!vectors.has(id)))throw new Error('vector_plan_incomplete');
  const fence=historical?.owner??owner;
  const checks=()=>[mutationAssertion(db,fence,[fence.phase]),reuseSourceAssertions(db,sources)];
  // The shared settleCapturedRevision performs the unchanged full current and
  // projection CAS AFTER this cancellable proof. Do not start uncancellable
  // streamed queries inside its observation timeout. Standalone readers below
  // independently retain those same full-source checks outside this callback.
  if(historical&&historical.selected.some(id=>!vectors.has(id)))throw new Error('vector_plan_incomplete');
  await db.batch(checks(),{signal});await reuseReadback(adapters,historical?new Map(historical.selected.map(id=>[id,vectors.get(id)!])):vectors,timeout,signal);
  if(!historical)await readNativeHistory({db,owner,history:request.plan.history??[],adapters,signal,acceptedOnly:Boolean(revision?.persistent)&&!auditHistory});
  await db.batch(checks(),{signal});
  return{environment:owner.environment,indexName:owner.indexName,settled:true as const,planSha256:request.planSha256,
    reference:`owned-vectors:${sha256(canonicalJson(rows.map(r=>r.delivery_id).sort()))}`};
}
/** Only the genuine immutable verification receipt attests the independently
 * rebuilt EXACT policy revision. This is not a caller boolean, alternate policy,
 * or generic settlement shortcut: independently reload all source proofs/native
 * values, then retain the unchanged full source/projection/prior/time/owner CAS.
 * Ordinary approved cohorts still reconstruct through settleApprovedCohort.
 */
export function settleOwnedApprovedCohortVectorProof(options:{db:CatalogD1;owner:MutationOwner;revision:ApprovedCohortRevision;
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>}) {
  return safe(async()=>{
    const {db,adapters}=options,revision=structuredClone(options.revision);let owner=structuredClone(options.owner);
    const actual=await readMutationOwner(db,owner);
    if(canonicalJson(actual)!==canonicalJson(owner)){
      const next={...owner,epoch:owner.epoch+1},bytes=encodeBuildRequest(capturedRevisionBuildRequest(revision)),requestId=sha256(bytes);
      const policy=await journal(db,idFor(owner,{kind:PLAN_KIND}));
      if(!revision.request.ownerBaseReview||!policy)throw Error('vector_owner_changed');
      validatePlan(policy,next,prunedVectorPlan(revision),adapters.providerIdentity,revision);
      const base=JSON.parse(policy.owner_json) as MutationOwner;
      const queued=(await db.prepare('SELECT * FROM catalog_build_requests WHERE request_id=?').bind(requestId).all<Row>()).results;
      const sealed=(await db.prepare('SELECT * FROM catalog_revisions WHERE revision=?').bind(revision.snapshot.catalogRevision).all<Row>()).results;
      if(canonicalJson(owner)!==canonicalJson({...base,epoch:base.epoch+1})
        ||canonicalJson(actual)!==canonicalJson(next)||queued.length!==1||queued[0].request_json!==bytes
        ||queued[0].environment!==owner.environment||queued[0].source_revision!==revision.snapshot.catalogRevision||queued[0].state!=='pending'||queued[0].attempts!==0
        ||['lease_token','lease_until','run_reference','release_id','version_reference','dispatch_reference','error_code','operator_recovery_json'].some(k=>queued[0][k]!==null)
        ||sealed.length!==1||sealed[0].status!=='reconciled'||sealed[0].source_export_sha256!==revision.sourceDigest
        ||sealed[0].created_at!==revision.snapshot.generatedAt||sealed[0].abandonment_delivery_id!==null)throw Error('vector_owner_changed');
      // The normal path below still authenticates the immutable native policy,
      // every source/projection row, prior receipt, watermarks and cutoff before
      // returning this SAME existing queue. No queue or epoch is written again.
      owner=next;
    }
    adapterScope(owner,adapters);await db.batch([mutationAssertion(db,owner,['freezing'])]);
    const policy=await journal(db,idFor(owner,{kind:PLAN_KIND}));
    if(policy){
      const plan=prunedVectorPlan(revision);validatePlan(policy,owner,plan,adapters.providerIdentity,revision);
      const rows=await planJournals(db,owner,revision.snapshot.catalogRevision);
      await assertPlanSource(db,owner,revision);
      let pending:Promise<PrunedVectorObservation>|undefined;
      try{
        const proof={deliveryId:policy.delivery_id,requestSha256:sha256(policy.request_json)};
        if(isCatalogD1Rest(db)&&hasAccountedVectorReadback(adapters)){
          // Real provider reads have their own header/body bounds, while every
          // SQL request also journals durable accounting. Validate the complete
          // native proof under a finite background bound, not the short core
          // observation clock. Core independently rechecks this exact policy,
          // owner, full source/projection, prior receipt, watermark and cutoff
          // before its atomic queue/epoch write. No proof is cached across calls.
          const observed=await bounded(signal=>(pending=readPlanVectors(db,owner,rows,plan,adapters,revision,signal,30000)),900_000);
          return await settleCapturedRevision(db,owner,revision,async(_plan,signal)=>{
            signal.throwIfAborted();return observed;
          },proof);
        }
        return await settleCapturedRevision(db,owner,revision,(_plan,signal)=>(pending=readPlanVectors(db,owner,rows,plan,adapters,revision,signal,30000)),proof);
      }
      finally{if(pending){
        // Provider/background deadlines still abort. Only concrete adapters may
        // join their own durable accounting beyond arbitrary-adapter cleanup.
        if(isCatalogD1Rest(db)&&hasAccountedVectorReadback(adapters))await pending.catch(()=>{});
        else await drainDeploymentObservation(pending);
      }}
    }
    const rows=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
      AND json_extract(request_json,'$.catalogRevision')=? AND json_extract(request_json,'$.kind') IN('prune','approved-cohort-reuse') LIMIT 21`)
      .bind(owner.environment,owner.indexName,owner.generation,revision.snapshot.catalogRevision).all<Journal>()).results;
    if(rows.length!==1||JSON.parse(rows[0].request_json).kind!==REUSE_KIND)throw new Error('vector_reuse_invalid');
    return settleCapturedRevision(db,owner,revision,()=>readReuseVectors(db,owner,rows[0],prunedVectorPlan(revision),adapters,revision));
  });
}
export function readOwnedPrunedVectors(...args: Parameters<typeof readPrunedVectors>): Promise<PrunedVectorObservation> {
  return safe(() => readPrunedVectors(...args));
}
export function readOwnedApprovedCohortVectors(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision,
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>):Promise<PrunedVectorObservation> {
  return safe(async()=>{
    adapterScope(owner,adapters);await db.batch([mutationAssertion(db,owner,['freezing'])]);
    if(await journal(db,idFor(owner,{kind:PLAN_KIND}))){
      await assertPlanSource(db,owner,revision);
      const result=await readPlanVectors(db,owner,await planJournals(db,owner,revision.snapshot.catalogRevision),prunedVectorPlan(revision),adapters,revision,undefined,30000);
      await assertPlanSource(db,owner,revision);return result;
    }
    const rows=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
      AND json_extract(request_json,'$.catalogRevision')=? AND json_extract(request_json,'$.kind') IN('prune','approved-cohort-reuse') LIMIT 21`)
      .bind(owner.environment,owner.indexName,owner.generation,revision.snapshot.catalogRevision).all<Journal>()).results;
    const reused=rows.filter(r=>JSON.parse(r.request_json).kind===REUSE_KIND);
    if(!reused.length)return readPrunedVectors(db,owner,revision,adapters);
    if(rows.length!==1)throw new Error('vector_plan_incomplete');
    return readReuseVectors(db,owner,reused[0],prunedVectorPlan(revision),adapters,revision);
  });
}
/** Native-only component of a permanent-cohort activation proof. Requires the
 * genuine current policy and exact owner/bits/history; does not create a policy,
 * claim, receipt, deadline or product grant. The publisher separately performs
 * fresh full inventory immediately before the atomic activation gates. */
export function readOwnedPermanentCohortNative(db:CatalogD1,owner:MutationOwner,revision:ApprovedCohortRevision,
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>):Promise<PrunedVectorObservation>{
  return safe(async()=>{
    // Native history is independent of finite photo/text overlays. Every
    // listing must still have its exact permanent cleared fallback; the
    // publisher separately validates the snapshot and original deadlines.
    if(!revision.persistent||revision.snapshot.products.some(p=>!persistentPublicProduct(p)))throw new Error('vector_plan_invalid');
    adapterScope(owner,adapters);await db.batch([mutationAssertion(db,owner,['freezing'])]);
    return readPlanVectors(db,owner,await planJournals(db,owner,revision.snapshot.catalogRevision),prunedVectorPlan(revision),adapters,revision,undefined,30000,undefined,true);
  });
}
/** Control-only readback after activation. No delivery, expiry renewal, watermark
 * or ownership write is permitted here. Fresh publication still requires the
 * separate current-rights/lease predicates in completePublication. This small
 * plan may survive content-artifact expiry for read-only reconciliation.
 */
export interface PublishedCatalogRead extends PublishedCatalogBinding {
  revision:ApprovedCohortRevision;
}
export function publishedCatalogOperationKey(input:PublishedCatalogRead):string {
  return sha256(encodePublishedCatalogBinding(input));
}
/** Read-only exception for NEW CODE over the EXACT already-published catalog.
 * Historical proof ownership is validated as historical, never claimed/current.
 * Every observation is fenced by the actual new owner/permit before AND after
 * native readback. No delivery journal, epoch, metadata or deadline is written. */
export function readPublishedCatalogVectors(options:{db:CatalogD1;owner:MutationOwner;published:PublishedCatalogRead;
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>;permit?:ActivationPermit;signal?:AbortSignal
}):Promise<PrunedVectorObservation>{
  return safe(async()=>{
    const {db,adapters,signal}=options,owner=structuredClone(options.owner),input=structuredClone(options.published);
    const {source,revision,request}=input,plan=prunedVectorPlan(revision),requestBytes=encodeBuildRequest(request);
    const snapshot=revision.snapshot,ids=[...snapshot.products,...snapshot.heldProducts].map(p=>p.publicId);
    const permit=options.permit&&structuredClone(options.permit),planHash=sha256(canonicalJson(plan));
    signal?.throwIfAborted();adapterScope(owner,adapters);
    if(!['freezing','activating'].includes(owner.phase)||owner.operationKey!==publishedCatalogOperationKey(input)
      ||owner.environment!==request.environment||owner.environment!==plan.environment||owner.indexName!==plan.indexName||request.sourceRevision!==snapshot.catalogRevision
      ||request.sourceDigest!==revision.packet.receipt.snapshot_sha256||request.capturedAt!==snapshot.generatedAt
      ||sha256(`${JSON.stringify(snapshot)}\n`)!==request.sourceDigest||!request.priorReleaseId
      ||snapshot.products.some(p=>p.eligibleUntil===null||request.cutoff>=p.eligibleUntil)||!snapshot.products.length
      ||ids.length>20||new Set(ids).size!==ids.length||revision.sourceRows.length!==ids.length
      ||canonicalJson(revision.sourceRows.map(r=>r.public_id).sort())!==canonicalJson([...ids].sort())
      ||owner.phase==='activating'&&(!permit||canonicalJson(permit.mutationOwner)!==canonicalJson(owner))
      ||owner.phase==='freezing'&&permit)throw new Error('vector_published_input_invalid');
    const read=async(sql:string,params:unknown[]=[])=>{signal?.throwIfAborted();
      const result=(await db.prepare(sql).bind(...params).all<Row>({signal})).results;signal?.throwIfAborted();return result;};
    const exact=(table:string,row:Row)=>{
      const keys=Object.keys(row);if(!keys.length||keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw new Error('vector_published_input_invalid');
      return assertion(db,`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k]));};
    // Original immutable completed proof, with its OWN generation/owner bytes.
    const journalRows=await read('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?',[source.deliveryId]);
    const saved=journalRows[0] as Journal;
    if(journalRows.length!==1||sha256(canonicalJson(saved))!==source.deliverySha256)throw new Error('vector_published_journal_changed');
    const recordedBase=JSON.parse(saved.owner_json) as MutationOwner;
    const recordedCompletedOwner={...recordedBase,epoch:recordedBase.epoch+1};
    const proof=validateReuse(saved,recordedCompletedOwner,plan,adapters.providerIdentity);
    if(recordedBase.generation>=owner.generation||proof.revisionSha256!==sha256(canonicalJson(revision))
      ||proof.sourceRowsSha256!==sha256(canonicalJson(revision.sourceRows))
      ||canonicalJson(proof.projectionReceipt)!==canonicalJson(revision.packet.receipt))throw new Error('vector_published_revision_changed');
    const sourceRows=await reuseSources(db,proof.approval,signal),vectors=reuseVectors(recordedCompletedOwner,proof,sourceRows);
    // Additional fresh absence READS, not historical deletion/dispatch proof.
    for(const held of snapshot.heldProducts)if(!vectors.has(held.publicId))vectors.set(held.publicId,null);
    const receipts=await read('SELECT * FROM publication_receipts WHERE release_id IN (?,?)',[source.releaseId,request.priorReleaseId]);
    const original=receipts.find(r=>r.release_id===source.releaseId),prior=receipts.find(r=>r.release_id===request.priorReleaseId);
    if(!original||!prior||sha256(canonicalJson(original))!==source.receiptSha256)throw new Error('vector_published_receipt_changed');
    const oldRequest=encodeBuildRequest({schemaVersion:1,environment:owner.environment,sourceRevision:snapshot.catalogRevision,
      sourceDigest:request.sourceDigest,codeSha:revision.request.codeSha,priorReleaseId:revision.request.context.priorPublication?.releaseId??null,
      capturedAt:snapshot.generatedAt,cutoff:revision.request.context.cutoff});
    const bindings:ReturnType<typeof exact>[]=[exact('catalog_vector_deliveries',saved)];
    for(const receipt of receipts){
      const intent=JSON.parse(String(receipt.manifest_json)) as PublicationIntent;
      const builds=await read("SELECT * FROM catalog_build_requests WHERE release_id=? AND state='resolved' LIMIT 2",[receipt.release_id]);
      const publications=await read("SELECT * FROM publication_outbox WHERE release_id=? AND state='verified' LIMIT 2",[receipt.release_id]);
      const build=builds[0],publication=publications[0];
      if(builds.length!==1||publications.length!==1||encodePublicationIntent(intent)!==receipt.manifest_json
        ||intent.releaseId!==receipt.release_id||intent.codeSha!==receipt.code_sha||intent.catalogRevision!==snapshot.catalogRevision
        ||receipt.catalog_revision!==snapshot.catalogRevision||intent.catalogSnapshotSha256!==request.sourceDigest
        ||intent.vectorSyncWatermark!==revision.vectorSyncWatermark||intent.nextExpiry!==snapshot.products.map(p=>p.eligibleUntil).sort()[0]
        ||publication.intent_json!==receipt.manifest_json||!publication.completed_token||!publication.dispatch_reference
        ||build.environment!==owner.environment||build.source_revision!==snapshot.catalogRevision||!build.lease_token||!build.run_reference
        ||build.request_id!==sha256(String(build.request_json))
        ||receipt===original&&(build.request_json!==oldRequest||intent.codeSha!==revision.request.codeSha
          ||String(saved.completed_at)>String(receipt.completed_at)))throw new Error('vector_published_build_changed');
      const built=JSON.parse(String(build.request_json)) as CatalogBuildRequest;
      if(encodeBuildRequest(built)!==build.request_json||built.codeSha!==intent.codeSha||built.sourceRevision!==snapshot.catalogRevision
        ||built.sourceDigest!==request.sourceDigest||built.priorReleaseId!==intent.priorReleaseId||built.capturedAt!==snapshot.generatedAt)
        throw new Error('vector_published_request_changed');
      const runtime=await readResolvedPublicationTransport(db,build,publication,intent,'vector_published_build_changed',signal);
      bindings.push(exact('publication_receipts',receipt),exact('catalog_build_requests',build),exact('publication_outbox',publication),
        ...(runtime?[exact('catalog_runtime_publications',runtime)]:[]));
    }
    if(request.codeSha===prior.code_sha)throw new Error('vector_published_code_unchanged');
    // Approved rows already carry exact full-row CAS in sourceRows. Capture the
    // remaining (held) full rows too, without duplicating eight large payloads.
    const remaining=revision.sourceRows.filter(r=>!r.approved_product_json).map(r=>r.public_id);
    const current=await read(`SELECT p.* FROM json_each(?) i CROSS JOIN products p ON p.public_id=i.value LIMIT 21`,[JSON.stringify(remaining)]);
    if(current.length!==remaining.length||new Set(current.map(r=>r.public_id)).size!==remaining.length)throw new Error('vector_published_source_changed');
    bindings.push(...current.map(row=>exact('products',row)));
    if(permit){
      const builds=await read('SELECT * FROM catalog_build_requests WHERE request_id=?',[permit.requestId]);
      const publications=await read('SELECT * FROM publication_outbox WHERE release_id=?',[permit.releaseId]);
      if(builds.length!==1||publications.length!==1||!['dispatched','verified'].includes(String(publications[0].state)))
        throw new Error('vector_published_permit_changed');
      const publication=publications[0],intent=JSON.parse(String(publication.intent_json)) as PublicationIntent;
      if(encodePublicationIntent(intent)!==publication.intent_json||intent.releaseId!==permit.releaseId||intent.codeSha!==request.codeSha
        ||intent.catalogRevision!==snapshot.catalogRevision||intent.catalogSnapshotSha256!==request.sourceDigest
        ||intent.priorReleaseId!==request.priorReleaseId||intent.vectorSyncWatermark!==revision.vectorSyncWatermark
        ||intent.nextExpiry!==snapshot.products.map(p=>p.eligibleUntil).sort()[0]||permit.requestId!==sha256(requestBytes))
        throw new Error('vector_published_permit_changed');
      bindings.push(exact('catalog_build_requests',builds[0]),exact('publication_outbox',publication));
    }
    const projectionColumns=Object.keys(revision.packet.rows[0]??{}),priorManifest=String(prior.manifest_json);
    if(!projectionColumns.length||projectionColumns.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw new Error('vector_published_source_changed');
    const checks=()=>[mutationAssertion(db,owner,[owner.phase]),...bindings,reuseSourceAssertions(db,sourceRows),
      assertion(db,'EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND captured_at=? AND activation_request_id IS ?)',
        [owner.environment,owner.indexName,owner.capturedAt,permit?.requestId??null]),
      ...(revision.request.context.priorPublication?[exact('publication_receipts',revision.priorRow)]:[]),
      ...pruningCurrentQueries(revision.sourceRows).map(q=>assertion(db,`(${q.sql})=?`,[...q.params,q.count])),
      exact('catalog_projection_receipts',revision.packet.receipt),
      assertion(db,`EXISTS(SELECT 1 FROM catalog_revisions WHERE revision=? AND status='published' AND source_export_sha256=?
        AND abandonment_delivery_id IS NULL) AND (SELECT count(*) FROM products)=?
        AND (SELECT count(*) FROM catalog_public_products WHERE catalog_revision=?)=?
        AND (SELECT count(*) FROM json_each(?) e JOIN catalog_public_products p ON p.catalog_revision=?
        AND p.public_id=json_extract(e.value,'$.public_id') WHERE ${projectionColumns.map(k=>`p.${k} IS json_extract(e.value,'$.${k}')`).join(' AND ')})=?
        AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox)=?
        AND (SELECT coalesce(max(sequence),0) FROM vector_sync_outbox WHERE source_revision=?)=?
        AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete')
        AND NOT EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND status!='complete')
        AND NOT EXISTS(SELECT 1 FROM catalog_revisions WHERE status='importing')
        AND ?>${NOW} AND ?<=${NOW}
        AND EXISTS(SELECT 1 FROM publication_receipts p WHERE p.rowid=(SELECT max(rowid) FROM publication_receipts)
          AND ((p.release_id=? AND p.manifest_json=?) OR (p.release_id=? AND p.catalog_revision=? AND p.code_sha=?
            AND json_extract(p.manifest_json,'$.catalogSnapshotSha256')=? AND json_extract(p.manifest_json,'$.priorReleaseId')=?
            AND json_extract(p.manifest_json,'$.vectorSyncWatermark')=? AND json_extract(p.manifest_json,'$.nextExpiry')=?
            AND EXISTS(SELECT 1 FROM publication_outbox o WHERE o.release_id=p.release_id AND o.state='verified' AND o.intent_json=p.manifest_json))))`,
      [snapshot.catalogRevision,revision.sourceDigest,ids.length,snapshot.catalogRevision,revision.packet.rows.length,JSON.stringify(revision.packet.rows),
        snapshot.catalogRevision,revision.packet.rows.length,revision.globalVectorWatermark,snapshot.catalogRevision,revision.vectorSyncWatermark,
        owner.environment,owner.indexName,request.cutoff,request.capturedAt,request.priorReleaseId,priorManifest,
        permit?.releaseId??null,snapshot.catalogRevision,request.codeSha,request.sourceDigest,request.priorReleaseId,
        revision.vectorSyncWatermark,snapshot.products.map(p=>p.eligibleUntil).sort()[0]]),
      ...(permit?[assertion(db,`EXISTS(SELECT 1 FROM catalog_mutation_scopes s JOIN catalog_build_requests b ON b.request_id=s.activation_request_id
        WHERE s.environment=? AND s.index_name=? AND b.request_id=? AND b.environment=? AND b.request_json=? AND b.state='activating'
          AND b.lease_token=? AND b.run_reference=? AND b.release_id=? AND b.version_reference=?)`,[owner.environment,owner.indexName,
        permit.requestId,owner.environment,requestBytes,permit.token,permit.runReference,permit.releaseId,permit.versionReference])]:[])];
    const check=async()=>{
      signal?.throwIfAborted();
      const time=(await read(`SELECT ${NOW} now`))[0].now as string;validateCatalogSnapshot(snapshot,new Date(time));
      for(const product of snapshot.products)checkCurrent(product,revision.packet.rows.find(r=>r.public_id===product.publicId)!,
        revision.sourceRows.find(r=>r.public_id===product.publicId)!,new Date(time));
      await db.batch(checks(),{signal});signal?.throwIfAborted();
    };
    await check();await reuseReadback(adapters,vectors,3000,signal);await check();signal?.throwIfAborted();
    return{environment:owner.environment,indexName:owner.indexName,settled:true as const,planSha256:planHash,
      reference:`published-vectors:${source.deliveryId}`};
  });
}
/** Default control-only readback may survive content-artifact expiry. The
 * explicit published-input path additionally requires the original fresh data. */
export interface ActivatedVectorPlan { catalogRevision:string; planSha256:string; ids:string[] }
export function validateNativeHistory(history:NativeHistoryBinding[],currentIds:string[]=[]){
  if(!Array.isArray(history)||history.length>SNAPSHOT_READ_LIMITS.identities)throw new Error('vector_history_invalid');
  const ids=[...currentIds,...history.flatMap(group=>group.ids??[])];
  if(ids.length>SNAPSHOT_READ_LIMITS.identities||new Set(ids).size!==ids.length||ids.some(id=>!UUID.test(id))
    ||history.some(group=>!Array.isArray(group.ids)||!group.ids.length||!HASH.test(group.revisionSha256)||!HASH.test(group.planSha256)
      ||!group.source||![group.source.receiptSha256,group.source.deliveryId,group.source.deliverySha256].every(h=>HASH.test(h))
      ||!REF.test(group.source.releaseId)))throw new Error('vector_history_invalid');
}
/** Flat, current membership; old publication receipts/journals remain the
 * authority. Permanent delta publication reuses accepted history: the enclosing
 * full inventory fence proves these identities did not change, and the real
 * resolved receipt authenticates their original native proof. Do not fetch all
 * old vector values again just to publish a different product. Explicit audits
 * retain live provider readback by default. Current deltas are always read back.
 * Current-delta and historical IDs must remain strictly disjoint. */
export async function readNativeHistory(options:{db:CatalogD1;owner:MutationOwner;history:NativeHistoryBinding[];
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>;signal?:AbortSignal;acceptedOnly?:boolean}){
  const {db,owner,history,adapters,signal}=options;validateNativeHistory(history);adapterScope(owner,adapters);
  const exact=(table:string,row:Row)=>{const keys=Object.keys(row);
    if(!keys.length||keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw new Error('vector_history_invalid');
    return assertion(db,`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k]));};
  for(const binding of history){
    signal?.throwIfAborted();
    const saved=await journal(db,binding.source.deliveryId,signal);if(!saved||sha256(canonicalJson(saved))!==binding.source.deliverySha256)throw new Error('vector_history_changed');
    const request=JSON.parse(saved.request_json),base=JSON.parse(saved.owner_json) as MutationOwner,plan=request.plan as PrunedVectorPlan;
    if(!plan||request.planSha256!==binding.planSha256||sha256(canonicalJson(plan))!==binding.planSha256
      ||request.revisionSha256!==binding.revisionSha256||base.generation>=owner.generation
      ||binding.ids.some(id=>!reuseIds(plan).includes(id)))throw new Error('vector_history_changed');
    if(request.kind===REUSE_KIND&&!options.acceptedOnly){
      const current=(await readApprovedCurrentRows(db,reuseIds(plan),owner,true,signal)).current;
      await readHistoricalNativePreservation({db,owner,native:{source:binding.source,revisionSha256:binding.revisionSha256,plan},current,
        changedIds:reuseIds(plan).filter(id=>!binding.ids.includes(id)),historicalOnly:true,adapters,signal});continue;
    }
    if(![PLAN_KIND,REUSE_KIND].includes(request.kind))throw new Error('vector_history_changed');
    const receipts=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(binding.source.releaseId).all<Row>({signal})).results;
    const builds=(await db.prepare("SELECT * FROM catalog_build_requests WHERE release_id=? AND state='resolved' LIMIT 2").bind(binding.source.releaseId).all<Row>({signal})).results;
    const outbox=(await db.prepare("SELECT * FROM publication_outbox WHERE release_id=? AND state='verified' LIMIT 2").bind(binding.source.releaseId).all<Row>({signal})).results;
    const receipt=receipts[0],build=builds[0],publication=outbox[0],intent=receipt&&JSON.parse(String(receipt.manifest_json));
    const buildRequest=build&&JSON.parse(String(build.request_json));
    if(receipts.length!==1||builds.length!==1||outbox.length!==1||sha256(canonicalJson(receipt))!==binding.source.receiptSha256
      ||encodePublicationIntent(intent)!==receipt.manifest_json||intent.releaseId!==binding.source.releaseId||intent.catalogRevision!==plan.catalogRevision
      ||receipt.catalog_revision!==plan.catalogRevision||intent.catalogSnapshotSha256!==plan.snapshotSha256||intent.codeSha!==receipt.code_sha
      ||publication.intent_json!==receipt.manifest_json||!publication.completed_token
      ||build.environment!==owner.environment||build.source_revision!==plan.catalogRevision||!build.lease_token||!build.run_reference
      ||build.request_id!==sha256(String(build.request_json))||encodeBuildRequest(buildRequest)!==build.request_json
      ||buildRequest.sourceRevision!==plan.catalogRevision||buildRequest.sourceDigest!==plan.snapshotSha256||buildRequest.codeSha!==intent.codeSha
      ||buildRequest.priorReleaseId!==intent.priorReleaseId||String(saved.completed_at)>String(receipt.completed_at))throw new Error('vector_history_changed');
    const runtime=await readResolvedPublicationTransport(db,build,publication,intent,'vector_history_changed',signal);
    if(!runtime&&request.kind===PLAN_KIND&&publication.dispatch_reference!==`version:${build.version_reference}`)throw new Error('vector_history_changed');
    const rows=options.acceptedOnly?[]:await planJournals(db,base,plan.catalogRevision,signal);
    const historical={...base,epoch:Math.max(base.epoch+1,...rows.map(row=>Number(row.prior_epoch)+2))};
    if(request.kind===REUSE_KIND)validateReuse(saved,historical,plan,adapters.providerIdentity);
    else validatePlan(saved,historical,plan,adapters.providerIdentity);
    // Historical membership proves OLD input and exact provider bytes, not
    // current supplier freshness. Current semantic targets have separate proofs.
    const checks=()=>[mutationAssertion(db,owner,[owner.phase]),exact('catalog_vector_deliveries',saved),exact('publication_receipts',receipt),
      exact('catalog_build_requests',build),exact('publication_outbox',publication),...(runtime?[exact('catalog_runtime_publications',runtime)]:[])];
    await db.batch(checks(),{signal});
    if(!options.acceptedOnly)await readPlanVectors(db,historical,rows,plan,adapters,undefined,signal,30000,{selected:binding.ids,owner});
    await db.batch(checks(),{signal});
  }
  return history.flatMap(group=>group.ids);
}
/** Preserve the original completed native proof. This observes its actual old
 * generation, processed references and exact bits/metadata; it neither promotes
 * those vectors into a permanent grant nor creates a replacement receipt. */
export function readHistoricalNativePreservation(options:{db:CatalogD1;owner:MutationOwner;native:HistoricalNativeBinding;current:Row[];original?:Row[];changedIds?:string[];historicalOnly?:boolean;
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>;signal?:AbortSignal
}):Promise<string[]>{return safe(async()=>{
  const {db,adapters,signal}=options,owner=structuredClone(options.owner),binding=structuredClone(options.native),changed=new Set(options.changedIds??[]);
  signal?.throwIfAborted();adapterScope(owner,adapters);
  if(!binding||!['freezing','activating'].includes(owner.phase)||changed.size>30||[...changed].some(id=>!UUID.test(id))
    ||options.historicalOnly!==undefined&&typeof options.historicalOnly!=='boolean')throw new Error('vector_preserved_input_invalid');
  const read=async(sql:string,params:unknown[])=>{signal?.throwIfAborted();
    const rows=(await db.prepare(sql).bind(...params).all<Row>({signal})).results;signal?.throwIfAborted();return rows;};
  const exact=(table:string,row:Row)=>{const keys=Object.keys(row);
    if(!keys.length||keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw new Error('vector_preserved_input_invalid');
    return assertion(db,`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k]));};
  const savedRows=await read('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?',[binding.source.deliveryId]);
  const saved=savedRows[0] as Journal;
  if(savedRows.length!==1||sha256(canonicalJson(saved))!==binding.source.deliverySha256)throw new Error('vector_preserved_journal_changed');
  const base=JSON.parse(saved.owner_json) as MutationOwner,historical={...base,epoch:base.epoch+1};
  const proof=validateReuse(saved,historical,binding.plan,adapters.providerIdentity);
  if(base.generation>=owner.generation||proof.revisionSha256!==binding.revisionSha256)throw new Error('vector_preserved_revision_changed');
  const rows=await reuseSources(db,proof.approval,signal),vectors=reuseVectors(historical,proof,rows);
  const originals=options.original&&new Map(options.original.map(row=>[row.public_id,row]));
  const current=new Map(options.current.map(row=>[row.public_id,row]));
  for(const row of rows)if(originals&&canonicalJson(originals.get(row.public_id))!==canonicalJson(JSON.parse(String(row.product_json)))
    ||!current.get(row.public_id)?.approved_product_json)throw new Error('vector_preserved_source_changed');
  for(const row of rows){const actual=current.get(row.public_id)!,old=JSON.parse(String(row.product_json));
    if(changed.has(String(row.public_id)))vectors.delete(String(row.public_id));
    else if(!options.historicalOnly&&(actual.source_facts_hash!==old.source_facts_hash||actual.embedding_text_hash!==old.embedding_text_hash))throw new Error('vector_preserved_source_changed');}
  const receipts=await read('SELECT * FROM publication_receipts WHERE release_id=?',[binding.source.releaseId]),receipt=receipts[0];
  if(receipts.length!==1||sha256(canonicalJson(receipt))!==binding.source.receiptSha256)throw new Error('vector_preserved_receipt_changed');
  const intent=JSON.parse(String(receipt.manifest_json)) as PublicationIntent;
  const builds=await read("SELECT * FROM catalog_build_requests WHERE release_id=? AND state='resolved' LIMIT 2",[binding.source.releaseId]);
  const publications=await read("SELECT * FROM publication_outbox WHERE release_id=? AND state='verified' LIMIT 2",[binding.source.releaseId]);
  const build=builds[0],publication=publications[0],request=build&&JSON.parse(String(build.request_json)) as CatalogBuildRequest;
  if(builds.length!==1||publications.length!==1||encodePublicationIntent(intent)!==receipt.manifest_json
    ||intent.releaseId!==binding.source.releaseId||intent.catalogRevision!==binding.plan.catalogRevision
    ||receipt.catalog_revision!==binding.plan.catalogRevision||intent.catalogSnapshotSha256!==binding.plan.snapshotSha256
    ||intent.codeSha!==receipt.code_sha||intent.vectorSyncWatermark!==binding.plan.globalWatermark
    ||publication.intent_json!==receipt.manifest_json||!publication.completed_token||!publication.dispatch_reference
    ||build.environment!==owner.environment||build.source_revision!==binding.plan.catalogRevision||!build.lease_token||!build.run_reference
    ||build.request_id!==sha256(String(build.request_json))
    ||encodeBuildRequest(request)!==build.request_json||request.codeSha!==intent.codeSha||request.sourceRevision!==binding.plan.catalogRevision
    ||request.sourceDigest!==binding.plan.snapshotSha256||request.priorReleaseId!==intent.priorReleaseId
    ||String(saved.completed_at)>String(receipt.completed_at))throw new Error('vector_preserved_receipt_changed');
  const runtime=await readResolvedPublicationTransport(db,build,publication,intent,'vector_preserved_receipt_changed',signal);
  const checks=()=>[mutationAssertion(db,owner,[owner.phase]),exact('catalog_vector_deliveries',saved),
    assertion(db,'EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND captured_at=?)',
      [owner.environment,owner.indexName,owner.capturedAt]),
    exact('publication_receipts',receipt),exact('catalog_build_requests',build),exact('publication_outbox',publication),
    ...(runtime?[exact('catalog_runtime_publications',runtime)]:[]),reuseSourceAssertions(db,rows),
    ...pruningCurrentQueries(rows.map(row=>current.get(row.public_id)!)).map(q=>assertion(db,`(${q.sql})=?`,[...q.params,q.count]))];
  await db.batch(checks(),{signal});signal?.throwIfAborted();await reuseReadback(adapters,vectors,3000,signal);
  await db.batch(checks(),{signal});signal?.throwIfAborted();
  return [...vectors.keys()];
});}
export async function readPermanentNativeProof(options:{db:CatalogD1;owner:MutationOwner;revision:PermanentCatalogRevision;
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>;signal?:AbortSignal}):Promise<PrunedVectorObservation>{
  const {revision,owner}=options;
  if(!revision.nativePreservation||canonicalJson(revision.nativePreservation)!==canonicalJson(revision.request.native)
    ||owner.operationKey!==revision.operationKey||permanentCatalogOperationKey(revision.request)!==revision.operationKey)
    throw new Error('vector_preserved_input_invalid');
  // A subsequent display-only installation starts from the already cleared
  // catalog, not the original supplier cache. Its full-row preservation is
  // independently checked by the permanent installer/freezer. Native bits,
  // metadata, factual/input hashes and original receipts remain verified below.
  await readHistoricalNativePreservation({...options,native:revision.nativePreservation,current:revision.sourceRows,
    ...(revision.request.installation.plan.input.priorPublication ? {}
      : {original:revision.request.installation.plan.input.capture.tables.products})});
  return{environment:owner.environment,indexName:owner.indexName,settled:true,planSha256:sha256(canonicalJson(prunedVectorPlan(revision))),
    reference:`preserved-vectors:${revision.nativePreservation.source.deliveryId}`};
}
/** Concrete native/permit observation for callers that already own the complete
 * permanent source/projection proof (receipt settlement or final resolution).
 * This does not attest the remaining catalog rows; the default reader below does. */
export function readActivatedPermanentCatalogNative(db:CatalogD1,permit:ActivationPermit,plan:ActivatedVectorPlan,
  revision:PermanentCatalogRevision,adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>,
  signal?:AbortSignal):Promise<PrunedVectorObservation>{return safe(async()=>{
  const owner=permit.mutationOwner,expected=prunedVectorPlan(revision);
  if(!owner||owner.phase!=='activating'||plan.catalogRevision!==expected.catalogRevision
    ||plan.planSha256!==sha256(canonicalJson(expected))||canonicalJson([...plan.ids].sort())!==canonicalJson(prunedVectorIds(expected).sort()))
    throw new Error('vector_plan_invalid');
  const check=async()=>{signal?.throwIfAborted();await db.batch([mutationAssertion(db,owner,['activating']),assertion(db,`EXISTS(
    SELECT 1 FROM catalog_mutation_scopes s JOIN catalog_build_requests b ON b.request_id=s.activation_request_id
    WHERE s.environment=? AND s.index_name=? AND s.captured_at=? AND s.activation_request_id=? AND b.environment=s.environment
    AND b.state='activating' AND b.lease_token=? AND b.run_reference=? AND b.release_id=? AND b.version_reference=?
    AND json_extract(b.request_json,'$.sourceRevision')=? AND json_extract(b.request_json,'$.sourceDigest')=?)`,
    [owner.environment,owner.indexName,owner.capturedAt,permit.requestId,permit.token,permit.runReference,permit.releaseId,permit.versionReference,
      revision.snapshot.catalogRevision,revision.packet.receipt.snapshot_sha256])],{signal});signal?.throwIfAborted();};
  await check();const observed=await readPermanentNativeProof({db,owner,revision,adapters,signal});await check();return observed;
});}
/** Terminal native observation after the exact permanent publication receipt
 * accepted the complete source/projection proof. No hydration, projection scan,
 * renewed content deadline, upload or activation authority is introduced. */
export function readAcceptedActivatedCatalogNative(db:CatalogD1,permit:ActivationPermit,plan:ActivatedVectorPlan,
  adapters:Pick<OwnedVectorAdapters,'readback'|'readbacks'|'environment'|'indexName'|'providerIdentity'>,
  options:{intent:PublicationIntent;signal?:AbortSignal}):Promise<PrunedVectorObservation>{return safe(async()=>{
  const {intent,signal}=options,owner=permit.mutationOwner,bytes=encodePublicationIntent(intent);
  if(!owner||owner.phase!=='activating'||intent.nextExpiry!==null||intent.releaseId!==permit.releaseId
    ||intent.catalogRevision!==plan.catalogRevision||!HASH.test(plan.planSha256)||!Array.isArray(plan.ids)
    ||plan.ids.length>OWNED_VECTOR_PROOF_LIMIT||new Set(plan.ids).size!==plan.ids.length||plan.ids.some(id=>!UUID.test(id)))
    throw Error('vector_terminal_receipt_invalid');
  adapterScope(owner,adapters);
  const read=async(sql:string,params:unknown[])=>{signal?.throwIfAborted();
    const rows=(await db.prepare(sql).bind(...params).all<Row>({signal})).results;
    if(rows.length!==1)throw Error('vector_terminal_receipt_invalid');return rows[0];};
  const receipt=await read('SELECT * FROM publication_receipts WHERE release_id=?',[permit.releaseId]);
  const outbox=await read('SELECT * FROM publication_outbox WHERE release_id=?',[permit.releaseId]);
  const build=await read('SELECT * FROM catalog_build_requests WHERE request_id=?',[permit.requestId]);
  const request=JSON.parse(String(build.request_json));
  if(receipt.manifest_json!==bytes||receipt.code_sha!==intent.codeSha||receipt.catalog_revision!==intent.catalogRevision
    ||outbox.state!=='verified'||outbox.intent_json!==bytes||!outbox.completed_token
    ||outbox.dispatch_reference!==`version:${permit.versionReference}`||build.state!=='activating'
    ||build.lease_token!==permit.token||build.run_reference!==permit.runReference||build.release_id!==permit.releaseId
    ||build.version_reference!==permit.versionReference||build.environment!==owner.environment
    ||encodeBuildRequest(request)!==build.request_json||sha256(String(build.request_json))!==permit.requestId
    ||request.sourceRevision!==intent.catalogRevision||request.sourceDigest!==intent.catalogSnapshotSha256
    ||request.codeSha!==intent.codeSha||request.priorReleaseId!==intent.priorReleaseId)
    throw Error('vector_terminal_receipt_invalid');
  const policy=await journal(db,idFor({...owner,phase:'freezing'},{kind:PLAN_KIND}),signal);
  if(!policy)throw Error('vector_terminal_receipt_invalid');
  const admitted=validatePlan(policy,owner,plan,adapters.providerIdentity),history=admitted.plan.history??[];
  const nativeIds=[...reuseIds(admitted.plan),...history.flatMap(group=>group.ids)];
  if(nativeIds.length>OWNED_VECTOR_PROOF_LIMIT)throw Error('vector_terminal_native_bound');
  // Historical selection must not conceal an oversized underlying source read.
  for(const group of history){const prior=await journal(db,group.source.deliveryId,signal),source=prior&&JSON.parse(prior.request_json);
    if(!prior||sha256(canonicalJson(prior))!==group.source.deliverySha256||!source?.plan
      ||reuseIds(source.plan).length>OWNED_VECTOR_PROOF_LIMIT)throw Error('vector_terminal_native_bound');}
  const projection=await read('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?',[plan.catalogRevision]);
  if(canonicalJson(projection)!==canonicalJson(admitted.projectionReceipt)
    ||projection.snapshot_sha256!==intent.catalogSnapshotSha256)throw Error('vector_terminal_receipt_invalid');
  const exact=(table:string,row:Row)=>{const keys=Object.keys(row);
    if(!keys.length||keys.length>65||keys.some(k=>!/^[a-z_][a-z0-9_]*$/.test(k)))throw Error('vector_terminal_receipt_invalid');
    return assertion(db,`EXISTS(SELECT 1 FROM ${table} WHERE ${keys.map(k=>`${k} IS ?`).join(' AND ')})`,keys.map(k=>row[k]));};
  const check=()=>db.batch([mutationAssertion(db,owner,['activating']),
    assertion(db,'EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND activation_request_id=?)',
      [owner.environment,owner.indexName,permit.requestId]),exact('publication_receipts',receipt),exact('publication_outbox',outbox),
    exact('catalog_build_requests',build),exact('catalog_projection_receipts',projection),exact('catalog_vector_deliveries',policy)],{signal});
  await check();
  const observed=await readPlanVectors(db,owner,await planJournals(db,owner,plan.catalogRevision,signal),plan,adapters,undefined,signal,30000);
  await check();return observed;
});}
export function readActivatedCatalogVectors(db:CatalogD1,permit:ActivationPermit,plan:ActivatedVectorPlan,
  adapters:Pick<OwnedVectorAdapters,'readback'|'environment'|'indexName'|'providerIdentity'>,
  options:{signal?:AbortSignal;published?:PublishedCatalogRead;permanent?:PermanentCatalogRevision}={}):Promise<PrunedVectorObservation> {
  return safe(async()=>{
    const {signal}=options;signal?.throwIfAborted();
    const owner=permit.mutationOwner;
    if(!owner||owner.phase!=='activating'||!HASH.test(plan.planSha256)||!plan.ids.every(id=>UUID.test(id))
      ||plan.ids.length>SNAPSHOT_READ_LIMITS.identities||new Set(plan.ids).size!==plan.ids.length)throw new Error('vector_plan_invalid');
    if(options.published){const expected=prunedVectorPlan(options.published.revision);
      if(plan.catalogRevision!==expected.catalogRevision||plan.planSha256!==sha256(canonicalJson(expected))
        ||canonicalJson([...plan.ids].sort())!==canonicalJson(reuseIds(expected).sort()))throw new Error('vector_plan_invalid');
      return readPublishedCatalogVectors({db,owner,published:options.published,adapters,permit,signal});}
    if(options.permanent){const revision=options.permanent,expected=prunedVectorPlan(revision);
      if(plan.catalogRevision!==expected.catalogRevision||plan.planSha256!==sha256(canonicalJson(expected))
        ||canonicalJson([...plan.ids].sort())!==canonicalJson(prunedVectorIds(expected).sort()))throw new Error('vector_plan_invalid');
      const {assertPermanentCatalog}=await import('../../lib/catalog/freeze-permanent-catalog.ts');
      await assertPermanentCatalog(db,owner,revision,permit,signal);
      const observed=await readActivatedPermanentCatalogNative(db,permit,plan,revision,adapters,signal);
      await assertPermanentCatalog(db,owner,revision,permit,signal);return observed;}
    adapterScope(owner,adapters);
    const check=async()=>{signal?.throwIfAborted();await db.batch([mutationAssertion(db,owner,['activating']),assertion(db,`EXISTS(
      SELECT 1 FROM catalog_mutation_scopes s JOIN catalog_build_requests b ON b.request_id=s.activation_request_id
      WHERE s.environment=? AND s.index_name=? AND b.environment=s.environment AND b.state='activating'
      AND b.request_id=? AND b.lease_token=? AND b.run_reference=? AND b.release_id=? AND b.version_reference=?
      AND json_extract(b.request_json,'$.sourceRevision')=?)`,[owner.environment,owner.indexName,
      permit.requestId,permit.token,permit.runReference,permit.releaseId,permit.versionReference,plan.catalogRevision])],{signal});signal?.throwIfAborted();};
    await check();
    const policy=await journal(db,idFor({...owner,phase:'freezing'},{kind:PLAN_KIND}),signal);
    if(policy){
      const request=validatePlan(policy,owner,plan,adapters.providerIdentity),projected:Row[]=[];
      let after='';
      for(let page=0;page<=2*SNAPSHOT_READ_LIMITS.identities;page+=256){
        const chunk=(await db.prepare(`SELECT public_id,catalog_revision,source_facts_hash FROM catalog_public_products
          WHERE eligible_until IS NOT NULL AND eligible_until>(SELECT json_extract(request_json,'$.cutoff') FROM catalog_build_requests WHERE request_id=?)
          AND (catalog_revision=? OR catalog_revision=(SELECT p.catalog_revision FROM catalog_build_requests b JOIN publication_receipts p
            ON p.release_id=json_extract(b.request_json,'$.priorReleaseId') WHERE b.request_id=?))
          AND catalog_revision||':'||public_id>? ORDER BY catalog_revision||':'||public_id LIMIT 256`)
          .bind(permit.requestId,plan.catalogRevision,permit.requestId,after).all<Row>({signal})).results;
        projected.push(...chunk);if(!chunk.length)break;
        after=`${chunk.at(-1)!.catalog_revision}:${chunk.at(-1)!.public_id}`;
        if(projected.length>2*SNAPSHOT_READ_LIMITS.ready)throw new Error('vector_plan_incomplete');
      }
      const receipt=(await db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?').bind(plan.catalogRevision).all<Row>({signal})).results;
      const historical=new Set((request.plan.history??[]).flatMap(group=>group.ids));
      const ready=projected.filter(r=>r.catalog_revision===plan.catalogRevision&&!historical.has(String(r.public_id)));
      if(receipt.length!==1||canonicalJson(receipt[0])!==canonicalJson(request.projectionReceipt)||ready.length!==request.plan.products.length
        ||projected.some(r=>!plan.ids.includes(String(r.public_id)))
        ||request.plan.products.some(p=>!ready.some(r=>r.public_id===p.publicId&&r.source_facts_hash===p.sourceFactsHash)))throw new Error('vector_plan_incomplete');
      const result=await readPlanVectors(db,owner,await planJournals(db,owner,plan.catalogRevision,signal),plan,adapters,undefined,signal,30000);
      await check();return result;
    }
    if(plan.ids.length>OWNED_VECTOR_PROOF_LIMIT)throw new Error('vector_plan_invalid');
    // Do not filter on caller plan hash: doing so could hide a missing/subset
    // proof. Bind ALL of this generation's target-revision journals, and the
    // immutable target/prior projections, before accepting any provider read.
    const rows=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
      AND json_extract(request_json,'$.kind') IN('prune','approved-cohort-reuse') AND json_extract(request_json,'$.catalogRevision')=? LIMIT 21`)
      .bind(owner.environment,owner.indexName,owner.generation,plan.catalogRevision).all<Journal>({signal})).results;signal?.throwIfAborted();
    const projections=(await db.prepare(`SELECT public_id,catalog_revision,source_facts_hash FROM catalog_public_products
      WHERE eligible_until IS NOT NULL AND eligible_until>(SELECT json_extract(request_json,'$.cutoff') FROM catalog_build_requests WHERE request_id=?)
      AND (catalog_revision=? OR catalog_revision=(SELECT p.catalog_revision FROM catalog_build_requests b JOIN publication_receipts p
      ON p.release_id=json_extract(b.request_json,'$.priorReleaseId') WHERE b.request_id=?)) LIMIT 41`)
      .bind(permit.requestId,plan.catalogRevision,permit.requestId).all<{public_id:string;catalog_revision:string;source_facts_hash:string}>({signal})).results;signal?.throwIfAborted();
    const receipt=(await db.prepare(`SELECT p.* FROM catalog_projection_receipts p JOIN catalog_build_requests b
      ON b.source_revision=p.catalog_revision AND json_extract(b.request_json,'$.sourceDigest')=p.snapshot_sha256 WHERE b.request_id=?`)
      .bind(permit.requestId).all<Row>({signal})).results[0];signal?.throwIfAborted();
    const ready=new Map(projections.filter(row=>row.catalog_revision===plan.catalogRevision).map(row=>[row.public_id,row]));
    const reused=rows.filter(row=>JSON.parse(row.request_json).kind===REUSE_KIND);
    if(reused.length){
      if(rows.length!==1||!receipt||projections.length>40||projections.some(row=>!plan.ids.includes(row.public_id)))throw new Error('vector_plan_incomplete');
      const request=validateReuse(reused[0],owner,plan,adapters.providerIdentity);
      if(canonicalJson(request.projectionReceipt)!==canonicalJson(receipt)||request.plan.products.length!==ready.size
        ||request.plan.products.some(p=>!ready.has(p.publicId)||ready.get(p.publicId)!.source_facts_hash!==p.sourceFactsHash)
        ||request.plan.absentIds.some(id=>ready.has(id)))throw new Error('vector_plan_incomplete');
      const observation=await readReuseVectors(db,owner,reused[0],plan,adapters,undefined,signal);await check();return observation;
    }
    const requests=new Map(rows.map(row=>[decodeRequest(row.request_json).publicId,decodeRequest(row.request_json)]));
    if(rows.length!==plan.ids.length||requests.size!==plan.ids.length||rows.some(row=>row.status!=='complete'||row.disposition!=='verified')
      ||!receipt||projections.length>40||projections.some(row=>!plan.ids.includes(row.public_id))
      ||plan.ids.some(id=>!requests.has(id)||requests.get(id)!.catalogRevision!==plan.catalogRevision
        ||requests.get(id)!.planSha256!==plan.planSha256||requests.get(id)!.providerIdentity!==adapters.providerIdentity
        ||canonicalJson(requests.get(id)!.projectionReceipt)!==canonicalJson(receipt)
        ||(ready.has(id)?!requests.get(id)!.vector||requests.get(id)!.vector!.id!==id
          ||requests.get(id)!.vector!.metadata.catalogRevision!==plan.catalogRevision
          ||requests.get(id)!.vector!.metadata.sourceFactsHash!==ready.get(id)!.source_facts_hash:requests.get(id)!.vector!==null)))throw new Error('vector_plan_incomplete');
    await reuseReadback(adapters,new Map(plan.ids.map(id=>[id,requests.get(id)!.vector])),3000,signal);
    await check();
    return{environment:owner.environment,indexName:owner.indexName,settled:true,planSha256:plan.planSha256,
      reference:`owned-vectors:${sha256(canonicalJson(rows.map(row=>row.delivery_id).sort()))}`};
  });
}
/** Explicit revision, at most10 events and one uncertain external intent. A
 * pending/expired outcome stops this invocation; caller keeps the returned owner.
 */
export function drainOwnedVectorOutbox(options: Omit<Parameters<typeof outboxDelivery>[0],'sequence'> & { maxEvents?:number }) {
  return safe(async () => {
    const max=options.maxEvents??5;
    if(!Number.isInteger(max)||max<1||max>10||typeof options.catalogRevision!=='string'
      ||!options.catalogRevision.trim()||Buffer.byteLength(options.catalogRevision)>64)throw new Error('invalid_owned_vector_bound');
    const rows=(await options.db.prepare(`SELECT sequence FROM vector_sync_outbox WHERE source_revision=? AND status='pending'
      ORDER BY sequence LIMIT ?`).bind(options.catalogRevision,max).all<{sequence:number}>()).results;
    if(!rows.length)await options.db.batch([mutationAssertion(options.db,options.owner,['writing'])]);
    let owner=options.owner;const outcomes:DeliveryResult[]=[];
    for(const row of rows){const result=await outboxDelivery({...options,owner,sequence:row.sequence});
      outcomes.push(result);owner=result.owner;if(result.state!=='complete')break;}
    return{owner,outcomes};
  });
}
/** Explicit recovery, never automatic timeout/takeover. Retain the importing
 * revision and its sealed evidence; mark it abandoned ONLY after this owner's
 * expired vector delivery settled. No pending external work/build/publication
 * may exist. A subsequent daily request must have a NEW operation key/cutoff.
 */
export function abandonExpiredPrunedRevision(db:CatalogD1,owner:MutationOwner,revision:PrunedRevision) {
  return safe(async()=>{
    if(owner.phase!=='freezing'||owner.operationKey!==revision.operationKey
      ||revision.request.scope.environment!==owner.environment||revision.request.scope.indexName!==owner.indexName)
      throw new Error('vector_abandonment_invalid');
    const planHash=sha256(canonicalJson(prunedVectorPlan(revision)));const target=revision.snapshot.catalogRevision;
    const rows=(await db.prepare(`SELECT * FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?
      AND status='complete' AND disposition IN('expired','expired_unsubmitted')
      AND json_extract(request_json,'$.kind')='prune' AND json_extract(request_json,'$.planSha256')=? ORDER BY prior_epoch LIMIT 1`)
      .bind(owner.environment,owner.indexName,owner.generation,planHash).all<Journal>()).results;
    const evidence=rows[0];if(!evidence)throw new Error('vector_abandonment_unproven');
    const request=decodeRequest(evidence.request_json);
    if(request.catalogRevision!==target||canonicalJson(request.projectionReceipt)!==canonicalJson(revision.packet.receipt))
      throw new Error('vector_abandonment_unproven');
    const actual=await readMutationOwner(db,owner);
    const stored=(await db.prepare('SELECT * FROM catalog_revisions WHERE revision=?').bind(target).all()).results[0];
    if(stored?.abandonment_delivery_id){
      const ownCommit=actual?.epoch===stored.abandonment_epoch && owner.epoch===Number(stored.abandonment_epoch)-1;
      if(stored.abandonment_delivery_id!==evidence.delivery_id||!actual
        ||canonicalJson({...actual,epoch:owner.epoch})!==canonicalJson(owner)
        ||actual.epoch<Number(stored.abandonment_epoch)||actual.epoch!==owner.epoch&&!ownCommit)throw new Error('vector_owner_changed');
      await db.batch([mutationAssertion(db,actual,['freezing'])]);return{owner:actual,state:'abandoned' as const};
    }
    const next={...owner,epoch:owner.epoch+1};
    const receipt={sql:'SELECT 1 FROM catalog_revisions WHERE revision=? AND abandonment_delivery_id=? AND abandonment_epoch=?',
      params:[target,evidence.delivery_id,next.epoch]};
    try{await db.batch([mutationAssertion(db,owner,['freezing']),
      assertion(db,`EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND request_json=? AND status='complete'
        AND disposition IN('expired','expired_unsubmitted')) AND NOT EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE status='pending')
        AND NOT EXISTS(SELECT 1 FROM catalog_build_requests WHERE source_revision=?)
        AND NOT EXISTS(SELECT 1 FROM publication_receipts WHERE catalog_revision=?)`,[evidence.delivery_id,evidence.request_json,target,target]),
      db.prepare(`UPDATE catalog_revisions SET abandonment_delivery_id=?,abandonment_epoch=? WHERE revision=? AND source_export_sha256=?
        AND status='importing' AND abandonment_delivery_id IS NULL`).bind(evidence.delivery_id,next.epoch,target,revision.sourceDigest),
      assertion(db,`EXISTS(${receipt.sql})`,receipt.params),mutationAdvance(db,owner,receipt),mutationAssertion(db,next,['freezing']),
    ]);}catch{/* Reconcile only this exact abandonment marker + one epoch advance. */}
    const current=await readMutationOwner(db,owner);
    const saved=(await db.prepare(receipt.sql).bind(...receipt.params).all()).results.length;
    if(!saved||!current||canonicalJson(current)!==canonicalJson(next))throw new Error('vector_abandonment_unconfirmed');
    return{owner:current,state:'abandoned' as const};
  });
}
