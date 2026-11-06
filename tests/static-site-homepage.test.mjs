import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createHash } from "node:crypto";
import { giftGuides } from "../lib/gift-guide-definitions.ts";

const require = createRequire(import.meta.url);
function load(file, overrides = {}) {
  const source = fs.readFileSync(new URL(`../static-site/${file}`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } });
  const commonJs = { exports: {} };
  vm.runInNewContext(outputText, { module: commonJs, exports: commonJs.exports, AbortController,
    require: (name) => overrides[name] || (name.startsWith(".")
      ? createRequire(new URL(`../static-site/${file}`, import.meta.url))(name) : require(name)) });
  return commonJs.exports;
}

test("each published guide has an intentional, accessible line icon instead of a number or emoji", () => {
  const icon = load("components/Icon.tsx");
  const { GuideIcon, guideIcons } = load("components/GuideIcon.tsx", { "./Icon": icon });
  assert.deepEqual(Object.keys(guideIcons).sort(), giftGuides.map(({ slug }) => slug).sort());
  assert.ok(new Set(Object.values(guideIcons)).size >= 25);
  for (const guide of giftGuides) {
    const html = renderToStaticMarkup(GuideIcon({ slug: guide.slug }));
    assert.match(html, /<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
    assert.match(html, /stroke="currentColor"/);
    assert.match(html, /<path d="[^"]+"/);
    assert.doesNotMatch(html, /<text|\p{Extended_Pictographic}/u);
  }
});

test("real gift cards have no repeated collection label or Unicode arrow; fixtures stay clearly labeled", () => {
  const { ProductCard } = load("components/ProductCard.tsx", {
    "./Icon": load("components/Icon.tsx"),
    "./CatalogPhotos": { CatalogCardArt: () => null, CatalogDisclosure: () => null, CatalogDescription: () => null, CatalogTitle: ({ fallback }) => fallback },
    "../lib/selection": { isIllustrative: () => false },
  });
  const product = { id: "owned-test", slug: "owned-test", source: "amazon", title: "Owned test gift",
    description: "Original editorial.", eligibleUntil: "2026-11-19T00:00:00.000Z", imageUrl: "/owned.svg",
    illustrative: false };
  const html = renderToStaticMarkup(ProductCard({ product }));
  assert.doesNotMatch(html, /The collection|class="eyebrow"|[↗→↓]/);
  assert.match(html, /data-analytics-product-link="" href="\/gifts\/owned-test"/);
  assert.match(html, /class="card-action"[^>]+href="\/gifts\/owned-test"/);
  assert.match(html, /View gift <svg[^>]+aria-hidden="true"/);
  assert.doesNotMatch(html, /data-analytics-outbound/);
  assert.match(renderToStaticMarkup(ProductCard({ product: { ...product, illustrative: true } })),
    /Illustrative fixture · not for sale/);
});

test("every initial, load-more and search card renders its image, title and short description", () => {
  const photos = load("components/CatalogPhotos.tsx", {
    "./Icon": { Icon: () => null },
    "@/components/ProductImage": { ProductImage: ({ imageUrl, alt }) => createElement("img", { src: imageUrl, alt }) },
    "../lib/photo-shard": { PHOTO_PLACEHOLDER: "/images/gift-placeholder.svg" },
  });
  const { ProductCard } = load("components/ProductCard.tsx", {
    "./Icon": load("components/Icon.tsx"),
    "./CatalogPhotos": photos, "../lib/selection": { isIllustrative: () => false },
  });
  const product = { id: "unfeatured", source: "amazon", slug: "unfeatured-object", title: "Unfeatured desk object",
    description: "A small desk object with a useful visual joke.", imageUrl: "/owned.svg", eligibleUntil: null };
  const before = JSON.stringify(product);
  for (const context of ["home_browse", "catalog_search", "gift_guide:office-prank-gifts"]) {
    for (const source of ["amazon", "etsy"]) {
      const html = renderToStaticMarkup(createElement(photos.CatalogPhotos, { indexPath: null },
        createElement(ProductCard, { product: { ...product, source }, context })));
      assert.match(html, /<img[^>]+src="\/owned.svg"[^>]+alt="Unfeatured desk object"/);
      assert.match(html, /<h2><a[^>]+>Unfeatured desk object<\/a><\/h2>/);
      assert.ok(html.includes(`<p class="card-description">${product.description}</p>`));
      assert.match(html, new RegExp(`data-analytics-context="${context}"`));
    }
  }
  const render = (id, curated) => renderToStaticMarkup(createElement(photos.CatalogPhotos,
    { indexPath: null, ...curated }, createElement(ProductCard, { product: { ...product, id } })));
  assert.ok(render(product.id, { descriptions: { unfeatured: "Obsolete override." } }).includes(product.description));
  assert.ok(render(product.id, { cardNotes: { unfeatured: "Obsolete note." } }).includes(product.description));
  assert.ok(render(product.id, { cardNotes: { unfeatured: " " }, descriptions: { unfeatured: " " } }).includes(product.description));
  assert.ok(render("toString", {}).includes(product.description));
  assert.equal(JSON.stringify(product), before);
  const feed = fs.readFileSync(new URL("../static-site/components/CatalogFeed.tsx", import.meta.url), "utf8");
  const search = fs.readFileSync(new URL("../static-site/components/Search.tsx", import.meta.url), "utf8");
  assert.match(feed, /state\.products\.map\(\(product\) => \([\s\S]*<ProductCard/);
  assert.match(search, /state\.products\.map\(\(product\) => \([\s\S]*<ProductCard/);
});

test("photo-free cards are compact at SSR; exact optional slots reserve geometry without fake image alt", () => {
  const icon = load("components/Icon.tsx");
  const photos = load("components/CatalogPhotos.tsx", {
    "./Icon": icon,
    "@/components/ProductImage": { ProductImage: ({ imageUrl, alt }) => createElement("img", { src: imageUrl, alt }) },
    "../lib/photo-shard": { PHOTO_PLACEHOLDER: "/images/gift-placeholder.svg" },
  });
  const photoSlots = Array.from({ length: 8 }, (_, i) => `owned-${i}`);
  const cards = Array.from({ length: 2359 }, (_, i) => createElement(photos.CatalogCardArt, {
    key: i, id: `owned-${i}`, href: `/gifts/owned-${i}`, label: `View owned gift ${i}`,
    imageUrl: "/images/gift-placeholder.svg", alt: `Owned gift ${i}`,
  }));
  const html = renderToStaticMarkup(createElement(photos.CatalogPhotos,
    { indexPath: `/catalog/${"a".repeat(64)}/photos.json`, photoSlots }, cards));
  assert.equal((html.match(/photo-unavailable/g) || []).length, 2351);
  assert.equal((html.match(/Photo unavailable/g) || []).length, 2351);
  assert.equal((html.match(/<img /g) || []).length, 8);
  assert.equal((html.match(/alt=""/g) || []).length, 8);
  assert.equal((html.match(/href="\/gifts\/owned-/g) || []).length, 2359);
  assert.equal((html.match(/<svg[^>]*aria-hidden="true"/g) || []).length, 2351);
  assert.doesNotMatch(html, /https:|supplier|data-analytics-outbound/);
});

test("guide selection copy uses plain public language without changing membership controls", () => {
  const source = fs.readFileSync(new URL("../static-site/app/gift-guides/[slug]/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Gift ideas/);
  assert.match(source, /No matching gifts yet/);
  assert.doesNotMatch(source, /Catalog matches in this snapshot|No matching ready products|Browse the collection/);
  assert.match(source, /selectGuideProducts\(catalog, guide\)/);
});

test("new site-authored packaging disclosure matches only the exact Amazon ASIN, without mutating catalog data", async () => {
  const { siteEditorialDisclosures } = load("lib/site-editorial.ts", { "server-only": {} });
  const photos = load("components/CatalogPhotos.tsx", {
    "./Icon": { Icon: () => null },
    "@/components/ProductImage": { ProductImage: () => null },
    "../lib/photo-shard": { PHOTO_PLACEHOLDER: "/images/gift-placeholder.svg" },
  });
  const { ProductCard } = load("components/ProductCard.tsx", {
    "./Icon": load("components/Icon.tsx"),
    "./CatalogPhotos": photos, "../lib/selection": { isIllustrative: () => false },
  });
  const product = { id: "B0757WW6KB", source: "amazon", slug: "owned-fixture", title: "Owned identity label",
    description: "Owned identity label", imageUrl: "/images/gift-placeholder.svg", eligibleUntil: null };
  const hash = () => createHash("sha256").update(JSON.stringify(product)).digest("hex"), before = hash();
  const render = child => renderToStaticMarkup(createElement(photos.CatalogPhotos,
    { indexPath: null, editorialDisclosures: siteEditorialDisclosures }, child));
  const note = "Empty prank gift box. No fire kit included.";
  for (const eligibleUntil of [null, "2020-01-01T00:00:00.000Z"]) {
    const html = render(createElement(ProductCard, { product: { ...product, eligibleUntil } }));
    assert.equal(html.split(note).length - 1, 1);
    assert.match(html, /photo-unavailable/);
  }
  for (const patch of [{ source: "etsy" }, { id: "B0757WW6KX" }, { id: "unknown", slug: product.slug }])
    assert.doesNotMatch(render(createElement(ProductCard, { product: { ...product, ...patch } })), /No fire kit included/);
  const { default: Gift } = load("app/gifts/[slug]/page.product.tsx", {
    "../../../components/Icon": load("components/Icon.tsx"),
    "next/navigation": { notFound() { throw new Error("Unexpected notFound"); } },
    "../../../components/CatalogPhotos": photos,
    "@/lib/gift-page-schema": { buildGiftPageSchema: () => ({}) },
    "../../../lib/catalog": { catalog: { products: [product], dataKind: "catalog" }, relatedGifts: () => [] },
    "../../../lib/selection": { isIllustrative: () => false },
    "../../../lib/metadata": { previewMetadata: () => ({}), PREVIEW_ORIGIN: "https://stupid.gifts" },
    "../../../components/ProductCard": { ProductCard: () => null },
    "../../../lib/og-data": { og: { cards: [] } },
  });
  const detail = render(await Gift({ params: Promise.resolve({ slug: product.slug }) }));
  assert.equal(detail.split(note).length - 1, 1);
  assert.match(detail, /<h1>Owned identity label<\/h1><p class="product-disclosure">/);
  assert.equal(hash(), before);
  assert.doesNotMatch(fs.readFileSync(new URL("../static-site/components/CatalogPhotos.tsx", import.meta.url), "utf8"), /B0757WW6KB|No fire kit/);
});

test("home is the browse destination with the approved heading and no redundant collection navigation", () => {
  const read = (name) => fs.readFileSync(new URL(`../static-site/${name}`, import.meta.url), "utf8");
  assert.match(read("app/page.tsx"), /Stupid gifts\. <span>Excellent taste\.<\/span>/);
  assert.doesNotMatch(read("app/page.tsx"), /Ridiculous gifts|well-considered collection|<span>0[123]<\/span>/);
  assert.doesNotMatch(read("app/layout.tsx"), /The collection|weird-gift-index|Search <span/);
  assert.doesNotMatch(read("components/CatalogFeed.tsx"), /More questionable|Full collection/);
  assert.match(read("components/CatalogFeed.tsx"), /Load more/);
});

test("clamped card titles draw the keyboard focus ring outside the clipping heading", () => {
  const css = fs.readFileSync(new URL("../static-site/app/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.product-card h2\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.product-card h2:has\(a:focus-visible\)\s*\{\s*outline:\s*2px solid var\(--accent\);\s*outline-offset:\s*5px;/);
  assert.match(css, /\.product-card h2 a:focus-visible\s*\{\s*outline:\s*none;/);
});

test("Load more failure preserves visible gifts and the cursor for a successful retry", async () => {
  const initial = [{ id: "first", eligibleUntil: "2030-01-01T00:00:00.000Z" }];
  let state, calls = 0;
  const { CatalogFeed } = load("components/CatalogFeed.tsx", {
    react: { useEffect() {}, useRef: (value) => ({ current: value }),
      useState(value) { state = value; return [state, (update) => {
        state = typeof update === "function" ? update(state) : update;
      }]; } },
    "./ProductCard": { ProductCard: () => null },
    "../lib/analytics": { captureRenderedLists() {} },
    "../lib/card-shard": { async fetchCardShard() {
      if (++calls === 1) throw new Error("Temporary network failure");
      return { products: [{ id: "second", eligibleUntil: "2030-01-01T00:00:00.000Z" }], next: null };
    } },
  });
  const view = CatalogFeed({ initial, next: "/next.json", catalogRevision: "owned", version: "owned" });
  const button = view.props.children.find((child) => child?.type === "button");
  await button.props.onClick();
  assert.equal(state.products, initial);
  assert.equal(state.next, "/next.json");
  assert.equal(state.status, "unavailable");
  await button.props.onClick();
  assert.deepEqual(Array.from(state.products, ({ id }) => id), ["first", "second"]);
  assert.equal(state.next, null);
  assert.equal(state.status, "ready");
});
