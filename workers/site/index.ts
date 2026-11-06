import type { CatalogAssetRoute, CatalogSnapshot, SiteAssetManifest } from '../../lib/catalog/types.ts';
import { catalogDeadline, persistentPublicProduct, resolvePublicProduct } from '../../lib/catalog/display.ts';
import type { SearchAdapters, SemanticBudgetScope, SiteEnv } from './bindings.ts';
import { prepareStaticFeed } from './feed.ts';
import { createSearchHandler, json, sha256 } from './search.ts';
import { snapshotKeywordSearch } from './snapshot-search.ts';
import { createDerivedSemanticSearch } from './derived-search.ts';
import type { DerivedSemanticSearch } from './derived-search.ts';
import { recordSearchDemand } from './search-demand.ts';
import { productPresentation } from '../../lib/catalog/presentation.ts';
import {readMerchandising} from '../../lib/catalog/merchandising.ts';

export type { SiteEnv, SearchAdapters, SearchStorage, SemanticBudgetScope } from './bindings.ts';
export interface SiteReleaseIdentity {
  release_id: string;
  code_sha: string;
  catalog_revision: string;
  catalog_snapshot_sha256: string;
  /** Build-derived hash of exact asset-manifest.json bytes; not a Vectorize visibility proof. */
  manifest_sha256: string;
}

const MAX_FEED_BODY = 64_000;
const TIMED_ROUTE = /^(?:\/$|\/h(?:[/.]|$)|\/gifts(?:\/|$)|\/gift-guides(?:\/|$)|\/howie(?:\/|$)|\/random-gift(?:[/.]|$)|\/catalog(?:[/.]|$)|\/data(?:\/|$)|\/sitemap(?:[/.]|$))/;
const RETIRED_ROUTE = /^\/(?:admin|auth|login|report|reports|bundles)(?:\/|$)|^\/gifts(?:\/?$|\.(?:html|txt)$|\/__next\.|\/page(?:[/.]|$))|^\/weird-gift-index(?:[/.]|$)|^\/safe\/index\.json$|^\/api\/(?:admin|auth|og|generate-bundle)(?:\/|$)/;
const PUBLIC_ASSET = /^(?:\/_next\/static\/|\/fonts\/|\/brand\/|\/illustrations\/)|^\/(?:images\/gift-placeholder\.svg|favicon\.ico|robots\.txt|[a-zA-Z0-9_-]+\.(?:png|webp|svg|jpg|jpeg|woff2?|ttf)|google[a-z0-9]+\.html|BingSiteAuth\.xml)$/;

function expiry(route: CatalogAssetRoute): number {
  return catalogDeadline(route.eligibleUntil);
}

// Presence is an explicit build-bound persistent variant; false still permits
// useful browsing, but never grants crawler indexability. Legacy safe pages
// have no flag and retain their existing unavailable/noindex behavior.
function hasPersistentVariant(route: CatalogAssetRoute): boolean {
  return typeof route.persistentIndexable === 'boolean';
}

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]!);
}
function verifiedReleaseIdentity(input: unknown, manifest: SiteAssetManifest, snapshotDigest: string | undefined): SiteReleaseIdentity | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  const value = input as Partial<SiteReleaseIdentity>;
  if (Object.keys(value).sort().join(',') !== 'catalog_revision,catalog_snapshot_sha256,code_sha,manifest_sha256,release_id'
    || typeof value.release_id !== 'string' || value.release_id !== manifest.releaseId
    || typeof value.catalog_revision !== 'string' || value.catalog_revision !== manifest.catalogRevision
    || typeof value.code_sha !== 'string' || !/^[a-f0-9]{40}$/.test(value.code_sha) || value.code_sha !== manifest.codeSha
    || typeof value.catalog_snapshot_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.catalog_snapshot_sha256) || value.catalog_snapshot_sha256 !== snapshotDigest
    || typeof value.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.manifest_sha256)) return;
  return Object.freeze({ release_id: value.release_id, code_sha: value.code_sha, catalog_revision: value.catalog_revision,
    catalog_snapshot_sha256: value.catalog_snapshot_sha256, manifest_sha256: value.manifest_sha256 });
}

