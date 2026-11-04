/** Optional supplier photos never become part of evergreen HTML or card shards. */
export const PHOTO_SHARD_SIZE = 24;
export const PHOTO_PLACEHOLDER = "/images/gift-placeholder.svg";
export interface PhotoIndex {
  schemaVersion: 1;
  status: "ready";
  version: string;
  products: Record<string, { shard: number; eligibleUntil: string }>;
}
export interface PhotoShard {
  schemaVersion: 1;
  status: "ready";
  version: string;
  eligibleUntil: string;
  images: Record<string, { imageUrl: string; eligibleUntil: string }>;
}
function fail(): never { throw new Error("Catalog photos unavailable"); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function instant(value: unknown): number {
  if (typeof value !== "string") return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : NaN;
}
export function photoVersion(path: string): string {
  const match = path.match(/^\/catalog\/([a-f0-9]{64})\/photos\.json$/);
  if (!match) fail();
  return match[1];
}
export function validatePhotoIndex(input: unknown, version: string): PhotoIndex {
  const value = record(input);
  keys(value, ["schemaVersion", "status", "version", "products"]);
  if (value.schemaVersion !== 1 || value.status !== "ready" || value.version !== version) fail();
  const products = record(value.products), ids = Object.keys(products);
  if (!ids.length || ids.length > 10000) fail();
  for (const id of ids) {
    const entry = record(products[id]);
    keys(entry, ["shard", "eligibleUntil"]);
    if (!id.trim() || id.length > 160 || !Number.isSafeInteger(entry.shard)
      || Number(entry.shard) < 1 || Number(entry.shard) > 10000
      || !Number.isFinite(instant(entry.eligibleUntil))) fail();
  }
  return value as unknown as PhotoIndex;
}
export function validatePhotoShard(input: unknown, version: string, now: number): PhotoShard {
  const value = record(input);
  keys(value, ["schemaVersion", "status", "version", "eligibleUntil", "images"]);
  if (!Number.isFinite(now) || value.schemaVersion !== 1 || value.status !== "ready"
    || value.version !== version || !(instant(value.eligibleUntil) > now)) fail();
  const images = record(value.images), entries = Object.entries(images);
  if (!entries.length || entries.length > PHOTO_SHARD_SIZE) fail();
  for (const [id, raw] of entries) {
    const image = record(raw);
    keys(image, ["imageUrl", "eligibleUntil"]);
    if (!id.trim() || id.length > 160 || !(instant(image.eligibleUntil) > now)) fail();
    let url: URL;
    try { url = new URL(String(image.imageUrl)); } catch { fail(); }
    if (typeof image.imageUrl !== "string" || url.protocol !== "https:" || url.username || url.password || url.hash) fail();
  }
  if (value.eligibleUntil !== entries.map(([, image]) => String(record(image).eligibleUntil)).sort()[0]) fail();
  return value as unknown as PhotoShard;
}
