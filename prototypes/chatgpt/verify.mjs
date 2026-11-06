import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = new URL(process.argv[2] || 'http://127.0.0.1:8787/mcp');
const files = ['package.json', 'package-lock.json', 'build.mjs', 'catalog.mjs', 'site-catalog.mjs', 'local-catalog.mjs', 'reviewed-facts.mjs', 'fixtures.json', 'mcp.mjs', 'server.mjs', 'web/widget.html', 'web/widget.mjs', 'web/preview.html', 'tests/prototype.test.mjs', 'tests/local-catalog.test.mjs', 'tests/site-catalog.test.mjs', 'smoke-site.mjs', 'verify.mjs', '../../lib/gift-slugs.ts', '../../lib/image-utils.ts', '../../lib/db/product-scoring.ts'];
const sourceHash = createHash('sha256');
for (const file of files) { sourceHash.update(file); sourceHash.update(await readFile(new URL(file, import.meta.url))); }
const evidence = { checkedAt: new Date().toISOString(), endpoint: endpoint.href, baseRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sourceFiles: files, sourceSha256: sourceHash.digest('hex'), mode: 'unknown', chatgptConversationVerified: false, modelCalls: 0, retailerCalls: 0, cases: [] };
const client = new Client({ name: 'Stupid Gifts acceptance replay', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(endpoint));
try {
  const { tools } = await client.listTools(); evidence.tools = tools.map((t) => ({ name: t.name, annotations: t.annotations }));
  assert.deepEqual(tools.map((t) => t.name), ['search_gifts', 'render_gifts']);
  assert.equal(tools[0]._meta.ui, undefined); assert.ok(tools[1]._meta.ui.resourceUri);
  const resource = await client.readResource({ uri: tools[1]._meta.ui.resourceUri });
  assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
  evidence.resourceUri = tools[1]._meta.ui.resourceUri;
  evidence.widgetSha256 = createHash('sha256').update(resource.contents[0].text).digest('hex');
  evidence.prefersBorder = resource.contents[0]._meta.ui.prefersBorder;
  async function run(name, args) {
    const start = performance.now(); const result = await client.callTool({ name, arguments: args });
    evidence.cases.push({ name, args, latencyMs: Math.round((performance.now() - start) * 10) / 10, result });
    const data = result.structuredContent;
    if (evidence.mode === 'unknown') evidence.mode = data.mode;
    assert.equal(data.mode, evidence.mode);
    assert.equal('budget' in data, false);
    for (const gift of data.gifts) for (const field of ['price', 'currency', 'priceAsOf']) assert.equal(field in gift, false);
    return data;
  }
  for (const query of ["I'm looking for a gift for my dad who loves cats", "I'm looking for a gift for my sister who loves barbecuing", 'office coffee', 'kitchen cooking', 'weird desk', 'gardening plant']) {
    const found = await run('search_gifts', { query });
    assert.ok(found.gifts.length >= (found.mode === 'fixture' ? 3 : 0) && found.gifts.length <= 12);
    if (!found.gifts.length) { assert.equal(found.status, 'empty'); continue; }
    const rendered = await run('render_gifts', { ids: found.gifts.slice(0, 6).map((g) => g.id) });
    assert.ok(rendered.gifts.length >= (found.mode === 'fixture' ? 3 : 1) && rendered.gifts.length <= 6);
    if (['site-catalog', 'local-catalog'].includes(rendered.mode)) for (const gift of rendered.gifts) {
      assert.match(gift.id, /^[0-9a-f-]{36}$/); assert.ok(gift.url.startsWith('https://stupid.gifts/gifts/')); assert.ok(gift.imageUrl);
    }
  }
  const candidates = await run('search_gifts', { query: 'cat' });
  const refined = await run('render_gifts', { ids: candidates.gifts.filter((g) => !g.tags.includes('mug')).slice(0, 6).map((g) => g.id) });
  assert.ok(refined.gifts.every((g) => !g.tags.includes('mug')));
  const coffee = await run('search_gifts', { query: 'coffee no mugs' });
  assert.ok(coffee.gifts.every(g => !g.tags.includes('mug') && !/\b(mugs?|cups?)\b/i.test(`${g.title} ${g.description}`)));
  if (coffee.gifts.length) await run('render_gifts', { ids: coffee.gifts.slice(0, 6).map(g => g.id) });
  // Empty retrieval is separate from the ChatGPT tool-selection test: a
  // travel request must not invoke this app, even if a gift mentions flight.
  assert.equal((await run('search_gifts', { query: 'zzzxqv' })).status, 'empty');
  assert.equal((await run('render_gifts', { ids: ['missing-gift'] })).status, 'not_found');
} finally { await client.close(); }
await mkdir(new URL('./evidence/', import.meta.url), { recursive: true });
const path = new URL(`./evidence/protocol-${evidence.mode === 'local-catalog' ? 'local-catalog' : endpoint.protocol === 'https:' ? 'https' : 'local'}.json`, import.meta.url);
await writeFile(path, JSON.stringify(evidence, null, 2) + '\n');
console.log(`Verified ${evidence.cases.length} MCP cases; evidence: ${path.pathname}`);
