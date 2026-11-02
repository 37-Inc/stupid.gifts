import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  catalogRunItem,
  createPostgresCatalogTelemetryStore,
  createRunItemCollector,
  createUsageLedger,
  finalizeUsageLedger,
  formatCatalogRunReport,
  formatEstimatedCatalogRunCost,
  formatManualReviewQueue,
  latestRunItemStates,
  manualInterventionItems,
  mergeUsageReports,
  recordOpenAIUsage,
  redactTelemetryText,
  safeCatalogConfig,
  sanitizeTelemetryValue,
  startCatalogRun,
  finishCatalogRun,
  insertCatalogRunItems,
  loadCatalogRun,
  loadRecentCatalogRuns,
} from '../scripts/ops/catalog-telemetry.mjs';
import { splitMigrationStatements } from '../scripts/ops/apply-catalog-telemetry-migration.mjs';
import { parseArgs as parseReportArgs } from '../scripts/ops/catalog-report.mjs';

// Exact query bytes captured before the storage extraction at e082ba82.
const TELEMETRY_SQL = {
  start: '1483ff006c96d0bd53520c42e83e973496b45c2a8a9afa030f2354c132bd0a0a',
  finish: '502fd1b2d69d6d0fc40eff798ef191c12775d81fd823267ae45fc221c193ea13',
  appendOne: 'bb5b4f0bb01d9e8cedff22063c8956f0802ab0f8083059d21134b8a43ee28ac8',
  appendFifty: '0c3a9f881b7403c4e3f761cded1c9393bae0fa7f1d0b136a2232016932a34d97',
  loadRun: '15fc0f9df13e8affb7a2207bb4d0daa6a4d8d01f9513daad09ef63b5c83cdcd4',
  loadItems: '207160d91427a2897571036e9cfc3daa8f18043ca4918756bbf3939a147a3974',
  recent: 'a6e78f578601a2725debe3638d23f8077c5753abfc5e0fffa591f823b2dc16e5',
};

test('Postgres telemetry store preserves every SQL byte, parameter order and read result', async () => {
  const calls = [];
  let rows = [{ id: 'fixture-run' }];
  const store = createPostgresCatalogTelemetryStore({ query: async (text, values) => {
    calls.push({ text, values }); return { rows, rowCount: 1 };
  } });
  assert.ok(Object.isFrozen(store)); assert.equal(calls.length, 0);
  const check = (name, values, call = calls.at(-1)) => {
    assert.equal(createHash('sha256').update(call.text).digest('hex'), TELEMETRY_SQL[name], name);
    assert.deepEqual(call.values, values, name);
  };
  assert.equal(await store.startCatalogRun({ id: 'fixture-run', mode: 'weekly', trigger: 'scheduled', dryRun: true,
    gitSha: 'fixture-sha', config: { maxNew: 5, apiKey: 'not-persisted' } }), 'fixture-run');
  check('start', ['fixture-run', 'catalog-telemetry-v2', 'weekly', 'scheduled', true, 'fixture-sha', '{"maxNew":5}']);
  await store.startCatalogRun({ id: 'fixture-run', gitSha: 'fixture-sha' });
  check('start', ['fixture-run', 'catalog-telemetry-v2', 'catalog', 'manual', false, 'fixture-sha', '{}']);
  await store.finishCatalogRun('fixture-run', { status: 'partial', counts: { selected: 1, token: 'secret' },
    timingsMs: { provider: 7 }, usage: { estimatedCostUsd: .125, inputTokens: 12 },
    warnings: [{ message: 'authorization=private' }], error: new Error('password=private') });
  check('finish', ['fixture-run', 'partial', '{"selected":1,"token":"[REDACTED]"}', '{"provider":7}',
    '{"estimatedCostUsd":0.125,"inputTokens":12}', .125, '[{"message":"authorization=[REDACTED]"}]', 'password=[REDACTED]']);
  await store.finishCatalogRun('fixture-run');
  check('finish', ['fixture-run', 'completed', '{}', '{}', '{}', null, '[]', null]);
  const item = { id: 'item-1', phase: 'revalidation', stage: 'selection', decision: 'selected', reasonCode: null,
    productId: 'product-1', externalId: 'external-1', source: 'amazon', sourceQuery: 'fixture', title: 'Fixture title',
    imageUrl: 'https://example.invalid/image', affiliateUrl: 'https://example.invalid/link', canonicalPath: '/gifts/fixture',
    winnerProductId: null, sourceFactsHash: 'facts', editorialSourceHash: 'editorial', requiresManualReview: false,
    nextAction: null, details: { token: 'secret', inputTokens: 12 } };
  const values = id => [id, 'fixture-run', item.phase, item.stage, item.decision, null, item.productId,
    item.externalId, item.source, item.sourceQuery, item.title, item.imageUrl, item.affiliateUrl, item.canonicalPath,
    null, 'facts', 'editorial', false, null, '{"token":"[REDACTED]","inputTokens":12}'];
  await store.insertCatalogRunItems('fixture-run', [item]); check('appendOne', values('item-1'));
  const before = calls.length;
  await store.insertCatalogRunItems('fixture-run', []); assert.equal(calls.length, before);
  await store.insertCatalogRunItems('fixture-run', Array.from({ length: 51 }, (_, i) => ({ ...item, id: `batch-${i}` })));
  check('appendFifty', Array.from({ length: 50 }, (_, i) => values(`batch-${i}`)).flat(), calls.at(-2));
  check('appendOne', values('batch-50'));
  assert.deepEqual(await store.loadCatalogRun('fixture-run'), { run: rows[0], items: rows });
  check('loadRun', ['fixture-run'], calls.at(-2)); check('loadItems', ['fixture-run']);
  assert.equal(await store.loadRecentCatalogRuns(4), rows); check('recent', [4]);
  for (const [limit, expected] of [[undefined, 10], [0, 10], [-1, 1], [101, 100], ['5', 5]]) {
    await store.loadRecentCatalogRuns(limit); check('recent', [expected]);
  }
  rows = [];
  assert.equal(await store.loadCatalogRun('missing'), null); check('loadRun', ['missing']);
});

