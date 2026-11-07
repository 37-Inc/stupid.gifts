import { isPurchasableAvailability } from '../../lib/gift-slugs.ts';

const DAY = 86_400_000;
const ASIN = /^[A-Z0-9]{10}$/;
export const FRESHNESS_POLICY = Object.freeze({
  version: 'due-work-v1', hotDays: 1, quietDays: 35, unavailableDays: 7, photoLeadHours: 18,
} as const);

export interface FreshnessProduct {
  id: string; source: string; isActive: boolean; publiclyCleared: boolean;
  duplicateOfProductId?: string | null; availabilityStatus?: string | null;
  availabilityCheckedAt?: string | null; photoExpiresAt?: string | null;
}
export interface FreshnessSelection {
  exposedIds?: readonly string[]; clickedIds?: readonly string[];
  promotedIds?: readonly string[]; brokenPhotoIds?: readonly string[]; photosOnly?: boolean;
}
export type FreshnessReason = 'photo_broken' | 'photo_due' | 'hot_stock_due'
  | 'legacy_availability_unknown' | 'unavailable_recheck' | 'availability_unknown' | 'catalog_rotation';
export interface FreshnessPlan {
  policy: typeof FRESHNESS_POLICY; observedAt: string; eligibleCount: number;
  neededCount: number; unknownAvailabilityCount: number;
  entries: Array<{ id: string; dueAt: string | null; reasons: FreshnessReason[] }>;
}
const priorities: Record<FreshnessReason, number> = {
  photo_broken: 0, photo_due: 0, hot_stock_due: 1, legacy_availability_unknown: 2,
  unavailable_recheck: 3, availability_unknown: 4, catalog_rotation: 5,
};
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !value.endsWith('Z')) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/** Read-only plan over the caller's captured clearance pool. No batch is
 * dispatched or capped here: the coordinator pins these exact IDs/chunks in a
 * new run config before fetching. A label/date is never stockout evidence. */
export function planProductFreshness(products: readonly FreshnessProduct[], observedAt: string,
  selection: FreshnessSelection = {}): FreshnessPlan {
  const now = instant(observedAt);
  if (now === null || new Date(now).toISOString() !== observedAt
    || selection.photosOnly !== undefined && typeof selection.photosOnly !== 'boolean')
    throw new Error('freshness_selection_invalid');
  const ids = (values: readonly string[] = []) => {
    if (!Array.isArray(values) || values.some(id => typeof id !== 'string' || !ASIN.test(id)))
      throw new Error('freshness_selection_invalid');
    return new Set(values);
  };
  const hot = new Set([...ids(selection.exposedIds), ...ids(selection.clickedIds), ...ids(selection.promotedIds)]);
  const broken = ids(selection.brokenPhotoIds), seen = new Set<string>();
  const eligible = products.filter(p => p.publiclyCleared && p.source === 'amazon'
    && p.isActive && !p.duplicateOfProductId && ASIN.test(p.id));
  let unknownAvailabilityCount = 0;
  const entries: FreshnessPlan['entries'] = [];
  for (const p of eligible) {
    if (seen.has(p.id)) throw new Error('freshness_duplicate_identity');
    seen.add(p.id);
    const rawChecked = instant(p.availabilityCheckedAt);
    // Future or missing observations cannot postpone a real verification.
    const checked = rawChecked !== null && rawChecked <= now ? rawChecked : null;
    const unavailable = ['OUT_OF_STOCK', 'UNAVAILABLE'].includes(String(p.availabilityStatus));
    const purchasable = isPurchasableAvailability(p.availabilityStatus || undefined);
    if (checked === null || !unavailable && !purchasable) unknownAvailabilityCount++;
    const reasons: FreshnessReason[] = [], dates: Array<number | null> = [];
    const add = (reason: FreshnessReason, due: number | null) => {
      if (due === null || due <= now) { reasons.push(reason); dates.push(due); }
    };
    if (broken.has(p.id)) add('photo_broken', null);
    const photoExpiry = instant(p.photoExpiresAt);
    if (photoExpiry !== null) add('photo_due', photoExpiry - FRESHNESS_POLICY.photoLeadHours * 3_600_000);
    if (!selection.photosOnly) {
      if (unavailable) add(checked === null ? 'legacy_availability_unknown' : 'unavailable_recheck',
        checked === null ? null : checked + FRESHNESS_POLICY.unavailableDays * DAY);
      else if (checked === null || !purchasable)
        add('availability_unknown', checked === null ? null : checked + FRESHNESS_POLICY.hotDays * DAY);
      else add(hot.has(p.id) ? 'hot_stock_due' : 'catalog_rotation',
        checked + (hot.has(p.id) ? FRESHNESS_POLICY.hotDays : FRESHNESS_POLICY.quietDays) * DAY);
    }
    if (reasons.length) entries.push({ id: p.id,
      dueAt: dates.includes(null) ? null : new Date(Math.min(...dates as number[])).toISOString(), reasons });
  }
  entries.sort((a, b) => Math.min(...a.reasons.map(r => priorities[r])) - Math.min(...b.reasons.map(r => priorities[r]))
    || (a.dueAt === null ? b.dueAt === null ? 0 : -1 : b.dueAt === null ? 1 : a.dueAt.localeCompare(b.dueAt))
    || a.id.localeCompare(b.id));
  return { policy: FRESHNESS_POLICY, observedAt, eligibleCount: eligible.length,
    neededCount: entries.length, unknownAvailabilityCount, entries };
}
