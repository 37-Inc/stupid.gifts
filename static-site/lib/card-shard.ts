import type { PublicCatalogProduct } from "../../lib/catalog/types";
import { isIllustrative } from "./selection.ts";
import { earliestCatalogExpiry } from "../../lib/catalog/display.ts";
import { isPersistentImagePath } from "../../lib/catalog/persistent-image.ts";

/** Rendering projection, not a second catalog/storage contract. */
export type CatalogCard = Pick<
  PublicCatalogProduct,
  | "id"
  | "source"
  | "slug"
  | "title"
  | "description"
  | "imageUrl"
  | "eligibleUntil"
  | "punnyTitle"
  | "wittyDescription"
> & { illustrative: boolean };
export function projectCard(product: PublicCatalogProduct): CatalogCard {
  return {
    id: product.id,
    source: product.source,
    slug: product.slug,
    title: product.title,
    description: product.description,
    imageUrl: product.imageUrl,
    eligibleUntil: product.eligibleUntil,
    ...(product.punnyTitle ? { punnyTitle: product.punnyTitle } : {}),
    ...(product.wittyDescription
      ? { wittyDescription: product.wittyDescription }
      : {}),
    illustrative: isIllustrative(product),
  };
}
export interface CardShard {
  schemaVersion: 1;
  status: "ready";
  catalogRevision: string;
  version: string;
  kind: "feed" | "random";
  eligibleUntil: string | null;
  products: CatalogCard[];
  next: string | null;
}
export interface ShardExpectation {
  catalogRevision: string;
  version: string;
  kind: CardShard["kind"];
}
const CARD_FIELDS = [
  "id",
  "source",
  "slug",
  "title",
  "description",
  "imageUrl",
  "eligibleUntil",
  "punnyTitle",
  "wittyDescription",
  "illustrative",
];
function unavailable(): never {
  throw new Error("Catalog shard unavailable");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    unavailable();
  return value as Record<string, unknown>;
}
function instant(value: unknown): number {
  if (value === null) return Infinity;
  if (typeof value !== "string") return NaN;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : NaN;
}
function imageUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (/^\/(?!\/)[a-zA-Z0-9/_\-.]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && !url.username && !url.password && !url.hash
    );
  } catch {
    return false;
  }
}
/** Validate release identity and deadlines after I/O; safe fallback is not empty success. */
export function validateCardShard(
  input: unknown,
  expected: ShardExpectation & { now: number },
): CardShard {
  const value = record(input);
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "schemaVersion",
          "status",
          "catalogRevision",
          "version",
          "kind",
          "eligibleUntil",
          "products",
          "next",
        ].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    value.status !== "ready" ||
    value.catalogRevision !== expected.catalogRevision ||
    value.version !== expected.version ||
    value.kind !== expected.kind ||
    !(instant(value.eligibleUntil) > expected.now) ||
    !Array.isArray(value.products) ||
    !value.products.length ||
    value.products.length > (expected.kind === "feed" ? 24 : 48)
  )
    unavailable();
  const ids = new Set<string>(),
    slugs = new Set<string>();
  for (const item of value.products) {
    const card = record(item);
    if (
      Object.keys(card).some((key) => !CARD_FIELDS.includes(key)) ||
      typeof card.id !== "string" ||
      !card.id ||
      !["amazon", "etsy"].includes(card.source as string) ||
      ids.has(card.id) ||
      typeof card.slug !== "string" ||
      card.slug.length > 160 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(card.slug) ||
      slugs.has(card.slug) ||
      typeof card.title !== "string" ||
      !card.title.trim() ||
      typeof card.description !== "string" ||
      !card.description.trim() ||
      !imageUrl(card.imageUrl) ||
      (card.eligibleUntil === null && !isPersistentImagePath(card.imageUrl)) ||
      typeof card.illustrative !== "boolean" ||
      !(instant(card.eligibleUntil) > expected.now) ||
      ["punnyTitle", "wittyDescription"].some(
        (key) =>
          key in card &&
          (typeof card[key] !== "string" || !(card[key] as string).trim()),
      )
    )
      unavailable();
    ids.add(card.id);
    slugs.add(card.slug);
  }
  if (
    value.eligibleUntil !==
    earliestCatalogExpiry(value.products as CatalogCard[])
  )
    unavailable();
  if (
    expected.kind === "random"
      ? value.next !== null
      : value.next !== null &&
        (typeof value.next !== "string" ||
          !new RegExp(
            `^/catalog/${expected.version}/feed-[1-9][0-9]*\\.json$`,
          ).test(value.next))
  )
    unavailable();
  return value as unknown as CardShard;
}
export async function fetchCardShard(
  path: string,
  expected: ShardExpectation,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<CardShard> {
  if (signal.aborted) throw signal.reason;
  const abort = new AbortController();
  const cancel = () => abort.abort(signal.reason);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => abort.abort(new Error("Catalog shard unavailable")),
    Math.max(
      1,
      Math.min(10_000, Number.isFinite(timeoutMs) ? timeoutMs : 10_000),
    ),
  );
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(abort.signal.reason);
    abort.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try {
    return await Promise.race([
      aborted,
      (async () => {
        const response = await fetch(path, { signal: abort.signal });
        if (!response.ok) unavailable();
        return validateCardShard(await response.json(), {
          ...expected,
          now: Date.now(),
        });
      })(),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    abort.signal.removeEventListener("abort", rejectAbort);
  }
}
