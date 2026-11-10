import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as contract from "../lib/analytics-contract.ts";

const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("first-party search demand shares privacy/host gates and excludes QA attribution across navigation", () => {
  const env = environment();
  assert.equal(env.analytics.isSearchDemandAllowed(), false, "catalog must initialize first");
  env.analytics.startStaticAnalytics(true);
  assert.equal(env.analytics.isSearchDemandAllowed(), true);
  env.navigator.doNotTrack = '1'; assert.equal(env.analytics.isSearchDemandAllowed(), false);
  delete env.navigator.doNotTrack;
  env.navigator.globalPrivacyControl = true; assert.equal(env.analytics.isSearchDemandAllowed(), false);
  delete env.navigator.globalPrivacyControl;
  env.window.location.search = '?utm_source=codex&utm_medium=qa';
  assert.equal(env.analytics.isSearchDemandAllowed(), false);
  env.window.location.search = '';
  assert.equal(env.analytics.isSearchDemandAllowed(), false, "QA carries across internal navigation");
  const local = environment('localhost'); local.analytics.startStaticAnalytics(true);
  assert.equal(local.analytics.isSearchDemandAllowed(), false);
});
function load(relative, globals, require) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const commonJs = { exports: {} };
  vm.runInNewContext(outputText, { module: commonJs, exports: commonJs.exports, require,
    URL, URLSearchParams, console, ...globals });
  return commonJs.exports;
}
const ATTRIBUTION_KEY = "stupid.gifts.analytics-attribution.v1";
function environment(hostname = "stupid.gifts", enabled = "true", storage = new Map(), mode = "stupid-production") {
  const calls = [], scripts = [], captures = [], listeners = new Set();
  const posthog = {
    init: (_key, options) => { posthog.options = options; },
    capture: (...args) => captures.push(args),
  };
  const storageCalls = { access: 0, read: 0, write: 0 };
  const window = {
    location: { hostname, protocol: "https:", pathname: "/gifts/safe-product",
      search: "?q=private+search&utm_source=Pinterest&utm_medium=social&utm_campaign=fall&utm_term=private-term" },
    gtag: (...args) => calls.push(args),
    get localStorage() { throw new Error("Must not read storage"); },
    get sessionStorage() {
      storageCalls.access++;
      if (!storage) throw new Error("Storage blocked");
      return {
        getItem: (key) => { storageCalls.read++; return storage.get(key) || null; },
        setItem: (key, value) => { storageCalls.write++; storage.set(key, value); },
      };
    },
  };
  const navigator = {};
  class Element {
    getClientRects() { return this.hidden ? [] : [{ x: 0, y: 0, width: 100, height: 100 }]; }
  }
  const card = new Element();
  card.dataset = { analyticsId: "amazon:123", analyticsSource: "amazon",
    analyticsContext: "home_opening", analyticsExpiry: "2099-01-01T00:00:00.000Z" };
  const document = {
    referrer: "https://example.com/private?email=private",
    head: { appendChild: (script) => scripts.push(script) },
    querySelector: () => undefined,
    createElement: () => ({ dataset: {} }),
    querySelectorAll: () => [card],
    addEventListener: (_name, callback) => listeners.add(callback),
    removeEventListener: (_name, callback) => listeners.delete(callback),
  };
  let attributionReads = 0, adapterLoads = 0;
  const globals = { window, document, navigator, Element,
    process: { env: { NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED: enabled,
      NEXT_PUBLIC_STATIC_SITE_MODE: mode,
      NEXT_PUBLIC_POSTHOG_KEY: "existing-test-key", NEXT_PUBLIC_POSTHOG_HOST: "https://analytics.example" } } };
  const shared = load("../lib/client-analytics.ts", globals, (name) => {
    if (name === "./analytics-contract") return contract;
    if (name === "./client-attribution") return { getClickAttribution: () => {
      attributionReads++;
      return { sessionId: "private-session", landingPage: "/?q=private-search", utmSource: "Pinterest" };
    } };
    if (name === "posthog-js") return { default: posthog };
    throw new Error(`Unexpected dependency ${name}`);
  });
  const identity = load("../static-site/lib/site-identity.ts", globals, () => { throw new Error("Identity must stay provider-free"); });
  const attribution = load("../static-site/lib/analytics-attribution.ts", globals, (name) => {
    if (name === "./site-identity") return identity;
    assert.equal(name, "../../lib/analytics-contract");
    return contract;
  });
  const analytics = load("../static-site/lib/analytics.ts", globals, (name) => {
    if (name === "./site-identity") return identity;
    if (name === "./analytics-attribution") return attribution;
    assert.equal(name, "../../lib/client-analytics");
    adapterLoads++;
    return shared;
  });
  return { ...globals, card, calls, captures, scripts, listeners, posthog, shared, analytics, storage, storageCalls,
    attributionReads: () => attributionReads, adapterLoads: () => adapterLoads,
    click(outbound = false) {
      const link = new Element();
      link.href = outbound ? "https://www.amazon.com/dp/PRIVATE?tag=private-affiliate" : "/gifts/safe-product";
      link.closest = () => card;
      link.hasAttribute = () => outbound;
      const target = new Element();
      target.closest = () => link;
      const event = { target, button: 0, defaultPrevented: false };
      for (const callback of listeners) callback(event);
      assert.equal(event.defaultPrevented, false, "native navigation must remain untouched");
    },
  };
}

