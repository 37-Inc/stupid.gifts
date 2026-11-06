import { refreshedShortCopy, sameProductTitle } from '../../lib/catalog/presentation.ts';

/** Pure semantics of the existing maintenance INSERT/ON CONFLICT, not a writer.
 * CamelCase input/output; numerics are exact fixed-scale decimal strings.
 * Existing timestamps are opaque: never infer a historical timezone here.
 * The caller supplies one explicit UTC databaseTime for new write/default times.
 * Identity/slug assignment, storage, rights, outbox and publication are separate.
 */
function decimal(value, precision, scale) {
  if (value === null || value === undefined) return null;
  if (!['string', 'number'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Expected finite decimal');
  const match = String(value).match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match || Math.abs(Number(match[4] || 0)) > 100) throw new TypeError('Unsupported decimal');
  const sign = match[1] === '-' ? -1n : 1n;
  let units = BigInt(match[2] + (match[3] || ''));
  const shift = scale + Number(match[4] || 0) - (match[3] || '').length;
  if (shift >= 0) units *= 10n ** BigInt(shift);
  else { const divisor = 10n ** BigInt(-shift); units = units / divisor + (units % divisor * 2n >= divisor ? 1n : 0n); }
  if (units >= 10n ** BigInt(precision)) throw new RangeError('Decimal exceeds source precision');
  const digits = units.toString().padStart(scale + 1, '0');
  return `${sign < 0n && units ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
function integer(value) {
  if (value === null || value === undefined) return null;
  if (!/^[+-]?\d+$/.test(String(value)) || !Number.isInteger(Number(value))
    || Number(value) < -2147483648 || Number(value) > 2147483647) throw new TypeError('Expected source integer');
  return Number(value);
}
function databaseInstant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value.replace(/(\.\d{3})\d{3}Z$/, '$1Z')) throw new TypeError('Explicit UTC databaseTime required');
  return value;
}
const reviewed = status => ['generated_ready', 'short_ready'].includes(status);
const approved = status => ['manual_locked', 'generated_ready', 'short_ready', 'stale'].includes(status);
const nullable = value => value ?? null;

export function mergeCatalogMaintenanceUpsert(existing, incoming, { sourceFactsHash, databaseTime }) {
  const now = databaseInstant(databaseTime);
  if (!incoming || typeof incoming.id !== 'string' || !incoming.id || existing && existing.id !== incoming.id
    || typeof incoming.title !== 'string' || typeof incoming.affiliateUrl !== 'string'
    || typeof incoming.currency !== 'string' || typeof incoming.isActive !== 'boolean'
    || incoming.price === null || incoming.price === undefined
    || !Array.isArray(incoming.humorTags) || Array.from(incoming.humorTags).some((_, index) => !(index in incoming.humorTags))
    || sourceFactsHash !== null && typeof sourceFactsHash !== 'string') throw new TypeError('Invalid maintenance input');
  let embedding = null;
  if (Array.isArray(incoming.embedding) && incoming.embedding.length) {
    if (incoming.embedding.length !== 1536 || Array.from(incoming.embedding).some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new TypeError('Expected 1536 finite vector elements');
    // The existing parameter serializer joins numbers to text first (-0 becomes 0).
    embedding = incoming.embedding.map(value => Math.fround(Number(String(value))));
    if (embedding.some(value => !Number.isFinite(value))) throw new RangeError('Vector exceeds float32');
  }
  const verified = incoming.remotelyVerified !== false;
  const status = incoming.editorialStatus || 'pending';
  const next = {
    id: incoming.id, title: incoming.title, price: decimal(incoming.price, 10, 2), currency: incoming.currency,
    imageUrl: nullable(incoming.imageUrl), affiliateUrl: incoming.affiliateUrl, source: incoming.source || 'amazon',
    sourceQuery: nullable(incoming.sourceQuery), humorTags: incoming.humorTags.map(String),
    punnyTitle: incoming.punnyTitle || null, wittyDescription: incoming.wittyDescription || null,
    qualityScore: decimal(incoming.qualityScore, 5, 4), rating: decimal(incoming.rating || null, 3, 2),
    reviewCount: integer(incoming.reviewCount || null), isActive: incoming.isActive, embedding,
    editorialWriteup: incoming.editorialWriteup || null,
    sourceFacts: JSON.parse(JSON.stringify(incoming.sourceFacts || {})), sourceFactsHash,
    editorialSourceHash: incoming.editorialSourceHash || (status === 'manual_locked' ? sourceFactsHash : null),
    availabilityStatus: incoming.availabilityStatus || null, availabilityCheckedAt: verified ? now : null,
    editorialStatus: status, editorialQualityScore: decimal(incoming.editorialQualityScore || null, 5, 4),
    editorialModel: incoming.editorialModel || null, editorialPromptVersion: incoming.editorialPromptVersion || null,
    editorialGeneratedAt: incoming.editorialGeneratedAt || null, editorialBlockReason: incoming.editorialBlockReason || null,
    duplicateOfProductId: incoming.duplicateOfProductId || null,
    contentUpdatedAt: approved(status) && status !== 'stale' ? now : null,
    lastVerifiedAt: verified ? now : null, createdAt: now, updatedAt: now,
  };
  if (!existing) return { inserted: true, product: structuredClone(next) };
  const old = structuredClone(existing);
  const product = { ...old, ...next, createdAt: nullable(old.createdAt) };
  for (const key of ['punnyTitle','wittyDescription','embedding','sourceFacts','sourceFactsHash','availabilityStatus','availabilityCheckedAt'])
    product[key] = next[key] ?? nullable(old[key]);
  if (old.editorialStatus === 'short_ready' && !reviewed(status)) product.wittyDescription = nullable(old.wittyDescription);
  product.editorialWriteup = old.editorialStatus === 'manual_locked' ? nullable(old.editorialWriteup)
    : status === 'generated_ready' && next.editorialWriteup !== null ? next.editorialWriteup
    : ['generated_ready','short_ready','stale'].includes(old.editorialStatus) ? nullable(old.editorialWriteup)
    : ['pending','needs_review'].includes(status) && next.editorialWriteup !== null ? next.editorialWriteup : nullable(old.editorialWriteup);
  product.editorialSourceHash = old.editorialStatus === 'manual_locked' ? old.editorialSourceHash ?? next.editorialSourceHash
    : reviewed(status) ? next.editorialSourceHash
    : ['generated_ready','short_ready','stale'].includes(old.editorialStatus) ? nullable(old.editorialSourceHash)
    : ['pending','needs_review'].includes(status) ? next.editorialSourceHash : nullable(old.editorialSourceHash);
  product.editorialStatus = old.editorialStatus === 'manual_locked' ? old.editorialStatus
    : reviewed(status) ? status
    : reviewed(old.editorialStatus) && nullable(old.editorialSourceHash) !== nullable(next.sourceFactsHash) ? 'stale'
    : reviewed(old.editorialStatus) ? old.editorialStatus
    : old.editorialStatus === 'stale' && ['pending','needs_review'].includes(status) ? 'stale'
    : ['pending','needs_review','blocked','duplicate','stale'].includes(status) ? status : old.editorialStatus;
  for (const key of ['editorialQualityScore','editorialModel','editorialPromptVersion','editorialGeneratedAt']) {
    const previous = key === 'editorialQualityScore' ? decimal(old[key], 5, 4) : nullable(old[key]);
    product[key] = approved(old.editorialStatus) && !reviewed(status) ? previous : next[key] ?? previous;
  }
  product.editorialBlockReason = old.editorialStatus === 'manual_locked' ? nullable(old.editorialBlockReason)
    : reviewed(status) ? null : next.editorialBlockReason ?? nullable(old.editorialBlockReason);
  product.duplicateOfProductId = next.duplicateOfProductId ?? nullable(old.duplicateOfProductId);
  product.contentUpdatedAt = reviewed(status) && (next.editorialWriteup !== nullable(old.editorialWriteup)
    || next.wittyDescription !== nullable(old.wittyDescription)) ? now : nullable(old.contentUpdatedAt);
  product.lastVerifiedAt = verified ? now : nullable(old.lastVerifiedAt);
  if (!reviewed(status) && !sameProductTitle(old.title,next.title)) {
    product.wittyDescription = refreshedShortCopy(old,next.title);
    product.punnyTitle = null;
    product.humorTags = [];
    // Original article/base/history stay retained. Stale copy is a review hint,
    // not a reason to deactivate a catalog identity or remove its native vector.
    if(product.editorialStatus!=='manual_locked')product.editorialStatus='stale';
  }
  return { inserted: false, product: structuredClone(product) };
}
