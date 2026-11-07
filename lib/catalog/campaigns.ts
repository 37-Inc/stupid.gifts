import type { PublicCatalogProduct } from './types.ts';
import type { GagAppeal, Merchandising, MerchandisingSignal } from './merchandising.ts';
import { productPresentation } from './presentation.ts';

export const WEBSITE_CAMPAIGN_SCOPE=Object.freeze({storeId:'rileyehrlic0b-20',trackingId:'goose-gifts-37-20',marketplace:'www.amazon.com'});
export interface ProductReview {title:string;description:string;appeal:GagAppeal;variantGroup?:string;reason:string;reviewedAt:string}
/** Optional on historical feeds: absence means fulfillment is not recorded. */
export interface CampaignContent {
  state:'unknown'|'not_required'|'required'|'submitted';
  url:string|null;observedAt:string;evidence:string|null;
}
/** Saved provider facts only. There is deliberately no enrollment operation. */
export interface WebsiteCampaign {
  campaignId:string;campaignName:string;asin:string;campaignUrl:string;
  observedAt:string;expiresAt:string;startsAt:string;endsAt:string;
  advertisedBonusRate:number;
  /** Exact effective eligible rate, not a video/payback calculator forecast. */
  verifiedTotalRate:number|null;
  enrollment:'offered'|'accepted'|'declined'|'unknown';joinable:boolean;
  websiteEligible:boolean|null;sellerQualified:boolean|null;funded:boolean|null;
  requirementsReviewed:boolean;enrollmentEvidence:string|null;sourceEvidence:string;
  content?:CampaignContent;
}
export interface CampaignFeed {schemaVersion:1;scope:typeof WEBSITE_CAMPAIGN_SCOPE;campaigns:WebsiteCampaign[]}
/** Thin handoff from Creator Research's complete CampaignInventoryEntry export.
 * These are leads, including full/unknown offers, NEVER website participation
 * proof. Do not consume its video-sales/payback score or qualified-only pool. */
