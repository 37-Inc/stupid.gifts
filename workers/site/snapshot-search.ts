import type { CatalogSnapshot } from '../../lib/catalog/types.ts';
import { persistentPublicProduct } from '../../lib/catalog/display.ts';
import { catalogSearchTerms } from '../../lib/catalog/search-terms.ts';
import { productPresentation } from '../../lib/catalog/presentation.ts';
import type { SearchStorage } from './bindings.ts';
import {appealPriority,usableCommissionPriority,merchandisingForProduct,productTitleView} from '../../lib/catalog/merchandising.ts';
import type {Merchandising} from '../../lib/catalog/merchandising.ts';

/** The deployed, independently cleared catalog is already in the Worker.
 * Search that immutable public view, not mutable/private D1 rows on each visit.
 * Mixed/finite catalogs retain the existing database adapter and expiry checks. */
export function snapshotKeywordSearch(snapshot: CatalogSnapshot,merchandising:Merchandising={}): SearchStorage['keyword'] | null {
  const products = snapshot.products.map(p=>{const base=persistentPublicProduct(p);return base?productTitleView(productPresentation(base),merchandising):null;});
  if (!products.length || products.some(p => !p)) return null;
  const index = new Map<string, Map<number, number>>();
  products.forEach((product, id) => {
    for (const [value, weight] of [[product!.title, 4], [product!.humorTags?.join(' ') || '', 2],
      [product!.description, 1]] as const) {
      for (const term of catalogSearchTerms(value)) {
        let matches = index.get(term);
        if (!matches) index.set(term, matches = new Map());
        matches.set(id, Math.max(weight, matches.get(id) || 0));
      }
    }
  });
  return async (query, limit, _now, revision) => {
    if (revision !== snapshot.catalogRevision || !Number.isInteger(limit) || limit < 1 || limit > 240)
      throw new Error('snapshot_search_scope');
    const terms = catalogSearchTerms(query);
    const scores = new Map<number, number>();
    for (const term of terms) {
      const matches = index.get(term) || new Map<number, number>();
      // Prefix lookup is only needed while typing an incomplete word.
      if (!matches.size) for (const [word, postings] of index) if (word.startsWith(term))
        for (const [id, weight] of postings) matches.set(id, Math.max(weight, matches.get(id) || 0));
      for (const [id, weight] of matches) scores.set(id, (scores.get(id) || 0) + 10 + weight);
    }
    return [...scores].map(([id, score]) => ({ product: products[id]!, score,
      signal:merchandisingForProduct(products[id]!,merchandising) }))
      // Do not lose reviewed gag gifts at the bounded retrieval cutoff merely
      // because books/ordinary variants have alphabetically earlier ASINs.
      .sort((a, b) => b.score - a.score || appealPriority(b.signal?.appeal)-appealPriority(a.signal?.appeal)
        ||usableCommissionPriority(b.signal,_now.getTime())-usableCommissionPriority(a.signal,_now.getTime())
        || (a.product.id < b.product.id ? -1 : a.product.id > b.product.id ? 1 : 0))
      .slice(0, limit).map(entry => entry.product);
  };
}
