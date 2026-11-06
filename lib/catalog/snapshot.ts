import { getGiftPath, hasIndexableGiftEditorial, hasReviewedGiftEditorial, hasReviewedGiftShortCopy, hasSubstantiveGiftEditorial, isPurchasableAvailability } from '../gift-slugs.ts';
import { EXACT_DUPLICATE_LISTINGS } from './duplicate-listings.ts';
import { isPersistentImagePath } from './persistent-image.ts';
import type { CatalogSnapshot, ContentRight, DisplayField, DisplayRights, HeldReason, ProductRights,
  PersistentCatalogProduct, PersistentProductInput, PublicCatalogProduct,
  SafeHeldProduct, SnapshotProductInput } from './types.ts';

export const EDITORIAL_MAX_AGE_MS = 35 * 24 * 60 * 60 * 1000;
const MERCHANT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const HELD_TITLE = 'Gift currently unavailable';
const HELD_DESCRIPTION = 'This gift is not currently available in the curated catalog. Browse other gifts instead.';
const PUBLIC_FIELDS = ['id', 'publicId', 'slug', 'title', 'description', 'imageUrl', 'affiliateUrl',
  'source', 'currency', 'price', 'isActive', 'qualityScore', 'eligibleUntil', 'punnyTitle',
  'wittyDescription', 'editorialWriteup', 'humorTags', 'indexable', 'persistent'];
