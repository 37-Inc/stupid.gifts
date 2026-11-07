import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import {automationContains} from '../../lib/catalog/automation-cohort.ts';
import type {AutomationCohortAuthority} from '../../lib/catalog/automation-cohort.ts';
import type { CatalogSnapshot, ProductRights, PublicCatalogProduct } from '../../lib/catalog/types.ts';
import { createProjectionPacket } from '../../lib/catalog/d1.ts';
import { canonicalTime, EDITORIAL_MAX_AGE_MS, persistentDisplayRights, publicProductRightsExpiry,
  validateCatalogSnapshot, validatePublicCatalogProduct } from '../../lib/catalog/snapshot.ts';
import { isPurchasableAvailability, hasReviewedGiftShortCopy } from '../../lib/gift-slugs.ts';
import { catalogDisplayDeadline, persistentPublicProduct } from '../../lib/catalog/display.ts';
import { suppressNearDuplicateProducts } from '../../lib/db/product-scoring.ts';
import { canonicalJson, canonicalTimestamp, sha256 } from './migration.ts';
import { mutationFenceQuery,pendingVectorReadFence as approvedRevisionReadFence } from '../../lib/catalog/mutation-fence.ts';
import type { MutationOwner, MutationQuery } from '../../lib/catalog/mutation-fence.ts';
import { pruningCurrentQueries, PRUNING_CURRENT_LIMITS, CATALOG_IDENTITY_LIMITS, PRUNING_CURRENT_COLUMNS as CURRENT, PRUNING_ARCHIVE_TIMES as ARCHIVE_TIMES } from '../../lib/catalog/pruning-current.ts';
import { originalEditorialEquivalentRow } from '../../lib/catalog/editorial-equivalence.ts';
import { approvedBaseChangeLimit } from '../../lib/catalog/owner-base-review.ts';
import type { OwnerBaseCatalogReview } from '../../lib/catalog/owner-base-review.ts';
import { editorialSourceHash } from '../ops/catalog-editorial-core.mjs';
export { pruningCurrentQueries } from '../../lib/catalog/pruning-current.ts';

/** The sealed header/held/history/order are not versioned in D1. Supply these
 * from an independently reviewed, hash-pinned artifact, not mutable current rows.
 * Property order is retained because the existing snapshot digest hashes JSON bytes.
 */
export type SealedSnapshotEnvelope = Omit<CatalogSnapshot, 'products'> & { products: string[] };
export interface SnapshotReadContext {
  envelopeSha256: string; snapshotSha256: string; projectionSha256: string; sourceExportSha256: string;
  vectorSyncWatermark: number; publicationReceiptWatermark: number; cutoff: string;
  /** Hash of canonicalJson of the exact five-column publication_receipts row.
   * The workflow supplies the correct environment/database; receipts lack an env column.
   */
  priorPublication: { releaseId: string; receiptSha256: string } | null;
}
export type SnapshotReadResult = { status: 'ready'; snapshot: CatalogSnapshot; observedAt: string }
  | { status: 'held'; reason: string; requiresNewRevision: boolean };
export const SNAPSHOT_READ_LIMITS = Object.freeze({ ...CATALOG_IDENTITY_LIMITS,
  rowBytes: PRUNING_CURRENT_LIMITS.rowBytes, resultBytes: 32 * 1024 * 1024, outboxSequence: 100000 });
type Row = Record<string, unknown>;
type CaptureRow = { kind: string; identity: string; data: string };
const HASH = /^[a-f0-9]{64}$/;
const KEY = /^[a-zA-Z0-9._-]{1,200}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROJECTION = ['catalog_revision', 'public_id', 'product_id', 'slug', 'title', 'description', 'tags',
  'source_facts_hash', 'eligible_until', 'public_display_json', 'display_sha256'];
const jsonColumns = (alias: string, columns: string[], extra: Record<string, string> = {}) =>
  `json_object(${[...columns.map((key) => `'${key}',${alias}.${key}`), ...Object.entries(extra).map(([key, expression]) => `'${key}',${expression}`)].join(',')})`;
// Carry private proof only for the small original-article equivalence lane,
// never duplicate source/semantic bodies across the whole catalog capture.
const EQUIVALENCE_NEEDED = `p.source_facts_hash IS NOT p.editorial_source_hash AND
  (json_extract(p.public_display_json,'$.indexable')=1 OR json_extract(p.public_display_json,'$.persistent.indexable')=1)`;
const copyField=(camel:string,snake:string)=>`CASE WHEN m.product_id IS NULL THEN json_extract(p.source_record_json,'$.${snake}')
  ELSE json_extract(m.semantic_json,'$.${camel}') END`;
const EDITORIAL_PROOF = {
  source_record_json: `CASE WHEN ${EQUIVALENCE_NEEDED} THEN p.source_record_json END`,
  maintenance_semantic: `CASE WHEN ${EQUIVALENCE_NEEDED} THEN m.semantic_json END`,
  short_copy_description:`CASE WHEN p.editorial_status='short_ready' THEN ${copyField('wittyDescription','witty_description')} END`,
  short_copy_quality:`CASE WHEN p.editorial_status='short_ready' THEN ${copyField('editorialQualityScore','editorial_quality_score')} END`,
  short_copy_current:`CASE WHEN p.editorial_status='short_ready' THEN (${copyField('editorialStatus','editorial_status')})=p.editorial_status
    AND (${copyField('sourceFactsHash','source_facts_hash')})=p.source_facts_hash
    AND (${copyField('editorialSourceHash','editorial_source_hash')})=p.editorial_source_hash END`,
};

// The whole-catalog reader carries only these small fields for short listings,
// not every product's archived source or private maintained body.
function shortCopyFields(current:Row,semantic=current.maintenance_semantic) {
  if(current.editorial_status!=='short_ready')return {};
  const source=object(JSON.parse(String(semantic??current.source_record_json)));
  const field=(camel:string,snake:string)=>source[semantic==null?snake:camel];
  return {short_copy_description:field('wittyDescription','witty_description'),
    short_copy_quality:field('editorialQualityScore','editorial_quality_score'),
    short_copy_current:field('editorialStatus','editorial_status')===current.editorial_status
      &&field('sourceFactsHash','source_facts_hash')===current.source_facts_hash
      &&field('editorialSourceHash','editorial_source_hash')===current.editorial_source_hash?1:0};
}

