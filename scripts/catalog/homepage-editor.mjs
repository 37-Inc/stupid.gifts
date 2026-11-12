import fs from 'node:fs/promises';
import path from 'node:path';
import {homedir} from 'node:os';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {readHomepageEdition} from '../../lib/catalog/homepage-edition.ts';
import {resolvePublicProduct} from '../../lib/catalog/display.ts';
import {pacificCatalogCalendar} from '../ops/catalog-daily.mjs';
import {resolveWranglerOAuth} from './check-cloudflare-runner.ts';
import {createCatalogD1ReadOnlyRest} from './d1-write-rest.ts';
import {routineHomepageEdition} from './daily-operator.mjs';
import { productPresentation } from '../../lib/catalog/presentation.ts';
import {routineMerchandising} from './campaign-operator.mjs';
import {merchandisingForProduct} from '../../lib/catalog/merchandising.ts';
import {runtimePresentation} from '../../lib/catalog/runtime-presentation.ts';

const CARE=path.join(homedir(),'.codex/private/goose-gifts-migration/daily-catalog-care');
const scope={accountId:'7f05a1dcb6e16f9c239564a0293bbe74',databaseId:'77b30f85-c57c-4acb-a0df-53368806c2a6',databaseName:'stupid-gifts-production'};
const limits={requests:10,statements:12,reportedRowsRead:50000,reportedRowsWritten:1};
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));

/** Live manual ordering is the editor's starting point, not an older package.
 * Both public IDs (admin) and merchant IDs (historical editions) resolve once
 * to the catalog IDs used by refresh, candidate selection and model review. */
