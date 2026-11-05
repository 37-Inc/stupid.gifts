import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { createSiteWorker } from '../workers/site/index.ts';
import { createStaticFeedPlan } from '../workers/site/feed.ts';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const DEADLINE = new Date(NOW + 2400).toISOString();
const ready = (path, overrides = {}) => ({ assetPath: `${path === '/' ? '/index' : path}.html`, safeAssetPath: '/safe.html', eligibleUntil: DEADLINE, state: 'ready', ...overrides });
const product = (overrides = {}) => ({ id: 'asin-1', publicId: 'uuid-1', slug: 'fart-button', title: 'Funny Fart Button', description: 'An absurd button.', imageUrl: '/brand/button.svg', affiliateUrl: 'https://www.amazon.com/dp/B123456789?tag=test-20', source: 'amazon', currency: 'USD', price: 0, isActive: true, qualityScore: 0.8, eligibleUntil: DEADLINE, ...overrides });

function setup(overrides = {}) {
  let clock = NOW;
  const calls = [];
  const snapshot = { schemaVersion: 1, dataKind: 'synthetic_fixture', catalogRevision: 'r1', generatedAt: new Date(NOW).toISOString(), products: [product()], heldProducts: [], slugHistory: [{ slug: 'old-button', canonicalSlug: 'fart-button', publicId: 'uuid-1' }] };
  const routes = {
    '/': ready('/'), '/gifts': ready('/gifts'), '/gifts/page/2': ready('/gifts/page/2'),
    '/gifts/fart-button': ready('/gifts/fart-button'), '/gift-guides/office-pranks': ready('/gift-guides/office-pranks'),
    '/gifts/held': ready('/gifts/held', { state: 'held', eligibleUntil: null }),
    '/gifts/fart-button.txt': ready('/gifts/fart-button', { assetPath: '/gifts/fart-button.txt', safeAssetPath: '/safe.txt' }),
    '/catalog/feed-1.json': ready('/catalog/feed-1', { assetPath: '/catalog/feed-1.json', safeAssetPath: '/safe.json' }),
    '/random-gift': ready('/random-gift'),
    '/howie': ready('/howie', { indexable: false }),
    '/gifts/funny%20button': ready('/gifts/fart-button'),
    '/_next/static/chunks/app/gifts/[slug]/page-old.js': ready('/retained', { assetPath: '/_next/static/chunks/app/gifts/[slug]/page-old.js', safeAssetPath: '/safe.js', indexable: false }),
  };
  const digest = 'a'.repeat(64);
  const manifest = { schemaVersion: 1, releaseId: 'test', codeSha: 'b'.repeat(40), catalogRevision: 'r1', catalogSnapshotSha256: digest, generatedAt: snapshot.generatedAt, nextExpiry: DEADLINE, productCount: 1, slugCount: 1, vectorSyncWatermark: 1, priorReleaseId: null, checksums: {}, dataKind: snapshot.dataKind, routes };
  const releaseIdentity = { release_id: manifest.releaseId, code_sha: manifest.codeSha, catalog_revision: manifest.catalogRevision,
    catalog_snapshot_sha256: digest, manifest_sha256: 'c'.repeat(64) };
  const env = { ENVIRONMENT: 'production', ASSETS: { async fetch(request) { calls.push(request); return new Response(new URL(request.url).pathname, { headers: { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: 'asset-tag', Age: '99' } }); } } };
  const worker = createSiteWorker({ manifest, snapshot, releaseIdentity, feedPlan: createStaticFeedPlan(snapshot, digest, NOW), now: () => clock, ...overrides });
  return { env, calls, worker, manifest, snapshot, releaseIdentity, advance(ms) { clock += ms; }, request: (path, init) => worker.fetch(new Request(`https://preview.example${path}`, init), env) };
}

