import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteCatalog, giftApprovalDigest } from '../site-catalog.mjs';
import { createGiftService, createCatalog } from '../catalog.mjs';
import { createHttpServer } from '../server.mjs';

const hash = 'a'.repeat(64);
const id = '11111111-1111-4111-8111-111111111111';
const product = { id: 'private-retailer-id', publicId: id, slug: 'cat-brush', title: 'Funny cat brush',
  wittyDescription: 'A playful brush for cat lovers.', imageUrl: 'https://m.media-amazon.com/images/I/test.jpg',
  humorTags: ['cat'], price: 100, affiliateUrl: 'https://example.com/private' };
function mock({ missing = false, changed = false, failSearch = false, lookupProducts = [product], lookupHash = hash } = {}) {
  let releases = 0; const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const u = new URL(url); requests.push({ url: u.href, method: options.method || 'GET' });
    if (u.pathname === '/.well-known/catalog-release.json') {
      releases++;
      return Response.json({ catalog_revision: 'v1', catalog_snapshot_sha256: changed && releases > 1 ? 'b'.repeat(64) : hash });
    }
    if (u.pathname === '/api/search-products') return failSearch ? new Response('', { status: 503 }) : Response.json({ results: [product] });
    if (u.pathname === '/api/catalog-gifts') return Response.json({ results: missing ? [] : lookupProducts,
      catalogRevision: 'v1', catalogSnapshotSha256: lookupHash });
    if (u.pathname === '/gifts/cat-brush') return new Response(null, { status: missing ? 404 : 200 });
    throw new Error('Unexpected URL');
  };
  return { fetchImpl, requests };
}

test('live-site projection excludes private retailer data and revalidates render', async () => {
  const m = mock(); const service = createGiftService(createSiteCatalog(m));
  const result = await service.search({ query: 'cats' });
  assert.equal(result.status, 'ok'); assert.equal(result.mode, 'site-catalog');
  assert.equal(result.gifts[0].id, id); assert.equal(result.gifts[0].url, 'https://stupid.gifts/gifts/cat-brush');
  assert.equal('price' in result.gifts[0], false); assert.equal('affiliateUrl' in result.gifts[0], false);
  assert.equal((await service.render({ ids: [id] })).status, 'ok');
  assert.ok(m.requests.some(x => x.method === 'HEAD' && x.url.endsWith('/gifts/cat-brush')));
  assert.ok(m.requests.every(x => new URL(x.url).hostname === 'stupid.gifts'));
});

test('fresh selected UUIDs render on a different or restarted instance without a search cache', async () => {
  const m = mock();
  const first = createGiftService(createSiteCatalog(m));
  const found = await first.search({ query: 'cats' });
  const second = createGiftService(createSiteCatalog(m));
  const rendered = await second.render({ ids: found.gifts.map(g => g.id) });
  assert.equal(rendered.status, 'ok');
  assert.deepEqual(rendered.gifts, found.gifts);
  assert.ok(m.requests.some(r => r.url === `https://stupid.gifts/api/catalog-gifts?ids=${id}`));
  assert.ok(m.requests.every(r => r.method === 'GET' || r.method === 'HEAD'));
});

test('lookup refuses identity swaps, duplicate rows and stale release responses', async () => {
  for (const config of [
    { lookupProducts: [{ ...product, publicId: '22222222-2222-4222-8222-222222222222' }] },
    { lookupProducts: [product, product] },
    { lookupHash: 'b'.repeat(64) },
  ]) {
    const service = createGiftService(createSiteCatalog(mock(config)));
    assert.equal((await service.render({ ids: [id] })).status, 'unavailable');
  }
});

test('public approval binds exact displayed copy and photo rather than UUID alone', async () => {
  const initial = (await createGiftService(createSiteCatalog(mock())).search({ query: 'cat' })).gifts[0];
  const approval = [{ id, sha256: await giftApprovalDigest(initial) }];
  const fresh = createGiftService(createSiteCatalog({ ...mock(), approvedGifts: approval }));
  assert.equal((await fresh.search({ query: 'cat' })).status, 'ok');
  assert.equal((await fresh.render({ ids: [id] })).status, 'ok');
  for (const change of [
    { imageUrl: 'https://m.media-amazon.com/images/I/different.jpg' },
    { wittyDescription: 'Changed descriptive facts.' },
    { title: 'Different cat product' },
  ]) {
    const service = createGiftService(createSiteCatalog({ ...mock({ lookupProducts: [{ ...product, ...change }] }), approvedGifts: approval }));
    assert.equal((await service.render({ ids: [id] })).status, 'not_found');
  }
  const unapproved = createGiftService(createSiteCatalog({ ...mock(), approvedGifts: [] }));
  assert.equal((await unapproved.search({ query: 'cat' })).status, 'empty');
  assert.equal((await unapproved.render({ ids: [id] })).status, 'not_found');
});

test('outage, deleted gift, release changes and missing ids fail honestly', async () => {
  const unavailable = createGiftService(createSiteCatalog(mock({ failSearch: true })));
  assert.equal((await unavailable.search({ query: 'cat' })).status, 'unavailable');
  const missing = createGiftService(createSiteCatalog(mock({ missing: true })));
  await missing.search({ query: 'cat' });
  assert.equal((await missing.render({ ids: [id] })).status, 'not_found');
  const changed = createGiftService(createSiteCatalog(mock({ changed: true })));
  assert.equal((await changed.search({ query: 'cat' })).status, 'unavailable');
  assert.equal((await missing.render({ ids: ['unknown'] })).status, 'not_found');
  await assert.rejects(createCatalog({ mode: 'local-catalog' }), /Unsupported/);
});

test('the live-site mode retains loopback-only protections', async t => {
  const catalog = createSiteCatalog(mock()); const http = createHttpServer(createGiftService(catalog), catalog.mode);
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${http.address().port}/health`, { headers: { 'x-forwarded-for': '203.0.113.1' } });
  assert.equal(response.status, 403);
});
