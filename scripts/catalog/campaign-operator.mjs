import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {readCampaignFeed,compileMerchandising,pendingCampaignJoins,researchCampaignLeads} from '../../lib/catalog/campaigns.ts';
import {productPresentation} from '../../lib/catalog/presentation.ts';
import baseline from '../../content/catalog-merchandising.json' with {type:'json'};
import {readMerchandising} from '../../lib/catalog/merchandising.ts';

const BASE=path.join(homedir(),'.codex/private/goose-gifts-migration'),CARE=BASE+'/daily-catalog-care';
const DIRECTORY=CARE+'/campaigns',TARGET='C0AGRSTBP5H';
const hash=value=>createHash('sha256').update(value).digest('hex');
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
async function optional(file,fallback){try{return await json(file);}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

export async function acceptedProducts(){
  const pointer=await json(CARE+'/last-success.json'),bytes=await fs.readFile(pointer.control.path);
  if(hash(bytes)!==pointer.control.sha256)throw Error('campaign_catalog_control_changed');
  const control=JSON.parse(bytes),release=control.publication.releaseId;
  if(!/^[a-zA-Z0-9._-]{1,200}$/.test(release))throw Error('campaign_catalog_identity');
  const snapshot=await fs.readFile(BASE+'/weekly-runs/runs/'+release+'/packages/'+release+'/catalog.snapshot.json');
  if(hash(snapshot)!==control.snapshotSha256)throw Error('campaign_catalog_snapshot_changed');
  return JSON.parse(snapshot).products.map(p=>productPresentation(p.persistent??p));
}
export async function readCampaignState(){
  const saved=await optional(DIRECTORY+'/website-feed.json',null);
  const feed=saved?readCampaignFeed(saved):null;
  const reviews={...baseline,...await optional(DIRECTORY+'/product-reviews.json',{})};
  return {reviews,campaigns:feed?.campaigns??[],configured:Boolean(feed)};
}
/** Optional metadata never becomes a new publisher dependency. */
export async function routineMerchandising(now=Date.now()){
  try{const [products,state]=await Promise.all([acceptedProducts(),readCampaignState()]);
    const compiled=compileMerchandising(products,state.reviews,state.campaigns,now);
    await atomic(DIRECTORY+'/last-compiled.json',compiled);return compiled;
  }catch{
    console.warn(JSON.stringify({notice:'campaign_metadata_unavailable',catalogBlocked:false}));
    try{const last=readMerchandising(await optional(DIRECTORY+'/last-compiled.json',{}))??{};
      // Source bindings protect changed items. Unverified campaign state cannot
      // retain a monetary preference, even when an old edition is reusable.
      return Object.fromEntries(Object.entries(last).map(([id,value])=>{const view={...value};delete view.commissionPriority;delete view.commissionUntil;return[id,view];}));
    }catch{return {};}
  }
}
async function atomic(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});
  const temporary=file+'.'+process.pid+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx',mode:0o600});
  try{await fs.rename(temporary,file);}catch(e){await fs.unlink(temporary).catch(()=>{});throw e;}
}
export function campaignDigest(groups){
  const lines=['Stupid Gifts — Campaigns to join manually',
    'Website account: rileyehrlic0b-20 · tracking ID: goose-gifts-37-20',
    'These are opportunities, not joined campaigns or guaranteed earnings.'];
  for(const group of groups){
    lines.push('',escape(group.name)+' — ends '+group.endsAt.slice(0,10),group.url);
    for(const p of group.products)lines.push('• '+escape(p.title)+' ('+p.id+') · advertised bonus '+(p.bonusRate*100).toFixed(1)+'% — '+escape(p.reason),p.url);
  }
  return lines.join('\n');
}
const actionKey=group=>hash(JSON.stringify({campaignId:group.campaignId,url:group.url,endsAt:group.endsAt,
  products:group.products.map(p=>({id:p.id,bonusRate:p.bonusRate}))}));
