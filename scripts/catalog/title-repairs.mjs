import path from 'node:path';
import {createHash} from 'node:crypto';
import {productPresentation} from '../../lib/catalog/presentation.ts';
import {persistentPublicProduct} from '../../lib/catalog/display.ts';
import {validDisplayTitle} from '../../lib/catalog/merchandising.ts';
import {shortProductName} from '../../static-site/lib/product-presentation.ts';
import {SHOW_PICK_SLUGS} from '../../static-site/lib/show-rehearsal.ts';

const hash=p=>createHash('sha256').update(JSON.stringify([p.title,p.description])).digest('hex');
// Initial QA-excluded aggregate click order, November 9. IDs only: no visitor
// data, analytics credential, or new reporting service. Daily exposure is first.
export const INITIAL_TITLE_PRIORITY=['B0G9M9XPSX','B0FHKFPH5V','B0GSW1X3P4','B0BGXLMHRV','B0H3P21YPW',
  'B0CYKK1167','B0757WW6KB','B0FR5J39PR','0762462876','B07VLBVQBP'];
const empty=()=>({schemaVersion:1,reviews:{},attempts:{}});
const file=runtime=>path.join(runtime.care,'title-repairs/current.json');
const optional=async read=>{try{return await read();}catch(e){if(e.code==='ENOENT')return null;throw e;}};
export function readTitleRepairs(value){
  if(!value||value.schemaVersion!==1||!value.reviews||typeof value.reviews!=='object'||Array.isArray(value.reviews)
    ||!value.attempts||typeof value.attempts!=='object'||Array.isArray(value.attempts)
    ||Object.keys(value).sort().join(',')!=='attempts,reviews,schemaVersion'
    ||Object.keys(value.reviews).length>10000||Object.keys(value.attempts).length>10000)throw Error('title_reviews_invalid');
  for(const [id,p] of Object.entries(value.reviews))if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)
    ||!p||typeof p.sourceTitle!=='string'||typeof p.sourceDescription!=='string'||!validDisplayTitle(p.displayTitle)
    ||Object.keys(p).sort().join(',')!=='displayTitle,sourceDescription,sourceTitle')throw Error('title_reviews_invalid');
  for(const [id,digest] of Object.entries(value.attempts))if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||!/^[a-f0-9]{64}$/.test(digest))throw Error('title_reviews_invalid');
  return value;
}
export async function savedTitleRepairs(runtime){
  const bytes=await optional(()=>runtime.state.readPointer('title-repairs',file(runtime)));
  return{bytes,state:bytes?readTitleRepairs(JSON.parse(Buffer.from(bytes).toString('utf8'))):empty()};
}
/** One finite editorial batch, not a supplier allowance or publication gate. */
export function selectTitleRepairs(products,state,{exposedIds=[],priorityIds=[],limit=50}={}){
  const visible=new Set(exposedIds),shown=p=>visible.has(p.id)||SHOW_PICK_SLUGS.includes(p.slug);
  const ranked=new Map((Array.isArray(priorityIds)?priorityIds:[]).map((id,i)=>[id,i]));
  return products.filter(p=>/(?:\.{3}|…)\s*$/.test(shortProductName(p.title))
    &&state.attempts[p.id]!==hash(p)
    &&!(state.reviews[p.id]?.sourceTitle===p.title&&state.reviews[p.id]?.sourceDescription===p.description))
    .sort((a,b)=>Number(shown(b))-Number(shown(a))
      ||(ranked.get(a.id)??Infinity)-(ranked.get(b.id)??Infinity)||a.id.localeCompare(b.id))
    .slice(0,limit);
}
export async function repairTitleQueue({runtime,db,revision,day,editor,exposedIds=[],priorityIds=[]}){
  const directory=path.join(runtime.care,'title-repairs',day);
  const saved=await optional(()=>runtime.state.bytes(directory+'/result.json'));
  if(saved){
    const result=JSON.parse(Buffer.from(saved).toString('utf8'));readTitleRepairs(result.state);
    await runtime.state.pointer('title-repairs',file(runtime),result.state,result.previous===null?null:Buffer.from(result.previous));
    return result;
  }
  let plan=await optional(()=>runtime.state.bytes(directory+'/plan.json'));
  if(plan)plan=JSON.parse(Buffer.from(plan).toString('utf8'));
  else{
    const previous=await savedTitleRepairs(runtime),products=[];let after='';
    for(;;){
      const rows=(await db.prepare('SELECT public_id,public_display_json FROM catalog_public_products WHERE catalog_revision=? AND public_id>? ORDER BY public_id LIMIT 128')
        .bind(revision,after).all()).results;
      for(const row of rows){const p=persistentPublicProduct(JSON.parse(row.public_display_json));if(p)products.push(productPresentation(p));after=row.public_id;}
      if(rows.length<128)break;
    }
    const eligible=selectTitleRepairs(products,previous.state,{exposedIds,priorityIds,limit:products.length});
    const deferred=products.filter(p=>/(?:\.{3}|…)\s*$/.test(shortProductName(p.title))
      &&previous.state.attempts[p.id]===hash(p)&&!(previous.state.reviews[p.id]?.sourceTitle===p.title
        &&previous.state.reviews[p.id]?.sourceDescription===p.description)).length;
    plan={previous:previous.bytes?Buffer.from(previous.bytes).toString('utf8'):null,state:previous.state,
      remaining:Math.max(0,eligible.length-50),deferred,
      products:eligible.slice(0,50).map(p=>({id:p.id,title:p.title,description:p.description}))};
    await runtime.state.put(directory+'/plan.json',plan);
  }
  const state=structuredClone(readTitleRepairs(plan.state));
  let approved=[],attention;
  if(plan.products.length){
    try{approved=await editor.repairTitles(plan.products);
      if(!Array.isArray(approved)||new Set(approved.map(p=>p.id)).size!==approved.length
        ||approved.some(p=>!validDisplayTitle(p.displayTitle)
          ||!plan.products.some(v=>v.id===p.id&&v.title===p.sourceTitle&&v.description===p.sourceDescription)))
        throw Error('title_review_scope');
    }
    catch(error){approved=[];attention=error.message==='editorial_dispatch_uncertain'?'title_review_dispatch_unknown':'title_review_unavailable';}
    for(const p of plan.products)state.attempts[p.id]=hash(p);
    for(const p of approved)state.reviews[p.id]={sourceTitle:p.sourceTitle,sourceDescription:p.sourceDescription,displayTitle:p.displayTitle};
  }
  const result={state,previous:plan.previous,selected:plan.products.length,approved:approved.length,
    remaining:plan.remaining,deferred:plan.deferred+plan.products.length-approved.length,...(attention?{attention}:{})};
  await runtime.state.put(directory+'/result.json',result);
  await runtime.state.pointer('title-repairs',file(runtime),state,plan.previous===null?null:Buffer.from(plan.previous));
  return result;
}
