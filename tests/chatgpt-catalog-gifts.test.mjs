import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogGiftsHandler } from '../workers/site/catalog-gifts.ts';
import { createSiteWorker } from '../workers/site/index.ts';

const NOW = Date.parse('2026-11-06T15:00:00Z');
const UNTIL = new Date(NOW + 60_000).toISOString();
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const product = (index = 0, extra = {}) => ({
  id: `private-retailer-${index}`, publicId: ids[index], slug: `cat-brush-${index}`, source: 'amazon',
  title: `Funny cat brush ${index}`, description: 'A brush for a cat lover.',
  imageUrl: '/images/cat-brush.jpg', affiliateUrl: 'https://www.amazon.com/dp/B123456789?tag=private-20',
  price: 0, currency: 'USD', humorTags: ['cat'], isActive: true, qualityScore: .8,
  eligibleUntil: UNTIL, internalNotes: 'private evidence', ...extra,
});
const route = extra => ({ state: 'ready', assetPath: '/page.html', safeAssetPath: '/safe.html', eligibleUntil: UNTIL, ...extra });
function setup(products = [product(), product(1)], options = {}) {
  let clock = NOW;
  const snapshot = { schemaVersion: 1, dataKind: 'synthetic_fixture', catalogRevision: 'revision-1',
    generatedAt: new Date(NOW).toISOString(), products, heldProducts: [], slugHistory: [] };
  const manifest = { schemaVersion: 1, releaseId: 'test', codeSha: 'b'.repeat(40), catalogRevision: snapshot.catalogRevision,
    catalogSnapshotSha256: 'a'.repeat(64), productCount: products.length, checksums: {}, dataKind: snapshot.dataKind,
    routes: { '/': route(), ...Object.fromEntries(products.map(p => [`/gifts/${p.slug}`, route()])) }, ...options.manifest };
  const handler = createCatalogGiftsHandler({ snapshot, manifest, now: () => clock });
  return { handler, snapshot, manifest, advance: ms => { clock += ms; },
    request: (query = `ids=${ids.join(',')}`, init) => handler(new Request(`https://stupid.gifts/api/catalog-gifts?${query}`, init)) };
}

test('public UUID lookup is independent of search, ordered and explicitly projected', async () => {
  for (let instance = 0; instance < 2; instance++) {
    const f = setup();
    const response = f.request(`ids=${ids[1]},${ids[0]}`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.results.map(p => p.publicId), [ids[1], ids[0]]);
    assert.deepEqual(Object.keys(body.results[0]).sort(), ['description', 'humorTags', 'imageUrl', 'publicId', 'slug', 'title']);
    assert.equal(body.results[0].imageUrl, 'https://stupid.gifts/images/cat-brush.jpg');
    assert.equal(body.catalogRevision, f.snapshot.catalogRevision);
    assert.equal(body.catalogSnapshotSha256, f.manifest.catalogSnapshotSha256);
    assert.doesNotMatch(JSON.stringify(body), /private|affiliate|currency|internalNotes|price/);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
});

test('input is bounded before lookup; arbitrary destinations and writes are unsupported', () => {
  const f = setup();
  for (const query of ['', 'ids=', 'ids=bad', `ids=${ids[0]},${ids[0]}`, `ids=${ids[0]}&ids=${ids[1]}`,
    `ids=${ids[0]}&url=https://example.com`, `ids=${ids[0]}&limit=100`]) assert.equal(f.request(query).status, 400, query);
  assert.equal(f.request('ids=' + 'x'.repeat(223)).status, 413);
  const write = f.request(`ids=${ids[0]}`, { method: 'POST', body: '{}' });
  assert.equal(write.status, 405); assert.equal(write.headers.get('Allow'), 'GET');
});

test('missing, duplicate, held, inactive and expired-only products never become visible', async () => {
  const duplicate = setup([product(), product(0, { title: 'Conflicting identity' })]);
  assert.deepEqual((await duplicate.request(`ids=${ids[0]}`).json()).results, []);
  for (const f of [setup([]), setup([product(0, { isActive: false })]),
    setup([product(0, { eligibleUntil: new Date(NOW - 1).toISOString() })]),
    setup([product()], { manifest: { routes: { '/': route(), '/gifts/cat-brush-0': route({ state: 'held' }) } } })])
    assert.deepEqual((await f.request(`ids=${ids[0]}`).json()).results, []);
  const f = setup(); f.advance(60_001);
  assert.equal(f.request().status, 503, 'an expired homepage cannot become an available catalog');
});

test('a persistent public view does not leak expired supplier copy or extend it', async () => {
  const base = product(0, { title: 'Independent cat brush', imageUrl: '/images/owned-brush.jpg', eligibleUntil: null, indexable: false });
  const supplier = product(0, { title: 'SUPPLIER ONLY TITLE', imageUrl: 'https://example.invalid/supplier.jpg', persistent: base });
  const f = setup([supplier], { manifest: { routes: { '/': route({ persistentIndexable: false }),
    '/gifts/cat-brush-0': route({ persistentIndexable: false }) } } });
  f.advance(60_001);
  const body = await f.request(`ids=${ids[0]}`).json();
  assert.equal(body.results[0].title, base.title);
  assert.equal(body.results[0].imageUrl, 'https://stupid.gifts/images/owned-brush.jpg');
  assert.doesNotMatch(JSON.stringify(body), /SUPPLIER|supplier\.jpg|persistent/);
});

test('unsafe image origins are omitted rather than proxied or returned', async () => {
  for (const imageUrl of ['http://stupid.gifts/image.jpg', '//evil.example/image.jpg', 'https://user:secret@stupid.gifts/image.jpg']) {
    const f = setup([product(0, { imageUrl })]);
    assert.deepEqual((await f.request(`ids=${ids[0]}`).json()).results, []);
  }
});

test('the real Worker routes lookup through existing host and staging protections', async () => {
  const f = setup();
  const worker = createSiteWorker({ snapshot: f.snapshot, manifest: f.manifest,
    canonicalOrigin: 'https://stupid.gifts', now: () => NOW });
  const env = { ENVIRONMENT: 'production', ASSETS: { fetch() { throw Error('No asset or database reads expected'); } } };
  const request = new Request(`https://stupid.gifts/api/catalog-gifts?ids=${ids[0]}`);
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200); assert.equal((await response.json()).results[0].publicId, ids[0]);
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal((await worker.fetch(new Request(`https://evil.example/api/catalog-gifts?ids=${ids[0]}`), env)).status, 404);
  assert.equal((await worker.fetch(request, { ...env, ENVIRONMENT: 'staging', STAGING_AUTH_SECRET: 'long-test-secret-1234' })).status, 401);
  const alias = await worker.fetch(new Request(`https://www.stupid.gifts/api/catalog-gifts?ids=${ids[0]}`), env);
  assert.equal(alias.status, 404, 'lookup uses the canonical API origin without forwarding ID queries through aliases');
});
