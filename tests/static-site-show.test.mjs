import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { validateEpisodeManifest, assertEpisodePublishable } from "../content/show/manifest.ts";
import { createShowRelease } from "../static-site/lib/show.ts";
import { unavailableEpisode } from "../static-site/lib/episode-display.ts";
import { episodeQrSvg } from "../static-site/lib/episode-qr.ts";
import { createStaticRoutes } from "../static-site/lib/asset-routes.ts";
import { createBrowseRelease } from "../static-site/lib/browse.ts";
import { createOgRelease } from "../static-site/lib/og.ts";
import { siteIdentity } from "../static-site/lib/site-identity.ts";
import { SHOW_PRESET_KEYS, SHOW_PRESETS } from "../static-site/lib/show-rehearsal.ts";
import { guides } from "../static-site/lib/guides.ts";
import { validateCatalogSnapshot } from "../lib/catalog/snapshot.ts";
import { createSiteWorker } from "../workers/site/index.ts";
import { createStaticFeedPlan } from "../workers/site/feed.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const owned = JSON.parse(fs.readFileSync(path.join(root, "static-site/fixtures/catalog.snapshot.json")));
// Controlled unit records only; never a source file or production publication.
const catalog = { ...owned, dataKind: "catalog" };
const missing = ["90000000-0000-4000-8000-000000000001", "90000000-0000-4000-8000-000000000002"];
function fixtureEpisodes(snapshot) {
  return [{ schemaVersion: 1, key: "controlled-layout-fixture", status: "published",
    title: "Controlled layout fixture — not aired", episodeDate: "2026-10-19",
    ownerConfirmed: true, presentationAssetsApproved: true,
    slots: [
      { position: 1, productPublicId: snapshot.products[0].publicId,
        exactVariant: "Controlled exact variant record — not a real episode",
        caption: "A controlled layout fixture. No appearance or endorsement is claimed.", alternativePublicIds: [] },
      { position: 2, productPublicId: snapshot.heldProducts[0]?.publicId || missing[0],
        exactVariant: "Original unavailable fixture variant",
        caption: "A historical selection is not silently replaced.",
        alternativePublicIds: snapshot.products.slice(1, 3).map((p) => p.publicId) },
    ] }, { schemaVersion: 1, key: "controlled-archive-fixture", status: "published",
    title: "Controlled archive fixture — not aired", episodeDate: "2026-10-12",
    ownerConfirmed: true, presentationAssetsApproved: true,
    slots: missing.map((id, index) => ({ position: index + 1, productPublicId: id,
      exactVariant: `Immutable original fixture variant ${index + 1}`,
      caption: "Controlled archive record, not an actual appearance.", alternativePublicIds: [] })) }];
}
function inventory(snapshot, inputs = []) {
  const show = createShowRelease(snapshot, inputs);
  const pages = ["/", "/random-gift", "/gift-guides", "/howie", "/preview/presentation", "/h",
    ...SHOW_PRESET_KEYS.map((key) => `/h/${key}`),
    ...guides.map((g) => `/gift-guides/${g.slug}`), ...snapshot.products.map((p) => `/gifts/${p.slug}`),
    ...show.episodes.flatMap((e) => [`/howie/${e.key}`, `/howie/${e.key}/presentation`])];
  const safe = ["/safe/catalog", "/safe/product", "/safe/howie", "/safe/presentation",
    ...show.episodes.flatMap((e) => [`/safe/howie/${e.key}`, `/safe/howie/${e.key}/presentation`])];
  return [...new Set([
    ...pages.flatMap((p) => p === "/" ? ["/index.html", "/index.txt", "/__next.__PAGE__.txt"]
      : [`${p}.html`, `${p}.txt`, `${p}/__next.__PAGE__.txt`]),
    ...safe.flatMap((p) => [`${p}.html`, `${p}.txt`]), "/safe/catalog.json",
    ...["_full", "_tree", "safe.product.__PAGE__"].map((part) => `/safe/product/__next.${part}.txt`),
    ...show.episodes.flatMap((e) => [`/howie/${e.key}/data.json`, `/safe/howie/${e.key}/data.json`]),
    ...createBrowseRelease(snapshot).shards.map((s) => s.path),
    ...createOgRelease(snapshot, siteIdentity).byPath.keys(),
  ])];
}
test("saved filming lineups retain independent noindex/freshness policies on every document alias", () => {
  const snapshot = structuredClone(catalog);
  snapshot.products[0].slug = SHOW_PRESETS.matan[0];
  snapshot.products[0].eligibleUntil = "2026-10-21T00:00:00.000Z";
  snapshot.products[1].slug = SHOW_PRESETS["billy-ray"][0];
  snapshot.products[1].eligibleUntil = "2026-10-22T00:00:00.000Z";
  const routes = createStaticRoutes(snapshot, inventory(snapshot));
  for (const [pathname, deadline] of [["/h", snapshot.products[0].eligibleUntil],
    ["/h/matan", snapshot.products[0].eligibleUntil], ["/h/billy-ray", snapshot.products[1].eligibleUntil]]) {
    for (const alias of [pathname, `${pathname}.html`, `${pathname}.txt`, `${pathname}/__next.__PAGE__.txt`]) {
      assert.equal(routes[alias].indexable, false, alias);
      assert.equal(routes[alias].eligibleUntil, deadline, alias);
      assert.match(routes[alias].safeAssetPath, /^\/safe\/catalog/);
    }
  }
  assert.equal(routes["/h/unknown"], undefined);
});
test("draft candidates can retain UUIDs but unapproved details never become display/presentation data", () => {
  const draft = { ...fixtureEpisodes(catalog)[0], status: "draft", episodeDate: null,
    ownerConfirmed: false, presentationAssetsApproved: false };
  draft.slots[0].productPublicId = missing[0];
  const validated = validateEpisodeManifest(draft, owned);
  assert.ok(Object.isFrozen(validated.slots[0]));
  assert.throws(() => assertEpisodePublishable(draft, catalog), /initial products/);
  const show = createShowRelease(owned, [draft]);
  assert.equal(show.latest, null);
  assert.equal(show.episodes.length, 0);
  assert.equal(show.preview.shareUrl, null);
  assert.equal(show.preview.eligibleUntil, null);
  assert.ok(show.preview.slots.every((s) => !s.primary && !s.originalPublicId && !s.exactVariant && !s.alternatives.length));
  assert.doesNotMatch(JSON.stringify(show), /controlled exact variant|ownerConfirmed|presentationAssetsApproved|Original unavailable/i);
  assert.equal(episodeQrSvg(show.preview), null);
});
test("published archives preserve primary identity, show only eligible labeled alternatives and omit approval/source-private fields", () => {
  const inputs = fixtureEpisodes(catalog);
  const show = createShowRelease(catalog, inputs);
  assert.equal(show.latest.key, inputs[0].key);
  assert.equal(show.latest.slots[0].primary.publicId, inputs[0].slots[0].productPublicId);
  assert.equal(show.latest.slots[1].originalPublicId, inputs[0].slots[1].productPublicId);
  assert.equal(show.latest.slots[1].primary, null);
  assert.deepEqual(show.latest.slots[1].alternatives.map((p) => p.publicId), inputs[0].slots[1].alternativePublicIds);
  assert.equal(show.episodes[1].slots[0].originalPublicId, missing[0]);
  assert.equal(show.episodes[1].slots[0].exactVariant, inputs[1].slots[0].exactVariant);
  assert.equal(show.episodes[1].eligibleUntil, null);
  assert.throws(() => assertEpisodePublishable(inputs[1], catalog), /not eligible/);
  assert.throws(() => createShowRelease(catalog, [inputs[0], inputs[0]]), /Duplicate episode key/);
  assert.doesNotMatch(JSON.stringify(show), /ownerConfirmed|presentationAssetsApproved|editorialWriteup|qualityScore|sourceFacts|alternativePublicIds|wittyDescription|"description"|"price"/);
  const safe = unavailableEpisode(show.latest);
  assert.equal(safe.slots[0].originalPublicId, show.latest.slots[0].originalPublicId);
  assert.equal(safe.slots[0].exactVariant, show.latest.slots[0].exactVariant);
  for (const product of catalog.products) {
    assert.equal(JSON.stringify(safe).includes(product.imageUrl), false);
    assert.equal(JSON.stringify(safe).includes(product.affiliateUrl), false);
    assert.equal(JSON.stringify(safe).includes(product.title), false);
  }
});
test("episode HTML/RSC/JSON and presentation inherit first displayed expiry; product-free archives remain stable", () => {
  const snapshot = structuredClone(catalog);
  snapshot.products[1].eligibleUntil = "2026-10-21T00:00:00.000Z";
  const inputs = fixtureEpisodes(snapshot);
  const routes = createStaticRoutes(snapshot, inventory(snapshot, inputs), inputs);
  for (const key of ["/howie", "/howie/controlled-layout-fixture", "/howie/controlled-layout-fixture/presentation"]) {
    for (const alias of [key, `${key}.html`, `${key}.txt`, `${key}/__next.__PAGE__.txt`]) {
      assert.equal(routes[alias].eligibleUntil, snapshot.products[1].eligibleUntil, alias);
      assert.match(routes[alias].safeAssetPath, /^\/safe\/howie/);
    }
  }
  assert.equal(routes["/howie/controlled-layout-fixture/data.json"].eligibleUntil, snapshot.products[1].eligibleUntil);
  assert.equal(routes["/howie/controlled-layout-fixture/data.json"].indexable, false);
  assert.equal(routes["/howie/controlled-archive-fixture"].eligibleUntil, null);
  assert.equal(routes["/howie/controlled-archive-fixture/presentation"].indexable, false);
  const empty = { ...snapshot, products: [] };
  const emptyRoutes = createStaticRoutes(empty, inventory(empty));
  assert.equal(emptyRoutes["/"].state, "held");
  assert.equal(emptyRoutes["/"].indexable, false);
  assert.equal(emptyRoutes["/index.txt"].safeAssetPath, "/safe/catalog.txt");
  assert.equal(emptyRoutes[createBrowseRelease(empty).random.poolPath].state, "held");
});
test("QR is deterministic local SVG for only the stable canonical page with coarse campaign fields", () => {
  const episode = createShowRelease(catalog, fixtureEpisodes(catalog)).latest;
  const url = new URL(episode.shareUrl);
  assert.equal(url.origin, siteIdentity.origin);
  assert.equal(url.pathname, `/howie/${episode.key}`);
  assert.deepEqual([...url.searchParams.keys()], ["utm_source", "utm_medium", "utm_campaign"]);
  assert.equal(url.searchParams.get("utm_campaign"), "episode_2026_10_19");
  const svg = episodeQrSvg(episode);
  assert.equal(svg, episodeQrSvg(episode));
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg.replace('xmlns="http://www.w3.org/2000/svg"', ""), /<script|<image|href=|https?:/);
  assert.throws(() => episodeQrSvg({ ...episode, shareUrl: "https://amazon.com/dp/NOT-A-QR-TARGET" }), /QR target/);
});

