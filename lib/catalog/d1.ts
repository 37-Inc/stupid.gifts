import type { CatalogSnapshot, PublicCatalogProduct } from './types.ts';
import type { CatalogD1 } from './storage/d1.ts';
import { validateCatalogSnapshot, validatePublicCatalogProduct } from './snapshot.ts';
import { legacyMutationBatch } from './mutation-fence.ts';
import { resolvePublicProduct, persistentPublicProduct } from './display.ts';
import { catalogSearchTerms } from './search-terms.ts';
import { originalEditorialEquivalenceSql } from './editorial-equivalence.ts';

type Row = Record<string, string | number | null>;
export interface ProjectionReceipt extends Row {
  catalog_revision: string; snapshot_sha256: string; projection_sha256: string;
  source_export_sha256: string; product_count: number; created_at: string;
}
export interface ProjectionPacket {
  rows: Row[]; receipt: ProjectionReceipt;
}
export interface ProjectionQuery { sql: string; params: unknown[] }
const CURRENT_READY = `p.is_active=1 AND p.duplicate_of_product_id IS NULL AND p.quality_score>=0.55
  AND COALESCE(p.availability_checked_at,p.last_verified_at) IS NOT NULL
  AND upper(p.availability_status) IN ('IN_STOCK','IN_STOCK_SCARCE','INSTOCKSCARCE','AVAILABLE_DATE','LEADTIME','PREORDER')
  AND p.editorial_status IN ('generated_ready','manual_locked','short_ready')
  AND p.source_facts_hash IS NOT NULL AND p.source_facts_hash=p.editorial_source_hash
  AND p.public_display_json IS NOT NULL AND p.eligible_until>?`;
// SQL counterpart of the exact-value grant checks in publicProductRightsExpiry.
// Keep this in the shared predicate: a JS-only result filter cannot fence the
// final publication/activation transaction. Malformed/missing evidence is held.
function canonicalInstant(value: string): string {
  return `(typeof(${value})='text' AND length(${value})=24
    AND strftime('%Y-%m-%dT%H:%M:%fZ',${value},'+0 days')=${value})`;
}
function displayValues(column: string): string {
  return `SELECT fullkey,CASE WHEN type IN ('integer','real') THEN 'number' ELSE type END,atom
    FROM json_tree(${column}) WHERE fullkey!='$.eligibleUntil'`;
}
const grant = (key: string) => `json_extract(p.rights_json,'$.'||field.value||'.${key}')`;
const display = "json_extract(v.public_display_json,'$.'||field.value)";
const reference = grant('reference'), expires = grant('expiresAt'), observed = grant('observedAt');
// JavaScript String.trim whitespace, including tabs/newlines and Unicode spaces.
const TRIM = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
// Maintained short-copy approval supersedes the archive, just like articles.
const currentCopy = (maintained:string,archived:string) => `(CASE WHEN m.product_id IS NULL
  THEN json_extract(p.source_record_json,'$.${archived}') ELSE json_extract(m.semantic_json,'$.${maintained}') END)`;
const currentEditorialQuality=currentCopy('editorialQualityScore','editorial_quality_score');
const reviewedQuality=`CASE WHEN json_valid(${currentEditorialQuality}) THEN CASE
  WHEN json_type(${currentEditorialQuality}) IN ('integer','real') THEN CAST(${currentEditorialQuality} AS REAL) END END`;
const currentShort=currentCopy('wittyDescription','witty_description');
const shortText=`trim(${currentShort},${TRIM})`;
const shortWords=[9,10,11,12,13,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]
  .reduce((text,code)=>`replace(${text},char(${code}),' ')`,shortText);