test('first-party telemetry is reachable only on the real production catalog, never a public read API', async () => {
  const f = setup({ canonicalOrigin: 'https://stupid.gifts' });
  let batches = 0;
  f.env.DB = { prepare(sql) { assert.doesNotMatch(sql, /\bproducts\b/); return { bind() { return this; } }; },
    async batch() { batches++; } };
  const payload = { schemaVersion: 1, id: '7a2262dc-ac57-42a7-970f-611cf880234c',
    topic: 'cat gifts', resultCount: 2, outcome: 'results', selectedRank: null };
  const post = () => f.worker.fetch(new Request('https://stupid.gifts/api/search-demand', { method: 'POST',
    headers: { Origin: 'https://stupid.gifts', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }), f.env);
  assert.equal((await post()).status, 403, 'fixture catalog cannot collect');
  assert.equal(batches, 0);
  f.manifest.dataKind = 'catalog'; f.snapshot.dataKind = 'catalog';
  const response = await post(); assert.equal(response.status, 204); assert.equal(batches, 1);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  const read = await f.worker.fetch(new Request('https://stupid.gifts/api/search-demand'), f.env);
  assert.equal(read.status, 405); assert.equal(await read.text(), '');
  assert.equal(batches, 1);
});

test('explicit persistent safe routes remain useful and indexable while legacy/photo fallbacks stay noindex',async()=>{
  const f=setup();f.manifest.routes['/gifts/fart-button'].persistentIndexable=true;
  f.manifest.routes['/gifts/fart-button.txt'].persistentIndexable=false;
  f.manifest.routes['/gifts/held'].persistentIndexable=true;
  f.advance(2400);
  const page=await f.request('/gifts/fart-button');assert.equal(await page.text(),'/safe.html');assert.equal(page.headers.get('X-Robots-Tag'),null);
  assert.equal((await f.request('/gifts/fart-button?q=test')).headers.get('X-Robots-Tag'),'noindex, follow');
  for(const path of ['/gifts/fart-button.txt','/catalog/feed-1.json','/','/gifts/held'])assert.equal((await f.request(path)).headers.get('X-Robots-Tag'),'noindex, follow');
  const map=await(await f.request('/sitemap.xml')).text();assert.match(map,/<loc>https:\/\/preview\.example\/gifts\/fart-button<\/loc>/);
  assert.doesNotMatch(map,/<loc>https:\/\/preview\.example\/gifts<\/loc>/);
});
test('sitemap cache cannot treat a legacy deadline crossed during rendering as permanent',async()=>{
  const f=setup();let reads=0;
  const worker=createSiteWorker({manifest:f.manifest,snapshot:f.snapshot,now:()=>++reads===1?NOW:NOW+2400});
  const response=await worker.fetch(new Request('https://preview.example/sitemap.xml'),f.env);
  assert.match(response.headers.get('Cache-Control'),/max-age=0, s-maxage=0/);
});
test('public feed uses a permanent base before/after expiry without an aggregate supplier deadline',async()=>{
  const f=setup(),base=product({title:'Independent desk object',eligibleUntil:null,indexable:false});
  f.snapshot.products=[product({title:'SUPPLIER ONLY TITLE',imageUrl:'https://example.invalid/supplier.jpg',persistent:base})];
  f.manifest.routes['/'].persistentIndexable=false;
  let clock=NOW;const worker=createSiteWorker({manifest:f.manifest,snapshot:f.snapshot,
    feedPlan:createStaticFeedPlan(f.snapshot,f.manifest.catalogSnapshotSha256,NOW),now:()=>clock});
  for(const instant of [NOW,NOW+2400,NOW+40*86400_000]){clock=instant;
    const response=await worker.fetch(new Request('https://preview.example/api/catalog-feed',{method:'POST',body:'{}'}),f.env);
    assert.equal(response.status,200);const body=await response.json();assert.deepEqual(body.products,[base]);
    assert.doesNotMatch(JSON.stringify(body),/SUPPLIER|supplier\.jpg|persistent/);
  }
});

test('ready assets, aliases and cache lifetimes are guarded without database access', async () => {
  const fixture = setup();
  for (const path of ['/', '/gifts/fart-button', '/gifts/fart-button.html', '/gifts/fart-button.txt', '/catalog/feed-1.json']) {
    const response = await fixture.request(path, { headers: { 'If-None-Match': 'old' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /max-age=2, s-maxage=2, must-revalidate/);
    assert.equal(response.headers.get('Age'), null);
    assert.equal(fixture.calls.at(-1).headers.get('If-None-Match'), null);
  }
  fixture.advance(2400);
  for (const path of ['/', '/gifts/fart-button', '/gifts/fart-button.html', '/gifts/fart-button.txt', '/catalog/feed-1.json']) {
    const response = await fixture.request(path);
    assert.match(await response.text(), /^\/safe\./);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, follow');
  }
});

test('held assets are safe and query roots are noindex', async () => {
  const fixture = setup();
  assert.equal(await (await fixture.request('/gifts/held')).text(), '/safe.html');
  assert.equal((await fixture.request('/?q=fart')).headers.get('X-Robots-Tag'), 'noindex, follow');
  assert.equal((await fixture.request('/')).headers.get('X-Robots-Tag'), null);
  const neutral = await fixture.request('/howie');
  assert.equal(await neutral.text(), '/howie.html');
  assert.equal(neutral.headers.get('X-Robots-Tag'), 'noindex, follow');
  assert.equal(await (await fixture.request('/', { method: 'HEAD' })).text(), '');
});

test('production canonical hosts preserve bounded campaign/click attribution and functional queries', async () => {
  const fixture = setup({ canonicalOrigin: 'https://stupid.gifts' });
  const request = (url, init) => fixture.worker.fetch(new Request(url, init), fixture.env);
  for (const method of ['GET', 'HEAD']) {
    const response = await request('https://www.stupid.gifts/gifts/fart-button?utm_source=show&utm_medium=podcast&utm_campaign=episode&utm_content=hero&utm_term=desk-gifts&gclid=click-123&gbraid=braid-123&wbraid=web-123&q=desk%20goat&page=2&token=private&redirect=https://evil.test', { method });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), 'https://stupid.gifts/gifts/fart-button?utm_source=show&utm_medium=podcast&utm_campaign=episode&utm_content=hero&utm_term=desk-gifts&gclid=click-123&gbraid=braid-123&wbraid=web-123&q=desk+goat&page=2');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '');
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal((await request('http://stupid.gifts/?q=desk%20goat')).headers.get('Location'), 'https://stupid.gifts/?q=desk+goat');
  assert.equal((await request('https://www.stupid.gifts/?q=desk%0Agoat&utm_source=bad%2Fvalue&redirect=https://evil.test')).headers.get('Location'), 'https://stupid.gifts/');
  assert.equal((await request(`https://www.stupid.gifts/?q=${'a'.repeat(201)}&page=${'1'.repeat(129)}`)).headers.get('Location'), 'https://stupid.gifts/');
  for (const host of ['stupid.gifts.evil.test', 'staging.stupid.gifts', 'stupid.gifts:444']) {
    const response = await request(`https://${host}/`);
    assert.equal(response.status, 404); assert.equal(response.headers.get('Location'), null);
  }
  const home = await request('https://stupid.gifts/');
  assert.equal(home.status, 200); assert.equal(home.headers.get('Location'), null); assert.equal(home.headers.get('X-Robots-Tag'), null);
  assert.equal((await request('https://stupid.gifts/?q=goat')).headers.get('X-Robots-Tag'), 'noindex, follow');
  assert.equal((await request('https://stupid.gifts/gifts/held')).headers.get('X-Robots-Tag'), 'noindex, follow');
});

test('canonical host attribution uses existing character/length bounds and drops unknown or invalid values', async () => {
  const fixture = setup({ canonicalOrigin: 'https://stupid.gifts' });
  const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid'];
  const redirect = async params => new URL((await fixture.worker.fetch(
    new Request(`https://www.stupid.gifts/gifts/fart-button?${params}`), fixture.env,
  )).headers.get('Location'));
  const boundary = new URLSearchParams(keys.map(key => [key, 'a'.repeat(200)]));
  boundary.set('q', 'q'.repeat(200)); boundary.set('page', '1'.repeat(128));
  assert.deepEqual([...(await redirect(boundary)).searchParams], [...boundary]);
  for (const key of keys) for (const value of ['', 'a'.repeat(201), 'bad/value', 'bad\nvalue', 'https://evil.test']) {
    const params = new URLSearchParams({ [key]: value, q: 'desk goat', page: '2', token: 'private', redirect: 'https://evil.test' });
    assert.deepEqual([...(await redirect(params)).searchParams], [['q', 'desk goat'], ['page', '2']]);
  }
  assert.equal(fixture.calls.length, 0);
});

test('production host redirects cannot revive retired, unknown or unsafe routes or redirect writes', async () => {
  const fixture = setup({ canonicalOrigin: 'https://stupid.gifts' });
  for (const path of ['/admin', '/bundles/old', '/api/admin/products', '/api/og/random-gift?gift=id', '/random-gift?gift=id',
    '/random-gift/?gift=', '/gifts/missing', '/unknown', '/gifts/fart-button.html/', '/gifts?page=0',
    '/gifts%2ffart-button', '/gifts/%252fbutton', '/api/search-products/']) {
    const response = await fixture.worker.fetch(new Request(`https://www.stupid.gifts${path}`), fixture.env);
    assert.equal(response.status, 404, path); assert.equal(response.headers.get('Location'), null, path);
  }
  const post = await fixture.worker.fetch(new Request('https://www.stupid.gifts/api/catalog-feed', { method: 'POST', body: '{}' }), fixture.env);
  assert.equal(post.status, 405); assert.equal(post.headers.get('Location'), null);
  assert.equal(fixture.calls.length, 0);
});

test('retired Index pages, data, image and RSC aliases are real 404s even in a stale manifest', async () => {
  const baseline = setup();
  const manifest = structuredClone(baseline.manifest);
  for (const path of ['/weird-gift-index', '/weird-gift-index/data', '/weird-gift-index/data.json', '/safe/index.json'])
    manifest.routes[path] = ready(path, { safeAssetPath: '/safe/index.json' });
  const fixture = setup({ manifest, canonicalOrigin: 'https://stupid.gifts' });
  const paths = ['/weird-gift-index', '/weird-gift-index/', '/weird-gift-index.html', '/weird-gift-index.txt',
    '/weird-gift-index/data', '/weird-gift-index/data.json', '/weird-gift-index/opengraph-image',
    '/weird-gift-index/__next._full.txt', '/%77eird-gift-index', '/weird%2dgift-index/data', '/safe/index.json'];
  for (const host of ['stupid.gifts', 'www.stupid.gifts']) for (const path of paths) for (const method of ['GET', 'HEAD']) {
    const response = await fixture.worker.fetch(new Request(`https://${host}${path}?utm_source=test`, { method }), fixture.env);
    assert.equal(response.status, 404, `${host}${path}`);
    assert.equal(response.headers.get('Location'), null);
  }
  assert.equal(fixture.calls.length, 0);
  const sitemap = await fixture.worker.fetch(new Request('https://stupid.gifts/sitemap.xml'), fixture.env);
  assert.doesNotMatch(await sitemap.text(), /weird-gift-index|safe\/index/);
  fixture.env.ENVIRONMENT = 'staging'; fixture.env.STAGING_AUTH_SECRET = 'synthetic-at-least-sixteen';
  assert.equal((await fixture.worker.fetch(new Request('https://preview.example/weird-gift-index'), fixture.env)).status, 401);
  const protectedRetired = await fixture.worker.fetch(new Request('https://preview.example/weird-gift-index', {
    headers: { Authorization: `Basic ${btoa('staging:synthetic-at-least-sixteen')}` },
  }), fixture.env);
  assert.equal(protectedRetired.status, 404);
  assert.equal(protectedRetired.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('canonical production identity never bypasses preview authentication or noindex policy', async () => {
  const fixture = setup({ canonicalOrigin: 'https://stupid.gifts' }); fixture.env.ENVIRONMENT = 'staging';
  const request = (headers) => fixture.worker.fetch(new Request('https://stupid-gifts-staging.thirty-seven-inc.workers.dev/', { headers }), fixture.env);
  assert.equal((await request()).status, 503);
  fixture.env.STAGING_AUTH_SECRET = 'synthetic-at-least-sixteen';
  assert.equal((await request()).status, 401);
  const response = await request({ Authorization: `Basic ${btoa('staging:synthetic-at-least-sixteen')}` });
  assert.equal(response.status, 200); assert.equal(response.headers.get('Location'), null);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'self'/);
});

test('expiry during an asset lookup replaces the body before responding', async () => {
  const fixture = setup();
  fixture.env.ASSETS.fetch = async (request) => {
    const path = new URL(request.url).pathname;
    if (path === '/index.html') fixture.advance(2400);
    return new Response(path);
  };
  assert.equal(await (await fixture.request('/')).text(), '/safe.html');
});

test('sitemap excludes held and expired routes, with both maintained sitemap paths', async () => {
  const fixture = setup();
  for (const path of ['/sitemap.xml', '/sitemap/0.xml']) {
    const response = await fixture.request(path);
    const xml = await response.text();
    assert.match(xml, /https:\/\/preview.example\/<\/loc>/);
    assert.match(xml, /fart-button<\/loc>/);
    assert.doesNotMatch(xml, /held|howie|\.txt|\.json/);
    assert.match(response.headers.get('Cache-Control'), /max-age=2/);
  }
  fixture.advance(2400);
  assert.doesNotMatch(await (await fixture.request('/sitemap.xml')).text(), /<url>/);
});

test('maintained search and product redirects preserve only bounded queries', async () => {
  const fixture = setup();
  assert.equal((await fixture.request('/search?q=%20crab%20')).headers.get('Location'), '/?q=crab');
  assert.equal((await fixture.request('/search')).headers.get('Location'), '/');
  assert.equal((await fixture.request('/gifts/old-button?utm_source=show')).headers.get('Location'), '/gifts/fart-button?utm_source=show');
  assert.equal((await fixture.request('/gifts/old-button?utm_campaign=episode_2026_10_19&token=private&redirect=https://evil.test')).headers.get('Location'), '/gifts/fart-button?utm_campaign=episode_2026_10_19');
});

test('retired directory, pagination and export aliases always404 while individual gift pages stay live', async () => {
  const f = setup({ canonicalOrigin: 'https://stupid.gifts' });
  for (const host of ['stupid.gifts', 'www.stupid.gifts']) {
    for (const method of ['GET', 'HEAD', 'POST']) {
      for (const path of ['/gifts', '/gifts/', '/gifts?page=1', '/gifts?page=2', '/gifts.html', '/gifts.txt',
        '/gifts/__next._full.txt', '/gifts/page', '/gifts/page/1', '/gifts/page/2/',
        '/gifts/page/9999999999999', '/gifts/page/2.html', '/gifts/page/2.txt', '/gifts/page/2/__next._tree.txt',
        '/%67ifts', '/gifts/%70age/2']) {
        const response = await f.worker.fetch(new Request(`https://${host}${path}`, { method }), f.env);
        assert.equal(response.status, 404, `${host}/${method}/${path}`);
        assert.equal(response.headers.get('Location'), null);
      }
    }
  }
  const response = await f.worker.fetch(new Request('https://stupid.gifts/gifts/fart-button'), f.env);
  assert.equal(response.status, 200);
  const xml = await (await f.worker.fetch(new Request('https://stupid.gifts/sitemap.xml'), f.env)).text();
  assert.doesNotMatch(xml, /<loc>https:\/\/stupid\.gifts\/gifts(?:<|\/page)/);
  assert.match(xml, /<loc>https:\/\/stupid\.gifts\/gifts\/fart-button<\/loc>/);
});

test('known HTML trailing slashes redirect for GET/HEAD with only coarse campaign and bounded functional query', async () => {
  const fixture = setup();
  for (const method of ['GET', 'HEAD']) {
    for (const path of ['/gifts/fart-button', '/howie', '/privacy', '/search']) {
      const response = await fixture.request(`${path}/?utm_source=show&utm_medium=podcast&utm_campaign=episode&q=desk%20goat&page=2&gift=private&token=private&redirect=https://evil.test&gclid=private&utm_term=private`, { method });
      assert.equal(response.status, 308, path);
      assert.equal(response.headers.get('Location'), `${path}?utm_source=show&utm_medium=podcast&utm_campaign=episode&q=desk+goat&page=2`);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal(await response.text(), '');
    }
  }
  assert.equal(fixture.calls.length, 0);
  for (const page of ['0', '-1', '1.5', 'junk', '1'.repeat(129)]) assert.equal((await fixture.request(`/gifts/?page=${page}`)).status, 404);
  const redirect = await fixture.request('/gifts/fart-button/');
  fixture.advance(2400);
  assert.equal(await (await fixture.request(redirect.headers.get('Location'))).text(), '/safe.html');
  const post = await fixture.request('/gifts/', { method: 'POST' });
  assert.equal(post.status, 404); assert.equal(post.headers.get('Location'), null);
  const overlong = await fixture.request(`/howie/?q=${'a'.repeat(201)}&page=${'1'.repeat(129)}`);
  assert.equal(overlong.headers.get('Location'), '/howie');
});

test('trailing slashes cannot revive retired gift IDs, API paths, unknown pages or data aliases', async () => {
  const fixture = setup();
  for (const method of ['GET', 'HEAD']) for (const path of ['/random-gift/?gift=private', '/random-gift/?gift=',
    '/api/search-products/', '/api/catalog-feed/', '/api/og/random-gift/', '/bundles/old/', '/unknown/',
    '/gifts/missing/', '/gifts/fart-button.html/', '/gifts/fart-button.txt/', '/catalog/feed-1.json/', '/gifts//']) {
    const response = await fixture.request(path, { method });
    assert.equal(response.status, 404, path); assert.equal(response.headers.get('Location'), null);
  }
  assert.equal(fixture.calls.length, 0);
});

test('shared held pages normalize only exact manifest-backed canonical snapshot paths', async () => {
  const fixture = setup();
  const held = { ...ready('/unused'), assetPath: '/safe/product.html', safeAssetPath: '/safe/product.html', state: 'held', indexable: false, eligibleUntil: null };
  const snapshot = { ...fixture.snapshot, heldProducts: [{ path: '/gifts/held' }, { path: '/gifts/not-in-manifest' }] };
  const routes = { ...fixture.manifest.routes, '/gifts/held': held, '/gifts/not-canonical': held, '/gifts/held.html': held };
  const worker = createSiteWorker({ manifest: { ...fixture.manifest, routes }, snapshot });
  const request = (path, method = 'GET') => worker.fetch(new Request(`https://preview.example${path}`, { method }), fixture.env);
  for (const method of ['GET', 'HEAD']) {
    const response = await request('/gifts/held/?utm_source=show&q=desk%20gift&token=discard', method);
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), '/gifts/held?utm_source=show&q=desk+gift');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(await response.text(), '');
    for (const path of ['/gifts/not-in-manifest/', '/gifts/not-canonical/', '/gifts/held.html/', '/gifts/held.txt/'])
      assert.equal((await request(path, method)).status, 404, path);
  }
  assert.equal(fixture.calls.length, 0);
  const page = await request('/gifts/held');
  assert.equal(await page.text(), '/safe/product.html');
  assert.equal(page.headers.get('X-Robots-Tag'), 'noindex, follow');
  assert.equal(page.headers.get('Cache-Control'), 'no-store');
});

test('Vercel has no retired bundle catch-all or heuristic map; canonical routes remain', () => {
  const present = (path) => existsSync(new URL(`../${path}`, import.meta.url));
  assert.equal(present('app/[slug]/page.tsx'), false);
  assert.equal(present('lib/legacy-redirects.ts'), false);
  for (const path of ['app/not-found.tsx', 'app/gifts/[slug]/page.tsx', 'app/gift-guides/[slug]/page.tsx', 'app/gifts/page.tsx', 'app/gift-guides/page.tsx']) {
    assert.equal(present(path), true, path);
  }
});

test('retired, unknown HTML/data and missing routes never redirect or fall back to the homepage', async () => {
  const fixture = setup();
  for (const path of ['/old-gift-bundle', '/bundles/foo', '/admin', '/api/og/random-gift?gift=id', '/api/admin/products', '/random-gift?gift=id', '/gifts/missing', '/rogue.html', '/secret.json', '/_next/other.txt',
    '/purrfect-gifts-for-cat-loving-bookworms-n6y7', '/hilarious-gift-bundles-for-a-new-bathroom-remodel-522n',
    '/hilarious-gift-bundles-for-property-managers-fy9y', '/quirky-optical-illusion-statues-for-unique-decor-lovers-ey78',
    '/hilarious-dirty-santa-gift-bundles-for-holiday-fun-kwsf', '/funny-office-gift-ideas-abcd?utm_source=pinterest', '/gifts-for-moon-dwellers-abcd']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await fixture.request(path, { method });
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get('Location'), null, path);
    }
  }
  assert.equal(fixture.calls.length, 0);
  assert.equal((await fixture.request('/_next/static/app.js')).status, 200);
});