test('telemetry finalization guards and driver errors retain their original behavior', async () => {
  const store = createPostgresCatalogTelemetryStore({ query: async () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(store.finishCatalogRun('missing'), /finalization updated 0 rows/);
  const failure = new Error('Synthetic query failure');
  const broken = createPostgresCatalogTelemetryStore({ query: async () => { throw failure; } });
  await assert.rejects(broken.loadRecentCatalogRuns(), error => error === failure);
  assert.throws(() => createPostgresCatalogTelemetryStore({ query: null }), /function/);
});

test('public telemetry API supports an explicit run-owned store without selecting a driver', async () => {
  const calls = [];
  const store = Object.fromEntries(['startCatalogRun', 'finishCatalogRun', 'insertCatalogRunItems', 'loadCatalogRun', 'loadRecentCatalogRuns']
    .map(name => [name, async (...args) => { calls.push([name, ...args]); return name; }]));
  const options = { id: 'owned-run', mode: 'weekly' }, items = [{ id: 'owned-item' }];
  assert.equal(await startCatalogRun(options, store), 'startCatalogRun');
  assert.equal(await finishCatalogRun('owned-run', options, store), 'finishCatalogRun');
  assert.equal(await insertCatalogRunItems('owned-run', items, store), 'insertCatalogRunItems');
  assert.equal(await loadCatalogRun('owned-run', store), 'loadCatalogRun');
  assert.equal(await loadRecentCatalogRuns(5, store), 'loadRecentCatalogRuns');
  assert.deepEqual(calls, [['startCatalogRun', options], ['finishCatalogRun', 'owned-run', options],
    ['insertCatalogRunItems', 'owned-run', items], ['loadCatalogRun', 'owned-run'], ['loadRecentCatalogRuns', 5]]);
});

test('pure telemetry helpers and store construction never import the Postgres driver', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {register} from 'node:module';
    register('data:text/javascript,'+encodeURIComponent(
      "export async function resolve(specifier,context,next){if(specifier==='@vercel/postgres')throw new Error('driver deliberately blocked');return next(specifier,context);}"
    ),import.meta.url);
    const api=await import('./scripts/ops/catalog-telemetry.mjs');
    api.safeCatalogConfig({maxNew:1}); api.catalogRunItem({id:'fixture'});
    const ledger=api.createUsageLedger(); api.finalizeUsageLedger(ledger);
    const store=api.createPostgresCatalogTelemetryStore();
    const spy=api.createPostgresCatalogTelemetryStore({query:async()=>({rows:[]})});
    assert.deepEqual(await api.loadRecentCatalogRuns(1,spy),[]);
    await assert.rejects(store.loadRecentCatalogRuns(1),/driver deliberately blocked/);
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: new URL('../', import.meta.url), stdio: 'pipe',
  });
});

