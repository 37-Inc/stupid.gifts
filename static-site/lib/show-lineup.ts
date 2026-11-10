const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** URL-only curation: no stored configuration, model call or catalog mutation. */
export function showLineupIds(search: string): string[] | null {
  const query = new URLSearchParams(search);
  if (!query.has('ids')) return null;
  const ids = (query.get('ids') ?? '').split(',').map(id => id.toLowerCase());
  if (query.getAll('ids').length !== 1 || !ids.length || ids.length > 6
    || new Set(ids).size !== ids.length || ids.some(id => !UUID.test(id))) throw new Error('Invalid lineup');
  return ids;
}

// Runs before the default grid is parsed, preventing an incorrect-picks flash.
export const SHOW_LINEUP_BOOTSTRAP = "if(new URLSearchParams(location.search).has('ids'))document.getElementById('main').dataset.customShow='true';";