/** One statement, bounded row-per-product output, not a giant aggregate JSON cell.
 * json_each of one bounded ID array avoids D1's100-parameter ceiling. Outbox
 * inspection has an explicit global sequence ceiling until a separate indexed
 * revision-watermark reader is justified; exceeding it is held, never truncated.
 */
const HEADER_CTES = `vectors AS (SELECT sequence,source_revision,status FROM vector_sync_outbox WHERE sequence BETWEEN 1 AND ${SNAPSHOT_READ_LIMITS.outboxSequence}),
  prior AS (SELECT release_id,catalog_revision,code_sha,completed_at,manifest_json FROM publication_receipts WHERE release_id=?)`;
const HEADER_SELECT = `SELECT 'header' kind,'' identity,json_object('observedAt',strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    'revision',c.revision,'revisionStatus',c.status,'sourceDigest',c.source_export_sha256,
    'receipt',${jsonColumns('r', ['catalog_revision', 'snapshot_sha256', 'projection_sha256', 'source_export_sha256', 'product_count', 'created_at'])},
    'watermark',(SELECT coalesce(max(sequence),0) FROM vectors WHERE source_revision=?),
    'pending',(SELECT count(*) FROM vectors WHERE source_revision=? AND status!='complete'),
    'globalWatermark',(SELECT coalesce(max(sequence),0) FROM vectors),
    'globalPending',(SELECT count(*) FROM vectors WHERE status!='complete'),
    'outboxOverflow',EXISTS(SELECT 1 FROM vector_sync_outbox WHERE sequence>${SNAPSHOT_READ_LIMITS.outboxSequence} LIMIT 1),
    'publicationWatermark',(SELECT coalesce(max(rowid),0) FROM publication_receipts),
    'prior',${jsonColumns('prior', ['release_id', 'catalog_revision', 'code_sha', 'completed_at', 'manifest_json'])}) data
    FROM (SELECT 1) LEFT JOIN catalog_revisions c ON c.revision=?
    LEFT JOIN catalog_projection_receipts r ON r.catalog_revision=c.revision LEFT JOIN prior ON 1`;
const CAPTURE_SQL = `WITH ids AS (SELECT value FROM json_each(?)),
  projection AS (SELECT * FROM catalog_public_products WHERE catalog_revision=? LIMIT ${SNAPSHOT_READ_LIMITS.ready + 1}),
  ${HEADER_CTES}, captured AS (${HEADER_SELECT}
  UNION ALL SELECT 'projection',v.public_id,${jsonColumns('v', PROJECTION)} FROM projection v
  UNION ALL SELECT 'current',p.public_id,${jsonColumns('p', CURRENT, ARCHIVE_TIMES)} FROM ids CROSS JOIN products p ON p.public_id=ids.value),
  sized AS (SELECT *,length(CAST(data AS BLOB)) row_bytes,
    sum(length(CAST(data AS BLOB))) OVER (ORDER BY kind,identity) total_bytes FROM captured)
  SELECT kind,identity,CASE WHEN row_bytes>${SNAPSHOT_READ_LIMITS.rowBytes} OR total_bytes>${SNAPSHOT_READ_LIMITS.resultBytes}
    THEN '{"readBoundsExceeded":true}' ELSE data END data FROM sized ORDER BY kind,identity`;

// Leave room for the REST result/usage envelope. Measure the OUTER escaped row
// JSON in SQL, not only the inner data string. The transport independently caps
// the complete wire response at512KiB and requires served_by_primary on EVERY read.
const PAGE_BYTES = PRUNING_CURRENT_LIMITS.pageBytes;
const OPERATION = ['operation_id','input_sha256','run_id','catalog_revision','environment','index_name',
  'generation','prior_epoch','next_epoch','database_time','result_json','changes_json'];
async function ownedPages(db: CatalogD1, owner: MutationOwner, ids: string[], select: string, params: unknown[] = [], fence?:MutationQuery,signal?:AbortSignal) {
  const gate = fence??mutationFenceQuery(owner, ['freezing']); const output: Row[] = [];
  if (ids.length > SNAPSHOT_READ_LIMITS.identities || new Set(ids).size !== ids.length) throw new Error('read_bounds');
  let bytes = 0;
  for (let offset = 0; offset < ids.length; offset += 80) {
    const window = ids.slice(offset, offset + 80); let position = 0;
    while (position < window.length) {
      signal?.throwIfAborted();const sql=`WITH requested AS (SELECT key ordinal,value FROM json_each(?)),
        captured AS (${select}), sized AS (SELECT *,sum(length(CAST(json_object('identity',identity,'data',data||'') AS BLOB)))
          OVER (ORDER BY ordinal) wire_bytes FROM captured)
        SELECT identity,data FROM sized WHERE ${gate.sql} AND wire_bytes<=? ORDER BY ordinal`;
      const rows = (await db.prepare(signal?`SELECT * FROM (${sql})`:sql)
        .bind(JSON.stringify(window.slice(position)), ...params, ...gate.params, PAGE_BYTES).all<{ identity: string; data: string }>({signal})).results;
      if (!rows.length || rows.length > window.length-position || Buffer.byteLength(JSON.stringify(rows)) > PAGE_BYTES + 81)
        throw new Error('read_bounds');
      for (const [index,row] of rows.entries()) {
        if (Object.keys(row).sort().join(',') !== 'data,identity' || row.identity !== window[position+index]
          || typeof row.data !== 'string' || Buffer.byteLength(row.data) > SNAPSHOT_READ_LIMITS.rowBytes) throw new Error('invalid_capture');
        bytes += Buffer.byteLength(row.data); if (bytes > SNAPSHOT_READ_LIMITS.resultBytes) throw new Error('read_bounds');
        output.push(object(JSON.parse(row.data)));
      }
      position += rows.length;
    }
  }
  return output;
}
async function ownedHeader(db: CatalogD1, owner: MutationOwner, revision: string, context: SnapshotReadContext) {
  const gate = mutationFenceQuery(owner, ['freezing']);
  const rows = (await db.prepare(`WITH ${HEADER_CTES} SELECT * FROM (${HEADER_SELECT}) WHERE ${gate.sql}`)
    .bind(context.priorPublication?.releaseId ?? null, revision, revision, revision, ...gate.params).all<CaptureRow>()).results;
  if (rows.length !== 1 || typeof rows[0].data !== 'string' || Buffer.byteLength(rows[0].data) > SNAPSHOT_READ_LIMITS.rowBytes)
    throw new Error('invalid_capture');
  return object(JSON.parse(rows[0].data));
}
/** Exact target/prior projection readback, including unexpected-row detection.
 * Partial target imports are allowed only for the immutable staging check; they
 * are never made visible by this reader or by an incomplete receipt.
 */
