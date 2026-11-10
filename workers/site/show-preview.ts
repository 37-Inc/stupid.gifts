// Finite, owner-approved filming previews only. Never catalog or evergreen assets.
// Both exact items/photos were observed 2026-11-10T20:27:10Z; do not renew.
const eligibleUntil = '2026-11-11T20:20:00Z';
const observedAt = Date.parse('2026-11-10T20:27:10Z');
const products = [
  { id: 'B01DVUSR1Y', title: 'Jeweled butt-plug set', description: 'Three polished metal plugs with pink jeweled bases.',
    imageUrl: 'https://m.media-amazon.com/images/I/61wQj-jCOuL._AC_SX679_AIweblab1392912,T1_.jpg' },
  { id: 'B0DK82DBDG', title: 'Inflatable girlfriend', description: 'Trixie, a life-size inflatable bachelor-party doll.',
    imageUrl: 'https://m.media-amazon.com/images/I/71Jj60i9bhL._AC_SX679_AIweblab1392912,T1_.jpg' },
] as const;

export function showPreview(request: Request, now: number): Response {
  const headers = { 'Cache-Control': 'private, no-store', 'CDN-Cache-Control': 'no-store',
    'Cloudflare-CDN-Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } });
  return Response.json({ products: now >= observedAt && now < Date.parse(eligibleUntil) ? products.map(product => ({ ...product,
    affiliateUrl: `https://www.amazon.com/dp/${product.id}?tag=goose-gifts-37-20`, eligibleUntil })) : [] }, { headers });
}
