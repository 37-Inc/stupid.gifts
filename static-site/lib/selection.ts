import type {
  CatalogSnapshot,
  PublicCatalogProduct,
} from "../../lib/catalog/types";
import { catalogDeadline, persistentPublicProduct } from "../../lib/catalog/display.ts";
import { productPresentation } from '../../lib/catalog/presentation.ts';

export const RANDOM_POOL_LIMIT = 48;

export function readySnapshotProducts(
  snapshot: CatalogSnapshot,
  now = Date.parse(snapshot.generatedAt),
) {
  return snapshot.products.map(product => productPresentation(persistentPublicProduct(product) ?? product)).filter(
    (product) =>
      product.isActive &&
      product.qualityScore >= (product.eligibleUntil === null ? 0 : 0.55) &&
      product.qualityScore <= 1 &&
      product.imageUrl &&
      product.affiliateUrl &&
      catalogDeadline(product.eligibleUntil) > now,
  );
}

export function eligiblePool<
  T extends Pick<PublicCatalogProduct, "eligibleUntil">,
>(products: readonly T[], now = Date.now()) {
  return products
    .filter((product) => catalogDeadline(product.eligibleUntil) > now)
    .slice(0, RANDOM_POOL_LIMIT);
}

export function nextRandomIndex(
  length: number,
  current: number,
  random = Math.random,
): number {
  if (length < 2) return 0;
  const offset =
    Math.min(length - 2, Math.max(0, Math.floor(random() * (length - 1)))) + 1;
  return (current + offset) % length;
}

/** Select uniformly, excluding the last shown gift when it is still in the pool. */
export function initialRandomIndex<T extends { id: string }>(
  products: readonly T[],
  lastId: string | null,
  random = Math.random,
) {
  if (products.length < 2) return 0;
  const previous = products.findIndex((product) => product.id === lastId);
  return previous >= 0
    ? nextRandomIndex(products.length, previous, random)
    : Math.min(products.length - 1, Math.max(0, Math.floor(random() * products.length)));
}

export function isIllustrative(
  product: Pick<PublicCatalogProduct, "affiliateUrl">,
) {
  return new URL(product.affiliateUrl).hostname === "example.invalid";
}