function campaignSearch(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'gclid', 'gbraid', 'wbraid']) {
    const value = params.get(key);
    if (value && /^[a-zA-Z0-9._~:-]{1,200}$/.test(value)) kept.set(key, value);
  }
  return kept.size ? `?${kept}` : '';
}
function pageAliasSearch(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
    const value = params.get(key);
    if (value && /^[a-zA-Z0-9._~:-]{1,200}$/.test(value)) kept.set(key, value);
  }
  const q = params.get('q');
  if (q !== null && q.length <= 200 && !/[\u0000-\u001f\u007f]/.test(q)) kept.set('q', q);
  const page = params.get('page');
  if (page !== null && page.length <= 128 && /^\d+$/.test(page)) kept.set('page', page);
  return kept.size ? `?${kept}` : '';
}
function canonicalHostSearch(params: URLSearchParams): string {
  // Preserve the existing bounded URL attribution contract, not raw event data.
  const kept = new URLSearchParams(campaignSearch(params));
  const functional = new URLSearchParams(pageAliasSearch(params));
  for (const key of ['q', 'page']) {
    const value = functional.get(key);
    if (value !== null) kept.set(key, value);
  }
  return kept.size ? `?${kept}` : '';
}
async function boundedJson(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_FEED_BODY) throw new Error('too_large');
  const reader = request.body?.getReader();
  if (!reader) return {};
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_FEED_BODY) { await reader.cancel(); throw new Error('too_large'); }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return {}; }
}

