import type { PublicCatalogProduct } from '../../lib/catalog/types.ts';
import { catalogDeadline, persistentPublicProduct, resolvePublicProduct } from '../../lib/catalog/display.ts';
import type { ProductSearchResult } from '../../lib/types.ts';
import { isCatalogDisplayEligibleProduct, suppressNearDuplicateProducts } from '../../lib/db/product-scoring.ts';
import type { SearchAdapters, SemanticBudgetScope, SiteEnv } from './bindings.ts';
import { catalogSearchTerms } from '../../lib/catalog/search-terms.ts';
import { DERIVED_SEARCH_PROFILE, normalizeSemanticPrefix } from '../../lib/catalog/semantic-profile.ts';
import type { DerivedSearchProfile } from '../../lib/catalog/semantic-profile.ts';
import type { DerivedSemanticSearch } from './derived-search.ts';
import { canonicalJson } from '../../lib/catalog/canonical-json.ts';
import { productPresentation } from '../../lib/catalog/presentation.ts';
import { rankHybridResults } from '../../lib/catalog/hybrid-ranking.ts';
import type { Merchandising } from '../../lib/catalog/merchandising.ts';
import { productTitleView } from '../../lib/catalog/merchandising.ts';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIMENSIONS = 1536;
const CACHE_MS = 5 * 60_000;
const MAX_STATE_ENTRIES = 256;
type SearchResult = ProductSearchResult & PublicCatalogProduct;

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
}

export async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Reject promptly even for non-abortable bindings. Never retry paid calls. */
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('provider_timeout')); }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function openAIEmbedding(query: string, env: SiteEnv, signal: AbortSignal, profile?: DerivedSearchProfile): Promise<number[]> {
  if (profile && canonicalJson(profile) !== canonicalJson(DERIVED_SEARCH_PROFILE)) throw new Error('embedding_profile_invalid');
  if (!env.OPENAI_API_KEY) throw new Error('embedding_unconfigured');
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: query, encoding_format: 'float' }),
  });
  // Do not log provider bodies, exception messages, query text or credentials.
  if (!response.ok) throw new Error('embedding_unavailable');
  if (Number(response.headers.get('content-length')) > 100_000) throw new Error('embedding_response_oversize');
  const body = await response.json() as { model?: string; data?: { embedding?: number[] }[] };
  const vector = body.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error('embedding_invalid');
  }
  if (profile && (body.model !== profile.model || body.data?.length !== 1)) throw new Error('embedding_model_invalid');
  return profile ? normalizeSemanticPrefix(vector, profile.dimensions) : vector;
}

function result(product: PublicCatalogProduct, similarity: number, matchType: 'semantic' | 'keyword'): SearchResult {
  // The catalog validator produces the public allowlist; never spread D1 rows.
  return {
    ...productPresentation(product),
    similarity,
    rankScore: similarity,
    matchType,
  };
}

function keywordSimilarity(product: PublicCatalogProduct, query: string): number {
  const needle = query.toLowerCase();
  if (product.title.toLowerCase().includes(needle)) return 0.74;
  if (product.description.toLowerCase().includes(needle)) return 0.68;
  if (product.humorTags?.join(' ').toLowerCase().includes(needle)) return 0.62;
  const terms = catalogSearchTerms(query);
  const coverage = (text: string) => terms.filter(term => text.toLowerCase().includes(term)).length / Math.max(1, terms.length);
  return 0.48 + coverage(product.title) * 0.28
    + coverage(product.humorTags?.join(' ') || '') * 0.1
    + coverage(product.description) * 0.06;
}

/** Small lexical tie-breaker keeps literal interests ahead of generic gift copy.
 * The fixed v3 profile's negative-query smoke cohort stays below0.4 cosine. */
function select(candidates: SearchResult[], limit: number, now: number,semanticDeadlines?:ReadonlyMap<string,number>): SearchResult[] {
  const ids = new Set<string>();
  const eligible = candidates.flatMap(candidate=>{
    const product=persistentPublicProduct(candidate)??resolvePublicProduct(candidate,now);
    if(!product)return[];
    // A permanent listing is not a renewed semantic/native freshness proof.
    if(candidate.matchType==='semantic'&&(semanticDeadlines?.get(candidate.publicId)??catalogDeadline(candidate.eligibleUntil))<=now)return[];
    return[{...result(product,candidate.similarity,candidate.matchType),rankScore:candidate.rankScore}];
  }).filter((product) => {
    if (ids.has(product.id) || !(product.eligibleUntil===null
      ? product.isActive&&product.qualityScore>=0&&product.qualityScore<=1&&product.imageUrl&&product.affiliateUrl
      : isCatalogDisplayEligibleProduct(product))) return false;
    ids.add(product.id);
    return true;
  });
  // Exact public-catalog duplicates are resolved before publication. Preserve
  // distinct cleared designs; fuzzy family suppression is for fresh suppliers.
  const finite = new Set(suppressNearDuplicateProducts(eligible.filter(product => product.eligibleUntil !== null), limit)
    .map(product => product.id));
  return eligible.filter(product => product.eligibleUntil === null || finite.has(product.id)).slice(0, limit);
}

