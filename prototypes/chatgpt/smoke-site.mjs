import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'Stupid Gifts migration smoke', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8788/mcp')));
try {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['search_gifts', 'render_gifts']);
  assert.match(tools[0].description, /Stupid Gifts/);
  const resource = await client.readResource({ uri: tools[1]._meta.ui.resourceUri });
  assert.match(resource.contents[0].uri, /stupid-gifts/);
  const checks = [];
  for (const query of ['dad who loves cats', 'sister who loves barbecuing', 'coffee no mugs']) {
    const found = (await client.callTool({ name: 'search_gifts', arguments: { query } })).structuredContent;
    assert.equal(found.status, 'ok'); assert.equal(found.mode, 'site-catalog');
    assert.ok(found.gifts.length > 0 && found.gifts.length <= 12);
    if (query.includes('no mugs')) assert.ok(found.gifts.every(g => !/\b(mugs?|cups?)\b/i.test(`${g.title} ${g.description} ${g.tags.join(' ')}`)));
    const selected = found.gifts.slice(0, 3);
    const rendered = (await client.callTool({ name: 'render_gifts', arguments: { ids: selected.map(g => g.id) } })).structuredContent;
    assert.equal(rendered.status, 'ok');
    assert.ok(rendered.gifts.every(g => g.url.startsWith('https://stupid.gifts/gifts/') && g.imageUrl && !('price' in g) && !('affiliateUrl' in g)));
    checks.push({ query, found: found.gifts.length, rendered: rendered.gifts.length, titles: selected.map(g => g.title), image: selected[0].imageUrl });
  }
  const missing = await client.callTool({ name: 'render_gifts', arguments: { ids: ['missing-gift'] } });
  assert.equal(missing.isError, true); assert.equal(missing.structuredContent.status, 'not_found');
  console.log(JSON.stringify({ tools: tools.map(t => t.name), widget: resource.contents[0].uri, checks, missing: 'not_found' }));
} finally { await client.close(); }