test('encoded separators and double encoding cannot reach a decoding/normalizing asset service', async () => {
  const fixture = setup();
  const decoded = [];
  fixture.env.ASSETS.fetch = async (request) => {
    const url = new URL(request.url);
    const path = new URL(decodeURIComponent(decodeURIComponent(url.pathname)).replaceAll('\\', '/'), url.origin).pathname;
    decoded.push(path);
    return new Response(path);
  };
  for (const path of [
    '/_next/static/%2e%2e%2f%2e%2e%2findex.html', '/_next/static/%2Findex.html',
    '/_next/static/%5c..%5C..%5cindex.html', '/_next/static/%252e%252e%252findex.html',
    '/gifts/fart-button%2fextra', '/%25',
  ]) assert.equal((await fixture.request(path)).status, 404, path);
  assert.deepEqual(decoded, []);
  assert.equal((await fixture.request('/_next/static/chunks/app/%5Bslug%5D.js?next=%2F&value=%255c')).status, 200);
  assert.equal(decoded.at(-1), '/_next/static/chunks/app/[slug].js');
  assert.equal((await fixture.request('/gifts/funny%20button?utm_content=%2F')).status, 200);
  assert.equal(decoded.at(-1), '/gifts/fart-button.html');
  assert.equal((await fixture.request('/_next/static/app.js')).status, 200);
});

