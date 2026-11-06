import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createGiftService } from './catalog-core.mjs';
import { createSiteCatalog } from './site-catalog.mjs';
import { createMcpServer } from './mcp.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 32768;
const json = (value, status = 200, extra = {}) => Response.json(value, { status, headers: {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', ...extra,
} });

async function readMessage(request) {
  if (!request.body) throw Object.assign(new Error('Missing request body.'), { status: 400 });
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, text = '', timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 5000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (timedOut) throw Object.assign(new Error('Request timed out.'), { status: 408 });
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) {
        await reader.cancel();
        throw Object.assign(new Error('Request too large.'), { status: 413 });
      }
      text += decoder.decode(value, { stream: true });
    }
    const message = JSON.parse(text + decoder.decode());
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('One JSON-RPC message is required.');
    return message;
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

export function parseApprovedGifts(value) {
  try {
    const entries = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(entries) || !entries.length || entries.length > 100) return null;
    const seen = new Set();
    for (const entry of entries) {
      if (!entry || Object.keys(entry).sort().join(',') !== 'id,sha256' || !UUID.test(entry.id || '')
        || !/^[a-f0-9]{64}$/.test(entry.sha256 || '') || seen.has(entry.id)) return null;
      seen.add(entry.id);
    }
    return entries;
  } catch { return null; }
}

// A stable shared route budget protects upstream capacity without identifying
// users or unfairly treating ChatGPT's shared egress IP as one person's account.
// The configured Cloudflare binding is approximate and per-location, not global.
export function createProductionHandler({ widgetHtml, origin, approvedGifts, enabled = false,
  rateLimiter, fetchImpl = fetch, maxConcurrency = 8 } = {}) {
  let canonical;
  try {
    const candidate = new URL(origin);
    if (candidate.protocol === 'https:' && !candidate.username && !candidate.password
      && !candidate.port && candidate.pathname === '/' && !candidate.search && !candidate.hash
      && (candidate.hostname === 'stupid.gifts' || candidate.hostname.endsWith('.stupid.gifts'))) canonical = candidate.origin;
  } catch { /* Missing/invalid publication configuration remains closed. */ }
  const cohort = parseApprovedGifts(approvedGifts);
  const ready = enabled === true && !!canonical && !!cohort && typeof rateLimiter?.limit === 'function'
    && typeof widgetHtml === 'string' && widgetHtml.includes('<!doctype html>');
  const service = ready ? createGiftService(createSiteCatalog({ fetchImpl, approvedGifts: cohort })) : null;
  const origins = new Set(['https://chatgpt.com', canonical]);
  let inFlight = 0;

  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (!canonical || url.origin !== canonical) return json({ error: 'Host is not allowed.' }, 403);
      if (request.headers.has('origin') && !origins.has(request.headers.get('origin'))) return json({ error: 'Origin is not allowed.' }, 403);
      if (url.pathname === '/mcp/health' && ['GET', 'HEAD'].includes(request.method)) {
        const response = json({ name: 'Stupid Gifts', version: '0.2.0', ready,
          status: ready ? 'configured' : 'public-release-disabled' }, ready ? 200 : 503);
        return request.method === 'HEAD' ? new Response(null, { status: response.status, headers: response.headers }) : response;
      }
      if (url.pathname !== '/mcp') return json({ error: 'Not found.' }, 404);
      if (!ready) return json({ error: 'Public catalog release is not enabled.' }, 503);
      if (url.search) return json({ error: 'Query parameters are not supported.' }, 400);
      if (request.method !== 'POST') return json({ error: 'Use POST; this server is stateless.' }, 405, { allow: 'POST' });
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) return json({ error: 'Use application/json.' }, 415);
      const length = request.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) return json({ error: 'Request too large.' }, 413);
      if (inFlight >= maxConcurrency) return json({ error: 'Try again shortly.' }, 429, { 'retry-after': '1' });
      try {
        const outcome = await rateLimiter.limit({ key: 'stupid-gifts:mcp:public-v1' });
        if (outcome?.success !== true) return json({ error: 'Try again shortly.' }, 429, { 'retry-after': '60' });
      } catch { return json({ error: 'Request protection unavailable.' }, 503); }
      // Recheck after the shared-limit await; several requests may have arrived.
      if (inFlight >= maxConcurrency) return json({ error: 'Try again shortly.' }, 429, { 'retry-after': '1' });
      inFlight++;
      const server = createMcpServer(service, 'site-catalog', { getWidgetHtml: () => widgetHtml, production: true });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: MAX_BODY,
      });
      try {
        const parsedBody = await readMessage(request);
        await server.connect(transport);
        const response = await transport.handleRequest(request, { parsedBody });
        // JSON-only transport finishes the tool before returning this response.
        return new Response(response.body, { status: response.status, headers: {
          ...Object.fromEntries(response.headers), 'cache-control': 'no-store',
          'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        } });
      } catch (error) {
        const status = [408, 413].includes(error?.status) ? error.status : 400;
        return json({ error: status === 413 ? 'Request too large.' : status === 408 ? 'Request timed out.' : 'Invalid request or unavailable catalog.' }, status);
      }
      finally { inFlight--; await server.close(); }
    },
  };
}