test('provider usage aggregates exact tokens and dated public price estimates', () => {
  const ledger = createUsageLedger();
  recordOpenAIUsage(ledger, {
    model: 'gpt-4o-mini',
    operation: 'editorial_draft',
    usage: {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
      total_tokens: 1_500_000,
      prompt_tokens_details: { cached_tokens: 200_000 },
    },
  });
  recordOpenAIUsage(ledger, {
    model: 'text-embedding-3-small',
    operation: 'embedding',
    usage: { prompt_tokens: 1_000_000, total_tokens: 1_000_000 },
  });

  const report = finalizeUsageLedger(ledger);
  assert.equal(report.models['gpt-4o-mini'].inputTokens, 1_000_000);
  assert.equal(report.models['gpt-4o-mini'].cachedInputTokens, 200_000);
  assert.equal(report.models['gpt-4o-mini'].estimatedCostUsd, 0.435);
  assert.equal(report.models['text-embedding-3-small'].estimatedCostUsd, 0.02);
  assert.equal(report.estimatedCostUsd, 0.455);
  assert.equal(report.estimateComplete, true);
});

test('Luna prices cache reads and writes separately without double-charging input', () => {
  const ledger = createUsageLedger();
  recordOpenAIUsage(ledger, { model: 'gpt-6-luna', operation: 'editorial_draft', usage: {
    prompt_tokens: 1_000_000, completion_tokens: 500_000, total_tokens: 1_500_000,
    prompt_tokens_details: { cached_tokens: 200_000, cache_write_tokens: 100_000 },
  } });
  const report = finalizeUsageLedger(ledger);
  assert.equal(report.models['gpt-6-luna'].estimatedCostUsd, 0.3345);
  assert.equal(report.models['gpt-6-luna'].cacheWriteInputTokens, 100_000);
  assert.equal(report.pricingVersion, 'openai-public-2026-11-02');
  assert.equal(report.estimateComplete, true);
  const merged = mergeUsageReports([report, report]);
  assert.equal(merged.models['gpt-6-luna'].cacheWriteInputTokens, 200_000);
  assert.equal(merged.estimatedCostUsd, 0.669);
});

test('unpriced cache writes remain an incomplete estimate instead of free usage', () => {
  const ledger = createUsageLedger();
  recordOpenAIUsage(ledger, { model: 'gpt-4o-mini', usage: {
    prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 50 },
  } });
  assert.equal(finalizeUsageLedger(ledger).estimateComplete, false);
});

test('unknown model usage remains visible and is never assigned a fabricated cost', () => {
  const ledger = createUsageLedger();
  recordOpenAIUsage(ledger, {
    model: 'custom-editor-v9',
    operation: 'editorial_review',
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  });
  const report = mergeUsageReports([finalizeUsageLedger(ledger)]);

  assert.equal(report.models['custom-editor-v9'].totalTokens, 120);
  assert.equal(report.models['custom-editor-v9'].estimatedCostUsd, null);
  assert.equal(report.estimateComplete, false);
  assert.deepEqual(report.unpricedModels, ['custom-editor-v9']);
  assert.equal(formatEstimatedCatalogRunCost({ usage: report, estimated_cost_usd: 0 }), '$0.000000 (partial; unpriced: custom-editor-v9)');
  assert.equal(formatEstimatedCatalogRunCost({ usage: {} }), 'unpriced');
});

