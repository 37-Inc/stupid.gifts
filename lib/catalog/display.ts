import type { CatalogSnapshot, PersistentCatalogProduct, PublicCatalogProduct } from './types.ts';
import { productPresentation } from './presentation.ts';

/** Null denotes positive permanent clearance, not an invented future date. */
export function catalogDeadline(value: string | null): number {
  return value === null ? Infinity : Date.parse(value);
}

export function persistentPublicProduct(product: PublicCatalogProduct): PersistentCatalogProduct | null {
  if (product.eligibleUntil === null) return product as PersistentCatalogProduct;
  return product.persistent ?? null;
}

/** Select a view without changing the sealed input or renewing its deadlines. */
export function resolvePublicProduct(product: PublicCatalogProduct, asOf: number | Date): PublicCatalogProduct | null {
  const time = asOf instanceof Date ? asOf.getTime() : asOf;
  if (!Number.isFinite(time)) return null;
  return catalogDeadline(product.eligibleUntil) > time ? product : persistentPublicProduct(product);
}

export function earliestCatalogExpiry(products: readonly Pick<PublicCatalogProduct, 'eligibleUntil'>[]): string | null {
  return products.flatMap(({ eligibleUntil }) => eligibleUntil === null ? [] : [eligibleUntil]).sort()[0] ?? null;
}

export function catalogDisplayDeadline(product: PublicCatalogProduct): number {
  return catalogDeadline((persistentPublicProduct(product) ?? product).eligibleUntil);
}

export function earliestDisplayExpiry(products: readonly PublicCatalogProduct[]): string | null {
  return earliestCatalogExpiry(products.map(product => persistentPublicProduct(product) ?? product));
}

/** A build-time view, not a replacement snapshot/receipt or a new observation. */
export function catalogDisplayView(snapshot: CatalogSnapshot): CatalogSnapshot {
  return { ...snapshot, products: snapshot.products.map(product => productPresentation(persistentPublicProduct(product) ?? product)) };
}