export async function readOwnedProjection(db: CatalogD1, owner: MutationOwner, revision: string, ids: string[],options:{phase?:'writing'|'activating';approvedRecovery?:boolean}={}) {
  owner = structuredClone(owner); ids = [...ids];
  const phase=options.phase??'freezing';if(owner.phase!==phase)throw new Error('mutation_phase_mismatch');
  const gate = options.approvedRecovery?approvedRevisionReadFence(owner):mutationFenceQuery(owner, [phase]);
  const rows = await ownedPages(db, owner, ids, `SELECT ids.ordinal,ids.value identity,
    ${jsonColumns('p', PROJECTION)} data FROM requested ids LEFT JOIN catalog_public_products p
    ON p.public_id=ids.value AND p.catalog_revision=?`, [revision],gate);
  const present = rows.filter(row => row.public_id !== null);
  const count = (await db.prepare(`SELECT (SELECT count(*) FROM catalog_public_products WHERE catalog_revision=?) n WHERE ${gate.sql}`)
    .bind(revision,...gate.params).all<{ n: number }>()).results;
  if (count.length !== 1 || count[0].n !== present.length) throw new Error('prune_projection_changed');
  return present;
}
async function captureOwned(db: CatalogD1, owner: MutationOwner, envelope: SealedSnapshotEnvelope, context: SnapshotReadContext) {
  // Primary observations under the SAME cooperative write barrier, not a claim
  // that separate REST requests share a database transaction/snapshot. The caller
  // has copied this owner once; never refresh it from the live ownership row.
  const header = await ownedHeader(db, owner, envelope.catalogRevision, context);
  const ids = [...envelope.products,...envelope.heldProducts.map(product => product.publicId)].sort();
  const current = await captureCurrentRows(db,owner,ids);
  const projection = await readOwnedProjection(db, owner, envelope.catalogRevision, [...envelope.products].sort());
  if (Buffer.byteLength(canonicalJson({header,current,projection})) > SNAPSHOT_READ_LIMITS.resultBytes) throw new Error('read_bounds');
  const final = await ownedHeader(db, owner, envelope.catalogRevision, context);
  if (canonicalJson({...header,observedAt:null}) !== canonicalJson({...final,observedAt:null})
    || canonicalTime(final.observedAt) < canonicalTime(header.observedAt)) throw new Error('prune_source_changed');
  return {header:final,current,projection};
}

function hold(reason: string, requiresNewRevision = false): SnapshotReadResult { return { status: 'held', reason, requiresNewRevision }; }
function object(value: unknown): Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_object');
  return value as Row;
}
export function createSealedSnapshotEnvelope(input: CatalogSnapshot): SealedSnapshotEnvelope {
  const snapshot = validateCatalogSnapshot(input, new Date(canonicalTime(input.generatedAt)));
  return { ...snapshot, products: snapshot.products.map((product) => product.publicId) };
}
function inputs(envelope: SealedSnapshotEnvelope, context: SnapshotReadContext): void {
  if (Object.keys(envelope).sort().join(',') !== 'catalogRevision,dataKind,generatedAt,heldProducts,products,schemaVersion,slugHistory'
    || envelope.schemaVersion !== 1 || envelope.dataKind !== 'catalog' || !KEY.test(envelope.catalogRevision)
    || !Array.isArray(envelope.products) || !Array.isArray(envelope.heldProducts) || !Array.isArray(envelope.slugHistory)
    || envelope.products.length > SNAPSHOT_READ_LIMITS.ready || envelope.heldProducts.length > SNAPSHOT_READ_LIMITS.held
    || envelope.slugHistory.length > SNAPSHOT_READ_LIMITS.slugs
    || envelope.products.length + envelope.heldProducts.length > SNAPSHOT_READ_LIMITS.identities
    || envelope.products.some((id) => typeof id !== 'string' || !UUID.test(id))
    || new Set(envelope.products).size !== envelope.products.length
    || ![context.envelopeSha256, context.snapshotSha256, context.projectionSha256, context.sourceExportSha256].every((hash) => typeof hash === 'string' && HASH.test(hash))
    || !Number.isSafeInteger(context.vectorSyncWatermark) || context.vectorSyncWatermark < 0 || context.vectorSyncWatermark > SNAPSHOT_READ_LIMITS.outboxSequence
    || !Number.isSafeInteger(context.publicationReceiptWatermark) || context.publicationReceiptWatermark < 0
    || context.priorPublication !== null && (typeof context.priorPublication.releaseId !== 'string' || !KEY.test(context.priorPublication.releaseId)
      || typeof context.priorPublication.receiptSha256 !== 'string' || !HASH.test(context.priorPublication.receiptSha256))) throw new Error('invalid_context');
  canonicalTime(envelope.generatedAt); canonicalTime(context.cutoff);
  validateCatalogSnapshot({ ...envelope, products: [], slugHistory: [] }, new Date(envelope.generatedAt));
  if (Buffer.byteLength(JSON.stringify(envelope)) > SNAPSHOT_READ_LIMITS.resultBytes) throw new Error('read_bounds');
  if (sha256(`${JSON.stringify(envelope)}\n`) !== context.envelopeSha256) throw new Error('envelope_digest');
}
async function capture(db: CatalogD1, envelope: SealedSnapshotEnvelope, context: SnapshotReadContext) {
  const ids = [...envelope.products, ...envelope.heldProducts.map((product) => product.publicId)];
  const results = (await db.prepare(CAPTURE_SQL).bind(JSON.stringify(ids), envelope.catalogRevision, context.priorPublication?.releaseId ?? null,
    envelope.catalogRevision, envelope.catalogRevision, envelope.catalogRevision).all<CaptureRow>()).results;
  if (!Array.isArray(results) || results.length > 1 + SNAPSHOT_READ_LIMITS.ready + 1 + SNAPSHOT_READ_LIMITS.identities) throw new Error('read_bounds');
  let bytes = 0;
  const groups = { header: [] as Row[], projection: [] as Row[], current: [] as Row[] };
  for (const row of results) {
    if (!['header', 'projection', 'current'].includes(row.kind) || typeof row.data !== 'string') throw new Error('invalid_capture');
    const size = Buffer.byteLength(row.data); bytes += size;
    if (size > SNAPSHOT_READ_LIMITS.rowBytes || bytes > SNAPSHOT_READ_LIMITS.resultBytes) throw new Error('read_bounds');
    const parsed = object(JSON.parse(row.data));
    if (parsed.readBoundsExceeded) throw new Error('read_bounds');
    groups[row.kind as keyof typeof groups].push(parsed);
  }
  if (groups.header.length !== 1) throw new Error('invalid_capture');
  await bindMaintenanceObservations(db, groups.current);
  return { header: groups.header[0], projection: groups.projection, current: groups.current };
}
/** Immutable operation receipts bind an actual observation, not the maintenance
 * SQL write time. Old migration-only databases do not have this table. The
 * receipt bytes are included in the final current-state CAS when present.
 */
