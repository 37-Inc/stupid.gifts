// Node-only catalog loaders are separated from the edge-safe public contract.
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { giftSchema } from './catalog-core.mjs';
export * from './catalog-core.mjs';

const catalogFile = z.object({ rightsReview: z.string().min(10), products: z.array(giftSchema).max(5000) }).strict();
const fixtureDisclosure = 'Sample catalog: imaginary gifts and illustrations, not available to buy.';
const liveDisclosure = 'Stupid Gifts earns from qualifying affiliate purchases on its website.';

export async function createCatalog({ mode = 'fixture', file, approved = false } = {}) {
  if (!['fixture', 'reviewed-catalog', 'site-catalog'].includes(mode)) throw new Error('Unsupported catalog mode.');
  if (mode === 'site-catalog') {
    const { createSiteCatalog } = await import('./site-catalog.mjs');
    return createSiteCatalog();
  }
  if (mode === 'reviewed-catalog' && (!approved || !file)) throw new Error('Reviewed catalog requires a rights-cleared catalog file and explicit approval.');
  const load = async () => {
    if (mode === 'fixture') {
      const entries = JSON.parse(await readFile(new URL('./fixtures.json', import.meta.url), 'utf8'));
      return entries.map((p) => giftSchema.parse({ ...p, url: 'https://stupid.gifts/', imageUrl: null }));
    }
    const parsed = catalogFile.parse(JSON.parse(await readFile(file, 'utf8')));
    // The reviewed distribution adapter still permits only Stupid Gifts-hosted images.
    if (parsed.products.some((p) => p.imageUrl && new URL(p.imageUrl).hostname !== 'stupid.gifts')) throw new Error('Reviewed catalog requires site-hosted images.');
    if (new Set(parsed.products.map((p) => p.id)).size !== parsed.products.length) throw new Error('Duplicate catalog IDs.');
    return parsed.products;
  };
  return { mode, load, disclosure: mode === 'fixture' ? fixtureDisclosure : liveDisclosure };
}

