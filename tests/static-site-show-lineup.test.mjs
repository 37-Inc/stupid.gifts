import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import { showLineupIds, SHOW_LINEUP_BOOTSTRAP } from '../static-site/lib/show-lineup.ts';

const a='11111111-1111-4111-8111-111111111111',b='abcdefab-1234-4123-8123-123456789abc';
test('custom filming URL is ordered, UUID-only, bounded and separate from real search', () => {
  assert.equal(showLineupIds('?q=goose'),null);
  assert.deepEqual(showLineupIds(`?ids=${b.toUpperCase()},${a}&q=goose&utm_medium=qa`),[b,a]);
  for(const query of ['?ids=', '?ids=not-public-id', `?ids=${a},${a}`, `?ids=${b},${b.toUpperCase()}`,
    `?ids=${a}&ids=${b}`, '?ids='+Array(7).fill(a).join(',')]) assert.throws(()=>showLineupIds(query));
});
test('pre-grid bootstrap hides saved picks for a custom URL before hydration, including invalid custom URLs', () => {
  for(const search of [`?ids=${a}`,'?ids=bad']){
    const main={dataset:{}},document={getElementById:id=>id==='main'?main:null};
    vm.runInNewContext(SHOW_LINEUP_BOOTSTRAP,{URLSearchParams,location:{search},document});
    assert.equal(main.dataset.customShow,'true');
  }
  const main={dataset:{}},document={getElementById:id=>id==='main'?main:null};
  vm.runInNewContext(SHOW_LINEUP_BOOTSTRAP,{URLSearchParams,location:{search:''},document});
  assert.deepEqual(main.dataset,{});
  const page=fs.readFileSync(new URL('../static-site/components/ShowShortlist.tsx',import.meta.url),'utf8');
  assert(page.indexOf('SHOW_LINEUP_BOOTSTRAP }}')<page.indexOf('<Search'));
  assert.match(page,/data-custom-show="true".*show-default-picks\{display:none\}/);
  const client=fs.readFileSync(new URL('../static-site/components/ShowLineup.tsx',import.meta.url),'utf8');
  assert.match(client,/fetchCardShard/);assert.match(client,/current\.signal\.aborted/);
  assert.match(client,/popstate/);assert.doesNotMatch(client,/as (?:CatalogCard|PublicCatalogProduct)/);
  assert.match(client,/catalogDeadline\(p\.eligibleUntil\) > Date\.now\(\)/);
  const analytics=fs.readFileSync(new URL('../static-site/lib/analytics.ts',import.meta.url),'utf8');
  assert.match(analytics,/if \(!element\.getClientRects\(\)\.length\) continue/);
});
