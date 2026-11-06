import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { selectShowPicks, SHOW_PICK_SLUGS } from "../static-site/lib/show-rehearsal.ts";
import { productPresentation } from "../lib/catalog/presentation.ts";
import copy from "../content/catalog-presentation.json" with { type: "json" };

const product = (slug, id, overrides = {}) => ({
  id, publicId: id, slug, title: `Gift ${id}`, description: "A gift.",
  imageUrl: "/owned.svg", affiliateUrl: "https://example.com/product", source: "amazon",
  currency: "USD", price: 0, isActive: true, qualityScore: 0.8, eligibleUntil: null, ...overrides,
});

test("Billy Ray shortlist is distinct, visually relevant and excludes retired gags", () => {
  assert.equal(SHOW_PICK_SLUGS.length, 8);
  assert.equal(new Set(SHOW_PICK_SLUGS).size, SHOW_PICK_SLUGS.length);
  for (const slug of SHOW_PICK_SLUGS) assert.doesNotMatch(slug, /wiener|belly-fanny|farting-ring/);
  assert.equal(SHOW_PICK_SLUGS[0], "country-cat-cowboy-decor-for-cat-lovers");
  assert.ok(SHOW_PICK_SLUGS.includes("guitar-shaped-cutting-board-wood-for-kitchen"));
});
const snapshot = (products) => ({
  schemaVersion: 1, dataKind: "catalog", catalogRevision: "test", generatedAt: "2026-10-26T00:00:00.000Z",
  products, heldProducts: [], slugHistory: [],
});

test("show picks preserve fixed order and exact shared product copy", () => {
  const products = SHOW_PICK_SLUGS.map((slug, i) => product(slug, String(i)));
  const selected = selectShowPicks(snapshot([...products].reverse()));
  assert.deepEqual(selected.map((p) => p.slug), [...SHOW_PICK_SLUGS]);
  assert.deepEqual(selected, products);
});

test("show page renders picks directly without a search, reveal gate or per-page copy", () => {
  const page = fs.readFileSync(new URL("../static-site/app/h/page.tsx", import.meta.url), "utf8");
  assert.match(page, /picks\.map/);
  assert.match(page, /indexable: false/);
  assert.doesNotMatch(page, /ShowRehearsal|selectShowOpening|SHOW_PICK_COPY|presentation=|hidden=|<form|<input/);
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
