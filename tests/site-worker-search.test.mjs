import assert from 'node:assert/strict';
import test from 'node:test';
import { createSearchHandler, EMBEDDING_DIMENSIONS, openAIEmbedding } from '../workers/site/search.ts';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const product = (id = 'one', overrides = {}) => ({ id, publicId: `public-${id}`, slug: id, title: 'Funny Fart Button', description: 'A ridiculous gift.', imageUrl: '/brand/button.svg', affiliateUrl: 'https://www.amazon.com/dp/B123456789?tag=test-20', source: 'amazon', currency: 'USD', price: 0, isActive: true, qualityScore: 0.8, eligibleUntil: new Date(NOW + 600_000).toISOString(), ...overrides });

function setup(options = {}) {
  let clock = NOW;
  const calls = { embed: 0, vector: [], ids: [], keyword: [], diagnostics: [] };
  const storage = {
    async byPublicIds(ids, now, revision) { assert.equal(revision, 'revision-1'); calls.ids.push(ids); return [product()]; },
    async keyword(query, limit, now, revision) { assert.equal(revision, 'revision-1'); calls.keyword.push({ query, limit }); return [product('keyword')]; },
    ...options.storage,
  };
  const env = { ENVIRONMENT: 'staging', SEMANTIC_SEARCH_ENABLED: 'true', SEMANTIC_SEARCH_DAILY_REQUEST_CAP: '100', SEMANTIC_SEARCH_DAILY_TOKEN_CAP: '100000', VECTORIZE: { async query(vector, parameters) { calls.vector.push(parameters); return { matches: [{ id: 'public-one', score: 0.9 }] }; } } };
  const handler = createSearchHandler({ catalogRevision: 'revision-1', now: () => clock, providerTimeoutMs: 30, semanticBudgetScope: { environment: 'staging', index: 'synthetic-shared-index' },
    adapters: { storage: () => storage, async reserveSemantic() { return true; }, async embed() { calls.embed++; return Array(EMBEDDING_DIMENSIONS).fill(0.1); }, async diagnostic(record) { calls.diagnostics.push(record); }, ...options.adapters },
    ...options.handler,
  });
  return { env, calls, advance(ms) { clock += ms; }, request: (query = 'funny button', extra = '') => handler(new Request(`https://example.test/api/search-products?q=${encodeURIComponent(query)}${extra}`, { headers: { 'CF-Connecting-IP': '192.0.2.1' } }), env), handler };
}

test('permanent keyword results/cache preserve identities without supplier bytes or provider calls',async()=>{
  const base=product('cleared',{title:'Independent desk object',eligibleUntil:null,indexable:false});
  const outer={...base,title:'SUPPLIER ONLY TITLE',imageUrl:'https://example.invalid/supplier.jpg',eligibleUntil:new Date(NOW+1).toISOString(),persistent:base};
  let reads=0;
  const f=setup({storage:{async keyword(){reads++;return[outer];}}});f.env.SEMANTIC_SEARCH_ENABLED='false';
  const before=await(await f.request('desk object')).json();f.advance(60_000);
  const after=await(await f.request('desk object')).json();
  assert.equal(reads,1);assert.equal(f.calls.embed,0);assert.equal(f.calls.vector.length,0);
  assert.equal(after.searchId,null);assert.deepEqual(after.results,before.results);assert.equal(after.results[0].id,base.id);
  assert.doesNotMatch(JSON.stringify(after),/SUPPLIER|supplier\.jpg|persistent/);
});
test('both hybrid lanes display source-bound reviewed names and preserve descriptions and identity',async()=>{
  const p=product('one',{title:'Funny Fart Button ...',eligibleUntil:null});
  const f=setup({storage:{async byPublicIds(){return[p];},async keyword(){return[p];}},handler:{merchandising:{one:{
    sourceTitle:p.title,sourceDescription:p.description,displayTitle:'Fart sound button'}}}});
  const result=(await(await f.request('fart button')).json()).results[0];
  assert.equal(result.title,'Fart sound button');assert.equal(result.description,p.description);assert.equal(result.id,p.id);
  assert.equal(f.calls.embed,1);
});