/** Same current-copy evidence for source outbox reads and published revisions. */
export function currentShortCopySql(displayColumn:'p.public_display_json'|'v.public_display_json'):string {
  return `(p.editorial_status!='short_ready' OR ${allOf([
  `json_type(${displayColumn},'$.editorialWriteup') IS NULL`,
  `typeof(${currentShort})='text'`, `${currentShort}=json_extract(${displayColumn},'$.description')`,
  `${reviewedQuality} BETWEEN 0.8 AND 1`, `length(${shortText})<=220`,
  `instr(${shortText},char(10))=0`, `instr(${shortText},char(13))=0`,
  `(SELECT count(*) FROM json_each('['||replace(json_quote(${shortWords}),' ','","')||']') WHERE length(value)>0) BETWEEN 6 AND 35`,
  `length(p.source_facts_hash)=64`, `p.source_facts_hash NOT GLOB '*[^a-f0-9]*'`,
  `${currentCopy('editorialStatus','editorial_status')}=p.editorial_status`,
  `${currentCopy('sourceFactsHash','source_facts_hash')}=p.source_facts_hash`,
  `${currentCopy('editorialSourceHash','editorial_source_hash')}=p.editorial_source_hash`,
])})`;
}
const CURRENT_SHORT=currentShortCopySql('v.public_display_json');
const CURRENT_PERMISSIONS = `coalesce(json_type(p.public_display_json)='object' AND json_type(p.rights_json)='object'
  AND ${CURRENT_SHORT}
  AND v.eligible_until=json_extract(v.public_display_json,'$.eligibleUntil')
  AND ${canonicalInstant('p.eligible_until')}
  AND ${canonicalInstant("json_extract(p.public_display_json,'$.eligibleUntil')")}
  AND v.eligible_until<=p.eligible_until AND v.eligible_until<=json_extract(p.public_display_json,'$.eligibleUntil')
  AND NOT EXISTS(${displayValues('v.public_display_json')} EXCEPT ${displayValues('p.public_display_json')})
  AND NOT EXISTS(${displayValues('p.public_display_json')} EXCEPT ${displayValues('v.public_display_json')})
  AND NOT EXISTS(SELECT 1 FROM json_each('["title","description","imageUrl","affiliateUrl","editorialWriteup","punnyTitle","wittyDescription","humorTags"]') field
    WHERE (field.value IN ('title','description','imageUrl','affiliateUrl')
      OR field.value='editorialWriteup' AND p.editorial_status!='short_ready'
      OR json_type(v.public_display_json,'$.'||field.value) IS NOT NULL)
    AND NOT coalesce(${grant('basis')} IN ('owned','licensed','merchant')
      AND typeof(${reference})='text' AND length(trim(${reference},${TRIM}))>0
      AND typeof(${grant('value')})='text' AND ${grant('value')}=${display}
      AND ((${expires} IS NULL AND ${grant('basis')}!='merchant')
        OR (${canonicalInstant(expires)} AND ${expires}>=v.eligible_until))
      AND (${grant('basis')}!='merchant' OR (${canonicalInstant(observed)} AND ${observed}<=?
        AND ${expires}>${observed} AND julianday(${expires})-julianday(${observed})<=1)),0)),0)`;
const VISIBLE = `v.eligible_until>? AND ${CURRENT_READY} AND v.source_facts_hash=p.source_facts_hash AND ${CURRENT_PERMISSIONS}`;
// Listing clearance is independent of supplier availability/verification age.
// It never authorizes a semantic/native read: that path retains VISIBLE above.
const base = (column:string) => `(CASE WHEN json_type(${column},'$.eligibleUntil')='null' THEN ${column}
  WHEN json_type(${column},'$.persistent')='object' THEN json_extract(${column},'$.persistent') END)`;
const V_BASE=base('v.public_display_json'),P_BASE=base('p.public_display_json');
// SQL counterpart of persistentDisplayRights, without granting a missing nested base.
const BASE_RIGHTS=`(CASE WHEN json_type(p.rights_json,'$.persistent')!='null' THEN p.rights_json->'$.persistent'
  WHEN json_type(p.public_display_json,'$.eligibleUntil')='null' THEN p.rights_json END)`;
const baseGrant=(key:string)=>`json_extract(${BASE_RIGHTS},'$.'||field.value||'.${key}')`;
const baseDisplay=`json_extract(${V_BASE},'$.'||field.value)`;
const editorial=`json_extract(${V_BASE},'$.editorialWriteup')`;
// Maintained semantics supersede the immutable archive; missing current copy
// evidence must not fall back to an older, higher-quality editorial record.
const currentEditorial=currentCopy('editorialWriteup','editorial_writeup');
const words=[9,10,11,12,13,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279]
  .reduce((text,code)=>`replace(${text},char(${code}),' ')`,editorial);