export function researchCampaignLeads(inventory:unknown,publicIds:ReadonlySet<string>){
  if(!Array.isArray(inventory)||inventory.length>10000)throw Error('campaign_inventory_invalid');
  return inventory.flatMap(entry=>{
    if(!entry||typeof entry!=='object'||!text(entry.scope?.accountScopeKey)
      ||entry.scope?.marketplace!=='www.amazon.com'||!/^[a-f0-9]{64}$/.test(entry.campaignKey)
      ||!entry.detail||!Array.isArray(entry.detail.productAsins)||!time(entry.detail.observedAt))return[];
    const asins=[...new Set<string>(entry.detail.productAsins.filter((id:unknown)=>typeof id==='string'&&/^[A-Z0-9]{10}$/.test(id)))].sort();
    if(!asins.length)return[];
    return[{campaignKey:entry.campaignKey,sourceAccountScope:entry.scope.accountScopeKey,
      observedAt:entry.detail.observedAt,asins,publicAsins:asins.filter(id=>publicIds.has(id)),
      // Nonpublic is not proof of novelty: normal admission still deduplicates
      // these leads against held/private identities and verified families.
      discoveryAsins:asins.filter(id=>!publicIds.has(id)),advertisedRate:String(entry.detail.commissionRate??''),
      startsAt:String(entry.detail.startsAt??''),endsAt:String(entry.detail.endsAt??''),
      enrollmentAvailability:entry.detail.enrollmentAvailability??'unknown',needsWebsiteVerification:true as const}];
  });
}
const time=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const text=(v:unknown,max=200):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f<>]/.test(v);
const nullableBool=(v:unknown)=>v===null||typeof v==='boolean';
const rate=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1;
function contentUrl(value:unknown):value is string {
  if(typeof value!=='string')return false;
  try{const url=new URL(value);return url.origin==='https://stupid.gifts'&&!url.username&&!url.password
    &&!url.search&&!url.hash&&/^\/gifts\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(url.pathname)
    &&url.pathname.length<=170&&url.href===value;}catch{return false;}
}
function validContent(c:WebsiteCampaign):boolean {
  const v=c.content;if(v===undefined)return true;
  return Boolean(v&&typeof v==='object'&&!Array.isArray(v)
    &&Object.keys(v).sort().join(',')==='evidence,observedAt,state,url'
    &&['unknown','not_required','required','submitted'].includes(v.state)
    &&time(v.observedAt)
    &&(v.evidence===null||text(v.evidence))&&(v.url===null||contentUrl(v.url))
    &&(!['not_required','submitted'].includes(v.state)||Boolean(v.evidence))
    &&(v.state!=='submitted'||contentUrl(v.url))&&(v.state!=='not_required'||v.url===null));
}
export function readCampaignFeed(value:unknown):CampaignFeed {
  const feed=value as CampaignFeed;
  if(!feed||Object.keys(feed).sort().join(',')!=='campaigns,schemaVersion,scope'||feed.schemaVersion!==1
    ||!feed.scope||Object.keys(feed.scope).sort().join(',')!=='marketplace,storeId,trackingId'
    ||Object.entries(WEBSITE_CAMPAIGN_SCOPE).some(([k,v])=>feed.scope[k as keyof typeof WEBSITE_CAMPAIGN_SCOPE]!==v)
    ||!Array.isArray(feed.campaigns)||feed.campaigns.length>10000)throw Error('campaign_website_scope_or_feed_invalid');
  const seen=new Set<string>();
  for(const c of feed.campaigns){
    const fields=`advertisedBonusRate,asin,campaignId,campaignName,campaignUrl,${c.content===undefined?'':'content,'}endsAt,enrollment,enrollmentEvidence,expiresAt,funded,joinable,observedAt,requirementsReviewed,sellerQualified,sourceEvidence,startsAt,verifiedTotalRate,websiteEligible`;
    let link:URL;try{link=new URL(c.campaignUrl);}catch{throw Error('campaign_link_invalid');}
    if(Object.keys(c).sort().join(',')!==fields||!text(c.campaignId)||!text(c.campaignName)
      ||!/^[A-Z0-9]{10}$/.test(c.asin)||link.origin!=='https://affiliate-program.amazon.com'
      ||c.campaignUrl.length>2048||link.username||link.password||link.hash
      ||/[\u0000-\u0020<>]/.test(c.campaignUrl)
      ||/\b(?:join|accept|enroll|submit)\b/i.test(link.pathname)
      ||[...link.searchParams.keys()].some(k=>/openid|token|signature|auth|action|session|cookie|^ac$/i.test(k))
      ||link.searchParams.has('early-acc')&&link.searchParams.get('early-acc')!=='0'
      ||!time(c.observedAt)||!time(c.expiresAt)||!time(c.startsAt)||!time(c.endsAt)
      ||Date.parse(c.expiresAt)<=Date.parse(c.observedAt)||Date.parse(c.endsAt)<=Date.parse(c.startsAt)
      ||!rate(c.advertisedBonusRate)||!(c.verifiedTotalRate===null||rate(c.verifiedTotalRate))
      ||!['offered','accepted','declined','unknown'].includes(c.enrollment)||typeof c.joinable!=='boolean'
      ||!nullableBool(c.websiteEligible)||!nullableBool(c.sellerQualified)||!nullableBool(c.funded)
      ||typeof c.requirementsReviewed!=='boolean'||!(c.enrollmentEvidence===null||text(c.enrollmentEvidence))
      ||!text(c.sourceEvidence)||!validContent(c)||seen.has(c.campaignId+'\n'+c.asin))throw Error('campaign_facts_invalid');
    seen.add(c.campaignId+'\n'+c.asin);
  }
  return structuredClone(feed);
}
export function currentCampaign(c:WebsiteCampaign,now:number):boolean {
  return Date.parse(c.observedAt)<=now&&Date.parse(c.startsAt)<=now
    &&Math.min(Date.parse(c.expiresAt),Date.parse(c.endsAt))>now;
}
export function campaignContentSatisfied(c:WebsiteCampaign,now:number,expectedUrl?:string):boolean {
  const content=c.content;
  return Boolean(content&&validContent(c)&&Date.parse(content.observedAt)<=now
    &&(content.state==='not_required'||content.state==='submitted'&&(!expectedUrl||content.url===expectedUrl)));
}
export function usableCampaign(c:WebsiteCampaign,now:number,expectedUrl?:string):boolean {
  return currentCampaign(c,now)&&c.enrollment==='accepted'&&Boolean(c.enrollmentEvidence)
    &&c.websiteEligible===true&&c.sellerQualified===true&&c.funded===true
    &&c.requirementsReviewed&&c.verifiedTotalRate!==null&&campaignContentSatisfied(c,now,expectedUrl);
}
/** Consume canonical current product text, without putting rates in public JSON. */
export function compileMerchandising(products:readonly PublicCatalogProduct[],reviews:Readonly<Record<string,ProductReview>>,
  campaigns:readonly WebsiteCampaign[],now=Date.now()):Merchandising {
  const publicProducts=new Map(products.map(p=>{const v=productPresentation(p.persistent??p);return[v.id,v];}));
  const output:Record<string,MerchandisingSignal>={};
  for(const [id,review]of Object.entries(reviews)){
    const p=publicProducts.get(id);
    if(!p||p.title!==review.title||p.description!==review.description
      ||!['standout','giftable','ordinary','unreviewed'].includes(review.appeal))continue;
    output[id]={sourceTitle:p.title,sourceDescription:p.description,appeal:review.appeal,...(review.variantGroup?{variantGroup:review.variantGroup}:{})};
  }
  const eligible=campaigns.filter(c=>publicProducts.has(c.asin)
    &&usableCampaign(c,now,'https://stupid.gifts/gifts/'+publicProducts.get(c.asin)!.slug)&&c.verifiedTotalRate!>0);
  const rates=[...new Set(eligible.map(c=>c.verifiedTotalRate!))].sort((a,b)=>a-b);
  for(const c of eligible){
    const old=output[c.asin]??{},priority=rates.indexOf(c.verifiedTotalRate!)+1;
    if(priority<(old.commissionPriority??0))continue;
    const product=publicProducts.get(c.asin)!;
    output[c.asin]={...old,sourceTitle:product.title,sourceDescription:product.description,
      commissionPriority:priority,commissionUntil:new Date(Math.min(Date.parse(c.endsAt),Date.parse(c.expiresAt))).toISOString()};
  }
  return output;
}
export interface PendingCampaign {campaignId:string;name:string;url:string;endsAt:string;bonusRate:number;
  action?:'join'|'submit_content';
  products:Array<{id:string;title:string;url:string;reason:string;bonusRate:number}>}
