import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { catalogDeadline } from '../../lib/catalog/display.ts';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { validateCatalogSnapshot } from '../../lib/catalog/snapshot.ts';
import type { CatalogAssetRoute, SiteAssetManifest } from '../../lib/catalog/types.ts';
import { createBrowseRelease, INITIAL_BROWSE_COUNT } from '../../static-site/lib/browse.ts';
import { validateCardShard } from '../../static-site/lib/card-shard.ts';
import { nextRandomIndex } from '../../static-site/lib/selection.ts';
import { createSiteWorker } from '../../workers/site/index.ts';
import { createStaticFeedPlan, prepareStaticFeed } from '../../workers/site/feed.ts';
import type { SiteEnv } from '../../workers/site/bindings.ts';

const RATE = 100;
const SECRET = 'local-fixture-not-a-provider-secret';
const AUTH = `Basic ${btoa(`staging:${SECRET}`)}`;
const RETAINED = '/_next/static/chunks/app/gifts/[slug]/retained.js';
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const unchanged = () => ({ assets: 0, ids: 0, keyword: 0, budget: 0, embeddings: 0, vectors: 0, diagnostics: 0 });

/** Owned fictional fixture, not a Next export or a real catalog/rights proof. */
export function localFixture(now: () => number, lifetimeMs: number) {
  const started = now(), end = new Date(started + lifetimeMs).toISOString();
  const snapshot = validateCatalogSnapshot({ schemaVersion: 1, dataKind: 'synthetic_fixture', catalogRevision: 'local-burst-fixture',
    generatedAt: new Date(started).toISOString(), heldProducts: [{ id: 'fixture-held', publicId: '00000000-0000-4000-8000-999999999999',
      slug: 'held-fixture', path: '/gifts/held-fixture', title: 'Gift currently unavailable',
      description: 'This gift is not currently available in the curated catalog. Browse other gifts instead.', reason: 'rights_unverified' }], slugHistory: [],
    products: Array.from({ length: 60 }, (_, i) => ({ id: `fixture-${i}`, publicId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      slug: `illustrative-fixture-${i}`, title: `Funny alphafixture${i} betafixture${i} gizmo`, description: 'Owned fictional layout fixture, not for sale.',
      imageUrl: '/illustrations/fixture.svg', affiliateUrl: 'https://example.invalid/not-for-sale', source: 'amazon', currency: 'USD', price: 0,
      isActive: true, qualityScore: .8, eligibleUntil: end })) }, new Date(started));
  const browse = createBrowseRelease(snapshot), digest = hash(`${JSON.stringify(snapshot)}\n`);
  const plan = createStaticFeedPlan(snapshot, digest), prepared = prepareStaticFeed(snapshot, plan, digest)!;
  assert.equal(browse.opening.length + browse.feed.initial.length, INITIAL_BROWSE_COUNT); assert.equal(browse.random.poolSize, 48);
  assert.equal(plan.entries.length, 60);
  const html = (products = browse.opening) => '<!doctype html><html><meta name="robots" content="noindex,nofollow"><body><main><h1>Local fictional fixtures, not for sale</h1>'
    + products.map(p => `<article><a href="/gifts/${p.slug}"><img src="${p.imageUrl}" alt="Owned fictional fixture" width="640" height="640"><h2>${p.title}</h2></a><p>${p.description}</p></article>`).join('')
    + '</main></body></html>';
  const assets = new Map<string, { body: string; type: string }>();
  const routes: Record<string, CatalogAssetRoute> = {};
  const put = (path: string, body: string, type = 'text/html') => assets.set(path, { body, type });
  put('/safe/catalog.html', '<main>Gifts unavailable. <a href="/">Try again</a></main>');
  put('/safe/catalog.txt', 'Collection unavailable.'); put('/safe/catalog.json', '{"status":"unavailable","products":[],"next":null}', 'application/json');
  put('/safe/unavailable.js', '/* Retained code unavailable. Reload the page. */', 'application/javascript');
  function route(path: string, body: string, type = 'text/html', held = false) {
    const assetPath = path === '/' ? '/index.html' : /\.(txt|json|js)$/.test(path) ? path : `${path}.html`;
    put(assetPath, body, type);
    routes[path] = { assetPath, safeAssetPath: type === 'application/json' ? '/safe/catalog.json'
      : type === 'application/javascript' ? '/safe/unavailable.js' : type === 'text/plain' ? '/safe/catalog.txt' : '/safe/catalog.html',
    eligibleUntil: held ? null : end, state: held ? 'held' : 'ready', indexable: type === 'text/html' };
  }
  route('/', html([...browse.opening, ...browse.feed.initial])); route('/random-gift', html([browse.random.initial!]));
  route('/gifts/illustrative-fixture-0', html([browse.random.initial!])); route('/gifts/held-fixture', '', 'text/html', true);
  route('/index.txt', JSON.stringify(browse.opening), 'text/plain');
  route(RETAINED, '/* Owned retained fixture code. */', 'application/javascript');
  routes[RETAINED].eligibleUntil = routes[RETAINED].retainedUntil = new Date(started + lifetimeMs / 2).toISOString();
  for (const shard of browse.shards) route(shard.path, JSON.stringify(shard.payload), 'application/json');
  put('/_next/static/current.js', '/* Owned code: no catalog, credentials or analytics. */', 'application/javascript');
  put('/_next/static/current.css', 'body{background:#faf8f2;color:#171717}', 'text/css');
  put('/illustrations/fixture.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#c2410c"/></svg>', 'image/svg+xml');
  const manifest: SiteAssetManifest = { schemaVersion: 1, sourceMode: 'preview', siteIdentitySha256: 'd'.repeat(64), releaseId: 'local-only',
    codeSha: 'c'.repeat(40), catalogRevision: snapshot.catalogRevision, catalogSnapshotSha256: digest, generatedAt: snapshot.generatedAt,
    nextExpiry: end, productCount: 60, slugCount: 61, vectorSyncWatermark: 0, priorReleaseId: null, dataKind: snapshot.dataKind,
    retention: null, routes, checksums: Object.fromEntries([...assets].map(([path, value]) => [path, hash(value.body)])) };
  const calls = unchanged(); let failure = '';
  const env: SiteEnv = { ENVIRONMENT: 'staging', STAGING_AUTH_SECRET: SECRET,
    SEMANTIC_SEARCH_ENABLED: 'true', SEMANTIC_SEARCH_DAILY_REQUEST_CAP: '100000', SEMANTIC_SEARCH_DAILY_TOKEN_CAP: '100000000',
    ASSETS: { async fetch(request) {
      calls.assets++; assert.equal(request.headers.has('If-None-Match'), false);
      const asset = assets.get(new URL(request.url).pathname);
      if (failure === 'asset') throw new Error('PRIVATE_FAKE_PROVIDER_ERROR');
      return asset ? new Response(asset.body, { headers: { 'Content-Type': asset.type, 'Cache-Control': 'public,max-age=31536000,immutable' } }) : new Response('Not found', { status: 404 });
    } }, VECTORIZE: { async query(vector, options) {
      calls.vectors++; assert.equal(vector.length, 1536); assert.ok(options.topK <= 100);
      assert.deepEqual(options.filter, { catalogRevision: snapshot.catalogRevision, eligible: true }); await pause(1);
      return { matches: snapshot.products.slice(0, options.topK).map(product => ({ id: product.publicId, score: .9 })) };
    } } };
  const worker = createSiteWorker({ snapshot, manifest, feedPlan: plan, now, semanticBudgetScope: { environment: 'staging', index: 'local-only' },
    searchAdapters: { storage: () => ({
      async byPublicIds(ids, at, revision) { calls.ids++; assert.ok(ids.length <= 100); assert.equal(revision, snapshot.catalogRevision);
        if (failure === 'storage') throw new Error('PRIVATE_FAKE_PROVIDER_ERROR'); await pause(1);
        return snapshot.products.filter(p => ids.includes(p.publicId) && catalogDeadline(p.eligibleUntil) > at.getTime()); },
      async keyword(_query, limit, at) { calls.keyword++; assert.ok(limit <= 240);
        if (failure === 'storage') throw new Error('PRIVATE_FAKE_PROVIDER_ERROR');
        return snapshot.products.filter(p => catalogDeadline(p.eligibleUntil) > at.getTime()).slice(0, limit); },
    }),
    async embed() { calls.embeddings++; if (failure === 'embedding') throw new Error('PRIVATE_FAKE_PROVIDER_ERROR'); await pause(5); return Array(1536).fill(.1); },
    async diagnostic(record) { calls.diagnostics++; assert.match(record.queryHash, /^[a-f0-9]{64}$/);
      assert.equal(Object.keys(record).sort().join(','), 'id,matchType,outcome,queryHash,queryLength,resultCount,topSimilarity'); },
  } });
  const request = (path: string, init: RequestInit = {}, authenticated = true) => {
    const headers = new Headers(init.headers); if (authenticated) headers.set('Authorization', AUTH);
    return worker.fetch(new Request(`https://local-only.invalid${path}`, { ...init, headers }), env);
  };
  return { snapshot, browse, prepared, assets, calls, env, request, fail(value: string) { failure = value; } };
}

