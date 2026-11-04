import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);

function identity(env = {}) {
  const source = fs.readFileSync(new URL("../static-site/lib/site-identity.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } });
  const commonJs = { exports: {} };
  vm.runInNewContext(outputText, { module: commonJs, exports: commonJs.exports, process: { env } });
  return commonJs.exports;
}
const plain = value => JSON.parse(JSON.stringify(value));
test("default stays protected Stupid preview, even under NODE_ENV=production", () => {
  const config = identity({ NODE_ENV: "production" });
  assert.equal(config.siteSourceMode, "preview"); assert.equal(config.isSitePreview, true); assert.equal(config.isSiteProduction, false);
  assert.deepEqual(plain(config.siteIdentity), { brand: "stupid", name: "Stupid Gifts", origin: "https://stupid-gifts-staging.thirty-seven-inc.workers.dev",
    hostname: "stupid-gifts-staging.thirty-seven-inc.workers.dev", wordmark: "stupid.gifts", tagline: "Very bad ideas. Carefully considered." });
  for (const host of [config.siteIdentity.hostname, "staging.stupid.gifts", "stupid.gifts", "www.goose.gifts"]) assert.equal(config.isSiteAnalyticsHostname(host), false);
  assert.equal(Object.isFrozen(config.siteIdentity), true);
});
test("explicit Goose runtime keeps the existing canonical host; rebrand is separate opt-in", () => {
  const goose = identity({ CATALOG_SITE_MODE: "goose-production" });
  assert.equal(goose.siteIdentity.brand, "goose"); assert.equal(goose.siteIdentity.origin, "https://www.goose.gifts");
  assert.equal(goose.siteIdentity.wordmark, "goose.gifts"); assert.equal(goose.isSiteProduction, true);
  assert.equal(goose.siteIdentity.tagline, "Absurd, useful, and deeply unnecessary.");
  const stupid = identity({ NEXT_PUBLIC_STATIC_SITE_MODE: "stupid-production" });
  assert.equal(stupid.siteIdentity.origin, "https://stupid.gifts"); assert.equal(stupid.siteIdentity.brand, "stupid");
  assert.equal(stupid.isSitePreview, false);
  for (const host of ["www.goose.gifts", "goose.gifts"]) assert.equal(goose.isSiteAnalyticsHostname(host), true);
  for (const host of ["stupid.gifts", "staging.stupid.gifts", "www.goose.gifts.evil.example", "localhost"]) assert.equal(goose.isSiteAnalyticsHostname(host), false);
  assert.equal(stupid.isSiteAnalyticsHostname("stupid.gifts"), true); assert.equal(stupid.isSiteAnalyticsHostname("www.stupid.gifts"), false);
  assert.equal(goose.isSiteInternalHostname("goose.gifts"), true); assert.equal(goose.isSiteInternalHostname("stupid.gifts"), false);
  assert.equal(stupid.isSiteInternalHostname("www.stupid.gifts"), true);
});
test("unknown/empty/arbitrary origins and disagreement are rejected rather than inferred", () => {
  for (const mode of ["", "production", "https://example.com", "goose", "GOOSE-PRODUCTION"]) assert.throws(() => identity({ CATALOG_SITE_MODE: mode }), /source mode/);
  assert.throws(() => identity({ CATALOG_SITE_MODE: "goose-production", NEXT_PUBLIC_STATIC_SITE_MODE: "stupid-production" }), /mismatch/);
  const config = identity();
  assert.throws(() => config.siteIdentityFor("https://example.com"), /source mode/);
  assert.equal(config.siteIdentity.origin, "https://stupid-gifts-staging.thirty-seven-inc.workers.dev");
});
test("serialized identity includes explicit reviewed source mode and has no environment-dependent extras", () => {
  for (const mode of ["preview", "goose-production", "stupid-production"]) {
    const config = identity({ CATALOG_SITE_MODE: mode, NEXT_PUBLIC_STATIC_SITE_MODE: mode });
    assert.deepEqual(plain(config.siteIdentityRecord), { schemaVersion: 1, sourceMode: mode, ...plain(config.siteIdentity) });
    assert.equal(Object.isFrozen(config.siteIdentityRecord), true);
    assert.equal(identity({ CATALOG_SITE_MODE: mode, NODE_ENV: "test" }).siteIdentityRecord.sourceMode, mode);
  }
});

function component(relative, config, fixture = false) {
  const source = fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX,
  } });
  const commonJs = { exports: {} };
  const dependencies = {
    "../lib/site-identity": config,
    "../lib/catalog": { isFixtureRelease: fixture, photos: { indexPath: null, index: { products: {} } } },
    "../components/CatalogPhotos": { CatalogPhotos: ({ children }) => children },
    "../lib/site-editorial": { siteEditorialDisclosures: {} },
    "../../content/homepage.json": { default: { cardTitles: {} } },
    "./CatalogPhotos": { CatalogImage: () => React.createElement("img", { alt: "Controlled fixture" }) },
    "../lib/metadata": { previewMetadata: () => ({}) },
    "../lib/show-data": { show: { latest: null } },
    "../components/StaticAnalytics": { StaticAnalytics: () => React.createElement("i", { "data-test-analytics": true }) },
    "../components/StaticContentExpiry": { StaticContentExpiry: ({ children }) => children },
    "./safe/catalog/page": { default: () => null },
    "../lib/episode-qr": { episodeQrSvg: () => "<svg></svg>" },
    "../lib/analytics": { captureRenderedLists() {} },
    "../lib/episode-display": { unavailableEpisode: value => value },
    "@/components/ProductImage": { ProductImage: () => React.createElement("img", { alt: "Controlled fixture" }) },
    "./styles.css": {},
  };
  vm.runInNewContext(outputText, { module: commonJs, exports: commonJs.exports,
    require(name) { return Object.hasOwn(dependencies, name) ? dependencies[name] : require(name); },
    process: { env: { NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED: "true" } } });
  return commonJs.exports;
}
test("layout and show wordmarks/URLs follow source mode without losing contact or preview safeguards", () => {
  for (const mode of ["preview", "goose-production", "stupid-production"]) {
    const config = identity({ CATALOG_SITE_MODE: mode });
    const layout = component("../static-site/app/layout.tsx", config);
    assert.equal(layout.metadata.icons.icon, "/favicon.ico");
    const html = renderToStaticMarkup(React.createElement(layout.default, null, React.createElement("main", { id: "main" })));
    assert.match(html, new RegExp(`${config.siteIdentity.brand}<span>\\.</span>gifts`));
    assert.doesNotMatch(html, /The collection|weird-gift-index/);
    assert.ok(html.includes("mailto:goosegifts@37.technology"));
    assert.equal(html.includes("Private staging preview"), mode === "preview");
    assert.equal(html.includes("data-test-analytics"), mode !== "preview");
    const fixture = component("../static-site/app/layout.tsx", config, true);
    const fixtureHtml = renderToStaticMarkup(React.createElement(fixture.default));
    assert.match(fixtureHtml, /Private design proof/); assert.doesNotMatch(fixtureHtml, /data-test-analytics/);

    const episode = { status: "published", key: "controlled-fixture", episodeDate: "2026-10-20",
      shareUrl: `${config.siteIdentity.origin}/howie/controlled-fixture?utm_source=howie_mandel_does_stuff`, eligibleUntil: null,
      slots: [{ primary: { id: "test", title: "Controlled fixture", slug: "controlled-product" }, alternatives: [], position: 1, exactVariant: "Controlled fixture" }] };
    const share = component("../static-site/components/EpisodeShare.tsx", config);
    const shareHtml = renderToStaticMarkup(React.createElement(share.EpisodeShare, { episode }));
    assert.ok(shareHtml.includes(`${config.siteIdentity.hostname}/howie/controlled-fixture`));
    const presentation = component("../static-site/components/Presentation.tsx", config);
    const slides = renderToStaticMarkup(React.createElement(presentation.Presentation, { episode, qrSvg: "<svg></svg>" }));
    assert.ok(slides.includes(`${config.siteIdentity.hostname}/gifts/controlled-product`));
    assert.ok(slides.includes(`${config.siteIdentity.hostname}/howie/controlled-fixture`));
  }
});
test("shared footer links to the owned Pinterest profile safely without changing adjacent links", () => {
  for (const mode of ["preview", "goose-production", "stupid-production"]) {
    for (const fixture of [false, true]) {
      const layout = component("../static-site/app/layout.tsx", identity({ CATALOG_SITE_MODE: mode }), fixture);
      const html = renderToStaticMarkup(React.createElement(layout.default));
      const footer = html.match(/<footer>([\s\S]*?)<\/footer>/)[1];
      const bottom = footer.match(/<div class="footer-bottom">([\s\S]*?)<\/div>/)[1];
      assert.match(bottom, /<a href="https:\/\/www\.pinterest\.com\/stupid_gifts\/" target="_blank" rel="noopener noreferrer">Pinterest<span class="sr-only"> \(opens in a new tab\)<\/span><\/a>/);
      assert.deepEqual([...bottom.matchAll(/href="([^"]+)"/g)].map(match => match[1]), [
        "/gift-guides", "/random-gift", "https://www.pinterest.com/stupid_gifts/",
        "mailto:goosegifts@37.technology", "/privacy",
      ]);
      assert.match(footer, /We may earn a commission\. As an Amazon Associate we earn from qualifying purchases\./);
      assert.match(bottom, /© Thirty Seven Inc\./);
    }
  }
});
test("actual show and QR generation use only selected compile-time origin across all source modes", () => {
  const script = `
    import { episodeShareUrl } from './static-site/lib/show.ts';
    import { episodeQrSvg } from './static-site/lib/episode-qr.ts';
    import { siteIdentity } from './static-site/lib/site-identity.ts';
    const episode={status:'published',key:'controlled-fixture',episodeDate:'2026-10-20'};
    const shareUrl=episodeShareUrl(episode);
    const svg=episodeQrSvg({...episode,shareUrl});
    let rejected=false;
    try { episodeQrSvg({...episode,shareUrl:shareUrl.replace(siteIdentity.origin,'https://unexpected.invalid')}); } catch { rejected=true; }
    console.log(JSON.stringify({shareUrl,svg:svg.startsWith('<svg'),rejected}));
  `;
  for (const mode of ["preview", "goose-production", "stupid-production"]) {
    const config = identity({ CATALOG_SITE_MODE: mode });
    const result = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL("../", import.meta.url), encoding: "utf8",
      env: { ...process.env, CATALOG_SITE_MODE: mode, NEXT_PUBLIC_STATIC_SITE_MODE: mode },
    }));
    const url = new URL(result.shareUrl);
    assert.equal(url.origin, config.siteIdentity.origin); assert.equal(url.pathname, "/howie/controlled-fixture");
    assert.deepEqual([...url.searchParams.keys()], ["utm_source", "utm_medium", "utm_campaign"]);
    assert.equal(result.svg, true); assert.equal(result.rejected, true);
  }
});
