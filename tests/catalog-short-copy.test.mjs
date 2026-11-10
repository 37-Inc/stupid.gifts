import assert from 'node:assert/strict';
import test from 'node:test';
import amazonCreators from '../lib/amazon-creators.js';
import { enrichProducts, executeCatalog, parseArgs } from '../scripts/ops/prefetch-catalog.mjs';
import { createUsageLedger } from '../scripts/ops/catalog-telemetry.mjs';
import { editorialSourceHash, hasCurrentApprovedCopy, resolveShortDescriptionAttempt,
  validateEditorialDraft, validateShortDescription } from '../scripts/ops/catalog-editorial-core.mjs';

const short = 'A brass lobster desk bell for a small tabletop.';
const product = (n = 1, title = 'Funny novelty brass lobster desk bell') => ({
  id: `B${String(n).padStart(9, '0')}`, title, price: 12, currency: 'USD', imageUrl: 'https://example.invalid/object.jpg',
  affiliateUrl: `https://www.amazon.com/dp/B${String(n).padStart(9, '0')}?tag=fixture-20`, source: 'amazon',
  sourceQuery: 'novelty desk objects', humorTags: ['desk', 'novelty'], qualityScore: .9, isActive: true,
  availabilityStatus: 'IN_STOCK', sourceFacts: { material: 'brass', shape: 'lobster' },
});
const article = Array(2).fill(Array(15).fill('Synthetic brass lobster novelty desk bell fixture editorial.').join(' ')).join('\n\n');
const ledger = () => ({ runId: 'test-only', usage: createUsageLedger(), warnings: [], timingsMs: {},
  items: { record() {}, async flush() {} } });
let mockClient = 0;

function mockModels(t, { reject = false, rejectIds = [], long = false, draftVeto = false, expectedModel = 'gpt-6-luna' } = {}) {
  const calls = { drafted: [], reviewed: [], embedded: [] };
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = `TEST_ONLY_SHORT_COPY_${++mockClient}`;
  t.after(() => { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.ok(String(url).startsWith('https://api.openai.com/v1/'));
    const body = JSON.parse(init.body);
    if (String(url).endsWith('/embeddings')) {
      assert.equal(body.model, 'text-embedding-3-small');
      calls.embedded.push(...body.input);
      return Response.json({ data: body.input.map((_, index) => ({ index, embedding: [1, 2, 3] })), usage: {} });
    }
    assert.equal(body.model, expectedModel);
    if (expectedModel === 'gpt-6-luna') {
      assert.equal(body.reasoning_effort, 'none');
      assert.ok(body.max_completion_tokens >= 500);
      assert.equal('max_tokens' in body, false);
    } else {
      assert.ok(body.max_tokens >= 500);
      assert.equal('reasoning_effort' in body, false);
    }
    const reviewing = body.messages[0].content.includes('skeptical');
    const inputs = JSON.parse(body.messages[1].content.split(reviewing ? 'Drafts:\n' : 'Products:\n')[1]);
    (reviewing ? calls.reviewed : calls.drafted).push(...inputs.map(p => p.id));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ products: inputs.map(p => reviewing
      ? { id: p.id, approved: !reject && !rejectIds.includes(p.id), qualityScore: .95,
        reasons: reject || rejectIds.includes(p.id) ? ['unsupported capability'] : [], correctedDescription: null, correctedEditorial: null }
      : { id: p.id, shortTitle: p.title, shortDescription: short, editorialWriteup: long ? article : undefined,
        qualityScore: draftVeto ? .1 : .9, isActive: !draftVeto }) }) } }], usage: {} });
  });
  return calls;
}

test('short readiness is a separate factual validator, not a weakened article gate', () => {
  const p = product();
  assert.equal(validateShortDescription(p, short).approved, true);
  assert.equal(validateEditorialDraft(p, short).approved, false);
  for (const text of ['Great gift!', 'The perfect gift for anyone who likes brass lobster bells.',
    'A brass lobster desk bell currently in stock for you.', `${short}\nAnother sentence.`])
    assert.equal(validateShortDescription(p, text).approved, false);
  const accepted = resolveShortDescriptionAttempt(p, { draftDescription: short, review: { approved: true }, reviewQuality: .9 });
  assert.equal(accepted.editorialStatus, 'short_ready');
  assert.equal(accepted.editorialWriteup, undefined);
  assert.equal(hasCurrentApprovedCopy({ ...p, ...accepted }), true);
  assert.equal(hasCurrentApprovedCopy({ ...p, ...accepted, editorialQualityScore: undefined }), false);
});

