import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson, canonicalTimestamp, convertSourceRow, destinationFor, exportVector, importBatch,
  moneyToMinor, reconcileRows, sha256, upsertProductAndQueueVector } from '../scripts/catalog/migration.ts';
import { getProductsByPublicIds, keywordSearch, appendSearchDiagnostic } from '../lib/catalog/storage/d1.ts';

const migration = readFileSync(new URL('../migrations/d1/0001_catalog.sql', import.meta.url), 'utf8');
const now = new Date('2026-10-19T12:00:00.000Z');
function database() {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec(migration);
  sqlite.exec('BEGIN'); sqlite.exec(readFileSync(new URL('../migrations/d1/0005_historical_timestamps.sql', import.meta.url), 'utf8')); sqlite.exec('COMMIT');
  const queries = [];
  const db = { sqlite, queries,
    prepare(sql) { queries.push(sql); let values = []; return {
      bind(...input) { values = input; return this; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return sqlite.prepare(sql).run(...values); },
    }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { for (const statement of statements) await statement.run(); sqlite.exec('COMMIT'); }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; } },
  };
  return db;
}
const options = { catalogRevision: 'test-only-revision', archiveId: 'protected-test-archive', now, timestamps: Object.fromEntries(
  ['created_at','updated_at','availability_checked_at','last_verified_at'].map((column) => [`products.${column}`,
    { timezone: 'UTC', evidence: 'Synthetic fixture writer explicitly uses UTC SQL NOW()' }])) };
function source(overrides = {}) {
  return { id: 'B000000001', public_id: '00000000-0000-4000-8000-000000000001', slug: 'test-only-crab',
    title: 'Private merchant test title', price: '12.34', currency: 'USD', source: 'amazon', quality_score: '0.9000',
    is_active: true, duplicate_of_product_id: null, editorial_status: 'manual_locked', availability_status: 'IN_STOCK',
    availability_checked_at: '2026-10-18 12:00:00.000001', last_verified_at: null,
    source_facts_hash: 'same', editorial_source_hash: 'same', source_facts: '{"raw":"private test evidence"}',
    editorial_generated_at: '2026-10-19 08:31:55.596',
    embedding: JSON.stringify(Array(1536).fill(0.012345678901234567)),
    created_at: '2026-10-18 12:00:00', updated_at: '2026-10-19 12:00:00.50259', ...overrides };
}
function display(overrides = {}) {
  return { id: 'B000000001', publicId: '00000000-0000-4000-8000-000000000001', slug: 'test-only-crab',
    title: 'TEST ONLY synthetic funny crab', description: 'Unit-test fixture, not a product recommendation.',
    imageUrl: '/test-only.svg', affiliateUrl: 'https://www.amazon.com/dp/B000000001?tag=test-only', currency: 'USD',
    source: 'amazon', price: 0, isActive: true, qualityScore: 0.9, eligibleUntil: '2026-10-20T12:00:00.000Z', ...overrides };
}
function converted(overrides = {}, publicDisplay = display()) { return convertSourceRow('products', source(overrides), { ...options, publicDisplay }); }
function batch(rows, batchNumber = 0) { return { exportSha256: sha256('synthetic-test-export'), table: 'products', batchNumber,
  rows, importedAt: now.toISOString() }; }

test('schema is repeatable, has indexed public identity and FTS but no retired runtime tables', () => {
  const db = database(); db.sqlite.exec(migration);
  const plan = db.sqlite.prepare('EXPLAIN QUERY PLAN SELECT * FROM products WHERE public_id=?').all('test');
  assert.match(plan[0].detail, /USING INDEX.*public_id/);
  for (const table of ['gift_bundles','gift_ideas','gift_idea_products','product_clicks','admin_actions','error_logs']) {
    assert.equal(db.sqlite.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table), undefined);
  }
  assert.equal(destinationFor('gift_bundles').kind, 'archive');
  assert.deepEqual(destinationFor('search_queries'), { kind: 'd1', table: 'search_history' });
});

