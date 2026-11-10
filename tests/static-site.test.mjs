import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateCatalogSnapshot } from "../lib/catalog/snapshot.ts";
import { earliestDisplayExpiry, persistentPublicProduct,catalogDisplayView } from "../lib/catalog/display.ts";
import { createStaticRoutes } from "../static-site/lib/asset-routes.ts";
import { createBrowseRelease } from "../static-site/lib/browse.ts";
import { createOgRelease } from "../static-site/lib/og.ts";
import { siteIdentity } from "../static-site/lib/site-identity.ts";
import { assertOwnedCodeSafe } from "../static-site/lib/retention.ts";
import { exportedRoutes, exportSourceMode, exportGeneratedAt, exportHomepage,exportMerchandising } from "./helpers/static-export.mjs";
import { guides, selectGuideProducts } from "../static-site/lib/guides.ts";
import {
  eligiblePool,
  initialRandomIndex,
  isIllustrative,
  nextRandomIndex,
} from "../static-site/lib/selection.ts";

const root = new URL("../static-site/", import.meta.url);
const fixture = JSON.parse(
  fs.readFileSync(new URL("fixtures/catalog.snapshot.json", root)),
);
const snapshot = validateCatalogSnapshot(
  fixture,
  new Date("2026-10-20T00:00:00.000Z"),
);
const builtSnapshotPath = new URL(
  "../build/stupid-gifts/catalog.snapshot.json",
  import.meta.url,
);
const artifactInput = fs.existsSync(builtSnapshotPath)
  ? builtSnapshotPath
  : process.env.CATALOG_SNAPSHOT_PATH;
const exportSnapshot = artifactInput
  ? validateCatalogSnapshot(JSON.parse(fs.readFileSync(artifactInput, "utf8")))
  : snapshot;
function files(directory, prefix = "") {
  if (directory instanceof URL) directory = fileURLToPath(directory);
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(directory, entry.name), `${prefix}/${entry.name}`)
        : [`${prefix}/${entry.name}`],
    );
}
function schemas(html) {
  return [
    ...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs),
  ].map((match) => JSON.parse(match[1]));
}

