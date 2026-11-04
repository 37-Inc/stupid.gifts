import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { catalogDisplayView, earliestDisplayExpiry } from '../lib/catalog/display.ts';
import { validateCatalogSnapshot } from '../lib/catalog/snapshot.ts';
import { createPhotoRelease } from '../static-site/lib/photos.ts';
import { PHOTO_PLACEHOLDER, photoVersion, validatePhotoIndex, validatePhotoShard } from '../static-site/lib/photo-shard.ts';
import { createBrowseRelease } from '../static-site/lib/browse.ts';
import { validateCardShard } from '../static-site/lib/card-shard.ts';
import { createOgRelease } from '../static-site/lib/og.ts';
import { siteIdentity } from '../static-site/lib/site-identity.ts';
import { createStaticRoutes } from '../static-site/lib/asset-routes.ts';
import { giftGuides } from '../lib/gift-guide-definitions.ts';
import { assertStaticAssetCapacity, CLOUDFLARE_ASSET_LIMIT } from '../scripts/staging/retention.mts';

const fixture = JSON.parse(fs.readFileSync(new URL('../static-site/fixtures/catalog.snapshot.json', import.meta.url)));
const at = Date.parse(fixture.generatedAt), deadline = new Date(at + 86400000).toISOString();
function snapshot(count = 73) {
  return validateCatalogSnapshot({ ...fixture, heldProducts: [], slugHistory: [], products: Array.from({ length: count }, (_, i) => {
    const product = { ...fixture.products[0], id: `fixture-${i}`, publicId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      slug: `original-fictional-object-${i}`, title: `Supplier title ${i}`, imageUrl: `https://example.invalid/supplier-photo-${i}.jpg`,
      eligibleUntil: deadline };
    product.persistent = { ...product, title: `Original fictional object ${i}`, description: `Original fictional object ${i}`,
      wittyDescription: undefined, imageUrl: PHOTO_PLACEHOLDER, eligibleUntil: null, indexable: false };
    delete product.persistent.wittyDescription;
    return product;
  }) }, new Date(at));
}

test('permanent browse, OG and card shards never contain supplier text/photos or lose catalog identities', () => {
  const input = snapshot(), bytes = JSON.stringify(input), view = catalogDisplayView(input), browse = createBrowseRelease(input);
  assert.equal(view.products.length, 73);
  assert.equal(earliestDisplayExpiry(input.products), null);
  assert.doesNotMatch(JSON.stringify(view), /Supplier title|supplier-photo/);
  assert.doesNotMatch(JSON.stringify(browse), /Supplier title|supplier-photo/);
  assert.doesNotMatch(JSON.stringify(createOgRelease(input, siteIdentity)), /Supplier title|supplier-photo/);
  const all = [...browse.opening, ...browse.feed.initial];
  for (const shard of browse.shards) {
    const payload = validateCardShard(shard.payload, { catalogRevision: input.catalogRevision, version: browse.version,
      kind: shard.payload.kind, now: Date.parse('2100-01-01T00:00:00.000Z') });
    assert.equal(payload.eligibleUntil, null);
    if (payload.kind === 'feed') all.push(...payload.products);
  }
  assert.equal(new Set(all.map(p => p.id)).size, 73);
  assert.equal(JSON.stringify(input), bytes);
});

test('photos use one bounded, versioned static overlay with their original finite deadlines', () => {
  const input = snapshot(), bytes = JSON.stringify(input), photos = createPhotoRelease(input);
  assert.equal(photoVersion(photos.indexPath), photos.index.version);
  assert.equal(Object.keys(validatePhotoIndex(photos.index, photos.index.version).products).length, 73);
  assert.doesNotMatch(JSON.stringify(photos.index), /https:|supplier-photo/);
  assert.deepEqual(photos.shards.map(shard => Object.keys(shard.payload.images).length), [24, 24, 24, 1]);
  for (const shard of photos.shards) {
    assert.equal(shard.eligibleUntil, deadline);
    assert.equal(validatePhotoShard(shard.payload, photos.index.version, at).eligibleUntil, deadline);
    assert.throws(() => validatePhotoShard(shard.payload, photos.index.version, Date.parse(deadline)), /unavailable/);
  }
  assert.equal(JSON.stringify(input), bytes);
  const baseOnly = catalogDisplayView(input);
  assert.equal(createPhotoRelease(baseOnly).indexPath, null);
  assert.equal(createPhotoRelease(baseOnly).shards.length, 0);
});

test('photo validation fails closed across release drift, unavailable fallback and malformed fields', () => {
  const photos = createPhotoRelease(snapshot(1)), shard = photos.shards[0].payload;
  for (const value of [{ status: 'unavailable' }, { ...shard, version: '0'.repeat(64) }, { ...shard, eligibleUntil: null },
    { ...shard, privateRights: {} }, { ...shard, images: { 'fixture-0': { imageUrl: 'javascript:alert(1)', eligibleUntil: deadline } } }])
    assert.throws(() => validatePhotoShard(value, photos.index.version, at));
  assert.throws(() => validatePhotoIndex({ ...photos.index, products: { bad: { shard: '../private', eligibleUntil: deadline } } }, photos.index.version));
  assert.throws(() => photoVersion('https://example.invalid/catalog/' + photos.index.version + '/photos.json'));
});

