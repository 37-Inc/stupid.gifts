import assert from 'node:assert/strict';
import test from 'node:test';
import { checkCurrent } from '../scripts/catalog/export-d1-snapshot.ts';
import { createPersistentCatalogProduct } from '../lib/catalog/snapshot.ts';

const now = new Date('2026-10-22T12:00:00.000Z'), facts = 'a'.repeat(64);
function fixture(nested = false) {
  const input = { id: 'B000000001', publicId: '00000000-0000-4000-8000-000000000001', slug: 'original-gift',
    title: 'Original gift', description: 'Original gift', imageUrl: '/images/gift-placeholder.svg',
    affiliateUrl: 'https://www.amazon.com/dp/B000000001?tag=fixture-20', source: 'amazon', currency: 'USD',
    price: 0, isActive: true, qualityScore: .8, editorialStatus: 'pending' };
  const rights = Object.fromEntries(['title', 'description', 'imageUrl', 'affiliateUrl'].map(field => [field,
    { basis: 'owned', value: input[field], reference: `Original fixture/${field}` }]));
  const base = createPersistentCatalogProduct({ product: input, rights }, now);
  const product = nested ? { ...base, imageUrl: 'https://example.invalid/expired-merchant.jpg',
    eligibleUntil: '2020-01-01T00:00:00.000Z', persistent: base } : base;
  const current = { id: base.id, public_id: base.publicId, slug: base.slug, source: base.source,
    is_active: 1, duplicate_of_product_id: null, quality_score: base.qualityScore, editorial_status: 'pending',
    availability_status: 'UNKNOWN', source_facts_hash: facts, editorial_source_hash: null,
    availability_checked_at: 'not-an-observation', eligible_until: product.eligibleUntil,
    public_display_json: JSON.stringify(product), rights_json: JSON.stringify(nested ? { persistent: rights } : rights) };
  return { product, current, projection: { source_facts_hash: facts } };
}

test('current-row checks preserve cleared listings without renewing supplier or editorial freshness', () => {
  for (const nested of [false, true]) {
    const f = fixture(nested), bytes = JSON.stringify(f);
    assert.doesNotThrow(() => checkCurrent(f.product, f.projection, f.current, now));
    assert.equal(JSON.stringify(f), bytes);
  }
});
test('a direct base selects its original nested grants without replacing or renewing merchant root evidence',()=>{
  const f=fixture(),baseRights=JSON.parse(f.current.rights_json);
  const merchant={title:{basis:'merchant',reference:'Original supplier receipt',value:'Expired supplier title',
    observedAt:'2020-01-01T00:00:00.000Z',expiresAt:'2020-01-02T00:00:00.000Z'}};
  f.current.rights_json=JSON.stringify({...merchant,persistent:baseRights});const bytes=JSON.stringify(f);
  assert.doesNotThrow(()=>checkCurrent(f.product,f.projection,f.current,now));assert.equal(JSON.stringify(f),bytes);
  for(const persistent of [{},{...baseRights,title:{...baseRights.title,value:'Unapproved replacement'}}]){
    assert.throws(()=>checkCurrent(f.product,f.projection,{...f.current,rights_json:JSON.stringify({...merchant,persistent})},now));
  }
});
test('permanent current-row checks still reject curation, display drift and exact-grant revocation', () => {
  for (const nested of [false, true]) for (const update of [{ is_active: 0 }, { duplicate_of_product_id: 'winner' },
    { quality_score: .1 }, { editorial_status: 'blocked' }, { editorial_status: 'needs_review' },
    { rights_json: '{}' }, { public_display_json: 'null' }]) {
    const f = fixture(nested);
    assert.throws(() => checkCurrent(f.product, f.projection, { ...f.current, ...update }, now));
  }
});
test('new supplier facts alone do not revoke unchanged independently cleared base content', () => {
  for (const nested of [false, true]) {
    const f = fixture(nested);
    assert.doesNotThrow(() => checkCurrent(f.product, f.projection, { ...f.current, source_facts_hash: 'b'.repeat(64) }, now));
  }
});