test("Goose legacy host policy, destinations, attribution and Ads callbacks remain unchanged", async () => {
  const env = environment("goose.gifts");
  assert.equal(env.shared.isClientAnalyticsAllowed(), true);
  env.shared.capturePageView("/?q=private-search");
  let callbackCount = 0;
  assert.equal(env.shared.captureOutboundProductClick({ clickSource: "gift_page_primary_cta",
    productId: "amazon:123", productSource: "amazon", affiliateUrl: "https://amazon.com/dp/private?tag=secret",
    attribution: { utmSource: "Pinterest" }, callback: () => callbackCount++ }), true);
  await flush();
  assert.deepEqual(plain(env.calls.filter(([name]) => name === "config")), [
    ["config", "G-6RR3HPR747", { send_page_view: false }],
    ["config", "AW-17626116539", { send_page_view: false }],
  ]);
  const page = env.calls.find((call) => call[1] === "page_view");
  assert.equal(page[2].page_location, "https://www.goose.gifts/");
  assert.equal(env.attributionReads(), 1);
  const outbound = env.calls.find((call) => call[1] === "conversion_event_outbound_click");
  assert.equal(outbound[2].event_timeout, 2000);
  outbound[2].event_callback();
  assert.equal(callbackCount, 1);
  assert.equal(outbound[2].link_domain, "amazon.com");
  assert.doesNotMatch(JSON.stringify(env.calls), /private-search|private-session|tag=secret/);
  for (const hostname of ["www.goose.gifts", "stupid.gifts", "localhost"]) {
    env.window.location.hostname = hostname;
    assert.equal(env.shared.isClientAnalyticsAllowed(), hostname === "www.goose.gifts");
  }
});

test("static staging, fixtures, unknown hosts, local and browser privacy signals load no adapter/providers", async () => {
  const cases = [
    { mode: "preview" }, { mode: "preview", host: "staging.stupid.gifts" },
    { mode: "goose-production", host: "stupid.gifts" },
    { enabled: undefined }, { enabled: "false" }, { catalog: false },
    { host: "localhost" }, { host: "staging.stupid.gifts" }, { host: "www.stupid.gifts" },
    { host: "goose.gifts" }, { host: "stupid.gifts.evil.example" }, { protocol: "http:" },
    { navigator: { doNotTrack: "1" } }, { navigator: { globalPrivacyControl: true } },
    { windowDnt: "1" },
  ];
  for (const entry of cases) {
    const env = environment(entry.host, Object.hasOwn(entry, "enabled") ? entry.enabled : "true", new Map(), entry.mode);
    // environment's default parameter is intentionally overridden for unset builds.
    if (Object.hasOwn(entry, "enabled")) env.process.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED = entry.enabled;
    Object.assign(env.navigator, entry.navigator);
    if (entry.protocol) env.window.location.protocol = entry.protocol;
    env.window.doNotTrack = entry.windowDnt;
    env.analytics.startStaticAnalytics(entry.catalog !== false);
    env.analytics.captureStaticSearch(3);
    env.analytics.captureStaticRandomSpin();
    await flush();
    assert.equal(env.adapterLoads(), 0, JSON.stringify(entry));
    assert.equal(env.calls.length + env.scripts.length + env.captures.length, 0);
    assert.equal(env.listeners.size, 0);
    assert.equal(env.attributionReads(), 0);
    assert.equal(env.storageCalls.access, 0, "gated pages must not access tab storage");
  }
});