async function bindMaintenanceObservations(db: CatalogD1, rows: Row[], owner?: MutationOwner, fence?:MutationQuery,signal?:AbortSignal) {
  const wanted = rows.flatMap(row => {
    const proof = JSON.parse(String(row.timestamp_provenance_json));
    const field = row.availability_checked_at !== null ? 'availability_checked_at' : 'last_verified_at';
    const evidence = proof?.fields?.[field];
    return evidence?.basis === 'maintenance_operation' && HASH.test(evidence.operationId) ? [evidence.operationId] : [];
  });
  if (!wanted.length) return;
  const ids = [...new Set(wanted)];
  if (ids.length > SNAPSHOT_READ_LIMITS.identities) throw new Error('read_bounds');
  const operations:Row[]=owner ? await ownedPages(db, owner, ids.sort(), `SELECT ids.ordinal,ids.value identity,
    ${jsonColumns('o', OPERATION)} data FROM requested ids CROSS JOIN catalog_maintenance_operations o ON o.operation_id=ids.value`,[],fence,signal) : [];
  let bytes=0;
  for(let offset=0;!owner && offset<ids.length;offset+=20){
    const chunk=(await db.prepare(`SELECT o.* FROM json_each(?) ids CROSS JOIN catalog_maintenance_operations o
      ON o.operation_id=ids.value`).bind(JSON.stringify(ids.slice(offset,offset+20))).all()).results;
    if(chunk.length>20)throw new Error('read_bounds');
    for(const row of chunk){const size=Buffer.byteLength(canonicalJson(row));bytes+=size;
      if(size>SNAPSHOT_READ_LIMITS.rowBytes||bytes>SNAPSHOT_READ_LIMITS.resultBytes)throw new Error('read_bounds');operations.push(row);}
  }
  const byId = new Map(operations.map(row => [row.operation_id, row]));
  for (const row of rows) {
    const proof = JSON.parse(String(row.timestamp_provenance_json));
    const field = row.availability_checked_at !== null ? 'availability_checked_at' : 'last_verified_at';
    const id = proof?.fields?.[field]?.operationId;
    if (byId.has(id)) {
      row.verification_operation_json = canonicalJson(byId.get(id)!);
    }
  }
}
async function captureCurrentRows(db:CatalogD1,owner:MutationOwner,ids:string[],fence?:MutationQuery) {
  const rows=await ownedPages(db,owner,ids,`SELECT ids.ordinal,ids.value identity,
    ${jsonColumns('p',CURRENT,{...ARCHIVE_TIMES,...EDITORIAL_PROOF})} data FROM requested ids CROSS JOIN products p
    ON p.public_id=ids.value LEFT JOIN catalog_maintenance_products m ON m.product_id=p.id`,[],fence);
  await bindMaintenanceObservations(db,rows,owner,fence);return rows;
}
/** Read-only recovery of ONE already-journaled body-free prune DELETE. This is
 * not permission to prune/reseal while pending. Its caller must match the
 * immutable source hash before the original full-row completion CAS is used.
 */
export async function readJournaledPruneDeleteSource(db:CatalogD1,owner:MutationOwner,deliveryId:string,publicId:string,completed=false) {
  owner=structuredClone(owner);
  if(!HASH.test(deliveryId)||!UUID.test(publicId)||owner.epoch<1)throw new Error('vector_resume_invalid');
  const base=mutationFenceQuery(owner,['freezing']);
  const fence={sql:`${base.sql} AND EXISTS(SELECT 1 FROM catalog_vector_deliveries WHERE delivery_id=? AND owner_json=?
    AND status=? ${completed?"AND disposition='verified'":''} AND dispatch_token IS NOT NULL AND mutation_reference IS NOT NULL
    AND json_extract(request_json,'$.kind')='prune' AND json_extract(request_json,'$.vector') IS NULL
    AND json_extract(request_json,'$.pruneCurrent') IS NULL AND json_extract(request_json,'$.pruneDeleteControl.schemaVersion')=1
    AND json_extract(request_json,'$.publicId')=?)`,
  params:[...base.params.slice(0,-1),completed?0:1,deliveryId,canonicalJson({...owner,epoch:owner.epoch-(completed?2:1)}),completed?'complete':'pending',publicId]};
  const rows=await captureCurrentRows(db,owner,[publicId],fence);
  const held=(await db.prepare(`SELECT 1 held WHERE ${fence.sql}`).bind(...fence.params).all()).results;
  if(rows.length!==1||held.length!==1)throw new Error('vector_owner_changed');return rows[0];
}

