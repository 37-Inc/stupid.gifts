import assert from 'node:assert/strict';
import test from 'node:test';
import {confirmedRetailAvailable,confirmedRetailUnavailable} from '../lib/catalog/retail-availability.ts';
const operationId='a'.repeat(64),time='2026-11-06T16:32:00.000Z',facts='b'.repeat(64);
function row(status='OUT_OF_STOCK'){
  return{source:'amazon',id:'B000000001',availability_status:status,availability_checked_at:time,source_facts_hash:facts,
    timestamp_provenance_json:JSON.stringify({fields:{availability_checked_at:{basis:'maintenance_operation',operationId,
      state:status==='UNAVAILABLE'?'unverified_claim':'evidenced',sourceFactsHash:facts,reference:'objects/source.json',observedAt:time}}}),
    verification_operation_json:JSON.stringify({operation_id:operationId,database_time:time,
      changes_json:'[{"productId":"B000000001"}]',result_json:status==='UNAVAILABLE'?'["B000000001"]':'{}'})};
}
test('only evidenced retailer stock or the confirmed-missing operation unlists a gift',()=>{
  assert.equal(confirmedRetailUnavailable(row()),true);assert.equal(confirmedRetailUnavailable(row('UNAVAILABLE')),true);
  for(const status of ['UNKNOWN','IN_STOCK','AVAILABLE_DATE','PREORDER','LEADTIME',''])assert.equal(confirmedRetailUnavailable(row(status)),false);
  for(const change of [r=>r.source='etsy',r=>r.timestamp_provenance_json='{}',r=>r.verification_operation_json=null,
    r=>r.availability_checked_at='2026-11-07T00:00:00Z',r=>r.source_facts_hash='wrong']){
    const r=row();change(r);assert.equal(confirmedRetailUnavailable(r),false);
  }
  const r=row('UNAVAILABLE'),op=JSON.parse(r.verification_operation_json);op.result_json='[]';r.verification_operation_json=JSON.stringify(op);
  assert.equal(confirmedRetailUnavailable(r),false);
});
test('returning stock requires a real purchasable observation, not an unknown result or old imported label',()=>{
  for(const status of ['IN_STOCK','IN_STOCK_SCARCE','INSTOCKSCARCE','AVAILABLE_DATE','LEADTIME','PREORDER'])assert.equal(confirmedRetailAvailable(row(status)),true);
  for(const status of ['UNKNOWN','OUT_OF_STOCK','UNAVAILABLE',''])assert.equal(confirmedRetailAvailable(row(status)),false);
  const r=row('IN_STOCK');r.timestamp_provenance_json='{}';assert.equal(confirmedRetailAvailable(r),false);
});