export async function safetyProbes() {
  let clock = Date.now(); const f = localFixture(() => clock, 60_000);
  for (const value of f.assets.values()) assert.doesNotMatch(value.body, /G-6RR3HPR747|AW-17626116539|posthog|PRIVATE_FAKE|local-fixture-not-a-provider-secret/);
  assert.equal((await f.request('/', {}, false)).status, 401);
  f.env.STAGING_AUTH_SECRET = ''; assert.equal((await f.request('/')).status, 503); f.env.STAGING_AUTH_SECRET = SECRET;
  assert.equal(f.calls.assets, 0); assert.equal(f.calls.ids, 0);
  const before = { ...f.calls };
  const normal = await f.request('/', { headers: { 'If-None-Match': 'old' } });
  assert.match(normal.headers.get('Content-Security-Policy')!, /connect-src 'self';/);
  assert.match(normal.headers.get('X-Robots-Tag')!, /noindex/); assert.equal(normal.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(f.calls.ids, before.ids); assert.equal(f.calls.budget, before.budget);
  const pool = f.browse.shards.find(shard => shard.path === f.browse.random.poolPath)!;
  assert.equal(validateCardShard(pool.payload, { catalogRevision: f.browse.catalogRevision, version: f.browse.version, kind: 'random', now: clock }).products.length, 48);
  assert.ok(f.browse.shards.filter(shard => shard.payload.kind === 'feed').every(shard => shard.payload.products.length <= 24));
  assert.notEqual(nextRandomIndex(48, 0, () => .5), 0);
  const selected = f.prepared.select('fixed', 36, new Set(f.snapshot.products.slice(0, 20).map(p => p.id)), clock)!;
  assert.equal(selected.products.length, 36); assert.ok(selected.inspected <= 20 + 36 + 8);
  const feed = await f.request('/api/catalog-feed', { method: 'POST', body: JSON.stringify({ seed: 'fixed', limit: 999 }) });
  assert.ok((await feed.json() as { products: unknown[] }).products.length <= 36); assert.equal(f.calls.ids, 0);
  for (const mode of ['embedding', 'storage', 'asset']) {
    f.fail(mode); const response = await f.request(mode === 'asset' ? '/' : `/api/search-products?q=controlled-${mode}`, { headers: { 'CF-Connecting-IP': mode } });
    const body = await response.text(); assert.doesNotMatch(body, /PRIVATE_FAKE/);
    assert.equal(response.status, ['storage', 'asset'].includes(mode) ? 503 : 200);
    if (mode === 'embedding') assert.match(body, /"matchType":"keyword"/);
  }
  f.fail(''); const prior = { ...f.calls };
  await f.request('/api/search-products?q=cache-proof', { headers: { 'CF-Connecting-IP': 'cache' } });
  const after = { ...f.calls }; await f.request('/api/search-products?q=cache-proof', { headers: { 'CF-Connecting-IP': 'cache' } });
  assert.equal(after.embeddings, prior.embeddings + 1); assert.deepEqual(f.calls, after);
  for (let i = 0; i < 21; i++) {
    const response = await f.request('/api/search-products?q=rate-proof', { headers: { 'CF-Connecting-IP': 'rate' } });
    assert.equal(response.status, 200); // Owner removed the per-IP query cutoff.
  }
  f.env.ENVIRONMENT = 'production'; // Local cache-policy probe, never a deployment.
  assert.match((await f.request('/')).headers.get('Cache-Control')!, /max-age=60, s-maxage=60/);
  clock += 60_000;
  for (const path of ['/', '/index.html', '/index.txt', f.browse.random.poolPath, '/_next/static/chunks/app/gifts/%5Bslug%5D/retained.js', '/gifts/held-fixture']) {
    const response = await f.request(path, { headers: { 'If-None-Match': 'old' } });
    assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /alphafixture/); assert.match(response.headers.get('X-Robots-Tag')!, /noindex/);
  }
  assert.equal((await f.request('/api/catalog-feed', { method: 'POST', body: '{}' })).status, 503);
  assert.doesNotMatch(await (await f.request('/sitemap.xml')).text(), /<url>/);
  assert.equal((await f.request('/catalog/unknown.json')).status, 404);
  return { passed: true, initialCards: INITIAL_BROWSE_COUNT, randomPool: 48, shardLimit: 24, feedInspectionBound: 64,
    expiryClock: 'advanced fixture clock outside timed load', privacy: 'protected CSP/noindex/no-store plus fixture asset scan' };
}