/** Explicit reviewed candidates only. Never scan mutable "ready" rows as an
 * approval source. Complete row bytes bind the maintenance operation receipt;
 * the narrow captured fields reuse the final pruning CAS and archived aliases.
 */
export async function readApprovedCurrentRows(db: CatalogD1, ids: string[], owner: MutationOwner,approvedRecovery=false,signal?:AbortSignal,
  ownerBaseReview?:OwnerBaseCatalogReview,automation?:AutomationCohortAuthority) {
  owner = structuredClone(owner); ids = [...ids];
  if ((automation?!automationContains(automation,ids):ids.length > approvedBaseChangeLimit(ownerBaseReview))
    ||automation&&ownerBaseReview||new Set(ids).size !== ids.length || ids.some(id => !UUID.test(id))) throw new Error('read_bounds');
  const gate = approvedRecovery?approvedRevisionReadFence(owner):mutationFenceQuery(owner, ['freezing']);
  const columns = (await db.prepare(`SELECT name FROM pragma_table_info('products') WHERE ${gate.sql}`).bind(...gate.params).all<{name:string}>({signal})).results.map(row=>row.name);
  if (!columns.length || columns.length > 65 || columns.some(key=>!/^[a-z_]+$/.test(key))) throw new Error('read_bounds');
  const joined = await ownedPages(db, owner, [...ids].sort(), `SELECT ids.ordinal,ids.value identity,
    ${jsonColumns('p', columns,{_editorial_semantic:'m.semantic_json'})} data FROM requested ids CROSS JOIN products p
    ON p.public_id=ids.value LEFT JOIN catalog_maintenance_products m ON m.product_id=p.id`,[],gate,signal);
  const rows = joined.map(value => { const row={...value};delete row._editorial_semantic;return row; });
  if (rows.length !== ids.length || rows.some(row => Buffer.byteLength(canonicalJson(row)) > SNAPSHOT_READ_LIMITS.rowBytes)) throw new Error('approved_identity_missing');
  const current:Row[] = rows.map((row,index) => {
    const archive = JSON.parse(String(row.source_record_json));
    return { ...Object.fromEntries(CURRENT.map(key => [key, row[key]])), approved_product_json:canonicalJson(row),
      source_record_json:row.source_record_json,maintenance_semantic:joined[index]._editorial_semantic,
      ...shortCopyFields(row,joined[index]._editorial_semantic),
      ...Object.fromEntries(['id','public_id','source','availability_checked_at','last_verified_at'].map(key => [`archived_${key}`, archive[key] ?? null])) };
  });
  await bindMaintenanceObservations(db, current, owner,gate,signal);
  return { rows, current };
}
/** Same byte-bounded ordered reader used by products/projections, rather than
 * one unbounded result containing every bulk operation's changes_json. */
export async function readOwnerBaseOperationReceipts(db:CatalogD1,owner:MutationOwner,ids:string[],approvedRecovery=false,signal?:AbortSignal) {
  ids=[...new Set(ids)].sort();
  if(ids.length>3383||ids.some(id=>!HASH.test(id)))throw Error('read_bounds');
  const gate=approvedRecovery?approvedRevisionReadFence(owner):mutationFenceQuery(owner,['freezing']);
  const rows=await ownedPages(db,owner,ids,`SELECT ids.ordinal,ids.value identity,${jsonColumns('o',OPERATION)} data
    FROM requested ids CROSS JOIN catalog_maintenance_operations o ON o.operation_id=ids.value`,[],gate,signal);
  if(rows.length!==ids.length)throw Error('approved_identity_missing');return rows;
}
/** Same byte-bounded reader in small technical chunks, with exact original
 * operation IDs plus independently validated same-run slug repair receipts. */
export async function readAutomationOperationReceipts(db:CatalogD1,owner:MutationOwner,ids:string[],runId:string,approvedRecovery=false,signal?:AbortSignal) {
  const wanted=new Set(ids);if(wanted.size!==ids.length||ids.some(id=>!HASH.test(id)))throw Error('read_bounds');
  const gate=approvedRecovery?approvedRevisionReadFence(owner):mutationFenceQuery(owner,['freezing']);let after='';
  for(;;){
    const found=(await db.prepare(`SELECT operation_id FROM catalog_maintenance_operations WHERE run_id=? AND operation_id>?
      AND json_extract(result_json,'$.kind')='new-product-slug-repair-v1' AND ${gate.sql} ORDER BY operation_id LIMIT 128`)
      .bind(runId,after,...gate.params).all<{operation_id:string}>({signal})).results;
    if(!found.length)break;
    if(found.some(r=>!HASH.test(r.operation_id)||r.operation_id<=after)||wanted.size+found.length>10000)throw Error('read_bounds');
    for(const row of found)wanted.add(row.operation_id);after=found.at(-1)!.operation_id;
  }
  const rows:Row[]=[],all=[...wanted].sort();
  for(let offset=0;offset<all.length;offset+=30)rows.push(...await readOwnerBaseOperationReceipts(db,owner,all.slice(offset,offset+30),approvedRecovery,signal));
  return rows;
}
/** Read-only hydration of an EXISTING seal, including a genuinely journaled
 * pending vector intent. This grants no claim, re-seal, mutation or replay. */
