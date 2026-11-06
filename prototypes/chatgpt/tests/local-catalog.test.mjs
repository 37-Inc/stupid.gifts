import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalCatalog, projectCatalogProducts, CATALOG_SELECT, previewImageUrl } from '../local-catalog.mjs';
import { createGiftService } from '../catalog.mjs';
import { createHttpServer } from '../server.mjs';
import { applyReviewedFacts } from '../reviewed-facts.mjs';

const now = new Date('2026-10-02T20:00:00Z');
const row = (extra = {}) => ({
  public_id: '11111111-1111-4111-8111-111111111111', slug: 'cat-brush',
  title: 'Funny Cat Brush', quality_score: '0.85',
  punny_title: 'Cat Brush', witty_description: 'A grooming gift for a cat lover.',
  humor_tags: ['cat-lovers'], image_url: 'https://m.media-amazon.com/images/I/test.jpg', source: 'amazon',
  editorial_writeup: `${'This reviewed cat gift includes a brush and provides useful grooming information. '.repeat(6)}\n\n${'A second factual editorial paragraph describes the same gift for a cat lover. '.repeat(6)}`,
  is_active: true, duplicate_of_product_id: null, availability_status: 'IN_STOCK',
  availability_checked_at: new Date('2026-10-01T20:00:00Z'), last_verified_at: null,
  editorial_status: 'generated_ready', editorial_quality_score: '0.88',
  source_facts_hash: 'current-facts', editorial_source_hash: 'current-facts',
  affiliate_url: 'https://amazon.com/private-tag', price: 99, id: 'retailer-id',
  ...extra,
});

test('retailer badge composites use the same product photo without a forced canvas', () => {
  const composite = 'https://m.media-amazon.com/images/I/41HMwWA6hoL._SR600,315_PIWhiteStrip,BottomLeft,0,35_PIStarRatingFOUR_ZA48,445,290,400_FMpng.jpg';
  assert.equal(previewImageUrl(composite, 'amazon'), 'https://m.media-amazon.com/images/I/41HMwWA6hoL._SL600_.jpg');
  const normal = 'https://m.media-amazon.com/images/I/41MZl5d0b4L._SL500_.jpg';
  assert.equal(previewImageUrl(normal, 'amazon'), normal);
  assert.equal(previewImageUrl('https://stupid.gifts/images/product.jpg', 'other'), 'https://stupid.gifts/images/product.jpg');
});

test('reviewed product kinds require the inspected title and photo identity', () => {
  const gift = { id: 'a284a9b7-ee88-406d-9c58-22177de9797a', imageUrl: 'https://m.media-amazon.com/images/I/41HMwWA6hoL._SL600_.jpg', tags: ['coffee'], description: 'A coffee joke.' };
  const title = 'shop4ever Coffee Because Adulting is Hard Novelty ...';
  assert.ok(applyReviewedFacts(gift, title).tags.includes('mug'));
  assert.match(applyReviewedFacts(gift, title).description, /white coffee mug/);
  assert.deepEqual(applyReviewedFacts({ ...gift, imageUrl: 'https://m.media-amazon.com/images/I/changed.jpg' }, title).tags, ['coffee']);
  assert.deepEqual(applyReviewedFacts(gift, 'A different product').tags, ['coffee']);
  const mitts = { id:'0d5f9acb-6bb8-4008-8901-4d4cdbbc88d0',imageUrl:'https://m.media-amazon.com/images/I/51T8W+9SJ6L._SL500_.jpg',tags:['kitchen'],description:'These are flame-proof.' };
  const checked = applyReviewedFacts(mitts,'Funny Oven Mitts and Pot Holders Sets Black Kitchen Accessories Cute Kitchen Decor');
  assert.equal(checked.description,'An oven mitt and pot holder with a playful kitchen print.');
  assert.equal(checked.tags.includes('mug'),false);
  assert.equal(applyReviewedFacts({...mitts,imageUrl:'https://m.media-amazon.com/images/I/changed.jpg'},'Funny Oven Mitts and Pot Holders Sets Black Kitchen Accessories').description,mitts.description);
});

