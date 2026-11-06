import { canonicalJson } from '../../lib/catalog/canonical-json.ts';
import { persistentPublicProduct } from '../../lib/catalog/display.ts';
import { semanticHash, semanticPublicFields, semanticVectorIdentity, semanticVectorMetadata,
  validateSemanticCatalog, semanticEntryFromMetadata, DERIVED_SEARCH_PROFILE } from '../../lib/catalog/semantic-profile.ts';
import type { CatalogSnapshot } from '../../lib/catalog/types.ts';
import type { VectorMatch } from './bindings.ts';
import { hasRepairedSemanticCopy, productPresentation } from '../../lib/catalog/presentation.ts';

/** Compiled, hash-bound artifact + CURRENT public snapshot, never broad D1 lookup.
 * Do not equate this local contract with actual index coverage/quality acceptance.
 */
export function createDerivedSemanticSearch(snapshot: CatalogSnapshot, input: unknown) {
  const catalog = validateSemanticCatalog(input);
  const excluded = new Set(snapshot.heldProducts.map(p => p.publicId));
  const excludedProducts = new Set(snapshot.heldProducts.map(p => p.id));
  const products = new Map(snapshot.products.flatMap(outer => {
    const p = persistentPublicProduct(outer);
    return p && p.isActive === true && outer.isActive === true && p.id === outer.id
      && p.publicId === outer.publicId && !excluded.has(p.publicId) && !excludedProducts.has(p.id)
      ? [[p.publicId, structuredClone(p)] as const] : [];
  }));
  if (new Set(snapshot.products.map(p => p.publicId)).size !== snapshot.products.length
    || new Set(snapshot.products.map(p => p.id)).size !== snapshot.products.length)
    throw new Error('semantic_public_membership_invalid');
  const entries = new Map(catalog.entries.map(entry => [entry.vectorId, entry]));
  return {
    profile: DERIVED_SEARCH_PROFILE, indexName: catalog.indexName,
    async resolve(matches: readonly VectorMatch[]) {
      const ids = new Set<string>();
      const verified = await Promise.all(matches.slice(0, 100).map(async match => {
        const metadata = match.metadata as {publicId?:string} | undefined;
        const product = products.get(metadata?.publicId ?? '');
        const entry = entries.get(match.id) ?? (product && semanticEntryFromMetadata(match.id,metadata,product.id));
        if (!entry || !product || hasRepairedSemanticCopy(product)&&entry.inputRecipe!=='canonical-short-description-v2'
          || product.id !== entry.productId || !Number.isFinite(match.score)
          || canonicalJson(match.metadata ?? null) !== canonicalJson(semanticVectorMetadata(entry))
          || await semanticVectorIdentity(entry) !== entry.vectorId
          || await semanticHash(canonicalJson(semanticPublicFields(product,entry.inputRecipe))) !== entry.publicFieldsSha256) return null;
        return { product:productPresentation(product), score: Math.max(-1, Math.min(1, match.score)) };
      }));
      return verified.flatMap(item => {
        if (!item || ids.has(item.product.publicId)) return [];
        ids.add(item.product.publicId); return [item];
      });
    },
  };
}
export type DerivedSemanticSearch = ReturnType<typeof createDerivedSemanticSearch>;
