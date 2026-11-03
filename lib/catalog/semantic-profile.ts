import { canonicalJson } from './canonical-json.ts';
import type { PublicCatalogProduct } from './types.ts';

/** Derived search only; the original 1536-d native maintenance contract is unchanged. */
export const DERIVED_SEARCH_PROFILE = Object.freeze({
  id: 'openai-v3-small-1024-prefix-l2-f32-v1', model: 'text-embedding-3-small',
  sourceDimensions: 1536, dimensions: 1024, transform: 'prefix-l2-float32-v1',
  inputRecipe: 'public-fields-plus-retained-context-v1',
} as const);
export type DerivedSearchProfile = typeof DERIVED_SEARCH_PROFILE;
export interface SemanticCatalogEntry {
  vectorId: string; publicId: string; productId: string; publicFieldsSha256: string;
  inputSha256: string; originalNativeSha256: string; derivedNativeSha256: string;
  receiptSha256: string; sourceFactsHash: string;
}
export type SemanticVectorBinding=Omit<SemanticCatalogEntry,'receiptSha256'|'sourceFactsHash'>;
export interface SemanticCatalog {
  schemaVersion: 1; indexName: string; profile: DerivedSearchProfile; entries: SemanticCatalogEntry[];
}
export const semanticHash = async (text: string) => [...new Uint8Array(await crypto.subtle.digest(
  'SHA-256', new TextEncoder().encode(text)))].map(v => v.toString(16).padStart(2, '0')).join('');

/** These exact fields feed the retained producer recipe, not volatile offers,
 * descriptions, scores, slugs, receipt dates or daily catalog revisions. */
export function semanticPublicFields(product: PublicCatalogProduct) {
  return { title: product.title, punnyTitle: product.punnyTitle ?? null,
    wittyDescription: product.wittyDescription ?? null, humorTags: product.humorTags ?? [] };
}
export function semanticProductInput(product: PublicCatalogProduct, retainedContext: string | null) {
  return [product.punnyTitle, product.title, product.wittyDescription, retainedContext,
    product.humorTags?.join(' ')].filter(Boolean).join('. ');
}
export function normalizeSemanticPrefix(values: readonly number[], dimensions: number) {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || dimensions > values.length
    || values.some(v => !Number.isFinite(v))) throw new Error('search_embedding_dimensions');
  const prefix = values.slice(0, dimensions).map(Math.fround), norm = Math.hypot(...prefix);
  if (!Number.isFinite(norm) || !norm) throw new Error('search_embedding_zero_norm');
  const vector = prefix.map(value => Math.fround(value / norm));
  if (Math.abs(Math.hypot(...vector) - 1) > 1e-6) throw new Error('search_embedding_normalization');
  return vector;
}
export function semanticVectorIdentity(entry: Omit<SemanticVectorBinding, 'vectorId'> | SemanticVectorBinding) {
  return semanticHash(canonicalJson({ profile: DERIVED_SEARCH_PROFILE, publicId: entry.publicId,
    productId: entry.productId, publicFieldsSha256: entry.publicFieldsSha256, inputSha256: entry.inputSha256,
    originalNativeSha256: entry.originalNativeSha256, derivedNativeSha256: entry.derivedNativeSha256 }));
}
export function semanticVectorMetadata(entry: SemanticVectorBinding) {
  const profile = DERIVED_SEARCH_PROFILE;
  return { profile: profile.id, model: profile.model, dimensions: profile.dimensions, transform: profile.transform,
    publicId: entry.publicId, publicFieldsSha256: entry.publicFieldsSha256, inputSha256: entry.inputSha256,
    originalNativeSha256: entry.originalNativeSha256, derivedNativeSha256: entry.derivedNativeSha256 };
}
/** Trusted index metadata is self-describing; current PUBLIC membership and
 * input hashes are still checked by the resolver. No client-supplied entries. */
export function semanticEntryFromMetadata(vectorId: string, metadata: unknown, productId: string): SemanticVectorBinding | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = metadata as ReturnType<typeof semanticVectorMetadata>;
  const entry = { vectorId, productId, publicId:m.publicId, publicFieldsSha256:m.publicFieldsSha256,
    inputSha256:m.inputSha256, originalNativeSha256:m.originalNativeSha256, derivedNativeSha256:m.derivedNativeSha256 };
  if(!/^[a-zA-Z0-9_-]{1,100}$/.test(productId)||typeof m.publicId!=='string'
    ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.publicId)
    ||[vectorId,m.publicFieldsSha256,m.inputSha256,m.originalNativeSha256,m.derivedNativeSha256]
      .some(v=>typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v)))return null;
  return canonicalJson(metadata) === canonicalJson(semanticVectorMetadata(entry)) ? entry : null;
}
/** Structural validation does not attest a provider receipt or index coverage. */
export function validateSemanticCatalog(value: unknown): SemanticCatalog {
  const catalog = value as SemanticCatalog;
  const hash = /^[a-f0-9]{64}$/;
  if (!catalog || Object.keys(catalog).sort().join(',') !== 'entries,indexName,profile,schemaVersion'
    || catalog.schemaVersion !== 1 || typeof catalog.indexName !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(catalog.indexName)
    || canonicalJson(catalog.profile) !== canonicalJson(DERIVED_SEARCH_PROFILE)
    || !Array.isArray(catalog.entries) || catalog.entries.length < 1 || catalog.entries.length > 10_000)
    throw new Error('semantic_catalog_invalid');
  const products = new Set<string>(), vectors = new Set<string>(), publicIds = new Set<string>();
  for (const entry of catalog.entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'derivedNativeSha256,inputSha256,originalNativeSha256,productId,publicFieldsSha256,publicId,receiptSha256,sourceFactsHash,vectorId'
      || typeof entry.productId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(entry.productId)
      || typeof entry.publicId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(entry.publicId)
      || [entry.vectorId, entry.publicFieldsSha256, entry.inputSha256, entry.originalNativeSha256,
        entry.derivedNativeSha256, entry.receiptSha256, entry.sourceFactsHash].some(v => typeof v !== 'string' || !hash.test(v))
      || products.has(entry.productId) || vectors.has(entry.vectorId) || publicIds.has(entry.publicId))
      throw new Error('semantic_catalog_entry_invalid');
    products.add(entry.productId); vectors.add(entry.vectorId); publicIds.add(entry.publicId);
  }
  return structuredClone(catalog);
}
export async function verifySemanticCatalogIdentities(value: unknown): Promise<SemanticCatalog> {
  const catalog = validateSemanticCatalog(value);
  if ((await Promise.all(catalog.entries.map(async entry => await semanticVectorIdentity(entry) === entry.vectorId))).some(valid => !valid))
    throw new Error('semantic_vector_identity_mismatch');
  return catalog;
}