function files(directory, prefix = "") {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((e) => e.isDirectory()
    ? files(path.join(directory, e.name), `${prefix}/${e.name}`) : [`${prefix}/${e.name}`]);
}
function isolatedProject(name) {
  const project = path.join(root, `output/${name}/${randomUUID()}/project`);
  fs.mkdirSync(project, { recursive: true });
  for (const item of ["static-site", "content", "lib", "components", "package.json", "tsconfig.json", "postcss.config.mjs", "tailwind.config.ts"])
    fs.cpSync(path.join(root, item), path.join(project, item), { recursive: true,
      filter: (file) => !/[\/](?:node_modules|out|\.next)(?:[\/]|$)/.test(file) });
  if (!fs.existsSync(path.join(project, "node_modules"))) fs.symlinkSync(fs.realpathSync(path.join(root, "node_modules")), path.join(project, "node_modules"), "dir");
  return project;
}
function build(project, source) {
  const snapshot = validateCatalogSnapshot(JSON.parse(fs.readFileSync(source, "utf8")));
  const context = path.join(project, "fixture-release-context.json");
  fs.writeFileSync(context, JSON.stringify({
    schemaVersion: 1, sourceMode: "preview", releaseId: `controlled-show-${randomUUID()}`,
    codeSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    catalogRevision: snapshot.catalogRevision,
    catalogSnapshotSha256: createHash("sha256").update(`${JSON.stringify(snapshot)}\n`).digest("hex"),
    generatedAt: new Date().toISOString(), vectorSyncWatermark: 0, priorReleaseId: null, retainedManifestSha256: null,
  }));
  try {
    execFileSync(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "build", "static-site", "--webpack"], {
      cwd: project, env: { ...process.env, CATALOG_SNAPSHOT_PATH: source,
        CATALOG_RELEASE_CONTEXT_PATH: context, NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED: "false" }, stdio: "pipe",
    });
  } catch (error) {
    throw new Error(`Isolated export failed: ${error.stdout?.toString()} ${error.stderr?.toString()}`);
  }
  return path.join(project, "static-site/out");
}
test("real empty publication exports no episode or candidate routes", { skip: !fs.existsSync(path.join(root, "static-site/out/howie.html")) }, () => {
  const published = JSON.parse(fs.readFileSync(path.join(root, "content/show/published.json")));
  if (published.length) return;
  assert.equal(files(path.join(root, "static-site/out")).some((p) => /^\/howie\/[^/]+\.html$/.test(p)), false);
  const html = fs.readFileSync(path.join(root, "static-site/out/howie.html"), "utf8");
  assert.match(html, /No episode selection has been published/);
  assert.doesNotMatch(html, /controlled-layout-fixture|Original exact variant|data-analytics-outbound/);
});

