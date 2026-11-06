import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('the show shortlist retains shared grid spacing below its search form at every width',()=>{
  const css=fs.readFileSync(new URL('../static-site/app/styles.css',import.meta.url),'utf8');
  assert.match(css,/\.catalog-grid\s*\{[^}]*margin:\s*28px 0 40px/s);
  assert.doesNotMatch(css,/\.show-rehearsal\s+\.catalog-grid\s*\{[^}]*margin-top:\s*0/s);
});
