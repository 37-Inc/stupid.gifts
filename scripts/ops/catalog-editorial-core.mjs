import { createHash } from 'node:crypto';
import {validDisplayTitle as completeProductName} from '../../lib/catalog/merchandising.ts';
export {completeProductName};

export const EDITORIAL_PROMPT_VERSION = 'catalog-editorial-v2';
export const SHORT_COPY_PROMPT_VERSION = 'catalog-short-copy-v2-title';
export const EDITORIAL_READY_STATUSES = new Set(['short_ready', 'generated_ready', 'manual_locked']);
export const PURCHASABLE_AVAILABILITY = new Set([
  'IN_STOCK',
  'IN_STOCK_SCARCE',
  'INSTOCKSCARCE',
  'AVAILABLE_DATE',
  'LEADTIME',
  'PREORDER',
]);

const GENERIC_PHRASES = [
  'the perfect gift',
  'perfect for anyone',
  'something for everyone',
  'sure to delight',
  'sure to bring a smile',
  'a must have',
  'a must-have',
  'this unique product',
  'this amazing product',
  'buy now',
  'click here',
  'seo',
];

const MUTABLE_CLAIM_PATTERNS = [
  /\b(?:currently|now) (?:available|in stock|on sale)\b/i,
  /\bonly \$\d/i,
  /\b(?:free|two-day|same-day) shipping\b/i,
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(Object.keys(value)
    .sort()
    .map((key) => [key, stableValue(value[key])])
    .filter(([, item]) => item !== undefined && item !== null && item !== ''));
}

export function normalizedSourceSnapshot(product) {
  return stableValue({
    title: String(product.title || '').trim(),
    imageUrl: String(product.imageUrl || '').trim(),
    sourceFacts: stableValue(product.sourceFacts || {}),
  });
}

export function editorialSourceHash(product) {
  return createHash('sha256')
    .update(JSON.stringify(normalizedSourceSnapshot(product)))
    .digest('hex');
}

export function isPurchasableAvailability(status) {
  return PURCHASABLE_AVAILABILITY.has(String(status || '').toUpperCase());
}

export function sourceFactCount(product) {
  const facts = product.sourceFacts || {};
  const values = Object.values(facts).flatMap((value) => {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value);
    return [value];
  });

  return values.filter((value) => value !== undefined && value !== null && String(value).trim()).length;
}

export function editorialWordCount(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean).length;
}

function paragraphs(value) {
  return String(value || '').split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
}

function wordShingles(value, size = 4) {
  const words = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const shingles = new Set();
  for (let index = 0; index <= words.length - size; index += 1) {
    shingles.add(words.slice(index, index + size).join(' '));
  }
  return shingles;
}

export function editorialSimilarity(first, second) {
  const left = wordShingles(first);
  const right = wordShingles(second);
  if (left.size === 0 || right.size === 0) return 0;
  const overlap = [...left].filter((value) => right.has(value)).length;
  return overlap / new Set([...left, ...right]).size;
}