test("synthetic snapshot is immutable and never points to a real retailer", () => {
  assert.equal(snapshot.dataKind, "synthetic_fixture");
  assert.ok(Object.isFrozen(snapshot.products[0]));
  assert.ok(snapshot.products.every(isIllustrative));
  assert.equal(snapshot.heldProducts.length, 1);
  assert.equal(
    snapshot.products.some((product) => product.price !== 0),
    false,
  );
});
test("random is bounded, deadline-filtered, and cannot repeat immediately", () => {
  assert.equal(
    eligiblePool(
      Array.from({ length: 80 }, () => snapshot.products[0]),
      Date.parse(snapshot.generatedAt),
    ).length,
    48,
  );
  assert.equal(
    eligiblePool(snapshot.products, Date.parse("2026-11-20T00:00:00.000Z"))
      .length,
    0,
  );
  for (let count = 2; count < 50; count++)
    for (let current = 0; current < count; current++)
      for (const random of [0, 0.2, 0.99, 1]) {
        const next = nextRandomIndex(count, current, () => random);
        assert.notEqual(next, current);
        assert.ok(next >= 0 && next < count);
      }
  assert.equal(nextRandomIndex(1, 0), 0);
});
test("initial random pick reaches the whole pool and avoids the previous visit", () => {
  const gifts = Array.from({ length: 48 }, (_, i) => ({ id: String(i) }));
  assert.equal(initialRandomIndex(gifts, null, () => 0), 0);
  assert.equal(initialRandomIndex(gifts, "missing", () => 0.999), 47);
  for (let previous = 0; previous < gifts.length; previous++)
    for (const random of [0, 0.2, 0.99, 1]) {
      const next = initialRandomIndex(gifts, String(previous), () => random);
      assert.notEqual(next, previous);
      assert.ok(next >= 0 && next < gifts.length);
    }
  assert.equal(initialRandomIndex([{ id: "only" }], "only"), 0);
});
test(
  "every content-bearing export is guarded, including nested RSC payloads",
  { skip: !fs.existsSync(new URL("out/index.html", root)) },
  () => {
    const inventory = files(new URL("out/", root));
    const routes = exportedRoutes(exportSnapshot, inventory);
    if (inventory.includes("/safe/product/__next._index.txt"))
      for (const held of exportSnapshot.heldProducts)
        assert.equal(routes[`${held.path}/__next._index.txt`].assetPath, "/safe/product/__next._index.txt");
    for (const asset of inventory.filter(
      (file) =>
        /\.(html|txt|json)$/.test(file) &&
        !/^\/(?:_next|safe|privacy|fonts|robots|404|_not-found)(?:[/\.]|$)/.test(
          file,
        ),
    )) {
      assert.ok(routes[asset], `missing ${asset}`);
      assert.ok(
        inventory.includes(routes[asset].safeAssetPath),
        `missing safe asset ${routes[asset].safeAssetPath}`,
      );
      assert.equal(routes[asset].indexable, false);
    }
    assert.equal(routes["/howie"].indexable, false);
    assert.equal(routes["/preview/presentation"].indexable, false);
    for (const held of exportSnapshot.heldProducts) {
      assert.equal(routes[held.path].state, "held");
      assert.equal(routes[`${held.path}.txt`].state, "held");
    }
    assert.equal(
      routes["/index.html"].eligibleUntil,
      earliestDisplayExpiry(exportSnapshot.products),
    );
    // Historical exports also publish standalone Flight; document output uses
    // inline hydration instead. Any retained companion still needs its policy.
    if (routes["/__next.__PAGE__.txt"])
      assert.equal(routes["/__next.__PAGE__.txt"].eligibleUntil, routes["/index.html"].eligibleUntil);
    assert.throws(
      () => exportedRoutes(exportSnapshot, [...inventory, "/orphan.txt"]),
      /no freshness policy/,
    );
  },
);
test(
  "legacy related product deadline protects detail HTML and RSC too",
  () => {
    // A legacy-only fixture keeps testing the original supplier-only contract,
    // even when the real export now contains permanent views/photo overlays.
    const changed = structuredClone(snapshot);
    const related = changed.products[Math.min(2, changed.products.length - 1)];
    changed.products[0].humorTags = ["desk"];
    related.humorTags = ["desk"];
    related.eligibleUntil = "2026-10-21T00:00:00.000Z";
    const pages = ["/random-gift", "/gift-guides", "/howie", "/preview/presentation",
      ...guides.map(guide => `/gift-guides/${guide.slug}`), ...changed.products.map(product => `/gifts/${product.slug}`)];
    const inventory = ["/index.html", "/index.txt", ...pages.flatMap(page => [`${page}.html`, `${page}.txt`]),
      ...["catalog", "product", "howie", "presentation"].flatMap(page => [`/safe/${page}.html`, `/safe/${page}.txt`]),
      "/safe/catalog.json", ...["_full", "_tree", "safe.product.__PAGE__"].map(part => `/safe/product/__next.${part}.txt`),
      ...createBrowseRelease(changed).shards.map(shard => shard.path), ...createOgRelease(changed, siteIdentity).byPath.keys()];
    const routes = createStaticRoutes(changed, inventory);
    assert.equal(
      routes[`/gifts/${changed.products[0].slug}`].eligibleUntil,
      related.eligibleUntil,
    );
    assert.equal(
      routes[`/gifts/${changed.products[0].slug}.txt`].eligibleUntil,
      related.eligibleUntil,
    );
  },
);
test(
  "retained hub and guide artifacts match their one build snapshot without a duplicate directory",
  { skip: !fs.existsSync(new URL("out/index.html", root)) },
  () => {
    const hub = fs.readFileSync(new URL("out/gift-guides.html", root), "utf8");
    assert.equal(schemas(hub)[0].mainEntity.numberOfItems, 43);
    for (const guide of guides) {
      assert.ok(hub.includes(`href="/gift-guides/${guide.slug}"`));
      const html = fs.readFileSync(
        new URL(`out/gift-guides/${guide.slug}.html`, root),
        "utf8",
      );
      const selected = selectGuideProducts(exportSnapshot, guide);
      const graph = schemas(html)[0]["@graph"];
      const list = graph.find((item) => item["@type"] === "ItemList");
      assert.equal(list.numberOfItems, selected.length);
      assert.deepEqual(
        list.itemListElement.map((item) => new URL(item.url).pathname),
        selected.map((p) => `/gifts/${p.slug}`),
      );
      assert.equal(
        graph.some((item) => item["@type"] === "FAQPage"),
        Boolean(guide.faqs?.length),
      );
      if (!selected.length) assert.match(html, /No matching gifts yet/);
      for (const product of exportSnapshot.products)
        assert.equal(
          html.includes(`href="/gifts/${product.slug}"`),
          selected.some((p) => p.id === product.id),
        );
    }
    assert.equal(fs.existsSync(new URL("out/gifts.html", root)), false);
    assert.equal(fs.existsSync(new URL("out/gifts/page/", root)), false);
    assert.equal(fs.existsSync(new URL("out/weird-gift-index.html", root)), false);
    assert.equal(fs.existsSync(new URL("out/weird-gift-index/", root)), false);
    assert.equal(fs.existsSync(new URL("out/safe/index.json", root)), false);
  },
);
test(
  "initial browse/Random payloads stay small and their public JSON matches the release",
  { skip: !fs.existsSync(new URL("out/index.html", root)) },
  () => {
    const release = createBrowseRelease(catalogDisplayView(exportSnapshot,exportMerchandising), exportGeneratedAt, exportHomepage);
    const home = fs.readFileSync(new URL("out/index.html", root), "utf8");
    const random = fs.readFileSync(
      new URL("out/random-gift.html", root),
      "utf8",
    );
    const initial = new Set(
      [...release.opening, ...release.feed.initial].map((p) => p.slug),
    );
    for (const product of exportSnapshot.products) {
      assert.equal(
        home.includes(`href="/gifts/${product.slug}"`),
        initial.has(product.slug),
      );
      assert.equal(
        random.includes(product.slug),
        product.slug === release.random.initial?.slug,
      );
      assert.equal((home + random).includes(product.affiliateUrl), false);
    }
    assert.doesNotMatch(
      home + random,
      /affiliateUrl|editorialWriteup|sourceFacts|qualityScore/,
    );
    for (const shard of release.shards)
      assert.deepEqual(
        JSON.parse(fs.readFileSync(new URL(`out${shard.path}`, root), "utf8")),
        shard.payload,
      );
  },
);
test(
  "export has crawlable links, build-mode indexing and no private or finite product data in immutable JS",
  { skip: !fs.existsSync(new URL("out/index.html", root)) },
  () => {
    const html = fs.readFileSync(new URL("out/index.html", root), "utf8");
    assert.ok(
      html.includes(`href="/gifts/${exportSnapshot.products[0].slug}"`),
    );
    const robots=html.match(/<meta name="robots" content="([^"]+)"/)[1].split(/,\s*/);
    const indexable=exportSourceMode!=='preview'&&exportSnapshot.dataKind==='catalog'&&createBrowseRelease(exportSnapshot, exportGeneratedAt).opening.length>0;
    assert.equal(robots.includes('index'),indexable);
    assert.equal(robots.includes('noindex'),!indexable);
    assert.doesNotMatch(html, /\$0\.00|https:\/\/example\.invalid/i);
    // A retained retailer title may truthfully mention a TV appearance. It is
    // not a site endorsement; keep that prohibition on site-authored markup.
    const siteMarkup=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
      .replace(/<article\b[^>]*class="product-card[^"]*"[^>]*>[\s\S]*?<\/article>/gi,'');
    assert.doesNotMatch(siteMarkup,/as seen on/i);
    const routes = exportedRoutes(exportSnapshot, files(new URL("out/", root)));
    for (const product of exportSnapshot.heldProducts) {
      const route = routes[product.path];
      assert.equal(route.state, "held");
      assert.equal(route.assetPath, "/safe/product.html");
      const held = fs.readFileSync(
        new URL(`out${route.assetPath}`, root),
        "utf8",
      );
      assert.doesNotMatch(held, /sourceFacts|"@type":"(?:Offer|Product)"|data-analytics-outbound|rel="canonical"/);
      for (const ready of exportSnapshot.products)
        assert.equal(held.includes(ready.imageUrl), false);
    }
    const safe = fs.readFileSync(
      new URL("out/safe/catalog.html", root),
      "utf8",
    );
    assert.match(safe, /id="catalog-search"/);
    assert.match(safe, /name="q"/);
    assert.match(safe, /action="\/" method="get"/);
    assert.doesNotMatch(safe, /paperweight|example\.invalid|\/illustrations\//);
    const preview = fs.readFileSync(
      new URL("out/preview/presentation.html", root),
      "utf8",
    );
    assert.doesNotMatch(preview, /fixture-paperweight|example\.invalid/);
    assertOwnedCodeSafe(Buffer.from(safe),[exportSnapshot]);
    assertOwnedCodeSafe(Buffer.from(preview),[exportSnapshot]);
    for (const product of exportSnapshot.products) {
      const permanent=persistentPublicProduct(product);
      for (const field of ['id','slug','imageUrl','affiliateUrl']) {
        // Shared first-party label/disclosure props may carry cleared IDs;
        // fallback pages still cannot carry product URLs or finite/private data.
        if (field==='id'&&permanent?.id===product.id) continue;
        const value=product[field];
        assert.equal(
          safe.includes(value),
          false,
          "product content in safe fallback",
        );
        assert.equal(
          preview.includes(value),
          false,
          "product content in pending presentation",
        );
      }
    }
    const readyProduct = exportSnapshot.products[0];
    const detail = fs.readFileSync(
      new URL(`out/gifts/${readyProduct.slug}.html`, root),
      "utf8",
    );
    const random = fs.readFileSync(
      new URL("out/random-gift.html", root),
      "utf8",
    );
    if (exportSnapshot.dataKind === "catalog") {
      assert.match(
        detail.replace(/<[^>]*>/g, ""),
        /Check price on Amazon|Check price on Etsy/,
      );
      assert.doesNotMatch(detail, /Retailer listing name/);
      assert.doesNotMatch(detail, /"@type":"Offer"|\$0\.00/);
      const pool=createBrowseRelease(exportSnapshot, exportGeneratedAt, exportHomepage).random;
      assert.ok(pool.poolSize>0&&pool.poolSize<=48);
      if(pool.poolSize>1){
        assert.match(random,/class="random-loading" role="status"/);
        assert.match(random,/Choosing a gift/);
      }else assert.match(random,/<button\b[^>]*type="button"/);
      assert.match(random,/aria-live="polite"/);
      for (const guide of guides) {
        const html = fs.readFileSync(
          new URL(`out/gift-guides/${guide.slug}.html`, root),
          "utf8",
        );
        const selected = new Set(
          selectGuideProducts(exportSnapshot, guide).map((p) => p.id),
        );
        for (const product of exportSnapshot.products) {
          assert.equal(
            html.includes(`href="/gifts/${product.slug}"`),
            selected.has(product.id),
            `incorrect membership in ${guide.slug}`,
          );
        }
      }
    }
    for (const file of files(new URL("out/_next/", root)).filter((file) =>
      file.endsWith(".js"),
    )) {
      const content = fs.readFileSync(
        new URL(`out/_next${file}`, root),
        "utf8",
      );
      assert.doesNotMatch(
        content,
        /fixture-paperweight|illustrative-very-official-paperweight|A very official paperweight|\/illustrations\/paperweight|example\.invalid\/not-for-sale|sourceFactsHash|POSTGRES_URL/,
      );
      // A real production export may deliberately include the approved public
      // analytics destinations. Preview/fixture exports must still exclude them.
      if (exportSourceMode === 'preview' || exportSnapshot.dataKind !== 'catalog')
        assert.doesNotMatch(content, /G-6RR3HPR747|AW-17626116539|googletagmanager/);
      assertOwnedCodeSafe(Buffer.from(content),[exportSnapshot]);
      for (const product of exportSnapshot.products) {
        const permanent=persistentPublicProduct(product);
        for (const field of ['id','slug','title','imageUrl','affiliateUrl']) {
          // Exact cleared, permanent ID/title pairs key the reviewed factual
          // short notes. URLs, slugs, supplier/private fields remain forbidden.
          if ((field==='id'||field==='title')&&permanent?.[field]===product[field]) continue;
          const value=product[field];
          assert.equal(
            content.includes(value),
            false,
            `product data in ${file}`,
          );
        }
      }
    }
  },
);
