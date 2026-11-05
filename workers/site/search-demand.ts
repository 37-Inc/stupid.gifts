import { isSearchDemandObservation } from '../../lib/search-demand.ts';
import type { SiteEnv } from './bindings.ts';

const RETENTION_SECONDS = 30 * 86400;
const MAX_BODY_BYTES = 1024;

export const SEARCH_DEMAND_UPSERT = `INSERT INTO search_demand
  (id,day,topic,outcome,result_count,selected_rank,expires_at) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET selected_rank=COALESCE(search_demand.selected_rank,excluded.selected_rank)
  WHERE search_demand.topic=excluded.topic AND search_demand.outcome=excluded.outcome
    AND search_demand.result_count IS excluded.result_count`;

async function readBody(request: Request, signal: AbortSignal): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES) throw new Error('size');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('body');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let bytes = new Uint8Array();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (bytes.length + value.length > MAX_BODY_BYTES) { void reader.cancel(); throw new Error('size'); }
      const next = new Uint8Array(bytes.length + value.length);
      next.set(bytes); next.set(value, bytes.length); bytes = next;
    }
    if (signal.aborted) throw new Error('timeout');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('invalid'); }
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Separate best-effort endpoint: search results never await or depend on this. */
export async function recordSearchDemand(request: Request, env: SiteEnv, now = Date.now()): Promise<Response> {
  const response = (status = 204) => new Response(null, {
    status, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' },
  });
  if (request.method !== 'POST') return new Response(null, { status: 405,
    headers: { Allow: 'POST', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' } });
  const url = new URL(request.url);
  if (env.ENVIRONMENT !== 'production' || url.origin !== 'https://stupid.gifts'
    || request.headers.get('origin') !== url.origin) return response(403);
  if (request.headers.get('dnt') === '1' || request.headers.get('sec-gpc') === '1'
    || url.searchParams.get('utm_medium')?.toLowerCase() === 'qa') return response();
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return response(415);
  if (!env.DB) return response(503);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Bounds only this optional request, never browsing/search. A late commit is
    // harmless: immutable per-search IDs make identical retries idempotent.
    await Promise.race([
      (async () => {
        const observation = await readBody(request, controller.signal);
        if (!isSearchDemandObservation(observation)) throw new Error('invalid');
        const seconds = Math.floor(now / 1000);
        await env.DB!.batch([
          env.DB!.prepare('DELETE FROM search_demand WHERE expires_at<=?').bind(seconds),
          env.DB!.prepare(SEARCH_DEMAND_UPSERT).bind(observation.id, new Date(now).toISOString().slice(0, 10),
            observation.topic, observation.outcome, observation.resultCount, observation.selectedRank,
            seconds + RETENTION_SECONDS),
        ]);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => {
        controller.abort(); reject(new Error('timeout'));
      }, 1000); }),
    ]);
    return response();
  } catch (error) {
    // No raw topic, request or provider error reaches logs/responses.
    return response(error instanceof Error && ['invalid', 'body', 'size'].includes(error.message) ? 400 : 503);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
