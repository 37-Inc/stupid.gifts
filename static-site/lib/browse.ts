import { createHash } from "node:crypto";
import type { CatalogSnapshot } from "../../lib/catalog/types";
import { readySnapshotProducts, RANDOM_POOL_LIMIT } from "./selection";
import { isCatalogDisplayEligibleProduct, limitProductTypeDiversity,
  scoreProductForFeed, suppressNearDuplicateProducts,
} from "../../lib/db/product-scoring";
import homepage from "../../content/homepage.json";
import defaultEdition from "../../content/homepage-edition.json";
import { readHomepageEdition } from "../../lib/catalog/homepage-edition";
import { projectCard } from "./card-shard";
import type { CardShard } from "./card-shard";
import { earliestCatalogExpiry } from "../../lib/catalog/display";

export const INITIAL_BROWSE_COUNT = 24;
export const FEED_SHARD_SIZE = 24;

/** Build-only ranking. Curate the first batch without dropping any gifts;
 * weaker matches/variants remain in subsequent static batches. */
export function rankedBrowseProducts(snapshot: CatalogSnapshot) {
  const seed = snapshot.generatedAt.slice(0, 10);
  const ranked = readySnapshotProducts(snapshot).map(product => ({ product,
    fit: isCatalogDisplayEligibleProduct(product, { asOf: new Date(snapshot.generatedAt) }),
    score: scoreProductForFeed(product, seed),
  })).sort((a, b) => Number(b.fit) - Number(a.fit) || b.score - a.score
    || a.product.id.localeCompare(b.product.id));
  const featured = homepage.featuredIds.flatMap(id => ranked.find(p => p.product.id === id)?.product || []);
  const featuredIds = new Set(featured.map(p => p.id));
  const opening = [...featured, ...limitProductTypeDiversity(
    suppressNearDuplicateProducts(ranked.filter(p => p.fit && !featuredIds.has(p.product.id)).map(p => p.product), 96),
    INITIAL_BROWSE_COUNT - featured.length, 2)];
  const selected = new Set(opening.map(p => p.id));
  return [...opening, ...ranked.filter(p => !selected.has(p.product.id)).map(p => p.product)];
}

/** Stable Pacific calendar keys, derived from a sealed release time, never a visitor clock. */
export function merchandisingEpoch(generatedAt: string) {
  const date = new Date(generatedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== generatedAt)
    throw new Error("Invalid merchandising release time");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles",
    year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  const day = `${part("year")}-${part("month")}-${part("day")}`;
  const ordinal = Date.parse(`${day}T00:00:00.000Z`) / 86400000;
  return { day, week: Math.floor((ordinal - 4) / 7) }; // January 5, 1970 was a Monday.
}

function seededFraction(seed: string, id: string) {
  const hash = createHash("sha256").update(`${seed}:${id}`).digest();
  return (hash.readUInt32BE(0) + 1) / 4294967297;
}

/** Editorial choice, not a merchant-keyword classifier. Missing/retired picks
 * are safely filled from the whole public catalog. All other gifts remain in
 * the tail, once each; only the presentation order changes. */
export function merchandisedBrowseProducts(snapshot: CatalogSnapshot, generatedAt = snapshot.generatedAt, input?: unknown) {
  const day = merchandisingEpoch(generatedAt).day;
  const base = readySnapshotProducts(snapshot).sort((a, b) =>
    seededFraction(day, a.id) - seededFraction(day, b.id) || a.id.localeCompare(b.id));
  const available = new Map(base.map(product => [product.id, product]));
  const edition = readHomepageEdition(input) ?? readHomepageEdition(defaultEdition)!;
  const selected = new Set<string>();
  const picks = (ids: string[]) => ids.flatMap(id => {
    const product = available.get(id);
    if (!product || selected.has(id)) return [];
    selected.add(id); return [product];
  });
  const anchors = picks(edition.anchors), rotations = picks(edition.rotation);
  const opening: typeof base = [];
  const slots = new Set([0, 1, 4, 8, 13, 19]);
  for (let index = 0; index < INITIAL_BROWSE_COUNT; index++) {
    const product = slots.has(index) ? anchors.shift() || rotations.shift() : rotations.shift() || anchors.shift();
    if (product) opening.push(product);
  }
  return [...opening, ...base.filter(product => !selected.has(product.id))];
}

export function createBrowseRelease(snapshot: CatalogSnapshot, generatedAt = snapshot.generatedAt, edition?: unknown) {
  const cards = merchandisedBrowseProducts(snapshot, generatedAt, edition).map(projectCard);
  const version = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: 1,
        initialBrowseCount: INITIAL_BROWSE_COUNT,
        feedShardSize: FEED_SHARD_SIZE,
        randomPoolLimit: RANDOM_POOL_LIMIT,
        catalogRevision: snapshot.catalogRevision,
        cards,
      }),
    )
    .digest("hex");
  const base = `/catalog/${version}`;
  const shard = (
    kind: CardShard["kind"],
    products: typeof cards,
    path: string,
    next: string | null = null,
  ) => {
    const eligibleUntil = earliestCatalogExpiry(products);
    const payload = products.length
      ? {
          schemaVersion: 1 as const,
          status: "ready" as const,
          catalogRevision: snapshot.catalogRevision,
          version,
          kind,
          eligibleUntil,
          products,
          next,
        }
      : {
          schemaVersion: 1 as const,
          status: "unavailable" as const,
          catalogRevision: snapshot.catalogRevision,
          version,
          kind,
          eligibleUntil: null,
          products: [],
          next: null,
        };
    return { path, eligibleUntil, payload };
  };
  const remaining = cards.slice(INITIAL_BROWSE_COUNT);
  const feedCount = Math.ceil(remaining.length / FEED_SHARD_SIZE);
  const feedPath = (index: number) => `${base}/feed-${index + 1}.json`;
  const feed = Array.from({ length: feedCount }, (_, index) =>
    shard(
      "feed",
      remaining.slice(index * FEED_SHARD_SIZE, (index + 1) * FEED_SHARD_SIZE),
      feedPath(index),
      index + 1 < feedCount ? feedPath(index + 1) : null,
    ),
  );
  const random = shard(
    "random",
    cards.slice(0, RANDOM_POOL_LIMIT),
    `${base}/random.json`,
  );
  return {
    catalogRevision: snapshot.catalogRevision,
    version,
    opening: cards.slice(0, 3),
    feed: {
      initial: cards.slice(3, INITIAL_BROWSE_COUNT),
      next: feed[0]?.path || null,
    },
    random: {
      initial: cards[0],
      poolSize: random.payload.products.length,
      poolPath: random.path,
    },
    shards: [...feed, random],
  };
}