test("opt-in exact static host sends only contract payloads, once per mount/list and actual action", async () => {
  const env = environment();
  const cleanup = env.analytics.startStaticAnalytics(true);
  cleanup(); // React development effect remount must not double-count.
  const cleanupAgain = env.analytics.startStaticAnalytics(true);
  await flush();
  env.analytics.captureRenderedLists();
  env.analytics.captureStaticSearch(1);
  env.analytics.captureStaticRandomSpin();
  env.click();
  env.click(true);
  await flush();
  const events = env.calls.filter(([name]) => name === "event");
  assert.deepEqual(events.map((event) => event[1]), ["page_view", "view_item_list", "search",
    "random_gift_spin", "select_item", "conversion_event_outbound_click"]);
  const clean = (properties) => plain({ ...properties, event_callback: undefined });
  const shared = { pathname: "/gifts/safe-product", page_location: "https://stupid.gifts/gifts/safe-product", page_referrer: "" };
  const traffic = { traffic_source: "Pinterest", traffic_medium: "social", traffic_campaign: "fall" };
  assert.deepEqual(clean(events[0][2]), { ...shared, ...traffic });
  assert.deepEqual(clean(events[1][2]), { ...shared, ui_context: "home_opening", item_list_id: "home_opening",
    result_count: 1, items: [{ item_id: "amazon:123", item_brand: "amazon", index: 0 }] });
  assert.deepEqual(clean(events[2][2]), { ...shared, ...traffic, ui_context: "catalog_search", result_count: 1 });
  assert.deepEqual(clean(events[3][2]), { ...shared, ui_context: "random_gift" });
  assert.deepEqual(clean(events[4][2]), { ...shared, ui_context: "home_opening", item_list_id: "home_opening",
    product_id: "amazon:123", source: "amazon", items: [{ item_id: "amazon:123", item_brand: "amazon", index: 0 }] });
  assert.deepEqual(clean(events[5][2]), { ...shared, ...traffic, ui_context: "home_opening",
    product_id: "amazon:123", source: "amazon", link_domain: "www.amazon.com", event_timeout: 2000 });
  assert.equal(typeof events[5][2].event_callback, "function");
  assert.equal(env.attributionReads(), 0, "static adapter must not use Goose's persisted attribution");
  assert.doesNotMatch(JSON.stringify([env.calls, env.captures]), /private|PRIVATE|affiliate|\?q=|utm_term|landingPage|sessionId/);
  assert.equal(env.captures.length, 6);
  const filtered = env.posthog.options.before_send({ event: "search", properties: { result_count: 1, query: "private", $current_url: "private" } });
  assert.deepEqual(plain(filtered.properties), { result_count: 1, $geoip_disable: true });
  env.navigator.globalPrivacyControl = true;
  env.analytics.captureStaticSearch(99);
  assert.equal(env.posthog.options.before_send({ event: "search", properties: {} }), null);
  await flush();
  assert.equal(env.calls.filter(([name]) => name === "event").length, 6);
  cleanupAgain();
  assert.equal(env.listeners.size, 0);
});

test("explicit permanent listings preserve list and outbound events without treating missing expiry as permission", async () => {
  for (const permanent of [true, false]) {
    const env = environment();
    delete env.card.dataset.analyticsExpiry;
    if (permanent) env.card.dataset.analyticsPermanent = "";
    const cleanup = env.analytics.startStaticAnalytics(true);
    await flush();
    env.click(true);
    await flush();
    const events = env.calls.filter(([name]) => name === "event").map((event) => event[1]);
    assert.deepEqual(events, permanent ? ["page_view", "view_item_list", "conversion_event_outbound_click"] : ["page_view"]);
    assert.doesNotMatch(JSON.stringify(env.calls), /private|affiliate|\?q=/);
    cleanup();
  }
});