test('one expired photo cannot disable a different freshly refreshed photo',()=>{
  const input=structuredClone(snapshot(2)),fresh=new Date(at+2*86400000).toISOString();input.products[1].eligibleUntil=fresh;
  const photos=createPhotoRelease(input),old=photos.index.products[input.products[0].id],current=photos.index.products[input.products[1].id];
  assert.notEqual(old.shard,current.shard);assert.equal(photos.shards.length,2);
  assert.equal(validatePhotoIndex(photos.index,photos.index.version).products[input.products[1].id].eligibleUntil,fresh);
  assert.throws(()=>validatePhotoShard(photos.shards[old.shard-1].payload,photos.index.version,Date.parse(deadline)),/unavailable/);
  assert.equal(validatePhotoShard(photos.shards[current.shard-1].payload,photos.index.version,Date.parse(deadline)).eligibleUntil,fresh);
});

test('only photo JSON expires; full rendered page/HTML/RSC policies remain permanent and nonindexable short copy stays noindex', () => {
  const input = snapshot(1), view = catalogDisplayView(input), photos = createPhotoRelease(input), browse = createBrowseRelease(view);
  const og = createOgRelease(view, siteIdentity);
  const pages = ['/', '/random-gift', '/gift-guides', '/howie', '/preview/presentation',
    ...giftGuides.map(g => `/gift-guides/${g.slug}`), ...view.products.map(p => `/gifts/${p.slug}`)];
  const assets = [...pages.flatMap(p => p === '/' ? ['/index.html', '/index.txt'] : [`${p}.html`, `${p}.txt`]),
    ...og.byPath.keys(), ...browse.shards.map(s => s.path), photos.indexPath, ...photos.shards.map(s => s.path),
    '/safe/catalog.html', '/safe/catalog.txt', '/safe/catalog.json', '/safe/product.html', '/safe/product.txt',
    '/safe/howie.html', '/safe/howie.txt', '/safe/presentation.html', '/safe/presentation.txt', '/safe/photos.json'];
  const routes = createStaticRoutes(input, assets);
  for (const p of ['/', '/index.txt', '/gifts/original-fictional-object-0', '/gifts/original-fictional-object-0.txt'])
    assert.equal(routes[p].eligibleUntil, null, p);
  assert.equal(routes['/gifts/original-fictional-object-0'].indexable, false);
  assert.equal(routes[photos.indexPath].eligibleUntil, null);
  assert.equal(routes[photos.shards[0].path].eligibleUntil, deadline);
  assert.equal(routes[photos.shards[0].path].safeAssetPath, '/safe/photos.json');
});

test('Cloudflare Free asset capacity is enforced before publication, without a paid fallback', () => {
  const assets = new Map(Array.from({ length: CLOUDFLARE_ASSET_LIMIT }, (_, i) => [`/owned-${i}.js`, new Uint8Array()]));
  assert.doesNotThrow(() => assertStaticAssetCapacity(assets));
  assets.set('/one-too-many.js', new Uint8Array());
  assert.throws(() => assertStaticAssetCapacity(assets), /Cloudflare Workers Paid asset limit/);
});

test('actual large persistent static export fits Free, preserves all routes and isolates supplier photos', {
  skip: !process.env.RUN_PERSISTENT_CATALOG_BUILD,
}, () => {
  const count = Number(process.env.RUN_PERSISTENT_CATALOG_BUILD);
  assert.ok(Number.isInteger(count) && count >= 73 && count <= 3383);
  const root = new URL('../', import.meta.url), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'stupid-persistent-export-'));
  try {
    const input = snapshot(count), snapshotBytes = `${JSON.stringify(input)}\n`;
    const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const context = { schemaVersion: 1, releaseId: `persistent-fixture-${count}-${Date.now()}`, codeSha,
      sourceMode: 'preview', catalogRevision: input.catalogRevision,
      catalogSnapshotSha256: createHash('sha256').update(snapshotBytes).digest('hex'),
      generatedAt: new Date().toISOString(), vectorSyncWatermark: 0, priorReleaseId: null, retainedManifestSha256: null };
    const inputPath = path.join(temp, 'snapshot.json'), contextPath = path.join(temp, 'context.json');
    fs.writeFileSync(inputPath, snapshotBytes, { mode: 0o600 });
    fs.writeFileSync(contextPath, JSON.stringify(context), { mode: 0o600 });
    const env = { HOME: process.env.HOME, PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
      TMPDIR: temp, NEXT_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '--max-old-space-size=8192',
      CATALOG_SNAPSHOT_PATH: inputPath, CATALOG_RELEASE_CONTEXT_PATH: contextPath };
    for (const script of ['build', 'verify-release']) execFileSync(process.execPath,
      ['--import', 'tsx', `scripts/staging/${script}.mts`], { cwd: root, env, stdio: 'inherit' });
    const output = new URL('../static-site/out/', import.meta.url);
    const files = fs.readdirSync(output, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile());
    assert.ok(files.length <= CLOUDFLARE_ASSET_LIMIT);
    assert.equal(files.filter(entry => entry.parentPath === path.join(output.pathname, 'gifts')
      && /^original-fictional-object-\d+\.html$/.test(entry.name)).length, count);
    let photoShards = 0;
    for (const entry of files) {
      if (!/\.(?:html|txt|json|js|css|svg|xml)$/.test(entry.name)) continue;
      const body = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
      assert.doesNotMatch(body, /\b(?:cameron|ehrlich|cameronehrlich)\b|\b(?:cam|cameron)@37\.technology\b/i);
      if (/^photos-\d+\.json$/.test(entry.name)) { photoShards++; continue; }
      assert.doesNotMatch(body, /Supplier title|supplier-photo/);
    }
    assert.equal(photoShards, Math.ceil(count / 24));
    console.log(JSON.stringify({ staticExportVerified: true, syntheticProducts: count,
      assets: files.length, photoShards, supplierLeakOutsideGuardedPhotos: 0, ownerIdentityLeaks: 0 }));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
