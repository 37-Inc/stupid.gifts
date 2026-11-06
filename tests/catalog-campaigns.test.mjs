import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readCampaignFeed,WEBSITE_CAMPAIGN_SCOPE,pendingCampaignJoins,compileMerchandising,researchCampaignLeads} from '../lib/catalog/campaigns.ts';
import {campaignDigest,deliverCampaignDigest,digestChunks} from '../scripts/catalog/campaign-operator.mjs';
const NOW=Date.parse('2026-11-05T12:00:00.000Z');
const product={id:'B000000001',source:'amazon',title:'Screaming desk potato',description:'A potato-shaped desk toy that screams.',slug:'desk-potato'};
const review={title:product.title,description:product.description,appeal:'standout',reason:'An absurd object with a clear visual joke.',reviewedAt:'2026-11-05T00:00:00.000Z'};
const facts=(patch={})=>({campaignId:'campaign-one',campaignName:'Potato campaign',asin:product.id,
  campaignUrl:'https://affiliate-program.amazon.com/creatorconnections/campaigns/campaign-one',
  observedAt:'2026-11-05T10:00:00.000Z',expiresAt:'2026-11-06T10:00:00.000Z',startsAt:'2026-11-01T00:00:00.000Z',endsAt:'2026-11-20T00:00:00.000Z',
  advertisedBonusRate:.15,verifiedTotalRate:null,enrollment:'offered',joinable:true,websiteEligible:true,
  sellerQualified:null,funded:true,requirementsReviewed:false,enrollmentEvidence:null,sourceEvidence:'synthetic-fixture-only',...patch});
const feed=c=>({schemaVersion:1,scope:{...WEBSITE_CAMPAIGN_SCOPE},campaigns:c});
test('account scope, exact product/link and provider facts are strict; no enrollment endpoint exists',()=>{
  assert.ok(readCampaignFeed(feed([facts()])));
  assert.throws(()=>readCampaignFeed({...feed([]),scope:{...WEBSITE_CAMPAIGN_SCOPE,storeId:'wrong-store'}}));
  for(const campaignUrl of ['https://evil.test/','https://affiliate-program.amazon.com/accept','https://affiliate-program.amazon.com/x?openid.token=secret'])
    assert.throws(()=>readCampaignFeed(feed([facts({campaignUrl})])));
  assert.throws(()=>readCampaignFeed(feed([facts({calculatorVerdict:'pass'})])));
});
test('complete research inventory becomes leads, never participation or calculator-filtered eligibility',()=>{
  const row={scope:{marketplace:'www.amazon.com',accountScopeKey:'other-research-account'},campaignKey:'a'.repeat(64),
    detail:{productAsins:[product.id,'B000000099'],observedAt:'2026-11-05T10:00:00.000Z',
      commissionRate:'15%',startsAt:'Nov 1',endsAt:'Nov 20',enrollmentAvailability:'full'},calculatorVerdict:'fail'};
  const leads=researchCampaignLeads([row],new Set([product.id]));assert.equal(leads.length,1);
  assert.deepEqual(leads[0].asins,[product.id]);assert.equal(leads[0].needsWebsiteVerification,true);
  assert.equal(leads[0].enrollmentAvailability,'full');assert.ok(!('commissionPriority' in leads[0]));
  assert.deepEqual(researchCampaignLeads([{...row,detail:undefined}],new Set([product.id])),[]);
});
test('joinable offers create manual actions but no ranking bonus; accepted/full participant can earn it',()=>{
  const reviews={[product.id]:review},offered=facts();
  assert.equal(pendingCampaignJoins([product],reviews,[offered],NOW).length,1);
  assert.equal(compileMerchandising([product],reviews,[offered],NOW)[product.id].commissionPriority,undefined);
  const accepted=facts({enrollment:'accepted',joinable:false,sellerQualified:true,requirementsReviewed:true,
    enrollmentEvidence:'synthetic-enrollment-proof',verifiedTotalRate:.18});
  const metadata=compileMerchandising([product],reviews,[accepted],NOW)[product.id];
  assert.equal(metadata.commissionPriority,1);assert.ok(!JSON.stringify(metadata).includes('0.18'));
  assert.equal(pendingCampaignJoins([product],reviews,[accepted],NOW).length,0);
  for(const change of [{funded:false},{websiteEligible:null},{sellerQualified:false},{requirementsReviewed:false},
    {enrollmentEvidence:null},{verifiedTotalRate:null},{expiresAt:'2026-11-05T11:00:00.000Z'}])
    assert.equal(compileMerchandising([product],reviews,[{...accepted,...change}],NOW)[product.id].commissionPriority,undefined);
});
test('only actual reviewed/admitted gag gifts notify; ordinary, stale, missing and already joined do not',()=>{
  const reviews={[product.id]:review};
  for(const data of [facts({enrollment:'accepted'}),facts({joinable:false}),facts({funded:false}),facts({websiteEligible:null}),facts({expiresAt:'2026-11-05T11:00:00.000Z'})])
    assert.equal(pendingCampaignJoins([product],reviews,[data],NOW).length,0);
  assert.equal(pendingCampaignJoins([],reviews,[facts()],NOW).length,0);
  assert.equal(pendingCampaignJoins([product],{[product.id]:{...review,appeal:'ordinary'}},[facts()],NOW).length,0);
});
test('manual digest escapes mentions, groups campaign products, deduplicates refreshes and never silently retries an uncertain send',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stupid-campaign-test-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const groups=pendingCampaignJoins([product],{[product.id]:review},[facts()],NOW);let sends=0;
  const send=async message=>{sends++;assert.match(message,/join manually/i);return{messageId:'fixture-message-id'};};
  assert.equal((await deliverCampaignDigest(groups,{directory,send})).sent,1);
  assert.equal((await deliverCampaignDigest(groups,{directory,send})).sent,0);
  assert.equal((await deliverCampaignDigest([{...groups[0],products:groups[0].products.map(p=>({...p,reason:'Cosmetic review wording changed.'}))}],{directory,send})).sent,0);
  assert.equal(sends,1);
  const changed=[{...groups[0],endsAt:'2026-11-21T00:00:00.000Z'}];
  await assert.rejects(deliverCampaignDigest(changed,{directory,send:async()=>{throw Error('lost response');}}));
  await assert.rejects(deliverCampaignDigest(changed,{directory,send}),/delivery_unknown/);assert.equal(sends,1);
  assert.ok(!campaignDigest([{...groups[0],name:'<!channel>'}]).includes('<!channel>'));
  const long='many campaigns\n'.repeat(1000),chunks=digestChunks(long);
  assert.ok(chunks.length>1&&chunks.every(c=>c.length<=3000));assert.equal(chunks.join('\n'),long.trimEnd());
});
