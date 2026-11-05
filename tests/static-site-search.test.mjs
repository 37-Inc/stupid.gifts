import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function search(href, query = "desk", resultState, fetchOverride) {
  const effects = [];
  const events = new Map();
  const pushed = [];
  const requests = [];
  const dispatched = [];
  const telemetry = [];
  const timers = new Map();
  let nextTimer = 0;
  const location = { href, pathname: new URL(href).pathname, search: new URL(href).search };
  const remember = (_state, _title, path) => {
    pushed.push(path);
    const url = new URL(path, location.href);
    Object.assign(location, { href: url.href, pathname: url.pathname, search: url.search });
  };
  let scrolls = 0;
  const source = fs.readFileSync(new URL("../static-site/components/Search.tsx", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } });
  const commonJs = { exports: {} };
  vm.runInNewContext(outputText, {
    module: commonJs, exports: commonJs.exports, URL, URLSearchParams, AbortController, Event,
    require(name) {
      if (name === "react") return {
        useState: (initial) => [typeof initial === "string" ? query : resultState || initial, () => {}],
        useRef: (initial) => ({ current: initial }), useEffect: (effect) => effects.push(effect),
      };
      if (name === "./ProductCard") return { ProductCard: () => null };
      if (name === "../lib/analytics") return { captureRenderedLists() {}, captureStaticSearch() {} };
      if (name === "../lib/search-demand") return { createBrowserSearchDemand: () => ({
        begin(...args) { telemetry.push(['begin', ...args]); }, edit() { telemetry.push(['edit']); },
        complete(...args) { telemetry.push(['complete', ...args]); },
        select(...args) { telemetry.push(['select', ...args]); }, dispose() { telemetry.push(['dispose']); },
      }) };
      return name.startsWith(".") ? createRequire(new URL("../static-site/components/Search.tsx", import.meta.url))(name) : require(name);
    },
    fetch: async (url, options) => { requests.push({ url, signal: options.signal });
      if (fetchOverride) return fetchOverride(url, options);
      return { ok: true, json: async () => ({ results: [] }) }; },
    document: { getElementById: () => ({ scrollIntoView() { scrolls++; } }) },
    window: {
      location,
      setTimeout: (fn) => { timers.set(++nextTimer, fn); return nextTimer; },
      clearTimeout: (id) => timers.delete(id),
      history: { pushState: remember, replaceState: remember },
      dispatchEvent: (event) => { dispatched.push(event.type); },
      addEventListener: (name, listener) => events.set(name, listener),
      removeEventListener: (name) => events.delete(name),
    },
  });
  const view = commonJs.exports.Search({ children: "NORMAL BROWSE" });
  return { view, effects, events, pushed, requests, dispatched, timers, location, telemetry, scrolls: () => scrolls };
}

test("search telemetry observes only accepted current responses, cancels edits/unmount and follows history", async () => {
  let resolve;
  const ui = search('https://example.invalid/?q=desk', 'desk', undefined,
    () => new Promise(done => { resolve = done; }));
  const cleanup = ui.effects[0]();
  assert.deepEqual(ui.telemetry.map(row => [...row]), [['begin', 'desk', false]]);
  const input = ui.view.props.children[0].props.children[1];
  input.props.onChange({ target: { value: 'cat' } });
  assert.equal(ui.requests[0].signal.aborted, true);
  resolve({ ok: true, json: async () => ({ results: [] }) });
  await new Promise(setImmediate);
  assert.equal(ui.telemetry.some(row => row[0] === 'complete'), false, 'stale response cannot log a different query');
  ui.location.search = '?q=pickle';
  void ui.events.get('popstate')();
  resolve({ ok: true, json: async () => ({ results: [] }) });
  await new Promise(setImmediate);
  assert.deepEqual([...ui.telemetry.at(-1)], ['complete', 0]);
  cleanup(); assert.deepEqual([...ui.telemetry.at(-1)], ['dispose']);
});

test("unavailable searches are reported distinctly, not as zero matches", async () => {
  const ui = search('https://example.invalid/?q=desk', 'desk', undefined, async () => ({ ok: false }));
  const cleanup = ui.effects[0](); await new Promise(setImmediate);
  assert.deepEqual([...ui.telemetry.at(-1)], ['complete', null]); cleanup();
});

