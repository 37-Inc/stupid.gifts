import { canonicalJson, canonicalTimestamp, moneyToMinor, sha256 } from './migration.ts';
import { createCatalogSnapshot, createPersistentCatalogProduct, persistentDisplayRights, publicProductRightsExpiry,
  validatePublicCatalogProduct } from '../../lib/catalog/snapshot.ts';
import type { DisplayRights, PersistentCatalogProduct, ProductRights, SnapshotProductInput } from '../../lib/catalog/types.ts';
import { isPurchasableAvailability, hasReviewedGiftShortCopy } from '../../lib/gift-slugs.ts';
import { editorialSourceHash } from '../ops/catalog-editorial-core.mjs';
import { normalizedEditorialFacts, originalEditorialEquivalent } from '../../lib/catalog/editorial-equivalence.ts';

export type Row = Record<string, unknown>;
/** Private PG semantics, not a public DTO. Existing wall times stay opaque. */
export interface SemanticProduct {
  [key: string]: unknown;
  id: string; title: string; publicId: string; slug: string; price: string; currency: string;
  imageUrl: string | null; affiliateUrl: string; source: 'amazon' | 'etsy'; sourceQuery: string | null;
  humorTags: Array<string | null> | null; punnyTitle: string | null; wittyDescription: string | null;
  qualityScore: string | null; rating: string | null; reviewCount: number | null; isActive: boolean;
  embedding: number[] | null; editorialWriteup: string | null; sourceFacts: Record<string, unknown> | null;
  sourceFactsHash: string | null; editorialSourceHash: string | null; availabilityStatus: string | null;
  editorialStatus: string; editorialQualityScore: string | null; editorialModel: string | null;
  editorialPromptVersion: string | null; editorialGeneratedAt: string | null; editorialBlockReason: string | null;
  duplicateOfProductId: string | null; contentUpdatedAt: string | null; availabilityCheckedAt: string | null;
  lastVerifiedAt: string | null; createdAt: string | null; updatedAt: string | null;
  /** Exact existing nonmerchant clearance, retained privately through curation holds. */
  persistentBase?: PersistentCatalogProduct;
  /** D1 daily retailer eligibility is separate from cleared listing curation. */
  supplierEligible?: boolean;
}
const FIELDS = ['id','title','price','currency','imageUrl','affiliateUrl','source','sourceQuery','humorTags','punnyTitle',
  'wittyDescription','qualityScore','rating','reviewCount','isActive','editorialWriteup','sourceFacts','sourceFactsHash',
  'editorialSourceHash','availabilityStatus','availabilityCheckedAt','editorialStatus','editorialQualityScore','editorialModel',
  'editorialPromptVersion','editorialGeneratedAt','editorialBlockReason','duplicateOfProductId','contentUpdatedAt',
  'lastVerifiedAt','createdAt','updatedAt'];
export const snake = (key: string): string => key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
const TIMES = ['availabilityCheckedAt','lastVerifiedAt','createdAt','updatedAt'];

