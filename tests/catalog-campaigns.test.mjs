import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readCampaignFeed,WEBSITE_CAMPAIGN_SCOPE,pendingCampaignJoins,pendingCampaignActions,compileMerchandising,researchCampaignLeads} from '../lib/catalog/campaigns.ts';
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
const content=(state='not_required',patch={})=>({state,url:state==='submitted'?'https://stupid.gifts/gifts/'+product.slug:null,
  observedAt:'2026-11-05T10:00:00.000Z',evidence:'synthetic-content-proof',...patch});
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
  assert.deepEqual(leads[0].asins,[product.id,'B000000099']);assert.equal(leads[0].needsWebsiteVerification,true);
  assert.deepEqual(leads[0].publicAsins,[product.id]);assert.deepEqual(leads[0].discoveryAsins,['B000000099']);
  assert.equal(leads[0].enrollmentAvailability,'full');assert.ok(!('commissionPriority' in leads[0]));
  const outside=researchCampaignLeads([{...row,detail:{...row.detail,productAsins:['B000000099','invalid','B000000099']}}],new Set([product.id]));
  assert.deepEqual(outside[0].asins,['B000000099']);assert.deepEqual(outside[0].publicAsins,[]);
  assert.deepEqual(researchCampaignLeads([{...row,detail:undefined}],new Set([product.id])),[]);
});
test('joinable offers create manual actions but no ranking bonus; accepted/full participant can earn it',()=>{
  const reviews={[product.id]:review},offered=facts();
  assert.equal(pendingCampaignJoins([product],reviews,[offered],NOW).length,1);
  assert.equal(compileMerchandising([product],reviews,[offered],NOW)[product.id].commissionPriority,undefined);
  const accepted=facts({enrollment:'accepted',joinable:false,sellerQualified:true,requirementsReviewed:true,
    enrollmentEvidence:'synthetic-enrollment-proof',verifiedTotalRate:.18,content:content()});
  const metadata=compileMerchandising([product],reviews,[accepted],NOW)[product.id];
  assert.equal(metadata.commissionPriority,1);assert.ok(!JSON.stringify(metadata).includes('0.18'));
  assert.equal(pendingCampaignJoins([product],reviews,[accepted],NOW).length,0);
  for(const change of [{funded:false},{websiteEligible:null},{sellerQualified:false},{requirementsReviewed:false},
    {enrollmentEvidence:null},{verifiedTotalRate:null},{expiresAt:'2026-11-05T11:00:00.000Z'}])
    assert.equal(compileMerchandising([product],reviews,[{...accepted,...change}],NOW)[product.id].commissionPriority,undefined);
});
test('historical feeds stay readable; unknown content obligations do not invent fulfilled participation',()=>{
  const accepted=facts({enrollment:'accepted',joinable:false,sellerQualified:true,requirementsReviewed:true,
    enrollmentEvidence:'synthetic-enrollment-proof',verifiedTotalRate:.18});
  assert.ok(readCampaignFeed(feed([accepted])));
  const priority=campaign=>compileMerchandising([product],{[product.id]:review},[campaign],NOW)[product.id].commissionPriority;
  assert.equal(priority(accepted),undefined);
  for(const c of [content('unknown',{evidence:null}),content('required'),content('submitted',{url:'https://stupid.gifts/gifts/another-product'})])
    assert.equal(priority({...accepted,content:c}),undefined);
  assert.equal(priority({...accepted,content:content('submitted',{observedAt:'2026-11-05T13:00:00.000Z'})}),undefined);
  assert.equal(priority({...accepted,content:content()}),1);
  assert.equal(priority({...accepted,content:content('submitted')}),1);
  assert.equal(priority({...accepted,content:content('submitted'),expiresAt:'2026-11-05T11:00:00.000Z'}),undefined);
  assert.equal(priority({...accepted,content:content('submitted'),enrollment:'offered'}),undefined);
});
test('content proof is exact, website-scoped and original-dated; full provider detail parameters survive',()=>{
  const full='https://affiliate-program.amazon.com/p/connect/request?creatorId=fixture&adId=amzn1.campaign.fixture&campaignId=fixture&recc=0&early-acc=0';
  const c=facts({campaignUrl:full,content:content('submitted')});
  assert.equal(readCampaignFeed(feed([c])).campaigns[0].campaignUrl,full);
  const groups=pendingCampaignJoins([product],{[product.id]:review},[c],NOW);
  assert.ok(campaignDigest(groups).includes(full));
  assert.ok(readCampaignFeed(feed([{...c,content:content('submitted',{observedAt:'2026-11-05T11:00:00.000Z'})}])));
  for(const change of [{evidence:null},{observedAt:'not-a-date'},
    {url:'https://other.test/gifts/desk-potato'},{url:'https://stupid.gifts/gifts/desk-potato?token=secret'},
    {url:'https://stupid.gifts/gifts/desk-potato#claim'},{url:'https://stupid.gifts/gifts/desk-potato/'},
    {state:'not_required'},{state:'submitted',extra:true}])
    assert.throws(()=>readCampaignFeed(feed([{...c,content:{...c.content,...change}}])),/campaign_facts_invalid/);
  assert.throws(()=>readCampaignFeed(feed([facts({campaignUrl:full+'&mention=<!channel>'})])),/campaign_facts_invalid/);
});
test('joined campaigns with known unmet obligations produce manual content actions, not join or bonus',()=>{
  const accepted=facts({enrollment:'accepted',joinable:false,requirementsReviewed:true,
    enrollmentEvidence:'synthetic-enrollment-proof',content:content('required')});
  const actions=pendingCampaignActions([product],{[product.id]:review},[accepted],NOW);
  assert.equal(actions.length,1);assert.equal(actions[0].action,'submit_content');
  assert.equal(actions[0].products[0].url,'https://stupid.gifts/gifts/'+product.slug);
  assert.match(campaignDigest(actions),/Submit content link manually/);
  assert.equal(pendingCampaignActions([product],{[product.id]:review},[facts()],NOW)[0].action,'join');
  for(const change of [{content:content('submitted')},{content:undefined},{enrollment:'unknown'},
    {requirementsReviewed:false},{enrollmentEvidence:null},{websiteEligible:null},{expiresAt:'2026-11-05T11:00:00.000Z'}])
    assert.equal(pendingCampaignActions([product],{[product.id]:review},[{...accepted,...change}],NOW).length,0);
  assert.equal(pendingCampaignActions([],{[product.id]:review},[accepted],NOW).length,0);
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
  assert.equal((await deliverCampaignDigest(groups.map(group=>({...group,action:'join'})),{directory,send})).sent,0);
  assert.equal((await deliverCampaignDigest([{...groups[0],products:groups[0].products.map(p=>({...p,reason:'Cosmetic review wording changed.'}))}],{directory,send})).sent,0);
  assert.equal(sends,1);
  const changed=[{...groups[0],endsAt:'2026-11-21T00:00:00.000Z'}];
  await assert.rejects(deliverCampaignDigest(changed,{directory,send:async()=>{throw Error('lost response');}}));
  await assert.rejects(deliverCampaignDigest(changed,{directory,send}),/delivery_unknown/);assert.equal(sends,1);
  assert.ok(!campaignDigest([{...groups[0],name:'<!channel>'}]).includes('<!channel>'));
  assert.ok(!campaignDigest([{...groups[0],url:'https://affiliate-program.amazon.com/x?mention=<!channel>'}]).includes('<!channel>'));
  const long='many campaigns\n'.repeat(1000),chunks=digestChunks(long);
  assert.ok(chunks.length>1&&chunks.every(c=>c.length<=3000));assert.equal(chunks.join('\n'),long.trimEnd());
});
test('content-link actions have independent deduplication from earlier manual join notices',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stupid-campaign-actions-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  let sends=0;const send=async()=>({messageId:'fixture-'+(++sends)});
  const joins=pendingCampaignActions([product],{[product.id]:review},[facts()],NOW);
  assert.equal((await deliverCampaignDigest(joins,{directory,send})).sent,1);
  const joined=facts({enrollment:'accepted',joinable:false,requirementsReviewed:true,
    enrollmentEvidence:'synthetic-enrollment-proof',content:content('required')});
  const actions=pendingCampaignActions([product],{[product.id]:review},[joined],NOW);
  assert.equal((await deliverCampaignDigest(actions,{directory,send})).sent,1);
  assert.equal((await deliverCampaignDigest(actions,{directory,send})).sent,0);
  assert.equal(sends,2);
});
