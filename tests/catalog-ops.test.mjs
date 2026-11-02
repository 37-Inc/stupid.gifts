import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import amazonCreators from '../lib/amazon-creators.js';
import {
  hydrateLocalAmazonCreatorsEnv,
  parseCsvRows,
} from '../scripts/ops/amazon-creators-env.mjs';
import { formatReport, parseFinalJson } from '../scripts/ops/catalog-weekly.mjs';
import {
  auditGuideProducts,
  extractGuideProducts,
  extractGuideUrls,
} from '../scripts/ops/audit-gift-guides.mjs';

import {
  areNearDuplicateTitles,
  amazonAffiliateUrl,
  deduplicateAgainstCatalog,
  deduplicateCandidates,
  discoveryCandidateBlockReason,
  isHighQualityDiscoveryCandidate,
  parseArgs,
  requestEditorialWithRetries,
  revalidatedProduct,
  retryableDraft,
  retryableReview,
  selectRotatingThemes,
  titleSimilarity,
} from '../scripts/ops/prefetch-catalog.mjs';
import {
  editorialSimilarity,
  editorialSourceHash,
  editorialReasonsRequireManualReview,
  resolveEditorialAttempt,
  selectDuplicateWinner,
  validateEditorialDraft,
} from '../scripts/ops/catalog-editorial-core.mjs';

test('daily theme selection rotates deterministically across the full pool', () => {
  const themes = Array.from({ length: 12 }, (_, index) => `theme-${index}`);
  const first = selectRotatingThemes(themes, 6, new Date('2026-07-14T01:00:00Z'));
  const sameDay = selectRotatingThemes(themes, 6, new Date('2026-07-14T23:00:00Z'));
  const nextDay = selectRotatingThemes(themes, 6, new Date('2026-07-15T12:00:00Z'));

  assert.deepEqual(first, sameDay);
  assert.equal(new Set([...first, ...nextDay]).size, 12);
});

test('explicit run themes are reproducible on retry and vary between same-day batches', () => {
  const pool = Array.from({ length: 24 }, (_, i) => `theme-${i}`);
  const first = selectRotatingThemes(pool, 6, new Date('2026-11-02'), 'run-one');
  assert.equal(first.length, 6);
  assert.equal(new Set(first).size, 6);
  assert.deepEqual(first, selectRotatingThemes(pool, 6, new Date('2026-11-03'), 'run-one'));
  assert.notDeepEqual(first, selectRotatingThemes(pool, 6, new Date('2026-11-02'), 'run-two'));
  assert.ok(first.every(theme => pool.includes(theme)));
});

test('Creators API item mapping reads lowerCamelCase offersV2 data', () => {
  const product = amazonCreators.mapItem({
    asin: 'B012345678',
    detailPageURL: 'https://www.amazon.com/dp/B012345678?tag=example-20',
    images: { primary: { large: { url: 'https://images.example/product.jpg' } } },
    itemInfo: { title: { displayValue: 'Ridiculous Desk Chicken' } },
    offersV2: { listings: [{ price: { money: { amount: 19.95, currency: 'USD' } } }] },
    customerReviews: { starRating: { value: 4.6 }, count: 123 },
  });

  assert.deepEqual(product, {
    id: 'B012345678',
    title: 'Ridiculous Desk Chicken',
    price: 19.95,
    currency: 'USD',
    imageUrl: 'https://images.example/product.jpg',
    affiliateUrl: 'https://www.amazon.com/dp/B012345678?tag=example-20',
    source: 'amazon',
    remotelyVerified: true,
    availabilityStatus: 'UNKNOWN',
    availabilityMessage: '',
    sourceFacts: {},
    rating: 4.6,
    reviewCount: 123,
  });
});