/** Bounded per-isolate cache and alert-only request telemetry. */
export function createSearchHandler<Env extends SiteEnv>(options: {
  catalogRevision: string;
  adapters: SearchAdapters<Env>;
  now?: () => number;
  providerTimeoutMs?: number;
  rateLimit?: number;
  semanticBudgetScope?: SemanticBudgetScope;
  /** null explicitly fails closed on a malformed derived artifact, not to legacy semantic serving. */
  derivedSemantic?: DerivedSemanticSearch | null;
  merchandising?: Merchandising;
}) {
  const now = options.now || Date.now;
  const timeout = Math.max(10, Math.min(options.providerTimeoutMs ?? 1500, 3000));
  const cache = new Map<string, { until: number; keywords: SearchResult[]; semantic: SearchResult[];semanticDeadlines:ReadonlyMap<string,number> }>();
  const clients = new Map<string, { until: number; count: number }>();
  const maxRequests = Math.max(1, Math.min(options.rateLimit ?? 20, 60));
  const derived = options.derivedSemantic;
  const scope = options.semanticBudgetScope && Object.freeze({ ...options.semanticBudgetScope });
  const hybrid=(query:string,keywords:SearchResult[],semantic:SearchResult[],limit:number,deadlines:ReadonlyMap<string,number>)=>{
    const current=now();
    // Expired semantic proof must not swallow a valid same-ID lexical result
    // during identity merging. Filter each lane first, then fuse once.
    const lexical=select(keywords,240,current).map(p=>productTitleView(p,options.merchandising??{})),
      vectors=select(semantic,240,current,deadlines).map(p=>productTitleView(p,options.merchandising??{}));
    return select(rankHybridResults(query,lexical,vectors,options.merchandising,current),limit,current,deadlines);
  };

  return async (request: Request, env: Env): Promise<Response> => {
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' });
    if (new TextEncoder().encode(request.url).byteLength > 2048 || request.body) return json({ error: 'Request too large' }, 413);
    const url = new URL(request.url);
    const query = (url.searchParams.get('q') || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (query.length > 200) return json({ error: 'Query too long' }, 400);
    if (query.length < 2) return json({ results: [], searchId: null });
    const parsed = Number.parseInt(url.searchParams.get('limit') || '36', 10);
    const limit = Number.isFinite(parsed) ? Math.max(1, Math.min(60, parsed)) : 36;
    const startedAt = now();
    // IP is hashed in memory only and never written into diagnostic records.
    const clientKey = await sha256(request.headers.get('CF-Connecting-IP') || 'unknown');
    for (const [key, value] of clients) if (value.until <= startedAt) clients.delete(key);
    let client = clients.get(clientKey);
    if (!client) {
      // Bound telemetry memory, not the number of visitors allowed to search.
      if (clients.size >= MAX_STATE_ENTRIES) clients.delete(clients.keys().next().value!);
      client = { until: startedAt + 60_000, count: 0 };
      clients.set(clientKey, client);
    }
    if (++client.count === maxRequests+1) console.warn('search_rate_above_estimate');
    const queryHash = await sha256(query.toLowerCase());
    // The kill switch changes the key so cached semantic responses are not reused.
    // Usage monitoring must not gate search or require a D1 budget write.
    const vectorBinding = derived ? env.SEMANTIC_VECTORIZE : env.VECTORIZE;
    const semantic = Boolean(derived !== null && scope && env.ENVIRONMENT === scope.environment
      && ['staging', 'production'].includes(scope.environment) && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(scope.index)
      && env.SEMANTIC_SEARCH_ENABLED === 'true' && vectorBinding && (options.adapters.embed || env.OPENAI_API_KEY));
    const key = `${options.catalogRevision}:${derived?.profile.id ?? EMBEDDING_MODEL}:${semantic}:${limit}:${queryHash}`;
    const cached = cache.get(key);
    // Hashing above can cross a product deadline. Check the current clock and
    // reselect immediately before serialization, just as for uncached responses.
    if (cached && cached.until > now()) {
      // Re-rank all saved candidates, not only yesterday's winners: a campaign
      // ending during cache lifetime loses its preference without another query.
      const fresh = hybrid(query,cached.keywords,cached.semantic,limit,cached.semanticDeadlines);
      return json({ searchId: null, results: fresh });
    }
    cache.delete(key);

    try {
      const storage = options.adapters.storage(env);
      const candidateLimit = Math.min(240, limit * 4);
      const keywordLimit=semantic?Math.max(limit,candidateLimit-Math.min(50,candidateLimit)):candidateLimit;
      const keywordTask=bounded(()=>storage.keyword(query,keywordLimit,new Date(now()),options.catalogRevision),timeout)
        .then(products=>({ok:true,products}),()=>({ok:false,products:[] as PublicCatalogProduct[]}));
      let candidates: SearchResult[] = [];
      let semanticAvailable = false;
      if (semantic) {
        try {
          const matches = await bounded(async (signal) => {
            const vector = await (options.adapters.embed || openAIEmbedding)(query, env, signal, derived?.profile);
            // A non-abortable/custom embedding can settle after fallback. It
            // must not dispatch another provider request in the background.
            if (signal.aborted) throw new Error('provider_timeout');
            if (vector.length !== (derived?.profile.dimensions ?? EMBEDDING_DIMENSIONS) || !vector.every(Number.isFinite)
              || derived && Math.abs(Math.hypot(...vector) - 1) > 1e-6) throw new Error('embedding_invalid');
            return vectorBinding!.query(vector, {
              // Full metadata has a 50-match limit; metadata-free legacy queries allow100.
              topK: Math.min(derived ? 50 : 100, candidateLimit), returnValues: false, returnMetadata: derived ? 'all' : 'none',
              // Derived search has its own profile-specific index. Validate
              // identity/metadata locally; no extra provider metadata-index setup.
              ...(derived ? {} : { filter: { catalogRevision: options.catalogRevision, eligible: true } }),
            });
          }, timeout);
          if (derived) {
            const verified = await bounded(() => derived.resolve(matches.matches.slice(0, Math.min(100, candidateLimit))), timeout);
            candidates = verified.filter(({ score }) => score >= 0.4)
              .map(({ product, score }) => result(product, score, 'semantic'))
              .sort((a,b) => b.similarity-a.similarity || a.id.localeCompare(b.id));
            semanticAvailable = true;
          } else {
            const scores = new Map<string, number>();
            for (const match of matches.matches.slice(0, Math.min(100, candidateLimit))) {
              if (typeof match.id === 'string' && match.id.length <= 100 && Number.isFinite(match.score)) scores.set(match.id, Math.max(-1, Math.min(1, match.score)));
            }
            if (scores.size) {
              const products = await bounded(() => storage.byPublicIds([...scores.keys()], new Date(now()), options.catalogRevision), timeout);
              candidates = products.filter((product) => scores.has(product.publicId))
                .map((product) => result(product, scores.get(product.publicId)!, 'semantic'))
                .sort((a, b) => b.rankScore - a.rankScore || a.id.localeCompare(b.id));
            }
            // A vector response is not a usable search lane until current
            // product resolution succeeds. If both stores fail, return an
            // actual unavailable response rather than a false zero-result hit.
            semanticAvailable = true;
          }
        } catch {
          // A provider failure only changes search mode. No raw error/query logs.
        }
      }
      const semanticDeadlines=new Map(candidates.map(product=>[product.publicId,catalogDeadline(product.eligibleUntil)]));
      const keywordResponse=await keywordTask;
      if(!keywordResponse.ok&&!semanticAvailable)throw new Error('search_unavailable');
      const keywords=keywordResponse.products.slice(0,keywordLimit).map(p=>result(p,keywordSimilarity(p,query),'keyword'));
      let results = hybrid(query,keywords,candidates,limit,semanticDeadlines);
      // Recheck deadlines after all I/O, and cap cache at the earliest result expiry.
      results = select(results, limit, now(),semanticDeadlines);
      const until = Math.min(startedAt + CACHE_MS,
        ...candidates.filter(product=>product.matchType==='semantic').map(product=>catalogDeadline(product.eligibleUntil)),
        ...results.map(product=>catalogDeadline(product.eligibleUntil)));
      if (until > now()) {
        if (cache.size >= MAX_STATE_ENTRIES) cache.delete(cache.keys().next().value!);
        cache.set(key, { keywords, semantic:candidates, until,semanticDeadlines });
      }
      let searchId: string | null = null;
      if (options.adapters.diagnostic) {
        const id = crypto.randomUUID();
        try {
          await bounded(() => options.adapters.diagnostic!({
            id, queryHash, queryLength: query.length, resultCount: results.length,
            topSimilarity: results[0]?.similarity ?? null, matchType: results[0]?.matchType || 'none',
            outcome: results.length ? 'ok' : 'empty',
          }, env, new Date(now())), Math.min(100, timeout));
          searchId = id;
        } catch { /* Diagnostic failure cannot fail usable results. */ }
      }
      const fresh = select(results, limit, now(),semanticDeadlines);
      if (fresh.length !== results.length) cache.delete(key);
      results = fresh;
      return json({ searchId, results });
    } catch {
      return json({ error: 'Search unavailable' }, 503, { 'Retry-After': '30' });
    }
  };
}
