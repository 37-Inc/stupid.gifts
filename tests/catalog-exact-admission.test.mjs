import assert from 'node:assert/strict';
import test from 'node:test';
import amazon from '../lib/amazon-creators.js';
import {dailyCatalogPhases,dailyCatalogExecutor} from '../scripts/ops/catalog-daily.mjs';
import {operatorInvocation} from '../scripts/catalog/daily-operator.mjs';
import {executeCatalog,discoveryCandidateBlockReason} from '../scripts/ops/prefetch-catalog.mjs';

const ids=['B0HJTJQ9VS','B0H6QDN85V'];
const cadence={calendar:{monday:false},assertDay(){},async plan(){return{daily:true,discovery:false};},async reserve(){}};
test('owner-selected admissions are explicit, named and not a new scheduled cadence',()=>{
  assert.deepEqual(operatorInvocation(['prepare','--run','campaign-two','--admit-asins',ids.join(',')],{day:'2026-11-06'}).admitAsins,ids);
  for(const args of [ ['prepare','--admit-asins',ids.join(',')],['start','--run','one','--admit-asins',ids.join(',')],
    ['prepare','--run','one','--photos-only','--admit-asins',ids.join(',')],
    ['prepare','--run','one','--admit-asins',ids[0]+','+ids[0]],['prepare','--run','one','--admit-asins','bad'] ])
    assert.throws(()=>operatorInvocation(args,{day:'2026-11-06'}),/routine_command/);
});
test('exact admissions produce one new-only phase, no refresh/search themes, and retain reservation on retry',async()=>{
  const phases=await dailyCatalogPhases(cadence,[],false,ids);
  assert.equal(phases.length,1);assert.equal(phases[0].dailyRefresh,undefined);
  assert.equal(phases[0].discoveryNewOnly,true);assert.deepEqual(phases[0].admitAsins,ids);
  assert.equal(phases[0].maxNew,2);assert.equal(phases[0].backfillLimit,0);
  assert.deepEqual(await dailyCatalogPhases({...cadence,plan:async()=>({daily:false,discovery:false})},[],false,ids),[]);
  await assert.rejects(dailyCatalogPhases(cadence,[],true,ids),/admission_asins_invalid/);
});
test('exact admission firewall cannot update an existing or unrelated product',async()=>{
  const store={getActiveCatalogIdentities:async()=>[{id:ids[0]}],upsertProduct:async()=>({inserted:true})};
  const execute=dailyCatalogExecutor(cadence,async(o,s,t,bounded)=>{
    await assert.rejects(bounded.upsertProduct({id:ids[0]}),/discovery_existing_mutation_forbidden/);
    await assert.rejects(bounded.upsertProduct({id:'B000000000'}),/discovery_existing_mutation_forbidden/);
    return bounded.upsertProduct({id:ids[1]});
  });
  assert.deepEqual(await execute({admitAsins:ids},[],{runId:'one'},store),{inserted:true});
});
test('exact discovery fetches only the requested ASINs and still deduplicates against all identities',async()=>{
  const original={getItems:amazon.getItems,searchItems:amazon.searchItems};
  let fetched=0,allIdentities=false;
  try{
    amazon.searchItems=async()=>{throw Error('must_not_search');};
    amazon.getItems=async selected=>{assert.deepEqual(selected,ids);fetched++;return[{
      id:ids[0],title:'TEST ONLY Coral Turtle Toilet Bolt Covers',price:20,currency:'USD',
      affiliateUrl:'https://www.amazon.com/dp/'+ids[0]+'?tag=fixture-20',
      imageUrl:'https://example.invalid/lobster.jpg',source:'amazon',availabilityStatus:'IN_STOCK',
      sourceFacts:{material:'brass'},remotelyVerified:true,
    }];};
    const [phase]=await dailyCatalogPhases(cadence,[],false,ids);
    const telemetry={warnings:[],timingsMs:{},items:{record(){},async flush(){}}};
    await executeCatalog({...phase,dryRun:true},[],telemetry,{
      async getActiveCatalogIdentities({includeInactive}){allIdentities=includeInactive;return[{id:ids[0],title:'Existing inactive exact ASIN'}];},
    });
    assert.equal(fetched,1);
    assert.equal(allIdentities,true);
  }finally{Object.assign(amazon,original);}
});
test('owner-selected taste review does not bypass source readiness or copy review',()=>{
  const product={imageUrl:'/owned.jpg',affiliateUrl:'https://example.com',isActive:true,qualityScore:.8,title:'Turtle toilet bolt covers'};
  assert.equal(discoveryCandidateBlockReason(product,.65),'off_brand');
  assert.equal(discoveryCandidateBlockReason(product,.65,true),undefined);
  assert.equal(discoveryCandidateBlockReason({...product,isActive:false},.65,true),'inactive_candidate');
  assert.equal(discoveryCandidateBlockReason({...product,imageUrl:''},.65,true),'missing_image');
});