function listingEvidenceTerms(product, minimumLength = 5) {
  const factText = JSON.stringify(normalizedSourceSnapshot(product))
    .toLowerCase()
    .replace(/https?:[^"\s]+/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ');
  return [...new Set(factText.split(/\s+/).filter((term) => (
    term.length >= minimumLength
      && !['amazon', 'product', 'funny', 'gifts', 'gift', 'large', 'small', 'the', 'and', 'for', 'with'].includes(term)
  )))];
}

export function validateEditorialDraft(product, editorialWriteup, existingWriteups = []) {
  const editorial = String(editorialWriteup || '').trim();
  const reasons = [];
  const words = editorialWordCount(editorial);
  const sections = paragraphs(editorial);
  const normalized = editorial.toLowerCase();

  if (words < 140 || words > 280) reasons.push('word_count');
  if (sections.length < 2 || sections.length > 4) reasons.push('paragraph_count');
  if (GENERIC_PHRASES.some((phrase) => normalized.includes(phrase))) reasons.push('generic_language');
  if (MUTABLE_CLAIM_PATTERNS.some((pattern) => pattern.test(editorial))) reasons.push('mutable_offer_claim');
  if (sourceFactCount(product) < 2) reasons.push('insufficient_source_facts');

  const evidenceMatches = listingEvidenceTerms(product)
    .filter((term) => normalized.includes(term))
    .length;
  if (evidenceMatches < 3) reasons.push('insufficient_listing_specificity');

  if (existingWriteups.some((existing) => editorialSimilarity(editorial, existing) >= 0.72)) {
    reasons.push('duplicate_editorial');
  }

  return {
    approved: reasons.length === 0,
    reasons,
    wordCount: words,
    paragraphCount: sections.length,
    evidenceMatches,
  };
}

/** Listing readiness is independent of the optional long article. The separate
 * reviewer must still approve every claim against the supplied listing facts. */
export function validateShortDescription(product, value) {
  const description = String(value || '').trim();
  const normalized = description.toLowerCase();
  const words = editorialWordCount(description);
  const reasons = [];
  if (words < 6 || words > 35 || description.length > 220) reasons.push('short_copy_length');
  if (/[\r\n]/.test(description)) reasons.push('short_copy_paragraphs');
  if (GENERIC_PHRASES.some(phrase => normalized.includes(phrase))) reasons.push('generic_language');
  if (MUTABLE_CLAIM_PATTERNS.some(pattern => pattern.test(description))) reasons.push('mutable_offer_claim');
  if (sourceFactCount(product) < 2) reasons.push('insufficient_source_facts');
  const writtenTerms = new Set(normalized.match(/[a-z0-9]+/g) || []);
  const evidenceMatches = listingEvidenceTerms(product, 3).filter(term => writtenTerms.has(term)).length;
  if (evidenceMatches < 2) reasons.push('insufficient_listing_specificity');
  return { approved: reasons.length === 0, reasons, wordCount: words, evidenceMatches };
}

export function hasCurrentApprovedCopy(product) {
  if (!EDITORIAL_READY_STATUSES.has(product.editorialStatus)
    || product.editorialSourceHash !== editorialSourceHash(product)
    || !(Number(product.editorialQualityScore) >= 0.8)) return false;
  if (product.editorialStatus === 'short_ready') return validateShortDescription(product, product.wittyDescription).approved;
  const article = String(product.editorialWriteup || '');
  return article.length >= 500 && editorialWordCount(article) >= 90 && /\n\s*\n/.test(article);
}

export function resolveShortDescriptionAttempt(product, {
  draftDescription, draftTitle, review, reviewQuality = 0.05, model, generatedAt = new Date(),
} = {}) {
  const draft = String(draftDescription || '').trim();
  const corrected = String(review?.correctedDescription || '').trim();
  const correction = corrected ? validateShortDescription(product, corrected) : null;
  const selected = correction?.approved ? corrected : draft;
  const title=String(review?.correctedTitle||draftTitle||'').trim();
  const validation = validateShortDescription(product, selected);
  const currentHash = editorialSourceHash(product);
  const approved = review?.approved === true && Number(reviewQuality) >= 0.8 && validation.approved
    &&(draftTitle===undefined||completeProductName(title));
  if (approved) return {
    wittyDescription: selected,
    ...(draftTitle===undefined?{}:{punnyTitle:title}),
    editorialSourceHash: currentHash,
    editorialStatus: 'short_ready',
    editorialQualityScore: reviewQuality,
    editorialModel: model,
    editorialPromptVersion: draftTitle===undefined?'catalog-short-copy-v1':SHORT_COPY_PROMPT_VERSION,
    editorialGeneratedAt: generatedAt,
    editorialBlockReason: undefined,
    requiresManualReview: false,
    preservation: null,
    validation,
  };
  const reviewerReasons = Array.isArray(review?.reasons) ? review.reasons.map(String) : [];
  const requiresManualReview = review?.approved === false && editorialReasonsRequireManualReview(reviewerReasons);
  const preservable = ['short_ready', 'generated_ready', 'manual_locked', 'stale'].includes(product.editorialStatus)
    && product.editorialSourceHash && (product.wittyDescription || product.editorialWriteup);
  if (preservable) {
    const unchanged = product.editorialSourceHash === currentHash;
    return { editorialStatus: unchanged ? product.editorialStatus : 'stale',
      editorialBlockReason: unchanged ? product.editorialBlockReason : 'source_facts_changed_generation_incomplete',
      requiresManualReview: !unchanged && requiresManualReview,
      preservation: unchanged ? 'approved_source_unchanged' : 'stale_source_changed', validation };
  }
  return { editorialStatus: requiresManualReview ? 'needs_review' : 'pending',
    editorialBlockReason: [...validation.reasons, ...reviewerReasons,
      ...(review?.approved === true ? [] : ['short_review_not_approved'])].join(', '),
    requiresManualReview, preservation: null, validation };
}

const MANUAL_EDITORIAL_REASON = /(unsupported|not[_ -]?supported|lack(?:s|ed|ing)? (?:of )?support|invented|inaccurate|contradict|misleading|wrong product|image mismatch|factual mismatch)/i;

export function editorialReasonsRequireManualReview(reasons = []) {
  return reasons.some((reason) => MANUAL_EDITORIAL_REASON.test(String(reason || '')));
}

export function resolveEditorialAttempt(product, {
  draftWriteup,
  review,
  reviewQuality = 0.05,
  pipelineReasons = [],
  existingWriteups = [],
  model,
  promptVersion = EDITORIAL_PROMPT_VERSION,
  generatedAt = new Date(),
} = {}) {
  const draft = String(draftWriteup || '').trim();
  const corrected = String(review?.correctedEditorial || '').trim();
  const draftValidation = validateEditorialDraft(product, draft, existingWriteups);
  const correctedValidation = corrected
    ? validateEditorialDraft(product, corrected, existingWriteups)
    : null;
  // A reviewer correction is optional. A truncated or otherwise invalid
  // correction must never replace a complete factual draft.
  const selectedWriteup = corrected && correctedValidation?.approved ? corrected : draft;
  const selectedValidation = selectedWriteup === corrected && correctedValidation
    ? correctedValidation
    : draftValidation;
  const reviewerReasons = Array.isArray(review?.reasons) ? review.reasons.map(String) : [];
  const reasons = [...new Set([
    ...pipelineReasons.map(String),
    ...(review && review.approved !== true ? ['editorial_review_not_approved'] : []),
    ...selectedValidation.reasons,
    ...reviewerReasons,
    ...(corrected && !correctedValidation?.approved ? ['invalid_reviewer_correction'] : []),
  ])];
  const approved = review?.approved === true
    && Number(reviewQuality) >= 0.8
    && selectedValidation.approved;
  const currentHash = editorialSourceHash(product);
  const requiresManualReview = review?.approved === false
    && editorialReasonsRequireManualReview(reviewerReasons);

  if (approved) {
    return {
      editorialWriteup: selectedWriteup,
      editorialSourceHash: currentHash,
      editorialStatus: 'generated_ready',
      editorialQualityScore: reviewQuality,
      editorialModel: model,
      editorialPromptVersion: promptVersion,
      editorialGeneratedAt: generatedAt,
      editorialBlockReason: undefined,
      requiresManualReview: false,
      preservation: null,
      validation: selectedValidation,
    };
  }

  const preservableStatus = ['short_ready', 'generated_ready', 'manual_locked', 'stale'].includes(product.editorialStatus);
  const hasPreservableEditorial = preservableStatus
    && Boolean(String(product.editorialWriteup || (product.editorialStatus === 'short_ready' ? product.wittyDescription : '') || '').trim())
    && Boolean(product.editorialSourceHash);
  if (hasPreservableEditorial) {
    const sourceUnchanged = product.editorialSourceHash === currentHash;
    return {
      editorialWriteup: product.editorialWriteup,
      editorialSourceHash: product.editorialSourceHash,
      editorialStatus: sourceUnchanged ? product.editorialStatus : 'stale',
      editorialQualityScore: product.editorialQualityScore,
      editorialModel: product.editorialModel,
      editorialPromptVersion: product.editorialPromptVersion,
      editorialGeneratedAt: product.editorialGeneratedAt,
      editorialBlockReason: sourceUnchanged
        ? product.editorialBlockReason
        : requiresManualReview
          ? 'source_facts_changed_manual_review_required'
          : 'source_facts_changed_generation_incomplete',
      requiresManualReview: !sourceUnchanged && requiresManualReview,
      preservation: sourceUnchanged ? 'approved_source_unchanged' : 'stale_source_changed',
      validation: selectedValidation,
    };
  }

  return {
    editorialWriteup: selectedWriteup || undefined,
    editorialSourceHash: currentHash,
    editorialStatus: requiresManualReview ? 'needs_review' : 'pending',
    editorialQualityScore: review ? reviewQuality : undefined,
    editorialModel: model,
    editorialPromptVersion: promptVersion,
    editorialGeneratedAt: generatedAt,
    editorialBlockReason: reasons.length > 0 ? reasons.join(', ') : 'generation_incomplete',
    requiresManualReview,
    preservation: null,
    validation: selectedValidation,
  };
}

export function editorialCandidateBlock(product) {
  if (product.isActive === false) return 'inactive';
  if (!product.imageUrl) return 'missing_image';
  if (!product.affiliateUrl) return 'missing_destination';
  if (!isPurchasableAvailability(product.availabilityStatus)) return 'unavailable';
  if (Number(product.qualityScore || 0) < 0.55) return 'low_quality';
  if (sourceFactCount(product) < 2) return 'ambiguous_listing';
  return undefined;
}

function dateScore(value) {
  const time = value ? new Date(value).getTime() : 0;
  if (!Number.isFinite(time) || time <= 0) return 0;
  const ageDays = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, 1 - ageDays / 90);
}

export function editorialWinnerScore(product) {
  return (isPurchasableAvailability(product.availabilityStatus) ? 100 : 0)
    + (product.editorialStatus === 'manual_locked' ? 25 : EDITORIAL_READY_STATUSES.has(product.editorialStatus) ? 15 : 0)
    + Number(product.qualityScore || 0) * 20
    + dateScore(product.availabilityCheckedAt || product.lastVerifiedAt) * 10
    + Math.min(10, Math.log10(Number(product.reviewCount || 0) + 1) * 3)
    + Math.min(8, sourceFactCount(product));
}

export function selectDuplicateWinner(products) {
  return [...products].sort((left, right) => (
    editorialWinnerScore(right) - editorialWinnerScore(left)
      || String(left.id).localeCompare(String(right.id))
  ))[0];
}