const summary = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] || 0).toFixed(3));
  return { count: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99), max: at(1) };
};

/** Real-clock, fixed95/5 mix. It never binds an HTTP port or accepts a target URL. */
export async function runLocalBurst(seconds = 600, progress: (value: unknown) => void = () => {}) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 600) throw new Error('Duration must be an integer from 1 to 600 seconds');
  const originalFetch = globalThis.fetch; let networkAttempts = 0; let stopMonitor = () => {};
  globalThis.fetch = async () => { networkAttempts++; throw new Error('External network prohibited in local rehearsal'); };
  try {
    const probes = await safetyProbes(); const f = localFixture(Date.now, (seconds + 60) * 1000);
    const staticPaths = ['/', '/random-gift', '/index.txt', '/gifts/illustrative-fixture-0', '/gifts/held-fixture',
      f.browse.random.poolPath, ...f.browse.shards.filter(s => s.payload.kind === 'feed').map(s => s.path),
      '/_next/static/current.js', '/_next/static/current.css', '/illustrations/fixture.svg', RETAINED];
    const latency = { static: [] as number[], search: [] as number[] }, lag: number[] = [], errors: string[] = []; let errorCount = 0;
    const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable(); stopMonitor = () => histogram.disable();
    const cpu = process.cpuUsage(), utilization = performance.eventLoopUtilization(), memory = process.memoryUsage();
    const startedAt = new Date().toISOString(), start = performance.now(), pending = new Set<Promise<void>>(); let highWater = 0, bytes = 0, retainedSafeResponses = 0;
    async function send(i: number) {
      const semantic = i % 20 === 19, began = performance.now();
      try {
        const response = await f.request(semantic ? `/api/search-products?q=local-fixture-${Math.floor(i / 20)}` : staticPaths[i % staticPaths.length], {
          headers: { 'CF-Connecting-IP': `synthetic-client-${Math.floor(i / 20) % 32}` },
        });
        assert.equal(response.status, 200); const body = await response.text(); bytes += Buffer.byteLength(body);
        assert.match(response.headers.get('X-Robots-Tag')!, /noindex/); assert.doesNotMatch(body, /PRIVATE_FAKE/);
        if (!semantic && body.includes('Retained code unavailable.')) retainedSafeResponses++;
        if (semantic) { const data = JSON.parse(body); assert.equal(data.results.length, 36); assert.ok(data.results.every((p: { matchType: string }) => p.matchType === 'semantic')); }
      } catch { errorCount++; if (errors.length < 20) errors.push(`request_${i}_failed`); }
      latency[semantic ? 'search' : 'static'].push(performance.now() - began);
    }
    for (let i = 0; i < seconds * RATE; i++) {
      const due = start + i * 1000 / RATE; await pause(Math.max(0, due - performance.now())); lag.push(Math.max(0, performance.now() - due));
      if (pending.size >= 100) throw new Error('Local concurrency bound exceeded');
      const task = send(i).finally(() => pending.delete(task)); pending.add(task); highWater = Math.max(highWater, pending.size);
      if (i && i % 6000 === 0) progress({ elapsedSeconds: Math.round((performance.now() - start) / 1000), requestsStarted: i });
    }
    await Promise.all(pending); await pause(Math.max(0, seconds * 1000 - (performance.now() - start))); histogram.disable();
    const elapsedMs = performance.now() - start, cpuUsed = process.cpuUsage(cpu), endMemory = process.memoryUsage();
    const expectedSearch = seconds * RATE / 20;
    const checks = { adapterCounts: [f.calls.ids, f.calls.embeddings, f.calls.vectors, f.calls.diagnostics].every(value => value === expectedSearch)
      && f.calls.budget === 0 && f.calls.keyword === expectedSearch, noNetwork: networkAttempts === 0 };
    return { schemaVersion: 1, kind: 'local-only-worker-rehearsal', startedAt, durationRequestedSeconds: seconds, elapsedMs: Math.round(elapsedMs),
      environment: { node: process.version, platform: process.platform, architecture: process.arch, transport: 'in-process', cacheState: 'warm handler; no CDN' },
      measurement: 'Handler dispatch through consumed response body; not network TTFB.',
      requests: seconds * RATE, achievedRps: Number((seconds * RATE / (elapsedMs / 1000)).toFixed(3)), mix: { static: 95, mockSemantic: 5 },
      errors: errorCount, errorSamples: errors, highWater, bytes, retainedSafeResponses, latencyMs: { static: summary(latency.static), mockSearch: summary(latency.search) },
      schedulingLagMs: summary(lag), eventLoopDelayMs: { p95: Number((histogram.percentile(95) / 1e6).toFixed(3)), max: Number((histogram.max / 1e6).toFixed(3)) },
      eventLoopUtilization: performance.eventLoopUtilization(utilization).utilization, nodeCpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
      rssBytes: { before: memory.rss, after: endMemory.rss }, adapters: f.calls, networkAttempts, probes, checks,
      mockLatencyMs: { embedding: 5, vector: 1, idLookup: 1 },
      limitations: ['Direct in-process handler, no HTTP/TLS/CDN or geographic timing.', 'Owned representative markup, not a complete Next export/browser/LCP audit.',
        'Mock storage/budget/diagnostics are not D1 SQL, rows-read, global budget or transactional acceptance.',
        'Mock embedding/index latency and Node CPU do not prove OpenAI/Vectorize/Cloudflare CPU, billing or production capacity.',
        'One Node process, synthetic clients, warm handler; no distributed cold starts or provider load.'] };
  } finally { stopMonitor(); globalThis.fetch = originalFetch; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); assert.ok(args.length === 0 || args.length === 4 && args[0] === '--seconds' && args[2] === '--output', 'Use --seconds 600 --output output/local-burst.json');
  const seconds = args.length ? Number(args[1]) : 600;
  const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), harnessSha256 = hash(await readFile(new URL(import.meta.url), 'utf8'));
  const result = await runLocalBurst(seconds, value => console.log(JSON.stringify({ progress: value })));
  const receipt = { ...result, codeSha, harnessSha256 };
  if (args.length) { const path = resolve(args[3]); await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  console.log(JSON.stringify(receipt, null, 2)); if (result.errors || !result.checks.adapterCounts || !result.checks.noNetwork) process.exitCode = 1;
}
