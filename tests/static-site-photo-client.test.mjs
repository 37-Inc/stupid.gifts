import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as photos from '../static-site/lib/photo-shard.ts';
import * as presentation from '../static-site/lib/product-presentation.ts';
import * as descriptions from '../static-site/lib/card-description.ts';

const version = 'a'.repeat(64), indexPath = `/catalog/${version}/photos.json`;
const deadline = new Date(5000).toISOString(), first = 'TEST-PHOTO-1', second = 'TEST-PHOTO-2';
const image = id => `https://supplier.invalid/synthetic-${id}.jpg`;
const source = readFileSync(new URL('../static-site/components/CatalogPhotos.tsx', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} });
const flush = () => new Promise(setImmediate);
function client(serve = async (_path, body) => body, json = true, initialIndex) {
  const index = { schemaVersion: 1, status: 'ready', version, products: Object.fromEntries(
    [first, second].map(id => [id, { shard: 1, eligibleUntil: deadline }])) };
  const shard = { schemaVersion: 1, status: 'ready', version, eligibleUntil: deadline,
    images: Object.fromEntries([first, second].map(id => [id, { imageUrl: image(id), eligibleUntil: deadline }])) };
  const embedded = initialIndex?.(structuredClone(index));
  const slots = new Map(), timers = new Map(), listeners = new Map(), calls = [];
  let clock = 1000, sequence = 0, active, cursor, context, forbidden = 0, lateUpdates = 0;
  const deny = () => { forbidden++; throw new Error('Unexpected storage/provider access'); };
  const element = (type, props, key) => ({ type, props, key: key ?? props?.key });
  const listen = (name, fn) => { const set = listeners.get(name) || new Set(); set.add(fn); listeners.set(name, set); };
  const unlisten = (name, fn) => { listeners.get(name)?.delete(fn); if (!listeners.get(name)?.size) listeners.delete(name); };
  const cleanup = fiber => { fiber.alive = false; for (const effect of fiber.effects) effect?.cleanup?.(); };
  const react = { createElement: element, createContext: () => ({}), useContext: () => context,
    useState(initial) {
      const fiber = active, i = cursor++;
      if (!(i in fiber.values)) fiber.values[i] = initial;
      return [fiber.values[i], value => { if (!fiber.alive) { lateUpdates++; return; } fiber.values[i] = value; fiber.dirty = true; }];
    },
    useEffect(fn, deps) {
      const i = cursor++, old = active.effects[i];
      if (!old || deps.some((value, n) => !Object.is(value, old.deps[n]))) active.pending.push({ i, fn, deps });
    } };
  const commonJs = { exports: {} };
  vm.runInNewContext(outputText, { module: commonJs, exports: commonJs.exports, AbortController, TextEncoder, URL,
    Date: class extends Date { static now() { return clock; } },
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'mock-fragment' };
      if (name === '@/components/ProductImage') return { ProductImage: 'mock-image-no-network' };
      if (name === './Icon') return { Icon: 'mock-decorative-icon' };
      if (name === '../lib/photo-shard') return photos;
      if (name === '../lib/product-presentation') return presentation;
      if (name === '../lib/card-description') return descriptions;
      throw new Error('Unexpected photo client dependency');
    },
    fetch: async (path, options) => {
      calls.push(path);
      assert.match(path, /^\/catalog\/[a-f0-9]{64}\/photos(?:-[1-9][0-9]*)?\.json$/);
      assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
      assert.equal(options.referrerPolicy, 'no-referrer'); assert.ok(options.signal instanceof AbortSignal);
      return { ok: true, headers: { get: () => json ? 'application/json' : 'text/html' },
        text: async () => { const body = await serve(path, structuredClone(path.endsWith('/photos.json') ? index : shard));
          return typeof body === 'string' ? body : JSON.stringify(body); } };
    },
    window: { setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: clock + delay }); return id; },
      clearTimeout: id => timers.delete(id), addEventListener: listen, removeEventListener: unlisten,
      get localStorage() { return deny(); }, get sessionStorage() { return deny(); } },
    document: { addEventListener: listen, removeEventListener: unlisten, get cookie() { return deny(); } },
    navigator: { sendBeacon: deny, get credentials() { return deny(); } },
  });
  function render(name, props = { id: first, imageUrl: photos.PHOTO_PLACEHOLDER, alt: 'Synthetic fixture' }, path = indexPath) {
    context = { indexPath: path, photoSlots: [first, second], initialIndex: embedded };
    const outer = commonJs.exports.CatalogImage(props);
    let fiber = slots.get(name);
    if (!fiber || fiber.key !== outer.key) {
      if (fiber) cleanup(fiber);
      fiber = { key: outer.key, values: [], effects: [], alive: true }; slots.set(name, fiber);
    }
    Object.assign(fiber, { props, path, dirty: false, pending: [] }); active = fiber; cursor = 0;
    fiber.view = outer.type(outer.props); active = undefined;
    for (const { i, fn, deps } of fiber.pending) { fiber.effects[i]?.cleanup?.(); fiber.effects[i] = { deps, cleanup: fn() }; }
    return fiber.view.props.imageUrl;
  }
  const api = { render, calls, clock(value) { clock = value; },
    async flush() { for (let i = 0; i < 8; i++) { await flush();
      for (const [name, fiber] of slots) if (fiber.dirty) render(name, fiber.props, fiber.path); } },
    url(name) { return slots.get(name).view.props.imageUrl; },
    alt(name) { return slots.get(name).view.props.alt; },
    placeholder(name) { return slots.get(name).view.props.placeholder; },
    async expire(trigger) { clock = 5000;
      if (trigger === 'timer') { for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } }
      else for (const fn of [...(listeners.get(trigger) || [])]) fn();
      await api.flush();
    },
    close() { for (const fiber of slots.values()) cleanup(fiber); slots.clear();
      assert.equal(listeners.size, 0); assert.equal(forbidden, 0); assert.equal(lateUpdates, 0);
      assert.ok(calls.every(path => path.startsWith('/catalog/'))); },
  };
  return api;
}
const props = (id = first, imageUrl = photos.PHOTO_PLACEHOLDER) => ({ id, imageUrl, alt: 'Synthetic fixture' });

