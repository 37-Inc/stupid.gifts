import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { createSearchDemandTracker } from '../lib/search-demand-tracker.ts';

function browser(allowed = true) {
  const requests = [], timers = new Map(); let next = 0;
  const source = fs.readFileSync(new URL('../static-site/lib/search-demand.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022 } }).outputText;
  const commonJs = { exports: {} };
  vm.runInNewContext(compiled, { module: commonJs, exports: commonJs.exports, AbortController,
    crypto: { randomUUID: () => '7a2262dc-ac57-42a7-970f-611cf880234c' },
    window: { setTimeout(fn, ms) { timers.set(++next, { fn, ms }); return next; },
      clearTimeout(id) { timers.delete(id); },
      get localStorage() { throw new Error('No browser storage'); } },
    fetch(url, options) { requests.push({ url, options }); return Promise.reject(new Error('offline')); },
    require(name) {
      if (name === '../../lib/search-demand-tracker') return { createSearchDemandTracker };
      if (name === './analytics') return { isSearchDemandAllowed: () => allowed };
      throw new Error(`Unexpected provider dependency ${name}`);
    },
  });
  return { tracker: commonJs.exports.createBrowserSearchDemand(), requests, timers,
    tick() { for (const [id, { fn, ms }] of [...timers]) if (ms === 1500) { timers.delete(id); fn(); } } };
}

test('browser adapter sends only the first-party observation, without cookies/referrer, and swallows transport failure', async () => {
  const b = browser();
  b.tracker.begin('Cat gifts!'); b.tracker.complete(3); b.tick();
  assert.equal(b.requests.length, 1);
  const { url, options } = b.requests[0];
  assert.equal(url, '/api/search-demand'); assert.equal(options.credentials, 'omit');
  assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.keepalive, true);
  assert.deepEqual(JSON.parse(options.body), { schemaVersion: 1, id: '7a2262dc-ac57-42a7-970f-611cf880234c',
    topic: 'cat gifts', outcome: 'results', resultCount: 3, selectedRank: null });
  await new Promise(setImmediate);
  assert.equal(b.timers.size, 0, 'failed request releases its timeout');
});

test('blocked/privacy/QA policy sends nothing; unmount and edits cancel collection', () => {
  const b = browser(false);
  b.tracker.begin('cat'); b.tracker.complete(3); b.tick(); assert.equal(b.requests.length, 0);
  const c = browser();
  c.tracker.begin('cat'); c.tracker.complete(3); c.tracker.edit(); c.tick();
  c.tracker.begin('fishing'); c.tracker.complete(3); c.tracker.dispose(); c.tick();
  assert.equal(c.requests.length, 0);
});

test('telemetry dependency failures cannot escape into a successful search or native link action', () => {
  const base = { isAllowed: () => true, id: () => 'id', later: () => 1, cancel() {}, send() {} };
  for (const method of ['isAllowed', 'id', 'later', 'send', 'cancel']) {
    const tracker = createSearchDemandTracker({ ...base, [method]() { throw new Error('blocked'); } });
    assert.doesNotThrow(() => { tracker.begin('cat'); tracker.complete(3); tracker.select(1); tracker.edit(); tracker.dispose(); });
  }
});