test('money is exact, zero/unknown stays null, unsupported precision refuses instead of rounding', () => {
  assert.equal(moneyToMinor('19.99', 'USD'), 1999);
  assert.equal(moneyToMinor('0.00', 'USD'), null);
  assert.equal(moneyToMinor(null, 'USD'), null);
  assert.equal(moneyToMinor('1999', 'JPY'), 1999);
  assert.equal(moneyToMinor('1.234', 'KWD'), 1234);
  assert.throws(() => moneyToMinor('1.234', 'USD'), /precision/);
  assert.throws(() => moneyToMinor(19.99, 'USD'), /decimal string/);
  assert.throws(() => moneyToMinor('1.00', 'XXX'), /review/);
});

test('timestamps preserve microseconds and require per-column writer evidence for naive history', () => {
  assert.throws(() => canonicalTimestamp('2026-10-19 08:31:55.596'), /documented UTC/);
  assert.throws(() => canonicalTimestamp(new Date()), /Expected timestamp/);
  assert.equal(canonicalTimestamp('2026-10-19 15:31:58.50259', { timezone: 'UTC', evidence: 'test SQL NOW' }), '2026-10-19T15:31:58.502590Z');
  assert.equal(canonicalTimestamp('2026-10-19T08:31:58.502590-07:00'), '2026-10-19T15:31:58.502590Z');
  assert.equal(canonicalTimestamp(null), null);
  assert.throws(() => canonicalTimestamp('2026-02-30T00:00:00Z'), /calendar date/);
  for (const value of ['2026-10-19T24:00:00Z', '2026-10-19 24:00:00.000',
    '2026-10-19T25:00:00Z', '2026-10-19T23:60:00Z', '2026-10-19T23:59:60Z']) {
    assert.throws(() => canonicalTimestamp(value, { timezone: 'UTC', evidence: 'test-only explicit semantics' }), /wall-clock time/);
  }
  assert.equal(canonicalTimestamp('2026-10-19T23:59:59.999999Z'), '2026-10-19T23:59:59.999999Z');
  const row = converted();
  assert.equal(row.updated_at, '2026-10-19T12:00:00.502590Z');
  assert.equal(JSON.parse(row.source_record_json).editorial_generated_at, '2026-10-19 08:31:55.596');
});

test('product conversion preserves private raw values but never embeds vectors or uncertified searchable copy', () => {
  const row = converted();
  assert.equal(row.price_minor, 1234);
  assert.equal(row.quality_score, 0.9);
  assert.equal(row.is_active, 1);
  assert.equal(JSON.parse(row.source_record_json).embedding, undefined);
  assert.equal(JSON.parse(row.source_record_json).price, '12.34');
  assert.throws(() => canonicalJson({ ambiguous_driver_date: new Date() }), /driver-parsed/);
  assert.equal(row.title, display().title);
  assert.equal(convertSourceRow('products', source(), options).title, '');
  assert.throws(() => converted({ is_active: 1 }), /boolean/);
  assert.throws(() => converted({ quality_score: 'NaN' }), /quality/);
});

