/** ID-only editorial presentation; never product existence or supplier rights. */
export interface HomepageEdition {
  schemaVersion: 1;
  day: string;
  anchors: string[];
  rotation: string[];
}

/** Invalid optional curation falls back before reserving a catalog run. */
export function readHomepageEdition(value: unknown): HomepageEdition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as HomepageEdition;
  if (Object.keys(v).sort().join(',') !== 'anchors,day,rotation,schemaVersion'
    || v.schemaVersion !== 1 || typeof v.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.day)
    || !Number.isFinite(Date.parse(v.day)) || new Date(v.day).toISOString().slice(0, 10) !== v.day
    || !Array.isArray(v.anchors) || v.anchors.length !== 6
    || !Array.isArray(v.rotation) || v.rotation.length !== 18) return null;
  const ids = [...v.anchors, ...v.rotation];
  if (ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(id))
    || new Set(ids).size !== ids.length) return null;
  return { schemaVersion: 1, day: v.day, anchors: [...v.anchors], rotation: [...v.rotation] };
}
