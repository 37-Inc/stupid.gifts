/** First-party only. Never add these observations to the GA4/PostHog contract. */
export interface SearchDemandObservation {
  schemaVersion: 1;
  id: string; // Random per-search nonce, not a visitor or session identifier.
  topic: string;
  outcome: 'results' | 'unavailable';
  resultCount: number | null; // Results actually shown, not total catalog matches.
  selectedRank: number | null; // First selected result, one-based.
}

/** Conservative suppression, not a guarantee that arbitrary text contains no PII. */
export function searchDemandTopic(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 200) return null;
  const text = value.normalize('NFKC').toLowerCase().trim();
  if (/[\u0000-\u001f\u007f@<>={}\\/]/.test(text)
    || /\b[\p{L}\p{N}-]+\.[\p{L}]{2,}\b/u.test(text)
    || /\d{4}|(?:\d[^\p{L}\p{N}]*){7}/u.test(text)
    || /\b(?:password|ssn|social security|e-?mail|phone number|home address)\b/u.test(text)) return null;
  const topic = text.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
  return topic.length >= 2 && topic.length <= 80 && topic.split(' ').length <= 12
    && /\p{L}/u.test(topic) ? topic : null;
}

export function isSearchDemandObservation(value: unknown): value is SearchDemandObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as SearchDemandObservation;
  return Object.keys(row).sort().join(',') === 'id,outcome,resultCount,schemaVersion,selectedRank,topic'
    && row.schemaVersion === 1 && typeof row.id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.id)
    && searchDemandTopic(row.topic) === row.topic
    && (row.outcome === 'unavailable' ? row.resultCount === null && row.selectedRank === null
      : row.outcome === 'results' && Number.isInteger(row.resultCount)
        && row.resultCount! >= 0 && row.resultCount! <= 36
        && (row.selectedRank === null || Number.isInteger(row.selectedRank)
          && row.selectedRank >= 1 && row.selectedRank <= row.resultCount!));
}