export async function readApprovedRevisionSource(db:CatalogD1,owner:MutationOwner,ids:string[],
  changes:Array<{publicId:string;operationId:string}>,ownerBaseReview?:OwnerBaseCatalogReview,
  approvalContext?:Pick<import('../../lib/catalog/freeze-approved-cohort.ts').ApprovedCohortRequest,'approval'|'previous'|'automation'>){
  const fence=approvedRevisionReadFence(owner),current=await captureCurrentRows(db,owner,[...ids].sort(),fence);
  const approved=await readApprovedCurrentRows(db,changes.map(c=>c.publicId),owner,true,undefined,ownerBaseReview,approvalContext?.automation);
  const operations=approvalContext?.automation?await readAutomationOperationReceipts(db,owner,changes.map(c=>c.operationId),approvalContext.approval.runId,true)
    :ownerBaseReview?await readOwnerBaseOperationReceipts(db,owner,changes.map(c=>c.operationId),true):changes.length?(await db.prepare(`SELECT * FROM catalog_maintenance_operations
    WHERE (operation_id IN(SELECT value FROM json_each(?)) OR (run_id=? AND json_extract(result_json,'$.kind')='new-product-slug-repair-v1')) AND ${fence.sql}`)
    .bind(JSON.stringify(changes.map(c=>c.operationId)),approvalContext?.approval.runId??'',...fence.params).all<Row>()).results:[];
  const byOp=new Map(operations.map(r=>[r.operation_id,r])),byId=new Map(current.map(r=>[String(r.public_id),r]));
  const {effectiveSlugApproval}=await import('./new-product-slug-repair.ts');
  for(const row of approved.current){const original=changes.find(c=>c.publicId===row.public_id)!;
    const change=approvalContext?effectiveSlugApproval(approvalContext.approval.changes.find(c=>c.publicId===row.public_id)!,operations,
      approved.rows.find(r=>r.public_id===row.public_id)!,owner,approvalContext):original;
    const op=byOp.get(change.operationId);
    if(!op)throw new Error('approved_identity_missing');row.approval_operation_json=canonicalJson(op);byId.set(String(row.public_id),row);}
  const rows=[...byId.values()].sort((a,b)=>String(a.public_id).localeCompare(String(b.public_id)));
  if(rows.length!==ids.length)throw new Error('approved_identity_missing');
  return rows;
}
function verificationTime(current: Row, rights: ProductRights): number {
  const column = current.availability_checked_at !== null ? 'availability_checked_at' : 'last_verified_at';
  const raw = current[column];
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(raw)) throw new Error('verification_utc_unproven');
  canonicalTimestamp(raw); // Validates calendar/microseconds without assigning UTC to naive history.
  const provenance = object(JSON.parse(String(current.timestamp_provenance_json)));
  const fields = provenance.fields ? object(provenance.fields) : undefined;
  const evidence = fields?.[column] ? object(fields[column]) : undefined;
  if (evidence?.basis === 'maintenance_operation') {
    const operation = current.verification_operation_json ? object(JSON.parse(String(current.verification_operation_json))) : null;
    const changes = operation ? JSON.parse(String(operation.changes_json)) : null;
    if (!operation || evidence.state !== 'evidenced' || operation.operation_id !== evidence.operationId
      || !HASH.test(String(operation.input_sha256)) || canonicalTimestamp(operation.database_time) !== canonicalTimestamp(raw)
      || !Array.isArray(changes) || !changes.some(change => change.productId === current.id && HASH.test(change.afterSha256))
      || evidence.sourceFactsHash !== current.source_facts_hash || typeof evidence.reference !== 'string' || !evidence.reference.trim()
      || typeof evidence.observedAt !== 'string' || !evidence.observedAt.endsWith('Z')) throw new Error('verification_utc_unproven');
    return Date.parse(canonicalTimestamp(evidence.observedAt)!);
  }
  let migrationEvidence = Boolean(provenance.schemaVersion === 1 && typeof provenance.sourceArchive === 'string' && provenance.sourceArchive.trim()
    && evidence && evidence.state === 'evidenced' && ['explicit_offset', 'documented_utc_writer'].includes(String(evidence.basis))
    && typeof evidence.evidence === 'string' && evidence.evidence.trim()
    && current.archived_id === current.id && current.archived_public_id === current.public_id && current.archived_source === current.source);
  if (migrationEvidence) {
    try {
      const decision = evidence!.basis === 'documented_utc_writer' ? { timezone: 'UTC' as const, evidence: String(evidence!.evidence) } : undefined;
      migrationEvidence = canonicalTimestamp(current[`archived_${column}`], decision) === canonicalTimestamp(raw);
    } catch { migrationEvidence = false; }
  }
  const receipt = rights.imageUrl;
  const freshEvidence = receipt?.basis === 'merchant' && receipt.reference.trim() && receipt.observedAt
    && canonicalTimestamp(receipt.observedAt) === canonicalTimestamp(raw);
  if (!migrationEvidence && !freshEvidence || evidence && evidence.state !== 'evidenced') throw new Error('verification_utc_unproven');
  return Date.parse(raw);
}
export function checkCurrent(product: PublicCatalogProduct, projection: Row, current: Row, now: Date): void {
  if (!current || current.id !== product.id || current.public_id !== product.publicId || current.slug !== product.slug || current.source !== product.source
    || current.is_active !== 1 || current.duplicate_of_product_id !== null || typeof current.quality_score !== 'number'
    || !Number.isFinite(current.quality_score) || current.quality_score < (persistentPublicProduct(product) ? 0 : .55)
    || current.quality_score > 1
    || typeof current.public_display_json !== 'string') throw new Error('current_hold_or_factual_drift');
  const approved = validatePublicCatalogProduct(JSON.parse(current.public_display_json), now);
  const persistent = persistentPublicProduct(product), currentPersistent = persistentPublicProduct(approved);
  const rights = object(JSON.parse(String(current.rights_json))) as ProductRights;
  if (persistent) {
    if (['blocked', 'needs_review'].includes(String(current.editorial_status)) || current.quality_score !== persistent.qualityScore || !currentPersistent
      || canonicalJson(persistent) !== canonicalJson(currentPersistent)
      || persistent.indexable && (!/^[a-f0-9]{64}$/.test(String(current.source_facts_hash))||!['generated_ready', 'manual_locked'].includes(String(current.editorial_status))
        || current.source_facts_hash !== current.editorial_source_hash)
        && !originalEditorialEquivalentRow(current,persistent.editorialWriteup || '',editorialSourceHash)
      || publicProductRightsExpiry(persistent, approved.eligibleUntil === null ? persistentDisplayRights(rights) : rights.persistent ?? {}, now) !== Infinity)
      throw new Error('current_rights_incompatible');
    // Final publication SQL separately rechecks current reviewed-copy provenance.
    // No supplier observation time, availability or deadline is renewed here.
    return;
  }
  if (current.source_facts_hash !== projection.source_facts_hash
    || !isPurchasableAvailability(String(current.availability_status)) || !['generated_ready', 'manual_locked', 'short_ready'].includes(String(current.editorial_status))
    || current.source_facts_hash !== current.editorial_source_hash || product.eligibleUntil === null || approved.eligibleUntil === null
    || current.editorial_status!=='short_ready'&&!product.editorialWriteup)
    throw new Error('current_hold_or_factual_drift');
  if(current.editorial_status==='short_ready'){
    const proof=Object.hasOwn(current,'short_copy_current')?current:shortCopyFields(current);
    if(product.editorialWriteup||proof.short_copy_current!==1||proof.short_copy_description!==product.description||!hasReviewedGiftShortCopy({
      editorialStatus:'short_ready',wittyDescription:typeof proof.short_copy_description==='string'?proof.short_copy_description:undefined,
      editorialQualityScore:Number(proof.short_copy_quality),sourceFactsHash:String(current.source_facts_hash),
      editorialSourceHash:String(current.editorial_source_hash)}))throw new Error('current_hold_or_factual_drift');
  }
  // A grant/factual hash alone cannot make a changed manual display compatible.
  // Only a renewed deadline may advance without changing the sealed display.
  if (canonicalJson({ ...approved, eligibleUntil: product.eligibleUntil }) !== canonicalJson(product)) throw new Error('current_display_incompatible');
  const deadline = publicProductRightsExpiry(product, rights, now);
  const verified = verificationTime(current, rights);
  const until = Math.min(Date.parse(canonicalTime(current.eligible_until)), Date.parse(approved.eligibleUntil));
  if (deadline === null || Date.parse(product.eligibleUntil) > deadline) throw new Error('current_rights_incompatible');
  if (verified > now.getTime() || verified + EDITORIAL_MAX_AGE_MS <= now.getTime()
    || Date.parse(product.eligibleUntil) > Math.min(until, verified + EDITORIAL_MAX_AGE_MS)) throw new Error('current_deadline_incompatible');
}

