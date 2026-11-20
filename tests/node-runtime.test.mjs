import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('local, install and CI Node versions stay on the qualified Node 26 line', () => {
  const version = read('.nvmrc').trim();
  assert.match(version, /^26\.\d+\.\d+$/);
  assert.equal(JSON.parse(read('package.json')).engines.node, '26.x');
  assert.equal(JSON.parse(read('package-lock.json')).packages[''].engines.node, '26.x');
  let count = 0;
  for (const file of readdirSync(new URL('../.github/workflows/', import.meta.url))) {
    if (!/\.ya?ml$/.test(file)) continue;
    for (const match of read(`.github/workflows/${file}`).matchAll(/node-version:\s*['"]([^'"]+)['"]/g)) {
      assert.equal(match[1], version, file);
      count++;
    }
  }
  assert.ok(count >= 10, 'check all existing CI and operator setup-node pins');
  assert.doesNotMatch(read('scripts/ops/pull-env.sh'), /\/node\/v22\./);
  assert.match(read('tests/fixtures/upload-isolation.Dockerfile'), new RegExp(`^FROM node:${version.replaceAll('.', '\\.')}\\b`));
  assert.doesNotMatch(read('tests/fixtures/upload-isolation.Dockerfile'), /experimental-transform-types/);
  assert.doesNotMatch(read('.github/workflows/catalog-hosted-proof.yml'), /experimental-transform-types/);
});