test('telemetry redacts credentials and allowlists run configuration', () => {
  const value = sanitizeTelemetryValue({
    POSTGRES_URL: 'postgres://name:password@example.com/db',
    apiKey: 'sk-secret-example-value',
    nested: {
      token: 'bearer-secret',
      accessToken: 'oauth-secret',
      inputTokens: 123,
      cachedInputTokens: 12,
      outputTokens: 45,
      totalTokens: 168,
      note: 'authorization=top-secret',
    },
  });
  assert.deepEqual(value, {
    POSTGRES_URL: '[REDACTED]',
    apiKey: '[REDACTED]',
    nested: {
      token: '[REDACTED]',
      accessToken: '[REDACTED]',
      inputTokens: 123,
      cachedInputTokens: 12,
      outputTokens: 45,
      totalTokens: 168,
      note: 'authorization=[REDACTED]',
    },
  });
  assert.equal(
    redactTelemetryText('failed postgres://name:password@example.com/db with sk-abcdefghijklmnop'),
    'failed postgres://[REDACTED]@example.com/db with [REDACTED_OPENAI_KEY]'
  );
  assert.deepEqual(safeCatalogConfig({
    maxNew: 20,
    minQualityScore: 0.65,
    OPENAI_API_KEY: 'must-not-appear',
  }), { maxNew: 20, minQualityScore: 0.65 });
});

test('append-only histories fold deterministically into exact manual intervention', () => {
  const product = {
    id: 'B012345678',
    slug: 'ridiculous-desk-goat',
    title: 'Ridiculous desk goat',
    imageUrl: 'https://images.example/goat.jpg',
    affiliateUrl: 'https://www.amazon.com/dp/B012345678?tag=goose-20',
  };
  const selected = {
    ...catalogRunItem(product, { phase: 'backfill', stage: 'selection', decision: 'selected' }),
    id: 'a',
    sequence: 1,
    created_at: '2026-08-10T01:00:00Z',
  };
  const needsReview = {
    ...catalogRunItem(product, {
      phase: 'backfill',
      stage: 'persistence',
      decision: 'needs_review',
      reasonCode: 'unsupported_material_claim',
      requiresManualReview: true,
      nextAction: 'Check the source facts.',
    }),
    id: 'b',
    sequence: 2,
    created_at: '2026-08-10T01:01:00Z',
  };
  const items = [needsReview, selected];
  const run = {
    id: '11111111-1111-1111-1111-111111111111',
    status: 'completed',
    mode: 'weekly',
    trigger: 'scheduled',
    dry_run: false,
    started_at: '2026-08-10T01:00:00Z',
    completed_at: '2026-08-10T01:02:00Z',
    counts: {},
    timings_ms: {},
    usage: {},
  };

  assert.deepEqual(latestRunItemStates(items).map((item) => item.id), ['b']);
  assert.equal(manualInterventionItems(run, items).length, 1);
  const first = formatCatalogRunReport(run, items);
  const second = formatCatalogRunReport(run, items);
  assert.equal(first, second);
  assert.match(first, /Manual intervention: 1/);
  assert.match(first, /Latest item outcomes: \{"needs_review":1\}/);
  assert.match(first, /Latest reason codes: \{"unsupported_material_claim":1\}/);
  assert.match(first, /https:\/\/www\.goose\.gifts\/gifts\/ridiculous-desk-goat/);
  assert.match(first, /unsupported_material_claim/);
  const queue = formatManualReviewQueue(run, items);
  assert.match(queue, /Manual intervention: 1/);
  assert.match(queue, /unsupported_material_claim/);
  assert.doesNotMatch(queue, /Counts:/);
  assert.doesNotMatch(queue, /Latest item outcomes:/);
});

test('reason codes are normalized to the database width without risking run persistence', () => {
  const item = catalogRunItem({ id: 'B012345678' }, {
    reasonCode: 'A very long reviewer explanation '.repeat(10),
  });
  assert.equal(item.reasonCode.length, 64);
  assert.match(item.reasonCode, /^[a-z0-9_]+$/);
});

