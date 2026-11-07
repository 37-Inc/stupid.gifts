import assert from 'node:assert/strict';
import test from 'node:test';
import { FRESHNESS_POLICY, planProductFreshness } from '../scripts/catalog/freshness-selection.ts';

const NOW='2026-11-06T16:30:00.000Z',DAY=86_400_000;
const id=n=>`B${String(n).padStart(9,'0')}`;
const ago=days=>new Date(Date.parse(NOW)-days*DAY).toISOString();
const product=(n,changes={})=>({id:id(n),source:'amazon',isActive:true,publiclyCleared:true,
  duplicateOfProductId:null,availabilityStatus:'IN_STOCK',availabilityCheckedAt:ago(40),photoExpiresAt:null,...changes});
const ids=plan=>plan.entries.map(p=>p.id);

test('due plan prioritizes real photo work, captured hot products, legacy uncertainty, held rechecks and fair rotation',()=>{
  const products=[product(1),product(2,{availabilityStatus:'OUT_OF_STOCK',availabilityCheckedAt:ago(8)}),
    product(3,{availabilityStatus:'UNAVAILABLE',availabilityCheckedAt:null}),
    product(4,{availabilityCheckedAt:ago(2)}),product(5,{availabilityCheckedAt:ago(2)}),
    product(6,{availabilityCheckedAt:ago(2)}),product(7,{availabilityCheckedAt:ago(.1),photoExpiresAt:ago(-.5)}),
    product(8,{availabilityCheckedAt:ago(.1)})];
  const before=structuredClone(products);
  const plan=planProductFreshness(products,NOW,{exposedIds:[id(4)],clickedIds:[id(5)],promotedIds:[id(6)],brokenPhotoIds:[id(8)]});
  assert.deepEqual(ids(plan),[id(8),id(7),id(4),id(5),id(6),id(3),id(2),id(1)]);
  assert.equal(plan.neededCount,8);assert.equal(plan.unknownAvailabilityCount,1);
  assert.deepEqual(plan.entries.find(p=>p.id===id(3)),{id:id(3),dueAt:null,reasons:['legacy_availability_unknown']});
  assert.deepEqual(products,before,'planning must not mutate facts, observations or deadlines');
});

test('fresh products and holds are skipped until their actual objective is due',()=>{
  const products=[product(1,{availabilityCheckedAt:ago(34)}),product(2,{availabilityCheckedAt:ago(.99)}),
    product(3,{availabilityStatus:'OUT_OF_STOCK',availabilityCheckedAt:ago(6.99)}),
    product(4,{availabilityCheckedAt:ago(.99),availabilityStatus:'UNKNOWN'}),
    product(5,{availabilityCheckedAt:ago(35)}),product(6,{availabilityCheckedAt:ago(1)})];
  const plan=planProductFreshness(products,NOW,{exposedIds:[id(2),id(6)]});
  assert.deepEqual(ids(plan),[id(6),id(5)]);
  assert.equal(plan.entries[0].dueAt,NOW);assert.equal(plan.entries[1].dueAt,NOW);
});

test('missing, invalid or future availability dates are unknown and due, never inferred from another timestamp',()=>{
  const products=[product(1,{availabilityCheckedAt:null,lastVerifiedAt:NOW}),
    product(2,{availabilityCheckedAt:'not-a-date'}),product(3,{availabilityCheckedAt:ago(-1)}),
    product(4,{availabilityStatus:'OUT_OF_STOCK',availabilityCheckedAt:null})];
  const plan=planProductFreshness(products,NOW);
  assert.deepEqual(ids(plan),[id(4),id(1),id(2),id(3)]);
  assert.equal(plan.unknownAvailabilityCount,4);
  assert.ok(plan.entries.every(p=>p.dueAt===null));
});

test('unknown stock responses get a later recheck rather than being unlisted or fetched continuously',()=>{
  const products=[product(1,{availabilityStatus:'UNKNOWN',availabilityCheckedAt:ago(.5)}),
    product(2,{availabilityStatus:'UNKNOWN',availabilityCheckedAt:ago(1)})];
  const plan=planProductFreshness(products,NOW);
  assert.deepEqual(ids(plan),[id(2)]);
  assert.equal(plan.unknownAvailabilityCount,2);
  assert.deepEqual(plan.entries[0].reasons,['availability_unknown']);
  assert.equal(products[1].isActive,true);
});

test('photo-only plan selects only genuinely due/broken photos and deduplicates concurrent reasons',()=>{
  const products=[product(1,{photoExpiresAt:ago(-.5)}),product(2,{photoExpiresAt:ago(-1)}),
    product(3),product(4,{photoExpiresAt:ago(1)})];
  const plan=planProductFreshness(products,NOW,{photosOnly:true,exposedIds:[id(3)],brokenPhotoIds:[id(4)]});
  assert.deepEqual(ids(plan),[id(4),id(1)]);
  assert.deepEqual(plan.entries[0].reasons,['photo_broken','photo_due']);
  assert.equal(new Set(ids(plan)).size,plan.neededCount);
  assert.equal(products[0].photoExpiresAt,ago(-.5));
});

test('no arbitrary100 cutoff; the coordinator receives the full finite due cohort to pin and chunk',()=>{
  const products=Array.from({length:250},(_,n)=>product(n+1));
  const plan=planProductFreshness(products,NOW);
  assert.equal(plan.neededCount,250);assert.equal(plan.eligibleCount,250);
  assert.deepEqual(ids(plan),products.map(p=>p.id));
  assert.deepEqual(plan,planProductFreshness([...products].reverse(),NOW));
  assert.equal(FRESHNESS_POLICY.quietDays,35);
});

test('no new admission or curation override can sneak into maintenance planning',()=>{
  const products=[product(1,{publiclyCleared:false}),product(2,{isActive:false}),
    product(3,{duplicateOfProductId:id(4)}),product(4,{source:'etsy'}),product(5,{id:'invalid'}),product(6)];
  const plan=planProductFreshness(products,NOW,{exposedIds:[id(1),id(2),id(3)]});
  assert.deepEqual(ids(plan),[id(6)]);assert.equal(plan.eligibleCount,1);
});

test('invalid plan inputs and conflicting duplicate identities fail before any dispatch',()=>{
  for(const options of [{exposedIds:['not-an-asin']},{clickedIds:'invalid'},{promotedIds:[null]},
    {brokenPhotoIds:[{}]},{photosOnly:'yes'}])assert.throws(()=>planProductFreshness([],NOW,options),/freshness_selection_invalid/);
  for(const now of ['invalid','2026-11-06T16:30:00','2026-11-06T16:30:00Z'])
    assert.throws(()=>planProductFreshness([],now),/freshness_selection_invalid/);
  assert.throws(()=>planProductFreshness([product(1),product(1)],NOW),/freshness_duplicate_identity/);
});