test('multiple images share one index and shard request; no provider/storage calls occur', async () => {
  const ui = client(); ui.render('one'); ui.render('two', props(second)); await ui.flush();
  assert.equal(ui.url('one'), image(first)); assert.equal(ui.url('two'), image(second));
  assert.deepEqual(ui.calls, [indexPath, `/catalog/${version}/photos-1.json`]); ui.close();
});

test('placeholder is decorative until the original finite overlay is verified, and again after expiry', async () => {
  const ui = client(); ui.render('one'); assert.equal(ui.alt('one'), '');
  assert.equal(ui.placeholder('one'), 'loading');
  await ui.flush(); assert.equal(ui.alt('one'), 'Synthetic fixture');
  assert.equal(ui.placeholder('one'), undefined);
  await ui.expire('timer'); assert.equal(ui.alt('one'), '');
  assert.equal(ui.placeholder('one'), 'unavailable');
  assert.equal(ui.url('one'), photos.PHOTO_PLACEHOLDER); ui.close();
});

test('a supplier URL is never shown when either index or shard I/O crosses its deadline', async () => {
  for (const stage of ['index', 'shard']) {
    let ui; ui = client(async (path, body) => { if (path.endsWith('/photos.json') === (stage === 'index')) ui.clock(5000); return body; });
    ui.render('one'); await ui.flush(); assert.equal(ui.url('one'), photos.PHOTO_PLACEHOLDER);
    assert.equal(ui.placeholder('one'), 'unavailable'); ui.close();
  }
});

test('timer, pageshow and visibility restoration expire the photo, not the persistent listing', async () => {
  for (const trigger of ['timer', 'pageshow', 'visibilitychange']) {
    const ui = client(); ui.render('one'); await ui.flush(); assert.equal(ui.url('one'), image(first));
    await ui.expire(trigger); assert.equal(ui.url('one'), photos.PHOTO_PLACEHOLDER);
    assert.equal(ui.calls.length, 2); ui.close();
  }
});