/** The daily pruner may read an expired seal, but never silently change its
 * approved identities/order or trust a receipt without verifying its row bytes.
 * This is a capture, NOT a write barrier; the caller must own the shared fence.
 */
export async function readPruningSource(db: CatalogD1, snapshotInput: CatalogSnapshot, context: SnapshotReadContext, owner: MutationOwner) {
  owner = structuredClone(owner); snapshotInput = structuredClone(snapshotInput); context = structuredClone(context);
  const envelope = createSealedSnapshotEnvelope(snapshotInput); inputs(envelope, context);
  const state = await captureOwned(db, owner, envelope, context); const { header, projection, current } = state;
  const snapshot = validateCatalogSnapshot(snapshotInput, new Date(envelope.generatedAt));
  const receipt = object(header.receipt); const prior = object(header.prior);
  if (header.revision !== envelope.catalogRevision || !['reconciled','published'].includes(String(header.revisionStatus))
    || header.sourceDigest !== context.sourceExportSha256 || receipt.snapshot_sha256 !== context.snapshotSha256
    || receipt.projection_sha256 !== context.projectionSha256 || receipt.source_export_sha256 !== context.sourceExportSha256
    || receipt.product_count !== snapshot.products.length || projection.length !== snapshot.products.length
    || sha256(`${JSON.stringify(snapshot)}\n`) !== context.snapshotSha256) throw new Error('prune_source_unreconciled');
  if (header.outboxOverflow || header.globalPending !== 0 || header.watermark !== context.vectorSyncWatermark
    || header.publicationWatermark !== context.publicationReceiptWatermark
    || (context.priorPublication === null ? prior.release_id !== null
      : prior.release_id !== context.priorPublication.releaseId || sha256(canonicalJson(prior)) !== context.priorPublication.receiptSha256))
    throw new Error('prune_source_unsettled');
  const facts = Object.fromEntries(projection.map(row => [String(row.public_id), row.source_facts_hash===null?null:String(row.source_facts_hash)]));
  const packet = await createProjectionPacket(snapshot, facts, context.sourceExportSha256, new Date(envelope.generatedAt));
  if (canonicalJson(packet.rows) !== canonicalJson([...projection].sort((a,b) => String(a.public_id).localeCompare(String(b.public_id))))
    || canonicalJson(packet.receipt) !== canonicalJson(receipt)) throw new Error('prune_projection_changed');
  const identities = [...snapshot.products, ...snapshot.heldProducts];
  const byId = new Map(current.map(row => [row.public_id,row]));
  if (current.length !== identities.length || byId.size !== identities.length
    || identities.some(value => byId.get(value.publicId)?.id !== value.id || byId.get(value.publicId)?.slug !== value.slug))
    throw new Error('prune_identity_changed');
  return { ...state, snapshot, packet, facts, observedAt: canonicalTime(header.observedAt) };
}

/** Internal read validation, NOT a reusable capability/waiver. The exact frozen
 * owner must still match in the immediately following atomic receipt transaction.
 * Supported product/operation writers require writing; legacy writers refuse an
 * enabled fence. Owner/generation/epoch/external_pending transitions invalidate
 * every page. Privileged/manual bypass SQL must remain stopped separately.
 */
export async function assertPruningCurrent(db: CatalogD1, owner: MutationOwner, rows: Row[]) {
  owner = structuredClone(owner); rows = structuredClone(rows);
  const gate = mutationFenceQuery(owner, ['freezing']);
  const guard = { sql:`SELECT json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'mutation_fenced' END)`,params:gate.params };
  let batch = [guard];
  async function flush() { await db.batch(batch.map(query=>db.prepare(query.sql).bind(...query.params))); batch=[guard]; }
  for (const query of pruningCurrentQueries(rows)) {
    const assertion = {sql:`SELECT json(CASE WHEN (${query.sql})=? THEN 'true' ELSE 'prune_fenced' END)`,params:[...query.params,query.count]};
    if (batch.length >= 50 || Buffer.byteLength(JSON.stringify({batch:[...batch,assertion]})) > 512*1024) await flush();
    if (Buffer.byteLength(JSON.stringify({batch:[...batch,assertion]})) > 512*1024) throw new Error('read_bounds');
    batch.push(assertion);
  }
  if (batch.length > 1 || !rows.length) await flush();
}