/** Manifest and snapshot are compiled into the same immutable asset release. */
export function createSiteWorker<Env extends SiteEnv>(options: {
  manifest: SiteAssetManifest;
  snapshot: CatalogSnapshot;
  searchAdapters?: SearchAdapters<Env>;
  semanticBudgetScope?: SemanticBudgetScope;
  feedPlan?: unknown;
  /** Supplied only after build/verification binds exact manifest bytes; never hash the full manifest here. */
  releaseIdentity?: unknown;
  canonicalOrigin?: string;
  now?: () => number;
}) {
  const now = options.now || Date.now;
  const { manifest, snapshot } = options;
  const clearedImages = new Set(snapshot.products.flatMap(product => {
    const base = persistentPublicProduct(product);
    return base?.imageUrl.startsWith('/') && Object.hasOwn(manifest.checksums ?? {}, base.imageUrl) ? [base.imageUrl] : [];
  }));
  if (manifest.catalogRevision !== snapshot.catalogRevision) throw new Error('release_revision_mismatch');
  const routes = new Map(Object.entries(manifest.routes));
  const directAssets = new Map<string, CatalogAssetRoute>();
  const safeAssets = new Set<string>();
  for (const route of routes.values()) {
    directAssets.set(route.assetPath, route);
    safeAssets.add(route.safeAssetPath);
  }
  const redirects = new Map(snapshot.slugHistory.map((entry) => [`/gifts/${entry.slug}`, `/gifts/${entry.canonicalSlug}`]));
  const heldProductPaths = new Set(snapshot.heldProducts.map((product) => product.path));
  const snapshotDigest = 'catalogSnapshotSha256' in manifest && typeof manifest.catalogSnapshotSha256 === 'string' ? manifest.catalogSnapshotSha256 : undefined;
  const releaseIdentity = verifiedReleaseIdentity(options.releaseIdentity, manifest, snapshotDigest);
  const preparedFeed = prepareStaticFeed(snapshot, options.feedPlan, snapshotDigest);
  // Shared by checked-in and generated publication entries. A request may not
  // choose the canonical origin or turn a preview hostname into a public alias.
  const productionOrigin = options.canonicalOrigin === 'https://stupid.gifts'
    || options.canonicalOrigin === 'https://www.goose.gifts' ? options.canonicalOrigin : undefined;
  const productionHost = productionOrigin ? new URL(productionOrigin).hostname : undefined;
  const productionAlias = productionHost?.startsWith('www.') ? productionHost.slice(4) : productionHost ? `www.${productionHost}` : undefined;
  const merchandising=readMerchandising(manifest.merchandising)??{};
  const localKeyword = snapshotKeywordSearch(snapshot,merchandising);
  const adapters = options.searchAdapters;
  let derivedSemantic: DerivedSemanticSearch | null | undefined;
  if (Object.hasOwn(manifest, 'semanticCatalog')) {
    try { derivedSemantic = createDerivedSemanticSearch(snapshot, manifest.semanticCatalog); }
    catch { derivedSemantic = null; } // Invalid proof cannot open legacy semantic serving.
  }
  const search = adapters ? createSearchHandler({
    catalogRevision: manifest.catalogRevision, adapters: localKeyword ? {
      ...adapters, storage: env => ({ ...adapters.storage(env), keyword: localKeyword }),
      // Explicit GA4/PostHog search events already cover the public interaction.
      // Do not write a redundant D1 diagnostic for immutable keyword results.
      diagnostic: undefined,
    } : adapters, now, semanticBudgetScope: options.semanticBudgetScope, derivedSemantic,merchandising,
  }) : undefined;

  function finish(response: Response, env: Env, request: Request): Response {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Catalog-Revision', manifest.catalogRevision);
    if (env.ENVIRONMENT !== 'production') {
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      headers.set('Cache-Control', 'private, no-store');
      headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
      headers.set('CDN-Cache-Control', 'no-store');
      // Defense in depth: exported staging HTML must also omit analytics keys.
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: https://m.media-amazon.com https://images-na.ssl-images-amazon.com https://i.etsystatic.com; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'");
    }
    return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
  }

  async function notFound(request: Request, env: Env, decodedPath: string): Promise<Response> {
    const fallback = () => json({ error: 'Not found' }, 404);
    const url = new URL(request.url);
    const acceptsHtml = (request.headers.get('Accept') || '').split(',').some(entry => {
      const [type, ...parameters] = entry.trim().toLowerCase().split(';');
      const quality = parameters.find(value => value.trim().startsWith('q='));
      const q = quality === undefined ? 1 : Number(quality.trim().slice(2));
      return type === 'text/html' && Number.isFinite(q) && q > 0 && q <= 1;
    });
    const destination = request.headers.get('Sec-Fetch-Dest');
    if (!['GET', 'HEAD'].includes(request.method) || !acceptsHtml
      || destination && destination !== 'document'
      || request.headers.has('RSC') || request.headers.has('Next-Router-Prefetch')
      || /^\/(?:api|_next|fonts|og|brand|images|illustrations|catalog|data|safe)(?:\/|$)/.test(decodedPath)
      || /[\u0000-\u0020\u007f\\]/.test(decodedPath) || decodedPath.split('/').some(part => part.includes('.'))
      || env.ENVIRONMENT === 'production' && productionOrigin && url.origin !== productionOrigin
      || !/^[a-f0-9]{64}$/.test(manifest.checksums?.['/404.html'] || '')) return fallback();
    const target = new URL('/404.html', url);
    try {
      const response = await env.ASSETS.fetch(new Request(target, { method: 'GET' }));
      if (response.status !== 200 || !/^text\/html(?:;|$)/i.test(response.headers.get('Content-Type') || '')) return fallback();
      const headers = new Headers(response.headers);
      for (const name of ['Age', 'ETag', 'Last-Modified', 'Location']) headers.delete(name);
      for (const name of ['Cache-Control', 'Cloudflare-CDN-Cache-Control', 'CDN-Cache-Control']) headers.set(name, 'no-store');
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      return new Response(response.body, { status: 404, headers });
    } catch { return fallback(); }
  }

  async function asset(request: Request, env: Env, route: CatalogAssetRoute, forceSafe = false): Promise<Response> {
    const deadline = expiry(route);
    const safe = forceSafe || route.state === 'held' || !Number.isFinite(deadline) && deadline !== Infinity || deadline <= now();
    const url = new URL(request.url);
    url.pathname = safe ? route.safeAssetPath : route.assetPath;
    url.search = '';
    // Do not forward conditional headers that could turn an expired asset into 304.
    const response = await env.ASSETS.fetch(new Request(url, { method: 'GET' }));
    if (!response.ok) return json({ error: 'Page unavailable' }, 503);
    // An asset lookup can cross its deadline; never return its now-expired body.
    if (!safe && deadline <= now()) return asset(request, env, route, true);
    const headers = new Headers(response.headers);
    const seconds = safe ? 0 : Math.max(0, Math.min(300, Math.floor((deadline - now()) / 1000)));
    const cache = safe ? 'no-store' : `public, max-age=${seconds}, s-maxage=${seconds}, must-revalidate`;
    headers.set('Cache-Control', cache);
    headers.set('Cloudflare-CDN-Cache-Control', cache);
    headers.set('CDN-Cache-Control', cache);
    headers.delete('Age');
    if (route.state === 'held' || (safe ? route.persistentIndexable !== true : route.indexable === false)
      || new URL(request.url).searchParams.has('q')) headers.set('X-Robots-Tag', 'noindex, follow');
    return new Response(response.body, { status: response.status, headers });
  }

  function sitemap(request: Request): Response {
    const origin = options.canonicalOrigin || new URL(request.url).origin;
    const at = now();
    const entries = [...routes.entries()].filter(([path, route]) => (
      route.state === 'ready' && (expiry(route) > at ? route.indexable !== false : route.persistentIndexable === true)
      && !path.includes('.') && !path.startsWith('/data/') && !RETIRED_ROUTE.test(path)
      && !path.startsWith('/catalog/') && !path.startsWith('/_') && (path === '/' || !path.endsWith('/'))
    ));
    const deadlines = entries.map(([, route]) => expiry(route) > at ? expiry(route) : Infinity);
    const seconds = Math.max(0, Math.min(300, Math.floor((Math.min(...deadlines) - now()) / 1000)));
    const body = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(([path]) => `<url><loc>${escapeXml(new URL(path, origin).href)}</loc></url>`).join('')}</urlset>`;
    return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': `public, max-age=${seconds}, s-maxage=${seconds}, must-revalidate` } });
  }

  async function feed(request: Request): Promise<Response> {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, { Allow: 'POST' });
    let body: { seed?: unknown; limit?: unknown; excludeIds?: unknown };
    try {
      const parsed = await boundedJson(request);
      body = parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return json({ error: 'Request too large' }, 413); }
    const guard = routes.get('/');
    const available = () => guard && guard.state !== 'held' && (expiry(guard) > now() || hasPersistentVariant(guard));
    if (!preparedFeed || !available()) return json({ error: 'Catalog temporarily unavailable' }, 503);
    const seed = (typeof body.seed === 'string' ? body.seed : 'goose-gifts').slice(0, 80);
    const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) ? Math.max(1, Math.min(36, Math.floor(body.limit))) : 24;
    const excluded = new Set((Array.isArray(body.excludeIds) ? body.excludeIds : []).filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 100).slice(0, 1200));
    const selection = preparedFeed.select(seed, limit, excluded, now());
    if (!selection || !available()) return json({ error: 'Catalog temporarily unavailable' }, 503);
    const products = selection.products.flatMap(product => {
      const resolved = resolvePublicProduct(product, now());return resolved ? [productPresentation(resolved)] : [];
    });
    if (selection.products.length&&!products.length) return json({ error: 'Catalog temporarily unavailable' }, 503);
    return json({ products, hasMore: selection.hasMore });
  }

  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const respond = (response: Response) => finish(response, env, request);
      try {
        if (env.ENVIRONMENT !== 'production') {
          if (!env.STAGING_AUTH_SECRET || env.STAGING_AUTH_SECRET.length < 16) return respond(json({ error: 'Staging protection unavailable' }, 503));
          const expected = await sha256(`Basic ${btoa(`staging:${env.STAGING_AUTH_SECRET}`)}`);
          const actual = await sha256(request.headers.get('Authorization') || '');
          let difference = 0;
          for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
          if (difference) return respond(json({ error: 'Authentication required' }, 401, { 'WWW-Authenticate': 'Basic realm="Stupid Gifts staging", charset="UTF-8"' }));
        }
        const url = new URL(request.url);
        const path = url.pathname;
        // Never let ASSETS decode separators/traversal differently from this dispatcher.
        if (/%(?:2f|5c|25)/i.test(path)) return respond(json({ error: 'Not found' }, 404));
        let decodedPath: string;
        try { decodedPath = decodeURIComponent(path); }
        catch { return respond(json({ error: 'Not found' }, 404)); }
        if (RETIRED_ROUTE.test(decodedPath)) return respond(await notFound(request, env, decodedPath));
        if (env.ENVIRONMENT === 'production' && productionHost) {
          if (![productionHost, productionAlias].includes(url.host)) return respond(json({ error: 'Not found' }, 404));
          if (url.origin !== productionOrigin) {
            // Reject retired/unknown paths before normalizing the host. Never
            // turn a historical bundle URL or unsafe asset alias into a redirect.
            if (RETIRED_ROUTE.test(path)
              || (decodedPath === '/random-gift' || decodedPath === '/random-gift/') && url.searchParams.has('gift'))
              return respond(json({ error: 'Not found' }, 404));
            if (!['GET', 'HEAD'].includes(request.method)) return respond(json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' }));
            const pagePath = path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path;
            const page = routes.get(pagePath);
            const knownPage = pagePath === '/privacy' || pagePath === '/search'
              || page?.assetPath === `${pagePath === '/' ? '/index' : pagePath}.html`
              || page?.state === 'held' && heldProductPaths.has(pagePath);
            const knownPath = knownPage || routes.has(path) || directAssets.has(path) || safeAssets.has(path)
              || routes.has(decodedPath) || directAssets.has(decodedPath) || redirects.has(path)
              || ['/sitemap.xml', '/sitemap/0.xml', '/.well-known/catalog-release.json', '/api/search-products'].includes(path)
              || PUBLIC_ASSET.test(path) || clearedImages.has(decodedPath);
            if (!knownPath)
              return respond(json({ error: 'Not found' }, 404));
            return respond(new Response(null, { status: 308, headers: {
              Location: `${productionOrigin}${path}${canonicalHostSearch(url.searchParams)}`, 'Cache-Control': 'no-store',
            } }));
          }
        }
        if (path === '/.well-known/catalog-release.json') {
          if (!['GET', 'HEAD'].includes(request.method)) return respond(json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' }));
          if (!releaseIdentity) return respond(json({ error: 'Release identity unavailable' }, 503));
          return respond(json(releaseIdentity));
        }
        if (path === '/api/search-products') return respond(search ? await search(request, env) : json({ error: 'Search unavailable' }, 503));
        if (path === '/api/search-demand') return respond(productionOrigin === 'https://stupid.gifts' && manifest.dataKind === 'catalog'
          ? await recordSearchDemand(request, env, now()) : new Response(null, { status: 403 }));
        if (path === '/api/catalog-feed') return respond(await feed(request));
        if (RETIRED_ROUTE.test(path) || path.startsWith('/api/')) return respond(json({ error: 'Not found' }, 404));
        if (!['GET', 'HEAD'].includes(request.method)) return respond(json({ error: 'Method not allowed' }, 405, { Allow: 'GET, HEAD' }));
        if ((decodedPath === '/random-gift' || decodedPath === '/random-gift/') && url.searchParams.has('gift')) return respond(json({ error: 'Not found' }, 404));
        if (path.endsWith('/') && path !== '/') {
          const target = path.slice(0, -1);
          // Only finite known HTML pages (plus maintained legal/search pages),
          // never API, unknown assets, data aliases or a catch-all SPA redirect.
          const page = routes.get(target);
          if (target === '/privacy' || target === '/search' || !target.includes('.') && (page?.assetPath === `${target}.html`
            || page?.state === 'held' && heldProductPaths.has(target))) {
            return respond(new Response(null, { status: 308, headers: { Location: `${target}${pageAliasSearch(url.searchParams)}`, 'Cache-Control': 'no-store' } }));
          }
        }
        if (path === '/search') {
          const q = url.searchParams.get('q')?.trim();
          return respond(new Response(null, { status: 308, headers: { Location: q ? `/?q=${encodeURIComponent(q)}` : '/', 'Cache-Control': 'no-store' } }));
        }
        const redirect = redirects.get(path);
        if (redirect && routes.has(redirect)) return respond(new Response(null, { status: 308, headers: { Location: `${redirect}${campaignSearch(url.searchParams)}`, 'Cache-Control': 'no-store' } }));
        if (path === '/sitemap.xml' || path === '/sitemap/0.xml') return respond(sitemap(request));
        // Retained chunks may arrive with encoded brackets or unreserved filename
        // bytes. Their single-decoded equivalent must not bypass the expiry guard.
        const route = routes.get(path) || directAssets.get(path) || routes.get(decodedPath) || directAssets.get(decodedPath);
        if (route) return respond(await asset(request, env, route));
        // Legal content is timeless and intentionally outside catalog manifests.
        if (path === '/privacy' || /^\/privacy(?:\.(?:html|txt)|\/__next\.[^/]+\.txt)$/.test(path)) {
          const assetPath = path === '/privacy' ? '/privacy.html' : path;
          return respond(await asset(request, env, { assetPath, safeAssetPath: assetPath, eligibleUntil: null, state: 'ready', indexable: path === '/privacy' }));
        }
        if (safeAssets.has(path)) {
          const safeRoute = [...routes.values()].find((entry) => entry.safeAssetPath === path)!;
          return respond(await asset(request, env, safeRoute, true));
        }
        // Unknown freshness-sensitive paths are real 404s, never asset/SPA fallback.
        if (TIMED_ROUTE.test(path) || !PUBLIC_ASSET.test(path) && !clearedImages.has(decodedPath)) return respond(await notFound(request, env, decodedPath));
        const response = await env.ASSETS.fetch(request);
        return respond(response.status === 404 ? json({ error: 'Not found' }, 404) : response);
      } catch {
        // No error object: it may contain provider credentials, queries or URLs.
        return respond(json({ error: 'Temporarily unavailable' }, 503));
      }
    },
  };
}