test('item telemetry failures stay retryable and do not abort observed catalog work', async () => {
  const warnings = [];
  let attempts = 0;
  const collector = createRunItemCollector({
    runId: '11111111-1111-1111-1111-111111111111',
    warnings,
    writeItems: async (_runId, items) => {
      attempts += 1;
      assert.equal(items.length, 1);
      if (attempts === 1) throw new Error('authorization=should-not-leak');
    },
  });
  collector.record({ id: 'B012345678', title: 'Retryable item' }, { decision: 'selected' });

  await collector.flush();
  assert.equal(collector.size, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].message, 'authorization=[REDACTED]');

  await collector.flush();
  assert.equal(collector.size, 0);
  assert.equal(attempts, 2);
});

test('report CLI rejects missing and invalid option values', () => {
  assert.throws(() => parseReportArgs(['--run']), /requires a value/);
  assert.throws(() => parseReportArgs(['--run', '--json']), /requires a value/);
  assert.throws(() => parseReportArgs(['--limit']), /requires a value/);
  assert.throws(() => parseReportArgs(['--limit', 'nope']), /positive integer/);
  assert.throws(() => parseReportArgs(['--limit', '0']), /positive integer/);
  assert.deepEqual(parseReportArgs(['--limit', '5', '--json']), {
    json: true,
    latest: false,
    manualReview: false,
    limit: 5,
    runId: null,
  });
});

test('partial runs surface selected-but-unfinished candidates as interrupted work', () => {
  const selected = {
    ...catalogRunItem({ id: 'B087654321', title: 'Interrupted item' }, {
      phase: 'revalidation',
      stage: 'selection',
      decision: 'selected',
    }),
    created_at: '2026-08-10T01:00:00Z',
  };
  const queue = manualInterventionItems({ status: 'partial' }, [selected]);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].effectiveDecision, 'interrupted');
  assert.match(queue[0].effectiveNextAction, /resume or rerun/);
});

test('telemetry migration keeps legacy editorial history independent of product deletion', () => {
  const migration = fs.readFileSync(
    new URL('../lib/db/migrations/0007_add_catalog_run_telemetry.sql', import.meta.url),
    'utf8'
  );
  const statements = splitMigrationStatements(migration);
  assert.match(migration, /catalog_run_items/);
  assert.match(statements[3], /CREATE TABLE IF NOT EXISTS "catalog_run_items" \([\s\S]+"sequence" bigserial NOT NULL/);
  assert.doesNotMatch(statements[0], /"sequence" bigserial NOT NULL/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "catalog_editorial_events_product_id_products_id_fk"/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "catalog_editorial_events_product_id_fkey"/);
  assert.doesNotMatch(migration, /catalog_run_items[\s\S]+product_id[^\n]+REFERENCES "products"/);
  assert.equal(statements.length, 9);
});

test('telemetry timestamp migration preserves existing UTC wall-clock values and is idempotent', () => {
  const migration = fs.readFileSync(
    new URL('../lib/db/migrations/0008_catalog_telemetry_timestamptz.sql', import.meta.url),
    'utf8'
  );
  const statements = splitMigrationStatements(migration);
  assert.equal(statements.length, 2);
  assert.match(migration, /data_type = 'timestamp without time zone'/);
  assert.match(migration, /USING "started_at" AT TIME ZONE 'UTC'/);
  assert.match(migration, /USING "created_at" AT TIME ZONE 'UTC'/);
  assert.match(migration, /TYPE timestamptz/);
});

test('catalog reports render absolute timestamp values as UTC in a Pacific process', () => {
  const report = formatCatalogRunReport({
    id: '11111111-1111-1111-1111-111111111111',
    status: 'completed',
    mode: 'weekly',
    trigger: 'scheduled',
    dry_run: false,
    started_at: new Date('2026-08-10T15:30:55.000Z'),
    completed_at: new Date('2026-08-10T15:34:49.000Z'),
    counts: {},
    timings_ms: {},
    usage: {},
  });
  assert.match(report, /Started: 2026-08-10T15:30:55\.000Z \| completed: 2026-08-10T15:34:49\.000Z/);
});
