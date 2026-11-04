import { createHash } from "node:crypto";
import type { CatalogSnapshot } from "../../lib/catalog/types";
import { PHOTO_SHARD_SIZE } from "./photo-shard";
import type { PhotoIndex, PhotoShard } from "./photo-shard";

/** Build-only projection. The sealed snapshot and its deadlines remain unchanged. */
export function createPhotoRelease(snapshot: CatalogSnapshot) {
  const products = snapshot.products.filter(product => product.persistent && product.eligibleUntil !== null
    && /^https:\/\//.test(product.imageUrl)).sort((a, b) => a.id.localeCompare(b.id));
  const version = createHash("sha256").update(JSON.stringify({ schemaVersion: 1,
    layout: "deadline-groups-v1",
    catalogRevision: snapshot.catalogRevision, products: products.map(({ id, imageUrl, eligibleUntil }) => ({ id, imageUrl, eligibleUntil })) })).digest("hex");
  const index: PhotoIndex = { schemaVersion: 1, status: "ready", version, products: {} };
  // Never let an older image expire the shard containing a freshly refreshed
  // neighbor. Each bounded shard has exactly one original observation deadline.
  const groups = new Map<string, typeof products>();
  for (const product of products) {
    const group = groups.get(product.eligibleUntil!) ?? [];
    group.push(product); groups.set(product.eligibleUntil!, group);
  }
  const batches = [...groups.values()].flatMap(group => Array.from({ length: Math.ceil(group.length / PHOTO_SHARD_SIZE) },
    (_, i) => group.slice(i * PHOTO_SHARD_SIZE, (i + 1) * PHOTO_SHARD_SIZE)));
  const shards = batches.map((batch, i) => {
    const eligibleUntil = batch[0].eligibleUntil!;
    const payload: PhotoShard = { schemaVersion: 1, status: "ready", version, eligibleUntil,
      images: Object.fromEntries(batch.map(product => [product.id, { imageUrl: product.imageUrl, eligibleUntil: product.eligibleUntil! }])) };
    for (const product of batch) index.products[product.id] = { shard: i + 1, eligibleUntil };
    return { path: `/catalog/${version}/photos-${i + 1}.json`, eligibleUntil, payload };
  });
  return { indexPath: products.length ? `/catalog/${version}/photos.json` : null,
    index, shards };
}
