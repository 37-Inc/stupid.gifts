import { z } from 'zod';
import { suppressNearDuplicateProducts } from '../../lib/db/product-scoring.ts';

export const searchInput = z.object({
  query: z.string().trim().min(2).max(240).describe('Carry forward gift interests and recipient context from the conversation, e.g. dad who loves cats. Include exclusions in plain words, e.g. coffee no mugs.'),
}).strict();
export const renderInput = z.object({
  ids: z.array(z.string().min(1).max(80)).min(1).max(6).describe('Choose up to six relevant IDs returned by search_gifts. Use the conversation to omit unwanted or previously shown gifts.'),
}).strict();

const siteUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && ['stupid.gifts'].includes(url.hostname) && !url.username && !url.password;
}, 'Only rights-cleared Stupid Gifts-hosted links and images are allowed.');
const catalogImageUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && ['stupid.gifts', 'm.media-amazon.com', 'i.etsystatic.com'].includes(url.hostname) && !url.username && !url.password;
}, 'Unexpected catalog image host.');
// Public results deliberately have no price fields, even when private price data exists.
export const giftSchema = z.object({
  id: z.string().min(1).max(80),
  title: z.string().min(1).max(180),
  description: z.string().min(1).max(600),
  tags: z.array(z.string().max(40)).max(12),
  url: siteUrl,
  imageUrl: catalogImageUrl.nullable(),
  illustration: z.enum(['cup', 'plant', 'cat', 'sock', 'desk', 'kitchen']).optional(),
}).strict();

export const resultSchema = z.object({
  status: z.enum(['ok', 'empty', 'unavailable', 'not_found']),
  mode: z.enum(['fixture', 'reviewed-catalog', 'local-catalog', 'site-catalog']),
  gifts: z.array(giftSchema).max(12),
  message: z.string(),
  disclosure: z.string(),
}).strict();

