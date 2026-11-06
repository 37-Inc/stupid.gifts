import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../web/widget.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../web/widget.mjs', import.meta.url), 'utf8')
  .replace(/^import .* from '@modelcontextprotocol\/ext-apps';\n/, '');

// A bridge/DOM unit harness for semantic and failure-state behavior. This is
// deliberately not reported as browser, layout, screen-reader or mobile proof.
function widget() {
  class Element {
    constructor(tagName) {
      this.tagName = tagName; this.children = []; this.attributes = {}; this.dataset = {};
      this.textContent = ''; this.hidden = false;
      this.classList = { remove() {} };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const elements = Object.fromEntries(['status', 'cards', 'disclosure', 'link-note'].map(id => [id, new Element('div')]));
  elements['link-note'].textContent = html.match(/id="link-note"[^>]*>([^<]+)/)[1];
  let app;
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) };
  class App {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- Capture the instance created inside the VM bridge harness.
    constructor() { app = this; this.opened = []; }
    connect() { return Promise.resolve(); }
    getHostContext() { return {}; }
    openLink({ url }) { this.opened.push(url); return Promise.resolve(); }
  }
  runInNewContext(script, { App, document, URL, applyDocumentTheme() {}, applyHostStyleVariables() {} });
  return { app, elements };
}

const gift = { title: 'Ceramic cat mug', description: 'A cat-shaped ceramic mug.', url: 'https://stupid.gifts/gifts/cat-mug', imageUrl: 'https://stupid.gifts/images/cat-mug.jpg' };
const find = (element, tag) => element.children.flatMap(child => [child, ...find(child, tag)]).filter(child => child.tagName === tag);

test('fallback footer text meets normal-text contrast in light and dark themes', () => {
  function luminance(hex) {
    const digits = hex.replace('#', '');
    const expanded = digits.length === 3 ? [...digits].map(d => d + d).join('') : digits;
    const channels = expanded.match(/../g).map(v => parseInt(v, 16) / 255)
      .map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
    return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  }
  for (const theme of ['light', 'dark']) {
    const declarations = html.match(new RegExp(`\\[data-theme=${theme}\\]\\{([^}]+)`))[1];
    const color = name => declarations.match(new RegExp(`--fallback-${name}:(#[a-f0-9]+)`))[1];
    const values = [luminance(color('bg')), luminance(color('subtle'))].sort((a, b) => b - a);
    assert.ok((values[0] + .05) / (values[1] + .05) >= 4.5, theme);
  }
});

test('whole-card links describe the gift and new-tab destination without duplicate image names', async () => {
  const { app, elements } = widget();
  await Promise.resolve();
  app.ontoolresult({ structuredContent: { status: 'ok', mode: 'site-catalog', gifts: [gift] } });
  const card = elements.cards.children[0], links = find(card, 'a');
  assert.equal(links.length, 1);
  const link = links[0];
  assert.equal(link.attributes['aria-label'], 'View Gift for Ceramic cat mug');
  const descriptionIds = link.attributes['aria-describedby'].split(' ');
  assert.ok(find(card, 'p').some(p => descriptionIds.includes(p.id) && p.textContent === gift.description));
  assert.ok(descriptionIds.includes('link-note'));
  assert.match(elements['link-note'].textContent, /new tab/);
  assert.equal(find(card, 'img')[0].alt, '');
  assert.equal(card.attributes['aria-label'], '1 of 1');
  let prevented = false;
  link.onclick({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.deepEqual(app.opened, [gift.url]);
});

test('failed, cancelled and malformed results cannot leave stale gift cards visible', () => {
  for (const failure of [{ status: 'unavailable', gifts: [gift], message: 'The catalog is unavailable.' }, null,
    { status: 'ok', gifts: [] }, { status: 'ok', gifts: [null] }, { status: 'ok', gifts: [{ title: 'Missing description' }] }]) {
    const { app, elements } = widget();
    app.ontoolresult({ structuredContent: { status: 'ok', mode: 'site-catalog', gifts: [gift] } });
    assert.equal(elements.cards.children.length, 1);
    app.ontoolresult({ structuredContent: failure });
    assert.equal(elements.cards.hidden, true);
    assert.equal(elements.cards.children.length, 0);
    assert.ok(elements.status.textContent);
  }
  const { app, elements } = widget();
  app.ontoolresult({ structuredContent: { status: 'ok', mode: 'site-catalog', gifts: [gift] } });
  app.ontoolcancelled();
  assert.equal(elements.cards.hidden, true);
  assert.equal(elements.cards.children.length, 0);
  assert.match(elements.status.textContent, /cancelled/);
});