test("product route family exports only ready identities; held-only/empty catalogs omit it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goose-empty-routes-"));
  try {
    for (const snapshot of [owned, { ...owned, products: [] }, { ...owned, products: [], heldProducts: [] }]) {
      const source = path.join(directory, "snapshot.json"); fs.writeFileSync(source, JSON.stringify(snapshot));
      const output = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
        import config from './static-site/next.config.ts';
        import {generateStaticParams} from './static-site/app/gifts/[slug]/page.product.tsx';
        console.log(JSON.stringify({extensions:config.pageExtensions,params:generateStaticParams()}));
      `], { cwd: root, env: { ...process.env, CATALOG_SNAPSHOT_PATH: source }, encoding: "utf8" }));
      const slugs = snapshot.products.map(({slug}) => ({slug}));
      assert.deepEqual(output.params, slugs);
      assert.equal(output.extensions.includes("product.tsx"), slugs.length > 0);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("held identities require the complete recognized shared HTML/RSC inventory, never individual exports", () => {
  const assets = inventory(owned);
  for (const companion of assets.filter((p) => p === "/safe/product.html" || p === "/safe/product.txt" || p.startsWith("/safe/product/")))
    assert.throws(() => createStaticRoutes(owned, assets.filter((p) => p !== companion)), /missing HTML\/RSC/);
  assert.throws(() => createStaticRoutes(owned, [...assets, "/safe/product/__next.new-format.txt"]), /unrecognized companion/);
  assert.throws(() => createStaticRoutes(owned, [...assets, `${owned.heldProducts[0].path}.html`]), /individual exports/);
  const routes = createStaticRoutes(owned, assets);
  const held = owned.heldProducts[0].path;
  assert.deepEqual(Object.keys(routes).filter((p) => p.startsWith(held)).sort(), [held, `${held}.html`, `${held}.txt`,
    `${held}/__next._full.txt`, `${held}/__next._tree.txt`, `${held}/__next.gifts.$d$slug.__PAGE__.txt`].sort());
  for (const [pathname, route] of Object.entries(routes).filter(([p]) => p.startsWith(held))) {
    assert.ok(assets.includes(route.assetPath), pathname);
    assert.equal(route.safeAssetPath, route.assetPath);
    assert.equal(route.state, "held");
    assert.equal(route.indexable, false);
    assert.equal(route.eligibleUntil, null);
  }
});

function representativeSnapshot() {
  const products = [...owned.products, { ...owned.products[0], id: "fixture-fourth", slug: "illustrative-fourth-fixture",
    publicId: "00000000-0000-4000-8000-000000000005" }];
  return validateCatalogSnapshot({ ...owned, products, heldProducts: Array.from({ length: 3379 }, (_, i) => ({
    ...owned.heldProducts[0], id: `fixture-held-${i}`, publicId: `10000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    slug: `illustrative-held-selection-${i}`, path: `/gifts/illustrative-held-selection-${i}`,
  })) });
}
test("3383 identities keep a constant ready-only inventory and exact finite held aliases", () => {
  const snapshot = representativeSnapshot();
  const assets = inventory(snapshot);
  assert.deepEqual(assets, inventory({ ...snapshot, heldProducts: [] }));
  const routes = createStaticRoutes(snapshot, assets);
  assert.equal(snapshot.products.length + snapshot.heldProducts.length, 3383);
  assert.equal(Object.values(routes).filter((r) => r.state === "held" && r.assetPath.startsWith("/safe/product")).length, 3379 * 6);
  assert.ok(assets.length + 10 < 10_000);
  assert.equal(routes["/gifts/unrecognized-held-id"], undefined);
});