test("hidden saved-lineup cards do not count as impressions or suppress their later visible impression", async () => {
  const env = environment();
  env.card.hidden = true;
  env.card.dataset.analyticsContext = "show-curated";
  const custom = new env.Element();
  custom.dataset = { ...env.card.dataset, analyticsId: "amazon:new" };
  env.document.querySelectorAll = () => [env.card, custom];
  env.analytics.startStaticAnalytics(true);
  await flush();
  env.analytics.captureRenderedLists();
  await flush();
  let lists = env.calls.filter(call => call[1] === "view_item_list");
  assert.equal(lists.length, 1);
  assert.deepEqual(plain(lists[0][2].items.map(item => item.item_id)), ["amazon:new"]);
  env.card.hidden = false;
  env.analytics.captureRenderedLists();
  env.analytics.captureRenderedLists();
  await flush();
  lists = env.calls.filter(call => call[1] === "view_item_list");
  assert.equal(lists.length, 2, "each actually shown gift counts once, not the hidden fallback");
  assert.deepEqual(plain(lists[1][2].items.map(item => item.item_id)), ["amazon:123"]);
});

test("explicit Goose static mode preserves canonical page origin, provider destinations and coarse internal attribution", async () => {
  for (const host of ["www.goose.gifts", "goose.gifts"]) {
    const env = environment(host, "true", new Map(), "goose-production");
    env.window.location.search = "";
    env.document.referrer = host === "goose.gifts" ? "https://www.goose.gifts/gifts/internal" : "https://goose.gifts/gifts/internal";
    env.analytics.startStaticAnalytics(true); await flush(); env.click(true); await flush();
    const page = env.calls.find(call => call[1] === "page_view");
    assert.equal(page[2].page_location, "https://www.goose.gifts/gifts/safe-product");
    assert.equal(page[2].traffic_source, "direct");
    assert.deepEqual(plain(env.calls.filter(([name]) => name === "config")), [
      ["config", "G-6RR3HPR747", { send_page_view: false }], ["config", "AW-17626116539", { send_page_view: false }],
    ]);
    assert.equal(env.storage.has("goose.gifts.analytics-attribution.v1"), true);
    assert.equal(env.storage.has(ATTRIBUTION_KEY), false);
    assert.equal(env.attributionReads(), 0, "static Goose must not read the legacy private attribution adapter");
    assert.doesNotMatch(JSON.stringify([env.calls, ...env.storage]), /private|stupid\.gifts|sessionId|landingPage/);
  }
});

test("privacy rechecked after deferred adapter/provider import; SSR remains off", async () => {
  const env = environment();
  env.analytics.startStaticAnalytics(true);
  env.navigator.doNotTrack = "1";
  await flush();
  assert.equal(env.calls.length + env.scripts.length + env.captures.length, 0);
  assert.equal(env.posthog.options, undefined);
  const server = load("../static-site/lib/analytics.ts", { process: { env: {} } }, (name) => {
    if (name === "./site-identity") return { isSiteProduction: false, isSiteAnalyticsHostname: () => false, siteIdentity: { origin: "https://staging.stupid.gifts" } };
    assert.equal(name, "./analytics-attribution");
    return { createSessionAttribution: () => () => ({}) };
  });
  assert.equal(server.isStaticAnalyticsAllowed(), false);
  const deferred = environment("goose.gifts");
  deferred.shared.capturePageView("/"); // Google is synchronous; PostHog import is deferred.
  deferred.navigator.globalPrivacyControl = true;
  await flush();
  assert.equal(deferred.posthog.options, undefined);
  assert.equal(deferred.captures.length, 0);
});