test('explicit unresolved historical derivatives become NULL without discarding source wall times', async () => {
  const unresolved = { timezone: 'unresolved', evidence: 'Historical session timezone not proven; retain exact source wall time' };
  const row = convertSourceRow('products', source(), { ...options,
    timestamps: { ...options.timestamps, 'products.created_at': unresolved }, publicDisplay: display() });
  assert.equal(row.created_at, null);
  assert.equal(JSON.parse(row.source_record_json).created_at, source().created_at);
  assert.equal(row.updated_at, '2026-10-19T12:00:00.502590Z');
  assert.equal(row.availability_checked_at, '2026-10-18T12:00:00.000001Z');
  const db = database(); await importBatch(db, batch([row]));
  assert.equal(db.sqlite.prepare('SELECT created_at FROM products').get().created_at, null);
  for (const column of ['availability_checked_at','last_verified_at','updated_at']) {
    const result = convertSourceRow('products', source(), { ...options,
      timestamps: { ...options.timestamps, [`products.${column}`]: unresolved } });
    assert.equal(result[column], null);
    assert.equal(JSON.parse(result.source_record_json)[column], source()[column]);
  }
  const event = convertSourceRow('catalog_editorial_events', { id: 'test', run_id: 'run', product_id: 'product', event_type: 'test', status: 'ok', created_at: '2026-10-19 12:00:00' }, {
    ...options, timestamps: { 'catalog_editorial_events.created_at': unresolved } });
  assert.equal(event.created_at, null);
  assert.throws(() => convertSourceRow('product_slug_history', { created_at: '2026-10-19 12:00:00' }, {
    ...options, timestamps: { 'product_slug_history.created_at': unresolved } }), /approved historical nullable/);
  assert.throws(() => canonicalTimestamp(source().created_at, unresolved), /documented UTC/);
  assert.throws(() => convertSourceRow('products', source(), { ...options,
    timestamps: { ...options.timestamps, 'products.created_at': { timezone: 'unresolved', evidence: '' } } }), /and evidence/);
  assert.throws(() => convertSourceRow('products', source(), { ...options,
    timestamps: { ...options.timestamps, 'products.created_at': undefined } }), /documented UTC/);
});

test('original vectors retain values/dimension and use exact public-ID mapping/metadata', () => {
  const metadata = { catalogRevision: 'test-only', eligible: false, embeddingTextHash: sha256('test-only-embedding-text') };
  const vector = exportVector(source(), metadata);
  assert.deepEqual(vector.values, JSON.parse(source().embedding));
  assert.equal(vector.values.length, 1536);
  assert.equal(vector.id, source().public_id);
  assert.deepEqual(vector.metadata, metadata);
  assert.equal(exportVector(source({ embedding: null }), metadata), null);
  assert.throws(() => exportVector(source({ embedding: '[1,2]' }), metadata), /1536/);
});

test('import retries are idempotent, modified receipts refuse, and interrupted batches roll back', async () => {
  const db = database(); const row = converted();
  assert.equal(await importBatch(db, batch([row])), 'imported');
  assert.equal(await importBatch(db, batch([row])), 'already_imported');
  await assert.rejects(importBatch(db, batch([{ ...row, title: 'changed' }])), /receipt/);
  const another = converted({ id: 'B000000002', public_id: '00000000-0000-4000-8000-000000000002', slug: 'test-only-second' },
    display({ id: 'B000000002', publicId: '00000000-0000-4000-8000-000000000002', slug: 'test-only-second', affiliateUrl: 'https://www.amazon.com/dp/B000000002?tag=test-only' }));
  await assert.rejects(importBatch(db, batch([another, row], 1)), /UNIQUE/);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM products').get().n, 1);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM migration_imports').get().n, 1);
  assert.equal(await importBatch(db, batch([another], 1)), 'imported');
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM products').get().n, 2);
});

test('a matching receipt cannot conceal deleted or modified operational row fields', async () => {
  for (const mutation of [
    'DELETE FROM products', "UPDATE products SET title='changed after receipt'",
    'UPDATE products SET quality_score=0.1', "UPDATE products SET duplicate_of_product_id='other'",
    `UPDATE products SET source_record_json='{"private":"changed source evidence"}'`,
  ]) {
    const db = database(); const row = converted(); const packet = batch([row]);
    await importBatch(db, packet);
    const receipt = db.sqlite.prepare('SELECT * FROM migration_imports').get();
    db.sqlite.exec(mutation);
    const afterMutation = db.sqlite.prepare('SELECT * FROM products').all();
    const start = db.queries.length;
    await assert.rejects(importBatch(db, packet), /target rows are missing or changed/);
    assert.ok(db.queries.slice(start).every((sql) => sql.trimStart().startsWith('SELECT')));
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM products').all(), afterMutation);
    assert.deepEqual(db.sqlite.prepare('SELECT * FROM migration_imports').get(), receipt);
    assert.deepEqual(packet.rows, [row]);
  }
});