test('Creators API mapping retains factual listing context and explicit availability', () => {
  const product = amazonCreators.mapItem({
    asin: 'B012345678',
    parentASIN: 'B087654321',
    detailPageURL: 'https://www.amazon.com/dp/B012345678?tag=example-20&linkCode=ogi',
    images: { primary: { large: { url: 'https://images.example/product.jpg' } } },
    itemInfo: {
      title: { displayValue: 'Shark-shaped ceramic coffee mug' },
      byLineInfo: {
        brand: { displayValue: 'Glazery' },
        manufacturer: { displayValue: 'Mug Works' },
      },
      classifications: { productGroup: { displayValue: 'Kitchen' } },
      features: { displayValues: ['Raised shark figure', '13.5 ounce capacity'] },
      productInfo: {
        color: { displayValue: 'Gray' },
        itemDimensions: { height: { displayValue: 4.5, unit: 'inches' } },
      },
    },
    offersV2: {
      listings: [{
        availability: { type: 'IN_STOCK', message: 'In Stock' },
        condition: { displayValue: 'New' },
        price: { money: { amount: 18.95, currency: 'USD' } },
      }],
    },
  });

  assert.equal(product.availabilityStatus, 'IN_STOCK');
  assert.equal(product.affiliateUrl, 'https://www.amazon.com/dp/B012345678?tag=example-20&linkCode=ogi');
  assert.deepEqual(product.sourceFacts, {
    brand: 'Glazery',
    manufacturer: 'Mug Works',
    productGroup: 'Kitchen',
    features: ['Raised shark figure', '13.5 ounce capacity'],
    color: 'Gray',
    itemDimensions: { height: '4.5 inches' },
    parentAsin: 'B087654321',
    offerCondition: 'New',
  });
});

test('local Creators credential CSV parsing handles quoted commas without exposing values', () => {
  const rows = parseCsvRows(
    'Application,Application Id,Credential Id,Secret,Version\n'
    + '"Goose, Gifts",app-id,credential-id,"secret,with,commas",3.1\n'
  );

  assert.deepEqual(rows, [
    ['Application', 'Application Id', 'Credential Id', 'Secret', 'Version'],
    ['Goose, Gifts', 'app-id', 'credential-id', 'secret,with,commas', '3.1'],
  ]);
});

