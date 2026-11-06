import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Portable CI check: resolve the exact runtime graph for Web Workers, inline the
// built UI, and refuse Node/external runtime dependencies rather than polyfill.
const result = await build({
  entryPoints: [new URL('./worker.mjs', import.meta.url).pathname],
  bundle: true, write: false, format: 'esm', platform: 'browser',
  target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
  loader: { '.html': 'text' }, metafile: true, minify: true,
});
const imports = Object.values(result.metafile.outputs).flatMap(output => output.imports);
if (imports.some(entry => entry.external || entry.path.startsWith('node:')))
  throw new Error('Edge bundle contains an external or Node runtime import.');
const nodeInputs = Object.keys(result.metafile.inputs).filter(path => path.startsWith('node:'));
if (nodeInputs.length) throw new Error('Edge bundle depends on Node builtins.');
const bundle = result.outputFiles[0].contents;
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await writeFile(new URL('./dist/worker.mjs', import.meta.url), bundle);
const report = { bundleBytes: bundle.byteLength,
  sha256: createHash('sha256').update(bundle).digest('hex'),
  externalRuntimeImports: [], nodeBuiltinImports: [] };
await writeFile(new URL('./dist/edge-build.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`Verified edge bundle: ${report.bundleBytes} bytes; no Node/external runtime imports.`);