test('receipt replay reconciles slug-history identities without a nonexistent id column', async () => {
  const db = database(); await importBatch(db, batch([converted()]));
  const row = { slug: 'previous-test-only-crab', product_id: source().id, created_at: now.toISOString(), source_record_json: '{"synthetic":"history"}' };
  const packet = { ...batch([row]), table: 'product_slug_history' };
  assert.equal(await importBatch(db, packet), 'imported');
  assert.equal(await importBatch(db, packet), 'already_imported');
  assert.match(db.queries.at(-1), /WHERE slug IN \(\?\)/);
  db.sqlite.exec('DELETE FROM product_slug_history');
  await assert.rejects(importBatch(db, packet), /missing or changed/);
});

test('replay uses one bounded indexed read and compares only each row original expected fields', async () => {
  const db = database();
  const rows = Array.from({ length: 40 }, (_, index) => ({ id: `run-${index}`, status: 'complete', mode: 'test', dry_run: 1,
    started_at: now.toISOString(), source_record_json: '{}', ...(index % 2 ? { completed_at: null } : {}) }));
  const packet = { ...batch(rows), table: 'catalog_runs' };
  assert.equal(await importBatch(db, packet), 'imported');
  const start = db.queries.length;
  assert.equal(await importBatch(db, packet), 'already_imported');
  const replayQueries = db.queries.slice(start);
  assert.equal(replayQueries.length, 2); // Receipt + target rows, no writes.
  assert.match(replayQueries[1], /FROM catalog_runs\s+WHERE id IN/);
  assert.equal(replayQueries[1].match(/\?/g).length, 40);
  assert.equal(db.sqlite.prepare('SELECT completed_at FROM catalog_runs WHERE id=?').get('run-0').completed_at, null);
  assert.equal('completed_at' in rows[0], false);
});

test('search is FTS/index-backed, bounded and fails closed on held, expired, duplicate or corrupt public fields', async () => {
  const db = database(); const row = converted(); await importBatch(db, batch([row]));
  db.sqlite.exec(readFileSync(new URL('../migrations/d1/0010_catalog_maintenance.sql', import.meta.url), 'utf8'));
  assert.equal((await keywordSearch(db, 'funny crab', 240, now))[0].publicId, source().public_id);
  assert.equal((await getProductsByPublicIds(db, [source().public_id], now)).length, 1);
  assert.equal((await getProductsByPublicIds(db, [source().public_id], now, 'wrong-revision')).length, 0);
  assert.equal((await keywordSearch(db, 'crab', 60, now, 'wrong-revision')).length, 0);
  assert.equal((await keywordSearch(db, '" OR * --', 60, now)).length, 0);
  await assert.rejects(getProductsByPublicIds(db, Array(241).fill('id'), now), /240/);
  for (const sql of ["UPDATE products SET duplicate_of_product_id='other'", "UPDATE products SET is_active=0",
    'UPDATE products SET availability_checked_at=NULL,last_verified_at=NULL',
    "UPDATE products SET availability_status='OUT_OF_STOCK'", 'UPDATE products SET quality_score=0.1',
    "UPDATE products SET eligible_until='2000-01-01T00:00:00.000Z'", "UPDATE products SET public_display_json='{}'"]) {
    await db.prepare(sql).run();
    assert.equal((await getProductsByPublicIds(db, [source().public_id], now)).length, 0);
    db.sqlite.prepare('DELETE FROM products').run();
    const keys = Object.keys(row); db.sqlite.prepare(`INSERT INTO products(${keys}) VALUES(${keys.map(() => '?')})`).run(...keys.map((key) => row[key]));
  }
});