// D1 limits expression depth to100, including the enclosing receipt/CAS gates.
// AND is associative even for SQL NULL; only grouping changes, never predicates
// or their order/parameters. A flat chain becomes a left-deep SQLite AST.
function allOf(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  const middle = Math.floor(parts.length / 2);
  return `(${allOf(parts.slice(0, middle))} AND ${allOf(parts.slice(middle))})`;
}
// The immutable projection is JS-validated before insertion, and its exact
// image value must still match the current base and field grant below. Admit
// the same HTTPS/local-image lanes here instead of retaining the old SVG-only
// restriction in keyword search and the final publication transaction.
const image=`json_extract(${V_BASE},'$.imageUrl')`;
const authority=`substr(replace(substr(${image},9),char(63),'/'),1,instr(replace(substr(${image},9),char(63),'/')||'/','/')-1)`;
const persistentImage=`(${allOf([
  `substr(${image},1,1)='/'`, `substr(${image},2,1)!='/'`,
  `${image} NOT GLOB '*[^a-zA-Z0-9/_.-]*'`, `instr(${image},'/./')=0`, `instr(${image},'/../')=0`,
  `(${['svg','png','jpg','jpeg','webp','avif'].map(ext=>`(${image} GLOB '*.${ext}' AND length(${image})>${ext.length+2})`).join(' OR ')})`,
])} OR ${allOf([
  `lower(substr(${image},1,8))='https://'`, `length(${authority})>0`, `instr(${authority},'@')=0`,
  `instr(${image},'#')=0`, `instr(${image},'\\')=0`,
])})`;
const PERSISTENT_VISIBLE=`coalesce(${allOf([
  'p.is_active=1', 'p.duplicate_of_product_id IS NULL', 'p.quality_score BETWEEN 0 AND 1',
  `p.quality_score=json_extract(${V_BASE},'$.qualityScore')`,
  "p.editorial_status NOT IN ('blocked','needs_review')",
  'v.source_facts_hash IS p.source_facts_hash', `json_type(${V_BASE})='object'`, `json_type(${P_BASE})='object'`,
  `json_type(${BASE_RIGHTS})='object'`, `json_type(${V_BASE},'$.eligibleUntil')='null'`,
  `json_type(${P_BASE},'$.eligibleUntil')='null'`,
  `json_type(${V_BASE},'$.indexable') IN ('true','false')`, `json_type(${V_BASE},'$.persistent') IS NULL`,
  `json_extract(${V_BASE},'$.id')=v.product_id`, `json_extract(${V_BASE},'$.publicId')=v.public_id`,
  `json_extract(${V_BASE},'$.slug')=v.slug`, `json_extract(${V_BASE},'$.source')=p.source`,
  `json_extract(${V_BASE},'$.currency')=p.currency`,
  persistentImage,
  // Identical JSON necessarily has identical trees. CASE is lazy in SQLite:
  // avoid four virtual tree scans per identical base, keeping the exact old
  // symmetric comparison for different bytes (including reordered keys).
  `(CASE WHEN ${V_BASE}=${P_BASE} THEN 1 ELSE
    (NOT EXISTS(${displayValues(V_BASE)} EXCEPT ${displayValues(P_BASE)})
      AND NOT EXISTS(${displayValues(P_BASE)} EXCEPT ${displayValues(V_BASE)})) END)`,
  `(json_extract(${V_BASE},'$.indexable')=0 OR ${allOf([
    "p.editorial_status IN ('generated_ready','manual_locked')",
    "(typeof(p.source_facts_hash)='text' AND length(p.source_facts_hash)=64 AND p.source_facts_hash NOT GLOB '*[^a-f0-9]*')",
    'p.source_facts_hash=p.editorial_source_hash', `${reviewedQuality} BETWEEN 0.8 AND 1`,
    `${currentEditorial}=${editorial}`,
    `${currentCopy('id','id')}=p.id`, `${currentCopy('publicId','public_id')}=p.public_id`,
    `${currentCopy('slug','slug')}=p.slug`,
    `${currentCopy('sourceFactsHash','source_facts_hash')}=p.source_facts_hash`,
    `${currentCopy('editorialSourceHash','editorial_source_hash')}=p.editorial_source_hash`,
    `${currentCopy('editorialStatus','editorial_status')}=p.editorial_status`, `length(${editorial})>=500`,
    `instr(replace(replace(replace(${editorial},char(13),''),char(9),''),' ',''),char(10)||char(10))>0`,
    `(SELECT count(*) FROM json_each('['||replace(json_quote(${words}),' ','","')||']') WHERE length(value)>0)>=90`,
  ])} OR ${allOf([
    originalEditorialEquivalenceSql('p','m.semantic_json',editorial), `length(${editorial})>=500`,
    `instr(replace(replace(replace(${editorial},char(13),''),char(9),''),' ',''),char(10)||char(10))>0`,
    `(SELECT count(*) FROM json_each('['||replace(json_quote(${words}),' ','","')||']') WHERE length(value)>0)>=90`,
  ])})`,
  `NOT EXISTS(SELECT 1 FROM json_each('["title","description","imageUrl","affiliateUrl","editorialWriteup","punnyTitle","wittyDescription","humorTags"]') field
    WHERE (field.value IN ('title','description','imageUrl','affiliateUrl') OR json_type(${V_BASE},'$.'||field.value) IS NOT NULL)
    AND NOT coalesce(${baseGrant('basis')} IN ('owned','licensed') AND ${baseGrant('expiresAt')} IS NULL
      AND typeof(${baseGrant('reference')})='text' AND length(trim(${baseGrant('reference')},${TRIM}))>0
      AND typeof(${baseGrant('value')})='text' AND ${baseGrant('value')}=${baseDisplay},0))`,
])},0)`;
const LISTED=`(${VISIBLE} OR ${PERSISTENT_VISIBLE})`;
// A validated base may survive a revoked/expired supplier overlay. An unproven
// nested base is never sent simply because the outer supplier DTO is fresh.
const LISTED_DISPLAY=`CASE WHEN ${PERSISTENT_VISIBLE} THEN ${V_BASE}
  ELSE json_remove(v.public_display_json,'$.persistent') END`;
