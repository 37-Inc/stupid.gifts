import assert from 'node:assert/strict';
import test from 'node:test';
import {loadAutomationDiscoveryInputs,loadAutomationMerchandising} from '../scripts/catalog/automation-inputs.mjs';
const NOW=Date.parse('2026-11-06T20:00:00.000Z');
function runtime(value){return{care:'/owned/care',state:{async bytes(){if(value instanceof Error)throw value;return Buffer.from(JSON.stringify(value));}}};}
test('campaign leads deduplicate all identities including held records before fetching',async()=>{
  const leads=[{campaignKey:'a',observedAt:'2026-11-06T12:00:00.000Z',endsAt:'2026-11-10T12:00:00.000Z',advertisedRate:'20%',
    discoveryAsins:['B000000001','B000000002','B000000003']}];
  const db={prepare(sql){return{async all(){return{results:sql==='SELECT id FROM products'?[{id:'B000000001'},{id:'B000000002'}]:[
    {topic:'funny guitar gift',completed_searches:8,zero_result_searches:4,sparse_searches:1},
    {topic:'one private search',completed_searches:1,zero_result_searches:1,sparse_searches:0},
    {topic:'private@example.com',completed_searches:8,zero_result_searches:8,sparse_searches:0},
  ]};}};}};
  assert.deepEqual(await loadAutomationDiscoveryInputs({runtime:runtime(leads),db,now:NOW}),{leadAsins:['B000000003'],searchTopics:['funny guitar gift']});
});
test('absent/stale campaigns and unavailable telemetry do not block ordinary discovery',async()=>{
  const db={prepare(sql){return{async all(){if(sql!=='SELECT id FROM products')throw Error('missing optional table');return{results:[]};}};}};
  const missing=Object.assign(Error('missing'),{code:'ENOENT'});
  assert.deepEqual(await loadAutomationDiscoveryInputs({runtime:runtime(missing),db,now:NOW}),{leadAsins:[],searchTopics:[]});
  const stale=[{campaignKey:'a',observedAt:'2026-10-01T12:00:00.000Z',asins:['B000000003']}];
  assert.deepEqual((await loadAutomationDiscoveryInputs({runtime:runtime(stale),db,now:NOW})).leadAsins,[]);
});
test('unverified campaign metadata never produces a monetary boost',async()=>{
  const db={prepare(){return{bind(){return this;},async all(){return{results:[]};}};}};
  assert.deepEqual(await loadAutomationMerchandising({runtime:runtime({untrusted:'not website participation'}),db,seal:{projectionReceipt:{catalog_revision:'owned'}},now:NOW}),{});
});
