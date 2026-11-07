import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { canonicalJson, sha256, upsertProductAndQueueVector } from '../scripts/catalog/migration.ts';
import { createReviewedVectorDelete, queueReviewedVectorDelete } from '../scripts/catalog/vector-delete.ts';
import { drainVectorOutbox } from '../scripts/catalog/vector-outbox.ts';

const NOW = Date.parse('2026-10-20T07:00:00.000Z');
const UUID = '00000000-0000-4000-8000-000000000001';
const MIGRATIONS = ['0001_catalog.sql','0002_public_projections.sql','0003_publication_outbox.sql',
  '0004_vector_outbox_leases.sql','0005_historical_timestamps.sql','0006_semantic_search_budget.sql','0007_catalog_build_requests.sql'];
const migration = name => readFile(new URL(`../migrations/d1/${name}`, import.meta.url), 'utf8');
async function installCurrentReaderSchema(sqlite) {
  // The current public reader joins the0010 sidecar. Install its real schema
  // only AFTER0008; an empty0009 scope keeps this legacy writer unselected.
  for (const name of ['0009_catalog_mutation_fence.sql','0010_catalog_maintenance.sql']) sqlite.exec(await migration(name));
  assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_mutation_scopes').get().n,0);
}
async function fixture(applyV8 = true) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const name of MIGRATIONS) sqlite.exec(await migration(name));
  if (applyV8) { sqlite.exec(await migration('0008_reviewed_vector_deletes.sql')); await installCurrentReaderSchema(sqlite); }
  let clock = NOW; let stored = { id: UUID, metadata: { legacyInputProvenance: 'unverified' } };
  let deletes = 0; let upserts = 0; let beforeRun;
  sqlite.function('strftime', (format, instant) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(instant, 'now'); return new Date(clock).toISOString();
  });
  sqlite.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,is_active,editorial_status,
    embedding_text_hash,catalog_revision,rights_json,source_record_json,created_at,updated_at)
    VALUES('B000000001',?,'test-held','amazon','','USD',0,'pending',NULL,'r1','{}','{"test":"exact archive wall time"}',NULL,NULL)`).run(UUID);
  const db = { prepare(sql) { let args = []; return {
    bind(...values) { args = values; return this; },
    async all() { return { results: sqlite.prepare(sql).all(...args).map(row => ({ ...row })) }; },
    async run() { beforeRun?.(sql); return sqlite.prepare(sql).run(...args); },
  }; }, async batch(statements) { sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  const product = () => ({ ...sqlite.prepare('SELECT * FROM products WHERE public_id=?').get(UUID) });
  const review = () => createReviewedVectorDelete(product(), { reviewedAt: new Date(clock).toISOString(), reviewReference: 'protected-test-review#held-identity' });
  const row = () => ({ ...sqlite.prepare('SELECT * FROM vector_sync_outbox ORDER BY sequence LIMIT 1').get() });
  const adapters = {
    async loadPayload(event) { return { ...event, mutation: JSON.parse(sqlite.prepare('SELECT mutation_json FROM vector_delete_mutations WHERE mutation_sha256=?').get(event.deleteMutationSha256).mutation_json) }; },
    async readback() { return stored; },
    async delete(id) { assert.equal(id, UUID); deletes++; stored = null; return { reference: 'test-reviewed-delete' }; },
    async upsert() { upserts++; throw new Error('Unknown hashes must never authorize upsert'); },
  };
  return { sqlite, db, product, review, row, adapters, counts: () => ({ deletes, upserts }),
    setStored(value) { stored = value; }, beforeRun(fn) { beforeRun = fn; }, advance(ms = 5000) { clock += ms; },
    queue: (value = review()) => queueReviewedVectorDelete(db, value, new Date(clock)),
    drain: () => drainVectorOutbox({ db, catalogRevision: 'r1', adapters, now: () => clock }), close: () => sqlite.close() };
}

test('reviewed legacy deletion needs no invented text/model/hash; exact absence and replay keep the global watermark', async () => {
  const f = await fixture();
  try {
    const original = f.product(); const review = f.review(); await f.queue(review); await f.queue(review);
    assert.equal(f.row().embedding_text_hash, null); assert.equal(f.row().delete_mutation_sha256, sha256(canonicalJson(review)));
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n, 1);
    assert.equal((await f.drain()).outcomes[0].outcome, 'complete'); assert.deepEqual(f.counts(), { deletes: 1, upserts: 0 });
    assert.deepEqual(f.product(), original); await f.queue(review);
    assert.deepEqual((await f.drain()).outcomes, []); assert.equal(f.counts().deletes, 1);
    assert.equal(f.sqlite.prepare('SELECT max(sequence) n FROM vector_sync_outbox').get().n, f.row().sequence);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});

test('accepted legacy delete retains its receipt, retries readback only, and requires verified absence', async () => {
  const f = await fixture(); let deletes = 0;
  try {
    await f.queue(); f.adapters.delete = async () => { deletes++; return { reference: 'test-accepted-not-visible' }; };
    assert.equal((await f.drain()).outcomes[0].errorCode, 'not_visible'); assert.equal(f.row().status, 'pending');
    assert.equal(f.row().mutation_reference, 'test-accepted-not-visible'); assert.deepEqual((await f.drain()).outcomes, []);
    f.advance(); f.setStored(null); assert.equal((await f.drain()).outcomes[0].outcome, 'complete');
    assert.equal(deletes, 1); assert.equal(f.row().attempts, 2);
  } finally { f.close(); }
});

test('an expired legacy-delete owner cannot complete or resend after a lease takeover', async () => {
  const f = await fixture(); let inner; let entered = false; let firstToken;
  try {
    await f.queue(); const readback = f.adapters.readback;
    f.adapters.readback = async id => {
      if (!entered) { entered = true; firstToken = f.row().lease_token; f.advance(60_000); inner = await f.drain(); }
      return readback(id);
    };
    const outer = await f.drain();
    assert.equal(inner.outcomes[0].outcome, 'complete'); assert.notEqual(outer.outcomes[0].outcome, 'complete');
    assert.equal(f.row().status, 'complete'); assert.notEqual(f.row().lease_token, firstToken); assert.equal(f.counts().deletes, 1);
  } finally { f.close(); }
});

test('review payload/identity/revision/text tampering and changed current rows refuse before deletion', async () => {
  for (const mutate of [
    payload => { payload.mutation.productId = 'other-product'; }, payload => { payload.publicId = 'other-uuid'; },
    payload => { payload.catalogRevision = 'other-revision'; }, payload => { payload.deleteMutationSha256 = 'a'.repeat(64); },
    payload => { payload.mutation.reviewReference = 'different-review'; }, payload => { payload.embeddingText = 'invented legacy input'; },
    payload => { payload.model = 'text-embedding-3-small'; }, payload => { payload.values = []; },
  ]) {
    const f = await fixture();
    try { await f.queue(); const load = f.adapters.loadPayload; f.adapters.loadPayload = async event => { const payload = await load(event); mutate(payload); return payload; };
      assert.equal((await f.drain()).outcomes[0].errorCode, 'payload_invalid'); assert.equal(f.counts().deletes, 0);
    } finally { f.close(); }
  }
  const f = await fixture();
  try { await f.queue(); f.sqlite.exec("UPDATE products SET updated_at='2026-10-20T07:00:01.000Z'");
    assert.notEqual((await f.drain()).outcomes[0].outcome, 'complete'); assert.equal(f.counts().deletes, 0);
  } finally { f.close(); }
});

test('receipt/queued identity are immutable, mismatched retries roll back, unknown-hash upserts cannot be queued', async () => {
  const f = await fixture();
  try {
    const review = f.review(); await f.queue(review);
    for (const sql of ["UPDATE vector_delete_mutations SET mutation_json='{}'", 'DELETE FROM vector_delete_mutations',
      "UPDATE vector_sync_outbox SET public_id='other'", "UPDATE vector_sync_outbox SET source_revision='other'",
      "UPDATE vector_sync_outbox SET operation='upsert'", "UPDATE vector_sync_outbox SET embedding_text_hash='invented'"])
      assert.throws(() => f.sqlite.exec(sql), /immutable|retained/);
    await assert.rejects(f.queue({ ...review, reviewReference: 'different-review' }), /immutable|CHECK/);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM vector_delete_mutations').get().n, 1);
    assert.throws(() => f.sqlite.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at)
      VALUES(?,'r2',NULL,'upsert',?)`).run(UUID, new Date(NOW).toISOString()), /CHECK/);
    await assert.rejects(upsertProductAndQueueVector(f.db, f.product(), { publicId: UUID, revision: 'r1',
      operation: 'upsert', embeddingTextHash: null, createdAt: new Date(NOW).toISOString() }), /mismatch/);
    const original = f.product();
    await assert.rejects(upsertProductAndQueueVector(f.db, { ...original, updated_at: new Date(NOW).toISOString(), embedding_text_hash: 'a'.repeat(64) },
      { publicId: UUID, revision: 'r1', operation: 'delete', embeddingTextHash: 'a'.repeat(64), createdAt: new Date(NOW).toISOString() }), /immutable|NOT NULL/);
    assert.deepEqual(f.product(), original); // Nullable delete hashes must not weaken the original atomic helper.
  } finally { f.close(); }
});