test("controlled isolated published export includes finite routes, safe companions and no product literals in JS", {
  skip: process.env.STATIC_SITE_BUILD_SHOW_FIXTURE !== "1",
}, () => {
  const source = process.env.CATALOG_SNAPSHOT_PATH;
  assert.ok(source, "Set an approved catalog snapshot for this isolated layout export");
  const snapshot = JSON.parse(fs.readFileSync(source, "utf8"));
  assert.equal(snapshot.dataKind, "catalog");
  assert.ok(snapshot.products.length >= 3);
  const project = isolatedProject("show-fixture");
  const inputs = fixtureEpisodes(snapshot);
  fs.writeFileSync(path.join(project, "content/show/published.json"), JSON.stringify(inputs));
  const out = build(project, source);
  const assets = files(out);
  const routes = createStaticRoutes(snapshot, assets, inputs);
  for (const episode of inputs) {
    const key = `/howie/${episode.key}`;
    for (const pathname of [key, `${key}/presentation`, `${key}/data.json`]) assert.ok(routes[pathname], pathname);
    const data = JSON.parse(fs.readFileSync(path.join(out, `${key}/data.json`)));
    assert.equal(data.key, episode.key);
    assert.doesNotMatch(JSON.stringify(data), /ownerConfirmed|presentationAssetsApproved|editorialWriteup|sourceFacts/);
  }
  for (const asset of assets.filter((p) => p.startsWith("/safe/howie/") && /\.(?:html|txt|json)$/.test(p)))
    for (const product of snapshot.products)
      for (const value of [product.title, product.imageUrl, product.affiliateUrl])
        assert.equal(fs.readFileSync(path.join(out, asset), "utf8").includes(value), false, `${asset} contains expired merchant text`);
  for (const asset of assets.filter((p) => p.startsWith("/_next/static/") && p.endsWith(".js"))) {
    const js = fs.readFileSync(path.join(out, asset), "utf8");
    for (const value of snapshot.products.flatMap((p) => [p.title, p.imageUrl, p.affiliateUrl])) assert.equal(js.includes(value), false);
    assert.doesNotMatch(js, /createSvgTag|G-6RR3HPR747|AW-17626116539/);
  }
});

