import type { CatalogSnapshot, PublicCatalogProduct, SiteAssetManifest } from '../../lib/catalog/types.ts';
import { catalogDeadline, persistentPublicProduct, resolvePublicProduct } from '../../lib/catalog/display.ts';
import { productPresentation } from '../../lib/catalog/presentation.ts';
import { isCatalogDisplayEligibleProduct } from '../../lib/db/product-scoring.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_HOSTS = new Set(['stupid.gifts', 'm.media-amazon.com', 'i.etsystatic.com']);

/** Bounded public lookup, independent of any previous search or isolate state. */
export function createCatalogGiftsHandler({ snapshot, manifest, now = Date.now }: {
  snapshot: CatalogSnapshot; manifest: SiteAssetManifest; now?: () => number;
}) {
  const products = new Map<string, PublicCatalogProduct | null>();
  for (const product of snapshot.products) {
    // Ambiguous identities fail closed rather than selecting an arbitrary row.
    products.set(product.publicId, products.has(product.publicId) ? null : product);
  }
  const json = (value: unknown, status = 200, headers: HeadersInit = {}) => Response.json(value, {
    status, headers: { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow', ...headers },
  });
  return (request: Request): Response => {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    const query = new URL(request.url).searchParams;
    const input = query.get('ids');
    if (input && input.length > 6 * 37) return json({ error: 'Request too large' }, 413);
    if (query.getAll('ids').length !== 1 || [...query.keys()].some(key => key !== 'ids'))
      return json({ error: 'Use one ids parameter' }, 400);
    const ids = input?.split(',') ?? [];
    if (!ids.length || ids.length > 6 || new Set(ids).size !== ids.length || ids.some(id => !UUID.test(id)))
      return json({ error: 'Supply one to six unique public gift IDs' }, 400);
    const at = now();
    const home = manifest.routes['/'];
    if (!home || home.state === 'held' || !(catalogDeadline(home.eligibleUntil) > at || typeof home.persistentIndexable === 'boolean'))
      return json({ error: 'Catalog temporarily unavailable' }, 503);
    const results = ids.flatMap(id => {
      const original = products.get(id);
      if (!original || !SLUG.test(original.slug)) return [];
      const base = persistentPublicProduct(original);
      const resolved = base ?? resolvePublicProduct(original, at);
      if (!resolved || !resolved.isActive || !resolved.imageUrl || !resolved.affiliateUrl) return [];
      if (!base && !isCatalogDisplayEligibleProduct(resolved, { asOf: new Date(at) })) return [];
      const route = manifest.routes[`/gifts/${resolved.slug}`];
      if (!route || route.state !== 'ready'
        || !(catalogDeadline(route.eligibleUntil) > at || base && typeof route.persistentIndexable === 'boolean')) return [];
      const view = productPresentation(resolved);
      let image: URL;
      try { image = new URL(view.imageUrl, 'https://stupid.gifts'); } catch { return []; }
      if (image.protocol !== 'https:' || !IMAGE_HOSTS.has(image.hostname) || image.username || image.password) return [];
      // Never spread the product: merchant IDs, affiliate links, prices and proof stay private.
      return [{ publicId: view.publicId, slug: view.slug, title: view.title,
        description: view.description, imageUrl: image.href, humorTags: view.humorTags ?? [] }];
    });
    return json({ results, catalogRevision: snapshot.catalogRevision,
      catalogSnapshotSha256: manifest.catalogSnapshotSha256 });
  };
}