test('local Creators credentials replace unreadable Vercel placeholders', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'goose-creators-env-'));
  const credentialFile = path.join(directory, 'credentials.csv');
  fs.writeFileSync(
    credentialFile,
    'Credential Id,Secret,Version\nlocal-id,local-secret,3.1\n',
  );
  const env = {
    AMAZON_CREATORS_CREDENTIALS_FILE: credentialFile,
    AMAZON_CREATORS_CREDENTIAL_ID: '[Encrypted]',
    AMAZON_CREATORS_CREDENTIAL_SECRET: '[Sensitive]',
    AMAZON_CREATORS_CREDENTIAL_VERSION: '[Encrypted]',
  };

  try {
    assert.equal(hydrateLocalAmazonCreatorsEnv(env), true);
    assert.equal(env.AMAZON_CREATORS_CREDENTIAL_ID, 'local-id');
    assert.equal(env.AMAZON_CREATORS_CREDENTIAL_SECRET, 'local-secret');
    assert.equal(env.AMAZON_CREATORS_CREDENTIAL_VERSION, '3.1');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('weekly catalog reporting parses command output and includes owner-facing stats', () => {
  assert.deepEqual(parseFinalJson('progress\n{\n  "inserted": 2\n}\n'), { inserted: 2 });
  const report = formatReport({
    discoveredCandidates: 60,
    qualityRejected: 24,
    duplicatesFiltered: 14,
    candidates: 22,
    inserted: 2,
    updated: 20,
    backfilled: 3,
    backfill: {
      selected: 8,
      ready: 5,
      needsReview: 1,
      blocked: 1,
      duplicates: 1,
      markedUnavailable: 0,
    },
    themes: ['weird kitchen gadgets'],
    reviewCandidates: Array.from({ length: 7 }, (_, index) => ({
      title: `Candidate ${index + 1}`,
      imageUrl: `https://images.example/${index + 1}.jpg`,
      affiliateUrl: `https://shop.example/${index + 1}`,
    })),
    manualIntervention: 1,
    telemetry: { runId: '11111111-1111-1111-1111-111111111111' },
  }, {
    selected: 50,
    refreshed: 49,
    confirmedMissing: 1,
    deactivated: 0,
    throttled: false,
  }, { id: '11111111-1111-1111-1111-111111111111', estimatedCostUsd: 0.012345 });

  assert.match(report, /60 fetched, 24 quality-rejected, 14 duplicates filtered/);
  assert.match(report, /2 inserted, 20 refreshed, 3 older products processed/);
  assert.match(report, /Editorial: 8 selected, 5 ready, 0 pending retry, 1 needs review, 1 blocked, 1 duplicate, 0 unavailable/);
  assert.match(report, /50 checked, 49 refreshed, 1 confirmed missing/);
  assert.match(report, /Visual spot-check \(5\):/);
  assert.match(report, /Run: 11111111-1111-1111-1111-111111111111/);
  assert.match(report, /estimated API cost: \$0\.012345/);
  assert.match(report, /Owner intervention: 1 item/);
  assert.match(report, /Candidate 5/);
  assert.doesNotMatch(report, /Candidate 6/);

  const dryRunReport = formatReport({
    dryRun: true,
    discoveredCandidates: 10,
    qualityRejected: 3,
    duplicatesFiltered: 2,
    candidates: [{ id: 'one' }, { id: 'two' }],
    themes: ['novelty desk toys'],
  }, {
    selected: 0,
    refreshed: 0,
    confirmedMissing: 0,
    deactivated: 0,
    throttled: false,
  });
  assert.match(dryRunReport, /2 retained/);
  assert.match(dryRunReport, /dry run; no products changed/);
});

test('gift guide audit reads rendered products and identifies thin distinct inventory', () => {
  const rendered = [
    {
      id: 'good',
      title: 'Red Crab Silicone Spoon Rest',
      punnyTitle: 'Crab-tivating Counter Help',
      qualityScore: 0.8,
      isActive: true,
      imageUrl: 'https://example.com/crab.jpg',
      affiliateUrl: 'https://example.com/crab',
    },
    {
      id: 'weak',
      title: 'Luxury Ramen Bowl Set',
      punnyTitle: 'Ramen Ready',
      qualityScore: 0.5,
      isActive: true,
      imageUrl: 'https://example.com/bowl.jpg',
      affiliateUrl: 'https://example.com/bowl',
    },
  ].map((product) => JSON.stringify(product).replaceAll('"', '\\"')).join(',');
  const html = `<script>self.__next_f.push([1,"${rendered}"])</script>`;
  const products = extractGuideProducts(html);

  assert.equal(products.length, 2);
  assert.deepEqual(auditGuideProducts(products, 2), {
    raw: 2,
    eligible: 1,
    distinct: 1,
    rejected: 1,
    duplicates: 0,
    underfilled: true,
  });
});

test('gift guide audit discovers only canonical guide detail URLs from the sitemap', () => {
  const sitemap = [
    '<urlset>',
    '<url><loc>https://www.goose.gifts/</loc></url>',
    '<url><loc>https://www.goose.gifts/gift-guides/weird-kitchen-gadgets</loc></url>',
    '<url><loc>https://www.goose.gifts/gift-guides/weird-kitchen-gadgets</loc></url>',
    '<url><loc>https://www.goose.gifts/gift-guides</loc></url>',
    '<url><loc>https://example.com/gift-guides/not-ours</loc></url>',
    '</urlset>',
  ].join('');

  assert.deepEqual(extractGuideUrls(sitemap), [
    'https://www.goose.gifts/gift-guides/weird-kitchen-gadgets',
  ]);
});

test('near-identical discovery titles are filtered while distinct products remain', () => {
  const products = [
    { id: 'B000000001', title: 'Dad Bag Belly Fanny Pack Funny Beer Belly Waist Pack' },
    { id: 'B000000002', title: 'Funny Dad Bag Belly Fanny Pack Beer Belly Waist Pack Gift' },
    { id: 'B000000003', title: 'Desktop Mini Wacky Waving Inflatable Tube Guy' },
  ];

  assert.ok(titleSimilarity(products[0].title, products[1].title) >= 0.82);
  const result = deduplicateCandidates(products);
  assert.deepEqual(result.products.map((product) => product.id), ['B000000001', 'B000000003']);
  assert.equal(result.duplicates, 1);
});

test('product-family deduplication catches marketplace variants with different SEO titles', () => {
  assert.equal(areNearDuplicateTitles(
    'Funny Shart Survival Kit with Wipes and Disposable Underwear',
    'Funny Survival Set Includes Disposable Underwear, Potty Humor and Wet Wipe'
  ), true);
  assert.equal(areNearDuplicateTitles(
    'Golf Pen Set with Mini Desktop Putting Green Game',
    'Tabletop Wooden Mini Bowling Alley Desk Toy'
  ), false);
  assert.equal(areNearDuplicateTitles(
    'Golf Pen Set with Mini Desktop Putting Green Game',
    'Desktop Golf Pen Putting Game for Coworkers'
  ), true);
});

test('discovery quality gate keeps distinctive gag objects and rejects generic merchandise', () => {
  const base = {
    price: 15,
    imageUrl: 'https://example.com/image.jpg',
    affiliateUrl: 'https://example.com/product',
    isActive: true,
    qualityScore: 0.75,
  };

  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'The Original Nessie Loch Ness Monster Soup Ladle',
  }), true);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Funny Sandalwood Scented Candle for Dad',
  }), false);
  assert.equal(discoveryCandidateBlockReason({
    ...base,
    title: 'Funny Sandalwood Scented Candle for Dad',
  }), 'generic_format');
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Sarcastic Candles for Coworkers',
  }), false);
  assert.equal(discoveryCandidateBlockReason({
    ...base,
    title: 'Vivulla68 And Here We Fucking Go Again I Mean Good Morning Funny Coffee Mug',
  }), 'generic_format');
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Weird Shark-Shaped Ceramic Coffee Mug',
  }), true);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Funny Shark Coffee Mug for Dad',
  }), false);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Funny Hidden Message Coffee Mug with Middle Finger',
  }), true);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Weird Color-Change Coffee Mug',
  }), true);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Funny Cocktail Socks and Party Stockings',
  }), false);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: "I'm Gay Rainbow Heat Change Mug Prank Gift",
  }), false);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'Fullstar Pro Original Vegetable Chopper and Spiralizer',
  }), false);
  assert.equal(isHighQualityDiscoveryCandidate({
    ...base,
    title: 'The Screaming Goat Book and Figure',
  }), true);
});

