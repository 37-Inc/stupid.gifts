import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { PUBLIC_CONTACT_EMAIL } from '../lib/site.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicSourceRoots = ['app', 'components', 'lib', 'public', 'static-site/app', 'static-site/components', 'static-site/lib', 'static-site/public', 'workers'];
const textExtensions = new Set(['.cjs', '.css', '.html', '.js', '.json', '.jsx', '.mjs', '.svg', '.ts', '.tsx', '.txt']);

function textFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) return textFiles(entryPath);
    return textExtensions.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

test('public surfaces use the product contact instead of a personal address', () => {
  assert.equal(PUBLIC_CONTACT_EMAIL, 'stupidgifts@37.technology');

  const forbiddenAddresses = /\b(?:cam|cameron)@37\.technology\b/gi;
  const leaks = publicSourceRoots.flatMap((sourceRoot) =>
    textFiles(path.join(root, sourceRoot)).flatMap((file) => {
      const matches = fs.readFileSync(file, 'utf8').match(forbiddenAddresses) ?? [];
      return matches.map((address) => `${path.relative(root, file)}: ${address}`);
    }),
  );

  assert.deepEqual(leaks, []);
});

test('public source surfaces contain no personal owner name or byline exceptions', () => {
  const filesWithOwnerName = publicSourceRoots.flatMap((sourceRoot) =>
    textFiles(path.join(root, sourceRoot)).filter((file) =>
      /\b(?:cameron|ehrlich|cameronehrlich)\b/i.test(fs.readFileSync(file, 'utf8')),
    ),
  );

  assert.deepEqual(filesWithOwnerName.map((file) => path.relative(root, file)), []);
});

test('built public assets contain no personal owner identity, including retained chunks', {
  skip: !fs.existsSync(path.join(root, 'static-site/out/index.html')),
}, () => {
  const leaks = textFiles(path.join(root, 'static-site/out')).filter((file) =>
    /\b(?:cameron|ehrlich|cameronehrlich)\b|\b(?:cam|cameron)@37\.technology\b/i.test(fs.readFileSync(file, 'utf8')),
  );
  assert.deepEqual(leaks.map((file) => path.relative(root, file)), []);
});