test('default enrichment creates reviewed short copy and no article', async t => {
  const calls = mockModels(t);
  const [after] = await enrichProducts([product()], { enrichmentBatchSize: 4 }, [], ledger());
  assert.equal(after.editorialStatus, 'short_ready');
  assert.equal(after.wittyDescription, short);
  assert.equal(after.editorialWriteup, undefined);
  assert.equal(calls.embedded.length, 1);
  assert.equal(after.editorialPromptVersion, 'catalog-short-copy-v2-title');
  assert.equal(after.punnyTitle, product().title);
});

test('rejected descriptions never get new embeddings', async t => {
  const calls = mockModels(t, { reject: true });
  const [after] = await enrichProducts([product()], { enrichmentBatchSize: 4 }, [], ledger());
  assert.equal(after.editorialStatus, 'needs_review');
  assert.equal(calls.embedded.length, 0);
  assert.equal(after.wittyDescription, undefined);
});

test('an explicit legacy text-model override retains its compatible request shape', async t => {
  const previous = process.env.CATALOG_EDITORIAL_MODEL;
  process.env.CATALOG_EDITORIAL_MODEL = 'gpt-4o-mini';
  t.after(() => { if (previous === undefined) delete process.env.CATALOG_EDITORIAL_MODEL; else process.env.CATALOG_EDITORIAL_MODEL = previous; });
  const calls = mockModels(t, { expectedModel: 'gpt-4o-mini' });
  const [after] = await enrichProducts([product()], { enrichmentBatchSize: 4 }, [], ledger());
  assert.equal(after.editorialStatus, 'short_ready');
  assert.equal(calls.drafted.length, 1);
  assert.equal(calls.reviewed.length, 1);
});

test('one rejected draft cannot consume an embedding alongside an accepted draft', async t => {
  const rejected = product(2), calls = mockModels(t, { rejectIds: [rejected.id] }), embeddedIds = [];
  const results = await enrichProducts([product(), rejected], { enrichmentBatchSize: 4 }, [], ledger(), {
    async embeddings({ products }) { embeddedIds.push(...products.map(p => p.id)); },
  });
  assert.deepEqual(results.map(p => p.editorialStatus), ['short_ready', 'needs_review']);
  assert.deepEqual(embeddedIds, [product().id]);
  assert.equal(calls.embedded.length, 1);
});

test('unchanged approved short copy, existing articles and manual locks are not rewritten', async t => {
  const calls = mockModels(t);
  const p = product(), sourceHash = editorialSourceHash(p), vector = [9, 8, 7];
  const approved = { ...p, wittyDescription: short, editorialStatus: 'short_ready', editorialSourceHash: sourceHash, editorialQualityScore: .9, embedding: vector };
  const long = { ...product(2), editorialWriteup: article, editorialStatus: 'generated_ready', editorialSourceHash: sourceHash, editorialQualityScore: .9, embedding: vector };
  long.editorialSourceHash = editorialSourceHash(long);
  const locked = { ...long, id: 'B000000003', editorialStatus: 'manual_locked' };
  const results = await enrichProducts([approved, long, locked], { enrichmentBatchSize: 4 }, [], ledger());
  assert.deepEqual(calls, { drafted: [], reviewed: [], embedded: [] });
  assert.deepEqual(results.map(p => p.embedding), [vector, vector, vector]);
  assert.equal(results[1].editorialWriteup, article);
});

test('explicit article mode adds a long article without changing the short validator', async t => {
  const calls = mockModels(t, { long: true });
  const p = { ...product(), wittyDescription: short, editorialStatus: 'short_ready', editorialQualityScore: .9 };
  p.editorialSourceHash = editorialSourceHash(p);
  const [after] = await enrichProducts([p], { enrichmentBatchSize: 4, longEditorial: true }, [], ledger());
  assert.equal(after.editorialStatus, 'generated_ready');
  assert.equal(after.editorialWriteup, article);
  assert.equal(calls.drafted.length, 1);
});

test('a rejected optional article preserves approved short copy and its unchanged vector', async t => {
  const calls = mockModels(t, { long: true, reject: true });
  const p = { ...product(), wittyDescription: short, editorialStatus: 'short_ready', editorialQualityScore: .9, embedding: [7, 8, 9] };
  p.editorialSourceHash = editorialSourceHash(p);
  const [after] = await enrichProducts([p], { enrichmentBatchSize: 4, longEditorial: true }, [], ledger());
  assert.equal(after.editorialStatus, 'short_ready');
  assert.equal(after.wittyDescription, short);
  assert.equal(after.editorialWriteup, undefined);
  assert.deepEqual(after.embedding, p.embedding);
  assert.equal(calls.embedded.length, 0);
});

