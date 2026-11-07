import assert from 'node:assert/strict';
import test from 'node:test';
import { runLocalBurst } from '../scripts/staging/local-burst.mts';

test('local rehearsal uses actual Worker95/5 dispatch with no network and bounded fake search calls', async () => {
  const result = await runLocalBurst(1);
  assert.equal(result.requests, 100); assert.equal(result.errors, 0); assert.equal(result.networkAttempts, 0);
  assert.equal(result.latencyMs.static.count, 95); assert.equal(result.latencyMs.mockSearch.count, 5);
  assert.deepEqual(result.mix, { static: 95, mockSemantic: 5 });
  assert.equal(result.adapters.ids, 5); assert.equal(result.adapters.embeddings, 5); assert.equal(result.adapters.vectors, 5);
  assert.equal(result.adapters.keyword, 5); assert.ok(result.elapsedMs >= 1000); assert.equal(result.probes.passed, true);
  assert.equal(result.probes.initialCards, 24);
  assert.deepEqual(result.checks, { adapterCounts: true, noNetwork: true });
  assert.ok(result.limitations.some(value => value.includes('not D1 SQL')));
});
test('local rehearsal rejects unbounded/ambiguous durations before doing work', async () => {
  for (const seconds of [0, -1, .5, 601, NaN]) await assert.rejects(runLocalBurst(seconds), /Duration/);
});
