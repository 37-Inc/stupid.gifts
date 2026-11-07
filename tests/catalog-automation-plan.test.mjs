import assert from 'node:assert/strict';
import test from 'node:test';
import {planRoutineAutomation} from '../scripts/catalog/automation-plan.ts';
const at='2026-11-06T16:30:00.000Z';
const product=n=>({id:'B'+String(n).padStart(9,'0'),source:'amazon',isActive:true,publiclyCleared:true,
  availabilityStatus:'IN_STOCK',availabilityCheckedAt:'2026-07-01T00:00:00.000Z'});
test('quiet throughput scales with catalog rather than an arbitrary hundred cap',()=>{
  const products=Array.from({length:7000},(_,n)=>product(n));const r=planRoutineAutomation(products,at);
  assert.equal(r.plan.neededCount,7000);assert.equal(r.quietPerRun,200);assert.equal(r.refreshIds.length,200);
});
test('due hot/photos and legacy negative labels are additional exact priority work',()=>{
  const products=Array.from({length:350},(_,n)=>product(n));
  products[20].availabilityStatus='OUT_OF_STOCK';products[20].availabilityCheckedAt=null;
  products[21].photoExpiresAt='2026-11-06T18:00:00.000Z';
  const r=planRoutineAutomation(products,at,{exposedIds:[products[22].id]});
  assert.equal(r.quietPerRun,10);assert.equal(r.refreshIds.length,13);
  for(const n of [20,21,22])assert.ok(r.refreshIds.includes(products[n].id));
  assert.equal(new Set(r.refreshIds).size,13);
});
test('photo-only plan never includes unrelated stock/rotation work',()=>{
  const products=[product(1),{...product(2),photoExpiresAt:'2026-11-06T18:00:00.000Z'}];
  assert.deepEqual(planRoutineAutomation(products,at,{photosOnly:true}).refreshIds,[products[1].id]);
});
test('hot gifts with unknown or undated stock never disappear behind quiet rotation',()=>{
  const products=Array.from({length:100},(_,n)=>({...product(n),availabilityStatus:'UNKNOWN',availabilityCheckedAt:null}));
  const hot=products.at(-1).id,r=planRoutineAutomation(products,at,{exposedIds:[hot]});
  assert.ok(r.refreshIds.includes(hot));assert.ok(r.plan.entries.find(p=>p.id===hot).reasons.includes('hot_stock_due'));
});