test('discovery quality gate exposes a stable reason for every rejection branch', () => {
  const base = {
    title: 'The Screaming Goat Book and Figure',
    price: 15,
    imageUrl: 'https://example.com/image.jpg',
    affiliateUrl: 'https://example.com/product',
    isActive: true,
    qualityScore: 0.75,
  };
  assert.equal(discoveryCandidateBlockReason({ ...base, imageUrl: null }), 'missing_image');
  assert.equal(discoveryCandidateBlockReason({ ...base, affiliateUrl: null }), 'missing_destination');
  assert.equal(discoveryCandidateBlockReason({ ...base, isActive: false, availabilityStatus: 'OUT_OF_STOCK' }), 'unavailable');
  assert.equal(discoveryCandidateBlockReason({ ...base, isActive: false, availabilityStatus: 'UNKNOWN' }), 'inactive_candidate');
  assert.equal(discoveryCandidateBlockReason({ ...base, qualityScore: 0.4 }), 'low_quality_score');
  assert.equal(discoveryCandidateBlockReason({ ...base, title: "I'm Gay Rainbow Heat Change Mug Prank Gift" }), 'taste_exclusion');
  assert.equal(discoveryCandidateBlockReason({ ...base, title: 'Funny Sandalwood Scented Candle for Dad' }), 'generic_format');
  assert.equal(discoveryCandidateBlockReason({ ...base, title: 'Acme Household Object' }), 'off_brand');
});

