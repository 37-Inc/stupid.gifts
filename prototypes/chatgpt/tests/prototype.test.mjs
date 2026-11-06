import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createCatalog, createGiftService, searchInput, renderInput, selectGifts } from '../catalog.mjs';
import { createHttpServer } from '../server.mjs';
import { WIDGET_URI } from '../mcp.mjs';

const gift = (id, extra = {}) => ({ id, title: `Coffee gift ${id}`, description: 'A coffee desk gift.', tags: ['coffee', 'desk'], url: 'https://stupid.gifts/', imageUrl: null, illustration: 'cup', ...extra });
const assertNoPrices = (products) => { for (const p of products) for (const field of ['price', 'currency', 'priceAsOf']) assert.equal(field in p, false); };

test('bundled inline UI remains executable after HTML embedding', () => {
  const html = readFileSync(new URL('../dist/widget.html', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Script(html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))));
  const preview = readFileSync(new URL('../web/preview.html', import.meta.url), 'utf8');
  assert.doesNotThrow(() => new Script(preview.slice(preview.indexOf('<script>') + 8, preview.lastIndexOf('</script>'))));
});

test('search takes only a query and works without price information', () => {
  const input = searchInput.parse({ query: 'coffee' });
  assert.deepEqual(input, { query: 'coffee' });
  const selected = selectGifts([gift('first'), gift('second')], input);
  assert.equal(selected.length, 2);
});

test('explicit chat exclusions do not reward unwanted products or lose the carried interest', () => {
  const products = [
    gift('mug', { title: 'Coffee mug', tags: ['coffee', 'mug'] }),
    gift('apron', { title: 'Coffee apron', tags: ['coffee', 'apron'] }),
    gift('spoon', { title: 'Coffee spoon', tags: ['coffee', 'spoon'] }),
    gift('unrelated', { title: 'No worries cat mug', description: 'For cat people.', tags: ['cat', 'mug'] }),
  ];
  for (const query of ['coffee no mugs', 'coffee without mugs', 'coffee avoid mugs', 'coffee excluding mugs']) {
    assert.deepEqual(selectGifts(products, { query }).map(g => g.id).sort(), ['apron', 'spoon']);
  }
  assert.deepEqual(selectGifts(products, { query: 'coffee no mugs or aprons' }).map(g => g.id), ['spoon']);
  assert.deepEqual(selectGifts(products, { query: 'no mugs' }), []);
});

test('coffee interest distinguishes the drink from coffee-table books and broad kitchen tags', () => {
  const products = [
    gift('sock', { title: 'Funny coffee socks', description: 'A coffee-themed gift.', tags: ['coffee'] }),
    gift('kitchen', { title: 'Funny oven mitts', description: 'Cooking humor.', tags: ['kitchen', 'coffee'] }),
    gift('book', { title: 'Mustache field guide', searchTitle: 'Funny Coffee Table Book', description: 'A coffee-table book of mustaches.', tags: ['coffee-table', 'coffee'] }),
    gift('desk', { title: 'Coworker desk toy', description: 'An office gift.', tags: ['coworker', 'desk'] }),
    gift('handyman', { title: 'Handyman gift', description: 'A joke about fixing coffee.', tags: ['coffee'] }),
  ];
  assert.deepEqual(selectGifts(products, { query: 'more different gifts for my coworker who loves coffee' }).map(g => g.id), ['sock']);
  assert.deepEqual(selectGifts(products, { query: 'coffee office desk gifts no mugs' }).map(g => g.id), ['sock']);
  assert.deepEqual(selectGifts(products, { query: 'coffee table book' }).map(g => g.id), ['book']);
});

test('only the public gift projection appears in search and carousel output', async () => {
  const product = gift('projected', { price: 12, currency: 'USD', priceAsOf: new Date().toISOString(), internalNotes: 'private' });
  const service = createGiftService({ mode: 'reviewed-catalog', disclosure: 'Test catalog', load: async () => [product] });
  for (const result of [await service.search({ query: 'coffee' }), await service.render({ ids: ['projected'] })]) {
    assert.equal(result.status, 'ok'); assertNoPrices(result.gifts); assert.equal('budget' in result, false);
    assert.equal('internalNotes' in result.gifts[0], false);
  }
});

test('schemas reject removed budget/filter fields, excessive IDs and external image links', async () => {
  for (const value of [{ query: 'coffee', maxPrice: 25 }, { query: 'coffee', url: 'http://localhost/private' }, { query: 'coffee', excludeTerms: ['mug'] }]) assert.throws(() => searchInput.parse(value));
  for (const value of [{ ids: [] }, { ids: Array(7).fill('x') }, { ids: ['x'], maxPrice: 25 }, { ids: ['x'], url: 'https://example.com' }]) assert.throws(() => renderInput.parse(value));
  await assert.rejects(createCatalog({ mode: 'reviewed-catalog' }), /rights-cleared/);
  const dir = await mkdtemp(join(tmpdir(), 'stupid-catalog-test-'));
  try {
    const file = join(dir, 'catalog.json');
    await writeFile(file, JSON.stringify({ rightsReview: 'Explicit test fixture approval', products: [gift('bad', { imageUrl: 'https://m.media-amazon.com/image.jpg' })] }));
    const catalog = await createCatalog({ mode: 'reviewed-catalog', file, approved: true });
    await assert.rejects(catalog.load());
  } finally { await rm(dir, { recursive: true }); }
});