test("tab-scoped sanitized campaign survives ordinary navigation through the retailer event", async () => {
  const storage = new Map();
  const landing = environment("stupid.gifts", "true", storage);
  landing.window.location.pathname = "/";
  landing.window.location.search = "?utm_source=Pinterest%20%3Cscript%3E&utm_medium=social&utm_campaign=show%20episode&q=private&utm_term=private-term&utm_content=private-copy";
  landing.analytics.startStaticAnalytics(true);
  await flush();
  const expected = { traffic_source: "Pinterest_script", traffic_medium: "social", traffic_campaign: "show_episode" };
  assert.deepEqual(JSON.parse(storage.get(ATTRIBUTION_KEY)), expected);
  assert.equal(storage.size, 1);

  // A fresh module/document, sharing only the browser tab's sessionStorage.
  const product = environment("stupid.gifts", "true", storage);
  product.window.location.search = "";
  product.document.referrer = "https://stupid.gifts/?q=private&email=private";
  product.analytics.startStaticAnalytics(true);
  await flush();
  product.click(true);
  await flush();
  for (const name of ["page_view", "conversion_event_outbound_click"]) {
    const properties = product.calls.find((call) => call[1] === name)[2];
    assert.deepEqual(Object.fromEntries(Object.entries(properties).filter(([key]) => key.startsWith("traffic_"))), expected);
  }
  assert.doesNotMatch(JSON.stringify([...storage, product.calls, product.captures]), /private|stupid\.gifts\/?\?|utm_term|utm_content|sessionId|landingPage/);

  const newCampaign = environment("stupid.gifts", "true", storage);
  newCampaign.window.location.search = "?utm_source=howie_mandel_does_stuff&utm_medium=podcast&utm_campaign=episode_2026_10_20";
  newCampaign.document.referrer = "https://stupid.gifts/gifts/safe-product";
  newCampaign.analytics.startStaticAnalytics(true);
  await flush();
  assert.deepEqual(JSON.parse(storage.get(ATTRIBUTION_KEY)), { traffic_source: "howie_mandel_does_stuff",
    traffic_medium: "podcast", traffic_campaign: "episode_2026_10_20" });

  const externalStorage = new Map();
  const external = environment("stupid.gifts", "true", externalStorage);
  external.window.location.search = "";
  external.document.referrer = "https://pinterest.com/private-pin?email=private";
  external.analytics.startStaticAnalytics(true);
  await flush();
  const internal = environment("stupid.gifts", "true", externalStorage);
  internal.window.location.search = "";
  internal.document.referrer = "https://stupid.gifts/random-gift";
  internal.analytics.startStaticAnalytics(true);
  await flush();
  assert.equal(internal.calls.find((call) => call[1] === "page_view")[2].traffic_source, "pinterest.com");
  assert.deepEqual(JSON.parse(externalStorage.get(ATTRIBUTION_KEY)), { traffic_source: "pinterest.com" });
});

test("internal referrers are not acquisition sources; junk and blocked storage stay safe", async () => {
  const junk = ["{", "null", "[]", JSON.stringify({ traffic_source: "Pinterest", q: "private" }),
    JSON.stringify({ traffic_source: "Unclean <script>" }), JSON.stringify({ traffic_source: 123 }),
    JSON.stringify({ traffic_source: "x".repeat(101) })];
  for (const value of junk) {
    const storage = new Map([[ATTRIBUTION_KEY, value]]);
    const env = environment("stupid.gifts", "true", storage);
    env.window.location.search = "?q=private&utm_term=private";
    env.document.referrer = "https://www.stupid.gifts/private?email=private";
    env.analytics.startStaticAnalytics(true);
    await flush();
    assert.equal(env.calls.find((call) => call[1] === "page_view")[2].traffic_source, "direct");
    assert.deepEqual(JSON.parse(storage.get(ATTRIBUTION_KEY)), { traffic_source: "direct" });
  }
  const blocked = environment("stupid.gifts", "true", null);
  blocked.analytics.startStaticAnalytics(true);
  await flush();
  blocked.window.location.search = "";
  blocked.document.referrer = "https://stupid.gifts/";
  blocked.click(true);
  await flush();
  assert.equal(blocked.calls.find((call) => call[1] === "conversion_event_outbound_click")[2].traffic_source, "Pinterest");
  assert.equal(blocked.listeners.size, 1, "blocked storage must not disable ordinary native links");
  const before = blocked.storageCalls.access;
  blocked.navigator.globalPrivacyControl = true;
  blocked.analytics.captureStaticSearch(1);
  blocked.click(true);
  await flush();
  assert.equal(blocked.storageCalls.access, before, "privacy opt-out must prevent further storage access");
  const readOnly = environment("stupid.gifts", "true", {
    get: () => null, set: () => { throw new Error("Storage quota unavailable"); },
  });
  readOnly.analytics.startStaticAnalytics(true);
  await flush();
  readOnly.click(true);
  await flush();
  assert.equal(readOnly.calls.find((call) => call[1] === "conversion_event_outbound_click")[2].traffic_source, "Pinterest");
});
