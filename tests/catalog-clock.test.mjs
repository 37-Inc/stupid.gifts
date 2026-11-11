import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogClockSlot,catalogScheduledTime} from '../lib/catalog/clock-slot.mjs';
import worker,{dispatchCatalogClock} from '../workers/catalog-clock.mjs';
import {hostedInvocationDay} from '../scripts/catalog/hosted-coordinator.mjs';

test('Pacific slots and catch-ups keep one identity across DST and delayed runners',()=>{
  for(const [wake,mode,due,day] of [
    ['2026-11-11T16:30:00.000Z','full','2026-11-11T16:30:00.000Z','2026-11-11'],
    ['2026-11-11T18:30:00.000Z','full','2026-11-11T16:30:00.000Z','2026-11-11'],
    ['2026-11-12T04:30:00.000Z','photos','2026-11-12T04:30:00.000Z','2026-11-12'],
    ['2026-11-12T06:30:00.000Z','photos','2026-11-12T04:30:00.000Z','2026-11-12'],
    ['2026-07-11T15:30:00.000Z','full','2026-07-11T15:30:00.000Z','2026-07-11'],
    ['2026-07-12T05:30:00.000Z','photos','2026-07-12T03:30:00.000Z','2026-07-12'],
  ]){
    assert.deepEqual(catalogClockSlot(wake),{mode,scheduled_at:due});
    assert.equal(hostedInvocationDay(mode,catalogScheduledTime(mode,due)),day);
  }
  for(const time of ['2026-11-11T15:30:00.000Z','2026-07-11T16:30:00.000Z','invalid','2026-11-11T16:30:01.000Z'])assert.equal(catalogClockSlot(time),null);
  assert.throws(()=>catalogScheduledTime('photos','2026-11-11T16:30:00.000Z'),/schedule_invalid/);
  assert.throws(()=>catalogScheduledTime('full','2026-11-11T18:30:00.000Z'),/schedule_invalid/);
});
test('clock dispatch is one fixed-repository request with no public trigger or provider access',async()=>{
  let calls=0;const logs=[],time=Date.parse('2026-11-11T16:30:00.000Z'),env={CLOCK_ENABLED:'true',GITHUB_CATALOG_DISPATCH_TOKEN:'test-only'};
  const dependencies={now:()=>time+100,log:line=>logs.push(JSON.parse(line)),send:async(url,init)=>{
    calls++;assert.equal(url,'https://api.github.com/repos/37-Inc/stupid.gifts/actions/workflows/catalog-manual.yml/dispatches');
    assert.deepEqual(JSON.parse(init.body),{ref:'main',inputs:{mode:'full',scheduled_at:new Date(time).toISOString()}});
    assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer test-only');return new Response(null,{status:204});
  }};
  assert.equal((await dispatchCatalogClock(time,env,dependencies)).state,'dispatched');assert.equal(calls,1);
  assert.equal(logs[0].status,204);assert.ok(!JSON.stringify(logs).includes('test-only'));
  assert.equal((await dispatchCatalogClock(time,{...env,CLOCK_ENABLED:'false'},dependencies)).state,'skipped');assert.equal(calls,1);
  assert.equal((await worker.fetch()).status,404);
  await assert.rejects(dispatchCatalogClock(time,env,{...dependencies,send:async()=>{calls++;throw Error('secret detail');}}),/dispatch_unknown/);
  assert.equal(calls,2);assert.ok(!JSON.stringify(logs).includes('secret detail'));
  await assert.rejects(dispatchCatalogClock(time,env,{...dependencies,send:async()=>{calls++;return new Response('private',{status:401});}}),/dispatch_failed_401/);
  assert.equal(calls,3);
});
