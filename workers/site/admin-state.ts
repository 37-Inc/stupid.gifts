import {readCampaignFeed,pendingCampaignActions,currentCampaign,usableCampaign} from '../../lib/catalog/campaigns.ts';
import type {ProductReview} from '../../lib/catalog/campaigns.ts';
import type {PublicCatalogProduct} from '../../lib/catalog/types.ts';
import {runtimeDigest} from '../../lib/catalog/runtime-catalog.ts';
import type {RuntimeCatalogBucket} from './runtime-data.ts';

function objectReader(bucket:RuntimeCatalogBucket){
  return async(key:string,sha?:string)=>{
    const object=await bucket.get('catalog-v1/'+key);if(!object)throw Error('missing');
    const bytes=new Uint8Array(await object.arrayBuffer());
    if(bytes.length>10*1024*1024||sha&&await runtimeDigest(bytes)!==sha)throw Error('changed');
    return JSON.parse(new TextDecoder().decode(bytes));
  };
}
export async function adminHostedStatus(bucket:RuntimeCatalogBucket|undefined){
  if(!bucket)return{state:'unknown'};
  try{
    const read=objectReader(bucket),pending=await read('pointers/pending-run.json'),success=await read('pointers/last-success.json');
    const bound=async(ref:{path:string;sha256:string})=>{
      const relative=ref.path?.replace('/home/runner/.codex/private/goose-gifts-migration/','');
      if(!/^daily-catalog-care\/runs\/[A-Za-z0-9_-]+\/(?:hosted-run|catalog-control)\.json$/.test(relative)
        ||!/^[a-f0-9]{64}$/.test(ref.sha256))throw Error('reference');
      return read('operator/'+relative,ref.sha256);
    };
    const control=await bound(success.control),run=pending.pending?await bound(pending.pending):null;
    return{state:'observed',pending:run?{runKey:run.runKey,source:run.source,day:run.day,kind:run.kind}:null,
      savedSuccessor:{releaseId:control.publication.releaseId,receiptSha256:control.publication.receiptSha256,
        snapshotSha256:control.snapshotSha256,controlSha256:success.control.sha256},
      note:'Saved control observation; compare with the live catalog, D1 receipt and owner.'};
  }catch{return{state:'unknown'};}
}
/** Staff-only, fixed input names. No arbitrary R2 key or provider operation. */
export async function adminCampaigns(bucket:RuntimeCatalogBucket|undefined,products:PublicCatalogProduct[],now:number){
  if(!bucket)return{privateFeed:'unavailable',manualActions:null};
  try{
    const read=objectReader(bucket);
    const ref=await read('pointers/operator-inputs.json');
    if(ref.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(ref.sha256)||ref.key!==`inputs/${ref.sha256}.json`)throw Error('reference');
    const manifest=await read(ref.key,ref.sha256);
    if(manifest.schemaVersion!==1||manifest.kind!=='catalog-hosted-inputs'||!Array.isArray(manifest.files)||manifest.files.length>20)throw Error('manifest');
    const file=async(name:string)=>{
      const matches=manifest.files.filter((f:{relative:string})=>f.relative==='daily-catalog-care/campaigns/'+name+'.json');
      if(matches.length!==1)throw Error('missing');const f=matches[0];
      if(!/^[a-f0-9]{64}$/.test(f.sha256)||f.key!==`inputs/files/${f.sha256}.json`)throw Error('reference');
      return read(f.key,f.sha256);
    };
    const feed=readCampaignFeed(await file('website-feed'));
    const reviews:Record<string,ProductReview>=await file('product-reviews');
    if(!reviews||Array.isArray(reviews)||typeof reviews!=='object')throw Error('reviews');
    const ids=new Map(products.map(p=>[p.id,p]));
    return{privateFeed:'saved_observations',scope:feed.scope,inputsSha256:ref.sha256,
      manualActions:pendingCampaignActions(products,reviews,feed.campaigns,now),
      campaigns:feed.campaigns.filter(c=>ids.has(c.asin)).map(c=>({asin:c.asin,campaignId:c.campaignId,name:c.campaignName,url:c.campaignUrl,
        observedAt:c.observedAt,expiresAt:c.expiresAt,endsAt:c.endsAt,enrollment:c.enrollment,content:c.content?.state??'unknown',
        fresh:currentCampaign(c,now),verifiedRate:usableCampaign(c,now,'https://stupid.gifts/gifts/'+ids.get(c.asin)!.slug)?c.verifiedTotalRate:null}))};
  }catch{return{privateFeed:'unavailable',manualActions:null};}
}