test('identity, version and fallback-image key changes immediately discard a previous product photo', async () => {
  for (const [next, path] of [[props(second), indexPath], [props(), `/catalog/${'b'.repeat(64)}/photos.json`],
    [props(first, '/images/another-owned.svg'), indexPath]]) {
    const ui = client(); ui.render('one'); await ui.flush(); assert.equal(ui.url('one'), image(first));
    assert.equal(ui.render('one', next, path), next.imageUrl); await ui.flush();
    assert.notEqual(ui.url('one'), image(first)); ui.close();
  }
  let release; const deferred = new Promise(resolve => { release = resolve; });
  const ui = client(async (path, body) => { if (!path.endsWith('/photos.json')) await deferred; return body; });
  ui.render('one'); await ui.flush(); ui.render('one', props(second)); release(); await ui.flush();
  assert.equal(ui.url('one'), image(second)); ui.close();
});

test('unavailable, malformed, mismatched-release and invalid photo payloads fail closed', async () => {
  for (const transform of [() => ({ status: 'unavailable' }), () => '{invalid-json',
    (_p, body) => ({ ...body, version: 'b'.repeat(64) }),
    (path, body) => path.endsWith('/photos.json') ? body : { status: 'unavailable' },
    (path, body) => path.endsWith('/photos.json') ? body : '{invalid-json',
    (path, body) => path.endsWith('/photos.json') ? body : { ...body, version: 'b'.repeat(64) },
    (_p, body) => ({ ...body, privateField: 'must-not-be-cached' }),
    (path, body) => path.endsWith('/photos.json') ? body : { ...body, images: { [first]: { imageUrl: '/not-a-supplier-url', eligibleUntil: deadline } } },
    (path, body) => path.endsWith('/photos.json') ? body : { ...body, images: { [second]: body.images[second] } },
    (path, body) => path.endsWith('/photos.json') ? body : { ...body, eligibleUntil: new Date(6000).toISOString(),
      images: { [first]: { imageUrl: image(first), eligibleUntil: new Date(6000).toISOString() } } },
    (path, body) => path.endsWith('/photos.json') ? { ...body, products: { [first]: { shard: 'https://outside.invalid', eligibleUntil: deadline } } } : body,
  ]) { const ui = client(async (path, body) => transform(path, body)); ui.render('one'); await ui.flush();
    assert.equal(ui.url('one'), photos.PHOTO_PLACEHOLDER); ui.close(); }
  const ui = client(undefined, false); ui.render('one'); await ui.flush(); assert.equal(ui.url('one'), photos.PHOTO_PLACEHOLDER); ui.close();
});

test('only versioned local JSON reads are allowed; unmounted images cannot receive late photos', async () => {
  for (const path of ['https://outside.invalid/photos.json', '//outside.invalid/photos.json', '/api/photos.json', null]) {
    const ui = client(); ui.render('one', props(), path); await ui.flush(); assert.equal(ui.calls.length, 0); ui.close();
  }
  let release; const deferred = new Promise(resolve => { release = resolve; });
  const ui = client(async (_path, body) => { await deferred; return body; }); ui.render('one'); ui.close();
  release(); await ui.flush(); assert.deepEqual(ui.calls, [indexPath, `/catalog/${version}/photos-1.json`]); ui.close();
});


test('initial URL-free hints skip the index request, preserve expiry, and later products use the normal fallback', async () => {
  const ui = client(undefined, true, index => ({ ...index, products: { [first]: index.products[first] } }));
  ui.render('one'); await ui.flush();
  assert.equal(ui.url('one'), image(first));
  assert.deepEqual(ui.calls, [`/catalog/${version}/photos-1.json`]);
  ui.render('two', props(second)); await ui.flush();
  assert.equal(ui.url('two'), image(second));
  assert.deepEqual(ui.calls, [`/catalog/${version}/photos-1.json`, indexPath]);
  await ui.expire('timer');
  assert.equal(ui.placeholder('one'), 'unavailable');
  assert.equal(ui.placeholder('two'), 'unavailable');
  ui.close();
});

test('mismatched initial photo hints fail closed without requesting a supplier image', async () => {
  const ui = client(undefined, true, index => ({ ...index, version: 'b'.repeat(64) }));
  ui.render('one'); await ui.flush();
  assert.equal(ui.placeholder('one'), 'unavailable');
  assert.deepEqual(ui.calls, []); ui.close();
});