test("bookmarked queries and history reveal search; short queries do not move the product-first homepage", async () => {
  for (const query of ["desk", "d", ""]) {
    const ui = search(`https://example.invalid/?q=${query}`);
    const cleanup = ui.effects[0]();
    await new Promise(setImmediate);
    assert.equal(ui.scrolls(), query.length >= 2 ? 1 : 0);
    assert.equal(ui.requests.length, query.length >= 2 ? 1 : 0);
    ui.events.get("popstate")();
    await new Promise(setImmediate);
    assert.equal(ui.scrolls(), query.length >= 2 ? 2 : 0);
    if (query.length >= 2) assert.equal(ui.requests[0].signal.aborted, true);
    cleanup();
    assert.equal(ui.events.size, 0);
  }
});

test("search-as-you-type debounces, submit cancels pending work, and clear returns to browse", () => {
  const ui = search("https://example.invalid/", "mug");
  const form = ui.view.props.children[0];
  const [label, input, submit, clear] = form.props.children;
  assert.equal(label.type, "label"); assert.equal(submit.type, "button");
  input.props.onChange({ target: { value: "mu" } });
  input.props.onChange({ target: { value: "mug" } });
  assert.equal(ui.timers.size, 1); assert.equal(ui.pushed.length, 0);
  form.props.onSubmit({ preventDefault() {} });
  assert.equal(ui.timers.size, 0); assert.deepEqual(ui.pushed, ["/?q=mug"]);
  let focused = false;
  input.props.ref.current = { focus() { focused = true; } };
  clear.props.onClick();
  assert.deepEqual(ui.pushed, ["/?q=mug", "/"]);
  assert.equal(focused, true, "Clear returns keyboard focus to the input");
});

test("short input can be cleared and loading skeleton is decorative", () => {
  const short = search("https://example.invalid/", "m");
  assert.equal(short.view.props.children[0].props.children[3].props.children, "Clear");
  const ui = search("https://example.invalid/?q=mug", "mug", { status: "loading", products: [] });
  const skeleton = ui.view.props.children.find(child => child?.props?.className === "catalog-grid search-skeleton");
  assert.equal(skeleton.props["aria-hidden"], "true");
});

test("empty and unavailable searches expose browse recovery; retry preserves query", () => {
  for (const status of ["ready", "unavailable"]) {
    const ui = search("https://example.invalid/?q=mug", "mug", { status, products: [] });
    const recovery = ui.view.props.children.find(child => child?.props?.className === "search-recovery");
    const [retry, browse] = recovery.props.children;
    assert.equal(browse.props.children, "Browse all gifts");
    assert.equal(Boolean(retry), status === "unavailable");
    if (retry) {
      retry.props.onClick();
      assert.equal(ui.location.search, "?q=mug");
      assert.deepEqual(ui.pushed, [], "Retry keeps the current search history entry");
      assert.deepEqual(ui.dispatched, ["catalog-search"], "Retry actually starts another search");
    }
    browse.props.onClick();
    assert.deepEqual(ui.pushed, ["/"]);
  }
});

test("loading, results, empty, and error states never display an unrelated homepage feed", () => {
  for (const status of ["idle", "loading", "ready", "unavailable"]) {
    const ui = search("https://example.invalid/", "mug", { status, products: [] });
    assert.equal(ui.view.props.children.includes("NORMAL BROWSE"), status === "idle");
  }
});

test("safe product/guide search submissions use root bookmarks, with the same native GET fallback", () => {
  for (const path of ["/", "/gifts/expired", "/gift-guides/held", "/safe/catalog"]) {
    const ui = search(`https://example.invalid${path}?utm_source=owned`, " desk ");
    const form = ui.view.props.children[0];
    assert.equal(form.type, "form");
    assert.equal(form.props.action, "/");
    assert.equal(form.props.method, "get");
    let prevented = false;
    form.props.onSubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(ui.pushed, ["/?utm_source=owned&q=desk"]);
  }
});
