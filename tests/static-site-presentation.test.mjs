import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { shortProductName } from "../static-site/lib/product-presentation.ts";
import { createRelatedGiftSelector } from "../static-site/lib/related-gifts.ts";
import { rankedBrowseProducts } from "../static-site/lib/browse.ts";
import { createStaticRoutes } from "../static-site/lib/asset-routes.ts";
import { createBrowseRelease } from "../static-site/lib/browse.ts";
import { createOgRelease } from "../static-site/lib/og.ts";
import { guides } from "../static-site/lib/guides.ts";
import { siteIdentity } from "../static-site/lib/site-identity.ts";
import homepage from "../content/homepage.json" with { type: "json" };

test("merchant names get a concise, factual presentation without changing the source", () => {
  const title = "OTOTO Jar Scraper Spatula - Silicone Scraper, Cute Kitchen Accessories, Gifts for Foodies";
  assert.equal(shortProductName(title), "OTOTO Jar Scraper Spatula");
  assert.equal(title.includes("Gifts for Foodies"), true);
  assert.equal(shortProductName("The Moon Ring®© | Prank ring box"), "The Moon Ring");
  assert.equal(shortProductName("Small mug, red ceramic coffee mug"), "Small mug, red ceramic coffee mug");
  const long = "A useful ceramic coffee mug with a very long retailer title and a whole assortment of search terms attached";
  assert.equal(shortProductName(long), long);
  for (const dots of ["...", "…"]) {
    assert.equal(shortProductName("The Art of Drawing Optical Illusions: How to draw mind-bending " + dots), "The Art of Drawing Optical Illusions");
    assert.equal(shortProductName("Funny Cooking Apron with " + dots), "Funny Cooking Apron");
    assert.equal(shortProductName("A mysterious unfinished " + dots), "A mysterious unfinished " + dots);
  }
  assert.equal(shortProductName("Star Trek: The Next Generation"), "Star Trek: The Next Generation");
  assert.equal(shortProductName("Original fictional gift"), "Original fictional gift");
  assert.equal(shortProductName("21st Birthday Gifts for Her Him - Happy Prank Toilet Paper - Party Supplies"), "Happy Prank Toilet Paper");
  assert.equal(shortProductName("Gag Gifts - White Elephant Gag Gifts Calendar 2027, Nature Butts"), "White Elephant Gag Gifts Calendar 2027");
});

test("related gifts prefer meaningful object and interest matches over generic gift keywords", () => {
  const make = (id, title, humorTags) => ({ id, title, humorTags });
  const subject = make("frog", "Grumpy Frog Statue", ["desk", "novelty"]);
  const products = [subject,
    make("mug", "Funny Christmas Gift Mug", ["novelty"]),
    make("toast", "Small Crochet Birthday Toast", ["novelty"]),
    make("frog2", "Frog Garden Statue", ["frog-lovers"]),
    make("frog3", "Tiny Frogs in Chairs", ["desk"]),
    make("goat", "Screaming Goat", ["desk"]),
  ];
  const before = JSON.stringify(products);
  const select = createRelatedGiftSelector(products);
  assert.deepEqual(select(subject).map(p => p.id), ["frog3", "frog2", "goat"]);
  assert.deepEqual(select(subject).map(p => p.id), select(subject).map(p => p.id));
  assert.equal(select(subject).some(p => p.id === subject.id), false);
  assert.equal(JSON.stringify(products), before);
  assert.deepEqual(createRelatedGiftSelector([subject])(subject), []);
  assert.deepEqual(createRelatedGiftSelector([make("unrelated", "Silicone Ladle", [])])(subject), []);
  assert.doesNotThrow(() => createRelatedGiftSelector([{ id: "no-tags", title: "Small cup" }])(subject));
});

test("the curated opening is an explicit diverse batch, without dropping any source identity", () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL("../static-site/fixtures/catalog.snapshot.json", import.meta.url)));
  const before = JSON.stringify(snapshot);
  const ranked = rankedBrowseProducts(snapshot);
  assert.deepEqual(ranked.map(p => p.id).sort(), snapshot.products.map(p => p.id).sort());
  assert.equal(new Set(homepage.featuredIds).size, 24);
  assert.deepEqual(Object.keys(homepage),['featuredIds'],'copy belongs to the canonical presentation, not a homepage override');
  assert.equal(JSON.stringify(snapshot), before);
});

test("storefront uses a white consistent gallery and preserves detail copy behind an accessible disclosure", () => {
  const read = name => fs.readFileSync(new URL(`../static-site/${name}`, import.meta.url), "utf8");
  assert.match(read("app/styles.css"), /--paper: #ffffff/);
  assert.match(read("app/styles.css"), /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(read("app/styles.css"), /\.opening-grid/);
  assert.match(read("app/page.tsx"), /initial=\{\[\.\.\.browse.opening, \.\.\.browse.feed.initial\]\}/);
  const detail = read("app/gifts/[slug]/page.product.tsx");
  assert.doesNotMatch(detail, /A carefully considered bad idea|While you’re considering it|product\.punnyTitle/);
  assert.match(detail, /relatedGifts\(product\)/);
  assert.match(detail, /<details className="editorial">/);
  assert.match(detail, /product\.editorialWriteup/);
});

test("detail route expiry follows newly matched related gifts, not the old first-three shortcut", () => {
  const snapshot = JSON.parse(fs.readFileSync(new URL("../static-site/fixtures/catalog.snapshot.json", import.meta.url)));
  const prototype = snapshot.products[0];
  snapshot.products = Array.from({length: 5}, (_, i) => ({ ...prototype,
    id: `related-${i}`, publicId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    slug: `related-${i}`, title: i === 0 || i === 4 ? "Grumpy frog statue" : `Different object ${i}`,
    humorTags: i === 0 || i === 4 ? ["frog-lovers"] : [],
    eligibleUntil: i === 4 ? "2026-10-21T00:00:00.000Z" : prototype.eligibleUntil,
  }));
  snapshot.heldProducts = [];
  const pages = ["/random-gift", "/gift-guides", "/howie", "/preview/presentation",
    ...guides.map(g => `/gift-guides/${g.slug}`), ...snapshot.products.map(p => `/gifts/${p.slug}`)];
  const inventory = ["/index.html", "/index.txt", ...pages.flatMap(p => [`${p}.html`, `${p}.txt`]),
    ...["catalog", "product", "howie", "presentation"].flatMap(p => [`/safe/${p}.html`, `/safe/${p}.txt`]),
    "/safe/catalog.json", ...createBrowseRelease(snapshot).shards.map(s => s.path), ...createOgRelease(snapshot, siteIdentity).byPath.keys()];
  const routes = createStaticRoutes(snapshot, inventory);
  assert.equal(routes["/gifts/related-0"].eligibleUntil, snapshot.products[4].eligibleUntil);
  assert.equal(routes["/gifts/related-0.txt"].eligibleUntil, snapshot.products[4].eligibleUntil);
});