export function pendingCampaignJoins(products:readonly PublicCatalogProduct[],reviews:Readonly<Record<string,ProductReview>>,
  campaigns:readonly WebsiteCampaign[],now=Date.now()):PendingCampaign[]{
  const publicProducts=new Map(products.map(p=>{const v=productPresentation(p.persistent??p);return[v.id,v];}));
  const groups=new Map<string,PendingCampaign>();
  for(const c of campaigns){
    const p=publicProducts.get(c.asin),review=reviews[c.asin];
    // No join alerts for guessed gag appeal, other accounts, stale cards, closed
    // offers or products we have not actually admitted to this catalog.
    if(!p||!review||review.title!==p.title||review.description!==p.description
      ||!['standout','giftable'].includes(review.appeal)||!currentCampaign(c,now)
      ||!c.joinable||c.enrollment!=='offered'||c.advertisedBonusRate<=0||c.websiteEligible!==true||c.funded===false)continue;
    const group=groups.get(c.campaignId)??{campaignId:c.campaignId,name:c.campaignName,url:c.campaignUrl,
      endsAt:c.endsAt,bonusRate:c.advertisedBonusRate,products:[]};
    group.bonusRate=Math.max(group.bonusRate,c.advertisedBonusRate);if(c.endsAt<group.endsAt)group.endsAt=c.endsAt;
    group.products.push({id:p.id,title:p.title,url:'https://stupid.gifts/gifts/'+p.slug,reason:review.reason,bonusRate:c.advertisedBonusRate});
    groups.set(c.campaignId,group);
  }
  return [...groups.values()].map(g=>({...g,products:g.products.sort((a,b)=>a.id.localeCompare(b.id))}))
    .sort((a,b)=>b.bonusRate-a.bonusRate||a.endsAt.localeCompare(b.endsAt)||a.campaignId.localeCompare(b.campaignId));
}
/** Manual actions only; no provider enrollment or submission is performed. */
export function pendingCampaignActions(products:readonly PublicCatalogProduct[],reviews:Readonly<Record<string,ProductReview>>,
  campaigns:readonly WebsiteCampaign[],now=Date.now()):PendingCampaign[]{
  const joins=pendingCampaignJoins(products,reviews,campaigns,now).map(group=>({...group,action:'join' as const}));
  const publicProducts=new Map(products.map(p=>{const v=productPresentation(p.persistent??p);return[v.id,v];}));
  const groups=new Map<string,PendingCampaign>();
  for(const c of campaigns){
    const p=publicProducts.get(c.asin);
    if(!p||!currentCampaign(c,now)||c.enrollment!=='accepted'||!c.enrollmentEvidence
      ||c.websiteEligible!==true||!c.requirementsReviewed||c.content?.state!=='required'||!validContent(c))continue;
    const group=groups.get(c.campaignId)??{campaignId:c.campaignId,name:c.campaignName,url:c.campaignUrl,
      endsAt:c.endsAt,bonusRate:c.advertisedBonusRate,action:'submit_content' as const,products:[]};
    group.bonusRate=Math.max(group.bonusRate,c.advertisedBonusRate);
    if(c.endsAt<group.endsAt)group.endsAt=c.endsAt;
    group.products.push({id:p.id,title:p.title,url:'https://stupid.gifts/gifts/'+p.slug,
      reason:'Joined campaign requires this published content link to be submitted manually.',bonusRate:c.advertisedBonusRate});
    groups.set(c.campaignId,group);
  }
  return [...joins,...[...groups.values()].map(group=>({...group,products:group.products.sort((a,b)=>a.id.localeCompare(b.id))}))]
    .sort((a,b)=>a.endsAt.localeCompare(b.endsAt)||(a.action??'join').localeCompare(b.action??'join')||a.campaignId.localeCompare(b.campaignId));
}
