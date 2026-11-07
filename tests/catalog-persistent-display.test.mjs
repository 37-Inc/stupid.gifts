import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogSnapshot, createPersistentCatalogProduct, publicProductRightsExpiry,
  validateCatalogSnapshot, validatePublicCatalogProduct } from '../lib/catalog/snapshot.ts';
import { catalogDeadline, earliestCatalogExpiry, catalogDisplayView, resolvePublicProduct } from '../lib/catalog/display.ts';

const now = new Date('2026-10-19T12:00:00.000Z');
const editorial = `${'This explicitly synthetic editorial tests a fictional gift, without any current merchant claim. '.repeat(9)}\n\n${'It is original fixture copy, not a real offer, photo, availability report or endorsement. '.repeat(9)}`;
function product(overrides = {}) {
  return { id: 'TEST-FIXTURE-1', publicId: '00000000-0000-4000-8000-000000000001', slug: 'fictional-test-gift',
    title: 'Synthetic supplier title', description: 'Synthetic supplier description', imageUrl: 'https://example.invalid/photo.jpg',
    affiliateUrl: 'https://example.invalid/fixture', source: 'amazon', currency: 'USD', price: 0,
    qualityScore: .9, isActive: true, availabilityCheckedAt: now.toISOString(), availabilityStatus: 'IN_STOCK',
    editorialStatus: 'manual_locked', editorialQualityScore: .9, editorialWriteup: editorial,
    sourceFactsHash: 'same', editorialSourceHash: 'same', ...overrides };
}
function rights(p) {
  return Object.fromEntries(['title', 'description', 'imageUrl', 'affiliateUrl', 'editorialWriteup'].filter(f => p[f])
    .map(field => [field, { basis: 'owned', value: p[field], reference: 'Original synthetic fixture, not a real rights claim' }]));
}
function base(overrides = {}) {
  const p = product({ title: 'Fictional Test Gift', description: 'Original fixture description', imageUrl: '/images/gift-placeholder.svg',
    editorialStatus: 'pending', editorialWriteup: undefined, availabilityStatus: 'UNKNOWN', ...overrides });
  return { product: p, rights: rights(p) };
}
function fresh() {
  const p = product(), permission = rights(p), persistent = base();
  permission.imageUrl = { ...permission.imageUrl, basis: 'merchant', observedAt: now.toISOString(), expiresAt: '2026-10-19T13:00:00.000Z' };
  const snapshot = createCatalogSnapshot([p], { [p.id]: permission }, { now, catalogRevision: 'persistent-test',
    dataKind: 'synthetic_fixture', persistentById: { [p.id]: persistent } });
  return { snapshot, permission: { ...permission, persistent: persistent.rights } };
}

test('an independently cleared base does not claim a current offer or require recent merchant verification', () => {
  const p = createPersistentCatalogProduct(base({ availabilityCheckedAt: '2020-01-01T00:00:00.000Z' }), now, true);
  assert.equal(p.eligibleUntil, null);
  assert.equal(p.indexable, false);
  assert.equal(p.price, 0);
  assert.equal('availabilityStatus' in p, false);
  assert.equal(resolvePublicProduct(p, new Date('2100-01-01T00:00:00.000Z')), p);
  assert.equal(publicProductRightsExpiry(p, base().rights, now), Infinity);
});

test('supplier expiry resolves to exact persistent content without changing sealed bytes or catalog identity', () => {
  const { snapshot, permission } = fresh(), p = snapshot.products[0], bytes = JSON.stringify(snapshot);
  assert.equal(p.eligibleUntil, '2026-10-19T13:00:00.000Z');
  assert.equal(resolvePublicProduct(p, now), p);
  const at = new Date('2026-12-01T00:00:00.000Z'), fallback = resolvePublicProduct(p, at);
  assert.equal(fallback, p.persistent);
  for (const field of ['id', 'publicId', 'slug', 'source', 'currency']) assert.equal(fallback[field], p[field]);
  assert.equal(fallback.eligibleUntil, null);
  assert.equal(fallback.title, 'Fictional Test Gift');
  assert.equal(JSON.stringify(fallback).includes('Synthetic supplier'), false);
  assert.equal(JSON.stringify(fallback).includes('photo.jpg'), false);
  assert.deepEqual(validateCatalogSnapshot(snapshot, at), snapshot);
  assert.equal(JSON.stringify(snapshot), bytes);
  assert.equal(publicProductRightsExpiry(p, permission, now), Date.parse(p.eligibleUntil));
  assert.equal(publicProductRightsExpiry(p, { ...permission, persistent: {} }, now), null);
});

test('a new snapshot emits the cleared base directly after supplier and 35-day deadlines', () => {
  const p = product(), persistent = base(), at = new Date('2027-01-01T00:00:00.000Z');
  const result = createCatalogSnapshot([p], { [p.id]: {} }, { now: at, catalogRevision: 'base-only', dataKind: 'synthetic_fixture',
    persistentById: { [p.id]: persistent } });
  assert.equal(result.products.length, 1);
  assert.equal(result.heldProducts.length, 0);
  assert.equal(result.products[0].eligibleUntil, null);
  assert.equal(result.products[0].indexable, false);
  assert.equal('persistent' in result.products[0], false);
});

test('permanent display requires exact nonexpiring nonmerchant grants for every displayed field', () => {
  for (const change of [r => delete r.title, r => r.description.value = 'different', r => r.imageUrl.reference = ' ',
    r => r.title.basis = 'merchant', r => r.affiliateUrl.expiresAt = '2027-01-01T00:00:00.000Z']) {
    const input = base(); change(input.rights);
    assert.equal(createPersistentCatalogProduct(input, now, true), null);
  }
  const input = base({ wittyDescription: 'Unproven optional copy', humorTags: ['unproven'] });
  const p = createPersistentCatalogProduct(input, now, true);
  assert.equal('wittyDescription' in p, false);
  assert.equal('humorTags' in p, false);
});

