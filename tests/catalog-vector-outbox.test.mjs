import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { drainVectorOutbox } from '../scripts/catalog/vector-outbox.ts';
import { sha256 } from '../scripts/catalog/migration.ts';
import { encodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const UUID = '00000000-0000-4000-8000-000000000001';
const FACTS = 'a'.repeat(64);
const TEXT = 'Verified original funny crab embedding input.';
const INPUT_HASH = sha256(TEXT);
const bytesHash = values => createHash('sha256').update(Buffer.from(encodePgvectorSendBase64(values), 'base64')).digest('hex');
async function setup(operation = 'upsert') {
  const sqlite = new DatabaseSync(':memory:');
  // Exercise the legacy drainer without installing/enabling0009 ownership,
  // but include the real maintenance schema used by current public-copy reads.
  for (const name of ['0001_catalog.sql', '0004_vector_outbox_leases.sql', '0008_reviewed_vector_deletes.sql', '0010_catalog_maintenance.sql'])
    sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`, import.meta.url), 'utf8'));
  let clock = NOW; let beforeRun;
  sqlite.function('strftime', (format, instant) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(instant, 'now');
    return new Date(clock).toISOString();
  });
  const product = { id: 'B000000001', publicId: UUID, slug: 'funny-crab', title: 'Funny Crab Spoon Rest', description: 'A funny crab.',
    imageUrl: 'https://m.media-amazon.com/images/I/crab.jpg', affiliateUrl: 'https://www.amazon.com/dp/B000000001?tag=test-20',
    source: 'amazon', currency: 'USD', price: 0, isActive: true, qualityScore: 0.8, eligibleUntil: new Date(NOW + 86_400_000).toISOString() };
  sqlite.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,quality_score,is_active,editorial_status,
    availability_status,availability_checked_at,source_facts_hash,editorial_source_hash,embedding_text_hash,catalog_revision,eligible_until,rights_json,source_record_json,updated_at,public_display_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(product.id, UUID, product.slug, 'amazon', product.title, 'USD', .8, operation === 'upsert' ? 1 : 0,
      'generated_ready', 'IN_STOCK', new Date(NOW).toISOString(), FACTS, FACTS, INPUT_HASH, 'r1', product.eligibleUntil, '{}', '{}', new Date(NOW).toISOString(), operation === 'upsert' ? JSON.stringify(product) : null);
  sqlite.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at) VALUES(?,?,?,?,?)`)
    .run(UUID, 'r1', INPUT_HASH, operation, new Date(NOW).toISOString());
  const db = { prepare(sql) { let values = []; return {
    bind(...input) { values = input; return this; },
    async all() { return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
    async run() { beforeRun?.(sql, values); return sqlite.prepare(sql).run(...values); },
  }; }, async batch() { throw new Error('This drainer uses atomic conditional statements only'); } };
  const values = Array(1536).fill(Math.fround(.1)); values[0] = -0; values[1] = Math.fround(1e-45);
  const payload = { sequence: 1, publicId: UUID, catalogRevision: 'r1', embeddingTextHash: INPUT_HASH, operation,
    model: 'text-embedding-3-small', embeddingText: TEXT, sourceFactsHash: FACTS,
    ...(operation === 'upsert' ? { values, vectorBytesSha256: bytesHash(values) } : {}) };
  let stored = null; let captured; let upserts = 0; let deletes = 0; let reads = 0; let loads = 0;
  const adapters = {
    async loadPayload() { loads++; return structuredClone(payload); },
    async upsert(vector) { upserts++; captured = structuredClone(vector); stored = structuredClone(vector); return { reference: `synthetic-upsert-${upserts}` }; },
    async delete(id) { assert.equal(id, UUID); deletes++; stored = null; return { reference: `synthetic-delete-${deletes}` }; },
    async readback(id) { assert.equal(id, UUID); reads++; return structuredClone(stored); },
  };
  return { sqlite, db, payload, adapters, advance(ms = 5000) { clock += ms; }, now: () => clock, setBeforeRun(fn) { beforeRun = fn; },
    setStored(value) { stored = structuredClone(value); }, getStored: () => stored, getCaptured: () => captured,
    counts: () => ({ upserts, deletes, reads, loads }), close: () => sqlite.close(),
    drain: (overrides = {}) => drainVectorOutbox({ db, catalogRevision: 'r1', adapters, now: () => clock, ...overrides }),
    row: () => ({ ...sqlite.prepare('SELECT * FROM vector_sync_outbox WHERE sequence=1').get() }) };
}

test('original UUID/native bytes/model/input metadata are preserved, and duplicate retries do no new work', async () => {
  const f = await setup();
  try {
    const result = await f.drain();
    assert.equal(result.outcomes[0].outcome, 'complete'); assert.equal(result.pending, 0);
    assert.equal(f.getCaptured().id, UUID);
    assert.deepEqual(f.getCaptured().values, f.payload.values);
    assert.equal(bytesHash(f.getCaptured().values), f.payload.vectorBytesSha256);
    assert.equal(f.getCaptured().metadata.embeddingTextHash, INPUT_HASH);
    assert.equal(f.getCaptured().metadata.embeddingModel, 'text-embedding-3-small');
    assert.equal(f.row().status, 'complete'); assert.ok(f.row().completed_at);
    const counts = f.counts(); assert.deepEqual((await f.drain()).outcomes, []); assert.deepEqual(f.counts(), counts);
  } finally { f.close(); }
});

test('accepted but invisible remains pending; retry reads visibility without another upsert', async () => {
  const f = await setup(); let accepted;
  try {
    f.adapters.upsert = async vector => { accepted = structuredClone(vector); return { reference: 'accepted-not-visible' }; };
    const first = await f.drain();
    assert.equal(first.outcomes[0].errorCode, 'not_visible'); assert.equal(f.row().status, 'pending');
    assert.equal(f.row().mutation_reference, 'accepted-not-visible'); assert.equal(f.row().completed_at, null);
    assert.deepEqual((await f.drain()).outcomes, []); // Cooldown, no tight polling.
    f.advance(); f.setStored(accepted);
    f.adapters.upsert = async () => { throw new Error('Retry must not resend accepted mutation'); };
    assert.equal((await f.drain()).outcomes[0].outcome, 'complete'); assert.equal(f.row().attempts, 2);
  } finally { f.close(); }
});

test('provider failure/timeout is sanitized, retryable and capped at three attempts', async () => {
  const f = await setup(); let calls = 0;
  try {
    f.adapters.upsert = async () => { calls++; throw new Error('FAKE_SECRET_PROVIDER_BODY'); };
    for (let i = 0; i < 3; i++) {
      const result = await f.drain(); assert.equal(result.outcomes[0].errorCode, 'provider_failed');
      assert.doesNotMatch(JSON.stringify(result), /FAKE_SECRET/); f.advance();
    }
    const exhausted = await f.drain(); assert.equal(calls, 3); assert.equal(exhausted.exhausted, 1); assert.equal(exhausted.pending, 1);
    assert.equal(f.row().status, 'pending');
  } finally { f.close(); }
  const timeout = await setup();
  try {
    timeout.adapters.loadPayload = (_event, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT')), { once: true }));
    assert.equal((await timeout.drain({ timeoutMs: 10 })).outcomes[0].errorCode, 'timeout');
    assert.equal(timeout.row().status, 'pending'); assert.equal(timeout.counts().upserts, 0);
  } finally { timeout.close(); }
});

test('failure before acceptance can recover with the same immutable original payload', async () => {
  const f = await setup(); const upsert = f.adapters.upsert;
  try {
    f.adapters.upsert = async () => { throw new Error('synthetic-provider-failure'); };
    await f.drain(); f.advance(); f.adapters.upsert = upsert;
    assert.equal((await f.drain()).outcomes[0].outcome, 'complete');
    assert.deepEqual(f.getCaptured().values, f.payload.values);
  } finally { f.close(); }
});

test('readback failure after acceptance keeps its receipt and pending work for a non-mutating retry', async () => {
  const f = await setup(); const readback = f.adapters.readback; let reads = 0;
  try {
    f.adapters.readback = async id => { if (++reads === 2) throw new Error('PRIVATE_READBACK_BODY'); return readback(id); };
    const first = await f.drain();
    assert.equal(first.outcomes[0].errorCode, 'provider_failed'); assert.doesNotMatch(JSON.stringify(first), /PRIVATE_READBACK/);
    assert.equal(f.row().status, 'pending'); assert.equal(f.row().mutation_reference, 'synthetic-upsert-1');
    f.advance(); f.adapters.readback = readback;
    assert.equal((await f.drain()).outcomes[0].outcome, 'complete'); assert.equal(f.counts().upserts, 1);
  } finally { f.close(); }
});

test('malformed/mismatched identity, revision, input text/model/facts, checksum and vector values refuse before mutation', async () => {
  for (const mutate of [
    payload => { payload.publicId = 'other-id'; }, payload => { payload.catalogRevision = 'r2'; },
    payload => { payload.embeddingText = 'changed original input'; }, payload => { payload.embeddingTextHash = 'b'.repeat(64); },
    payload => { payload.model = 'different-model'; }, payload => { payload.sourceFactsHash = 'b'.repeat(64); },
    payload => { payload.vectorBytesSha256 = 'b'.repeat(64); }, payload => { payload.values = [1, 2]; },
    payload => { payload.values[0] = NaN; }, payload => { payload.values[0] = .1; }, payload => { delete payload.values[0]; },
  ]) {
    const f = await setup();
    try { mutate(f.payload); const result = await f.drain();
      assert.equal(result.outcomes[0].errorCode, 'payload_invalid'); assert.equal(f.counts().upserts, 0); assert.equal(f.row().status, 'pending');
    } finally { f.close(); }
  }
});

test('unproven legacy hashes, stale revisions and wrong desired operations never mutate the index', async () => {
  for (const sql of ["UPDATE products SET embedding_text_hash=NULL", "UPDATE products SET catalog_revision='newer'",
    'UPDATE products SET public_display_json=NULL', "UPDATE products SET editorial_source_hash='changed'"]) {
    const f = await setup();
    try { f.sqlite.exec(sql); assert.equal((await f.drain()).outcomes[0].errorCode, 'current_state_changed'); assert.equal(f.counts().upserts, 0); }
    finally { f.close(); }
  }
  const f = await setup('delete');
  try { f.sqlite.exec('UPDATE products SET is_active=1');
    // Invalid/missing display remains held; now restore a valid active projection explicitly.
    const active = await setup();
    try { f.sqlite.prepare('UPDATE products SET public_display_json=?').run(active.sqlite.prepare('SELECT public_display_json FROM products').get().public_display_json); }
    finally { active.close(); }
    assert.equal((await f.drain()).outcomes[0].errorCode, 'current_state_changed'); assert.equal(f.counts().deletes, 0);
  } finally { f.close(); }
});

test('metadata mismatch or changed float32 bits cannot complete merely from mutation acceptance', async () => {
  for (const mismatch of [
    vector => { vector.metadata.catalogRevision = 'wrong'; }, vector => { vector.metadata.eligible = false; },
    vector => { vector.values[1] = 0; }, vector => { vector.values[0] = 0; },
  ]) {
    const f = await setup();
    try { f.adapters.upsert = async vector => { mismatch(vector); f.setStored(vector); return { reference: 'accepted' }; };
      assert.equal((await f.drain()).outcomes[0].errorCode, 'not_visible'); assert.equal(f.row().status, 'pending');
    } finally { f.close(); }
  }
});

test('current product changes during loading or immediately before completion are fenced', async () => {
  for (const phase of ['load', 'complete']) {
    const f = await setup();
    try {
      if (phase === 'load') f.adapters.loadPayload = async () => { f.sqlite.exec("UPDATE products SET source_facts_hash='changed'"); return f.payload; };
      else f.setBeforeRun(sql => { if (sql.includes("SET status='complete'")) f.sqlite.exec("UPDATE products SET updated_at='later-change'"); });
      assert.equal((await f.drain()).outcomes[0].errorCode, 'current_state_changed'); assert.equal(f.row().status, 'pending');
      if (phase === 'load') assert.equal(f.counts().upserts, 0);
    } finally { f.close(); }
  }
});

test('an expired owner cannot complete after takeover, even with exact visible bytes', async () => {
  const f = await setup(); let inner; let originalToken; let takeover = false; const readback = f.adapters.readback;
  try {
    f.adapters.readback = async id => {
      if (!takeover) {
        takeover = true; originalToken = f.row().lease_token; f.advance(60_000);
        inner = await f.drain();
      }
      return readback(id);
    };
    const outer = await f.drain();
    assert.equal(inner.outcomes[0].outcome, 'complete'); assert.notEqual(outer.outcomes[0].outcome, 'complete');
    assert.equal(f.row().status, 'complete'); assert.notEqual(f.row().lease_token, originalToken);
  } finally { f.close(); }
});

test('delete requires exact verified absence; acceptance alone stays pending and retry does not resend', async () => {
  const f = await setup('delete'); let deletes = 0;
  try {
    f.setStored({ id: UUID, values: Array(1536).fill(1), metadata: { catalogRevision: 'prior' } });
    f.adapters.delete = async id => { assert.equal(id, UUID); deletes++; return { reference: 'delete-accepted' }; };
    assert.equal((await f.drain()).outcomes[0].errorCode, 'not_visible'); assert.equal(f.row().status, 'pending');
    f.advance(); f.setStored(null);
    assert.equal((await f.drain()).outcomes[0].outcome, 'complete'); assert.equal(deletes, 1);
  } finally { f.close(); }
});

test('verified initial delete absence needs no mutation, and malformed acceptance receipts cannot complete', async () => {
  const absent = await setup('delete');
  try {
    assert.equal((await absent.drain()).outcomes[0].outcome, 'complete'); assert.equal(absent.counts().deletes, 0);
  } finally { absent.close(); }
  const invalid = await setup();
  try {
    invalid.adapters.upsert = async () => ({ reference: 123 });
    assert.equal((await invalid.drain()).outcomes[0].errorCode, 'provider_failed');
    assert.equal(invalid.row().status, 'pending'); assert.equal(invalid.row().mutation_reference, null);
  } finally { invalid.close(); }
});

test('explicit revision and batch bounds are enforced without embedding/network generation', async () => {
  const f = await setup();
  try {
    for (const options of [{ maxEvents: 0 }, { maxEvents: 11 }, { catalogRevision: '' }, { catalogRevision: 'x'.repeat(65) }])
      await assert.rejects(f.drain(options), /invalid_vector_drain_bound/);
    f.sqlite.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at) VALUES(?,?,?,?,?)`)
      .run('malformed-future-event', 'r1', INPUT_HASH, 'upsert', new Date(NOW).toISOString());
    assert.equal((await f.drain({ maxEvents: 1 })).outcomes.length, 1);
    assert.equal(f.sqlite.prepare('SELECT attempts FROM vector_sync_outbox WHERE sequence=2').get().attempts, 0);
    assert.deepEqual((await f.drain({ catalogRevision: 'other-revision' })).outcomes, []);
    assert.deepEqual(f.getCaptured().values, f.payload.values); // Supplied original vector, never generated.
  } finally { f.close(); }
});
