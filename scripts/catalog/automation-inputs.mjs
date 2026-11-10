import path from 'node:path';
import baseline from '../../content/catalog-merchandising.json' with {type:'json'};
import {readCampaignFeed,compileMerchandising} from '../../lib/catalog/campaigns.ts';
import {productPresentation} from '../../lib/catalog/presentation.ts';
import {resolvePublicProduct} from '../../lib/catalog/display.ts';
import {searchDemandTopic} from '../../lib/search-demand.ts';
import {searchDemandReportSql} from '../ops/search-demand-report.mjs';
import {savedTitleRepairs} from './title-repairs.mjs';

const optional=async(runtime,file,fallback)=>{
  try{return JSON.parse(await runtime.state.bytes(file));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}
};

/** Optional campaign facts use current accepted product fields, not a local
 * copy of a previous build. Missing/stale account evidence means neutral money.
 * No account login, automatic enrollment or external request exists here. */
async function campaignMerchandising({runtime,db,seal,now=Date.now()}){
  try{
    const directory=path.join(runtime.care,'campaigns');
    const saved=await optional(runtime,path.join(directory,'website-feed.json'),null),campaigns=saved?readCampaignFeed(saved).campaigns:[];
    const reviews={...baseline,...await optional(runtime,path.join(directory,'product-reviews.json'),{})};
    const ids=[...new Set([...Object.keys(reviews),...campaigns.map(c=>c.asin)])],products=[];
    for(let offset=0;offset<ids.length;offset+=30){
      const rows=(await db.prepare(`SELECT public_display_json FROM catalog_public_products WHERE catalog_revision=?
        AND product_id IN (SELECT value FROM json_each(?))`).bind(seal.projectionReceipt.catalog_revision,JSON.stringify(ids.slice(offset,offset+30))).all()).results;
      for(const row of rows){const product=resolvePublicProduct(JSON.parse(row.public_display_json),now);if(product)products.push(productPresentation(product));}
    }
    return compileMerchandising(products,reviews,campaigns,now);
  }catch{return{};}
}
export async function loadAutomationMerchandising(options){
  const signals=await campaignMerchandising(options);
  try{const {state}=await savedTitleRepairs(options.runtime);
    for(const [id,review] of Object.entries(state.reviews)){
      const old=signals[id];
      signals[id]={...(old?.sourceTitle===review.sourceTitle&&old?.sourceDescription===review.sourceDescription?old:{}),...review};
    }
  }catch{/* Optional title metadata never gates catalog or campaign care. */}
  return signals;
}

/** A finite input cohort, not an earnings forecast or a taste/acceptance gate.
 * Only aggregate repeated zero/sparse topics become optional search hints.
 * All existing/held identities are deduplicated before a new lead is fetched.
 */
export async function loadAutomationDiscoveryInputs({runtime,db,now=Date.now()}){
  let leads=[];try{leads=await optional(runtime,path.join(runtime.care,'campaigns/research-leads.json'),[]);}catch{/* optional */}
  const existing=new Set((await db.prepare('SELECT id FROM products').all()).results.map(p=>p.id));
  const fresh=Array.isArray(leads)?leads.filter(lead=>Number.isFinite(Date.parse(lead.observedAt))
    &&Date.parse(lead.observedAt)<=now&&Date.parse(lead.observedAt)>now-7*86400000
    &&(!lead.endsAt||Number.isFinite(Date.parse(lead.endsAt))&&Date.parse(lead.endsAt)>now)):[];
  // Advertised rates only order which leads we inspect; they confer NO boost.
  const percentage=value=>{const match=String(value).match(/^(\d+(?:\.\d+)?)\s*%?$/);return match?Number(match[1]):0;};
  fresh.sort((a,b)=>percentage(b.advertisedRate)-percentage(a.advertisedRate)||String(a.campaignKey).localeCompare(String(b.campaignKey)));
  const leadAsins=[...new Set(fresh.flatMap(lead=>Array.isArray(lead.discoveryAsins)?lead.discoveryAsins:lead.asins??[]))]
    .filter(id=>typeof id==='string'&&/^[A-Z0-9]{10}$/.test(id)&&!existing.has(id)).slice(0,10);
  let topics=[];try{const report=(await db.prepare(searchDemandReportSql(7)).all()).results;
    topics=report.filter(row=>Number(row.completed_searches)>=3&&Number(row.zero_result_searches)+Number(row.sparse_searches)>=2)
      .map(row=>searchDemandTopic(row.topic)).filter(Boolean).slice(0,2);
  }catch{/* Telemetry cannot prevent ordinary discovery. */}
  return{leadAsins,searchTopics:topics};
}