test('invalid queue reviews do not write receipts or events; provider receipts/leases cannot bypass the current-row fence', async () => {
  for (const mutate of [
    review => { review.reviewReference = ''; }, review => { review.reviewedAt = '2026-02-30T00:00:00Z'; },
    review => { review.reviewedAt = new Date(NOW + 1000).toISOString(); }, review => { review.productStateSha256 = 'a'.repeat(64); },
  ]) {
    const f = await fixture(); try { const review = { ...f.review() }; mutate(review); await assert.rejects(f.queue(review));
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM vector_delete_mutations').get().n, 0);
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n, 0);
    } finally { f.close(); }
  }
  const invalid = await fixture();
  try { await invalid.queue(); invalid.adapters.delete = async () => ({ reference: null });
    assert.equal((await invalid.drain()).outcomes[0].errorCode, 'provider_failed'); assert.equal(invalid.row().mutation_reference, null);
  } finally { invalid.close(); }
  const fenced = await fixture();
  try { await fenced.queue(); fenced.beforeRun(sql => { if (sql.includes("SET status='complete'")) fenced.sqlite.exec("UPDATE products SET updated_at='changed'"); });
    assert.equal((await fenced.drain()).outcomes[0].errorCode, 'current_state_changed'); assert.equal(fenced.row().status, 'pending');
  } finally { fenced.close(); }
});