export async function currentHomepageEdition(db,fallback){
  const row=(await db.prepare("SELECT payload_json FROM catalog_runtime_collections WHERE name='/collections/homepage' ORDER BY revision DESC LIMIT 1").all()).results[0];
  const edition=row&&readHomepageEdition(JSON.parse(row.payload_json).edition);
  if(!edition)return fallback;
  const rows=(await db.prepare('SELECT id,public_id FROM products WHERE id IN (SELECT value FROM json_each(?)) OR public_id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...edition.anchors,...edition.rotation]),JSON.stringify([...edition.anchors,...edition.rotation])).all()).results;
  const ids=new Map(rows.flatMap(p=>[[p.id,p.id],[p.public_id,p.id]]));
  return readHomepageEdition({...edition,anchors:edition.anchors.map(id=>ids.get(id)??id),rotation:edition.rotation.map(id=>ids.get(id)??id)})??fallback;
}

/** A stable shuffled sweep reaches every catalog identity, not just a contiguous
 * block of books or similar marketplace IDs. No keywords or quality heuristics. */
export function candidateSweep(ids,day,limit=72){
  const hash=id=>createHash('sha256').update(id).digest('hex');
  const ordered=ids.map(id=>({id,key:hash(id)})).sort((a,b)=>a.key.localeCompare(b.key)).map(p=>p.id);
  const offset=ordered.length?(Math.floor(Date.parse(day)/86400000)*limit)%ordered.length:0;
  return [...ordered.slice(offset),...ordered.slice(0,offset)].slice(0,limit);
}

/** Read accepted public presentation only. Newest, prior favorites and a
 * calendar-driven sweep cover the WHOLE catalog, without category keywords. */
export async function homepageBrief(db,revision,prior,day,now=Date.now(),merchandising={},edits={}){
  const ids=(await db.prepare('SELECT product_id FROM catalog_public_products WHERE catalog_revision=?').bind(revision).all()).results.map(p=>p.product_id);
  const sample=candidateSweep(ids,day),count=ids.length;
  const query='SELECT v.public_display_json FROM catalog_public_products v';
  const previous=[...prior.anchors,...prior.rotation];
  const batches=await db.batch([
    db.prepare(query+' JOIN products p ON p.id=v.product_id WHERE v.catalog_revision=? AND p.created_at IS NOT NULL ORDER BY p.created_at DESC,v.product_id LIMIT 20').bind(revision),
    db.prepare(query+' WHERE v.catalog_revision=? AND v.product_id IN (SELECT value FROM json_each(?))').bind(revision,JSON.stringify(previous)),
    db.prepare(query+' WHERE v.catalog_revision=? AND v.product_id IN (SELECT value FROM json_each(?))').bind(revision,JSON.stringify(sample)),
    db.prepare(query+' WHERE v.catalog_revision=? AND v.product_id IN (SELECT value FROM json_each(?))').bind(revision,JSON.stringify(Object.keys(merchandising).filter(id=>merchandising[id].commissionPriority))),
  ]);
  const candidates=new Map();
  for(let lane=0;lane<batches.length;lane++)for(const row of batches[lane].results){
    const raw=resolvePublicProduct(JSON.parse(row.public_display_json),now);
    const p=raw&&runtimePresentation({products:[productPresentation(raw)],heldProducts:[]},edits).snapshot.products[0];
    if(!p||!p.description?.trim()||p.imageUrl.includes('gift-placeholder'))continue;
    const item=candidates.get(p.id)||{id:p.id,title:p.title,
      description:p.description,
      imageUrl:new URL(p.imageUrl,'https://stupid.gifts').href,url:'https://stupid.gifts/gifts/'+p.slug,
      merchandising:merchandisingForProduct(p,merchandising)??{},lanes:[]};
    item.lanes.push(['newest','previous','rediscovery','verified-campaign'][lane]);candidates.set(p.id,item);
  }
  return{day,catalogRevision:revision,catalogSize:count,previous:prior,candidates:[...candidates.values()],readOnlyUsage:db.metrics()};
}

const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function previewHtml(brief){
  return'<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Stupid Gifts — Editorial candidates</title><style>body{font:15px system-ui;margin:24px;background:white}main{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px}article{border:1px solid #ddd;padding:10px}img{width:100%;height:170px;object-fit:contain}h2{font-size:14px}code{font-size:11px}p{font-size:12px}</style><h1>Editorial candidates — '+escape(brief.day)+'</h1><p>Choose actual funny, attractive gifts, not categories. Existing public catalog only. No product mutations.</p><main>'+brief.candidates.map(p=>'<article><img loading="lazy" src="'+escape(p.imageUrl)+'"><h2>'+escape(p.title)+'</h2><code>'+escape(p.id)+'</code><p>'+escape(p.description)+'</p><small>'+escape(p.lanes.join(', '))+'</small></article>').join('')+'</main>';
}

export async function validateSelection(db,revision,edition,edits={}){
  const ids=[...edition.anchors,...edition.rotation];
  const rows=(await db.prepare('SELECT public_display_json FROM catalog_public_products WHERE catalog_revision=? AND product_id IN (SELECT value FROM json_each(?))')
    .bind(revision,JSON.stringify(ids)).all()).results;
  const available=new Set(rows.flatMap(row=>{const raw=resolvePublicProduct(JSON.parse(row.public_display_json),Date.now());
    const p=raw&&runtimePresentation({products:[raw],heldProducts:[]},edits).snapshot.products[0];
    return p&&p.description?.trim()&&!p.imageUrl.includes('gift-placeholder')?[p.id]:[];}));
  if(ids.some(id=>!available.has(id)))throw Error('homepage_selection_not_public_or_missing_photo');
}

/** Hosted/editor API seam. The owning coordinator supplies the scoped saved
 * editor and atomic ID-only saver. Failure never changes the current edition.
 */
export async function automatedHomepage({db,revision,prior,day,merchandising={},edits={},editor,save,now=Date.now()}){
  if(typeof editor?.selectHomepage!=='function'||typeof save!=='function')throw Error('homepage_editor_capability');
  try{
    const brief=await homepageBrief(db,revision,prior,day,now,merchandising,edits);
    const edition=await editor.selectHomepage(brief);
    await validateSelection(db,revision,edition,edits);
    await save(edition);
    return{state:'curated',edition};
  }catch{
    // The editor's private journal retains exact pending/error evidence. Do not
    // log product/provider bodies or erase an uncertain model dispatch here.
    return{state:'last_good',edition:prior,attention:'homepage_editor_unavailable'};
  }
}

export async function main(){
  if(process.versions.node.split('.')[0]!=='22')throw Error('homepage_requires_node22');
  const [command,arg,...extra]=process.argv.slice(2);
  if(!['brief','preview','select'].includes(command)||extra.length||command!=='select'&&arg)throw Error('homepage_command');
  if(Object.keys(process.env).some(k=>/^(AMAZON_|OPENAI_|POSTGRES_|VERCEL_|CATALOG_)/.test(k)))throw Error('homepage_ambient_configuration');
  const day=pacificCatalogCalendar().day,priorPointer=await read(CARE+'/last-success.json');
  const control=await read(priorPointer.control.path),revision=control.publication.releaseId;
  const prior=await routineHomepageEdition(day,priorPointer.control.path);
  const directory=CARE+'/homepage';await fs.mkdir(directory,{recursive:true,mode:0o700});
  const file=directory+'/'+day+'.json';
  if(command!=='select')try{const existing=readHomepageEdition(await read(file));if(existing){console.log(JSON.stringify({state:'already_curated',edition:existing}));return;}}
  catch(e){if(e.code!=='ENOENT')throw e;}
  const token=await resolveWranglerOAuth(),db=await createCatalogD1ReadOnlyRest({...scope,token,limits});
  try{
    if(command==='select'){
      const edition=readHomepageEdition(JSON.parse(arg));if(!edition||edition.day!==day)throw Error('homepage_selection_invalid');
      await validateSelection(db,revision,edition);
      // This is a presentation draft, not a run journal. Preparation captures
      // its value into the immutable config; later edits cannot change a run.
      const temporary=file+'.'+Date.now()+'.tmp';
      await fs.writeFile(temporary,JSON.stringify(edition)+'\n',{flag:'wx',mode:0o600});
      await fs.rename(temporary,file);
      console.log(JSON.stringify({state:'curated',path:file,edition,readOnlyUsage:db.metrics()}));return;
    }
    const merchandising=await routineMerchandising();
    const brief=await homepageBrief(db,revision,prior,day,Date.now(),merchandising);console.log(JSON.stringify(brief));
    if(command==='preview'){
      const html=previewHtml(brief),server=createServer((req,res)=>{
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});res.end(html);
      });
      server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({preview:'http://127.0.0.1:'+server.address().port})));
      setTimeout(()=>server.close(),10*60*1000).unref();
    }
  }finally{
    // Numeric evidence only; no supplier bodies/photos persist in this helper.
    await fs.writeFile(directory+'/'+day+'-'+Date.now()+'-usage.json',JSON.stringify({revision,command,observedAt:new Date().toISOString(),...db.metrics()})+'\n',{flag:'wx',mode:0o600});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
