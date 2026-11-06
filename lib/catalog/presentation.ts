import backfill from '../../content/catalog-presentation.json' with {type:'json'};

export interface PresentationProduct {
  id: string; source: string; title: string; description?: string;
  wittyDescription?: string | null; punnyTitle?: string | null; humorTags?: readonly (string | null)[] | null;
  persistentBase?: {description:string};
}
export interface PresentationReview {
  sourceTitle: string;
  sourceCopy: string;
  sourceDescription?: string;
  description: string;
  title?: string;
  /** Explicitly repaired contradictory editorial, not a guessed keyword gate. */
  repairedSemanticCopy?: boolean;
}
const reviews: Readonly<Record<string, PresentationReview>> = backfill;

function matchingReview(product: PresentationProduct): PresentationReview | undefined {
  if (product.source !== 'amazon' || !Object.hasOwn(reviews, product.id)) return;
  const review = reviews[product.id];
  // Offer/photo/timestamp changes are deliberately absent. A new object or
  // genuinely revised copy must never inherit another item's old editorial.
  const titleMatches = product.title === review.sourceTitle || product.title === review.title;
  const copy = product.wittyDescription?.trim() || product.description?.trim() || '';
  const sourceDescription=review.sourceDescription??review.sourceCopy;
  return titleMatches && (product.description===review.description
    || copy===review.sourceCopy&&(product.description===undefined||product.description===sourceDescription)) ? review : undefined;
}

/** One short copy contract for cards, details, metadata, retrieval and indexing.
 * Historical aliases remain private inputs, never an independent display path. */
export function productShortDescription(product: PresentationProduct): string {
  return matchingReview(product)?.description
    || product.description?.trim() || product.wittyDescription?.trim() || product.title;
}
export function productDisplayTitle(product: PresentationProduct): string {
  return matchingReview(product)?.title || product.title;
}
export function hasRepairedSemanticCopy(product: PresentationProduct): boolean {
  return matchingReview(product)?.repairedSemanticCopy === true;
}
export function productPresentation<T extends PresentationProduct>(product: T): T {
  const review = matchingReview(product);
  const current = { ...product, title: productDisplayTitle(product), description: productShortDescription(product) };
  if (review?.repairedSemanticCopy) {
    // Do not let an old Mickey/plush pun or tags describe an insect net. The
    // original values remain in the sealed catalog and native-vector history.
    delete current.punnyTitle;
    current.wittyDescription = current.description;
    current.humorTags = [];
  }
  return current;
}

/** A copy-only or offer-only refresh cannot silently inherit stale object copy.
 * A changed title is reviewed, or gets a plain factual title-based fallback. */
export function refreshedShortCopy(previous: PresentationProduct, title: string): string {
  return sameProductTitle(title,previous.title) ? productShortDescription(previous) : title.trim().replace(/[.!?]+$/, '') + '.';
}
export function sameProductTitle(a: string,b: string): boolean {
  const key=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[™®]/g,'').replace(/\s+/g,' ').trim();
  return key(a)===key(b);
}
/** Current producer recipe. No retained search query, pun or commission terms. */
export function canonicalDescriptionEmbeddingInput(product: PresentationProduct): string {
  const view=productPresentation({...product,description:product.description
    ?? product.wittyDescription ?? product.persistentBase?.description ?? ''});
  return [view.title,view.description].filter(Boolean).join('. ');
}
