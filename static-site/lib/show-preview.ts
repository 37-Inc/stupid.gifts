export interface ShowPreviewProduct {
  id: string; title: string; description: string; imageUrl: string; affiliateUrl: string; eligibleUntil: string;
}

/** Optional endpoint data is never trusted as catalog content or an internal route. */
export function readShowPreviews(value: unknown, now: number): ShowPreviewProduct[] {
  if (!value || typeof value !== 'object' || !('products' in value) || !Array.isArray(value.products)) return [];
  return value.products.flatMap((product: unknown) => {
    if (!product || typeof product !== 'object' || !('id' in product) || !('title' in product)
      || !('description' in product) || !('imageUrl' in product) || !('affiliateUrl' in product) || !('eligibleUntil' in product)
      || typeof product.id !== 'string' || !/^B[A-Z0-9]{9}$/.test(product.id)
      || typeof product.title !== 'string' || !product.title.trim() || product.title.length > 200
      || typeof product.description !== 'string' || product.description.length > 500
      || typeof product.imageUrl !== 'string' || typeof product.affiliateUrl !== 'string'
      || typeof product.eligibleUntil !== 'string' || !(Date.parse(product.eligibleUntil) > now)) return [];
    try {
      const image = new URL(product.imageUrl), link = new URL(product.affiliateUrl);
      if (image.origin !== 'https://m.media-amazon.com' || !image.pathname.startsWith('/images/I/') || image.username || image.password
        || link.origin !== 'https://www.amazon.com' || link.pathname !== `/dp/${product.id}`
        || link.search !== '?tag=goose-gifts-37-20' || link.hash || link.username || link.password) return [];
    } catch { return []; }
    return [{ id: product.id, title: product.title, description: product.description, imageUrl: product.imageUrl,
      affiliateUrl: product.affiliateUrl, eligibleUntil: product.eligibleUntil }];
  });
}
