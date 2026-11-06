import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createProductionHandler, parseApprovedGifts } from '../production.mjs';
import { createSiteCatalog, giftApprovalDigest } from '../site-catalog.mjs';
import { createGiftService } from '../catalog-core.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const hash = 'a'.repeat(64);
const product = { publicId: id, slug: 'cat-brush', title: 'Funny cat brush',
  description: 'A playful brush for a cat lover.', humorTags: ['cat'],
  imageUrl: 'https://stupid.gifts/images/owned-cat-brush.jpg', affiliateUrl: 'private-merchant-field' };
const fetchImpl = async (url, options = {}) => {
  const u = new URL(url);
  if (u.pathname === '/.well-known/catalog-release.json') return Response.json({ catalog_revision: 'v1', catalog_snapshot_sha256: hash });
  if (u.pathname === '/api/search-products') return Response.json({ results: [product] });
  if (u.pathname === '/api/catalog-gifts') return Response.json({ results: [product], catalogRevision: 'v1', catalogSnapshotSha256: hash });
  if (u.pathname === '/gifts/cat-brush' && options.method === 'HEAD') return new Response(null, { status: 200 });
  throw new Error('Unexpected fixture request');
};
const gift = (await createGiftService(createSiteCatalog({ fetchImpl })).search({ query: 'cat' })).gifts[0];
const approvedGifts = [{ id, sha256: await giftApprovalDigest(gift) }];
const widgetHtml = await readFile(new URL('../dist/widget.html', import.meta.url), 'utf8');
const defaults = { origin: 'https://stupid.gifts', enabled: true, approvedGifts,
  widgetHtml, fetchImpl, rateLimiter: { limit: async () => ({ success: true }) } };
const request = (body, { url = 'https://stupid.gifts/mcp', method = 'POST', headers = {} } = {}) => new Request(url, {
  method, headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
  ...(['GET', 'HEAD'].includes(method) ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

test('public handler stays disabled without rights, exact cohort and working protection', async () => {
  for (const override of [{ enabled: false }, { approvedGifts: [] }, { rateLimiter: undefined },
    { approvedGifts: [{ id, sha256: 'not-a-digest' }] }, { approvedGifts: [...approvedGifts, ...approvedGifts] }]) {
    const handler = createProductionHandler({ ...defaults, ...override });
    assert.equal((await handler.fetch(request(rpc('tools/list')))).status, 503);
    const health = await handler.fetch(request(null, { url: 'https://stupid.gifts/mcp/health', method: 'GET' }));
    assert.equal(health.status, 503);
    assert.equal((await health.json()).ready, false);
  }
  assert.equal(parseApprovedGifts(JSON.stringify(approvedGifts)).length, 1);
});

test('edge transport exposes bounded read-only tools and exact built UI without Node filesystem', async () => {
  const handler = createProductionHandler(defaults);
  const initialized = await handler.fetch(request(rpc('initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Stupid Gifts production test', version: '1.0.0' },
  })));
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, 'Stupid Gifts');
  const tools = (await (await handler.fetch(request(rpc('tools/list')))).json()).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), ['search_gifts', 'render_gifts']);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false));
  const resource = (await (await handler.fetch(request(rpc('resources/read', { uri: tools[1]._meta.ui.resourceUri })))).json()).result;
  assert.equal(resource.contents[0].text, widgetHtml);
  assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, []);
  assert.equal(resource.contents[0].text.includes('goose.gifts'), false);
  assert.equal(initialized.headers.get('cache-control'), 'no-store');
});

test('independent edge handlers search then render selected UUID without session state', async () => {
  const searchHandler = createProductionHandler(defaults);
  const found = (await (await searchHandler.fetch(request(rpc('tools/call', { name: 'search_gifts', arguments: { query: 'cat' } })))).json()).result;
  assert.equal(found.structuredContent.status, 'ok');
  const renderHandler = createProductionHandler(defaults);
  const shown = (await (await renderHandler.fetch(request(rpc('tools/call', { name: 'render_gifts', arguments: { ids: [id] } })))).json()).result;
  assert.equal(shown.structuredContent.status, 'ok');
  assert.deepEqual(shown.structuredContent.gifts, found.structuredContent.gifts);
  assert.equal(JSON.stringify(shown).includes('private-merchant-field'), false);
});

test('production rejects foreign host/origin, unsupported routes/methods and oversized JSON', async () => {
  const handler = createProductionHandler(defaults);
  assert.equal((await handler.fetch(request(rpc('tools/list'), { url: 'https://attacker.example/mcp' }))).status, 403);
  assert.equal((await handler.fetch(request(rpc('tools/list'), { headers: { origin: 'https://attacker.example' } }))).status, 403);
  assert.equal((await handler.fetch(request(null, { method: 'GET' }))).status, 405);
  assert.equal((await handler.fetch(request('{}', { url: 'https://stupid.gifts/preview/call' }))).status, 404);
  assert.equal((await handler.fetch(request('{}', { url: 'https://stupid.gifts/mcp?prompt=private' }))).status, 400);
  assert.equal((await handler.fetch(request('{}', { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await handler.fetch(request([rpc('tools/list'), rpc('tools/list')]))).status, 400);
  const large = await handler.fetch(request(JSON.stringify({ value: 'a'.repeat(40000) })));
  assert.equal(large.status, 413);
  const declared = await handler.fetch(request('{}', { headers: { 'content-length': '40000' } }));
  assert.equal(declared.status, 413);
});

test('one isolate bounds concurrent tool work even across rate-limit awaits', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const slowFetch = async (...args) => { entered(); await pending; return fetchImpl(...args); };
  const handler = createProductionHandler({ ...defaults, fetchImpl: slowFetch, maxConcurrency: 1 });
  const first = handler.fetch(request(rpc('tools/call', { name: 'search_gifts', arguments: { query: 'cat' } })));
  await started;
  const second = await handler.fetch(request(rpc('tools/list')));
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
});

test('shared capacity protection failures do not open the service or leak prompts', async () => {
  const keys = [];
  const denied = createProductionHandler({ ...defaults, rateLimiter: { limit: async ({ key }) => { keys.push(key); return { success: false }; } } });
  assert.equal((await denied.fetch(request(rpc('tools/list')))).status, 429);
  assert.deepEqual(keys, ['stupid-gifts:mcp:public-v1']);
  const broken = createProductionHandler({ ...defaults, rateLimiter: { limit: async () => { throw new Error('secret provider error'); } } });
  const response = await broken.fetch(request(rpc('tools/list')));
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('secret'), false);
});