test('keyword results preserve adapter relevance instead of re-sorting by optimistic copy and quality',async()=>{
  const f=setup({storage:{async keyword(){return[
    product('best',{title:'Funny BBQ Apron',humorTags:['dad','grill'],qualityScore:.6}),
    product('weak',{title:'Funny Birthday Gift',punnyTitle:'dad who loves grilling',qualityScore:1}),
  ];}}});f.env.SEMANTIC_SEARCH_ENABLED='false';
  const body=await(await f.request('dad who loves grilling')).json();
  assert.deepEqual(body.results.map(p=>p.id),['best','weak']);assert.equal(f.calls.embed,0);
});
test('a persistent listing never extends cached semantic proof beyond original native eligibility',async()=>{
  const base=product('one',{title:'Independent desk object',eligibleUntil:null,indexable:false});
  const outer={...base,eligibleUntil:new Date(NOW+5).toISOString(),persistent:base};
  const f=setup({storage:{async byPublicIds(){return[outer];},async keyword(){return[base];}}});
  assert.equal((await(await f.request('desk object')).json()).results[0].matchType,'semantic');f.advance(6);
  const after=await(await f.request('desk object')).json();assert.equal(after.results[0].matchType,'keyword');
  assert.equal(f.calls.embed,2);assert.equal(after.results[0].eligibleUntil,null);
});

test('semantic response retains contract, rank score, provider and candidate bounds', async () => {
  const fixture = setup();
  const response = await fixture.request('funny button', '&limit=999');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(typeof body.searchId, 'string');
  assert.equal(body.results[0].matchType, 'semantic');
  assert.equal(body.results[0].rankScore, 1/61);
  assert.deepEqual(fixture.calls.vector[0], { topK: 100, returnValues: false, returnMetadata: 'none', filter: { catalogRevision: 'revision-1', eligible: true } });
  assert.ok(fixture.calls.keyword[0].limit + fixture.calls.ids[0].length <= 240);
  assert.ok(body.results.length <= 60);
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  const diagnostic = fixture.calls.diagnostics[0];
  assert.match(diagnostic.queryHash, /^[0-9a-f]{64}$/);
  assert.equal(diagnostic.queryLength, 12);
  assert.equal(diagnostic.outcome, 'ok');
  assert.doesNotMatch(JSON.stringify(diagnostic), /funny button|192\.0\.2\.1/);
});

test('query input and methods are bounded; rate estimates never reject legitimate searches', async () => {
  const fixture = setup({ handler: { rateLimit: 2 } });
  assert.deepEqual(await (await fixture.request('x')).json(), { results: [], searchId: null });
  assert.equal((await fixture.request('x'.repeat(201))).status, 400);
  assert.equal((await fixture.request('🔥'.repeat(1000))).status, 413);
  assert.equal(fixture.calls.embed, 0);
  assert.equal((await fixture.handler(new Request('https://example.test/api/search-products', { method: 'POST', body: '{}' }), fixture.env)).status, 405);
  assert.equal((await fixture.request('fart')).status, 200);
  assert.equal((await fixture.request('crab')).status, 200);
  assert.equal((await fixture.request('goat')).status, 200);
  fixture.advance(60_000);
  assert.equal((await fixture.request('goat')).status, 200);
});

test('more than256 distinct clients can search without a visitor admission cutoff',async()=>{
  const f=setup();
  for(let i=0;i<270;i++)assert.equal((await f.handler(new Request('https://example.test/api/search-products?q=goat',{
    headers:{'CF-Connecting-IP':`192.0.${Math.floor(i/256)}.${i%256}`}}),f.env)).status,200);
  assert.equal(f.calls.embed,1,'cached results remain available across clients');
});

test('normalized cache is short, revision/model scoped and kill switch bypasses semantic cache', async () => {
  const fixture = setup();
  await fixture.request('Funny Button');
  const cached = await (await fixture.request('  funny   button  ')).json();
  assert.equal(cached.searchId, null);
  assert.equal(fixture.calls.embed, 1);
  fixture.env.SEMANTIC_SEARCH_ENABLED = 'false';
  const fallback = await (await fixture.request('funny button')).json();
  assert.equal(fallback.results[0].matchType, 'keyword');
  assert.equal(fixture.calls.embed, 1);
  fixture.env.SEMANTIC_SEARCH_ENABLED = 'true';
  fixture.advance(300_001);
  await fixture.request('funny button');
  assert.equal(fixture.calls.embed, 2);
});

test('eligibility, quality, expiry and family dedup remain final after vector lookup', async () => {
  const fixture = setup({ storage: {
    async byPublicIds() { return [product()]; },
    async keyword() { return [
      product('expired', { eligibleUntil: new Date(NOW - 1).toISOString() }),
      product('low', { qualityScore: 0.3 }), product('inactive', { isActive: false }),
      product('generic', { title: 'Generic Bath Bomb Gift Basket' }),
      product('duplicate', { title: 'Funny Fart Button Red' }),
      product('crab', { title: 'Red Crab Silicone Spoon Rest' }),
    ]; },
  } });
  assert.deepEqual((await (await fixture.request()).json()).results.map((value) => value.id), ['one', 'crab']);
});

test('cached results never survive product eligibility expiry', async () => {
  const fixture = setup({ storage: {
    async byPublicIds() { return [product('one', { eligibleUntil: new Date(NOW + 100).toISOString() })]; },
    async keyword() { return []; },
  } });
  assert.equal((await (await fixture.request()).json()).results.length, 1);
  fixture.advance(100);
  assert.equal((await (await fixture.request()).json()).results.length, 0);
  assert.equal(fixture.calls.embed, 2);
});

