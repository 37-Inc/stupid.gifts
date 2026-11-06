// Presentation only. The upstream catalog remains the authority for product
// identity and curated copy; this module never generates product facts.
const cleanText = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim()
  : '';
const firstText = (...values) => values.map(cleanText).find(Boolean) || '';
const objectName = /\b(?:mugs?|cups?|shirts?|socks?|hats?|aprons?|towels?|blankets?|vases?|statues?|figurines?|sculptures?|tapestr(?:y|ies)|posters?|prints?|plaques?|lamps?|lights?|box(?:es)?|buttons?|toys?|games?|books?|notebooks?|calendars?|spatulas?|ladles?|scrapers?|holders?|bags?|rings?|cards?|toilet paper|brush(?:es)?|devices?|nets?)\b/i;
const keywordSegment = value => !/["“”'‘’]/.test(value)
  && /\bgifts?\b|\bstocking stuffers?\b|\bwhite elephant\b|\bsecret santa\b/i.test(value) && !objectName.test(value);

function boundedText(value, limit) {
  if (value.length <= limit) return value;
  const head = value.slice(0, limit - 1);
  const boundary = head.lastIndexOf(' ');
  return `${(boundary > limit / 2 ? head.slice(0, boundary) : head).replace(/[\s:;,.!–—|-]+$/, '')}…`;
}

export function conciseGiftTitle(value, limit = 76) {
  const clean = cleanText(value).replace(/[®©™]/g, '').replace(/\s+/g, ' ').trim();
  // Remove only separate keyword-only gift-marketing segments. Retain factual
  // qualifiers, quoted product wording, sizes and parenthetical variants.
  const parts = clean.split(/(\s+[|–—]\s*|\s+-\s+|,\s*)/);
  while (parts.length > 1 && keywordSegment(parts.at(-1))) parts.splice(-2);
  while (parts.length > 1 && keywordSegment(parts[0])
    && parts.slice(2).some((part, index) => index % 2 === 0 && objectName.test(part))) parts.splice(0, 2);
  return boundedText(parts.join('').trim(), limit);
}

export function naturalProductImage(value) {
  if (typeof value !== 'string' || !value) return null;
  let url;
  try { url = new URL(value); } catch { return value; }
  // Remove a recognized thumbnail/crop recipe only when the same base Amazon
  // photo ID and file type can be retained. Do not infer photos from composite
  // JSON recipes or substitute another image/product.
  if (url.protocol === 'https:' && url.hostname === 'm.media-amazon.com'
    && /PIStarRating|PIWhiteStrip|_ZA|_SR/i.test(url.pathname)) {
    const match = url.pathname.match(/^\/images\/I\/([^/.]+)\._[^/]+\.(jpg|jpeg|png|webp)$/i);
    if (match) { url.pathname = `/images/I/${match[1]}._SL600_.${match[2]}`; return url.href; }
  }
  return value;
}

export function presentGiftProduct(product) {
  const originalTitle = firstText(product?.displayTitle, product?.title);
  const description = firstText(product?.description, product?.wittyDescription, originalTitle);
  return {
    title: conciseGiftTitle(originalTitle),
    description: boundedText(description, 600),
    imageUrl: naturalProductImage(product?.imageUrl),
  };
}
