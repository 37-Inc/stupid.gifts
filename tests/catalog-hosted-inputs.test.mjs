import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,realpath,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {publishHostedInputs,currentHostedInputs,restoreHostedInputs,syncHostedCampaignFeed} from '../scripts/catalog/hosted-inputs.ts';
import {WEBSITE_CAMPAIGN_SCOPE} from '../lib/catalog/campaigns.ts';
function memory(){const data=new Map();let n=0;return{data,async get(k){return data.get(k)??null;},
  async putImmutable(k,bytes){const old=data.get(k);if(old&&!Buffer.from(old.bytes).equals(bytes))throw Error('conflict');
    const value=old??{bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(k,value);return value;},
  async compareAndSwap(k,etag,bytes){if((data.get(k)?.etag??null)!==etag)throw Error('conflict');
    const value={bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(k,value);return value;},async remove(){throw Error('no removal');}};}
async function base(t){const value=await realpath(await mkdtemp(path.join(os.tmpdir(),'hosted-inputs-')));t.after(()=>rm(value,{recursive:true,force:true}));return value;}
const file=value=>({relative:'daily-catalog-care/automation-policy.json',bytes:Buffer.from(JSON.stringify(value)+'\n')});
const campaign=(asin,changes={})=>({campaignId:'campaign-'+asin,campaignName:'Test gift',asin,
  campaignUrl:'https://affiliate-program.amazon.com/p/connect/request?campaignId=test',
  observedAt:'2026-11-09T10:00:00.000Z',expiresAt:'2026-11-10T10:00:00.000Z',startsAt:'2026-11-01T08:00:00.000Z',endsAt:'2026-12-01T08:00:00.000Z',
  advertisedBonusRate:.1,verifiedTotalRate:.13,enrollment:'accepted',joinable:false,websiteEligible:true,sellerQualified:true,funded:true,
  requirementsReviewed:true,enrollmentEvidence:'test-only-accepted',sourceEvidence:'test-only-observation',
  content:{state:'required',url:null,observedAt:'2026-11-09T10:00:00.000Z',evidence:'test-only-requirement'},...changes});
const feed=campaigns=>({schemaVersion:1,scope:WEBSITE_CAMPAIGN_SCOPE,campaigns});
const campaignFile=campaigns=>({relative:'daily-catalog-care/campaigns/website-feed.json',bytes:Buffer.from(JSON.stringify(feed(campaigns))+'\n')});
async function savedCampaigns(store){const ref=await currentHostedInputs(store),manifest=JSON.parse(store.data.get(ref.key).bytes);
  return JSON.parse(store.data.get(manifest.files.find(f=>f.relative.endsWith('website-feed.json')).key).bytes).campaigns;}
test('protected campaign observations merge privately without changing accepted/pending authority or dropping other inputs',async t=>{
  const store=memory(),first=await publishHostedInputs(store,[file({schemaVersion:1,enabled:true}),campaignFile([campaign('B000000001')])],null);
  const pending=Buffer.from('saved original intent'),accepted=Buffer.from('genuine accepted catalog');
  store.data.set('pointers/pending-run.json',{bytes:pending,etag:'"pending"'});store.data.set('pointers/last-success.json',{bytes:accepted,etag:'"accepted"'});
  const next=await syncHostedCampaignFeed(store,JSON.stringify(feed([campaign('B000000002')])));
  assert.notEqual(first.sha256,next.sha256);assert.equal((await savedCampaigns(store)).length,2);
  assert.deepEqual(store.data.get('pointers/pending-run.json').bytes,pending);assert.deepEqual(store.data.get('pointers/last-success.json').bytes,accepted);
  const size=store.data.size;assert.deepEqual(await syncHostedCampaignFeed(store,JSON.stringify(feed([campaign('B000000002')]))),next);
  assert.equal(store.data.size,size);
  const directory=await base(t);await restoreHostedInputs(store,directory,first);
  assert.equal(JSON.parse(await readFile(path.join(directory,campaignFile([]).relative))).campaigns.length,1,'old pinned intent still resolves original input');
});
test('campaign fact and content clocks are independent and an older input cannot erase a later submission',async()=>{
  const store=memory(),submitted={state:'submitted',url:'https://stupid.gifts/gifts/test-gift',observedAt:'2026-11-09T12:00:00.000Z',evidence:'test-only-submission'};
  await publishHostedInputs(store,[campaignFile([campaign('B000000001',{content:submitted})])],null);
  const incoming=campaign('B000000001',{observedAt:'2026-11-09T09:00:00.000Z',advertisedBonusRate:.2});
  await syncHostedCampaignFeed(store,JSON.stringify(feed([incoming])));
  const [current]=await savedCampaigns(store);assert.equal(current.advertisedBonusRate,.1);assert.deepEqual(current.content,submitted);
  const later={...submitted,observedAt:'2026-11-09T13:00:00.000Z',evidence:'test-only-later-readback'};
  await syncHostedCampaignFeed(store,JSON.stringify(feed([{...incoming,content:later}])));
  const [after]=await savedCampaigns(store);assert.deepEqual(after.content,later);
  assert.equal(after.observedAt,'2026-11-09T10:00:00.000Z');assert.equal(after.expiresAt,'2026-11-10T10:00:00.000Z');
});
test('malformed or wrong-account campaign inputs cannot mutate the private input pointer',async()=>{
  const store=memory();await publishHostedInputs(store,[file({schemaVersion:1})],null);const before=Buffer.from(store.data.get('pointers/operator-inputs.json').bytes);
  for(const raw of ['not json',JSON.stringify({...feed([]),scope:{...WEBSITE_CAMPAIGN_SCOPE,storeId:'different-20'}}),' '.repeat(49153)])
    await assert.rejects(syncHostedCampaignFeed(store,raw));
  assert.deepEqual(store.data.get('pointers/operator-inputs.json').bytes,before);
});
test('versioned inputs restore exact metadata while pending runs keep their original reference',async t=>{
  const store=memory(),first=await publishHostedInputs(store,[file({schemaVersion:1,enabled:false})],null);
  const old=store.data.get('pointers/operator-inputs.json').bytes;
  const second=await publishHostedInputs(store,[file({schemaVersion:1,enabled:true})],old);
  assert.deepEqual(await currentHostedInputs(store),second);
  const directory=await base(t);await restoreHostedInputs(store,directory,first);
  assert.equal(JSON.parse(await readFile(path.join(directory,file({}).relative))).enabled,false);
  await assert.rejects(restoreHostedInputs(store,directory,second),/inputs_invalid/);
});
test('inputs reject path escapes, locks, secret paths, corrupt bodies and stale pointer replacement',async t=>{
  const store=memory();
  for(const relative of ['../escape.json','locks/owner.json','credentials.json'])
    await assert.rejects(publishHostedInputs(store,[{relative,bytes:Buffer.from('{}')}],null),/inputs_invalid/);
  const ref=await publishHostedInputs(store,[file({schemaVersion:1})],null);
  await assert.rejects(publishHostedInputs(store,[file({schemaVersion:2})],null),/inputs_invalid/);
  const manifest=JSON.parse(store.data.get(ref.key).bytes);store.data.get(manifest.files[0].key).bytes=Buffer.from('{"changed":true}');
  await assert.rejects(restoreHostedInputs(store,await base(t),ref),/inputs_invalid/);
});
