import {renderToReadableStream} from 'react-dom/server.browser';
import {RuntimeApp} from '../../static-site/runtime/App.tsx';
import type {RuntimePageProps} from '../../static-site/runtime/App.tsx';
import {createRuntimeCatalogReader} from './runtime-data.ts';
import type {RuntimeCatalogEnv,RuntimeCatalogView} from './runtime-data.ts';
import {runtimeDigest,runtimeAssetKey} from '../../lib/catalog/runtime-catalog.ts';
import {createSiteWorker} from './index.ts';
import {d1SearchAdapters} from './d1-search.ts';
import type {SiteEnv} from './bindings.ts';
import type {CatalogSnapshot,PublicCatalogProduct,SiteAssetManifest} from '../../lib/catalog/types.ts';
import {catalogDeadline,persistentPublicProduct,resolvePublicProduct,earliestCatalogExpiry} from '../../lib/catalog/display.ts';
import {readHomepageEdition} from '../../lib/catalog/homepage-edition.ts';
import {productTitleView,readMerchandising} from '../../lib/catalog/merchandising.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {projectCard} from '../../static-site/lib/card-shard.ts';
import {guides,selectGuideProducts,guideSchema} from '../../static-site/lib/guides.ts';
import {createRelatedGiftSelector} from '../../static-site/lib/related-gifts.ts';
import {SHOW_PRESETS,ACTIVE_SHOW_PRESET} from '../../static-site/lib/show-rehearsal.ts';
import {buildGiftPageSchema} from '../../lib/gift-page-schema.ts';
import {shortProductName} from '../../static-site/lib/product-presentation.ts';
import {PHOTO_SHARD_SIZE,PHOTO_PLACEHOLDER} from '../../static-site/lib/photo-shard.ts';
import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import {createStaticFeedPlan} from './feed.ts';

export type RuntimeSiteEnv=SiteEnv&RuntimeCatalogEnv&{DB:CatalogD1};
export interface RuntimeSiteOptions {
  codeSha:string;releaseId:string;manifestSha256:string;clientPath:string;cssPath:string;brandOgPath?:string;analytics?:boolean;
  now?:()=>number;readView?:(env:RuntimeSiteEnv)=>Promise<RuntimeCatalogView>;
  handleRequest?:(request:Request,env:RuntimeSiteEnv,view:RuntimeCatalogView)=>Promise<Response|undefined>;
}
const ORIGIN='https://stupid.gifts';
const PHOTO_CACHE_TTL=300;
const PHOTO_PATH=/^\/catalog\/[a-f0-9]{64}\/photos-[1-9][0-9]*\.json$/;
function photoResponse(response:Response,until:number,at:number,state:'HIT'|'MISS'){
  const headers=new Headers(response.headers),seconds=Math.max(0,Math.floor((until-at)/1000));
  headers.set('Cache-Control',`public, max-age=${seconds}, must-revalidate`);
  headers.set('X-Photo-Cache-Until',String(until));headers.set('X-Photo-Cache',state);
  headers.set('Date',new Date(at).toUTCString());headers.delete('Age');
  return new Response(response.body,{status:response.status,headers});
}
const safeJson=(value:unknown)=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
function campaignQuery(params:URLSearchParams){
  const result=new URLSearchParams();for(const key of ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','gclid','gbraid','wbraid']){
    const value=params.get(key);if(value&&/^[a-zA-Z0-9._~:-]{1,200}$/.test(value))result.set(key,value);}
  return result.size?'?'+result:'';
}
const pageRoute=(path:string,indexable=true)=>({assetPath:path==='/'?'/index.html':path+'.html',safeAssetPath:'/safe/catalog.html',
  eligibleUntil:null,state:'ready' as const,indexable,persistentIndexable:indexable});