test('a different ASIN duplicating the active catalog is filtered without blocking an update', () => {
  const catalog = [{ id: 'B000000001', title: 'Dad Bag Belly Fanny Pack Funny Beer Belly Waist Pack' }];
  const discoveries = [
    { id: 'B000000001', title: 'Dad Bag Belly Fanny Pack Funny Beer Belly Waist Pack' },
    { id: 'B000000002', title: 'Funny Dad Bag Belly Fanny Pack Beer Belly Waist Pack Gift' },
  ];
  const result = deduplicateAgainstCatalog(discoveries, catalog);

  assert.deepEqual(result.products.map((product) => product.id), ['B000000001']);
  assert.equal(result.duplicates, 1);
});

test('Amazon affiliate URLs are canonical and encode the associate tag', () => {
  assert.equal(
    amazonAffiliateUrl('B012345678', 'riley+test-20'),
    'https://www.amazon.com/dp/B012345678?tag=riley%2Btest-20'
  );
});

test('revalidation arguments stay bounded and support audit-only behavior', () => {
  const options = parseArgs([
    '--revalidate',
    '--revalidate-limit', '25',
    '--stale-days', '14',
    '--deactivate-after-days', '120',
    '--no-deactivate',
  ]);

  assert.equal(options.revalidate, true);
  assert.equal(options.revalidateLimit, 25);
  assert.equal(options.staleDays, 14);
  assert.equal(options.deactivateAfterDays, 120);
  assert.equal(options.deactivateMissing, false);

  const clamped = parseArgs(['--revalidate-limit', '500', '--deactivate-after-days', '2']);
  assert.equal(clamped.revalidateLimit, 100);
  assert.equal(clamped.deactivateAfterDays, 60);
  assert.equal(parseArgs(['--enrichment-batch-size', '100']).enrichmentBatchSize, 4);
});

test('affiliate URL repair can run without product revalidation', () => {
  const options = parseArgs(['--repair-affiliate-urls-only', '--dry-run']);

  assert.equal(options.repairAffiliateUrlsOnly, true);
  assert.equal(options.dryRun, true);
  assert.equal(options.revalidate, false);
});

test('revalidation preserves a known price but does not claim availability when Amazon omits offer data', () => {
  const result = revalidatedProduct({
    id: 'B012345678',
    title: 'Funny Existing Product',
    price: '29.99',
    currency: 'CAD',
    image_url: 'https://example.com/existing.jpg',
    source_query: 'funny gifts',
    humor_tags: ['funny'],
    punny_title: 'Existing pun',
    witty_description: 'Existing description',
    quality_score: '0.75',
    rating: '4.5',
    review_count: 100,
    embedding: null,
  }, {
    id: 'B012345678',
    title: 'Funny Existing Product',
    price: 0,
    currency: 'USD',
    imageUrl: 'https://example.com/current.jpg',
    affiliateUrl: 'https://www.amazon.com/dp/B012345678?tag=test-20',
    source: 'amazon',
  }, {
    minPrice: 5,
    maxPrice: 150,
  });

  assert.equal(result.price, 29.99);
  assert.equal(result.currency, 'CAD');
  assert.equal(result.isActive, false);
  assert.equal(result.availabilityStatus, 'UNKNOWN');
  assert.equal(result.imageUrl, 'https://example.com/current.jpg');
});

