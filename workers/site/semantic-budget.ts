import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import type { SemanticBudgetScope, SiteEnv } from './bindings.ts';

// Historical receipt/capture compatibility only. Live search and its D1 adapter
// no longer import this module or reserve daily request/token budgets.

const MAX_REQUESTS = 100_000;
const MAX_TOKENS = 100_000_000;
const TOKEN_OVERHEAD = 16;

function positiveInteger(value: unknown, maximum: number): number | undefined {
  if (typeof value !== 'string' || !/^[1-9]\d{0,8}$/.test(value)) return;
  const parsed = Number(value);
  return parsed <= maximum ? parsed : undefined;
}

export function semanticBudgetConfig(env: Pick<SiteEnv, 'ENVIRONMENT' | 'SEMANTIC_SEARCH_ENABLED'
  | 'SEMANTIC_SEARCH_DAILY_REQUEST_CAP' | 'SEMANTIC_SEARCH_DAILY_TOKEN_CAP'>, scope: SemanticBudgetScope | undefined) {
  if (!scope || !['staging', 'production'].includes(scope.environment) || env.ENVIRONMENT !== scope.environment
    || typeof scope.index !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(scope.index)
    || env.SEMANTIC_SEARCH_ENABLED !== 'true') return;
  const requests = positiveInteger(env.SEMANTIC_SEARCH_DAILY_REQUEST_CAP, MAX_REQUESTS);
  const tokens = positiveInteger(env.SEMANTIC_SEARCH_DAILY_TOKEN_CAP, MAX_TOKENS);
  if (requests && tokens) return { requests, tokens };
}

/** text-embedding-3-small uses cl100k_base byte BPE. The exact normalized query is
 * the whole text-only input (no prompt/template). Each token consumes >=1 UTF-8
 * byte; add modest fixed overhead rather than using an average words/token ratio.
 * This is a conservative local allocation, NOT a provider dollar-billing limit.
 * https://developers.openai.com/api/docs/guides/embeddings
 * https://developers.openai.com/cookbook/examples/how_to_count_tokens_with_tiktoken
 */
export function semanticTokenUpperBound(query: string): number {
  return new TextEncoder().encode(query).byteLength + TOKEN_OVERHEAD;
}

/** One atomic reservation covers at most one embedding and one Vectorize query.
 * D1's UTC execution clock, not client/isolate time, owns the period. Fixed caps
 * must match the day's first allocation; lowering/mixed configs fail closed.
 * Lost responses/timeouts are never refunded or retried. Aggregate history only.
 */
export async function reserveSemanticSearch(db: CatalogD1, scope: SemanticBudgetScope, env: SiteEnv, tokenUpperBound: number): Promise<boolean> {
  const caps = semanticBudgetConfig(env, scope);
  if (!caps || !Number.isInteger(tokenUpperBound) || tokenUpperBound < 1 || tokenUpperBound > 800 + TOKEN_OVERHEAD) return false;
  try {
    const unowned="NOT EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE phase!='idle')";
    // Indexed cleanup is bounded even after a long idle period; never delete the current day.
    await db.prepare(`DELETE FROM semantic_search_budgets WHERE rowid IN (
      SELECT rowid FROM semantic_search_budgets WHERE utc_day<date('now','-30 days') ORDER BY utc_day LIMIT 32)
      AND ${unowned}`).run();
    const result = await db.prepare(`INSERT INTO semantic_search_budgets
      (environment,index_scope,utc_day,requests_reserved,tokens_reserved,request_cap,token_cap)
      SELECT ?,?,date('now'),1,?,?,? WHERE ?<=? AND ${unowned}
      ON CONFLICT(environment,index_scope,utc_day) DO UPDATE SET
        requests_reserved=requests_reserved+1,tokens_reserved=tokens_reserved+excluded.tokens_reserved
      WHERE request_cap=excluded.request_cap AND token_cap=excluded.token_cap
        AND requests_reserved<request_cap AND tokens_reserved<=token_cap-excluded.tokens_reserved AND ${unowned}`)
      .bind(scope.environment, scope.index, tokenUpperBound, caps.requests, caps.tokens, tokenUpperBound, caps.tokens).run() as {
        success?: boolean; meta?: { changes?: number };
      };
    // Unknown/failed write receipts cannot authorize provider calls, even if the write committed.
    return result.success === true && result.meta?.changes === 1;
  } catch { return false; }
}
