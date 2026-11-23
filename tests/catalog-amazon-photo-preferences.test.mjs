import test from 'node:test';
import assert from 'node:assert/strict';
import {mapItem} from '../lib/amazon-creators.js';
import {matchesPreferredAmazonPhoto} from '../lib/catalog/amazon-photo-preferences.mjs';

test('pick only the exact asset when Amazon returns it for the exact ASIN',()=>{
  const asin='B0C85MZCYY',primary='https://m.media-amazon.com/images/I/primary.jpg';
  const selected='https://m.media-amazon.com/images/I/71nY+6TsrYL._SL500_.jpg';
  const unrelated=selected.replace('m.media-amazon.com','example.invalid');
  const item={asin,images:{primary:{large:{url:primary}},variants:[{large:{url:unrelated}},{large:{url:selected}}]}};
  assert.equal(mapItem(item).imageUrl,selected);
  assert.equal(mapItem({...item,asin:'B000000001'}).imageUrl,primary);
  item.images.variants.pop();
  assert.equal(mapItem(item).imageUrl,primary);
  assert.equal(matchesPreferredAmazonPhoto(asin,selected.replace('71nY+6TsrYL','71nY+6TsrYL-other')),false);
  assert.equal(matchesPreferredAmazonPhoto(asin,selected.replace('https:','http:')),false);
});
