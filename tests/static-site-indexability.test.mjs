import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { privacyPolicySections, privacyPolicyIntro, privacyPolicyUpdated } from "../lib/privacy-policy.ts";

const owned = JSON.parse(fs.readFileSync(new URL("../static-site/fixtures/catalog.snapshot.json", import.meta.url)));
function controlledSnapshot(dataKind, empty = false) {
  // Structural policy tests only: never published, clicked or presented as real.
  return { ...owned, dataKind, catalogRevision: "controlled-metadata-not-for-publication", slugHistory: [],
    products: empty ? [] : Array.from({ length: 26 }, (_, i) => ({ ...owned.products[0],
      id: `B0${String(i).padStart(8, "0")}`, publicId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      title: i === 0 ? "Controlled Cat Bookmark - not an actual product" : `Controlled policy object ${i} - not for sale`,
      slug: `controlled-policy-object-${i}`, affiliateUrl: dataKind === "synthetic_fixture"
        ? "https://example.invalid/not-for-sale" : `https://www.amazon.com/dp/B0${String(i).padStart(8, "0")}` })),
    heldProducts: [{ ...owned.heldProducts[0], id: "B099999999", publicId: "99999999-0000-4000-8000-000000000000",
      slug: "controlled-held", path: "/gifts/controlled-held" }],
  };
}
const script = `
  import React from 'react';
  globalThis.React = React;
  import {renderToStaticMarkup} from 'react-dom/server';
  import {show} from './static-site/lib/show-data.ts';
  if(process.env.CONTROLLED_PUBLISHED === 'true') {
    const episode={key:'controlled-archive',title:'Controlled metadata fixture - not aired',status:'published',eligibleUntil:null};
    show.episodes.push(episode); show.latest=episode;
  }
  const pages={
    home:await import('./static-site/app/page.tsx'),
    hub:await import('./static-site/app/gift-guides/page.tsx'), random:await import('./static-site/app/random-gift/page.tsx'),
    howie:await import('./static-site/app/howie/page.tsx'),
    privacy:await import('./static-site/app/privacy/page.tsx'), presentation:await import('./static-site/app/preview/presentation/page.tsx')
  };
  const flags=Object.fromEntries(Object.entries(pages).map(([key,value])=>[key,value.metadata.robots.index]));
  const product=await import('./static-site/app/gifts/[slug]/page.product.tsx');
  const safeProduct=await import('./static-site/app/safe/product/page.tsx');
  const guide=await import('./static-site/app/gift-guides/[slug]/page.tsx');
  const episode=await import('./static-site/app/howie/[episode]/page.episode.tsx');
  const presentation=await import('./static-site/app/howie/[episode]/presentation/page.episode.tsx');
  const get=async(module,params)=>(await module.generateMetadata({params:Promise.resolve(params)})).robots.index;
  const productParams=product.generateStaticParams();
  flags.ready=productParams.length ? await get(product,productParams[0]) : false;
  flags.held=safeProduct.metadata.robots.index;
  const notFound=async(action)=>{
    try {await action(); return false;}
    catch(error) {if(error?.digest==='NEXT_HTTP_ERROR_FALLBACK;404') return true; throw error;}
  };
  const rejectedProducts={};
  for(const slug of ['controlled-held','unknown-product','controlled-policy-object-0'].filter(slug=>!productParams.some(p=>p.slug===slug))) {
    const params=()=>({params:Promise.resolve({slug})});
    rejectedProducts[slug]={metadata:await notFound(()=>product.generateMetadata(params())),
      renderer:await notFound(()=>product.default(params()))};
  }
  flags.matchingGuide=await get(guide,{slug:'cat-lover-gag-gifts'});
  flags.thinGuide=await get(guide,{slug:'office-prank-gifts'});
  flags.episode=await get(episode,{episode:'controlled-archive'});
  flags.episodePresentation=await get(presentation,{episode:'controlled-archive'});
  const {default:robots}=await import('./static-site/app/robots.ts');
  const {siteIdentity}=await import('./static-site/lib/site-identity.ts');
  const {guides,guideSchema}=await import('./static-site/lib/guides.ts');
  console.log(JSON.stringify({flags,productParams,rejectedProducts,safeProductMetadata:safeProduct.metadata,
    robots:robots(),origin:siteIdentity.origin,
    guideWebsite:guideSchema(guides[0],[])['@graph'][0].isPartOf,
    descriptions:[pages.home.metadata.description,pages.random.metadata.description,pages.hub.metadata.description],
    emptyGuide:renderToStaticMarkup(await guide.default({params:Promise.resolve({slug:'office-prank-gifts'})})),
    privacy:renderToStaticMarkup(React.createElement(pages.privacy.default))}));
`;
function inspect(mode, input, published = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "goose-gifts-metadata-"));
  try {
    const file = path.join(directory, "snapshot.json"); fs.writeFileSync(file, JSON.stringify(input));
    const output = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: new URL("../", import.meta.url), encoding: "utf8", env: { ...process.env, CATALOG_SNAPSHOT_PATH: file,
        CATALOG_SITE_MODE: mode, NEXT_PUBLIC_STATIC_SITE_MODE: mode, NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED: "false",
        CONTROLLED_PUBLISHED: String(published) },
    }));
    assert.deepEqual(output.productParams, input.products.map(({ slug }) => ({ slug })));
    for (const [slug, rejected] of Object.entries(output.rejectedProducts))
      assert.deepEqual(rejected, { metadata: true, renderer: true }, `${mode}/${slug} must 404 outside the shared held route`);
    assert.equal(output.safeProductMetadata.robots.index, false);
    assert.equal(output.safeProductMetadata.alternates.canonical, null);
    assert.equal(output.safeProductMetadata.openGraph, null);
    assert.equal(output.safeProductMetadata.twitter, null);
    return output;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