const SEMANTIC_DISPLAY=`CASE WHEN ${PERSISTENT_VISIBLE} THEN v.public_display_json
  ELSE json_remove(v.public_display_json,'$.persistent') END`;
// Start with revision/FTS candidates, then inspect each current product by its
// unique identity. Do not let the planner start with all active products.
const JOIN = `CROSS JOIN products p ON p.id=v.product_id AND p.public_id=v.public_id
  JOIN catalog_projection_receipts r ON r.catalog_revision=v.catalog_revision
  LEFT JOIN catalog_maintenance_products m ON m.product_id=p.id`;

async function hash(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export async function createProjectionPacket(snapshotInput: CatalogSnapshot, factsByPublicId: Record<string, string|null>, sourceSha256: string, now = new Date()): Promise<ProjectionPacket> {
  const snapshot = validateCatalogSnapshot(snapshotInput, now);
  if (snapshot.dataKind !== 'catalog' || !/^[a-f0-9]{64}$/.test(sourceSha256)) throw new Error('A real validated snapshot and source checksum are required');
  const rows = await Promise.all([...snapshot.products].sort((a, b) => a.publicId.localeCompare(b.publicId)).map(async (product) => {
    const factsHash = factsByPublicId[product.publicId];
    if (!/^[a-f0-9]{64}$/.test(factsHash || '')
      && !(factsHash===null&&product.eligibleUntil===null&&product.indexable===false)) throw new Error('Missing projection factual hash');
    const display = JSON.stringify(product);
    const indexed=persistentPublicProduct(product)??product;
    return { catalog_revision: snapshot.catalogRevision, public_id: product.publicId, product_id: product.id,
      slug: product.slug, title: indexed.title, description: indexed.description, tags: indexed.humorTags?.join(' ') || '',
      source_facts_hash: factsHash, eligible_until: product.eligibleUntil, public_display_json: display, display_sha256: await hash(display) };
  }));
  return { rows, receipt: { catalog_revision: snapshot.catalogRevision,
    // Same normalized bytes as the static build's catalogSnapshotSha256.
    snapshot_sha256: await hash(`${JSON.stringify(snapshot)}\n`), projection_sha256: await hash(JSON.stringify(rows)),
    source_export_sha256: sourceSha256, product_count: rows.length, created_at: snapshot.generatedAt } };
}
export function projectionPreflight(packet: ProjectionPacket): ProjectionQuery {
  return { sql: 'SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?', params: [packet.receipt.catalog_revision] };
}
export function projectionQueries(packet: ProjectionPacket, rowsPerInsert = 1): ProjectionQuery[] {
  if (!Number.isSafeInteger(rowsPerInsert) || rowsPerInsert < 1 || rowsPerInsert > 9) throw new Error('Invalid projection row group');
  const insert = (table: string, rows: Row[]): ProjectionQuery => {
    const columns = Object.keys(rows[0]);
    if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column)) || columns.length * rows.length > 100
      || rows.some(row => Object.keys(row).length !== columns.length || columns.some(column => !Object.hasOwn(row,column))))
      throw new Error('Invalid projection columns');
    return { sql: `INSERT INTO ${table} (${columns.join(',')}) VALUES ${rows.map(() => `(${columns.map(() => '?').join(',')})`).join(',')}`,
      params: rows.flatMap(row => columns.map(column => row[column])) };
  };
  const queries: ProjectionQuery[] = [];
  for (let offset = 0; offset < packet.rows.length; offset += rowsPerInsert)
    queries.push(insert('catalog_public_products', packet.rows.slice(offset, offset + rowsPerInsert)));
  return [...queries, insert('catalog_projection_receipts', [packet.receipt])];
}
function receiptMatches(actual: ProjectionReceipt, expected: ProjectionReceipt): boolean {
  return Object.keys(expected).every((key) => actual[key] === expected[key]);
}
async function assertStoredProjection(db: CatalogD1, packet: ProjectionPacket): Promise<void> {
  const result = await db.prepare('SELECT * FROM catalog_public_products WHERE catalog_revision=?')
    .bind(packet.receipt.catalog_revision).all<Row>();
  const stored = new Map(result.results.map((row) => [row.public_id, row]));
  if (result.results.length !== packet.rows.length || packet.rows.some((expected) => {
    const actual = stored.get(expected.public_id);
    return !actual || Object.keys(actual).length !== Object.keys(expected).length
      || Object.keys(expected).some((key) => actual[key] !== expected[key]);
  })) throw new Error('Stored public projection is incomplete or changed');
}
/** All projection rows and their visibility receipt become available together. */
export async function importPublicProjection(db: CatalogD1, packet: ProjectionPacket): Promise<'imported' | 'already_imported'> {
  if (packet.rows.length !== packet.receipt.product_count
    || await hash(JSON.stringify(packet.rows)) !== packet.receipt.projection_sha256
    || packet.rows.some((row) => row.catalog_revision !== packet.receipt.catalog_revision)) throw new Error('Projection packet checksum mismatch');
  const query = projectionPreflight(packet);
  const existing = await db.prepare(query.sql).bind(...query.params).all<ProjectionReceipt>();
  if (existing.results.length) {
    if (!receiptMatches(existing.results[0], packet.receipt)) throw new Error('Revision already exists with different projection bytes');
    await assertStoredProjection(db, packet);
    return 'already_imported';
  }
  const queries = projectionQueries(packet);
  // Publication command chunks large catalogs separately before one final receipt;
  // this helper deliberately handles one small atomic proof packet only.
  if (queries.length > 40) throw new Error('Atomic projection proof packet exceeds 39 products');
  await legacyMutationBatch(db, queries.map((item) => db.prepare(item.sql).bind(...item.params)));
  await assertStoredProjection(db, packet);
  return 'imported';
}
function publicRows(rows: { public_display_json: string }[], now: Date): PublicCatalogProduct[] {
  return rows.flatMap((row) => { try {
    const product=resolvePublicProduct(validatePublicCatalogProduct(JSON.parse(row.public_display_json),now),now);
    return product?[product]:[];
  } catch { return []; } });
}
/** Reused inside fenced publication SQL; omission uses the database execution clock. */
export function visibleRevisionCountQuery(revision: string, now?: Date): ProjectionQuery {
  const visible = now ? LISTED : LISTED.replaceAll('?', "strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  return { sql: `SELECT count(*) FROM catalog_public_products v ${JOIN}
    WHERE v.catalog_revision=? AND ${visible}`, params: [revision, ...(now ? [now.toISOString(), now.toISOString(), now.toISOString()] : [])] };
}
export async function getRevisionProductsByPublicIds(db: CatalogD1, ids: string[], now: Date, revision: string): Promise<PublicCatalogProduct[]> {
  return revisionProductsByPublicIds(db,ids,now,revision,false);
}
/** Validated permanent listing lookup; never substitute for semantic/native eligibility. */
export async function getListedRevisionProductsByPublicIds(db: CatalogD1, ids: string[], now: Date, revision: string): Promise<PublicCatalogProduct[]> {
  return revisionProductsByPublicIds(db,ids,now,revision,true);
}
async function revisionProductsByPublicIds(db: CatalogD1, ids: string[], now: Date, revision: string,listing:boolean): Promise<PublicCatalogProduct[]> {
  if (!revision || ids.length > 240) throw new Error('Revision and bounded product IDs required');
  const unique = [...new Set(ids)]; const found = new Map<string, PublicCatalogProduct>();
  for (let offset = 0; offset < unique.length; offset += 80) {
    const chunk = unique.slice(offset, offset + 80);
    const result = await db.prepare(`WITH requested(public_id) AS (VALUES ${chunk.map(() => '(?)').join(',')})
      SELECT ${listing?LISTED_DISPLAY:SEMANTIC_DISPLAY} public_display_json FROM requested
      CROSS JOIN catalog_public_products v ON v.public_id=requested.public_id AND v.catalog_revision=? ${JOIN}
      WHERE ${listing?LISTED:VISIBLE}`)
      .bind(...chunk,revision,
        now.toISOString(),now.toISOString(),now.toISOString()).all<{ public_display_json: string }>();
    for (const product of publicRows(result.results, now)) found.set(product.publicId, product);
  }
  return unique.flatMap((id) => found.has(id) ? [found.get(id)!] : []);
}
export async function keywordSearchRevision(db: CatalogD1, query: string, limit: number, now: Date, revision: string): Promise<PublicCatalogProduct[]> {
  const normalized = query.normalize('NFKC').trim();
  if (!revision || !Number.isInteger(limit) || limit < 1 || limit > 240) throw new Error('Revision and 1..240 candidate limit required');
  if (normalized.length < 2 || normalized.length > 200) return [];
  const words = catalogSearchTerms(normalized);
  if (!words.length) return [];
  const result = await db.prepare(`SELECT ${LISTED_DISPLAY} public_display_json FROM catalog_public_products_fts
    CROSS JOIN catalog_public_products v ON v.rowid=catalog_public_products_fts.rowid ${JOIN}
    WHERE catalog_public_products_fts MATCH ? AND v.catalog_revision=? AND ${LISTED}
    ORDER BY bm25(catalog_public_products_fts,4,1,2),v.public_id LIMIT ?`)
    .bind(words.map((word) => `"${word}"*`).join(' OR '), revision,
      now.toISOString(),now.toISOString(),now.toISOString(),limit)
    .all<{ public_display_json: string }>();
  return publicRows(result.results, now);
}
/** Rollback is an explicit compatibility check, never a blind old-Worker flip. */
export async function rollbackPreflight(db: CatalogD1, snapshot: CatalogSnapshot, now = new Date()): Promise<{ ok: boolean; reason: string }> {
  if (snapshot.products.some((product) => !resolvePublicProduct(product,now))) return { ok: false, reason: 'release_expired' };
  try { validateCatalogSnapshot(snapshot, now); } catch { return { ok: false, reason: 'release_invalid' }; }
  const receipt = await db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?')
    .bind(snapshot.catalogRevision).all<ProjectionReceipt>();
  if (receipt.results.length !== 1) return { ok: false, reason: 'projection_receipt_missing' };
  if (receipt.results[0].snapshot_sha256 !== await hash(`${JSON.stringify(snapshot)}\n`)
    || receipt.results[0].product_count !== snapshot.products.length) return { ok: false, reason: 'release_digest_mismatch' };
  const expected = new Map(snapshot.products.map((product) => [product.publicId, JSON.stringify(persistentPublicProduct(product)??resolvePublicProduct(product,now))]));
  let visible = 0;
  for (let offset = 0; offset < snapshot.products.length; offset += 240) {
    const products = await getListedRevisionProductsByPublicIds(db, snapshot.products.slice(offset, offset + 240).map((product) => product.publicId), now, snapshot.catalogRevision);
    if (products.some((product) => expected.get(product.publicId) !== JSON.stringify(product))) return { ok: false, reason: 'projection_bytes_incompatible' };
    visible += products.length;
  }
  if (visible !== snapshot.products.length) return { ok: false, reason: 'current_hold_or_factual_incompatibility' };
  return { ok: true, reason: 'eligible_revision_compatible' };
}
