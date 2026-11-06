import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCatalog, createGiftService } from './catalog.mjs';
import { createMcpServer } from './mcp.mjs';

async function readJson(req) {
  let length = 0;
  const parts = [];
  for await (const part of req) {
    length += part.length;
    if (length > 32768) throw new Error('Request too large.');
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export function createHttpServer(service, mode, { allowedHosts = ['localhost', '127.0.0.1', '[::1]'] } = {}) {
  let inFlight = 0;
  let calls = 0;
  let windowStart = Date.now();
  const respond = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
  const http = createServer(async (req, res) => {
    let host;
    try { host = new URL(`http://${req.headers.host || 'invalid'}`).hostname; }
    catch { return respond(res, 400, { error: 'Invalid host.' }); }
    if (!allowedHosts.includes(host)) return respond(res, 403, { error: 'Host is not allowed.' });
    if (['site-catalog', 'local-catalog'].includes(mode) && (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded)) return respond(res, 403, { error: 'Real catalog preview is local-only; public distribution remains pending.' });
    if (req.headers.origin) {
      try {
        if (!allowedHosts.includes(new URL(req.headers.origin).hostname)) return respond(res, 403, { error: 'Origin is not allowed.' });
      } catch { return respond(res, 403, { error: 'Origin is not allowed.' }); }
    }
    const path = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
    if (path === '/health' && req.method === 'GET') return respond(res, 200, { name: 'Stupid Gifts', version: '0.2.0', mode });
    const previewEnabled = ['fixture', 'site-catalog', 'local-catalog'].includes(mode);
    // Real data is available in an explicit loopback-only development mode.
    const previewFiles = { '/': './web/preview.html', '/widget': './dist/widget.html' };
    if (previewEnabled && req.method === 'GET' && path in previewFiles) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(await readFile(new URL(previewFiles[path], import.meta.url), 'utf8'));
      return;
    }
    if (path !== '/mcp' && !(previewEnabled && path === '/preview/call')) return respond(res, 404, { error: 'Not found.' });
    if (req.method !== 'POST') return respond(res, 405, { error: 'Use POST; this stateless server has no SSE session.' });
    if (!req.headers['content-type']?.startsWith('application/json')) return respond(res, 415, { error: 'Use application/json.' });
    if (Date.now() - windowStart >= 60000) { calls = 0; windowStart = Date.now(); }
    if (++calls > 120 || inFlight >= 8) return respond(res, 429, { error: 'Try again shortly.' });
    inFlight++;
    try {
      const body = await readJson(req);
      if (path === '/preview/call') {
        if (body.name === 'search_gifts') return respond(res, 200, { structuredContent: await service.search(body.arguments) });
        if (body.name === 'render_gifts') return respond(res, 200, { structuredContent: await service.render(body.arguments) });
        return respond(res, 400, { error: 'Unknown tool.' });
      }
      const mcp = createMcpServer(service, mode, { getWidgetHtml: () => readFile(new URL('./dist/widget.html', import.meta.url), 'utf8') });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) respond(res, 400, { error: 'Invalid request or unavailable catalog.' });
      else res.end();
    } finally { inFlight--; }
  });
  http.requestTimeout = 10000;
  http.headersTimeout = 10000;
  return http;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const catalog = await createCatalog({
    mode: (process.env.STUPID_CHATGPT_CATALOG_MODE ?? process.env.GOOSE_CHATGPT_CATALOG_MODE) || 'fixture',
    file: (process.env.STUPID_CHATGPT_CATALOG_FILE ?? process.env.GOOSE_CHATGPT_CATALOG_FILE),
    envFile: (process.env.STUPID_CHATGPT_ENV_FILE ?? process.env.GOOSE_CHATGPT_ENV_FILE),
    approved: (process.env.STUPID_CHATGPT_CATALOG_USE_APPROVED ?? process.env.GOOSE_CHATGPT_CATALOG_USE_APPROVED) === 'true',
  });
  const port = Number((process.env.STUPID_CHATGPT_PORT ?? process.env.GOOSE_CHATGPT_PORT) || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  const http = createHttpServer(createGiftService(catalog), catalog.mode);
  http.listen(port, '127.0.0.1', () => console.log(`Stupid Gifts — ChatGPT prototype (${catalog.mode}) at http://127.0.0.1:${port}/mcp`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => http.close(async () => { await catalog.close?.(); process.exit(0); }));
}
