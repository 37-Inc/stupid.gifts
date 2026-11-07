import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingVectorCode} from '../scripts/catalog/run-cloudflare-weekly.ts';

const pending={errorCode:'mutation_unknown',deliveryId:'saved-delivery'};
const journal=value=>({prepare(sql){assert.equal(sql,'SELECT mutation_reference FROM catalog_vector_deliveries WHERE delivery_id=?');
  return{bind(id){assert.equal(id,pending.deliveryId);return{async all(){return{results:value}}}}}}});

test('only a durable provider acknowledgement becomes a same-delivery visibility wait',async()=>{
  assert.equal(await pendingVectorCode(journal([{mutation_reference:'provider-mutation'}]),pending),'not_visible');
  for(const rows of [[],[{mutation_reference:null}],[{mutation_reference:''}]]){
    assert.equal(await pendingVectorCode(journal(rows),pending),'mutation_unknown');
  }
});
test('other pending reasons are preserved without another journal read',async()=>{
  for(const errorCode of ['not_visible','provider_failed','attempts_exhausted']){
    assert.equal(await pendingVectorCode({prepare(){throw Error('unexpected read')}},{...pending,errorCode}),errorCode);
  }
});
test('an unreadable journal is not acknowledgement evidence',async()=>{
  await assert.rejects(pendingVectorCode({prepare(){throw Error('read unavailable')}},pending),/read unavailable/);
});
