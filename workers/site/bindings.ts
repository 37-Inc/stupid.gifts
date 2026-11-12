import type { PublicCatalogProduct } from '../../lib/catalog/types.ts';
import type { SearchDiagnostic } from '../../lib/catalog/storage/d1.ts';
import type { DerivedSearchProfile } from '../../lib/catalog/semantic-profile.ts';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import type { ContentAdminAuthEnv } from './content-admin-auth.ts';

/** Small structural interfaces: no Node runtime or generated provider types. */
export interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

export interface VectorMatch { id: string; score: number; metadata?: Record<string, unknown> }
export interface VectorBinding {
  query(vector: number[], options: {
    topK: number;
    returnValues: false;
    returnMetadata: 'none' | 'all';
    filter?: Record<string, string | boolean>;
  }): Promise<{ matches: VectorMatch[] }>;
}

export interface SearchStorage {
  byPublicIds(ids: string[], now: Date, catalogRevision: string): Promise<PublicCatalogProduct[]>;
  keyword(query: string, limit: number, now: Date, catalogRevision: string): Promise<PublicCatalogProduct[]>;
}

/** Compiled deployment identity shared by all revisions/isolates using this index.
 * Never derive either field from a request, catalog revision or client identifier.
 * The historical name remains compatible with retained publication entries;
 * this is an environment/index scope, not a runtime spending budget.
 */
export interface SemanticBudgetScope { environment: 'staging' | 'production'; index: string }

export interface SiteEnv extends ContentAdminAuthEnv {
  /** Exact owner-approved workflow dispatch only; no merchant/model credentials. */
  CONTENT_ADMIN_DISPATCH_ENABLED?:string;
  GITHUB_CATALOG_DISPATCH_TOKEN?:string;
  ASSETS: AssetBinding;
  /** Optional first-party search observations; absent DB never prevents search. */
  DB?: CatalogD1;
  VECTORIZE?: VectorBinding;
  /** Optional derived index, never a replacement/relabel of the original native index. */
  SEMANTIC_VECTORIZE?: VectorBinding;
  OPENAI_API_KEY?: string;
  /** Semantic calls require explicit opt-in; keyword search remains available. */
  SEMANTIC_SEARCH_ENABLED?: string;
  /** Historical configuration only; live search ignores both former caps. */
  SEMANTIC_SEARCH_DAILY_REQUEST_CAP?: string;
  SEMANTIC_SEARCH_DAILY_TOKEN_CAP?: string;
  ENVIRONMENT?: string;
  STAGING_AUTH_SECRET?: string;
}

export interface SearchAdapters<Env extends SiteEnv = SiteEnv> {
  storage(env: Env): SearchStorage;
  diagnostic?(record: SearchDiagnostic, env: Env, now: Date): Promise<void>;
  embed?(query: string, env: Env, signal: AbortSignal, profile?: DerivedSearchProfile): Promise<number[]>;
}
