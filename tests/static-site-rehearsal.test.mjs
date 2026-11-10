import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { selectShowPicks, SHOW_PICK_SLUGS, SHOW_PRESETS, SHOW_PRESET_KEYS, ACTIVE_SHOW_PRESET, isShowPreset } from "../static-site/lib/show-rehearsal.ts";
import { productPresentation } from "../lib/catalog/presentation.ts";
import copy from "../content/catalog-presentation.json" with { type: "json" };

const product = (slug, id, overrides = {}) => ({
  id, publicId: id, slug, title: `Gift ${id}`, description: "A gift.",
  imageUrl: "/owned.svg", affiliateUrl: "https://example.com/product", source: "amazon",
  currency: "USD", price: 0, isActive: true, qualityScore: 0.8, eligibleUntil: null, ...overrides,
});

test("Billy Ray's original eight picks stay intact and Matan becomes the distinct active edition", () => {
  assert.deepEqual(SHOW_PRESETS["billy-ray"], [
    "country-cat-cowboy-decor-for-cat-lovers",
    "cluck-yeah-chicken-leg-socks-for-poultry-lovers",
    "guitar-shaped-cutting-board-wood-for-kitchen",
    "rooster-but-not-a-roost-wine-bottle-holder",
    "wrap-it-up-tortilla-blanket-for-foodies",
    "trash-talk-with-the-raccoon-desk-buddy",
    "desktop-boxing-knock-out-stress-in-style",
    "lobster-claw-oven-mitts-quilted-cotton-lining-design-heat-resistant-crab-claw-gloves-microwave-oven-gloves-lobster-oven",
  ]);
  assert.equal(ACTIVE_SHOW_PRESET, "matan");
  assert.equal(SHOW_PICK_SLUGS, SHOW_PRESETS.matan);
  assert.deepEqual(SHOW_PICK_SLUGS.slice(0, 6), ["B005LY2HHO", "B0BVCTV6WL", "B0HNWBJ1L3", "B09VTJRGBJ", "B08BC25ZTP", "B0CGXSKGXL"]);
  for (const slugs of Object.values(SHOW_PRESETS)) {
    assert.equal(new Set(slugs).size, slugs.length);
    for (const slug of slugs) assert.doesNotMatch(slug, /belly-fanny|farting-ring|screaming-goat|mystic-pickle|raw-chicken-vase/);
  }
  assert.equal(SHOW_PRESETS.matan.length, 12);
  assert.deepEqual(SHOW_PRESETS.matan.slice(-3), ["B0FMXQJW2V", "B0H2TW8LZ9", "B0HDRTSB19"]);
  assert.ok(!SHOW_PRESETS.matan.includes("B0B3XCGVJB")); // Duck is site-only.
  assert.ok(SHOW_PICK_SLUGS.every((slug) => !SHOW_PRESETS["billy-ray"].includes(slug)));
  for (const key of SHOW_PRESET_KEYS) assert.equal(isShowPreset(key), true);
  for (const key of ["unknown", "toString", "__proto__"]) assert.equal(isShowPreset(key), false);
});
const snapshot = (products) => ({
  schemaVersion: 1, dataKind: "catalog", catalogRevision: "test", generatedAt: "2026-10-26T00:00:00.000Z",
  products, heldProducts: [], slugHistory: [],
});

test("show picks preserve fixed order and exact shared product copy", () => {
  for (const preset of SHOW_PRESET_KEYS) {
    const products = SHOW_PRESETS[preset].map((slug, i) => product(slug, String(i)));
    const selected = selectShowPicks(snapshot([...products].reverse()), preset);
    assert.deepEqual(selected.map((p) => p.slug), [...SHOW_PRESETS[preset]]);
    assert.deepEqual(selected, products);
  }
});

test("new show picks resolve exact ASINs to current canonical products without duplicate admission or copy", () => {
  const ids = ["B0FMXQJW2V", "B0H2TW8LZ9", "B0HDRTSB19"];
  const products = ids.map((id, i) => product(`generated-canonical-slug-${i}`, id));
  products.push(product("catnip-duck-site-only", "B0B3XCGVJB"));
  assert.deepEqual(selectShowPicks(snapshot(products)), products.slice(0, 3));
  assert.deepEqual(selectShowPicks(snapshot(products), "billy-ray"), []);
});

test("show page renders fresh picks immediately with ordinary storefront search and no guest label", () => {
  const page = fs.readFileSync(new URL("../static-site/app/h/page.tsx", import.meta.url), "utf8");
  assert.match(page, /indexable: false/);
  assert.match(page, /<ShowShortlist \/>/);
  const shared = fs.readFileSync(new URL("../static-site/components/ShowShortlist.tsx", import.meta.url), "utf8");
  assert.match(shared, /picks\.map/);
  assert.match(shared, /<Search action=\{action\} autoSearch=\{false\}>/);
  assert.doesNotMatch(shared, /Hand-picked for|show-intro|Billy Ray|Matan/);
  assert.doesNotMatch(shared, /ShowRehearsal|selectShowOpening|SHOW_PICK_COPY|presentation=|hidden=|<form|<input/);
  const saved = fs.readFileSync(new URL("../static-site/app/h/[preset]/page.tsx", import.meta.url), "utf8");
  assert.match(saved, /dynamicParams = false/);
  assert.match(saved, /SHOW_PRESET_KEYS\.map/);
  assert.match(saved, /if \(!isShowPreset\(preset\)\) notFound\(\)/);
  assert.match(saved, /indexable: false/);
  assert.match(saved, /action=\{`\/h\/\$\{preset\}`\}/);
});

test("reviewed Billy Ray titles and descriptions are the shared canonical presentation", () => {
  for (const id of ["B08TJ1BSDV", "B0731P1WYY", "B0B5RCZ77D"]) {
    const review = copy[id];
    const view = productPresentation(product("test", id, {
      title: review.sourceTitle, description: review.sourceCopy,
    }));
    assert.equal(view.title, review.title);
    assert.equal(view.description, review.description);
    assert.deepEqual(productPresentation(view), view);
    assert.equal(productPresentation({ ...view, title: "Different object", description: "Different copy" }).description, "Different copy");
  }
});

test("an unavailable pick is omitted, not silently replaced by an unrehearsed product", () => {
  const products = SHOW_PICK_SLUGS.map((slug, i) => product(slug, String(i), i === 0 ? { isActive: false } : {}));
  products.push(product("not-rehearsed", "extra"));
  assert.deepEqual(selectShowPicks(snapshot(products)).map((p) => p.slug), SHOW_PICK_SLUGS.slice(1));
});