test('0008 preserves populated outbox rows, leases, receipts, and deleted-row AUTOINCREMENT high-water marks', async () => {
  const f = await fixture(false);
  try {
    f.sqlite.prepare(`INSERT INTO vector_sync_outbox(sequence,public_id,source_revision,embedding_text_hash,operation,status,attempts,
      created_at,completed_at,lease_token,lease_until,mutation_reference,error_code) VALUES(7,?,'old',?,'upsert','pending',2,'created',NULL,'lease','later','accepted','not_visible')`).run(UUID, 'a'.repeat(64));
    f.sqlite.prepare(`INSERT INTO vector_sync_outbox(sequence,public_id,source_revision,embedding_text_hash,operation,created_at) VALUES(99,?,'gone',?,'delete','created')`).run(UUID, 'a'.repeat(64));
    f.sqlite.exec('DELETE FROM vector_sync_outbox WHERE sequence=99'); const before = f.row();
    f.sqlite.exec('BEGIN'); f.sqlite.exec(await migration('0008_reviewed_vector_deletes.sql')); f.sqlite.exec('COMMIT');
    const after = f.row(); assert.equal(after.delete_mutation_sha256, null); delete after.delete_mutation_sha256;
    assert.deepEqual(after, before); assert.equal(f.sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='vector_sync_outbox'").get().seq, 99);
    await installCurrentReaderSchema(f.sqlite);
    await f.queue(); assert.equal(f.sqlite.prepare('SELECT max(sequence) n FROM vector_sync_outbox').get().n, 100);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { f.close(); }
});

test('0008 preserves an empty outbox historical sequence and a forged preexisting review cannot gain queued work', async () => {
  const empty = await fixture(false);
  try {
    empty.sqlite.prepare(`INSERT INTO vector_sync_outbox(sequence,public_id,source_revision,embedding_text_hash,operation,created_at)
      VALUES(99,?,'gone',?,'delete','created')`).run(UUID, 'a'.repeat(64));
    empty.sqlite.exec('DELETE FROM vector_sync_outbox'); empty.sqlite.exec(await migration('0008_reviewed_vector_deletes.sql'));
    await installCurrentReaderSchema(empty.sqlite);
    await empty.queue(); assert.equal(empty.row().sequence, 100);
  } finally { empty.close(); }
  const forged = await fixture();
  try {
    const review = forged.review(); const digest = sha256(canonicalJson(review));
    forged.sqlite.prepare('INSERT INTO vector_delete_mutations VALUES(?,?,?,?)').run(digest, UUID, 'r1', '{}');
    await assert.rejects(forged.queue(review), /review mismatch|CHECK/);
    assert.equal(forged.sqlite.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n, 0);
  } finally { forged.close(); }
  const conflict = await fixture();
  try {
    conflict.sqlite.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at)
      VALUES(?,'r1',?,'delete',?)`).run(UUID, 'a'.repeat(64), new Date(NOW).toISOString());
    await assert.rejects(conflict.queue(), /NOT NULL|CHECK/);
    assert.equal(conflict.sqlite.prepare('SELECT count(*) n FROM vector_delete_mutations').get().n, 0);
    assert.equal(conflict.row().embedding_text_hash, 'a'.repeat(64));
  } finally { conflict.close(); }
});

test('0008 preserves existing column/index semantics and revision watermark queries remain indexed', async () => {
  const f = await fixture(false);
  const indexes = () => f.sqlite.prepare('PRAGMA index_list(vector_sync_outbox)').all().map(index => ({
    // SQLite owns autoindex names; explicit index names are part of the schema contract.
    name: index.origin === 'u' ? '<unique constraint>' : index.name,
    unique: index.unique, partial: index.partial,
    columns: f.sqlite.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all().map(column => column.name),
  })).sort((a, b) => a.name.localeCompare(b.name));
  try {
    const beforeIndexes = indexes();
    assert.deepEqual(beforeIndexes.map(index => index.name), ['<unique constraint>', 'vector_sync_outbox_pending_idx', 'vector_sync_revision_watermark']);
    const beforeColumns = f.sqlite.prepare('PRAGMA table_info(vector_sync_outbox)').all().map(column => ({ ...column }));
    const insert = f.sqlite.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,status,created_at)
      VALUES(?,?,?,'upsert',?,'2026-10-20T07:00:00.000Z')`);
    f.sqlite.exec('BEGIN');
    for (let index = 0; index < 3000; index++) insert.run(`00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, 'other-revision', 'a'.repeat(64), 'complete');
    insert.run(UUID, 'target-revision', 'a'.repeat(64), 'pending');
    f.sqlite.exec('COMMIT');
    const queries = [
      'SELECT coalesce(max(sequence),0) watermark FROM vector_sync_outbox WHERE source_revision=?',
      "SELECT 1 pending FROM vector_sync_outbox WHERE source_revision=? AND status!='complete' LIMIT 1",
    ];
    const results = queries.map(sql => ({ ...f.sqlite.prepare(sql).get('target-revision') }));
    f.sqlite.exec('BEGIN'); f.sqlite.exec(await migration('0008_reviewed_vector_deletes.sql')); f.sqlite.exec('COMMIT');
    assert.deepEqual(indexes(), beforeIndexes);
    const afterColumns = f.sqlite.prepare('PRAGMA table_info(vector_sync_outbox)').all().map(column => ({ ...column }));
    assert.deepEqual(afterColumns.slice(0, beforeColumns.length), beforeColumns.map(column =>
      column.name === 'embedding_text_hash' ? { ...column, notnull: 0 } : column));
    assert.equal(afterColumns.at(-1).name, 'delete_mutation_sha256');
    for (let index = 0; index < queries.length; index++) {
      assert.deepEqual({ ...f.sqlite.prepare(queries[index]).get('target-revision') }, results[index]);
      const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN ${queries[index]}`).all('target-revision').map(row => row.detail).join('\n');
      assert.match(plan, /SEARCH vector_sync_outbox USING COVERING INDEX vector_sync_revision_watermark \(source_revision=\?\)/);
      assert.doesNotMatch(plan, /SCAN vector_sync_outbox/);
    }
    assert.deepEqual(results, [{ watermark: 3001 }, { pending: 1 }]);
  } finally { f.close(); }
});

test('pre-batch product drift can queue stale work but cannot authorize a deletion or autonomous completion', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.beforeRun(sql => {
      if (!changed && sql.includes('INSERT INTO vector_delete_mutations')) {
        changed = true; f.sqlite.exec("UPDATE products SET updated_at='2026-10-20T07:00:01.000Z'");
      }
    });
    await f.queue();
    assert.equal((await f.drain()).outcomes[0].errorCode, 'payload_invalid');
    assert.equal(f.row().status, 'pending'); assert.equal(f.row().mutation_reference, null);
    assert.deepEqual(f.counts(), { deletes: 0, upserts: 0 });
  } finally { f.close(); }
});
