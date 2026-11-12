import test from 'node:test';
import assert from 'node:assert/strict';
import {adminCampaigns,adminHostedStatus} from '../workers/site/admin-state.ts';
import {runtimeDigest} from '../lib/catalog/runtime-catalog.ts';
import {WEBSITE_CAMPAIGN_SCOPE} from '../lib/catalog/campaigns.ts';
const bytes=v=>new TextEncoder().encode(JSON.stringify(v)+'\n');
function bucket(objects){return{async get(key){const b=objects.get(key);return b?{async arrayBuffer(){return b.buffer;}}:null;}};}
test('private campaign actions read only exact hash-bound website inputs; stale is not zero or a commission boost',async()=>{
  const now=Date.parse('2026-11-11T12:00:00.000Z'),p={id:'B000000001',source:'amazon',title:'Desk goose',description:'A magnetic desk goose.',slug:'desk-goose'},
    c={campaignId:'fixture',campaignName:'Goose campaign',asin:p.id,campaignUrl:'https://affiliate-program.amazon.com/creatorconnections/campaigns/fixture',
      observedAt:'2026-11-11T10:00:00.000Z',expiresAt:'2026-11-12T10:00:00.000Z',startsAt:'2026-11-01T00:00:00.000Z',endsAt:'2026-12-01T00:00:00.000Z',
      advertisedBonusRate:.15,verifiedTotalRate:null,enrollment:'offered',joinable:true,websiteEligible:true,sellerQualified:null,funded:true,
      requirementsReviewed:false,enrollmentEvidence:null,sourceEvidence:'synthetic-fixture'};
  const objects=new Map(),files=[];
  for(const [name,value]of Object.entries({'website-feed':{schemaVersion:1,scope:WEBSITE_CAMPAIGN_SCOPE,campaigns:[c]},
    'product-reviews':{[p.id]:{title:p.title,description:p.description,appeal:'standout',reason:'Clear visual joke.'}}})){
    const body=bytes(value),sha256=await runtimeDigest(body),key='inputs/files/'+sha256+'.json';objects.set('catalog-v1/'+key,body);
    files.push({relative:'daily-catalog-care/campaigns/'+name+'.json',key,sha256});
  }
  const body=bytes({schemaVersion:1,kind:'catalog-hosted-inputs',files}),sha256=await runtimeDigest(body),key='inputs/'+sha256+'.json';
  objects.set('catalog-v1/'+key,body);objects.set('catalog-v1/pointers/operator-inputs.json',bytes({schemaVersion:1,key,sha256}));
  const live=await adminCampaigns(bucket(objects),[p],now);assert.equal(live.privateFeed,'saved_observations');assert.equal(live.manualActions[0].action,'join');
  assert.equal(live.campaigns[0].verifiedRate,null);
  const stale=await adminCampaigns(bucket(objects),[p],now+2*86400000);assert.equal(stale.campaigns[0].fresh,false);assert.deepEqual(stale.manualActions,[]);
  objects.set('catalog-v1/'+files[0].key,bytes({unexpected:'changed'}));
  assert.deepEqual(await adminCampaigns(bucket(objects),[p],now),{privateFeed:'unavailable',manualActions:null});
});
test('hosted status reports the saved pending identity and digest-verified successor without claiming fresh acceptance',async()=>{
  const objects=new Map(),prefix='/home/runner/.codex/private/goose-gifts-migration/';
  const ref=async(name,value)=>{const body=bytes(value),sha256=await runtimeDigest(body),relative='daily-catalog-care/runs/fixture/'+name+'.json';
    objects.set('catalog-v1/operator/'+relative,body);return{path:prefix+relative,sha256};};
  const control=await ref('catalog-control',{publication:{releaseId:'accepted',receiptSha256:'a'.repeat(64)},snapshotSha256:'b'.repeat(64)});
  const pending=await ref('hosted-run',{runKey:'original',source:'c'.repeat(40),day:'2026-11-11',kind:'full'});
  objects.set('catalog-v1/pointers/last-success.json',bytes({control}));objects.set('catalog-v1/pointers/pending-run.json',bytes({pending}));
  const result=await adminHostedStatus(bucket(objects));assert.equal(result.state,'observed');assert.equal(result.pending.runKey,'original');
  assert.equal(result.savedSuccessor.releaseId,'accepted');assert.match(result.note,/compare/i);
  objects.set('catalog-v1/pointers/last-success.json',bytes({control:{path:prefix+'../credentials',sha256:'a'.repeat(64)}}));
  assert.deepEqual(await adminHostedStatus(bucket(objects)),{state:'unknown'});
});