test('cache hits recheck expiry after asynchronous request hashing', async () => {
  let clock = NOW;
  let crossDeadline = false;
  const fixture = setup({ storage: {
    async byPublicIds() { return [product('one', { eligibleUntil: new Date(NOW + 100).toISOString() })]; },
    async keyword() { return []; },
  }, handler: { now() {
    const captured = clock;
    if (crossDeadline) {
      crossDeadline = false;
      queueMicrotask(() => { clock = NOW + 100; });
    }
    return captured;
  } } });
  assert.equal((await (await fixture.request()).json()).results.length, 1);
  clock = NOW + 99;
  crossDeadline = true;
  const body = await (await fixture.request()).json();
  assert.equal(clock, NOW + 100);
  assert.deepEqual(body.results, []);
});

test('uncached responses recheck expiry after asynchronous diagnostics', async () => {
  const fixture = setup({ storage: {
    async byPublicIds() { return [product('one', { eligibleUntil: new Date(NOW + 100).toISOString() })]; },
    async keyword() { return []; },
  }, adapters: { async diagnostic() { fixture.advance(100); } } });
  const body = await (await fixture.request()).json();
  assert.equal(fixture.calls.embed, 1);
  assert.deepEqual(body.results, []);
});

test('embedding failure, timeout and invalid dimensions fall back without logging raw errors', async () => {
  for (const embed of [async () => { throw new Error('raw query and secret must not log'); }, async () => new Promise(() => {}), async () => [1, 2]]) {
    const fixture = setup({ adapters: { embed } });
    const response = await fixture.request();
    assert.equal(response.status, 200);
    assert.equal((await response.json()).results[0].matchType, 'keyword');
    assert.equal(fixture.calls.vector.length, 0);
  }
});

test('diagnostic failure cannot fail search; storage failure returns safe 503', async () => {
  const fixture = setup({ adapters: { async diagnostic() { throw new Error('private'); } } });
  assert.equal((await (await fixture.request()).json()).searchId, null);
  const broken = setup({ storage: { async keyword() { throw new Error('private DB url'); } } });
  broken.env.SEMANTIC_SEARCH_ENABLED = 'false';
  const response = await broken.request();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Search unavailable' });
});
test('acknowledged vectors do not disguise failure of both current-product lookup lanes as zero results', async () => {
  const broken = setup({ storage: {
    async keyword() { throw new Error('private keyword failure'); },
    async byPublicIds() { throw new Error('private current-product failure'); },
  } });
  const response = await broken.request();
  assert.equal(broken.calls.vector.length, 1);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Search unavailable' });
});

test('disabled or absent semantic binding makes no paid call', async () => {
  const fixture = setup();
  delete fixture.env.VECTORIZE;
  assert.equal((await (await fixture.request()).json()).results[0].matchType, 'keyword');
  assert.equal(fixture.calls.embed, 0);
});

test('legacy invalid ANN candidates cannot starve limit1 lexical fallback or exceed combined lookup bounds',async()=>{
  const f=setup({storage:{async byPublicIds(){return[];}}});
  f.env.VECTORIZE.query=async()=>({matches:Array.from({length:100},(_,i)=>({id:`unknown-${i}`,score:.9}))});
  const body=await(await f.request('funny button','&limit=1')).json();
  assert.equal(body.results[0].matchType,'keyword');assert.equal(f.calls.keyword[0].limit,1);
  assert.ok(f.calls.keyword[0].limit+4<=240);
});

test('keyword overfetch is capped at 240 and public results at 60', async () => {
  const fixture = setup({ storage: { async keyword(query, limit) {
    assert.equal(limit, 240);
    return Array.from({ length: 300 }, (_, index) => product(`gift-${index}`, {
      title: `Funny Gadget ${String.fromCharCode(97 + Math.floor(index / 26), 97 + index % 26)}`,
    }));
  } } });
  fixture.env.SEMANTIC_SEARCH_ENABLED = 'false';
  const body = await (await fixture.request('funny', '&limit=60')).json();
  assert.equal(body.results.length, 60);
  assert.equal(fixture.calls.embed, 0);
});

test('OpenAI adapter pins model, float format, dimensions and abort signal', async (t) => {
  const controller = new AbortController();
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/embeddings');
    assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), { model: 'text-embedding-3-small', input: 'funny button', encoding_format: 'float' });
    return Response.json({ data: [{ embedding: Array(1536).fill(0.1) }] });
  });
  assert.equal((await openAIEmbedding('funny button', { OPENAI_API_KEY: 'fake-test-only' }, controller.signal)).length, 1536);
});