test('a draft model veto cannot deactivate or rewrite an existing listing in either copy mode', async t => {
  for (const longEditorial of [false, true]) {
    const calls = mockModels(t, { draftVeto: true, long: longEditorial });
    const old = { ...product(), editorialStatus: 'stale', editorialSourceHash: 'a'.repeat(64),
      editorialWriteup: article, wittyDescription: short, embedding: [9, 8, 7] };
    const [after] = await enrichProducts([old], { enrichmentBatchSize: 4, preserveExistingListing: true, longEditorial }, [], ledger());
    assert.equal(after.isActive, true);
    assert.equal(after.qualityScore, old.qualityScore);
    assert.equal(after.editorialStatus, 'stale');
    assert.equal(after.editorialWriteup, article);
    assert.equal(after.wittyDescription, short);
    assert.equal(after.editorialSourceHash, old.editorialSourceHash);
    assert.deepEqual(after.embedding, old.embedding);
    assert.equal(calls.embedded.length, 0);
  }
});

test('a draft model veto still blocks a genuinely new discovery', async t => {
  const calls = mockModels(t, { draftVeto: true });
  const [after] = await enrichProducts([product()], { enrichmentBatchSize: 4 }, [], ledger());
  assert.equal(after.isActive, false);
  assert.equal(after.editorialStatus, 'blocked');
  assert.equal(calls.embedded.length, 0);
});

test('rejected copy attempts do not turn an existing pending listing into a curation hold', async t => {
  for (const longEditorial of [false, true]) {
    const calls = mockModels(t, { reject: true, long: longEditorial });
    const old = { ...product(), editorialStatus: 'pending', editorialWriteup: article,
      wittyDescription: short, embedding: [9, 8, 7] };
    const [after] = await enrichProducts([old], { enrichmentBatchSize: 4, preserveExistingListing: true, longEditorial }, [], ledger());
    for (const key of ['isActive', 'qualityScore', 'editorialStatus', 'editorialWriteup', 'wittyDescription', 'editorialSourceHash'])
      assert.equal(after[key], old[key]);
    assert.deepEqual(after.embedding, old.embedding);
    assert.equal(calls.embedded.length, 0);
  }
});

test('discovery chooses at most maxNew unique candidates before any model requests', async t => {
  const calls = mockModels(t), writes = [], decisions = [];
  const items = [product(1), product(2, 'Funny potato shaped desk lamp'), product(3, 'Funny alligator silicone oven mitt')];
  t.mock.method(amazonCreators, 'searchItems', async () => [...items, items[0]]);
  const store = { async getActiveCatalogIdentities() { return []; }, async getExistingEditorialWriteups() { return []; },
    async upsertProduct(p) { writes.push(p.id); return { inserted: true, slug: `fixture-${p.id}` }; }, async recordEditorialEvent() {} };
  const telemetry = ledger(); telemetry.items.record = (p, event) => decisions.push({ id: p.id, ...event });
  const options = { ...parseArgs(['--max-new', '2', '--backfill-limit', '0', '--themes', 'test-only']), discoveryNewOnly: true };
  await executeCatalog(options, undefined, telemetry, store);
  assert.equal(new Set(calls.drafted).size, 2);
  assert.equal(writes.length, 2);
  assert.equal(calls.drafted.includes(items[2].id), false);
  assert.ok(decisions.some(d => d.id === items[2].id && d.reasonCode === 'max_new_limit' && d.decision === 'deferred'));
});

test('zero discovery admission allowance performs no model work or product persistence', async t => {
  const calls = mockModels(t);
  t.mock.method(amazonCreators, 'searchItems', async () => [product()]);
  const store = { async getActiveCatalogIdentities() { return []; },
    async getExistingEditorialWriteups() { assert.fail('No enrichment selection'); },
    async upsertProduct() { assert.fail('No product admission'); } };
  const options = { ...parseArgs(['--max-new', '0', '--backfill-limit', '0', '--themes', 'test-only']), discoveryNewOnly: true };
  const result = await executeCatalog(options, undefined, ledger(), store);
  assert.equal(result.deferredCandidates, 1);
  assert.deepEqual(calls, { drafted: [], reviewed: [], embedded: [] });
});

test('overflow and rejected replacement drafts cannot supersede an existing catalog identity', async t => {
  for (const maxNew of [0, 1]) {
    const calls = mockModels(t, { reject: true });
    t.mock.method(amazonCreators, 'searchItems', async () => [product()]);
    const existing = { ...product(99), qualityScore: .1, availabilityStatus: 'UNKNOWN' };
    const store = { async getActiveCatalogIdentities() { return [existing]; }, async getExistingEditorialWriteups() { return []; },
      async upsertProduct() { return { inserted: true, slug: 'test-only' }; }, async recordEditorialEvent() {},
      async markCatalogDuplicate() { assert.fail('No accepted replacement exists'); } };
    const options = parseArgs(['--max-new', String(maxNew), '--backfill-limit', '0', '--themes', 'test-only']);
    const result = await executeCatalog(options, undefined, ledger(), store);
    assert.equal(result.discoveryReady, 0);
    assert.equal(calls.embedded.length, 0);
  }
});
