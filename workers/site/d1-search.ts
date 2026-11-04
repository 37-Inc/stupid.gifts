import { appendSearchDiagnostic } from '../../lib/catalog/storage/d1.ts';
import { getRevisionProductsByPublicIds, keywordSearchRevision } from '../../lib/catalog/d1.ts';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import type { SearchAdapters, SiteEnv } from './bindings.ts';

export interface CatalogSiteEnv extends SiteEnv {
  DB: CatalogD1;
}

/** Adapter only: catalog validation, indexed SQL and batch bounds live in lib/catalog. */
export const d1SearchAdapters: SearchAdapters<CatalogSiteEnv> = {
  storage: (env) => ({
    byPublicIds: (ids, now, revision) => getRevisionProductsByPublicIds(env.DB, ids, now, revision),
    keyword: (query, limit, now, revision) => keywordSearchRevision(env.DB, query, limit, now, revision),
  }),
  diagnostic: (event, env, now) => appendSearchDiagnostic(env.DB, event, now),
};