test('single-encoded equivalents of retained chunk paths share the exact expiry guard', async () => {
  const fixture = setup();
  const raw = '/_next/static/chunks/app/gifts/[slug]/page-old.js';
  const aliases = [raw, raw.replace('[slug]', '%5Bslug%5D'), raw.replace('[slug]', '%5bslug%5d'),
    raw.replace('[slug]', '%5bslug%5D').replace('page-old', '%70age-%6fld')];
  for (const path of aliases) {
    const response = await fixture.request(path);
    assert.equal(response.status, 200); assert.equal(await response.text(), raw);
    assert.match(response.headers.get('Cache-Control'), /max-age=2/);
  }
  fixture.advance(2400);
  for (const path of aliases) {
    const response = await fixture.request(path);
    assert.equal(await response.text(), '/safe.js'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  const count = fixture.calls.length;
  for (const path of ['/_next/static/%zz.js', '/_next/static/%C0%AF.js', raw.replace('page', '%2570age'), '/rando%6d-gift/?gift=retired']) {
    assert.equal((await fixture.request(path)).status, 404, path);
  }
  assert.equal(fixture.calls.length, count);
});

test('timeless privacy companions and owned illustrations remain available', async () => {
  const fixture = setup();
  fixture.advance(2400);
  for (const path of ['/privacy', '/privacy.html', '/privacy.txt', '/privacy/__next._full.txt', '/illustrations/button.svg', '/images/gift-placeholder.svg']) {
    assert.equal((await fixture.request(path)).status, 200, path);
  }
  assert.equal(new URL(fixture.calls[0].url).pathname, '/privacy.html');
  assert.equal((await fixture.request('/images/unreviewed-file.svg')).status,404);
});

test('photo shards expire independently of permanent pages, including expiry during asset I/O',async()=>{
  for(const duringIO of [false,true]){
    const f=setup();let clock=NOW;
    const pathname=`/catalog/${'a'.repeat(64)}/photos-1.json`;
    f.manifest.routes['/']={...f.manifest.routes['/'],eligibleUntil:null};
    f.manifest.routes[pathname]={assetPath:pathname,safeAssetPath:'/safe/photos.json',eligibleUntil:DEADLINE,state:'ready',indexable:false};
    const worker=createSiteWorker({manifest:f.manifest,snapshot:f.snapshot,now:()=>clock});
    const env={...f.env,ASSETS:{async fetch(request){const path=new URL(request.url).pathname;
      if(duringIO&&path===pathname)clock=NOW+2400;
      return Response.json(path==='/safe/photos.json'?{status:'unavailable'}:{imageUrl:'https://supplier.invalid/synthetic.jpg'});}}};
    if(!duringIO)clock=NOW+2400;
    const response=await worker.fetch(new Request(`https://preview.example${pathname}`),env);
    assert.deepEqual(await response.json(),{status:'unavailable'});
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.equal((await worker.fetch(new Request('https://preview.example/'),f.env)).status,200);
  }
});

test('POST feed preserves products/hasMore, bounds input, and fails clearly after expiry', async () => {
  const fixture = setup();
  const response = await fixture.request('/api/catalog-feed', { method: 'POST', body: JSON.stringify({ seed: 'test', limit: 1 }) });
  assert.deepEqual(Object.keys(await response.json()).sort(), ['hasMore', 'products']);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const excluded = await fixture.request('/api/catalog-feed', { method: 'POST', body: JSON.stringify({ excludeIds: ['asin-1', 'unknown-id'] }) });
  assert.deepEqual(await excluded.json(), { products: [], hasMore: false });
  assert.equal((await fixture.request('/api/catalog-feed', { method: 'POST', body: 'x'.repeat(64001) })).status, 413);
  assert.equal((await fixture.request('/api/catalog-feed')).status, 405);
  fixture.advance(2400);
  assert.equal((await fixture.request('/api/catalog-feed', { method: 'POST', body: '{}' })).status, 503);
});

test('missing or incompatible feed plans fail closed without affecting guarded browsing', async () => {
  for (const feedPlan of [undefined, {}, { schemaVersion: 1, catalogRevision: 'other', catalogSnapshotSha256: 'a'.repeat(64), entries: [] }]) {
    const fixture = setup({ feedPlan });
    assert.equal((await fixture.request('/api/catalog-feed', { method: 'POST', body: '{}' })).status, 503);
    assert.equal((await fixture.request('/')).status, 200);
  }
});

test('staging is fail-closed, protected, noindex and blocks production analytics transport', async () => {
  const fixture = setup();
  fixture.env.ENVIRONMENT = 'staging';
  assert.equal((await fixture.request('/')).status, 503);
  fixture.env.STAGING_AUTH_SECRET = 'test-secret-at-least-sixteen';
  assert.equal((await fixture.request('/')).status, 401);
  assert.equal(fixture.calls.length, 0);
  const response = await fixture.request('/', { headers: { Authorization: `Basic ${btoa('staging:test-secret-at-least-sixteen')}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.match(response.headers.get('Content-Security-Policy'), /connect-src 'self'/);
  assert.doesNotMatch(response.headers.get('Content-Security-Policy'), /google-analytics|posthog/);
});

test('deployed release identity is an exact no-store compiled allowlist without assets or DB', async () => {
  const fixture = setup();
  let reads = 0;
  Object.defineProperty(fixture.env, 'DB', { get() { reads++; throw new Error('Identity must not read D1'); } });
  fixture.env.OPENAI_API_KEY = 'FAKE_SECRET_NOT_FOR_RESPONSE';
  const response = await fixture.request('/.well-known/catalog-release.json?release_id=untrusted&catalog_revision=wrong');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.deepEqual(await response.json(), fixture.releaseIdentity);
  assert.equal(reads, 0); assert.equal(fixture.calls.length, 0);
  const head = await fixture.request('/.well-known/catalog-release.json', { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(await head.text(), '');
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const invalid = await fixture.request('/.well-known/catalog-release.json', { method });
    assert.equal(invalid.status, 405); assert.equal(invalid.headers.get('Allow'), 'GET, HEAD');
  }
  fixture.advance(2400); // Identity remains a historical bundle identity, not a freshness claim.
  assert.equal((await fixture.request('/.well-known/catalog-release.json')).status, 200);
});

test('release identity retains staging authentication/noindex and fails closed for a missing digest', async () => {
  const fixture = setup(); fixture.env.ENVIRONMENT = 'staging';
  assert.equal((await fixture.request('/.well-known/catalog-release.json')).status, 503);
  fixture.env.STAGING_AUTH_SECRET = 'synthetic-at-least-sixteen';
  assert.equal((await fixture.request('/.well-known/catalog-release.json')).status, 401);
  const response = await fixture.request('/.well-known/catalog-release.json', { headers: { Authorization: `Basic ${btoa('staging:synthetic-at-least-sixteen')}` } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const source = setup();
  const worker = createSiteWorker({ manifest: { ...source.manifest, catalogSnapshotSha256: undefined }, snapshot: source.snapshot, releaseIdentity: source.releaseIdentity });
  assert.equal((await worker.fetch(new Request('https://preview.example/.well-known/catalog-release.json'), source.env)).status, 503);
});

test('missing, malformed or incompatible build-derived identities refuse without runtime hashing', async () => {
  const source = setup();
  for (const releaseIdentity of [undefined, {}, { ...source.releaseIdentity, release_id: 'different' },
    { ...source.releaseIdentity, code_sha: 'd'.repeat(40) }, { ...source.releaseIdentity, catalog_revision: 'other' },
    { ...source.releaseIdentity, catalog_snapshot_sha256: 'd'.repeat(64) }, { ...source.releaseIdentity, manifest_sha256: 'invalid' },
    { ...source.releaseIdentity, secret: 'must-not-export' }]) {
    const fixture = setup({ releaseIdentity });
    assert.equal((await fixture.request('/.well-known/catalog-release.json')).status, 503);
    assert.equal(fixture.calls.length, 0);
  }
});
