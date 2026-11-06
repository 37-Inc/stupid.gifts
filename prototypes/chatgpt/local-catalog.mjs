import { readFile } from 'node:fs/promises';
import { neon } from '@neondatabase/serverless';
import { parse } from 'dotenv';
import { isPurchasableAvailability } from '../../lib/gift-slugs.ts';
import { isCatalogDisplayEligibleProduct } from '../../lib/db/product-scoring.ts';
import { cleanImageUrl } from '../../lib/image-utils.ts';
import { giftSchema } from './catalog.mjs';
import { applyReviewedFacts } from './reviewed-facts.mjs';

// SELECT only. Discovery uses the website's catalog-display eligibility, not
// the stricter SEO/editorial-page gate. No query embedding or price filtering.
export const CATALOG_SELECT = `SELECT public_id, slug, title, punny_title, witty_description,
  humor_tags, quality_score, image_url, source, editorial_writeup, is_active,
  duplicate_of_product_id, availability_status, availability_checked_at, last_verified_at
FROM products
WHERE is_active = true AND duplicate_of_product_id IS NULL
  AND quality_score >= 0.55 AND title <> ''
  AND image_url IS NOT NULL AND affiliate_url IS NOT NULL
ORDER BY quality_score DESC, public_id
LIMIT 5000`;

export function previewImageUrl(value, source) {
  const cleaned = cleanImageUrl(value, source);
  if (!cleaned) return cleaned;
  // Some catalog thumbnails add retailer rating badges, text and a forced
  // landscape canvas. Request a bounded version of the same image ID instead.
  // This changes delivery sizing only; it never crops or replaces the product.
  const url = new URL(cleaned);
  if (url.hostname === 'm.media-amazon.com' && /(?:PIStarRating|PIWhiteStrip|_ZA|_SR)/i.test(url.pathname)) {
    const match = url.pathname.match(/^\/images\/I\/([^/.]+)\._[^/]+\.(jpg|jpeg|png|webp)$/i);
    if (match) { url.pathname = `/images/I/${match[1]}._SL600_.${match[2]}`; return url.href; }
  }
  return cleaned;
}

export function projectCatalogProducts(rows, now = new Date()) {
  const products = [];
  for (const row of rows) {
    const verifiedTime = new Date(row.availability_checked_at || row.last_verified_at).getTime();
    if (Number.isFinite(verifiedTime) && verifiedTime > now.getTime()) continue;
    if (row.duplicate_of_product_id) continue;
    // Unknown/stale availability can support discovery, as on the website;
    // explicit unavailability cannot. The app makes no in-stock claims.
    if (row.availability_status && !isPurchasableAvailability(row.availability_status)) continue;
    if (!isCatalogDisplayEligibleProduct({
      title: row.title,
      isActive: row.is_active,
      qualityScore: Number(row.quality_score),
      imageUrl: row.image_url,
      affiliateUrl: 'present', // The fixed SELECT checks destination presence.
    })) continue;
    try {
      // Retailer IDs, affiliate URLs, prices and internal fields never leave here.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.public_id)) continue;
      const gift = giftSchema.parse({
        id: row.public_id,
        title: (row.punny_title || row.title || '').trim().slice(0, 180),
        description: (row.witty_description || 'A gift idea from the Stupid Gifts catalog. View details for the current product information.').trim().slice(0, 600),
        tags: (row.humor_tags || []).slice(0, 12).map((tag) => tag.slice(0, 40)),
        url: `https://stupid.gifts/gifts/${encodeURIComponent(row.slug)}`,
        imageUrl: previewImageUrl(row.image_url, row.source),
      });
      if (!row.slug || !gift.imageUrl) continue;
      products.push({ ...applyReviewedFacts(gift, row.title), searchTitle: row.title, searchText: (row.editorial_writeup || '').slice(0, 4000) });
    } catch { /* Skip unusable records; never replace them with samples. */ }
  }
  return products;
}

export async function createLocalCatalog({ envFile = new URL('../../.env.local', import.meta.url), loadRows, cacheMs = 300000, clock = () => new Date() } = {}) {
  if (!loadRows) {
    // Read only the DB configuration. Do not load model, retailer or admin keys.
    const connectionString = process.env.POSTGRES_URL || parse(await readFile(envFile, 'utf8')).POSTGRES_URL;
    if (!connectionString) throw new Error('Database configuration is missing.');
    const url = new URL(connectionString);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname.endsWith('.neon.tech')) throw new Error('Unexpected catalog database.');
    const sql = neon(connectionString);
    loadRows = () => sql.query(CATALOG_SELECT);
  }
  let cachedRows;
  let cachedAt = 0;
  let pending;
  const refresh = async () => {
    if (!pending) pending = Promise.resolve().then(loadRows).then((rows) => {
      cachedRows = rows; cachedAt = clock().getTime(); return rows;
    }).finally(() => { pending = undefined; });
    return pending;
  };
  return {
    mode: 'local-catalog',
    disclosure: 'Stupid Gifts earns from qualifying affiliate purchases. Check current details and availability on the gift page.',
    async load({ fresh = false } = {}) {
      const rows = !fresh && cachedRows && clock().getTime() - cachedAt < cacheMs ? cachedRows : await refresh();
      return projectCatalogProducts(rows, clock());
    },
  };
}