/** Reconstruction of an EXISTING seal, not a new-revision freshness freezer.
 * Inject a primary/first-primary session (or an authoritative writer bookmark),
 * not an unconstrained possibly-stale replica. Two stable
 * captures detect observed drift, not a lock against later writes/ABA or proof of
 * external Vectorize visibility. Workflow writer barriers + activation preflight
 * and independent deployed/vector readback remain mandatory after this returns.
 * No queries, raw source records, private rights, or adapter errors are returned.
 */
export async function reconstructD1Snapshot(db: CatalogD1, envelopeInput: SealedSnapshotEnvelope, contextInput: SnapshotReadContext): Promise<SnapshotReadResult> {
  try {
    const envelope = structuredClone(envelopeInput); const context = structuredClone(contextInput);
    inputs(envelope, context);
    const first = await capture(db, envelope, context); const { header, projection, current } = first;
    const now = new Date(canonicalTime(header.observedAt));
    if (header.revision !== envelope.catalogRevision || !['reconciled', 'published'].includes(String(header.revisionStatus))
      || header.sourceDigest !== context.sourceExportSha256) return hold('revision_not_reconciled');
    const receipt = object(header.receipt);
    if (receipt.catalog_revision !== envelope.catalogRevision || receipt.snapshot_sha256 !== context.snapshotSha256
      || receipt.projection_sha256 !== context.projectionSha256 || receipt.source_export_sha256 !== context.sourceExportSha256
      || receipt.product_count !== envelope.products.length || receipt.created_at !== envelope.generatedAt
      || projection.length !== envelope.products.length) return hold('projection_receipt_mismatch');
    if (header.outboxOverflow || header.watermark !== context.vectorSyncWatermark || header.pending !== 0) return hold('vector_watermark_unreconciled');
    const prior = object(header.prior);
    if (header.publicationWatermark !== context.publicationReceiptWatermark || (context.priorPublication === null ? prior.release_id !== null
      : prior.release_id !== context.priorPublication.releaseId || sha256(canonicalJson(prior)) !== context.priorPublication.receiptSha256)) return hold('publication_prior_changed');
    const byId = new Map(projection.map((row) => [row.public_id, row]));
    if (byId.size !== projection.length) return hold('projection_bytes_mismatch');
    const products = envelope.products.map((id) => JSON.parse(String(byId.get(id)?.public_display_json)) as PublicCatalogProduct);
    const snapshot = validateCatalogSnapshot({ ...envelope, products }, new Date(envelope.generatedAt));
    const facts = Object.fromEntries(projection.map((row) => [String(row.public_id), row.source_facts_hash===null?null:String(row.source_facts_hash)]));
    const packet = await createProjectionPacket(snapshot, facts, context.sourceExportSha256, new Date(envelope.generatedAt));
    const sortedProjection = [...projection].sort((a, b) => String(a.public_id).localeCompare(String(b.public_id)));
    if (canonicalJson(packet.rows) !== canonicalJson(sortedProjection) || canonicalJson(packet.receipt) !== canonicalJson(receipt)) return hold('projection_bytes_mismatch');
    if (snapshot.products.some((product) => catalogDisplayDeadline(product) <= Math.max(now.getTime(), Date.parse(context.cutoff)))) return hold('expiry_requires_new_revision', true);
    if (now.toISOString() >= context.cutoff) return hold('capture_window_elapsed');
    // Family/archetype heuristics are discovery filters, not authority to
    // unpublish an owner-approved permanent listing or a distinct variant.
    const supplierOnly = snapshot.products.filter(product => !persistentPublicProduct(product));
    if (suppressNearDuplicateProducts(supplierOnly).length !== supplierOnly.length) return hold('duplicates_require_new_revision', true);
    validateCatalogSnapshot(snapshot, now);
    const operational = new Map(current.map((row) => [row.public_id, row]));
    if (operational.size !== current.length || current.length !== envelope.products.length + envelope.heldProducts.length) return hold('current_identity_missing');
    for (const product of snapshot.products) checkCurrent(product, byId.get(product.publicId)!, operational.get(product.publicId)!, now);
    for (const held of snapshot.heldProducts) {
      const row = operational.get(held.publicId)!;
      if (row.id !== held.id || row.slug !== held.slug) return hold('current_identity_changed');
      if (held.affiliateUrl) {
        const right = (object(JSON.parse(String(row.rights_json))) as ProductRights).affiliateUrl;
        if (!right || !['owned', 'licensed'].includes(right.basis) || right.expiresAt || right.value !== held.affiliateUrl || !right.reference?.trim()) return hold('held_link_rights_incompatible', true);
      }
    }
    const final = await capture(db, envelope, context);
    const stable = (value: typeof first) => canonicalJson({ ...value, header: { ...value.header, observedAt: null } });
    if (stable(first) !== stable(final)) return hold('source_changed_during_read');
    const observedAt = canonicalTime(final.header.observedAt);
    if (observedAt < now.toISOString()) return hold('database_clock_regressed');
    if (snapshot.products.some((product) => catalogDisplayDeadline(product) <= Date.parse(observedAt))) return hold('expiry_requires_new_revision', true);
    if (observedAt >= context.cutoff) return hold('capture_window_elapsed');
    return snapshot.products.length ? { status: 'ready', snapshot, observedAt } : hold('all_held');
  } catch (error) {
    // Fixed codes only: provider errors can contain SQL, source content or credentials.
    const safe = new Set(['current_hold_or_factual_drift', 'current_display_incompatible', 'current_rights_incompatible', 'current_deadline_incompatible', 'verification_utc_unproven', 'read_bounds']);
    const reason = error instanceof Error && safe.has(error.message) ? error.message : 'snapshot_reconstruction_failed';
    return hold(reason, ['current_display_incompatible', 'current_rights_incompatible', 'current_deadline_incompatible'].includes(reason));
  }
}