test('editorial validation accepts specific factual copy and rejects generic duplicated copy', () => {
  const product = {
    id: 'B012345678',
    title: 'Gray shark-shaped ceramic coffee mug with raised fin handle',
    imageUrl: 'https://images.example/shark.jpg',
    sourceFacts: {
      brand: 'Glazery',
      color: 'Gray',
      features: ['Raised shark figure', '13.5 ounce capacity', 'Ceramic construction'],
    },
  };
  const paragraph = 'This gray ceramic mug turns the body of a shark into the cup itself, with a raised shark figure and fin-like details that make the object readable before anyone takes a sip. The listing identifies a 13.5 ounce capacity, so it is a real coffee mug rather than a decorative miniature. Glazery keeps the palette gray and white, which lets the sculpted shape do most of the joke work without relying on printed slogans.';
  const second = 'It makes sense for a shark enthusiast, an ocean-obsessed coworker, or a white elephant exchange where useful objects tend to survive the trading. The ceramic construction gives the recipient an everyday cup after the reveal, while the dimensional figure supplies the strange shelf presence. Anyone ordering it should still check the retailer listing for current care guidance and package details, because those can change independently of the object described here.';
  const editorial = `${paragraph}\n\n${second}`;

  assert.equal(validateEditorialDraft(product, editorial).approved, true);
  assert.ok(editorialSourceHash(product).match(/^[a-f0-9]{64}$/));
  assert.ok(editorialSimilarity(editorial, editorial) > 0.99);
  assert.equal(validateEditorialDraft(product, editorial, [editorial]).approved, false);
  assert.equal(validateEditorialDraft(product, 'This unique product is the perfect gift.').approved, false);
});

test('editorial resolution keeps a valid draft when an optional reviewer correction is truncated', () => {
  const product = {
    id: 'B012345678',
    title: 'Gray shark-shaped ceramic coffee mug with raised fin handle',
    imageUrl: 'https://images.example/shark.jpg',
    sourceFacts: {
      brand: 'Glazery',
      color: 'Gray',
      features: ['Raised shark figure', '13.5 ounce capacity', 'Ceramic construction'],
    },
    editorialStatus: 'pending',
  };
  const draft = 'This gray ceramic mug turns the body of a shark into the cup itself, with a raised shark figure and fin-like details that make the object readable before anyone takes a sip. The listing identifies a 13.5 ounce capacity, so it is a real coffee mug rather than a decorative miniature. Glazery keeps the palette gray and white, which lets the sculpted shape do most of the joke work without relying on printed slogans.\n\nIt makes sense for a shark enthusiast, an ocean-obsessed coworker, or a white elephant exchange where useful objects tend to survive the trading. The ceramic construction gives the recipient an everyday cup after the reveal, while the dimensional figure supplies the strange shelf presence. Anyone ordering it should still check the retailer listing for current care guidance and package details, because those can change independently of the object described here.';
  const outcome = resolveEditorialAttempt(product, {
    draftWriteup: draft,
    review: { approved: true, qualityScore: 0.91, correctedEditorial: 'Too short.', reasons: [] },
    reviewQuality: 0.91,
    model: 'gpt-4o-mini',
  });

  assert.equal(outcome.editorialStatus, 'generated_ready');
  assert.equal(outcome.editorialWriteup, draft);
  assert.equal(outcome.requiresManualReview, false);
});