test('permanent clearance never overrides explicit curation holds, duplicates or invalid ranking metadata', () => {
  for (const override of [{ isActive: false }, { duplicateOfProductId: 'other' }, { qualityScore: -.1 }, { qualityScore: 1.1 },
    { editorialStatus: 'blocked' }, { editorialStatus: 'needs_review' }]) {
    assert.equal(createPersistentCatalogProduct(base(override), now, true), null);
  }
});

test('only substantive reviewed exact copy makes a persistent page indexable, not a pending label', () => {
  const p = createPersistentCatalogProduct(base({ editorialStatus: 'manual_locked', editorialWriteup: editorial }), now, true);
  assert.equal(p.indexable, true);
  assert.equal(p.editorialWriteup, editorial);
  const input = base({ editorialStatus: 'manual_locked', editorialWriteup: editorial }); delete input.rights.editorialWriteup;
  assert.equal(createPersistentCatalogProduct(input, now, true).indexable, false);
  assert.equal(createPersistentCatalogProduct(base({ editorialStatus: 'manual_locked', editorialWriteup: editorial, editorialSourceHash: 'mismatch' }), now, true).indexable, false);
});

test('fallbacks reject altered identity, nested grants, unsafe images and sentinel dates', () => {
  const { snapshot } = fresh(), p = JSON.parse(JSON.stringify(snapshot.products[0]));
  for (const patch of [{ id: 'wrong' }, { source: 'etsy' }, { slug: 'wrong' }, { currency: 'EUR' },
    { eligibleUntil: '2999-01-01T00:00:00.000Z' }, { imageUrl: 'http://example.invalid/photo.svg' },
    { imageUrl: '/../private.svg' }, { persistent: {} }]) {
    assert.throws(() => validatePublicCatalogProduct({ ...p, persistent: { ...p.persistent, ...patch } }, now, true));
  }
  assert.throws(() => createCatalogSnapshot([product()], {}, { now, catalogRevision: 'bad', dataKind: 'synthetic_fixture',
    persistentById: { 'TEST-FIXTURE-1': base({ publicId: '00000000-0000-4000-8000-000000000099' }) } }), /identity/);
});

test('legacy rights and sealed DTOs do not silently gain permanence', () => {
  const p = product(), result = createCatalogSnapshot([p], { [p.id]: rights(p) }, { now,
    catalogRevision: 'legacy', dataKind: 'synthetic_fixture' });
  assert.equal('persistent' in result.products[0], false);
  assert.equal(resolvePublicProduct(result.products[0], new Date('2027-01-01T00:00:00.000Z')), null);
  assert.throws(() => validateCatalogSnapshot(result, new Date('2027-01-01T00:00:00.000Z')), /expired/);
  assert.equal(result.products[0].eligibleUntil, '2026-11-23T12:00:00.000Z');
});

test('expiry and build-view helpers ignore only explicit null and do not mutate the source snapshot', () => {
  const { snapshot } = fresh(), bytes = JSON.stringify(snapshot), p = snapshot.products[0];
  assert.equal(earliestCatalogExpiry([p.persistent, p]), p.eligibleUntil);
  assert.equal(earliestCatalogExpiry([p.persistent]), null);
  assert.equal(catalogDeadline(null), Infinity);
  assert.deepEqual(catalogDisplayView(snapshot).products[0], p.persistent);
  assert.equal(JSON.stringify(snapshot), bytes);
});

test('composition preserves authoritative curation even when a separate clearance input disagrees', () => {
  for (const override of [{ qualityScore: -.1 }, { editorialStatus: 'blocked' }, { editorialStatus: 'needs_review' },
    { isActive: false }, { duplicateOfProductId: 'other' }]) {
    const p = product(override);
    const result = createCatalogSnapshot([p], {}, { now, catalogRevision: 'holds', dataKind: 'synthetic_fixture',
      persistentById: { [p.id]: base() } });
    assert.equal(result.products.length, 0);
    assert.equal(result.heldProducts.length, 1);
  }
  const p = product({ qualityScore: .7, editorialWriteup: undefined });
  const result = createCatalogSnapshot([p], {}, { now, catalogRevision: 'curation', dataKind: 'synthetic_fixture',
    persistentById: { [p.id]: base({ editorialWriteup: editorial, editorialStatus: 'manual_locked' }) } });
  assert.equal(result.products[0].qualityScore, .7);
  assert.equal(result.products[0].indexable, false);
});

test('the rendering view preserves legacy identities and slug history instead of dropping listings', () => {
  const p = product();
  const result = createCatalogSnapshot([p], { [p.id]: rights(p) }, { now, catalogRevision: 'legacy-view',
    dataKind: 'synthetic_fixture', slugHistory: [{ slug: 'old-gift', canonicalSlug: p.slug, publicId: p.publicId }] });
  assert.deepEqual(catalogDisplayView(result), result);
  assert.deepEqual(validateCatalogSnapshot(catalogDisplayView(result), now), result);
});

test('serialized permanent indexable listings cannot omit substantive editorial', () => {
  const p = createPersistentCatalogProduct(base(), now, true);
  for (const editorialWriteup of [undefined, 'Too short', 'A single paragraph '.repeat(100)]) {
    assert.throws(() => validatePublicCatalogProduct({ ...p, indexable: true,
      ...(editorialWriteup ? { editorialWriteup } : {}) }, now, true), /persistent editorial/);
  }
});