const stopWords = new Set(['a', 'an', 'and', 'for', 'gift', 'gifts', 'the', 'to', 'with', 'who', 'likes', 'loves', 'under', 'someone', 'i', 'im', 'am', 'looking', 'my', 'dad', 'father', 'sister', 'brother', 'mom', 'mother', 'please', 'something', 'some', 'ideas', 'coworker', 'coworkers', 'colleague', 'friend', 'partner', 'husband', 'wife', 'grandpa', 'grandma', 'uncle', 'aunt', 'fresh', 'different', 'show', 'more', 'now', 'about', 'what']);
const aliases = { cats: 'cat', barbecuing: 'barbecue', barbecues: 'barbecue', barbequing: 'barbecue', barbeque: 'barbecue', bbq: 'barbecue', grilling: 'barbecue', grilled: 'barbecue', grills: 'barbecue', grill: 'barbecue', cooking: 'kitchen', cook: 'kitchen', gardening: 'garden', plants: 'plant', mugs: 'mug', socks: 'sock', aprons: 'apron', cups: 'cup', spoons: 'spoon', shirts: 'shirt', planters: 'planter' };
const tokens = (text) => text.toLowerCase().replace(/coffee[- ]table/g, 'coffeetable').replace(/['’]/g, '').match(/[a-z0-9]+/g)?.filter((v) => !stopWords.has(v) && !/^\d+$/.test(v)).map((v) => aliases[v] || v) ?? [];

export function selectGifts(products, input, limit = 12) {
  const excluded = new Set();
  // A conversational exclusion must not boost exactly the products the user
  // rejected. Parse short explicit noun lists; ChatGPT still curates context,
  // recipient suitability and previously shown IDs.
  const positiveQuery = input.query.replace(/\b(?:no|without|avoid|excluding|exclude|not)\s+(?:any\s+)?([a-z]+(?:\s+(?:or|and)\s+[a-z]+)*)/gi, (_, nouns) => {
    for (const term of tokens(nouns)) excluded.add(term);
    return ' ';
  });
  if (excluded.has('mug')) excluded.add('cup');
  const terms = [...new Set(tokens(positiveQuery))];
  const seen = new Set();
  const ranked = products.map((product) => {
    const title = tokens(product.title);
    const originalTitle = new Set(tokens(product.searchTitle || ''));
    const tags = new Set(product.tags.flatMap(tokens));
    const body = new Set(tokens(product.description));
    if ([...excluded].some((term) => originalTitle.has(term) || title.includes(term) || tags.has(term) || body.has(term))) return { product, score: 0, relevant: false };
    // Recipient context such as "office" must not bypass the requested coffee
    // interest and fill a refinement with unrelated workplace gag gifts.
    if (terms.includes('coffee') && !originalTitle.has('coffee') && !title.includes('coffee')) return { product, score: 0, relevant: false };
    // The catalog's broad coffee tag also occurs on unrelated kitchen gifts.
    // Require an explicit product-text match for this interest, and distinguish
    // coffee-table books from gifts for someone who enjoys drinking coffee.
    const primaryScore = terms.reduce((sum, term) => sum + (originalTitle.has(term) ? 4 : tags.has(term) && term !== 'coffee' ? 3 : title.includes(term) ? 2 : body.has(term) && term !== 'coffee' ? 1 : 0), 0);
    // Editorial mentions can break ties, but cannot turn an unrelated product
    // into a match (e.g. a mug mentioned in a barbecue gift paragraph).
    const editorial = new Set(tokens(product.searchText || ''));
    const score = primaryScore + Math.min(0.25, terms.filter((term) => editorial.has(term)).length * 0.05);
    return { product, score, relevant: primaryScore > 0 };
  }).filter((p) => p.relevant).sort((a, b) => b.score - a.score || a.product.id.localeCompare(b.product.id))
    .map(({ product }) => product).filter((product) => {
      const key = (product.searchTitle || product.title).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  // Reuse the website's variant suppression after relevance ranking, using the
  // original product title without exposing it as an extra tool field.
  return suppressNearDuplicateProducts(ranked.map((product) => ({ title: product.searchTitle || product.title, product })), limit).map(({ product }) => product);
}

export function createGiftService(catalog, { timeoutMs = 5000 } = {}) {
  const bounded = async (operation) => {
    let timer;
    try { return await Promise.race([operation(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Catalog timed out.')), timeoutMs); })]); }
    finally { clearTimeout(timer); }
  };
  const load = async (fresh = false) => {
    return bounded(() => catalog.load({ fresh }));
  };
  const respond = (products, status, message) => resultSchema.parse({
    status, mode: catalog.mode,
    gifts: products.map(({ id, title, description, tags, url, imageUrl, illustration }) => ({ id, title, description, tags, url, imageUrl, ...(illustration ? { illustration } : {}) })),
    message,
    disclosure: catalog.disclosure,
  });
  const failure = () => respond([], 'unavailable', 'The catalog is unavailable. Try again later.');
  return {
    async search(rawInput) {
      const input = searchInput.parse(rawInput);
      try {
        const selected = catalog.search ? await bounded(() => catalog.search(input)) : selectGifts(await load(), input);
        return respond(selected, selected.length ? 'ok' : 'empty', selected.length ? 'Choose the best matches and call render_gifts to show the carousel.' : 'No matching gifts were found. Try different interests.');
      } catch { return failure(); }
    },
    async render(rawInput) {
      const input = renderInput.parse(rawInput);
      try {
        const ids = [...new Set(input.ids)];
        const products = catalog.lookup ? null : await load(true);
        const chosen = catalog.lookup ? await bounded(() => catalog.lookup(ids)) : ids.map((id) => products.find((p) => p.id === id));
        if (chosen.some((p) => !p)) return respond([], 'not_found', 'No gifts were rendered: a selected gift is no longer in the catalog. Search again using the recipient interests, then retry render_gifts once with fresh IDs. If it still fails, explain that the carousel is unavailable. Do not describe the failed selection as available or shown.');
        return respond(chosen, 'ok', 'Gift carousel ready. Reply with one short sentence about the fit. Do not repeat gift titles or descriptions; they are visible in the carousel.');
      } catch { return failure(); }
    },
  };
}