test('incomplete retries never overwrite approved copy and stale it only when source facts changed', () => {
  const product = {
    id: 'B012345678',
    title: 'Gray shark-shaped ceramic coffee mug with raised fin handle',
    imageUrl: 'https://images.example/shark.jpg',
    sourceFacts: { brand: 'Glazery', features: ['Raised shark figure', '13.5 ounce capacity'] },
    editorialStatus: 'generated_ready',
    editorialWriteup: 'Previously approved substantive copy stays intact.',
    editorialQualityScore: 0.92,
    editorialModel: 'reviewed-model',
    editorialPromptVersion: 'reviewed-v1',
    editorialGeneratedAt: new Date('2026-08-08T12:00:00Z'),
  };
  product.editorialSourceHash = editorialSourceHash(product);

  const unchanged = resolveEditorialAttempt(product, {
    draftWriteup: 'Truncated attempt.',
    pipelineReasons: ['draft_generation_incomplete'],
  });
  assert.equal(unchanged.editorialStatus, 'generated_ready');
  assert.equal(unchanged.editorialWriteup, product.editorialWriteup);
  assert.equal(unchanged.preservation, 'approved_source_unchanged');

  const changedProduct = {
    ...product,
    sourceFacts: { ...product.sourceFacts, color: 'Gray' },
  };
  const changed = resolveEditorialAttempt(changedProduct, {
    draftWriteup: 'Truncated attempt.',
    pipelineReasons: ['draft_generation_incomplete'],
  });
  assert.equal(changed.editorialStatus, 'stale');
  assert.equal(changed.editorialWriteup, product.editorialWriteup);
  assert.equal(changed.preservation, 'stale_source_changed');
});

test('generation completeness is retryable while factual rejections remain owner-reviewable', () => {
  const product = {
    id: 'B012345678',
    title: 'Gray shark-shaped ceramic coffee mug with raised fin handle',
    imageUrl: 'https://images.example/shark.jpg',
    sourceFacts: { brand: 'Glazery', features: ['Raised shark figure', '13.5 ounce capacity'] },
    editorialStatus: 'pending',
  };
  const incomplete = resolveEditorialAttempt(product, {
    draftWriteup: 'Truncated attempt.',
    pipelineReasons: ['draft_generation_incomplete', 'review_response_missing'],
  });
  assert.equal(incomplete.editorialStatus, 'pending');
  assert.equal(incomplete.requiresManualReview, false);

  const rejected = resolveEditorialAttempt(product, {
    draftWriteup: 'Truncated attempt.',
    review: { approved: false, reasons: ['unsupported material claim'] },
    pipelineReasons: [],
  });
  assert.equal(rejected.editorialStatus, 'needs_review');
  assert.equal(rejected.requiresManualReview, true);
  assert.equal(editorialReasonsRequireManualReview(['Lacks support for personalization details.']), true);
});

test('editorial retries include malformed paragraphs and one reviewer rejection', () => {
  const oneParagraph = Array.from({ length: 160 }, (_, index) => `detail${index}`).join(' ');
  const twoParagraphs = `${Array.from({ length: 80 }, (_, index) => `first${index}`).join(' ')}\n\n${Array.from({ length: 80 }, (_, index) => `second${index}`).join(' ')}`;

  assert.equal(retryableDraft({ editorialWriteup: oneParagraph }), true);
  assert.equal(retryableDraft({ editorialWriteup: twoParagraphs }), false);
  assert.equal(retryableReview({ approved: false, correctedEditorial: twoParagraphs }), true);
  assert.equal(retryableReview({ approved: true, correctedEditorial: oneParagraph }), true);
  assert.equal(retryableReview({ approved: true, correctedEditorial: null }), false);
});

