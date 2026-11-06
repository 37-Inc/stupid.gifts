import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
const bundle = await build({
  entryPoints: [new URL('./web/widget.mjs', import.meta.url).pathname],
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
});
const html = await readFile(new URL('./web/widget.html', import.meta.url), 'utf8');
const script = bundle.outputFiles[0].text.replaceAll('</script', '<\\/script');
await writeFile(new URL('./dist/widget.html', import.meta.url), html.replace('<!-- WIDGET_SCRIPT -->', () => `<script>${script}</script>`));
console.log('Built self-contained Stupid Gifts MCP App UI.');