function collection(view:RuntimeCatalogView,name:string){
  const payload=view.collections[name]?.payload??view.collections[name==='active-show'?'/active-show':'/collections/'+name]?.payload;
  return payload&&typeof payload==='object'&&!Array.isArray(payload)?payload as Record<string,unknown>:{};
}
function selectedProducts(snapshot:CatalogSnapshot,at:number,merchandising:SiteAssetManifest['merchandising']){
  return snapshot.products.flatMap(original=>{const product=persistentPublicProduct(original)??resolvePublicProduct(original,at);
    return product&&product.isActive&&product.imageUrl&&product.affiliateUrl?[productTitleView(product,merchandising??{})]:[];});
}
async function browseProducts(products:PublicCatalogProduct[],snapshot:CatalogSnapshot,editionInput:unknown){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(snapshot.generatedAt));
  const scores=new Map(await Promise.all(products.map(async p=>[p.id,await runtimeDigest(parts+':'+p.id)] as const)));
  const ranked=[...products].sort((a,b)=>scores.get(a.id)!.slice(0,8).localeCompare(scores.get(b.id)!.slice(0,8))||a.id.localeCompare(b.id));
  const edition=readHomepageEdition(editionInput);if(!edition)return ranked;
  const byId=new Map(ranked.flatMap(p=>[[p.id,p],[p.publicId,p]] as const)),used=new Set<string>();
  const picks=(ids:string[])=>ids.flatMap(id=>{const p=byId.get(id);if(!p||used.has(p.id))return[];used.add(p.id);return[p];});
  const anchors=picks(edition.anchors),rotation=picks(edition.rotation),opening:PublicCatalogProduct[]=[];
  for(let i=0;i<24;i++){const p=[0,1,4,8,13,19].includes(i)?anchors.shift()??rotation.shift():rotation.shift()??anchors.shift();if(p)opening.push(p);}
  return [...opening,...ranked.filter(p=>!used.has(p.id))];
}
/** A photo lapse changes a homepage slot, never a product or the saved edition. */
function picturedOpening(ordered:PublicCatalogProduct[],slots:Readonly<Record<string,unknown>>){
  const pictured=(p:PublicCatalogProduct)=>p.imageUrl!==PHOTO_PLACEHOLDER||Object.hasOwn(slots,p.id);
  const opening=ordered.slice(0,24);
  let next=opening.length;
  for(let i=0;i<opening.length;i++){
    if(pictured(opening[i]))continue;
    while(next<ordered.length&&!pictured(ordered[next]))next++;
    if(next===ordered.length)break;
    opening[i]=ordered[next++];
  }
  if(next===opening.length)return ordered;
  const used=new Set(opening.map(p=>p.id));
  return [...opening,...ordered.filter(p=>!used.has(p.id))];
}
/** Only descriptors from accepted public data can address R2. No URL, arbitrary
 * object key, private journal or supplier endpoint is accepted from a caller. */