test('editorial batch omissions and short drafts receive one bounded per-item retry', async () => {
  const products = [
    { id: 'B000000001', editorialWriteup: '' },
    { id: 'B000000002', editorialWriteup: '' },
  ];
  const calls = [];
  const requestBatch = async (batch, _telemetry, operation) => {
    calls.push({ ids: batch.map((product) => product.id), operation });
    const entries = batch.length > 1
      ? [['B000000001', { id: 'B000000001', editorialWriteup: 'Too short.' }]]
      : [[batch[0].id, {
        id: batch[0].id,
        editorialWriteup: Array.from({ length: 160 }, (_, index) => `detail${index}`).join(' '),
      }]];
    return {
      items: new Map(entries),
      diagnostics: {
        expectedIds: batch.map((product) => product.id),
        returnedIds: entries.map(([id]) => id),
        finishReason: 'stop',
      },
    };
  };
  const telemetry = { warnings: [] };
  const result = await requestEditorialWithRetries(
    products,
    requestBatch,
    retryableDraft,
    telemetry,
    'draft'
  );

  assert.deepEqual(calls, [
    { ids: ['B000000001', 'B000000002'], operation: 'editorial_draft' },
    { ids: ['B000000001'], operation: 'editorial_draft_retry' },
    { ids: ['B000000002'], operation: 'editorial_draft_retry' },
  ]);
  assert.equal(result.byId.size, 2);
  assert.equal(result.diagnosticsById.get('B000000001').retryCount, 1);
  assert.equal(result.diagnosticsById.get('B000000002').retryCount, 1);
  assert.equal(telemetry.warnings.length, 0);
});

test('confirmed model credit exhaustion is explicit and does not retry each product', async () => {
  for (const code of ['credit_balance_exhausted', 'insufficient_quota', 'project_spend_limit_exceeded']) {
    let calls = 0;
    const telemetry = { warnings: [] };
    const result = await requestEditorialWithRetries(
      [{ id: 'B000000001' }, { id: 'B000000002' }],
      async () => { calls++; throw Object.assign(new Error('Account unavailable'), { status: 429, code }); },
      retryableDraft, telemetry, 'draft'
    );
    assert.equal(calls, 1);
    assert.equal(result.byId.size, 0);
    assert.equal(telemetry.warnings[0].reasonCode, `model_${code}`);
    assert.equal(result.diagnosticsById.get('B000000001').retryCount, 0);
  }
});

test('transient model throttling retains the bounded per-product retry', async () => {
  let calls = 0;
  const telemetry = { warnings: [] };
  await requestEditorialWithRetries([{ id: 'B000000001' }], async () => {
    calls++; throw Object.assign(new Error('Slow down'), { status: 429, code: 'rate_limit_exceeded' });
  }, retryableDraft, telemetry, 'draft');
  assert.equal(calls, 2);
  assert.equal(telemetry.warnings[0].reasonCode, 'draft_request_failed');
});

test('product upsert has a database-level approved-copy preservation backstop', () => {
  const source = fs.readFileSync(
    new URL('../scripts/ops/catalog-maintenance-postgres.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /WHEN products\.editorial_status IN \('generated_ready', 'stale'\)\s+THEN products\.editorial_writeup/);
  assert.match(source, /WHEN products\.editorial_status = 'generated_ready' THEN 'generated_ready'/);
  assert.match(source, /products\.editorial_source_hash IS DISTINCT FROM EXCLUDED\.source_facts_hash THEN 'stale'/);
});

test('duplicate winner favors verified factual and reviewed inventory deterministically', () => {
  const winner = selectDuplicateWinner([
    { id: 'B000000001', qualityScore: 0.9, availabilityStatus: 'UNKNOWN', sourceFacts: {} },
    {
      id: 'B000000002',
      qualityScore: 0.7,
      availabilityStatus: 'IN_STOCK',
      editorialStatus: 'manual_locked',
      sourceFacts: { brand: 'Odd Co', features: ['Concrete fact'] },
    },
  ]);
  assert.equal(winner.id, 'B000000002');
});

test('historical click counters cannot determine the editorial duplicate winner', () => {
  const facts = { qualityScore: 0.8, availabilityStatus: 'IN_STOCK', sourceFacts: { brand: 'Odd Co' } };
  assert.equal(selectDuplicateWinner([
    { ...facts, id: 'B000000002', clickCount: 100_000 },
    { ...facts, id: 'B000000001', clickCount: 0 },
  ]).id, 'B000000001');
});