const HELD_FIELDS = ['id', 'publicId', 'slug', 'path', 'title', 'description', 'reason', 'affiliateUrl'];
const OPTIONAL_FIELDS: DisplayField[] = ['punnyTitle', 'wittyDescription', 'editorialWriteup', 'humorTags'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function fail(message: string): never { throw new Error(`Invalid catalog snapshot: ${message}`); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected object');
  return value as Record<string, unknown>;
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail('unexpected public field');
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function canonicalTime(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('expected canonical UTC instant');
  return value;
}
function identity(value: Record<string, unknown>): void {
  if (!nonempty(value.id) || typeof value.publicId !== 'string' || !UUID.test(value.publicId)
    || typeof value.slug !== 'string' || value.slug.length > 160 || !SLUG.test(value.slug)) fail('identity');
}
function httpsUrl(value: unknown, fixture = false, image = false): value is string {
  if (typeof value !== 'string') return false;
  if (image && /^\/(?!\/)[a-zA-Z0-9/_\-.]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false;
    if (fixture) return url.hostname === 'example.invalid';
    if (image) return true; // The exact image's permission is checked before projection.
    return /^(?:www\.)?amazon\.(?:com|ca|co\.uk|de|fr|it|es|co\.jp|com\.au)$/.test(url.hostname)
      || /^(?:www\.)?etsy\.com$/.test(url.hostname);
  } catch { return false; }
}
function retailerIdentityUrl(value: string, id: string, source?: string): boolean {
  const url = new URL(value);
  if (url.hostname.includes('amazon.')) {
    const productId = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i)?.[1];
    return source !== 'etsy' && productId?.toUpperCase() === id.toUpperCase();
  }
  const productId = url.pathname.match(/^\/listing\/(\d+)(?:\/|$)/)?.[1];
  return source !== 'amazon' && productId === id;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function approvedRight(right: ContentRight | undefined, value: string, now: number): number | null {
  if (!right || !['owned', 'licensed', 'merchant'].includes(right.basis)
    || !nonempty(right.reference) || right.value !== value) return null;
  let expiry = Infinity;
  if (right.expiresAt) {
    try { expiry = Date.parse(canonicalTime(right.expiresAt)); } catch { return null; }
    if (expiry <= now) return null;
  }
  if (right.basis === 'merchant') {
    if (!right.observedAt || !right.expiresAt) return null;
    let observed: number;
    try { observed = Date.parse(canonicalTime(right.observedAt)); } catch { return null; }
    if (observed > now || expiry <= observed || expiry - observed > MERCHANT_MAX_AGE_MS) return null;
  }
  return expiry;
}

/** Recheck the exact fields of an existing sealed DTO against current grants.
 * This does not create rights or extend the DTO's previously sealed deadline.
 */
export function persistentDisplayRights(rights: ProductRights): DisplayRights { return rights.persistent ?? rights; }
export function publicProductRightsExpiry(product: PublicCatalogProduct, rights: ProductRights, now: Date): number | null {
  if (!Number.isFinite(now.getTime())) return null;
  if (product.persistent && (!rights.persistent
    || publicProductRightsExpiry(product.persistent, rights.persistent, now) !== Infinity)) return null;
  const permanent = product.eligibleUntil === null;
  const permission = permanent ? persistentDisplayRights(rights) : rights;
  const fields: DisplayField[] = ['title', 'description', 'imageUrl', 'affiliateUrl'];
  if (product.editorialWriteup) fields.push('editorialWriteup');
  for (const field of OPTIONAL_FIELDS) if (field in product && !fields.includes(field)) fields.push(field);
  const expiries = fields.map((field) => {
    const value = field === 'humorTags' ? JSON.stringify(product.humorTags) : product[field];
    const right = permission[field];
    if (permanent && (!right || right.basis === 'merchant' || right.expiresAt)) return null;
    return typeof value === 'string' && value.length ? approvedRight(right, value, now.getTime()) : null;
  });
  return expiries.some((value) => value === null) ? null : Math.min(...expiries as number[]);
}

export function validatePublicCatalogProduct(input: unknown, now: Date = new Date(), fixture = false): PublicCatalogProduct {
  const value = record(input);
  exactKeys(value, PUBLIC_FIELDS);
  identity(value);
  if (EXACT_DUPLICATE_LISTINGS[String(value.id)]) fail('confirmed duplicate');
  for (const field of ['title', 'description', 'currency']) if (!nonempty(value[field])) fail(field);
  if (!/^[A-Z]{3}$/.test(String(value.currency)) || !httpsUrl(value.imageUrl, fixture, true)
    || !httpsUrl(value.affiliateUrl, fixture) || !['amazon', 'etsy'].includes(String(value.source))
    || value.price !== 0 || value.isActive !== true || typeof value.qualityScore !== 'number'
    || !Number.isFinite(value.qualityScore) || value.qualityScore < (value.eligibleUntil === null ? 0 : 0.55)
    || value.qualityScore > 1) fail('display fields');
  if (!fixture && !retailerIdentityUrl(String(value.affiliateUrl), String(value.id), String(value.source))) fail('retailer identity');
  if ('indexable' in value && typeof value.indexable !== 'boolean') fail('indexability');
  if (value.eligibleUntil === null) {
    if (typeof value.indexable !== 'boolean' || !isPersistentImagePath(value.imageUrl)
      || 'persistent' in value) fail('persistent display');
    if (value.indexable && !hasSubstantiveGiftEditorial(value.editorialWriteup as string | undefined)) fail('persistent editorial');
  } else canonicalTime(value.eligibleUntil);
  for (const field of ['punnyTitle', 'wittyDescription', 'editorialWriteup']) {
    if (field in value && !nonempty(value[field])) fail(field);
  }
  if ('humorTags' in value && (!Array.isArray(value.humorTags) || value.humorTags.some((tag) => !nonempty(tag)))) fail('tags');
  if ('persistent' in value) {
    const persistent = record(value.persistent);
    if (persistent.eligibleUntil !== null || 'persistent' in persistent
      || ['id', 'publicId', 'slug', 'source', 'currency'].some(field => persistent[field] !== value[field])) fail('persistent identity');
    validatePublicCatalogProduct(persistent, now, fixture);
  }
  if (value.eligibleUntil !== null && Date.parse(String(value.eligibleUntil)) <= now.getTime()
    && !value.persistent) fail('expired public product');
  return freeze(structuredClone(value) as unknown as PublicCatalogProduct);
}

/** No supplier freshness/availability claim is promoted to permanent content. */
export function createPersistentCatalogProduct(input: PersistentProductInput, now: Date,
  fixture = false): PersistentCatalogProduct | null {
  const { product, rights } = input;
  // A historic ranking score is not a veto on an explicitly cleared listing.
  // Fresh supplier/long-editorial publication keeps its separate quality gate.
  if (product.isActive === false || product.duplicateOfProductId || EXACT_DUPLICATE_LISTINGS[product.id] || !Number.isFinite(product.qualityScore)
    || product.qualityScore! < 0 || product.qualityScore! > 1
    || ['blocked', 'needs_review'].includes(product.editorialStatus ?? '')) return null;
  const result: PersistentCatalogProduct = { id: product.id, publicId: product.publicId, slug: product.slug,
    source: product.source, currency: product.currency, title: product.title,
    description: product.description || product.wittyDescription || product.title,
    imageUrl: product.imageUrl, affiliateUrl: product.affiliateUrl, price: 0, isActive: true,
    qualityScore: product.qualityScore!, eligibleUntil: null, indexable: hasReviewedGiftEditorial(product) };
  for (const field of OPTIONAL_FIELDS) {
    const value = field === 'humorTags' ? product.humorTags?.length ? JSON.stringify(product.humorTags) : undefined : product[field];
    const right = rights[field];
    if (!value || !right || right.basis === 'merchant' || right.expiresAt
      || approvedRight(right, value, now.getTime()) !== Infinity) continue;
    if (field === 'humorTags') result.humorTags = [...product.humorTags!];
    else result[field] = value;
  }
  // A private editorial flag alone cannot make omitted/unproven copy indexable.
  if (!result.editorialWriteup) result.indexable = false;
  if (publicProductRightsExpiry(result, rights, now) !== Infinity) return null;
  return validatePublicCatalogProduct(result, now, fixture) as PersistentCatalogProduct;
}

/** Validates the complete allowlist; callers cannot spread private DB records into public files. */
export function validateCatalogSnapshot(input: unknown, now: Date = new Date()): CatalogSnapshot {
  const value = record(structuredClone(input));
  exactKeys(value, ['schemaVersion', 'dataKind', 'catalogRevision', 'generatedAt', 'products', 'heldProducts', 'slugHistory']);
  if (value.schemaVersion !== 1 || !['catalog', 'synthetic_fixture'].includes(String(value.dataKind))
    || !nonempty(value.catalogRevision) || !Number.isFinite(now.getTime())) fail('header');
  if (Date.parse(canonicalTime(value.generatedAt)) > now.getTime()) fail('future snapshot');
  if (!Array.isArray(value.products) || !Array.isArray(value.heldProducts) || !Array.isArray(value.slugHistory)) fail('collections');
  const ids = new Set<string>(); const publicIds = new Set<string>(); const slugs = new Set<string>();
  for (const raw of [...value.products, ...value.heldProducts]) {
    const p = record(raw); identity(p);
    if (ids.has(String(p.id)) || publicIds.has(String(p.publicId)) || slugs.has(String(p.slug))) fail('duplicate identity');
    ids.add(String(p.id)); publicIds.add(String(p.publicId)); slugs.add(String(p.slug));
  }
  const fixture = value.dataKind === 'synthetic_fixture';
  const validatedProducts = value.products.map((p) => validatePublicCatalogProduct(p, now, fixture));
  value.products = validatedProducts;
  for (const raw of value.heldProducts) {
    const p = record(raw); exactKeys(p, HELD_FIELDS);
    if (p.path !== getGiftPath(String(p.slug)) || p.title !== HELD_TITLE || p.description !== HELD_DESCRIPTION
      || !['inactive', 'duplicate', 'editorial_hold', 'expired', 'rights_unverified', 'unavailable'].includes(String(p.reason))
      || ('affiliateUrl' in p && !httpsUrl(p.affiliateUrl, fixture))) fail('held product');
    if (!fixture && 'affiliateUrl' in p && !retailerIdentityUrl(String(p.affiliateUrl), String(p.id))) fail('held retailer identity');
  }
  const all = [...validatedProducts, ...value.heldProducts] as Array<{ publicId: string; slug: string }>;
  for (const raw of value.slugHistory) {
    const h = record(raw); exactKeys(h, ['slug', 'canonicalSlug', 'publicId']);
    if (typeof h.slug !== 'string' || !SLUG.test(h.slug) || slugs.has(h.slug)
      || !all.some((p) => p.publicId === h.publicId && p.slug === h.canonicalSlug)) fail('slug history');
    slugs.add(h.slug);
  }
  return freeze(structuredClone(value) as unknown as CatalogSnapshot);
}

export function createCatalogSnapshot(products: SnapshotProductInput[], rightsById: Record<string, ProductRights>, options: {
  catalogRevision: string; now: Date; dataKind?: CatalogSnapshot['dataKind'];
  slugHistory?: CatalogSnapshot['slugHistory'];
  persistentById?: Record<string, PersistentProductInput>;
}): CatalogSnapshot {
  const now = options.now.getTime();
  const ready: PublicCatalogProduct[] = []; const held: SafeHeldProduct[] = [];
  for (const product of products) {
    const rights = rightsById[product.id] || {};
    const persistentInput = options.persistentById?.[product.id];
    if (persistentInput && ['id', 'publicId', 'slug', 'source', 'currency']
      .some(field => persistentInput.product[field as keyof SnapshotProductInput] !== product[field as keyof SnapshotProductInput]))
      fail('persistent identity');
    // Clearance of presentation fields cannot override the source row's curation.
    const persistent = persistentInput && !['blocked', 'needs_review'].includes(product.editorialStatus ?? '')
      ? createPersistentCatalogProduct({ ...persistentInput,
      product: { ...persistentInput.product, isActive: product.isActive,
        duplicateOfProductId: product.duplicateOfProductId, qualityScore: product.qualityScore,
        editorialStatus: persistentInput.product.editorialWriteup === product.editorialWriteup ? product.editorialStatus : 'pending',
        editorialQualityScore: product.editorialQualityScore,
        sourceFactsHash: product.sourceFactsHash, editorialSourceHash: product.editorialSourceHash } }, options.now,
      options.dataKind === 'synthetic_fixture') : null;
    const shortReady = hasReviewedGiftShortCopy(product);
    const values: Partial<Record<DisplayField, string>> = {
      title: product.title, description: shortReady ? product.wittyDescription : product.description || product.wittyDescription,
      imageUrl: product.imageUrl, affiliateUrl: product.affiliateUrl,
      punnyTitle: product.punnyTitle, wittyDescription: product.wittyDescription,
      editorialWriteup: product.editorialStatus === 'short_ready' ? undefined : product.editorialWriteup,
      humorTags: product.humorTags?.length ? JSON.stringify(product.humorTags) : undefined,
    };
    const verifiedRaw = product.availabilityCheckedAt || product.lastVerifiedAt;
    const verified = verifiedRaw ? new Date(verifiedRaw).getTime() : NaN;
    const editorialExpiry = verified + EDITORIAL_MAX_AGE_MS;
    let reason: HeldReason | undefined;
    if (product.isActive === false) reason = 'inactive';
    else if (product.duplicateOfProductId || EXACT_DUPLICATE_LISTINGS[product.id]) reason = 'duplicate';
    else if (!Number.isFinite(verified) || verified > now || editorialExpiry <= now) reason = 'expired';
    else if (!(hasIndexableGiftEditorial(product, options.now) || shortReady && isPurchasableAvailability(product.availabilityStatus))
      || (product.qualityScore || 0) < 0.55) reason = 'editorial_hold';
    const required: DisplayField[] = ['title', 'description', 'imageUrl', 'affiliateUrl', ...(!shortReady ? ['editorialWriteup' as const] : [])];
    const expiries = required.map((field) => approvedRight(rights[field], values[field] || '', now));
    if (!reason && expiries.some((expiry) => expiry === null)) reason = 'rights_unverified';
    if (reason) {
      if (persistent && reason !== 'inactive' && reason !== 'duplicate') { ready.push(persistent); continue; }
      // A held page never carries a merchant title, image, price or stale editorial.
      const safe: SafeHeldProduct = { id: product.id, publicId: product.publicId, slug: product.slug,
        path: getGiftPath(product.slug), title: HELD_TITLE, description: HELD_DESCRIPTION, reason };
      // Only non-expiring owned/licensed links survive the safe variant.
      const linkRight = rights.affiliateUrl;
      if (linkRight && linkRight.basis !== 'merchant' && !linkRight.expiresAt
        && approvedRight(linkRight, product.affiliateUrl, now) !== null) safe.affiliateUrl = product.affiliateUrl;
      held.push(safe); continue;
    }
    const display: PublicCatalogProduct = { id: product.id, publicId: product.publicId, slug: product.slug,
      title: product.title, description: values.description!, imageUrl: product.imageUrl,
      affiliateUrl: product.affiliateUrl, source: product.source, currency: product.currency,
      price: 0, isActive: true, qualityScore: product.qualityScore!, eligibleUntil: '' };
    for (const field of OPTIONAL_FIELDS) {
      const raw = values[field];
      if (!raw) continue;
      const expiry = approvedRight(rights[field], raw, now);
      if (expiry === null) continue;
      expiries.push(expiry);
      if (field === 'humorTags') display.humorTags = [...product.humorTags!];
      else display[field] = raw;
    }
    display.eligibleUntil = new Date(Math.min(editorialExpiry, ...(expiries as number[]))).toISOString();
    if (persistent) display.persistent = persistent;
    ready.push(display);
  }
  return validateCatalogSnapshot({ schemaVersion: 1, dataKind: options.dataKind || 'catalog',
    catalogRevision: options.catalogRevision, generatedAt: options.now.toISOString(),
    products: ready.sort((a, b) => a.publicId.localeCompare(b.publicId)),
    heldProducts: held.sort((a, b) => a.publicId.localeCompare(b.publicId)),
    slugHistory: [...(options.slugHistory || [])].sort((a, b) => a.slug.localeCompare(b.slug)) }, options.now);
}