/** PG one-dimensional text[] transport, including NULL/empty/escaped elements. */
export function maintenanceTextArray(value: unknown): Array<string | null> | null {
  if (value === null) return null;
  if (Array.isArray(value) && value.every(v => v === null || typeof v === 'string')) return [...value];
  if (typeof value !== 'string' || !value.startsWith('{') || !value.endsWith('}')) throw new Error('maintenance_text_array');
  if (value === '{}') return [];
  const result: Array<string | null> = []; let index = 1;
  while (index < value.length-1) {
    const quoted = value[index] === '"'; if (quoted) index++;
    let part = ''; let closed = !quoted;
    while (index < value.length-1) {
      const c = value[index++];
      if (c === '\\') { if (index >= value.length-1) throw new Error('maintenance_text_array'); part += value[index++]; }
      else if (quoted && c === '"') { closed = true; break; }
      else if (!quoted && c === ',') { index--; break; }
      else if (!quoted && /[{}"]/.test(c)) throw new Error('maintenance_text_array');
      else part += c;
    }
    if (!closed || !quoted && !part) throw new Error('maintenance_text_array');
    result.push(!quoted && part === 'NULL' ? null : part);
    if (index < value.length-1 && value[index++] !== ',' || index === value.length-1 && value[index-1] === ',') throw new Error('maintenance_text_array');
  }
  return result;
}

/** Raw historical payloads keep wall times. Only typed, evidenced instants may
 * drive current eligibility/order. The preserved cohort may supply a reviewed
 * private override when its current facts differ from the old archive.
 */
export function maintenanceState(row: Row, override?: { product: SemanticProduct; evidence: string }): SemanticProduct {
  for (const key of TIMES) if (row[snake(key)] !== null) explicitMaintenanceTime(row[snake(key)]);
  if (row.maintenance_semantic !== null && row.maintenance_semantic !== undefined) {
    const current = JSON.parse(String(row.maintenance_semantic)) as SemanticProduct;
    const typed = { publicId:'public_id',slug:'slug',source:'source',editorialStatus:'editorial_status',
      duplicateOfProductId:'duplicate_of_product_id',availabilityStatus:'availability_status',sourceFactsHash:'source_facts_hash',
      editorialSourceHash:'editorial_source_hash',availabilityCheckedAt:'availability_checked_at',lastVerifiedAt:'last_verified_at',
      createdAt:'created_at',updatedAt:'updated_at' };
    if (current.id !== row.id || current.isActive !== (row.is_active === 1)
      || current.supplierEligible!==undefined&&typeof current.supplierEligible!=='boolean'
      || (current.qualityScore === null ? null : Number(current.qualityScore)) !== row.quality_score
      || Object.entries(typed).some(([key,column]) => current[key] !== row[column])) throw new Error('maintenance_current_state_drift');
    return current;
  }
  const raw = JSON.parse(String(row.source_record_json));
  if (raw.id !== row.id || raw.public_id !== row.public_id || raw.slug !== row.slug) throw new Error('maintenance_archive_identity');
  const p = Object.fromEntries(FIELDS.map(key => [key, raw[snake(key)] ?? null])) as SemanticProduct;
  p.sourceFacts = typeof p.sourceFacts === 'string' ? JSON.parse(p.sourceFacts) : p.sourceFacts;
  p.humorTags = maintenanceTextArray(raw.humor_tags);
  p.reviewCount = p.reviewCount === null ? null : Number(p.reviewCount);
  if (override) {
    if (!override.evidence.trim() || override.product.id !== row.id) throw new Error('maintenance_override_evidence');
    Object.assign(p, structuredClone(override.product));
  }
  for (const key of TIMES) p[key] = row[snake(key)];
  Object.assign(p, { publicId: row.public_id, slug: row.slug, source: row.source, isActive: row.is_active === 1,
    qualityScore: row.quality_score === null ? null : Number(row.quality_score).toFixed(4),
    sourceFactsHash: row.source_facts_hash, editorialSourceHash: row.editorial_source_hash,
    availabilityStatus: row.availability_status, editorialStatus: row.editorial_status,
    duplicateOfProductId: row.duplicate_of_product_id, embedding: null });
  if (typeof p.title !== 'string' || typeof p.affiliateUrl !== 'string' || !['amazon','etsy'].includes(p.source)
    || typeof p.isActive !== 'boolean') throw new Error('maintenance_archive_fields');
  return p;
}

/** Keep the original identity rules, but trim again after truncation so a new
 * URL cannot end in a separator. Existing product slugs never regenerate. */
export function maintenanceSlugs(product: SemanticProduct, publicId: string): string[] {
  const base = (String(product.punnyTitle || product.title).toLowerCase().replace(/[^a-z0-9]+/g,'-')
    .replace(/^-+|-+$/g,'').slice(0,120).replace(/-+$/g,'')) || 'ridiculous-gift';
  const hex = publicId.replaceAll('-','');
  return [base, ...[8,12,16,20,24,28,32].map(length => `${base.slice(0,159-length)}-${hex.slice(0,length)}`)];
}

/** Same five fields/order as the existing runner's buildProductEmbeddingText. */
export function maintenanceEmbeddingText(p: SemanticProduct): string {
  return [p.punnyTitle,p.title,p.wittyDescription,p.sourceQuery,p.humorTags?.join(' ')].filter(Boolean).join('. ');
}
export function maintenanceRow(p: SemanticProduct): Row {
  return { ...Object.fromEntries(FIELDS.filter(key => !['createdAt','updatedAt'].includes(key)).map(key => [snake(key),p[key] ?? null])),slug:p.slug };
}
export function publishedMaintenanceProduct(p: SemanticProduct): boolean {
  if (hasReviewedGiftShortCopy({ editorialStatus:p.editorialStatus, isActive:p.isActive, editorialQualityScore: Number(p.editorialQualityScore),
    wittyDescription:p.wittyDescription ?? undefined, sourceFactsHash:p.sourceFactsHash ?? undefined,
    editorialSourceHash:p.editorialSourceHash ?? undefined, duplicateOfProductId:p.duplicateOfProductId ?? undefined }))
    return Boolean(p.slug && p.imageUrl && isPurchasableAvailability(p.availabilityStatus || undefined));
  // Structural published lane, intentionally no35-day age test.
  const copy = String(p.editorialWriteup || '').replace(/^[ \t\n\r]+|[ \t\n\r]+$/g,'');
  return Boolean(p.slug && p.imageUrl && ['generated_ready','manual_locked'].includes(p.editorialStatus)
    && Number(p.editorialQualityScore) >= .8 && !p.duplicateOfProductId && isPurchasableAvailability(p.availabilityStatus || undefined)
    && p.sourceFactsHash && p.sourceFactsHash === p.editorialSourceHash
    && Array.from(copy).length >= 500 && copy.split(/\s+/).length >= 90 && /\n\s*\n/.test(copy));
}
export function explicitMaintenanceTime(value: unknown): string {
  if (typeof value !== 'string' || !value.endsWith('Z')) throw new Error('maintenance_utc_required');
  return canonicalTimestamp(value)!;
}
export function maintenanceTimeOrder(a: unknown,b: unknown,nullsFirst: boolean): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? nullsFirst ? -1 : 1 : nullsFirst ? 1 : -1;
  const at=explicitMaintenanceTime(a);const bt=explicitMaintenanceTime(b);
  return at < bt ? -1 : at > bt ? 1 : 0;
}
/** Recover clearance only from an existing saved base, never from fresh grants
 * or merchant fields. Current factual/curation checks still decide its display. */
function retainedBase(previous: { row: Row; product: SemanticProduct } | undefined, p: SemanticProduct,
  rights: ProductRights, now: Date) {
  if (!previous) return null;
  try {
    const oldRights = JSON.parse(String(previous.row.rights_json)) as ProductRights;
    const saved = JSON.parse(String(previous.row.public_display_json));
    const candidate = saved?.eligibleUntil === null ? saved : saved?.persistent ?? previous.product.persistentBase;
    if (!candidate) return null;
    const base = structuredClone(validatePublicCatalogProduct(candidate, now)) as PersistentCatalogProduct;
    const permission: DisplayRights = persistentDisplayRights(oldRights);
    if (base.eligibleUntil !== null || ['id','publicId','slug','source','currency'].some(key => base[key as keyof typeof base] !== p[key])
      || publicProductRightsExpiry(base, permission, now) !== Infinity
      || rights.persistent && canonicalJson(rights.persistent) !== canonicalJson(permission)) return null;
    // Preserve the original cleared base privately, while still deriving the
    // current display from the current reviewed view. This does not republish
    // suppressed or unreviewed content.
    let originalBase = structuredClone(base);
    if (previous.product.persistentBase) {
      try {
        const historical=validatePublicCatalogProduct(previous.product.persistentBase,now) as PersistentCatalogProduct;
        const fields=['title','description','imageUrl','affiliateUrl','punnyTitle','wittyDescription','editorialWriteup','humorTags'] as const;
        if (historical.eligibleUntil===null && ['id','publicId','slug','source','currency'].every(key=>historical[key as keyof typeof historical]===p[key])
          && fields.every(field=>base[field]===undefined||canonicalJson(base[field])===canonicalJson(historical[field]??null))
          && (!base.indexable||historical.indexable)
          && publicProductRightsExpiry(historical,permission,now)===Infinity) originalBase=structuredClone(historical);
      } catch { /* Keep the current exact cleared view, not an invalid history. */ }
    }
    // Independently cleared title/description remain exact licensed fallback
    // values even when a new supplier overlay or reviewed short copy changes.
    // The old grant never authorizes the replacement copy.
    for (const field of ['punnyTitle','wittyDescription','humorTags'] as const) {
      if (canonicalJson(base[field] ?? null) !== canonicalJson(p[field] ?? null)) delete base[field];
    }
    const facts = normalizedEditorialFacts(previous.product.sourceFacts);
    const retainedEditorial = Boolean(base.editorialWriteup && p.editorialWriteup === base.editorialWriteup
      && Number(p.editorialQualityScore) >= .8 && facts !== null && facts === normalizedEditorialFacts(p.sourceFacts)
      && editorialSourceHash(p) === p.sourceFactsHash);
    if (base.editorialWriteup && !retainedEditorial) {
      delete base.editorialWriteup; base.indexable = false;
    }
    const product = { ...base, isActive:p.isActive, duplicateOfProductId:p.duplicateOfProductId,
      qualityScore:p.qualityScore === null ? undefined : Number(p.qualityScore), editorialStatus:p.editorialStatus,
      editorialQualityScore:p.editorialQualityScore === null ? undefined : Number(p.editorialQualityScore),
      sourceFactsHash:p.sourceFactsHash, editorialSourceHash:p.editorialSourceHash } as unknown as SnapshotProductInput;
    const display = createPersistentCatalogProduct({product,rights:permission},now);
    // Preserve the ORIGINAL approved article only; no current hash/status or
    // supplier/native binding is rewritten to pretend a new review happened.
    const equivalent = display && base.indexable && retainedEditorial && originalEditorialEquivalent(
      previous.row.source_record_json, p, base.editorialWriteup!, editorialSourceHash);
    return { saved:originalBase, rights:permission, display:equivalent
      ? validatePublicCatalogProduct({...display,indexable:true},now) as PersistentCatalogProduct : display };
  } catch { return null; } // Unknown/corrupt clearance never becomes a public grant.
}
export function maintenanceProjection(p: SemanticProduct, rights: ProductRights, revision: string, now: string,
  provenInput: boolean, observedVerification: string | null, previous?: { row: Row; product: SemanticProduct }, allowApprovedBase=false) {
  const input = { ...p, price: Number(p.price), qualityScore: p.qualityScore === null ? undefined : Number(p.qualityScore),
    editorialQualityScore: p.editorialQualityScore === null ? undefined : Number(p.editorialQualityScore),
    // PG's mutation NOW is retained in the private/typed row, but publishing
    // cannot turn an old actual observation into a fresh35-day verification.
    availabilityCheckedAt: observedVerification || undefined, lastVerifiedAt: undefined,
    humorTags: p.humorTags || undefined } as unknown as SnapshotProductInput;
  // A rights grant does not prove source facts or the vector's current input.
  let supplier;
  if (provenInput && p.supplierEligible!==false && /^[a-f0-9]{64}$/.test(p.sourceFactsHash || '')) {
    try { supplier=createCatalogSnapshot([input], { [p.id]: rights }, { catalogRevision: revision, now: new Date(now) }).products[0]; }
    catch { /* Invalid display data stays private/held; never rewrite the SQL semantic payload. */ }
  }
  let base=retainedBase(previous,p,rights,new Date(now));
  // D1-only positive approval. Root merchant grants/title are NEVER a fallback
  // authority. Every presented value is independently checked by the canonical
  // persistent constructor, including owner-cleared existing imagery.
  if(!base&&allowApprovedBase&&rights.persistent){
    const permission=rights.persistent;
    try{
      const product={...input,title:permission.title?.value,description:permission.description?.value,
        imageUrl:permission.imageUrl?.value,affiliateUrl:permission.affiliateUrl?.value} as SnapshotProductInput;
      const display=createPersistentCatalogProduct({product,rights:permission},new Date(now));
      if(display)base={saved:display,display,rights:permission};
    }catch{ /* Supplied but invalid clearance remains held, never synthesized. */ }
  }
  const display=supplier ? {...supplier,...(base?.display ? {persistent:base.display} : {})} : base?.display;
  // Preserve supplier evidence/deadlines even when only the permanent view is
  // displayable. Its independent exact grants remain in their existing lane.
  const storedRights=base ? {...rights,persistent:base.rights} : rights;
  // Postgres permits negative numeric prices; retain them privately but never
  // turn a nonpositive/unknown price into a public offer or invalid D1 amount.
  const price = Number(p.price) > 0 ? moneyToMinor(p.price, p.currency) : null;
  return { semanticEligible:Boolean(supplier), persistentBase:base?.saved, row:{ id: p.id, public_id: p.publicId, slug: p.slug, source: p.source,
    title: display?.title || '', description: display?.description || '', tags: display?.humorTags?.join(' ') || '',
    price_minor: price, currency: p.currency, quality_score: p.qualityScore === null ? null : Number(p.qualityScore),
    is_active: p.isActive ? 1 : 0, duplicate_of_product_id: p.duplicateOfProductId ?? null,
    editorial_status: p.editorialStatus, availability_status: p.availabilityStatus,
    availability_checked_at: p.availabilityCheckedAt, last_verified_at: p.lastVerifiedAt,
    source_facts_hash: p.sourceFactsHash, editorial_source_hash: p.editorialSourceHash,
    catalog_revision: revision, eligible_until: display?.eligibleUntil || null,
    public_display_json: display ? canonicalJson(display) : null, rights_json: canonicalJson(storedRights),
    created_at: p.createdAt, updated_at: p.updatedAt } };
}
export function maintenanceDigest(value: unknown): string { return sha256(canonicalJson(value)); }
