import { createHash, randomUUID } from 'node:crypto';
import type { CatalogD1, D1Statement } from '../../lib/catalog/storage/d1.ts';
import type { ProductRights } from '../../lib/catalog/types.ts';
import { mutationAssertion, mutationAdvance, readMutationOwner } from '../../lib/catalog/mutation-fence.ts';
import type { MutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { canonicalJson, canonicalTimestamp, EMBEDDING_MODEL, sha256 } from './migration.ts';
import { decodePgvectorSendBase64, encodePgvectorSendBase64 } from './pgvector-binary.ts';
import { createReviewedVectorDelete } from './vector-delete.ts';
import type { ImmutableVectorPayload, VectorEvent } from './vector-outbox.ts';
import { mergeCatalogMaintenanceUpsert } from '../ops/catalog-maintenance-merge.mjs';
import { editorialSourceHash } from '../ops/catalog-editorial-core.mjs';
import { explicitMaintenanceTime, maintenanceDigest, maintenanceEmbeddingText, maintenanceProjection,
  maintenanceRow, maintenanceSlugs, maintenanceState, publishedMaintenanceProduct, snake } from './maintenance-state.ts';
import { maintenanceTimeOrder, refreshPhotoRights } from './maintenance-state.ts';
import type { Row, SemanticProduct } from './maintenance-state.ts';
import { planProductFreshness } from './freshness-selection.ts';
import type { FreshnessSelection } from './freshness-selection.ts';

export interface MaintenanceIntent {
  rightsById?: Record<string, ProductRights>;
  /** Real observation, not a synthetic migration time or rights grant. */
  verificationById?: Record<string, { reference: string; observedAt: string; sourceFactsHash: string | null }>;
  embeddingById?: Record<string, { reference: string; model: typeof EMBEDDING_MODEL; text: string; sourceFactsHash: string }>;
  /** Explicit review authority for the exact intended mutation, included in its hash. */
  reviewedDeleteReference?: string;
}
export interface MaintenanceD1Options {
  db: CatalogD1; owner: MutationOwner; runId: string; catalogRevision: string;
  /** Caller serializes shared catalog/telemetry operations. No DB auto-refresh. */
  ownerCursor?: { current: MutationOwner };
  /** Pure supplied evidence: no provider work is performed by this store. */
  intent?: (method: string, args: unknown[]) => MaintenanceIntent | Promise<MaintenanceIntent>;
  historical?: { archiveSha256: string; embeddingPresence: Record<string, { present: boolean; sourceRecordSha256: string }>;
    overrides?: Record<string, { product: SemanticProduct; evidence: string }> };
  newPublicId?: () => string;
  /** D1 daily only. Retailer eligibility cannot revoke existing cleared curation. */
  preservePermanentListings?: boolean;
}
type Loaded = { row: Row; product: SemanticProduct; version: number; present: boolean | null; native: string | null; provenance: Row;
  privateState: unknown[] };
type Receipt = { input_sha256: string; result_json: string; environment: string; index_name: string; generation: number; prior_epoch: number; next_epoch: number };
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const KEY = /^[a-zA-Z0-9._:/-]{1,200}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
export const PHOTO_EXPIRY_SQL = `CASE WHEN json_extract(p.rights_json,'$.persistent.imageUrl.value')='/images/gift-placeholder.svg'
  AND json_extract(p.rights_json,'$.imageUrl.basis')='merchant' THEN json_extract(p.rights_json,'$.imageUrl.expiresAt') END`;
const UPSERT_INPUT = ['id','title','price','currency','imageUrl','affiliateUrl','source','sourceQuery','humorTags','punnyTitle',
  'wittyDescription','qualityScore','rating','reviewCount','isActive','embedding','remotelyVerified','editorialWriteup','sourceFacts',
  'editorialSourceHash','availabilityStatus','editorialStatus','editorialQualityScore','editorialModel','editorialPromptVersion',
  'editorialGeneratedAt','editorialBlockReason','duplicateOfProductId'];
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const compare = (a: unknown, b: unknown): number => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
const idsInput = (ids: string[]) => {
  if (!Array.isArray(ids) || ids.length > 50 || ids.some(id => typeof id !== 'string' || !id || id.length > 255)) throw new Error('maintenance_id_bound');
  return [...new Set(ids)];
};
function assertion(db: CatalogD1, sql: string, params: unknown[] = []): D1Statement {
  if (params.length > 100) throw new Error('maintenance_parameter_bound');
  return db.prepare(`SELECT json(CASE WHEN ${sql} THEN 'true' ELSE 'maintenance_conflict' END)`).bind(...params);
}
function sameOwner(a: MutationOwner | null, b: MutationOwner): boolean {
  return Boolean(a && a.token === b.token && a.generation === b.generation && a.phase === 'writing'
    && a.environment === b.environment && a.indexName === b.indexName && a.operationKey === b.operationKey
    && a.ownerReference === b.ownerReference);
}

/** Explicit opt-in store for executeCatalog(..., store). Requires a primary D1
 * session and the shared writing owner. No PG fallback, credentials, providers,
 * telemetry-run writer, schedule, or publication dispatch is installed here.
 * Historical presence entries bind the exact immutable nonvector source JSON
 * bytes to a separately pinned archive; unknown is never treated as absent.
 * The pure evidence callback supplies reviewed exact-value rights/observations/
 * embedding input receipts. Missing evidence keeps display held. Owner/run time
 * never renews merchant expiry. remotelyVerified claims retain PG merge times
 * but are marked unverified_claim without real observation evidence.
 * Replays reuse persisted DBtime/result; changed intended values are a new op.
 * Read the current owner via readMutationOwner before a separate handoff. This
 * store does not enable/claim/release scope ownership or choose another backend.
 */
export function createD1CatalogMaintenanceStore(options: MaintenanceD1Options) {
  const { db, runId, catalogRevision } = options;
  let owner = Object.freeze({ ...options.owner }); let tail: Promise<unknown> = Promise.resolve();
  if (!KEY.test(runId) || !KEY.test(catalogRevision) || catalogRevision.length > 64 || owner.phase !== 'writing'
    || options.historical && !HASH.test(options.historical.archiveSha256)
    || options.preservePermanentListings!==undefined&&typeof options.preservePermanentListings!=='boolean') throw new Error('maintenance_configuration');
  const prepare = (sql: string, params: unknown[] = []) => {
    if (params.length > 100 || params.some(value => typeof value === 'string' && Buffer.byteLength(value)>128*1024)) throw new Error('maintenance_parameter_bound');
    return db.prepare(sql).bind(...params);
  };
  const all = async <T = Row>(sql: string, params: unknown[] = []) => (await prepare(sql, params).all<T>()).results;
  const checkOwner = async () => {
    const current = await readMutationOwner(db, owner);
    if (!sameOwner(current, owner) || current!.epoch !== owner.epoch) throw new Error('maintenance_fenced');
    try { await mutationAssertion(db,owner).all(); } catch { throw new Error('maintenance_fenced'); }
  };
  const decode = (row: Row): Loaded => {
    const product = maintenanceState(row, options.historical?.overrides?.[String(row.id)]);
    const explicit = options.historical?.embeddingPresence[String(row.public_id)];
    if (explicit && (typeof explicit.present !== 'boolean' || explicit.sourceRecordSha256 !== sha256(String(row.source_record_json)))) throw new Error('maintenance_embedding_inventory_mismatch');
    const present = row.maintenance_version !== null ? row.maintenance_present === null ? null : row.maintenance_present === 1
      : explicit ? explicit.present : null;
    return { row: Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('maintenance_'))), product,
      version: Number(row.maintenance_version || 0), present, native: row.maintenance_native as string | null,
      privateState:[row.maintenance_version,row.maintenance_semantic,row.maintenance_present,row.maintenance_native,row.maintenance_provenance],
      provenance: row.maintenance_provenance ? JSON.parse(String(row.maintenance_provenance))
        : { input: 'unverified', archiveSha256: options.historical?.archiveSha256 || null } };
  };
  const SELECT = `SELECT p.*,s.version maintenance_version,s.semantic_json maintenance_semantic,
    s.embedding_present maintenance_present,s.embedding_native_base64 maintenance_native,
    s.embedding_provenance_json maintenance_provenance FROM products p LEFT JOIN catalog_maintenance_products s ON s.product_id=p.id`;
  const load = async (id: string): Promise<Loaded | null> => {
    const rows = await all(`${SELECT} WHERE p.id=?`, [id]); return rows[0] ? decode(rows[0]) : null;
  };
  // Catalog views use semantic/presence evidence, never native vector bytes or
  // their provenance. Exact point-load/write/CAS continues to use SELECT above.
  const CATALOG_SELECT = `SELECT p.*,s.version maintenance_version,s.semantic_json maintenance_semantic,
    s.embedding_present maintenance_present,NULL maintenance_native,NULL maintenance_provenance
    FROM products p LEFT JOIN catalog_maintenance_products s ON s.product_id=p.id`;
  const catalog = async () => {
    await checkOwner(); const values: Loaded[] = []; let after = ''; let bytes = 0; let page = 10;
    for (;;) {
      let rows: Row[];
      try { rows = await all(`${CATALOG_SELECT} WHERE p.id>? ORDER BY p.id LIMIT ?`, [after,page]); }
      catch (error) {
        // Retry ONLY this read-only keyset query, without advancing its cursor.
        // The transport retains unknown usage; success cannot erase that gap.
        if (error instanceof Error && error.message === 'catalog_d1_result_unknown' && page > 1) {
          page = Math.floor(page / 2); continue;
        }
        throw error;
      }
      for (const row of rows) {
        bytes += Buffer.byteLength(canonicalJson(row));
        if (values.length >= 10000 || bytes > 64 * 1024 * 1024) throw new Error('maintenance_catalog_bound');
        values.push(decode(row));
      }
      if (rows.length < page) break; after = String(rows.at(-1)!.id);
    }
    await checkOwner(); return values;
  };
  // Read-only purpose projections, not persistence inputs. Keep the existing
  // semantic/typed consistency checks, without shipping source facts, native
  // vectors, rights or complete archive/current JSON for every identity.
  const catalogView = async (fields: string[],preferBase=false,publicOnly=false) => {
    const typed = ['id','public_id','slug','source','is_active','quality_score','source_facts_hash','editorial_source_hash',
      'availability_status','editorial_status','duplicate_of_product_id','availability_checked_at','last_verified_at','created_at','updated_at'];
    const semantic = [...new Set(['id','publicId','slug','source','isActive','qualityScore','sourceFactsHash','editorialSourceHash',
      'availabilityStatus','editorialStatus','duplicateOfProductId','availabilityCheckedAt','lastVerifiedAt','createdAt','updatedAt',
      'title','affiliateUrl',...fields])];
    const archive = [...new Set(['id','public_id','slug','title','affiliate_url',...fields.map(snake)])];
    const project = (column: string, keys: string[]) => `json_object(${keys.map(key => `'${key}',json(${column}->'$.${key}')`).join(',')})`;
    const data = `json_object(${typed.map(key => `'${key}',p.${key}`).join(',')},
      'preferredTitle',${preferBase&&options.preservePermanentListings?`CASE WHEN json_type(p.public_display_json,'$.eligibleUntil')='null'
        THEN json_extract(p.public_display_json,'$.title') ELSE json_extract(p.public_display_json,'$.persistent.title') END`:'NULL'},
      'photoExpiresAt',${publicOnly?PHOTO_EXPIRY_SQL:'NULL'},
      'archive',json(CASE WHEN s.semantic_json IS NULL THEN ${project('p.source_record_json',archive)} ELSE NULL END),
      'semantic',json(CASE WHEN s.semantic_json IS NULL THEN NULL ELSE ${project('s.semantic_json',semantic)} END),
      'invalidSemantic',s.semantic_json IS NOT NULL AND (${semantic.map(key => `json_type(s.semantic_json,'$.${key}') IS NULL`).join(' OR ')}))`;
    await checkOwner(); const values: SemanticProduct[] = []; let after = ''; let bytes = 0; let page = 128;
    for (;;) {
      let rows: Row[];
      try {
        rows = await all(`WITH candidates AS MATERIALIZED (
          SELECT p.id,${data} data FROM products p LEFT JOIN catalog_maintenance_products s ON s.product_id=p.id
          WHERE p.id>?${publicOnly?' AND p.public_display_json IS NOT NULL':''} ORDER BY p.id LIMIT ?), sized AS MATERIALIZED (
          SELECT id,data,length(CAST(json_quote(data) AS BLOB))+32 wire_bytes FROM candidates), bounded AS (
          SELECT id,data,wire_bytes,sum(wire_bytes) OVER(ORDER BY id) total_bytes FROM sized)
          SELECT CASE WHEN wire_bytes>256*1024 THEN '{"oversized":true}' ELSE data END data FROM bounded
          WHERE total_bytes<=384*1024 OR id=(SELECT min(id) FROM candidates) ORDER BY id`,[after,page]);
      } catch (error) {
        if (error instanceof Error && error.message === 'catalog_d1_result_unknown' && page > 1) { page = Math.floor(page/2); continue; }
        throw error;
      }
      if (!rows.length) break;
      for (const row of rows) {
        if (typeof row.data !== 'string') throw new Error('maintenance_catalog_bound');
        bytes += Buffer.byteLength(row.data);
        if (values.length >= 10000 || bytes > 64*1024*1024) throw new Error('maintenance_catalog_bound');
        const view = JSON.parse(row.data);
        if (view.oversized) throw new Error('maintenance_catalog_bound');
        if (view.invalidSemantic) throw new Error('maintenance_current_state_drift');
        // maintenanceState expects a PG text[] even though these views do not
        // consume tags. Full selected point-loads still validate their real tags.
        const product=maintenanceState({...view,source_record_json:JSON.stringify({...view.archive,humor_tags:null}),
          maintenance_semantic:view.semantic === null ? null : JSON.stringify(view.semantic)},options.historical?.overrides?.[String(view.id)]);
        // Discovery identity/family dedup only; never overwrite semantic source
        // fields or use this read-only label as public clearance.
        if(preferBase&&options.preservePermanentListings&&typeof view.preferredTitle==='string'&&view.preferredTitle.trim())product.title=view.preferredTitle;
        if(typeof view.photoExpiresAt==='string')product.photoExpiresAt=view.photoExpiresAt;
        values.push(product);
      }
      after = String(values.at(-1)!.id);
    }
    await checkOwner(); return values;
  };
  const currentReceipt = async (operationId: string, inputHash: string): Promise<{ result: unknown } | null> => {
    const receipt = (await all<Receipt>('SELECT * FROM catalog_maintenance_operations WHERE operation_id=?', [operationId]))[0];
    if (!receipt) return null;
    if (receipt.input_sha256 !== inputHash || receipt.environment !== owner.environment || receipt.index_name !== owner.indexName) throw new Error('maintenance_receipt_mismatch');
    const current = await readMutationOwner(db, owner);
    const ownCommit=receipt.generation===owner.generation && receipt.prior_epoch===owner.epoch && current?.epoch===receipt.next_epoch;
    if (!sameOwner(current, owner) || current!.epoch < receipt.next_epoch || (!ownCommit && current!.epoch!==owner.epoch)) throw new Error('maintenance_fenced');
    owner = Object.freeze(current!);
    if (options.ownerCursor) options.ownerCursor.current=owner;
    return { result: JSON.parse(receipt.result_json) };
  };
  async function write<T>(method: string, rawArgs: unknown[], build: (args: unknown[], intent: MaintenanceIntent, now: string,
    statements: D1Statement[], operationId: string, changes: Row[]) => Promise<T>): Promise<T> {
    const args = copy(rawArgs); const intent = copy(await options.intent?.(method, copy(args)) || {});
    const inputHash = maintenanceDigest({ method, args, intent, runId, catalogRevision, environment: owner.environment, indexName: owner.indexName,
      ...(options.preservePermanentListings?{listingPolicy:'permanent-base-v1'}:{}) });
    const operationId = sha256(`${runId}:${inputHash}`);
    const replay = await currentReceipt(operationId, inputHash); if (replay) return replay.result as T;
    await checkOwner();
    // Capture once AFTER the replay lookup; lost committed responses never create
    // a new write time or a new generated identity on retry.
    const now = String((await all<{ now: string }>(`SELECT ${NOW} now`))[0].now);
    explicitMaintenanceTime(now);
    const statements: D1Statement[] = [mutationAssertion(db, owner)]; const changes: Row[] = [];
    const result = await build(args, intent, now, statements, operationId, changes);
    const next = { ...owner, epoch: owner.epoch + 1 };
    statements.push(prepare(`INSERT INTO catalog_maintenance_operations(operation_id,input_sha256,run_id,catalog_revision,
      environment,index_name,generation,prior_epoch,next_epoch,database_time,result_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    [operationId,inputHash,runId,catalogRevision,owner.environment,owner.indexName,owner.generation,owner.epoch,next.epoch,now,canonicalJson(result ?? null),canonicalJson(changes)]));
    statements.push(mutationAdvance(db, owner, { sql: `SELECT 1 FROM catalog_maintenance_operations WHERE operation_id=? AND input_sha256=?
      AND environment=? AND index_name=? AND generation=? AND prior_epoch=? AND next_epoch=?`,
    params: [operationId,inputHash,owner.environment,owner.indexName,owner.generation,owner.epoch,next.epoch] }), mutationAssertion(db, next));
    if (statements.length > 1000 || Buffer.byteLength(canonicalJson({args,intent,changes}))>750*1024) throw new Error('maintenance_batch_bound');
    try { await db.batch(statements); }
    catch {
      const saved = await currentReceipt(operationId,inputHash); if (saved) return saved.result as T;
      throw new Error('maintenance_conflict');
    }
    const saved = await currentReceipt(operationId,inputHash); if (!saved) throw new Error('maintenance_receipt_missing');
    return saved.result as T;
  }
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const work = tail.then(() => {
      if (options.ownerCursor) {
        if (!sameOwner(options.ownerCursor.current,options.owner)) throw new Error('maintenance_fenced');
        owner=Object.freeze({...options.ownerCursor.current});
      }
      return operation();
    }); tail = work.catch(() => {}); return work;
  };
  function cas(old: Loaded | null, id: string, statements: D1Statement[]) {
    if (!old) { statements.push(assertion(db,'NOT EXISTS(SELECT 1 FROM products WHERE id=?)',[id])); return; }
    const fields = Object.keys(old.row);
    statements.push(assertion(db,`EXISTS(SELECT 1 FROM products WHERE ${fields.map(key => `${key} IS ?`).join(' AND ')})
      AND ${old.version ? `EXISTS(SELECT 1 FROM catalog_maintenance_products WHERE product_id=? AND version IS ? AND semantic_json IS ?
        AND embedding_present IS ? AND embedding_native_base64 IS ? AND embedding_provenance_json IS ?)`
      : 'NOT EXISTS(SELECT 1 FROM catalog_maintenance_products WHERE product_id=?)'}`,
    [...fields.map(key => old.row[key]),id,...(old.version ? old.privateState : [])]));
  }
  async function persist(old: Loaded | null, product: SemanticProduct, intent: MaintenanceIntent, now: string,
    statements: D1Statement[], operationId: string, changes: Row[], replacedEmbedding = false) {
    cas(old,product.id,statements);
    const supplied = replacedEmbedding ? product.embedding as number[] : null;
    const proof = intent.embeddingById?.[product.id];
    const savedText=proof?.text ?? old?.provenance?.text;
    const text = maintenanceEmbeddingText(product,typeof savedText==='string'?savedText:undefined);
    const factsMatch = HASH.test(product.sourceFactsHash || '') && editorialSourceHash(product) === product.sourceFactsHash;
    if (proof && (!proof.reference?.trim() || proof.reference.length>200 || proof.model !== EMBEDDING_MODEL || proof.text !== text
      || Buffer.byteLength(text)>64000
      || proof.sourceFactsHash !== product.sourceFactsHash || !factsMatch || !supplied)) throw new Error('maintenance_embedding_proof');
    const previous = old?.provenance;
    const carry = !replacedEmbedding && old?.native && previous?.input === 'verified' && previous.model === EMBEDDING_MODEL
      && typeof previous.reference === 'string' && previous.reference.trim() && previous.text === text
      && previous.embeddingTextHash === sha256(text) && previous.embeddingTextHash === old.row.embedding_text_hash
      && previous.sourceFactsHash === product.sourceFactsHash
      && createHash('sha256').update(Buffer.from(old.native,'base64')).digest('hex') === previous.vectorBytesSha256;
    const known = factsMatch && Boolean(proof || carry);
    const binding = known ? sha256(text) : null;
    const observation = intent.verificationById?.[product.id];
    if (observation && (!observation.reference?.trim() || observation.sourceFactsHash !== product.sourceFactsHash
      || !observation.observedAt.endsWith('Z') || explicitMaintenanceTime(observation.observedAt) > explicitMaintenanceTime(now))) throw new Error('maintenance_verification_proof');
    let rights = intent.rightsById?.[product.id] ?? (old ? JSON.parse(String(old.row.rights_json)) : {});
    if(old&&observation&&options.preservePermanentListings&&!intent.rightsById?.[product.id])
      rights=refreshPhotoRights(product,rights,observation,now,old);
    const timeProof = old ? JSON.parse(String(old.row.timestamp_provenance_json)) : { schemaVersion:1,fields:{} };
    timeProof.fields ||= {};
    for (const key of ['availabilityCheckedAt','lastVerifiedAt','updatedAt','createdAt']) {
      const column = key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
      if (product[key] !== null && product[key] !== old?.product[key]) {
        explicitMaintenanceTime(product[key]);
        timeProof.fields[column] = { state: key === 'availabilityCheckedAt' || key === 'lastVerifiedAt'
          ? observation ? 'evidenced' : 'unverified_claim' : 'evidenced', basis:'maintenance_operation', operationId,
        ...(observation ? { reference:observation.reference,observedAt:observation.observedAt,sourceFactsHash:observation.sourceFactsHash } : {}) };
      }
    }
    if (product.editorialGeneratedAt !== old?.product.editorialGeneratedAt && product.editorialGeneratedAt !== null) explicitMaintenanceTime(product.editorialGeneratedAt);
    const verification = product.availabilityCheckedAt || product.lastVerifiedAt;
    const verifiedColumn = product.availabilityCheckedAt ? 'availability_checked_at' : 'last_verified_at';
    const evidence=timeProof.fields[verifiedColumn];
    const archived=old ? JSON.parse(String(old.row.source_record_json)) : null;
    const archivedFactsMatch=Boolean(archived && archived.id === product.id && archived.public_id === product.publicId
      && archived.source_facts_hash === product.sourceFactsHash);
    let merchantVerification=false;
    try { merchantVerification=Boolean(archivedFactsMatch && (evidence?.basis !== 'maintenance_operation' || evidence.sourceFactsHash === product.sourceFactsHash)
      && rights.imageUrl?.basis === 'merchant' && rights.imageUrl.observedAt && verification
      && canonicalTimestamp(rights.imageUrl.observedAt) === canonicalTimestamp(verification)); } catch { /* Unknown is not evidence. */ }
    const observedVerification=observation?.observedAt || (evidence?.state === 'evidenced'
      ? evidence.basis === 'maintenance_operation'
        ? evidence.sourceFactsHash === product.sourceFactsHash ? evidence.observedAt || null : null
        : archivedFactsMatch ? verification : null
      : null) || (merchantVerification ? rights.imageUrl!.observedAt! : null);
    const projection = maintenanceProjection(product,rights,catalogRevision,now,known && factsMatch && Boolean(observedVerification),observedVerification,old ?? undefined,options.preservePermanentListings);
    if (projection.persistentBase) product.persistentBase=projection.persistentBase;
    const row: Row = { ...projection.row,embedding_text_hash:binding,timestamp_provenance_json:canonicalJson(timeProof),
      source_record_json: old?.row.source_record_json ?? canonicalJson({ kind:'maintenance_creation',schemaVersion:1,operationId,
        id:product.id,public_id:product.publicId,slug:product.slug,source:product.source,product:{...product,embedding:null} }) };
    const pending = (await all<{sequence:number}>('SELECT sequence FROM vector_sync_outbox WHERE public_id=? AND status=\'pending\' ORDER BY sequence',[product.publicId])).map(value => value.sequence);
    if (pending.length>20) throw new Error('maintenance_pending_bound');
    statements.push(assertion(db,`(SELECT count(*) FROM vector_sync_outbox WHERE public_id=? AND status='pending')=?
      AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE public_id=? AND status='pending' AND sequence NOT IN(SELECT value FROM json_each(?)))`,
    [product.publicId,pending.length,product.publicId,canonicalJson(pending)]));
    // No dispatched/leased pending work may be rewritten. A complete event from
    // this same revision also requires a new revision, not an identity overwrite.
    statements.push(assertion(db,`NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE public_id=? AND
      ((status='pending' AND (attempts<>0 OR lease_token IS NOT NULL OR lease_until IS NOT NULL OR mutation_reference IS NOT NULL))
        OR (source_revision=? AND status='complete')))`,[product.publicId,catalogRevision]));
    const columns = Object.keys(row); const updates = columns.filter(key => !['id','public_id','slug','source_record_json'].includes(key));
    statements.push(prepare(old ? `UPDATE products SET ${updates.map(key => `${key}=?`).join(',')} WHERE id=?`
      : `INSERT INTO products(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`,
    old ? [...updates.map(key => row[key]),product.id] : columns.map(key => row[key])));
    statements.push(assertion(db,`EXISTS(SELECT 1 FROM products WHERE ${columns.map(key => `${key} IS ?`).join(' AND ')})`,columns.map(key => row[key])));
    const native = supplied ? encodePgvectorSendBase64(supplied) : old?.native || null;
    const present = supplied ? true : old ? old.present : false;
    const provenance = proof ? { input:'verified',reference:proof.reference,model:proof.model,text,sourceFactsHash:proof.sourceFactsHash,
      embeddingTextHash:binding,vectorBytesSha256:createHash('sha256').update(Buffer.from(native!, 'base64')).digest('hex') }
      : replacedEmbedding ? { input:'unverified',operationId } : old?.provenance || { input:'absent' };
    const semantic = { ...product,embedding:null };
    statements.push(prepare(`INSERT INTO catalog_maintenance_products(product_id,version,semantic_json,embedding_present,embedding_native_base64,embedding_provenance_json)
      VALUES(?,?,?,?,?,?) ON CONFLICT(product_id) DO UPDATE SET version=excluded.version,semantic_json=excluded.semantic_json,
      embedding_present=excluded.embedding_present,embedding_native_base64=excluded.embedding_native_base64,embedding_provenance_json=excluded.embedding_provenance_json`,
    [product.id,(old?.version || 0)+1,canonicalJson(semantic),present === null ? null : present ? 1 : 0,native,canonicalJson(provenance)]));
    statements.push(prepare(`DELETE FROM vector_sync_outbox WHERE public_id=? AND status='pending' AND attempts=0
      AND lease_token IS NULL AND lease_until IS NULL AND mutation_reference IS NULL`,[product.publicId]));
    const unchanged = old && !replacedEmbedding && ['title','currency','imageUrl','affiliateUrl','source','sourceQuery','humorTags',
      'punnyTitle','wittyDescription','qualityScore','isActive','editorialWriteup','sourceFacts','sourceFactsHash','editorialSourceHash',
      'availabilityStatus','editorialStatus','editorialQualityScore','editorialBlockReason','duplicateOfProductId']
      .every(key=>canonicalJson(product[key] ?? null)===canonicalJson(old.product[key] ?? null))
      && canonicalJson({...rights,persistent:null})===canonicalJson({...JSON.parse(String(old.row.rights_json)),persistent:null});
    // Only positive native evidence can require index work. A public listing or
    // unknown historical presence is not a vector: ordinary refreshes must not
    // queue speculative deletes (or require a deletion review) for those rows.
    // Time passing alone still cannot authorize vector deletion.
    // Changed supplier input can invalidate semantic eligibility, but must not
    // delete a cleared listing's old native vector or pretend it is fresh.
    const preservedListing = options.preservePermanentListings
      && projection.persistentBase && projection.row.public_display_json !== null;
    const needsDelete = !projection.semanticEligible && !unchanged && !preservedListing
      && Boolean(old && (old.present === true || old.row.embedding_text_hash));
    const operation = projection.semanticEligible ? 'upsert' : needsDelete ? 'delete' : null;
    if (operation) {
      let payload: Row; let deleteHash: string | null = null;
      if (operation === 'delete' && binding === null) {
        if (!intent.reviewedDeleteReference?.trim()) throw new Error('maintenance_delete_review_required');
        const mutation = createReviewedVectorDelete(row,{reviewedAt:now,reviewReference:intent.reviewedDeleteReference});
        const bytes = canonicalJson(mutation); deleteHash = sha256(bytes);
        statements.push(prepare(`INSERT INTO vector_delete_mutations(mutation_sha256,public_id,source_revision,mutation_json) VALUES(?,?,?,?)
          ON CONFLICT(mutation_sha256) DO NOTHING`,
          [deleteHash,product.publicId,catalogRevision,bytes]));
        statements.push(assertion(db,`EXISTS(SELECT 1 FROM vector_delete_mutations WHERE mutation_sha256=? AND public_id=? AND source_revision=? AND mutation_json=?)`,
          [deleteHash,product.publicId,catalogRevision,bytes]));
        payload = { publicId:product.publicId,catalogRevision,embeddingTextHash:null,operation,deleteMutationSha256:deleteHash,mutation };
      } else {
        if (!binding || !known || operation === 'upsert' && !native) throw new Error('maintenance_vector_provenance_missing');
        payload = { publicId:product.publicId,catalogRevision,embeddingTextHash:binding,operation,model:EMBEDDING_MODEL,
          embeddingText:text,sourceFactsHash:product.sourceFactsHash };
        if (operation === 'upsert') {
          const bytes = Buffer.from(native!,'base64');
          // Canonical JSON numbers lose signed zero. Persist immutable native
          // bytes, not a second lossy numeric serialization of the same vector.
          payload.nativeBase64 = native;
          // Native bytes, not UTF-8 serialization of arbitrary binary data.
          payload.vectorBytesSha256 = createHash('sha256').update(bytes).digest('hex');
        }
      }
      statements.push(prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at,delete_mutation_sha256)
        VALUES(?,?,?,?,?,?)`,[product.publicId,catalogRevision,binding,operation,now,deleteHash]));
      statements.push(prepare(`INSERT INTO catalog_maintenance_vector_payloads(sequence,operation_id,payload_json)
        SELECT sequence,?,json_set(?,'$.sequence',sequence) FROM vector_sync_outbox WHERE public_id=? AND source_revision=? AND operation=?`,
      [operationId,canonicalJson(payload),product.publicId,catalogRevision,operation]));
    }
    changes.push({productId:product.id,beforeSha256:old ? maintenanceDigest(old.row) : null,afterSha256:maintenanceDigest(row),
      privateStateSha256:maintenanceDigest(semantic),supersededUnsentSequences:pending,vectorOperation:operation});
  }
  async function change(method: string,args: unknown[], mutate: (p: SemanticProduct,now: string) => boolean) {
    return write(method,args,async (values,intent,now,statements,operationId,changes) => {
      const ids = idsInput(values[0] as string[]); const updated: string[] = [];
      for (const id of ids) {
        const old = await load(id); if (!old) continue;
        const p = copy(old.product); if (!mutate(p,now)) continue;
        await persist(old,p,intent,now,statements,operationId,changes); updated.push(id);
      }
      return updated;
    });
  }
  const store = {
    upsertProduct: async (incoming: object, sourceFactsHash: string | null): Promise<{inserted:boolean;slug:string}> => {
      // Ignore fields the PG statement never binds (e.g. revalidatedProduct's
      // transient availabilityCheckedAt Date), so retrying identical SQL intent
      // cannot get a new operation merely from rebuilding those unused fields.
      const values=incoming as Row;
      for (const key of ['price','qualityScore','rating','reviewCount','editorialQualityScore']) {
        const value=values[key];
        if (typeof value === 'number' && (!Number.isFinite(value) && (!Number.isNaN(value) || ['price','qualityScore'].includes(key)))) throw new Error('maintenance_nonfinite_number');
      }
      const tags=values.humorTags;
      if (!Array.isArray(tags) || Array.from(tags).some((_,index) => !(index in tags))) throw new Error('maintenance_tag_array');
      const input = copy(Object.fromEntries(UPSERT_INPUT.filter(key => values[key] !== undefined).map(key => [key,
        key === 'humorTags' ? tags.map(String) : values[key]])));
      // Existing JSON/PG coercions normalize -0. Bind its ORIGINAL native bytes
      // separately when present, so neither retry hashing nor the merge's text
      // conversion silently changes a newly supplied vector's float32 identity.
      let originalNative: string | undefined;
      if (Array.isArray(values.embedding) && values.embedding.some(value => Object.is(value,-0))) {
        if (values.embedding.length !== 1536 || !Array.from(values.embedding).every(value => typeof value === 'number' && Number.isFinite(value)))
          throw new Error('maintenance_vector_input_invalid');
        originalNative = encodePgvectorSendBase64(values.embedding.map(value => Math.fround(value)));
      }
      return serialize(() => write('upsertProduct',[input,sourceFactsHash,...(originalNative ? [originalNative] : [])],
      async (args,intent,now,statements,operationId,changes) => {
        const p = args[0] as SemanticProduct; const old = await load(p.id);
        if (p.remotelyVerified === false && intent.verificationById?.[p.id]) throw new Error('maintenance_verification_proof');
        const merged = mergeCatalogMaintenanceUpsert(old?.product || null,p,{sourceFactsHash:args[1],databaseTime:now});
        const product = merged.product;
        if(options.preservePermanentListings){
          product.supplierEligible=product.isActive;
          if(old?.product.isActive&&!product.isActive&&!['blocked','needs_review'].includes(old.product.editorialStatus)){
            const candidate={...product,isActive:true},rights=intent.rightsById?.[product.id]??JSON.parse(String(old.row.rights_json));
            const base=maintenanceProjection(candidate,rights,catalogRevision,now,false,null,old);
            if(base.row.public_display_json!==null)product.isActive=true;
          }
        }
        if (args[2]) product.embedding = decodePgvectorSendBase64(args[2]);
        if (!old) {
          product.publicId = (options.newPublicId || randomUUID)().toLowerCase(); if (!UUID.test(product.publicId)) throw new Error('maintenance_public_id');
          const candidates = maintenanceSlugs(product,product.publicId);
          const reserved = new Set((await all<{slug:string}>(`SELECT slug FROM products WHERE slug IN(SELECT value FROM json_each(?))
            UNION ALL SELECT slug FROM product_slug_history WHERE slug IN(SELECT value FROM json_each(?))`,[canonicalJson(candidates),canonicalJson(candidates)])).map(row => row.slug));
          product.slug = candidates.find(slug => !reserved.has(slug)); if (!product.slug) throw new Error('maintenance_slug_exhausted');
        }
        await persist(old,product,intent,now,statements,operationId,changes,Array.isArray(p.embedding) && p.embedding.length > 0);
        return {inserted:merged.inserted,slug:product.slug};
      }));
    },
    getActiveCatalogIdentities: ({includeInactive=false}: {includeInactive?:boolean} = {}) => serialize(async () => (await catalogView(['imageUrl','reviewCount'],true)).filter(p => includeInactive || p.isActive && p.title !== '')
      .map(p => Object.fromEntries(['id','slug','title','imageUrl','affiliateUrl','qualityScore','availabilityStatus','availabilityCheckedAt',
        'lastVerifiedAt','editorialStatus','reviewCount'].map(key => [key,p[key]]))).map(p => ({...p,sourceFacts:null}))),
    getExistingEditorialWriteups: (excludedIds: string[] = []) => serialize(async () => (await catalogView(['editorialWriteup']))
      .filter(p => ['generated_ready','manual_locked'].includes(p.editorialStatus) && p.editorialWriteup !== null && !excludedIds.includes(p.id))
      .map(p => p.editorialWriteup).filter(Boolean)),
    getAffiliateUrlMismatches: (tag: string) => serialize(async () => (await catalog()).map(value => value.product)
      .filter(p => p.source === 'amazon' && /^[A-Z0-9]{10}$/.test(p.id)
        && (!p.affiliateUrl.includes(p.id) || !p.affiliateUrl.includes(`tag=${tag}`)))
      .map(p => ({id:p.id,affiliate_url:p.affiliateUrl}))),
    updateAmazonAffiliateUrl: (id: string,url: string) => serialize(async () => (await change('updateAmazonAffiliateUrl',[[id],url],(p,now) => {
      p.affiliateUrl=url; p.updatedAt=now; return true;
    }) as string[]).length),
    // Explicit read-only planning seam. The existing ten-item selector below
    // remains unchanged; a coordinator must pin this plan before dispatching it.
    planProductFreshness: (selection: FreshnessSelection = {}) => serialize(async () => {
      const products = (await catalogView([],false,true)).map(p => ({
        id:p.id,source:p.source,isActive:p.isActive,publiclyCleared:true,
        duplicateOfProductId:p.duplicateOfProductId,availabilityStatus:p.availabilityStatus,
        availabilityCheckedAt:p.availabilityCheckedAt,
        photoExpiresAt:typeof p.photoExpiresAt==='string'?p.photoExpiresAt:null,
      }));
      const now = String((await all<{now:string}>(`SELECT ${NOW} now`))[0].now);
      const plan = planProductFreshness(products,now,selection);
      await checkOwner();return plan;
    }),
    getProductsForRevalidation: (selection: {limit:number;daily:true;featuredIds?:string[];photosOnly?:true;selectedIds?:string[]}
      | {limit:number;staleDays:number;publishedStaleDays:number;publishedSlots:number;legacySlots:number;daily?:never}) => serialize(async () => {
      if(selection.daily){
        const {limit,featuredIds=[]}=selection;
        if(!Number.isInteger(limit)||limit<1||limit>10||featuredIds.length>100||featuredIds.some(id=>!(/^[A-Z0-9]{10}$/).test(id)))throw new Error('daily_selection_invalid');
        if(selection.selectedIds!==undefined){
          const ids=selection.selectedIds;
          if(!Array.isArray(ids)||ids.length!==limit||new Set(ids).size!==ids.length
            ||ids.some(id=>typeof id!=='string'||!(/^[A-Z0-9]{10}$/).test(id)))throw new Error('daily_selection_invalid');
          await checkOwner();const rows=[];
          // Only a coordinator's pinned plan may use this exact technical
          // batch. A changed/missing member fails, never substitutes a gift.
          for(const id of ids){
            const full=await load(id),p=full?.product;
            if(!full||!p||full.row.public_display_json===null||p.source!=='amazon'||!p.isActive||p.duplicateOfProductId)
              throw new Error('daily_selection_changed');
            rows.push({...maintenanceRow(p),has_embedding:full.present});
          }
          await checkOwner();return rows;
        }
        // Public clearance is the stored display, not long-article readiness.
        // Keep six slots for the rest of the catalog so featured gifts cannot
        // monopolize every batch; sparse lanes lend their unused slots.
        const featured=new Set(featuredIds),featuredSlots=Math.min(4,limit),otherSlots=limit-featuredSlots;
        const publicProducts=(await catalogView([],false,true))
          .filter(p=>p.source==='amazon'&&p.isActive&&!p.duplicateOfProductId&&(/^[A-Z0-9]{10}$/).test(p.id))
          .sort((a,b)=>maintenanceTimeOrder(a.availabilityCheckedAt||a.lastVerifiedAt,b.availabilityCheckedAt||b.lastVerifiedAt,true)
            ||maintenanceTimeOrder(a.updatedAt,b.updatedAt,false)||compare(a.id,b.id));
        const featuredProducts=publicProducts.filter(p=>featured.has(p.id)),others=publicProducts.filter(p=>!featured.has(p.id));
        const now=Date.parse(String((await all<{now:string}>(`SELECT ${NOW} now`))[0].now));
        const urgent=publicProducts.filter(p=>typeof p.photoExpiresAt==='string'&&Date.parse(p.photoExpiresAt)<=now+36*3600000)
          .sort((a,b)=>maintenanceTimeOrder(a.photoExpiresAt,b.photoExpiresAt,false)||compare(a.id,b.id));
        // Cleared unavailable records remain in this private source pool. Give
        // one weekly-due stock recheck a slot; a real positive response can
        // restore its stable page without re-admission or new copy generation.
        const rechecks=publicProducts.filter(p=>['OUT_OF_STOCK','UNAVAILABLE'].includes(String(p.availabilityStatus))
          &&p.availabilityCheckedAt!==null&&Date.parse(p.availabilityCheckedAt)<=now-7*86400000);
        const seen=new Set<string>();
        const selected=[...urgent,...(selection.photosOnly?[]:[...rechecks.slice(0,1),...featuredProducts.slice(0,featuredSlots),...others.slice(0,otherSlots),
          ...featuredProducts.slice(featuredSlots),...others.slice(otherSlots)])]
          .filter(p=>!seen.has(p.id)&&Boolean(seen.add(p.id))).slice(0,limit);
        const rows=[];
        for(const p of selected){const full=await load(p.id);if(!full)throw new Error('maintenance_current_state_drift');
          rows.push({...maintenanceRow(full.product),has_embedding:full.present});}
        await checkOwner();return rows;
      }
      const {limit,staleDays,publishedStaleDays,publishedSlots,legacySlots} = selection;
      if (!Object.values(selection).every(Number.isInteger) || limit < 1 || limit > 100 || staleDays < 1 || publishedStaleDays < 1
        || publishedSlots < 0 || legacySlots < 0 || publishedSlots+legacySlots !== limit) throw new Error('maintenance_revalidation_bound');
      const now = Date.parse(String((await all<{now:string}>(`SELECT ${NOW} now`))[0].now));
      const values = (await catalog()).map(value => value.product).filter(p => p.source === 'amazon' && p.isActive && /^[A-Z0-9]{10}$/.test(p.id));
      const lanes = [true,false].map(published => values.filter(p => publishedMaintenanceProduct(p) === published)
        .filter(p => { const time = published ? p.availabilityCheckedAt || p.lastVerifiedAt : p.lastVerifiedAt;
          return time === null || explicitMaintenanceTime(time) <= explicitMaintenanceTime(new Date(now-(published ? publishedStaleDays : staleDays)*86400000).toISOString()); })
        .sort((a,b) => { const at = published ? a.availabilityCheckedAt || a.lastVerifiedAt : a.lastVerifiedAt;
          const bt = published ? b.availabilityCheckedAt || b.lastVerifiedAt : b.lastVerifiedAt;
          return maintenanceTimeOrder(at,bt,true) || maintenanceTimeOrder(a.updatedAt,b.updatedAt,false) || compare(a.id,b.id); }));
      return [...lanes[0].slice(0,publishedSlots),...lanes[1].slice(0,legacySlots),...lanes[0].slice(publishedSlots),...lanes[1].slice(legacySlots)]
        .slice(0,limit).map(maintenanceRow);
    }),
    deactivateConfirmedMissing: (ids: string[],days: number) => serialize(() => {
      if(options.preservePermanentListings)throw new Error('maintenance_permanent_deactivation_forbidden');
      if (!Number.isInteger(days) || days < 1) throw new Error('maintenance_deactivation_bound');
      return change('deactivateConfirmedMissing',[ids,days],(p,now) => {
        const time = p.lastVerifiedAt || p.createdAt;
        if (time === null || explicitMaintenanceTime(time) > explicitMaintenanceTime(new Date(Date.parse(now)-days*86400000).toISOString())) return false;
        p.isActive=false; p.updatedAt=now; return true;
      }) as Promise<string[]>;
    }),
    markConfirmedMissingUnavailable: (ids: string[]) => serialize(() => change('markConfirmedMissingUnavailable',[ids],(p,now) => {
      p.availabilityStatus='UNAVAILABLE'; p.availabilityCheckedAt=now; p.updatedAt=now; return true;
    }) as Promise<string[]>),
    getProductsNeedingEnrichment: (limit: number,ids?: string[]) => serialize(async () => {
      if (!Number.isInteger(limit) || limit < 0 || limit > 100) throw new Error('maintenance_enrichment_bound');
      const exact = ids?.length ? idsInput(ids) : null;
      const rows = (await catalog()).filter(({product:p,present}) => {
        if ((!p.isActive && !exact) || p.imageUrl === null || p.affiliateUrl === null || p.title === '' || p.duplicateOfProductId
          || exact && !exact.includes(p.id)) return false;
        if (exact || ['pending','stale','needs_review'].includes(p.editorialStatus) || p.sourceFactsHash !== p.editorialSourceHash) return true;
        if (['blocked','duplicate'].includes(p.editorialStatus)) return false;
        if (p.punnyTitle === null || p.wittyDescription === null || p.humorTags === null || p.qualityScore === null) return true;
        if (present === null) throw new Error('maintenance_embedding_presence_unproven');
        return !present;
      }).map(value => value.product).sort((a,b) => (exact ? exact.indexOf(a.id)-exact.indexOf(b.id) : 0)
        || (a.qualityScore === null ? b.qualityScore === null ? 0 : 1 : b.qualityScore === null ? -1 : Number(b.qualityScore)-Number(a.qualityScore))
        || -maintenanceTimeOrder(a.updatedAt,b.updatedAt,false) || compare(a.id,b.id));
      return rows.slice(0,limit).map(maintenanceRow);
    }),
    recordEditorialEvent: (event: {runId:string;productId:string;eventType:string;status:string;details:unknown}) => serialize(async () => {
      await write('recordEditorialEvent',[event],async (args,_intent,now,statements,operationId) => {
        const e = args[0] as typeof event;
        if (e.runId !== runId) throw new Error('maintenance_event_run_mismatch');
        const eventId=randomUUID();
        statements.push(assertion(db,'EXISTS(SELECT 1 FROM products WHERE id=?)',[e.productId]));
        statements.push(prepare(`INSERT INTO catalog_editorial_events(id,run_id,product_id,event_type,status,created_at,source_record_json,timestamp_provenance_json)
          VALUES(?,?,?,?,?,?,?,?)`,[eventId,e.runId,e.productId,e.eventType,e.status,now,
          canonicalJson({id:eventId,run_id:e.runId,product_id:e.productId,event_type:e.eventType,status:e.status,details:e.details,
            created_at:now,_maintenance:{operationId}}),
          canonicalJson({schemaVersion:1,fields:{created_at:{state:'evidenced',basis:'maintenance_operation',operationId}}})]));
        return null;
      });
    }),
    markCatalogDuplicate: (id: string,winner: string,reason: string) => serialize(async () => {
      await change('markCatalogDuplicate',[[id],winner,reason],(p,now) => {
        if (p.editorialStatus === 'manual_locked') return false;
        p.editorialStatus='duplicate'; p.editorialBlockReason=reason; p.duplicateOfProductId=winner; p.updatedAt=now; return true;
      });
    }),
  };
  return Object.freeze(store);
}

/** Feed the existing drainer through an explicit owned provider adapter later;
 * this only retrieves the immutable, transactionally captured private payload.
 */
export async function loadMaintenanceVectorPayload(db: CatalogD1,event: Readonly<VectorEvent>): Promise<ImmutableVectorPayload> {
  const row = (await db.prepare('SELECT payload_json FROM catalog_maintenance_vector_payloads WHERE sequence=?')
    .bind(event.sequence).all<{payload_json:string}>()).results[0];
  if (!row) throw new Error('maintenance_vector_payload_missing');
  const payload = JSON.parse(row.payload_json);
  if (payload.operation === 'upsert' && Object.hasOwn(payload,'nativeBase64')) {
    if (Object.hasOwn(payload,'values') || typeof payload.nativeBase64 !== 'string'
      || createHash('sha256').update(Buffer.from(payload.nativeBase64,'base64')).digest('hex') !== payload.vectorBytesSha256)
      throw new Error('maintenance_vector_payload_invalid');
    payload.values = decodePgvectorSendBase64(payload.nativeBase64);
    delete payload.nativeBase64;
  }
  // Existing numeric payloads are not silently repaired from mutable state.
  // The drainer independently validates identity/input/native checksum as usual.
  return payload as ImmutableVectorPayload;
}
