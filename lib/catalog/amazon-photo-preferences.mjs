// Owner-picked Amazon gallery image identities, not URLs or durable rights.
// Refresh only from a new same-ASIN Creators API observation.
const preferred = Object.freeze({ B0C85MZCYY: '71nY+6TsrYL' });

export const preferredAmazonPhotoIds = Object.freeze(Object.keys(preferred));

export function hasPreferredAmazonPhoto(id) {
  return Object.hasOwn(preferred, id);
}

export function matchesPreferredAmazonPhoto(id, value) {
  if (!hasPreferredAmazonPhoto(id) || typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.origin === 'https://m.media-amazon.com' && !url.username && !url.password && !url.hash
      && decodeURIComponent(url.pathname).startsWith('/images/I/' + preferred[id] + '.');
  } catch { return false; }
}