test('failures and timeouts return honest empty results without credential-bearing errors', async () => {
  const catalog = { mode: 'fixture', disclosure: 'Fixture', load: async () => { throw new Error('postgres://secret'); } };
  const service = createGiftService(catalog);
  for (const failed of [await service.search({ query: 'coffee' }), await service.render({ ids: ['missing'] })]) {
    assert.equal(failed.status, 'unavailable'); assert.deepEqual(failed.gifts, []); assert.ok(!JSON.stringify(failed).includes('secret'));
  }
  const timed = await createGiftService({ ...catalog, load: () => new Promise(() => {}) }, { timeoutMs: 5 }).search({ query: 'coffee' });
  assert.equal(timed.status, 'unavailable');
});

test('natural recipient prompts yield relevant sample carousels and chat-selected IDs allow refinements', async () => {
  const service = createGiftService(await createCatalog());
  const prompts = ["I'm looking for a gift for my dad who loves cats", "I'm looking for a gift for my sister who loves barbecuing", 'office coffee', 'kitchen cooking', 'weird desk', 'gardening plant'];
  for (const query of prompts) {
    const found = await service.search({ query });
    assert.equal(found.mode, 'fixture'); assert.ok(found.gifts.length >= 3 && found.gifts.length <= 12, query);
    const rendered = await service.render({ ids: found.gifts.slice(0, 6).map((p) => p.id) });
    assert.ok(rendered.gifts.length >= 3 && rendered.gifts.length <= 6); assert.equal('budget' in rendered, false);
    assert.match(rendered.disclosure, /imaginary/); assertNoPrices(rendered.gifts);
    if (query.includes('cats')) assert.ok(rendered.gifts.every((p) => p.tags.includes('cat')));
    if (query.includes('barbecuing')) assert.ok(rendered.gifts.every((p) => p.tags.includes('barbecue')));
  }
  const first = await service.search({ query: 'cats' });
  const selected = first.gifts.filter((p) => !p.tags.includes('mug'));
  const refined = await service.render({ ids: selected.map((p) => p.id) });
  assert.ok(refined.gifts.every((p) => !p.tags.includes('mug'))); assert.equal(first.gifts.length, 4);
  assert.equal((await service.search({ query: 'flight booking' })).status, 'empty');
  assert.equal((await service.render({ ids: ['not-a-gift'] })).status, 'not_found');
});

test('real MCP transport exposes data-only search, one carousel renderer and bounded requests', async (t) => {
  const catalog = await createCatalog(); const http = createHttpServer(createGiftService(catalog), catalog.mode);
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { http.closeAllConnections(); http.close(resolve); }));
  const base = `http://127.0.0.1:${http.address().port}`;
  const client = new Client({ name: 'Stupid Gifts protocol verification', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))); t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((v) => v.name), ['search_gifts', 'render_gifts']);
  for (const tool of tools) { assert.equal(tool.annotations.readOnlyHint, true); assert.equal(tool.annotations.destructiveHint, false); assert.equal(tool.annotations.openWorldHint, false); }
  assert.equal(tools[0]._meta.ui, undefined); assert.equal(tools[1]._meta.ui.resourceUri, WIDGET_URI);
  assert.deepEqual(tools[0].inputSchema.required, ['query']);
  const resource = await client.readResource({ uri: WIDGET_URI });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app'); assert.deepEqual(resource.contents[0]._meta.ui.csp.connectDomains, []);
  const found = await client.callTool({ name: 'search_gifts', arguments: { query: 'dad who loves cats' } });
  assert.equal(found.structuredContent.status, 'ok');
  const rendered = await client.callTool({ name: 'render_gifts', arguments: { ids: found.structuredContent.gifts.map((p) => p.id) } });
  assert.equal(rendered.structuredContent.gifts.length, 4); assertNoPrices(rendered.structuredContent.gifts);
  const missing = await client.callTool({ name: 'render_gifts', arguments: { ids: ['missing-gift'] } });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.status, 'not_found');
  assert.deepEqual(missing.structuredContent.gifts, []); assert.match(missing.structuredContent.message, /No gifts were rendered/);
  assert.equal((await client.callTool({ name: 'search_gifts', arguments: { query: 'coffee', maxPrice: 25 } })).isError, true);
  const badOrigin = await fetch(`${base}/mcp`, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(badOrigin.status, 403);
  const huge = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 'a'.repeat(40000) }) });
  assert.equal(huge.status, 400); assert.equal((await fetch(`${base}/health`)).status, 200);
});
