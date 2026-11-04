import assert from 'node:assert/strict';
import test from 'node:test';
import {withPublicationInventorySignal} from '../scripts/catalog/publish-release.ts';

test('routine paged inventory outlives the old two-minute timer; legacy behavior is unchanged',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const routine of [true,false]){
    let signal,finish;
    const pending=withPublicationInventorySignal(routine,3_600_000,async s=>{signal=s;await new Promise(r=>{finish=r;});});
    t.mock.timers.tick(130_000);assert.equal(signal.aborted,!routine);finish();await pending;
  }
});
test('original deadline still bounds routine inventory, and the larger window is finite',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  for(const remaining of [60_000,3_600_000]){
    let signal,finish;
    const pending=withPublicationInventorySignal(true,remaining,async s=>{signal=s;await new Promise(r=>{finish=r;});});
    const limit=Math.min(remaining,900_000);t.mock.timers.tick(limit-1);assert.equal(signal.aborted,false);
    t.mock.timers.tick(1);assert.equal(signal.aborted,true);finish();await pending;
  }
  await assert.rejects(withPublicationInventorySignal(true,0,async()=>{}),/retry_cutoff/);
});
