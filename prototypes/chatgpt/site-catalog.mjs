import { giftSchema, selectGifts } from './catalog-core.mjs';
import { presentGiftProduct } from './presentation.mjs';

const ORIGIN = 'https://stupid.gifts';
const RELEASE = `${ORIGIN}/.well-known/catalog-release.json`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Bind a public review to the exact displayed facts, not only a stable UUID.
export async function giftApprovalDigest(gift) {
  const projection = {
    id: gift.id, title: gift.title, description: gift.description,
    tags: [...new Set(gift.tags)].sort(), url: gift.url, imageUrl: gift.imageUrl,
  };
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(projection)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// Use the live site's existing search, not a second database or copied catalog.
// Rendering re-reads selected UUIDs from the same published public catalog. No
// search session or process-local candidate cache is required across instances.
export function createSiteCatalog({ fetchImpl = fetch, approvedGifts } = {}) {
  const approvals = approvedGifts === undefined ? null : new Map(approvedGifts.map(({ id, sha256 }) => [id, sha256]));
  const approved = async gift => !approvals || approvals.get(gift.id) === await giftApprovalDigest(gift);
  async function get(url, options = {}) {
    const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(4500) });
    if (!response.ok) throw new Error('Site catalog unavailable');
    return response;
  }
  async function release() {
    const data = await (await get(RELEASE)).json();
    if (typeof data.catalog_revision !== 'string' || !/^[a-f0-9]{64}$/.test(data.catalog_snapshot_sha256)) throw new Error('Invalid catalog release');
    return `${data.catalog_revision}:${data.catalog_snapshot_sha256}`;
  }
  function project(product) {
    if (!product || !UUID.test(product.publicId || '') || !SLUG.test(product.slug || '') || !product.imageUrl) return null;
    let image;
    try { image = new URL(product.imageUrl, ORIGIN); } catch { return null; }
    const presentation = presentGiftProduct({ ...product, imageUrl: image.href });
    const gift = giftSchema.safeParse({
      id: product.publicId,
      ...presentation,
      tags: (Array.isArray(product.humorTags) ? product.humorTags : []).filter(x => typeof x === 'string').slice(0, 12).map(x => x.slice(0, 40)),
      url: `${ORIGIN}/gifts/${product.slug}`,
    });
    return gift.success ? { ...gift.data, searchTitle: String(product.title || '').slice(0, 500) } : null;
  }
  return {
    mode: 'site-catalog',
    disclosure: 'Stupid Gifts earns from qualifying affiliate purchases. Check current details and availability on the gift page.',
    async search(input) {
      const before = await release();
      // Exclusions are enforced locally, so do not make the search engine rank
      // the word describing what the shopper explicitly rejected.
      const query = input.query.replace(/\b(?:no|without|avoid|excluding|exclude|not)\s+(?:any\s+)?[a-z]+(?:\s+(?:or|and)\s+[a-z]+)*/gi, ' ').trim();
      if (query.length < 2) return [];
      const url = new URL('/api/search-products', ORIGIN);
      url.searchParams.set('q', query.slice(0, 200));
      url.searchParams.set('limit', '60');
      const body = await (await get(url)).json();
      if (!Array.isArray(body.results) || body.results.length > 60) throw new Error('Invalid catalog response');
      if (await release() !== before) throw new Error('Catalog changed during search');
      const candidates = body.results.map(project).filter(Boolean);
      const allowed = await Promise.all(candidates.map(approved));
      const projected = candidates.filter((_, index) => allowed[index]);
      const accepted = new Set(selectGifts(projected, input, 60).map(gift => gift.id));
      // Keep the website's ranked order rather than sorting ties by UUID.
      const gifts = projected.filter(gift => accepted.has(gift.id)).slice(0, 12);
      return gifts;
    },
    async lookup(ids) {
      if (!ids.length || ids.length > 6 || ids.some(id => !UUID.test(id))) return ids.map(() => null);
      const before = await release();
      const url = new URL('/api/catalog-gifts', ORIGIN);
      url.searchParams.set('ids', ids.join(','));
      const body = await (await get(url)).json();
      if (!Array.isArray(body.results) || body.results.length > ids.length) throw new Error('Invalid catalog lookup');
      if (`${body.catalogRevision}:${body.catalogSnapshotSha256}` !== before) throw new Error('Catalog lookup release mismatch');
      const products = new Map();
      for (const product of body.results) {
        const gift = project(product);
        if (!gift || !ids.includes(gift.id) || products.has(gift.id)) throw new Error('Invalid catalog lookup');
        if (await approved(gift)) products.set(gift.id, gift);
      }
      if (await release() !== before) throw new Error('Catalog changed during lookup');
      const items = ids.map(id => products.get(id) || null);
      const checks = await Promise.all(items.map(gift => gift
        ? fetchImpl(gift.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(4500) })
        : null));
      if (await release() !== before) throw new Error('Catalog changed during lookup');
      if (checks.some(r => r && ![200, 404, 410].includes(r.status))) throw new Error('Gift page unavailable');
      return items.map((gift, i) => checks[i]?.status === 200 ? gift : null);
    },
  };
}