export function digestChunks(text,limit=3000){
  const chunks=[];let current='';
  for(const line of text.trimEnd().split('\n')){
    const points=Array.from(line);
    do{const part=points.splice(0,limit).join('');
      if(current.length+part.length+1>limit){chunks.push(current);current='';}
      current+=(current?'\n':'')+part;
    }while(points.length);
  }
  if(current)chunks.push(current);return chunks;
}
export async function deliverCampaignDigest(groups,{directory=DIRECTORY,send=sendSlack}={}){
  const previous=await optional(directory+'/notifications.json',{});
  const changed=groups.filter(g=>previous[g.campaignId]!==actionKey(g));
  if(!changed.length)return{state:'no_new_campaign_actions',pending:groups.length,sent:0};
  const key=hash(JSON.stringify(changed.map(actionKey))),folder=directory+'/deliveries';
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const chunks=digestChunks(campaignDigest(changed));let sent=0;
  for(let i=0;i<chunks.length;i++){
    const intent=folder+'/'+key+'-'+i+'.intent.json',receipt=folder+'/'+key+'-'+i+'.sent.json';
    if(await optional(receipt,null))continue;
    // A lost response is not proof of failure. Keep the intent and report it;
    // never blindly send the same campaign actions again on every daily retry.
    try{await fs.writeFile(intent,JSON.stringify({key,campaignIds:changed.map(g=>g.campaignId),createdAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});}
    catch(e){if(e.code==='EEXIST')throw Error('campaign_digest_delivery_unknown');throw e;}
    const message=chunks[i]+'\n\nDigest '+key.slice(0,12)+' · '+(i+1)+'/'+chunks.length+' · Join manually; participation is verified afterward.';
    const result=await send(message);
    if(!result||typeof result.messageId!=='string'||!result.messageId)throw Error('campaign_digest_delivery_unknown');
    await fs.writeFile(receipt,JSON.stringify({key,messageId:result.messageId,sentAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
    sent++;
  }
  for(const g of changed)previous[g.campaignId]=actionKey(g);
  await atomic(directory+'/notifications.json',previous);
  return {state:'campaign_actions_notified',campaigns:changed.length,pending:groups.length,sent};
}
function sendSlack(message){
  let data;
  try{data=JSON.parse(execFileSync('/opt/homebrew/bin/openclaw',['message','send','--channel','slack','--target',TARGET,'--message',message,'--json'],
    {encoding:'utf8',timeout:30000,maxBuffer:64000,env:{HOME:homedir(),PATH:process.env.PATH}}));}
  catch{throw Error('campaign_digest_delivery_unknown');}
  const messageId=data?.payload?.result?.messageId??data?.payload?.messageId??data?.messageId;
  if(typeof messageId!=='string')throw Error('campaign_digest_delivery_unknown');
  return{messageId};
}
export async function main(){
  if(!process.versions.node.startsWith('22.'))throw Error('campaign_operator_requires_node22');
  const [command,arg,...rest]=process.argv.slice(2);
  if(!['status','import','research','review','digest','test-notification'].includes(command)||rest.length||command==='digest'&&arg&&arg!=='--send'
    ||['status','test-notification'].includes(command)&&arg||['import','research','review'].includes(command)&&!arg)throw Error('campaign_operator_command');
  const products=await acceptedProducts();
  if(command==='test-notification'){
    const ack=sendSlack('Stupid Gifts — Campaign digest connected (configuration test). Future notices will include verified, joinable gag-gift campaigns and manual join links for rileyehrlic0b-20 / goose-gifts-37-20. No campaigns have been joined, and no commission preference is enabled without verified participation.');
    await atomic(DIRECTORY+'/notification-test.json',{...ack,sentAt:new Date().toISOString(),channel:TARGET});
    console.log(JSON.stringify({state:'notification_test_delivered',...ack}));return;
  }
  if(command==='research'){
    const bytes=await fs.readFile(path.resolve(arg));if(bytes.length>4*1024*1024)throw Error('campaign_feed_too_large');
    const leads=researchCampaignLeads(JSON.parse(bytes),new Set(products.map(p=>p.id)));
    await atomic(DIRECTORY+'/research-leads.json',leads);
    console.log(JSON.stringify({leads,websiteVerificationRequired:true,automaticJoining:false}));return;
  }
  if(command==='import'){
    const bytes=await fs.readFile(path.resolve(arg));if(bytes.length>4*1024*1024)throw Error('campaign_feed_too_large');
    const feed=readCampaignFeed(JSON.parse(bytes));
    const history=DIRECTORY+'/history';await fs.mkdir(history,{recursive:true,mode:0o700});
    try{await fs.writeFile(history+'/'+hash(bytes)+'.json',bytes,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
    await atomic(DIRECTORY+'/website-feed.json',feed);console.log(JSON.stringify({imported:feed.campaigns.length,automaticJoining:false}));return;
  }
  if(command==='review'){
    const input=JSON.parse(arg),members=new Map(products.map(p=>[p.id,p]));
    if(!input||input.schemaVersion!==1||Object.keys(input).sort().join(',')!=='reviews,schemaVersion'
      ||!input.reviews||typeof input.reviews!=='object'||Array.isArray(input.reviews))throw Error('campaign_review_invalid');
    const existing=await optional(DIRECTORY+'/product-reviews.json',{});
    for(const [id,r]of Object.entries(input.reviews)){
      const p=members.get(id);
      if(!p||!r||typeof r!=='object'||Object.keys(r).some(k=>!['title','description','appeal','variantGroup','reason','reviewedAt'].includes(k))
        ||r.title!==p.title||r.description!==p.description||!['standout','giftable','ordinary','unreviewed'].includes(r.appeal)
        ||typeof r.reason!=='string'||!r.reason.trim()||r.reason.length>280
        ||r.variantGroup!==undefined&&!/^[a-zA-Z0-9._-]{1,100}$/.test(r.variantGroup)
        ||!Number.isFinite(Date.parse(r.reviewedAt))||Date.parse(r.reviewedAt)>Date.now())throw Error('campaign_review_not_current_product');
      existing[id]=r;
    }
    await atomic(DIRECTORY+'/product-reviews.json',existing);console.log(JSON.stringify({reviewed:Object.keys(input.reviews).length}));return;
  }
  const state=await readCampaignState(),pending=pendingCampaignJoins(products,state.reviews,state.campaigns);
  if(command==='digest'&&arg==='--send')console.log(JSON.stringify(await deliverCampaignDigest(pending)));
  else console.log(JSON.stringify({configured:state.configured,reviewedProducts:Object.keys(state.reviews).length,
    pending,researchLeads:await optional(DIRECTORY+'/research-leads.json',[]),merchandising:compileMerchandising(products,state.reviews,state.campaigns),automaticJoining:false}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