export async function runtimePublicAsset(request:Request,env:RuntimeSiteEnv,view:RuntimeCatalogView,path:string,now=Date.now){
  const asset=view.data.assets[path];if(!asset||!env.CATALOG_DATA)return json({error:'Not found'},404);
  const deadline=catalogDeadline(asset.eligibleUntil);if(!(deadline>now()))return json({error:'Not found'},404);
  const object=await env.CATALOG_DATA.get(runtimeAssetKey(asset));if(!object)return json({error:'Asset unavailable'},503);
  const bytes=new Uint8Array(await object.arrayBuffer());
  if(bytes.length>32*1024*1024||await runtimeDigest(bytes)!==asset.sha256)return json({error:'Asset unavailable'},503);
  if(!(deadline>now()))return json({error:'Not found'},404);
  const seconds=asset.eligibleUntil===null?300:Math.max(0,Math.min(300,Math.floor((deadline-now())/1000)));
  return new Response(request.method==='HEAD'?null:bytes,{headers:{'Content-Type':asset.contentType,'Cache-Control':`public, max-age=${seconds}, s-maxage=${seconds}, must-revalidate`,
    ETag:'"'+asset.sha256+'"','X-Content-Type-Options':'nosniff'}});
}
async function prepare(view:RuntimeCatalogView,options:RuntimeSiteOptions,now:()=>number){
  const snapshot=view.data.snapshot,merchandising=readMerchandising(view.data.merchandising)??{},at=now();
  const products=selectedProducts(snapshot,at,merchandising),edition=collection(view,'homepage').edition??view.data.homepage;
  const virtual=new Map<string,{value:unknown;deadline:number}>();
  const photoVersion=await runtimeDigest(canonicalJson({revision:snapshot.catalogRevision,photos:snapshot.products.filter(p=>p.persistent&&p.eligibleUntil!==null).map(p=>[p.id,p.imageUrl,p.eligibleUntil])}));
  const photoBase='/catalog/'+photoVersion,index:{schemaVersion:1;status:'ready';version:string;products:Record<string,{shard:number;eligibleUntil:string}>}={schemaVersion:1,status:'ready',version:photoVersion,products:{}};
  const photoGroups=new Map<string,PublicCatalogProduct[]>();
  for(const p of snapshot.products)if(p.persistent&&p.eligibleUntil!==null&&catalogDeadline(p.eligibleUntil)>at&&p.imageUrl.startsWith('https://')){
    const group=photoGroups.get(p.eligibleUntil)??[];group.push(p);photoGroups.set(p.eligibleUntil,group);}
  let photoShard=0;
  for(const [eligibleUntil,group]of photoGroups)for(let i=0;i<group.length;i+=PHOTO_SHARD_SIZE){const batch=group.slice(i,i+PHOTO_SHARD_SIZE);photoShard++;
    for(const p of batch)index.products[p.id]={shard:photoShard,eligibleUntil};
    virtual.set(`${photoBase}/photos-${photoShard}.json`,{value:{schemaVersion:1,status:'ready',version:photoVersion,eligibleUntil,
      images:Object.fromEntries(batch.map(p=>[p.id,{imageUrl:p.imageUrl,eligibleUntil}]))},deadline:Date.parse(eligibleUntil)});}
  virtual.set(photoBase+'/photos.json',{value:index,deadline:Math.min(...Object.values(index.products).map(p=>Date.parse(p.eligibleUntil)))});
  const ranked=picturedOpening(await browseProducts(products,snapshot,edition),index.products),cards=ranked.map(projectCard);
  const version=await runtimeDigest(JSON.stringify({schemaVersion:1,initialBrowseCount:24,feedShardSize:24,randomPoolLimit:48,catalogRevision:snapshot.catalogRevision,cards})),base='/catalog/'+version;
  const feedCount=Math.ceil(Math.max(0,cards.length-24)/24);
  const shard=(kind:'feed'|'random',items:typeof cards,next:string|null)=>({schemaVersion:1,status:items.length?'ready':'unavailable',catalogRevision:snapshot.catalogRevision,
    version,kind,eligibleUntil:earliestCatalogExpiry(items),products:items,next});
  for(let i=0;i<feedCount;i++){const items=cards.slice(24+i*24,48+i*24);virtual.set(`${base}/feed-${i+1}.json`,
    {value:shard('feed',items,i+1<feedCount?`${base}/feed-${i+2}.json`:null),deadline:Math.min(...items.map(p=>catalogDeadline(p.eligibleUntil)))});}
  const random=cards.slice(0,48);virtual.set(base+'/random.json',{value:shard('random',random,null),deadline:Math.min(...random.map(p=>catalogDeadline(p.eligibleUntil)))});
  const routes:SiteAssetManifest['routes']={'/':pageRoute('/'),'/h':pageRoute('/h',false),'/random-gift':pageRoute('/random-gift'),
    '/gift-guides':pageRoute('/gift-guides'),'/privacy':pageRoute('/privacy'),'/howie':pageRoute('/howie',false)};
  for(const p of snapshot.products){const base=persistentPublicProduct(p);routes['/gifts/'+p.slug]={...pageRoute('/gifts/'+p.slug),
    eligibleUntil:p.eligibleUntil,persistentIndexable:Boolean(base)};}
  for(const p of snapshot.heldProducts)routes[p.path]={...pageRoute(p.path,false),state:'held'};
  for(const guide of guides)routes['/gift-guides/'+guide.slug]=pageRoute('/gift-guides/'+guide.slug,selectGuideProducts({...snapshot,products},guide,at).length>0);
  const manifest:SiteAssetManifest={schemaVersion:1,dataKind:'catalog',sourceMode:'stupid-production',siteIdentitySha256:'0'.repeat(64),releaseId:options.releaseId,codeSha:options.codeSha,
    catalogRevision:snapshot.catalogRevision,catalogSnapshotSha256:view.head.snapshotSha256,generatedAt:snapshot.generatedAt,nextExpiry:null,
    productCount:snapshot.products.length,slugCount:snapshot.products.length+snapshot.heldProducts.length+snapshot.slugHistory.length,vectorSyncWatermark:0,priorReleaseId:null,
    checksums:Object.fromEntries(Object.entries(view.data.assets).map(([path,asset])=>[path,asset.sha256])),routes,retention:null,merchandising,
    ...(view.data.semanticCatalog?{semanticCatalog:view.data.semanticCatalog}:{})};
  const api=createSiteWorker<RuntimeSiteEnv>({snapshot,manifest,canonicalOrigin:ORIGIN,searchAdapters:d1SearchAdapters,
    semanticBudgetScope:{environment:'production',index:'stupid-gifts-production'},now,
    feedPlan:createStaticFeedPlan(snapshot,view.head.snapshotSha256,at),
    repairedPublicIds:view.data.repairedSemanticIds,legacyPublicFieldsSha256:view.data.legacySemanticFieldsSha256});
  const bySlug=new Map(products.map(p=>[p.slug,p])),byId=new Map(products.map(p=>[p.publicId,p])),related=createRelatedGiftSelector(ranked);
  const names=new Set([...Object.keys(SHOW_PRESETS),...Object.keys(view.collections).map(name=>name.replace(/^\/collections\//,''))].filter(name=>/^[a-z0-9][a-z0-9-]{0,59}$/.test(name)&&name!=='homepage'&&name!=='active-show'));
  const showIds=(name:string)=>{
    const ids=collection(view,name).ids;if(Array.isArray(ids))return ids.filter((id):id is string=>typeof id==='string');
    const preset=SHOW_PRESETS[name as keyof typeof SHOW_PRESETS]??[];
    return preset.flatMap(id=>snapshot.products.find(p=>p.id===id||p.slug===id||p.publicId===id)?.publicId??[]);
  };
  const active=collection(view,'active-show').name;
  const activeName=typeof active==='string'&&names.has(active)?active:ACTIVE_SHOW_PRESET;
  return{snapshot,products,ranked,cards,version,base,feedCount,virtual,photoLookup:index,photoIndex:photoShard?photoBase+'/photos.json':null,photoSlots:Object.keys(index.products),manifest,api,bySlug,byId,related,names,showIds,activeName};
}
type Prepared=Awaited<ReturnType<typeof prepare>>;
async function pageOg(view:RuntimeCatalogView,props:RuntimePageProps,at:number){
  const text=(value:string)=>value.normalize('NFKC').replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/[–—]/g,'-').replace(/…/g,'...').trim();
  const brand={schemaVersion:1,styleVersion:1,identity:{name:'Stupid Gifts',origin:ORIGIN,tagline:'Very bad ideas. Carefully considered.'},
    kind:'brand',subjectId:'brand',title:'Very bad ideas. Carefully considered.',eligibleUntil:null as string|null};
  const cards=[brand];
  if(props.kind==='product'){const p=props.products[0];cards.unshift({...brand,kind:'product',subjectId:p.publicId,title:text(p.punnyTitle||p.title),eligibleUntil:p.eligibleUntil});}
  if(props.kind==='guide'&&props.guide)cards.unshift({...brand,kind:'guide',subjectId:props.guide.slug,title:text(props.guide.h1)});
  for(const card of cards){const path='/og/'+await runtimeDigest(JSON.stringify(card))+'.png',asset=view.data.assets[path];
    if(asset&&catalogDeadline(asset.eligibleUntil)>at)return path;}
  // No arbitrary first product image may stand in for another page's OG card.
  return undefined;
}
function page(path:string,view:RuntimeCatalogView,p:Prepared,options:RuntimeSiteOptions,now:()=>number){
  const props:RuntimePageProps={kind:'missing',products:[],cards:[],catalogRevision:p.snapshot.catalogRevision,version:p.version,next:null,poolSize:p.cards.slice(0,48).length,
    action:'/',guides:guides.map(({slug,title,intro})=>({slug,title,intro})),analytics:options.analytics===true,
    disclosures:view.data.disclosures??{},photoIndex:p.photoIndex,photoSlots:p.photoSlots,eligibleUntil:null};
  let title='That gift wandered off.',description='We couldn’t find that page.',status=200,indexable=true,schema:unknown;
  if(path==='/'){props.kind='home';props.cards=p.cards.slice(0,24);props.next=p.feedCount?p.base+'/feed-1.json':null;indexable=props.cards.length>0;
    title='Stupid gifts. Excellent taste.';description='Stupid Gifts: Very bad ideas. Carefully considered.';
    schema={'@context':'https://schema.org','@type':'ItemList',numberOfItems:props.cards.length,itemListElement:props.cards.map((p,i)=>({'@type':'ListItem',position:i+1,name:p.title,url:ORIGIN+'/gifts/'+p.slug}))};}
  else if(path==='/h'||/^\/h\/[a-z0-9][a-z0-9-]{0,59}$/.test(path)&&p.names.has(path.slice(3))){
    const showName=path==='/h'?p.activeName:path.slice(3);
    props.kind='show';props.action=path;props.products=p.showIds(showName).flatMap(id=>p.byId.get(id)??[]);
    title='Saved picks';description='The saved Stupid Gifts lineup.';indexable=false;
  }else if(path==='/random-gift'){props.kind='random';props.cards=p.cards.slice(0,1);title='A random stupid gift';description='Find something absurd, useful, and deeply unnecessary.';}
  else if(path==='/howie'){props.kind='howie';title='From the show';description='No episode selection has been published.';indexable=false;}
  else if(path==='/gift-guides'){props.kind='guides';title='Funny gift guides';description='Find the right kind of stupid gift.';}
  else if(path==='/privacy'){props.kind='privacy';title='Privacy Policy';description='How Stupid Gifts handles information and affiliate links.';}
  else if(path.startsWith('/gift-guides/')){const guide=guides.find(g=>path==='/gift-guides/'+g.slug);
    if(guide){props.kind='guide';props.guide=guide;props.products=selectGuideProducts({...p.snapshot,products:p.products},guide,now());title=guide.metadataTitle??guide.title;description=guide.intro;
      indexable=props.products.length>0;schema=guideSchema(guide,props.products);}}
  else if(path.startsWith('/gifts/')){const product=p.bySlug.get(path.slice(7));
    if(product){props.kind='product';props.products=[product];props.related=p.related(product);title=shortProductName(product.title);description=product.description;
      const route=p.manifest.routes[path];indexable=catalogDeadline(route.eligibleUntil)>now()?route.indexable!==false:route.persistentIndexable===true;
      schema=buildGiftPageSchema(product,ORIGIN+path,title,description,ORIGIN,new Date(now()));}
    else if(p.snapshot.heldProducts.some(item=>item.path===path)||p.snapshot.products.some(item=>'/gifts/'+item.slug===path)){
      props.kind='held';title='Gift currently unavailable';description='This gift is not currently available in the curated catalog.';indexable=false;}}
  if(props.kind==='missing'){status=404;indexable=false;}
  // Reuse the server's already-resolved, URL-free lookup for the initial grid.
  // Bound HTML growth; later cards can still fetch the full versioned index.
  const initialPhotos=Object.fromEntries([...props.products,...props.cards,...(props.related??[])].slice(0,24)
    .flatMap(product=>Object.hasOwn(p.photoLookup.products,product.id)?[[product.id,p.photoLookup.products[product.id]]]:[]));
  if(Object.keys(initialPhotos).length)props.initialPhotoIndex={...p.photoLookup,products:initialPhotos};
  props.eligibleUntil=earliestCatalogExpiry([...props.products,...props.cards,...(props.related??[])]);
  return{props,title,description,status,indexable,schema};
}

export function createRuntimeSite(options:RuntimeSiteOptions){
  if(!/^[a-f0-9]{40}$/.test(options.codeSha)||!/^[a-zA-Z0-9._-]{1,200}$/.test(options.releaseId)||!/^[a-f0-9]{64}$/.test(options.manifestSha256)
    ||![options.clientPath,options.cssPath,...(options.brandOgPath?[options.brandOgPath]:[])].every(p=>/^\/app\/[a-zA-Z0-9_.-]+$/.test(p)))throw Error('runtime_app_identity_invalid');
  const now=options.now??Date.now,read=options.readView??createRuntimeCatalogReader(now);
  const appAssets=new Set([options.clientPath,options.cssPath,...(options.brandOgPath?[options.brandOgPath]:[]),'/fonts/inter-latin.woff2','/fonts/OFL.txt','/favicon.ico','/images/gift-placeholder.svg']);
  let cached:{view:RuntimeCatalogView;collections:string;prepared:Promise<Prepared>;until:number}|undefined;
  return{async fetch(request:Request,env:RuntimeSiteEnv):Promise<Response>{
    const url=new URL(request.url),path=url.pathname;
    let catalogRevision:string|undefined;
    // Versioned public photo shards only. Keep HTML, admin, search and index reads current.
    const photoCache=env.ENVIRONMENT==='production'&&env.RUNTIME_CATALOG_ENABLED==='true'&&url.origin===ORIGIN&&!url.search&&request.method==='GET'&&PHOTO_PATH.test(path)
      ?(globalThis.caches as CacheStorage&{default?:Cache}|undefined)?.default:undefined;
    const photoKey=new Request(ORIGIN+path+'?photo-app='+options.codeSha);
    const finish=(response:Response)=>{const headers=new Headers(response.headers);headers.set('X-Content-Type-Options','nosniff');headers.set('Referrer-Policy','strict-origin-when-cross-origin');
      if(catalogRevision)headers.set('X-Catalog-Revision',catalogRevision);
      if(env.ENVIRONMENT!=='production'){headers.set('X-Robots-Tag','noindex, nofollow');headers.set('Cache-Control','private, no-store');}
      return new Response(request.method==='HEAD'?null:response.body,{status:response.status,headers});};
    try{
      if(/%(?:2f|5c|25)/i.test(path)||/[\\\u0000-\u001f]/.test(decodeURIComponent(path)))return finish(json({error:'Not found'},404));
      if(env.ENVIRONMENT==='production'&&!['stupid.gifts','www.stupid.gifts'].includes(url.host))return finish(json({error:'Not found'},404));
      if(env.ENVIRONMENT!=='production'){
        if(!env.STAGING_AUTH_SECRET||env.STAGING_AUTH_SECRET.length<16)return finish(json({error:'Staging protection unavailable'},503));
        if(await runtimeDigest(request.headers.get('Authorization')??'')!==await runtimeDigest('Basic '+btoa('staging:'+env.STAGING_AUTH_SECRET)))
          return finish(new Response(null,{status:401,headers:{'WWW-Authenticate':'Basic realm="Stupid Gifts staging"'}}));
      }
      if(path.startsWith('/app/')||path.startsWith('/fonts/')||path==='/favicon.ico'||path==='/images/gift-placeholder.svg'){
        if(!['GET','HEAD'].includes(request.method))return finish(json({error:'Method not allowed'},405));
        if(!appAssets.has(path))return finish(json({error:'Not found'},404));
        return finish(await env.ASSETS.fetch(request));
      }
      if(PHOTO_PATH.test(path)&&env.RUNTIME_CATALOG_ENABLED!=='true')return finish(json({error:'Catalog unavailable'},503));
      if(photoCache)try{
        const hit=await photoCache.match(photoKey),until=Number(hit?.headers.get('X-Photo-Cache-Until'));
        if(hit?.status===200&&Number.isFinite(until)&&until>now())return finish(photoResponse(hit,until,now(),'HIT'));
      }catch{/* A cache outage must not interrupt the normal validated read. */}
      const view=await read(env);catalogRevision=view.head.catalogRevision;
      if(options.handleRequest){const result=await options.handleRequest(request,env,view);if(result)return finish(result);}
      if(path==='/.well-known/catalog-release.json'||path==='/.well-known/runtime-catalog.json'){
        if(!['GET','HEAD'].includes(request.method))return finish(new Response(null,{status:405,headers:{Allow:'GET, HEAD'}}));
        if(env.ENVIRONMENT==='production'&&url.origin!==ORIGIN)return finish(new Response(null,{status:308,headers:{Location:ORIGIN+path,'Cache-Control':'no-store'}}));
        return finish(json(path.endsWith('/runtime-catalog.json')?{schemaVersion:1,contract:'runtime-catalog-v1',catalogReleaseId:view.head.releaseId,dataSha256:view.head.dataSha256,version:view.head.version}:
          {release_id:options.releaseId,code_sha:options.codeSha,manifest_sha256:options.manifestSha256,catalog_revision:view.head.catalogRevision,catalog_snapshot_sha256:view.head.snapshotSha256}));
      }
      const collections=canonicalJson(view.collections);
      if(!cached||cached.view.data!==view.data||cached.collections!==collections||cached.until<=now())cached={view,collections,prepared:prepare(view,options,now),
        until:Math.min(...view.data.snapshot.products.map(p=>catalogDeadline(p.eligibleUntil)).filter(until=>until>now()))};
      const p=await cached.prepared;
      if(env.ENVIRONMENT==='production'&&url.origin!==ORIGIN){
        const known=p.manifest.routes[path]||p.virtual.has(path)||view.data.assets[path]||path.startsWith('/api/')||path==='/.well-known/catalog-release.json'||path==='/.well-known/runtime-catalog.json'||path==='/sitemap.xml'||path==='/robots.txt'||/^\/h\//.test(path)&&p.names.has(path.slice(3));
        if(!known)return finish(json({error:'Not found'},404));
        return finish(new Response(null,{status:308,headers:{Location:ORIGIN+path+url.search,'Cache-Control':'no-store'}}));
      }
      if(path.startsWith('/api/'))return finish(await p.api.fetch(request,env));
      if(!['GET','HEAD'].includes(request.method))return finish(new Response(null,{status:405,headers:{Allow:'GET, HEAD'}}));
      if(path==='/search'){const q=url.searchParams.get('q')?.trim().slice(0,200);return finish(new Response(null,{status:308,headers:{Location:q?'/?q='+encodeURIComponent(q):'/'}}));}
      if(path.endsWith('/')&&path!=='/'&&p.manifest.routes[path.slice(0,-1)])return finish(new Response(null,{status:308,headers:{Location:path.slice(0,-1)+url.search}}));
      const historical=p.snapshot.slugHistory.find(item=>path==='/gifts/'+item.slug);
      if(historical&&(p.bySlug.has(historical.canonicalSlug)||p.snapshot.heldProducts.some(item=>item.slug===historical.canonicalSlug)))
        return finish(new Response(null,{status:308,headers:{Location:'/gifts/'+historical.canonicalSlug+campaignQuery(url.searchParams),'Cache-Control':'no-store'}}));
      if(Object.hasOwn(view.data.assets,path))return finish(await runtimePublicAsset(request,env,view,path,now));
      if(path==='/robots.txt')return finish(new Response('User-agent: *\nAllow: /\nDisallow: /h\nDisallow: /api/\nSitemap: '+ORIGIN+'/sitemap.xml\n',{headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'public, max-age=300'}}));
      if(path==='/sitemap.xml'||path==='/sitemap/0.xml'){
        const paths=['/','/gift-guides','/random-gift','/privacy',...guides.filter(g=>p.manifest.routes['/gift-guides/'+g.slug].indexable).map(g=>'/gift-guides/'+g.slug),...p.products.filter(product=>{
          const route=p.manifest.routes['/gifts/'+product.slug];return catalogDeadline(route.eligibleUntil)>now()?route.indexable!==false:route.persistentIndexable===true;
        }).map(product=>'/gifts/'+product.slug)];
        return finish(new Response('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+paths.map(path=>'<url><loc>'+escape(ORIGIN+path)+'</loc></url>').join('')+'</urlset>',{headers:{'Content-Type':'application/xml; charset=utf-8','Cache-Control':'no-store'}}));
      }
      const virtual=p.virtual.get(path);if(virtual){
        if(!(virtual.deadline>now()))return finish(json({error:'Catalog data expired'},410));
        if(photoCache&&Number.isFinite(virtual.deadline)){
          const until=Math.min(virtual.deadline,now()+PHOTO_CACHE_TTL*1000);
          const response=finish(photoResponse(json(virtual.value),until,now(),'MISS'));
          try{await photoCache.put(photoKey,response.clone());}catch{/* Serving does not depend on cache storage. */}
          return until>now()?finish(photoResponse(response,until,now(),'MISS')):finish(json({error:'Catalog data expired'},410));
        }
        return finish(json(virtual.value));
      }
      if(path.startsWith('/catalog/')||path.startsWith('/images/')||path.startsWith('/og/')||path.startsWith('/safe/')||path.startsWith('/data/'))return finish(json({error:'Not found'},404));
      const value=page(path,view,p,options,now),canonical=ORIGIN+path;
      value.props.analytics=options.analytics===true&&env.ENVIRONMENT==='production';
      if(path==='/random-gift'&&url.searchParams.has('gift')){value.status=404;value.indexable=false;value.props.kind='missing';}
      const indexable=value.indexable&&!url.searchParams.has('q')&&env.ENVIRONMENT==='production';
      const stream=await renderToReadableStream(<RuntimeApp {...value.props}/>);await stream.allReady;
      const html=await new Response(stream).text();
      // An SSR read can cross a finite content deadline. Never emit that body.
      if(catalogDeadline(value.props.eligibleUntil)<=now())return finish(json({error:'Catalog data expired'},503));
      const og=await pageOg(view,value.props,now())??options.brandOgPath;
      const document='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+escape(value.title)+' — Stupid Gifts</title>'+
        '<meta name="description" content="'+escape(value.description)+'"><link rel="canonical" href="'+escape(canonical)+'"><meta name="robots" content="'+(indexable?'index, follow':'noindex, follow')+'">'+
        '<meta property="og:type" content="website"><meta property="og:title" content="'+escape(value.title)+'"><meta property="og:description" content="'+escape(value.description)+'"><meta property="og:url" content="'+escape(canonical)+'">'+
        (og?'<meta property="og:image" content="'+escape(ORIGIN+og)+'"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="'+escape(ORIGIN+og)+'">':'')+
        '<link rel="icon" href="/favicon.ico"><link rel="stylesheet" href="'+escape(options.cssPath)+'">'+(value.schema?'<script type="application/ld+json">'+safeJson(value.schema)+'</script>':'')+
        '</head><body><div id="runtime-app">'+html+'</div><script id="runtime-props" type="application/json">'+safeJson(value.props)+'</script><script type="module" src="'+escape(options.clientPath)+'"></script></body></html>';
      return finish(new Response(document,{status:value.status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',...(indexable?{}:{'X-Robots-Tag':'noindex, follow'})}}));
    }catch(error){
      const message=error instanceof Error?error.message:'',errorCode=/^(?:runtime_catalog|runtime_app|runtime_site)_[a-z0-9_]{1,80}$/.test(message)?message:'runtime_site_unavailable';
      console.error(JSON.stringify({state:'runtime_site_error',errorCode}));
      return finish(json({error:'Temporarily unavailable'},503));
    }
  }};
}
