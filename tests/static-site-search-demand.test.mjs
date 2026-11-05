import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { searchDemandTopic, isSearchDemandObservation } from '../lib/search-demand.ts';
import { createSearchDemandTracker } from '../lib/search-demand-tracker.ts';
import { recordSearchDemand } from '../workers/site/search-demand.ts';
import { searchDemandReportSql } from '../scripts/ops/search-demand-report.mjs';

const NOW = Date.now();
const ID = '7a2262dc-ac57-42a7-970f-611cf880234c';
const observation = (change = {}) => ({ schemaVersion: 1, id: ID, topic: 'cat gifts',
  outcome: 'results', resultCount: 3, selectedRank: null, ...change });

function tracker() {
  const sent = [], timers = new Map(); let id = 0, allowed = true;
  const instance = createSearchDemandTracker({ isAllowed: () => allowed,
    id: () => `${++id}`, send: value => sent.push(value),
    later: (callback, ms) => { assert.equal(ms, 1500); timers.set(id, callback); return id; },
    cancel: timer => timers.delete(timer),
  });
  return { instance, sent, timers, allow(value) { allowed = value; },
    tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}

test('normalization preserves useful topics but suppresses obvious private/oversized input', () => {
  assert.equal(searchDemandTopic('  Cat   mugs! '), 'cat mugs');
  assert.equal(searchDemandTopic('ＣＡＴ gifts'), 'cat gifts');
  assert.equal(searchDemandTopic('cadeau drôle'), 'cadeau drôle');
  for (const value of ['x', '', 'a'.repeat(81), 'cat '.repeat(13), 'me@example.com', 'https://example.com',
    'www.example.com', 'example.com', '@myhandle', 'call 555 123 4567', '555-123-4567',
    'social security 123', 'password gift', 'cat\nmug', '<script>cat</script>', '123'])
    assert.equal(searchDemandTopic(value), null, value);
});

test('strict wire schema accepts only current bounded observations', () => {
  assert.equal(isSearchDemandObservation(observation()), true);
  assert.equal(isSearchDemandObservation(observation({ resultCount: 0 })), true);
  assert.equal(isSearchDemandObservation(observation({ outcome: 'unavailable', resultCount: null })), true);
  for (const change of [{ id: 'bad' }, { rawQuery: 'private' }, { topic: 'Cat Gifts' }, { topic: 'a@b.com' },
    { resultCount: null }, { resultCount: 37 }, { resultCount: 0.5 }, { selectedRank: 4 },
    { outcome: 'unavailable' }, { resultCount: 0, selectedRank: 1 }])
    assert.equal(isSearchDemandObservation(observation(change)), false, JSON.stringify(change));
});

test('only settled results survive edits; explicit submit, repeated submit and selection deduplicate', () => {
  const t = tracker();
  t.instance.begin('ca'); t.instance.complete(12); t.instance.edit(); t.tick();
  assert.equal(t.sent.length, 0);
  t.instance.begin('cat gifts'); t.instance.complete(3); t.tick();
  assert.equal(t.sent.length, 1);
  t.instance.begin('cat gifts', true); t.instance.complete(3); t.tick();
  assert.equal(t.sent.length, 1, 'Enter after automatic completion is not a second search');
  t.instance.select(2); t.instance.select(1);
  assert.equal(t.sent.length, 2);
  assert.equal(t.sent[0].id, t.sent[1].id);
  assert.equal(t.sent[1].selectedRank, 2, 'only the first choice is recorded');
  t.instance.edit(); t.instance.begin('cat gifts', true); t.instance.complete(0);
  assert.equal(t.sent.length, 3, 'a genuinely new interaction can repeat the same topic');
});

test('a click can settle results early; errors are not empty results; dispose cancels timers', () => {
  const t = tracker();
  t.instance.begin('cat'); t.instance.complete(2); t.instance.select(1); t.tick();
  assert.equal(t.sent.length, 1); assert.equal(t.sent[0].selectedRank, 1);
  t.instance.begin('fishing', true); t.instance.complete(null);
  assert.equal(t.sent[1].outcome, 'unavailable'); assert.equal(t.sent[1].resultCount, null);
  t.instance.begin('fishing', true); t.instance.complete(0);
  assert.equal(t.sent[2].outcome, 'results'); assert.equal(t.sent[2].resultCount, 0);
  t.instance.begin('pickles'); t.instance.complete(3); t.instance.dispose(); t.tick();
  assert.equal(t.sent.length, 3);
});

test('privacy is rechecked at completion, timeout and click; analytics startup need not precede search', () => {
  const t = tracker();
  t.allow(false); t.instance.begin('cat'); t.allow(true); t.instance.complete(2); t.tick();
  assert.equal(t.sent.length, 1);
  t.instance.edit(); t.instance.begin('fishing'); t.instance.complete(2); t.allow(false); t.tick();
  t.instance.select(1); assert.equal(t.sent.length, 1);
  t.instance.begin('pickle'); t.instance.complete(3); t.allow(true); t.tick();
  assert.equal(t.sent.length, 1, 'no delayed collection for a completed opted-out query');
});

function storage() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../migrations/d1/0017_search_demand.sql', import.meta.url), 'utf8'));
  let writes = 0;
  return { db, writes: () => writes,
    binding: { prepare(sql) { return { sql, values: [], bind(...values) { this.values = values; return this; } }; },
      async batch(statements) {
        writes++; db.exec('BEGIN');
        try { const results = statements.map(s => db.prepare(s.sql).run(...s.values)); db.exec('COMMIT'); return results; }
        catch (error) { db.exec('ROLLBACK'); throw error; }
      } },
  };
}
function request(body = observation(), headers = {}, method = 'POST', url = 'https://stupid.gifts/api/search-demand') {
  return new Request(url, { method, headers: { Origin: 'https://stupid.gifts', 'Content-Type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
const env = db => ({ ENVIRONMENT: 'production', DB: db });

test('real SQLite migration/upsert handles repeats, out-of-order clicks and immutable original expiry', async () => {
  const f = storage();
  try {
    // Click can arrive before the separate initial observation.
    assert.equal((await recordSearchDemand(request(observation({ selectedRank: 2 })), env(f.binding), NOW)).status, 204);
    await recordSearchDemand(request(), env(f.binding), NOW + 86400000);
    await recordSearchDemand(request(), env(f.binding), NOW + 86400000);
    const rows = f.db.prepare('SELECT * FROM search_demand').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].selected_rank, 2);
    assert.equal(rows[0].day, new Date(NOW).toISOString().slice(0, 10));
    assert.equal(rows[0].expires_at, Math.floor(NOW / 1000) + 30 * 86400);
    await recordSearchDemand(request(observation({ topic: 'other topic' })), env(f.binding), NOW);
    assert.equal(f.db.prepare('SELECT topic FROM search_demand').get().topic, 'cat gifts');
    assert.deepEqual(Object.keys(rows[0]).sort(), ['day','expires_at','id','outcome','result_count','selected_rank','topic']);
  } finally { f.db.close(); }
});

test('endpoint rejects foreign/malformed input and respects privacy headers without writing', async () => {
  const f = storage();
  try {
    for (const r of [request({}, { Origin: 'https://evil.example' }), request({}, { Origin: '' }),
      request({}, {}, 'GET'), request('bad JSON'), request('x'.repeat(1025)),
      request(observation({ rawQuery: 'secret' })), request(observation({ topic: 'me@example.com' })),
      request({}, { 'Content-Type': 'text/plain' }), request({}, {}, 'POST', 'https://preview.example/api/search-demand')]) {
      assert.ok((await recordSearchDemand(r, env(f.binding), NOW)).status >= 400);
    }
    for (const headers of [{ DNT: '1' }, { 'Sec-GPC': '1' }])
      assert.equal((await recordSearchDemand(request({}, headers), env(f.binding), NOW)).status, 204);
    assert.equal((await recordSearchDemand(request(), { ...env(f.binding), ENVIRONMENT: 'staging' }, NOW)).status, 403);
    assert.equal(f.writes(), 0);
  } finally { f.db.close(); }
});

test('storage/missing migration failures stay isolated and never echo query/provider errors', async () => {
  const bad = { prepare() { throw new Error('secret topic or database error'); } };
  for (const binding of [undefined, bad]) {
    const response = await recordSearchDemand(request(), env(binding), NOW);
    assert.equal(response.status, 503); assert.equal(await response.text(), '');
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
});

test('slow telemetry bodies time out and cannot dispatch a late database write', async () => {
  const f = storage(); let cancelled = false;
  const slow = new ReadableStream({ cancel() { cancelled = true; } });
  try {
    const r = new Request('https://stupid.gifts/api/search-demand', { method: 'POST', duplex: 'half', body: slow,
      headers: { Origin: 'https://stupid.gifts', 'Content-Type': 'application/json' } });
    assert.equal((await recordSearchDemand(r, env(f.binding), NOW)).status, 503);
    await new Promise(setImmediate);
    assert.equal(cancelled, true); assert.equal(f.writes(), 0);
  } finally { f.db.close(); }
});

test('expired rows are excluded/deleted; report distinguishes empty, error, sparse and selection', async () => {
  const f = storage();
  try {
    const events = [observation(), observation({ id: ID.replace(/^7/, '8'), resultCount: 0 }),
      observation({ id: ID.replace(/^7/, '9'), resultCount: null, outcome: 'unavailable' })];
    for (const event of events) await recordSearchDemand(request(event), env(f.binding), NOW);
    await recordSearchDemand(request(observation({ selectedRank: 2 })), env(f.binding), NOW);
    const report = f.db.prepare(searchDemandReportSql(7)).all();
    assert.equal(report.length, 1);
    assert.equal(report[0].observations, 3); assert.equal(report[0].completed_searches, 2);
    assert.equal(report[0].unavailable_searches, 1); assert.equal(report[0].zero_result_searches, 1);
    assert.equal(report[0].sparse_searches, 1); assert.equal(report[0].searches_with_selection, 1);
    assert.equal(report[0].zero_result_rate_pct, 50); assert.equal(report[0].sparse_result_rate_pct, 50);
    assert.equal(report[0].selection_rate_pct, 100); assert.equal(report[0].average_selected_rank, 2);
    f.db.prepare('UPDATE search_demand SET expires_at=0').run();
    assert.equal(f.db.prepare(searchDemandReportSql()).all().length, 0);
    await recordSearchDemand(request(observation({ id: ID.replace(/^7/, 'a') })), env(f.binding), NOW);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM search_demand').get().n, 1);
    assert.throws(() => searchDemandReportSql(31)); assert.throws(() => searchDemandReportSql('7; DROP TABLE products'));
  } finally { f.db.close(); }
});