test('product/outbox mutation is atomic and retries do not duplicate vector work', async () => {
  const db = database(); const row = converted();
  const event = { publicId: row.public_id, revision: row.catalog_revision, embeddingTextHash: sha256('synthetic-text'), operation: 'upsert', createdAt: now.toISOString() };
  await upsertProductAndQueueVector(db, row, event); await upsertProductAndQueueVector(db, row, event);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n, 1);
  await assert.rejects(upsertProductAndQueueVector(db, row, { ...event, embeddingTextHash: sha256('different') }), /NOT NULL/);
  await assert.rejects(upsertProductAndQueueVector(db, { ...row, title: 'must-roll-back' }, { ...event, operation: 'bad' }), /CHECK/);
  assert.equal(db.sqlite.prepare('SELECT title FROM products').get().title, row.title);
});

test('history keeps archived bundle references without a retired runtime foreign key', () => {
  const row = convertSourceRow('search_queries', { id: 'test-search', query: 'private test', clicked_bundle_id: 'legacy-bundle', clicked_bundle_slug: 'legacy-slug', created_at: '2026-10-18T00:00:00Z' }, options);
  assert.equal(row.legacy_bundle_id, 'legacy-bundle');
  assert.equal(row.archive_reference, 'protected-test-archive/gift_bundles');
  const db = database(); const keys = Object.keys(row);
  db.sqlite.prepare(`INSERT INTO search_history(${keys}) VALUES(${keys.map(() => '?')})`).run(...keys.map((key) => row[key]));
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  const history = convertSourceRow('product_slug_history', { slug: 'old', product_id: source().id, created_at: '2026-10-18T00:00:00Z' }, options);
  assert.equal(history.slug, 'old');
});

test('receipt sequences remain ordered and new local writes allocate after imported maximum', () => {
  const db = database();
  db.sqlite.prepare("INSERT INTO catalog_runs VALUES('run','ok','test',1,'2026-10-19T00:00:00.000000Z',NULL,'{}')").run();
  db.sqlite.prepare("INSERT INTO catalog_run_items(sequence,id,run_id,external_id,decision,requires_manual_review,created_at,source_record_json) VALUES(500,'item','run','test','held',0,'2026-10-19T00:00:00.000000Z','{}')").run();
  db.sqlite.prepare("INSERT INTO catalog_run_items(id,run_id,external_id,decision,requires_manual_review,created_at,source_record_json) VALUES('next','run','test','held',0,'2026-10-19T00:00:00.000000Z','{}')").run();
  assert.equal(db.sqlite.prepare("SELECT sequence FROM catalog_run_items WHERE id='next'").get().sequence, 501);
});

test('new diagnostics store hashes only and clean by explicit 30-day expiry', async () => {
  const db = database();db.sqlite.exec(readFileSync(new URL('../migrations/d1/0009_catalog_mutation_fence.sql',import.meta.url),'utf8'));
  await appendSearchDiagnostic(db, { id: 'test', queryHash: sha256('synthetic query'), queryLength: 15,
    resultCount: 1, topSimilarity: 0.75, matchType: 'semantic', outcome: 'ok' }, now);
  const row = db.sqlite.prepare('SELECT * FROM search_diagnostics').get();
  assert.equal(row.expires_at, '2026-11-18T12:00:00.000Z'); assert.equal(row.query, undefined);
  assert.deepEqual(reconcileRows([{ id: '1', amount: '12.34' }], [{ amount: '12.34', id: '1' }], 'id'), []);
  assert.deepEqual(reconcileRows([{ id: '1', amount: '12.34' }], [{ amount: '12.35', id: '1' }], 'id'), ['1']);
  assert.equal(canonicalJson({ z: 1, a: null }), '{"a":null,"z":1}');
});
