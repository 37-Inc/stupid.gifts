import assert from 'node:assert/strict';
import test from 'node:test';
import reviews from '../content/catalog-presentation.json' with {type:'json'};
import {productPresentation,productShortDescription,refreshedShortCopy} from '../lib/catalog/presentation.ts';
import {backfillPresentation} from '../scripts/catalog/backfill-presentation.mjs';
import {mergeCatalogMaintenanceUpsert} from '../scripts/ops/catalog-maintenance-merge.mjs';

test('every migrated note is exact-input-bound and resolves identically on a second pass',()=>{
  for(const [id,r] of Object.entries(reviews)){
    const p={id,source:'amazon',title:r.sourceTitle,description:r.sourceDescription??r.sourceCopy,wittyDescription:r.sourceCopy};
    assert.ok(r.description.trim());assert.notEqual(r.description,'A strange little catalog find.');
    assert.equal(productShortDescription(p),r.description,id);
    assert.deepEqual(productPresentation(productPresentation(p)),productPresentation(p),id);
    const fresh={...p,description:'Freshly reviewed factual description.'};
    assert.equal(productShortDescription(fresh),fresh.description,'fresh copy must supersede old backfill');
    const changed={...p,title:'A completely different object',description:'New object short copy.'};
    assert.equal(productShortDescription(changed),changed.description);
  }
});
test('net repair never describes Mickey, preserves ID and removes contradictory current aliases only',()=>{
  const r=reviews.B0BYJ6QF8S;
  const p={id:'B0BYJ6QF8S',source:'amazon',title:r.sourceTitle,description:r.sourceDescription??r.sourceCopy,
    wittyDescription:r.sourceCopy,punnyTitle:'Mickey Stuffed Animal',humorTags:['disney'],slug:'original-stable-slug'};
  const v=productPresentation(p);
  assert.match(v.description,/nets/);assert.equal(v.slug,p.slug);assert.equal(v.punnyTitle,undefined);
  assert.deepEqual(v.humorTags,[]);assert.equal(p.punnyTitle,'Mickey Stuffed Animal');
});
test('offline backfill reuses good descriptions, migrates notes, and does not change membership',()=>{
  const p={id:'a',source:'amazon',title:'Object',description:'A strange little catalog find.'};
  const good={id:'b',source:'amazon',title:'Other object',description:'Already good short copy.'};
  const s={products:[p,good]};const before=JSON.stringify(s);
  const result=backfillPresentation(s,{}, {a:{title:'Object',description:'A factual object description.'}});
  assert.deepEqual(Object.keys(result),['a']);assert.equal(JSON.stringify(s),before);
  assert.equal(refreshedShortCopy(good,'Other object'),good.description);
  assert.equal(refreshedShortCopy(good,'A different object'),'A different object.');
});
test('maintenance cannot carry an unreviewed object pun across a changed merchant title',()=>{
  const incoming={id:'x',title:'Butterfly net',price:0,currency:'USD',affiliateUrl:'https://www.amazon.com/dp/B000000001',
    humorTags:['disney'],isActive:true,source:'amazon',sourceFacts:{},editorialStatus:'pending'};
  const old={...incoming,title:'Mickey plush',wittyDescription:'A licensed snuggle buddy.',punnyTitle:'Mickey!',
    editorialStatus:'short_ready',editorialWriteup:'Retained original article',createdAt:null};
  const result=mergeCatalogMaintenanceUpsert(old,incoming,{sourceFactsHash:null,databaseTime:'2026-11-05T00:00:00.000Z'}).product;
  assert.equal(result.wittyDescription,'Butterfly net.');assert.equal(result.punnyTitle,null);
  assert.deepEqual(result.humorTags,[]);assert.equal(result.isActive,true);
  assert.equal(result.editorialWriteup,old.editorialWriteup);
});
