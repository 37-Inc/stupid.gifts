import { App, applyHostStyleVariables, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';

const app = new App({ name: 'Gift carousel', version: '0.2.0' }, {}, { strict: true, autoResize: true });
const byId = (id) => document.getElementById(id);
let ready = false;
const paths = {
  cup: '<path d="M29 43h48v39c0 12-48 12-48 0z" fill="#fff9ed"/><path d="M77 48h9c18 0 18 28 0 28h-9M42 31c-9-9 9-9 0-18M60 31c-9-9 9-9 0-18" fill="none"/><path d="M40 62h25M43 69h19"/>',
  plant: '<path d="M31 69h53l-8 35H39z" fill="#cf784b"/><path d="M57 69V30M57 54C27 53 29 27 29 27c27 0 28 27 28 27M57 43c0-30 30-24 30-24s2 25-30 24" fill="#6f8764"/>',
  cat: '<path d="M28 82V38l20 14h20l21-14v44c0 33-61 33-61 0z" fill="#dca969"/><path d="M43 72h1m29 0h1M53 83l5 4 5-4M58 87v7M19 84l18 3M79 87l20-3"/>',
  sock: '<path d="M58 22h26v52c0 11-7 17-17 23l-19 11c-18 10-34-11-16-23l26-17z" fill="#fff9ed"/><path d="M59 34h24M59 44h24M52 73l15 18M35 85l13 17" stroke="#c2410c"/>',
  desk: '<path d="M18 100h82M28 96V32h59v64" fill="#f8cfa3"/><path d="M40 48h35M40 60h35M40 72h25M40 83h30"/>',
  kitchen: '<path d="M44 30h32l-3 29-11 12v35H49V71L39 59z" fill="#dbb17d"/><path d="M47 39h21M47 48h21M55 73v24M23 20l7 12M89 18l-5 14"/>',
};
function illustration(kind) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 120 120'); svg.setAttribute('aria-hidden', 'true');
  // Only static authored SVG fragments become markup. Catalog text uses textContent.
  svg.innerHTML = `<g stroke="#65513f" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || paths.desk}</g>`;
  return svg;
}
function safeUrl(value, hosts = ['stupid.gifts']) {
  try { const url = new URL(value); return url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function render(data) {
  if (!data || !Array.isArray(data.gifts)) { showStatus('Gift ideas could not be loaded. Try again in chat.'); return; }
  // Real gift pages carry the disclosure. Imaginary samples need a label here.
  byId('disclosure').textContent = data.mode === 'fixture' ? data.disclosure : '';
  byId('status').classList.remove('loading');
  const gifts = data.status === 'ok' ? data.gifts.slice(0, 6) : [];
  if (data.status === 'ok' && !gifts.length) { showStatus('No gift ideas were returned. Try different interests.'); return; }
  if (gifts.some(gift => !gift || typeof gift.title !== 'string' || !gift.title.trim()
    || typeof gift.description !== 'string')) { showStatus('Gift ideas could not be loaded. Try again in chat.'); return; }
  byId('status').textContent = data.status !== 'ok'
    ? (typeof data.message === 'string' && data.message.trim() ? data.message : 'Gift ideas are unavailable. Try again in chat.') : '';
  const cards = byId('cards'); cards.replaceChildren();
  cards.setAttribute('aria-busy', 'false');
  cards.hidden = !gifts.length;
  for (const [index, gift] of gifts.entries()) {
    const card = document.createElement('article'); card.className = 'card';
    card.setAttribute('aria-label', `${index + 1} of ${gifts.length}`);
    const art = document.createElement('div'); art.className = 'art';
    const missingImage = () => { art.replaceChildren(); art.dataset.missing = ''; art.textContent = 'Image unavailable'; };
    const imageUrl = safeUrl(gift.imageUrl, data.mode === 'site-catalog' ? ['stupid.gifts', 'm.media-amazon.com', 'i.etsystatic.com'] : undefined);
    if (data.mode === 'fixture') art.append(illustration(gift.illustration));
    else if (imageUrl) {
      // The adjacent heading and link name identify the gift. Avoid announcing
      // the same title a second time as the image alternative.
      const image = document.createElement('img'); image.alt = ''; image.loading = index < 3 ? 'eager' : 'lazy'; image.decoding = 'async';
      image.onload = () => {
        const ratio = image.naturalWidth / image.naturalHeight;
        art.dataset.shape = ratio < .8 ? 'portrait' : ratio > 1.25 ? 'landscape' : 'square';
        art.dataset.loaded = '';
      };
      image.onerror = missingImage; image.src = imageUrl; art.append(image);
    } else missingImage();
    const body = document.createElement('div'); body.className = 'body';
    const title = document.createElement('h2'); title.textContent = gift.title;
    const description = document.createElement('p'); description.className = 'description'; description.id = `gift-description-${index}`; description.textContent = gift.description;
    body.append(title, description);
    const url = safeUrl(gift.url);
    if (url && new URL(url).pathname.startsWith('/gifts/')) {
      const link = document.createElement('a'); link.className = 'card-link';
      link.setAttribute('aria-label', `View Gift for ${gift.title}`);
      link.setAttribute('aria-describedby', `${description.id} link-note`);
      const cta = document.createElement('span'); cta.className = 'cta'; cta.textContent = 'View Gift';
      const arrow = document.createElement('span'); arrow.className = 'cta-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = '→';
      cta.append(arrow); body.append(cta);
      link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.onclick = (event) => { if (ready) { event.preventDefault(); void app.openLink({ url }).catch(() => { byId('status').textContent = 'The host could not open this link. Try again.'; }); } };
      link.append(art, body); card.append(link);
    } else {
      card.append(art, body);
    }
    cards.append(card);
  }
  cards.scrollLeft = 0;
}
function applyContext(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.ontoolresult = ({ structuredContent }) => render(structuredContent);
function showStatus(message) {
  byId('cards').replaceChildren();
  byId('cards').hidden = true;
  byId('cards').setAttribute('aria-busy', 'false');
  byId('status').classList.remove('loading');
  byId('status').textContent = message;
}
app.ontoolcancelled = () => showStatus('Search cancelled. Try again in chat.');
app.onhostcontextchanged = applyContext;
app.connect().then(() => { ready = true; applyContext(app.getHostContext()); }).catch(() => showStatus('Open this component through the connected Stupid Gifts app.'));
