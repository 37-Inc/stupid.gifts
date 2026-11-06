import assert from 'node:assert/strict';
import test from 'node:test';
import {rankHybridResults} from '../lib/catalog/hybrid-ranking.ts';
import {readMerchandising} from '../lib/catalog/merchandising.ts';
const p=(id,title='Fishing gift',description='A fishing gift.')=>({id,title,description,rankScore:.99});
test('full ANN page cannot bury an exact literal product; overlap strengthens rank fusion',()=>{
  const exact=p('vase','Raw chicken vase'),generic=p('mug','Chicken mug');
  assert.equal(rankHybridResults('raw chicken vase',[exact],[generic,exact])[0].id,'vase');
  const both=p('both'),lex=p('lex'),ann=p('ann');
  assert.equal(rankHybridResults('fishing',[lex,both],[ann,both])[0].id,'both');
});
test('appeal then verified commission orders comparable matches, never an unrelated lucrative item',()=>{
  const ordinary=p('net'),funny=p('funny'),higher=p('higher'),irrelevant=p('random','Luxury watch','A watch.');
  const signals={net:{appeal:'ordinary'},funny:{appeal:'standout'},higher:{appeal:'standout',commissionPriority:2,commissionUntil:'2026-11-06T00:00:00.000Z'},
    random:{appeal:'standout',commissionPriority:999,commissionUntil:'2026-11-06T00:00:00.000Z'}};
  assert.deepEqual(rankHybridResults('fishing',[ordinary,funny,higher],[ordinary,funny,higher,irrelevant],signals,Date.parse('2026-11-05')).map(p=>p.id),['higher','funny','net','random']);
});
test('expired commission loses preference on the same cached candidate set',()=>{
  const a=p('a'),b=p('b'),signals={b:{commissionPriority:2,commissionUntil:'2026-11-05T12:00:00.000Z'}};
  assert.equal(rankHybridResults('fishing',[a,b],[],signals,Date.parse('2026-11-05T11:00:00Z'))[0].id,'b');
  assert.equal(rankHybridResults('fishing',[a,b],[],signals,Date.parse('2026-11-05T13:00:00Z'))[0].id,'a');
});
test('spread verified designs, not every blanket or category; no identity disappears',()=>{
  const items=[p('a','Cat blanket'),p('b','Cat blanket blue'),p('c','Cat blanket taco'),p('d','Cat blanket stars')];
  const result=rankHybridResults('cat blanket',items,[],{a:{variantGroup:'design1'},b:{variantGroup:'design1'}});
  assert.equal(result.length,4);assert.equal(new Set(result.map(p=>p.id)).size,4);
  assert.equal(rankHybridResults('cat blanket blue',items,[],{a:{variantGroup:'design1'},b:{variantGroup:'design1'}})[0].id,'b');
  assert.ok(readMerchandising({a:{appeal:'standout'}}));assert.equal(readMerchandising({a:{rawCommissionRate:50}}),null);
});
