import widgetHtml from './dist/widget.html';
import { createProductionHandler } from './production.mjs';

// No direct catalog/admin writes, prompt/IP logs, filesystem access, or fallback fixtures.
// The reused website search may retain its separately disclosed operational diagnostics.
let active;
const worker = {
  fetch(request, env) {
    const key = JSON.stringify([env.MCP_PUBLIC_ORIGIN, env.PUBLIC_CATALOG_APPROVED,
      env.APPROVED_GIFTS, !!env.MCP_RATE_LIMITER]);
    if (active?.key !== key) active = { key, handler: createProductionHandler({
        widgetHtml, origin: env.MCP_PUBLIC_ORIGIN,
        enabled: env.PUBLIC_CATALOG_APPROVED === 'true',
        approvedGifts: env.APPROVED_GIFTS,
        rateLimiter: env.MCP_RATE_LIMITER,
      }) };
    return active.handler.fetch(request);
  },
};
export default worker;