test("controlled mixed/all-held/empty Next exports share neutral held HTML/RSC with bounded 3383-identity inventory", {
  skip: process.env.STATIC_SITE_BUILD_EMPTY_FIXTURE !== "1",
}, async () => {
  const mixed = { ...owned, products: representativeSnapshot().products, slugHistory: [{
    slug: "illustrative-old-held-selection", canonicalSlug: owned.heldProducts[0].slug, publicId: owned.heldProducts[0].publicId,
  }] };
  for (const [name, snapshot] of [["mixed", mixed], ["all-held", { ...mixed, products: [] }],
    ["empty", { ...mixed, products: [], heldProducts: [], slugHistory: [] }]]) {
    const project = isolatedProject(`held-${name}-fixture`);
    fs.writeFileSync(path.join(project, "content/show/published.json"), "[]");
    const source = path.join(project, "catalog.snapshot.json");
    fs.writeFileSync(source, JSON.stringify(snapshot));
    const out = build(project, source);
    const assets = files(out);
    assert.ok(assets.includes("/404.html"));
    const heldPath = owned.heldProducts[0].path;
    assert.equal(assets.some((p) => p.startsWith(heldPath)), false);
    const safeHtml = fs.readFileSync(path.join(out, "safe/product.html"), "utf8");
    assert.match(safeHtml, /Not currently in the collection/);
    assert.doesNotMatch(safeHtml, /rel="canonical"|property="og:|name="twitter:|"@type":"Product"|data-analytics-outbound|example\.invalid\/not-for-sale/);
    for (const product of snapshot.products) assert.equal(safeHtml.includes(product.title), false);
    for (const asset of assets.filter((p) => p.startsWith("/_next/static/") && p.endsWith(".js"))) {
      const js = fs.readFileSync(path.join(out, asset), "utf8");
      for (const value of [...snapshot.products.flatMap((p) => [p.title, p.publicId, p.affiliateUrl]),
        ...snapshot.heldProducts.flatMap((p) => [p.slug, p.publicId])])
        assert.equal(js.includes(value), false, `${asset} contains snapshot data`);
    }
    const routes = createStaticRoutes(snapshot, assets);
    const digest = createHash("sha256").update(`${JSON.stringify(snapshot)}\n`).digest("hex");
    const feedPlan = createStaticFeedPlan(snapshot, digest);
    const calls = [];
    const worker = createSiteWorker({ snapshot, manifest: { catalogRevision: snapshot.catalogRevision, catalogSnapshotSha256: digest, routes }, feedPlan });
    const env = { ENVIRONMENT: "production", ASSETS: { fetch: (request) => {
      const asset = new URL(request.url).pathname; calls.push(asset);
      return new Response(fs.readFileSync(path.join(out, asset)), { headers: {
        "Content-Type": asset.endsWith(".txt") ? "text/x-component" : "text/html; charset=utf-8",
      } });
    } } };
    for (const [pathname, route] of Object.entries(routes).filter(([p]) => p.startsWith(heldPath))) {
      const response = await worker.fetch(new Request(`https://example.invalid${pathname}`, { headers: { RSC: "1" } }), env);
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("X-Robots-Tag"), "noindex, follow");
      assert.equal(response.headers.get("Content-Type"), pathname.endsWith(".txt") ? "text/x-component" : "text/html; charset=utf-8");
      assert.equal(await response.text(), fs.readFileSync(path.join(out, route.assetPath), "utf8"));
      assert.equal(calls.at(-1), route.assetPath);
    }
    const before = calls.length;
    for (const pathname of ["/gifts/missing", "/gifts/missing/", "/gifts/missing.txt", "/gifts/missing/__next._full.txt", `${heldPath}/__next.unknown.txt`, "/bundles/retired"])
      assert.equal((await worker.fetch(new Request(`https://example.invalid${pathname}`), env)).status, 404, pathname);
    assert.equal(calls.length, before);
    if (snapshot.heldProducts.length) {
      const slash = await worker.fetch(new Request(`https://example.invalid${heldPath}/?utm_source=pinterest&q=gift&unsafe=discard`), env);
      assert.equal(slash.status, 308);
      assert.equal(slash.headers.get("Location"), `${heldPath}?utm_source=pinterest&q=gift`);
      assert.equal(slash.headers.get("Cache-Control"), "no-store");
      assert.equal((await worker.fetch(new Request(`https://example.invalid${heldPath}.html/`), env)).status, 404);
      const redirected = await worker.fetch(new Request("https://example.invalid/gifts/illustrative-old-held-selection"), env);
      assert.equal(redirected.status, 308);
      assert.equal(redirected.headers.get("Location"), heldPath);
      const head = await worker.fetch(new Request(`https://example.invalid${heldPath}`, { method: "HEAD" }), env);
      assert.equal(head.status, 200); assert.equal(await head.text(), "");
    }
    assert.doesNotMatch(await (await worker.fetch(new Request("https://example.invalid/sitemap.xml"), env)).text(), /illustrative-held|illustrative-old-held/);
    const response = await worker.fetch(new Request("https://example.invalid/api/catalog-feed", { method: "POST", body: "{}" }), env);
    assert.equal(response.status, snapshot.products.length ? 200 : 503);
    assert.doesNotMatch(await response.text(), /fixture-held|illustrative-held/);
    if (!snapshot.products.length) {
      const html = fs.readFileSync(path.join(out, "index.html"), "utf8");
      assert.match(html, /The collection is being checked/);
      assert.doesNotMatch(html, /More questionable decisions|class="opening-grid"/);
      assert.equal(assets.some((p) => /^\/gifts\/[^/]+\.html$/.test(p)), false);
      assert.equal(routes["/"].state, "held");
      assert.equal(routes["/__next.__PAGE__.txt"].state, "held");
    } else {
      const full = representativeSnapshot();
      const fullRoutes = createStaticRoutes(full, assets);
      const snapshotBytes = Buffer.byteLength(`${JSON.stringify(full)}\n`);
      const routeBytes = Buffer.byteLength(JSON.stringify(fullRoutes, null, 2));
      const assetBytes = assets.reduce((sum, p) => sum + fs.statSync(path.join(out, p)).size, 0);
      // Exact measured assets + two snapshot copies + route JSON. Fixed package
      // metadata/entry/config get a conservative 1 MiB allowance, not a cap raise.
      const packageBound = assetBytes + snapshotBytes * 2 + routeBytes + 1024 * 1024;
      assert.ok(assets.length + 10 < 10_000);
      assert.ok(packageBound < 128 * 1024 * 1024);
      console.log(JSON.stringify({ fixture: "3383-identities", ready: 4, held: 3379, out,
        assetFiles: assets.length, assetBytes, routeAliases: Object.keys(fullRoutes).length,
        snapshotBytes, routeBytes, packageFileBound: assets.length + 10, packageByteBound: packageBound }));
    }
    console.log(JSON.stringify({ fixture: name, out, assets: assets.length, aliases: Object.keys(routes).length }));
  }
});