test('discovery projection keeps quality catalog gifts without requiring indexable editorial', () => {
  const rejected = [
    { is_active: false }, { duplicate_of_product_id: 'duplicate' }, { quality_score: '0.5' },
    { title: 'Ordinary Cat Brush' }, { title: 'Funny Cat Coloring Book' },
    { availability_status: 'UNAVAILABLE' }, { availability_checked_at: new Date('2026-10-03') },
    { image_url: null },
    { image_url: 'https://attacker.example/image.jpg' }, { public_id: 'retailer-id' },
  ];
  const products = projectCatalogProducts([row(), ...rejected.map((extra) => row(extra))], now);
  assert.equal(products.length, 1);
  assert.equal(products[0].url, 'https://stupid.gifts/gifts/cat-brush');
  for (const field of ['price', 'affiliate_url', 'source_facts_hash', 'source', 'editorial_status']) assert.equal(field in products[0], false);
  assert.equal(products[0].id, row().public_id);
  // Missing/older long-form editorial controls SEO indexing, not discovery.
  for (const extra of [
    { editorial_status: 'pending', editorial_writeup: null, editorial_quality_score: null },
    { editorial_writeup: 'short', editorial_source_hash: 'old-facts' },
    { availability_checked_at: new Date('2026-08-01') },
    { availability_status: null, availability_checked_at: null },
  ]) assert.equal(projectCatalogProducts([row(extra)], now).length, 1);
});

test('local catalog reads cache for search, refreshes before render, and never substitutes samples after outage', async () => {
  let reads = 0; let rows = [row()]; let fail = false;
  const catalog = await createLocalCatalog({ clock: () => now, loadRows: async () => { reads++; if (fail) throw new Error('secret database URL'); return rows; } });
  const service = createGiftService(catalog);
  const found = await service.search({ query: 'cats' });
  assert.equal(found.mode, 'local-catalog'); assert.equal(found.gifts.length, 1); assert.equal(reads, 1);
  assert.equal('searchText' in found.gifts[0], false); assert.equal('searchTitle' in found.gifts[0], false);
  await service.search({ query: 'cats' }); assert.equal(reads, 1);
  rows = [];
  assert.equal((await service.render({ ids: [row().public_id] })).status, 'not_found'); assert.equal(reads, 2);
  fail = true;
  const result = await service.render({ ids: [row().public_id] });
  assert.equal(result.status, 'unavailable'); assert.deepEqual(result.gifts, []); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.match(CATALOG_SELECT.trim(), /^SELECT /); assert.doesNotMatch(CATALOG_SELECT, /\b(INSERT|UPDATE|DELETE|price|embedding)\b/i);
  assert.doesNotMatch(CATALOG_SELECT.split('FROM products')[0], /\b(id|affiliate_url|source_facts_hash)\b/i);
});

test('original product titles supply interest matches and near variants do not fill the carousel', async () => {
  const catalog = await createLocalCatalog({ clock: () => now, loadRows: async () => [
    row({ title: 'Funny Grill Apron Red', punny_title: 'King of the Cookout', witty_description: 'A humorous apron.', humor_tags: ['apron'], editorial_writeup: null, editorial_status: 'pending' }),
    row({ public_id: '22222222-2222-4222-8222-222222222222', title: 'Funny Grill Apron Blue', punny_title: 'Chef With Attitude', witty_description: 'An apron with personality.', humor_tags: ['apron'] }),
    row({ public_id: '33333333-3333-4333-8333-333333333333', title: "Funny I'm A Cat Lover Mug", punny_title: 'A Cat Lover Mug', witty_description: 'A cup for cat lovers.', humor_tags: ['cat'] }),
  ] });
  const service = createGiftService(catalog);
  for (const query of ['barbecuing', 'bbq', 'grilling', "I'm looking for a gift for my sister who loves barbecuing", 'I’m looking for a gift for my sister who loves barbecuing']) {
    const result = await service.search({ query });
    assert.equal(result.status, 'ok'); assert.equal(result.gifts.length, 1);
    assert.ok(/Cookout|Chef/.test(result.gifts[0].title));
    assert.ok(!JSON.stringify(result).includes('searchTitle'));
  }
});

test('long editorial copy cannot create irrelevant matches', async () => {
  const catalog = await createLocalCatalog({ clock: () => now, loadRows: async () => [row({ editorial_writeup: `${row().editorial_writeup}\n\nFor a person who loves barbecuing, a mug could be an alternative.` })] });
  const service = createGiftService(catalog);
  assert.equal((await service.search({ query: 'barbecuing' })).status, 'empty');
  assert.equal((await service.search({ query: 'cats' })).status, 'ok');
});

test('real catalog mode rejects forwarded public requests while local preview works', async (t) => {
  const catalog = await createLocalCatalog({ clock: () => now, loadRows: async () => [row()] });
  const http = createHttpServer(createGiftService(catalog), catalog.mode);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }));
  const base = `http://127.0.0.1:${http.address().port}`;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/`, { headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 403);
  const result = await fetch(`${base}/preview/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'search_gifts', arguments: { query: 'cats' } }) });
  assert.equal(result.status, 200); assert.equal((await result.json()).structuredContent.mode, 'local-catalog');
});
