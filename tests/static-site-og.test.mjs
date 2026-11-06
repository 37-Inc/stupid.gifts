import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createOgRelease, ogPath, ogText } from "../static-site/lib/og.ts";
import { renderOgPng } from "../static-site/lib/og-image.ts";
import { previewMetadata } from "../static-site/lib/metadata.ts";
import { siteIdentity } from "../static-site/lib/site-identity.ts";
import { exportIdentity, exportedRoutes } from "./helpers/static-export.mjs";
import {catalogDisplayView} from '../lib/catalog/display.ts';

const fixture = JSON.parse(fs.readFileSync(new URL("../static-site/fixtures/catalog.snapshot.json", import.meta.url)));
const identity = { name: "Goose Gifts", origin: "https://www.goose.gifts", tagline: "Ridiculous gifts. Excellent taste." };
test("owned OG descriptors are deterministic, identity-explicit and never copy merchant images/private/held fields", () => {
  const input = structuredClone(fixture);
  input.products[0].privateRights = "must-not-ship";
  const release = createOgRelease(input, identity);
  assert.equal(release.cards.filter((c) => c.kind === "guide").length, 43);
  assert.equal(release.cards.filter((c) => c.kind === "fixture").length, input.products.length);
  assert.deepEqual(createOgRelease(structuredClone(input), identity), release);
  assert.match(ogPath(release.brand), /^\/og\/[a-f0-9]{64}\.png$/);
  for (const product of fixture.products) {
    const serialized = JSON.stringify(release.cards);
    assert.equal(serialized.includes(product.imageUrl), false);
    assert.equal(serialized.includes(product.affiliateUrl), false);
    assert.equal(serialized.includes(product.description), false);
  }
  assert.doesNotMatch(JSON.stringify(release.cards), /must-not-ship|privateRights|editorialWriteup|qualityScore|held-selection/);
  const changed = structuredClone(input); changed.products[0].eligibleUntil = "2026-11-20T00:00:00.000Z";
  assert.notEqual(ogPath(createOgRelease(changed, identity).cards.at(-input.products.length)),
    ogPath(release.cards.at(-input.products.length)));
  assert.notEqual(ogPath(createOgRelease(input, { ...identity, name: "Stupid Gifts", origin: "https://stupid.gifts" }).brand), ogPath(release.brand));
  assert.throws(() => createOgRelease(input, { ...identity, origin: "https://www.goose.gifts/other" }), /identity/);
});
test("unsupported or unfit display text uses owned brand fallback rather than remote glyph loading or invented copy", () => {
  const input = structuredClone(fixture);
  input.products[0].title = "未经授权的字形";
  input.products[1].title = "W".repeat(240);
  input.products[2].title = "An actual approved title";
  const release = createOgRelease(input, identity);
  assert.equal(release.cards.some((c) => c.subjectId === input.products[0].publicId), false);
  assert.equal(release.cards.some((c) => c.subjectId === input.products[1].publicId), false);
  assert.equal(release.cards.find((c) => c.subjectId === input.products[2].publicId).title, input.products[2].title);
  assert.equal(ogText("A ‘curated’ idea — really…"), "A 'curated' idea - really...");
  assert.equal(ogText("🐸"), null);
});
test("metadata references finite absolute PNG assets with large-image cards; preview and fixtures stay noindex", () => {
  const card = createOgRelease(fixture, siteIdentity).cards.at(-1);
  const meta = previewMetadata("Approved title", "Approved description", "/gifts/example", { image: card, indexable: true, fixture: true });
  assert.equal(meta.robots.index, false);
  assert.equal(meta.twitter.card, "summary_large_image");
  assert.deepEqual(meta.openGraph.images[0], { url: `${siteIdentity.origin}${ogPath(card)}`, width: 1200, height: 630, alt: card.title });
  assert.equal(previewMetadata("Held", "Unavailable", "/gifts/held").robots.index, false);
});
test("production source mode alone cannot index held/thin/private/fixture metadata", () => {
  for (const mode of ["preview", "goose-production", "stupid-production"]) {
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import {previewMetadata} from './static-site/lib/metadata.ts';
      console.log(JSON.stringify([
        previewMetadata('Held','Unavailable','/gifts/held').robots.index,
        previewMetadata('Unknown fixture status','Unknown','/',{indexable:true}).robots.index,
        previewMetadata('Fixture','Illustrative','/',{indexable:true,fixture:true}).robots.index,
        previewMetadata('Ready','Approved','/gifts/ready',{indexable:true,fixture:false}).robots.index
      ]));`], { cwd: new URL("../", import.meta.url), env: { ...process.env, CATALOG_SITE_MODE: mode, NEXT_PUBLIC_STATIC_SITE_MODE: mode }, encoding: "utf8" }));
    assert.deepEqual(result, [false, false, false, mode !== "preview"]);
  }
});
test("every exported product PNG has its original product deadline and owned brand safe fallback", () => {
  // Reuse the export inventory when available; all other artifact tests also
  // verify full HTML/RSC coverage against the exact built snapshot.
  const out = new URL("../static-site/out/", import.meta.url);
  if (!fs.existsSync(new URL("index.html", out))) return;
  const list = (directory, prefix = "") => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? list(new URL(`${entry.name}/`, directory), `${prefix}/${entry.name}`) : [`${prefix}/${entry.name}`]);
  const source = new URL("../build/stupid-gifts/catalog.snapshot.json", import.meta.url);
  const built = fs.existsSync(source) ? JSON.parse(fs.readFileSync(source)) : process.env.CATALOG_SNAPSHOT_PATH
    ? JSON.parse(fs.readFileSync(process.env.CATALOG_SNAPSHOT_PATH)) : fixture;
  const release = createOgRelease(catalogDisplayView(built), exportIdentity), inventory = list(out);
  const routes = exportedRoutes(built, inventory);
  for (const card of release.cards) {
    const route = routes[ogPath(card)];
    assert.equal(route.eligibleUntil, card.eligibleUntil);
    assert.equal(route.safeAssetPath, ogPath(release.brand));
    assert.equal(route.indexable, false);
    assert.ok(inventory.includes(route.assetPath));
    const bytes = fs.readFileSync(new URL(`.${route.assetPath}`, out));
    assert.equal(bytes.readUInt32BE(16), 1200);
    assert.equal(bytes.readUInt32BE(20), 630);
    if (card.kind === "product" || card.kind === "fixture") {
      const product = built.products.find((p) => p.publicId === card.subjectId);
      const html = fs.readFileSync(new URL(`./gifts/${product.slug}.html`, out), "utf8");
      assert.ok(html.includes(`property="og:image" content="${exportIdentity.origin}${ogPath(card)}"`));
    }
  }
  for (const held of built.heldProducts) {
    const route = routes[held.path];
    assert.equal(route.state, "held");
    assert.equal(route.indexable, false);
    assert.equal(route.assetPath, "/safe/product.html");
    assert.equal(route.safeAssetPath, route.assetPath);
    const html = fs.readFileSync(new URL(`.${route.assetPath}`, out), "utf8");
    assert.match(html, /Not currently in the collection/);
    assert.doesNotMatch(html, /rel="canonical"|property="og:|name="twitter:|"@type":"Product"|data-analytics-outbound/);
    if (held.affiliateUrl) assert.equal(html.includes(held.affiliateUrl), false);
  }
});
test("PNG renderer is local-only, deterministic 1200x630 code-native typography/shapes", async () => {
  const requests = [], original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    requests.push(new URL(String(url)).protocol);
    // Next's bundled WASM uses a local file/data URL, then local fallback.
    throw new Error("No external network permitted");
  };
  try {
    const card = createOgRelease(fixture, identity).brand;
    const first = await renderOgPng(card), second = await renderOgPng(card);
    assert.deepEqual(first, second);
    assert.deepEqual([...first.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const header = new DataView(first.buffer, first.byteOffset);
    assert.equal(header.getUint32(16), 1200);
    assert.equal(header.getUint32(20), 630);
    assert.ok(first.length < 150000);
    assert.equal(requests.some((protocol) => !["file:", "data:"].includes(protocol)), false, requests.join(", "));
    fs.mkdirSync(new URL("../output/og-proof/", import.meta.url), { recursive: true });
    fs.writeFileSync(new URL("../output/og-proof/brand.png", import.meta.url), first);
    const long = { ...card, kind: "product", title: "Carefully selected everyday curiosities with a wonderfully unnecessary purpose, made for the person who already has everything and still appreciates a very unexpected gift." };
    fs.writeFileSync(new URL("../output/og-proof/long-title.png", import.meta.url), await renderOgPng(long));
  } finally { globalThis.fetch = original; }
});