test("eligible maintained routes index only in explicit production; held/thin/duplicate/private routes do not", () => {
  for (const mode of ["preview", "goose-production", "stupid-production"]) {
    const output = inspect(mode, controlledSnapshot("catalog"));
    const publicMode = mode !== "preview";
    const name = mode === "goose-production" ? "Goose Gifts" : "Stupid Gifts";
    assert.equal(output.guideWebsite.name, name);
    assert.equal(output.guideWebsite.url, output.origin);
    for (const key of ["home", "hub", "random", "privacy", "ready", "matchingGuide"])
      assert.equal(output.flags[key], publicMode, `${mode}/${key}`);
    for (const key of ["held", "thinGuide", "howie", "presentation", "episode", "episodePresentation"])
      assert.equal(output.flags[key], false, `${mode}/${key}`);
    assert.equal(output.robots.rules.allow === "/", publicMode);
    if (publicMode) {
      assert.equal(output.robots.sitemap, `${output.origin}/sitemap.xml`);
      assert.match(output.privacy, /Privacy Policy|Last updated August 21, 2026/);
      assert.ok(output.privacy.includes(mode === "goose-production" ? "goose.gifts" : "stupid.gifts"));
      assert.match(output.privacy, /We may use analytics tools/);
      assert.doesNotMatch(output.privacy, /Preview privacy|does not initialize production analytics/);
      assert.doesNotMatch(output.descriptions.join(" "), /staging|not a public launch|runtime database/i);
    } else {
      assert.equal(output.robots.rules.disallow, "/");
      assert.match(output.privacy, /Preview privacy/);
    }
    assert.match(output.emptyGuide, /Browse all gifts/);
    assert.doesNotMatch(output.emptyGuide, /Browse the staging collection/);
  }
});
test("production-mode fixtures remain entirely noindex/blocked; zero-ready catalog routes stay unavailable", () => {
  const fixture = inspect("goose-production", controlledSnapshot("synthetic_fixture"));
  assert.ok(Object.values(fixture.flags).every((value) => value === false));
  assert.equal(fixture.robots.rules.disallow, "/");
  assert.match(fixture.privacy, /Preview privacy/);
  const empty = inspect("stupid-production", controlledSnapshot("catalog", true));
  for (const key of ["home", "random", "ready", "matchingGuide"])
    assert.equal(empty.flags[key], false, key);
  assert.equal(empty.flags.privacy, true); assert.equal(empty.flags.hub, true);
});
test("only controlled published archives, never drafts or presentation views, gain public metadata", () => {
  const published = inspect("goose-production", controlledSnapshot("catalog"), true);
  assert.equal(published.flags.howie, true); assert.equal(published.flags.episode, true);
  assert.equal(published.flags.episodePresentation, false); assert.equal(published.flags.presentation, false);
  const fixture = inspect("stupid-production", controlledSnapshot("synthetic_fixture"), true);
  assert.equal(fixture.flags.howie, false); assert.equal(fixture.flags.episode, false);
});
test("shared policy discloses functional search separately from analytics; favicon reuses the owned signature", () => {
  const search=privacyPolicySections.find(section=>section.title==='Gift Search');
  assert.match(search.body.join(' '), /search text to OpenAI/);
  assert.match(search.body.join(' '), /Cloudflare Vectorize/);
  assert.match(search.body.join(' '), /separate from analytics/);
  assert.match(search.body.join(' '), /keyword search instead/);
  assert.equal(privacyPolicyUpdated, "November 5, 2026");
  assert.doesNotMatch(search.body.join(' '), /daily limit/);
  const analytics = privacyPolicySections.find(section => section.title === 'Analytics').body.join(' ');
  assert.match(analytics, /random identifier for each search, not a visitor identifier/);
  assert.match(analytics, /not sent to Google Analytics or PostHog/);
  assert.equal(privacyPolicyIntro, "This policy explains how goose.gifts handles information for visitors using the site.");
  assert.deepEqual(fs.readFileSync(new URL("../static-site/public/favicon.ico", import.meta.url)), fs.readFileSync(new URL("../public/favicon.ico", import.meta.url)));
});
test("rendered export advertises the owned favicon, never the placeholder Stupid letter icon", {
  skip: !fs.existsSync(new URL("../static-site/out/index.html", import.meta.url)),
}, () => {
  const html = fs.readFileSync(new URL("../static-site/out/index.html", import.meta.url), "utf8");
  assert.match(html, /<link[^>]*rel="icon"[^>]*href="\/favicon\.ico"/);
  assert.doesNotMatch(html, /href="\/favicon\.svg"/);
  assert.deepEqual(fs.readFileSync(new URL("../static-site/out/favicon.ico", import.meta.url)), fs.readFileSync(new URL("../public/favicon.ico", import.meta.url)));
});
