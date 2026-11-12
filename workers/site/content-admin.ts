import type {CatalogSnapshot,SiteAssetManifest} from '../../lib/catalog/types.ts';
import type {SiteEnv} from './bindings.ts';
import type {SiteReleaseIdentity} from './index.ts';
import {ContentAdminError,createContentRequestStore} from '../../lib/catalog/content-admin.ts';
import type {ContentRequest} from '../../lib/catalog/content-admin.ts';
import {readHomepageEdition} from '../../lib/catalog/homepage-edition.ts';
import {validDisplayTitle,readMerchandising,usableCommissionPriority,merchandisingForProduct,productTitleView} from '../../lib/catalog/merchandising.ts';
import {resolvePublicProduct} from '../../lib/catalog/display.ts';
import {productPresentation} from '../../lib/catalog/presentation.ts';
import {contentAdminActor} from './content-admin-auth.ts';
import {dispatchAdmission,readAdmissionDispatch} from './content-admin-dispatch.ts';

const PREFIX='/api/content-admin';
const exact=(v:Record<string,unknown>,keys:string)=>Object.keys(v).sort().join(',')===keys.split(',').sort().join(',');
function invalid():never{throw new ContentAdminError(400,'invalid_request');}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:invalid();
const response=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'private, no-store',
  'Cloudflare-CDN-Cache-Control':'no-store','CDN-Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Vary':'Cf-Access-Jwt-Assertion'}});
async function body(request:Request):Promise<Record<string,unknown>>{
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')??''))throw new ContentAdminError(415,'json_required');
  if(Number(request.headers.get('Content-Length'))>20000)throw new ContentAdminError(413,'request_too_large');
  const reader=request.body?.getReader();if(!reader)invalid();
  let size=0;const chunks:Uint8Array[]=[];
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>20000){await reader.cancel();throw new ContentAdminError(413,'request_too_large');}chunks.push(next.value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.length;}
  try{return object(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}catch(error){if(error instanceof ContentAdminError)throw error;return invalid();}
}
export function createContentAdminHandler(options:{snapshot:CatalogSnapshot;manifest:SiteAssetManifest;releaseIdentity?:SiteReleaseIdentity;
  showCollections:Record<string,string[]>;activeShow:string;now:()=>number;
  applyCollection?:(request:ContentRequest)=>Promise<unknown>;readApplication?:(id:string)=>Promise<unknown>;
  campaigns?:()=>Promise<unknown>;hostedStatus?:()=>Promise<unknown>}){
  const {snapshot,manifest,now}=options;
  const metadata=readMerchandising(manifest.merchandising)??{};
  const identities=new Map([...snapshot.products,...snapshot.heldProducts].map(p=>[p.publicId,p]));
  function validate(resource:string,value:unknown,checkCurrent=true){
    const p=object(value);
    if(resource.startsWith('/admissions/')){if(!exact(p,'asin')||p.asin!==resource.slice(12))invalid();return p;}
    if(resource.startsWith('/products/')){
      if(!identities.has(resource.slice(10)))throw new ContentAdminError(404,'product_not_found');
      if(!Object.keys(p).length||Object.keys(p).some(k=>!['title','description','visibility'].includes(k)))invalid();
      if(p.title!==undefined&&!validDisplayTitle(p.title))invalid();
      if(p.description!==undefined&&(typeof p.description!=='string'||p.description!==p.description.trim()||p.description.length<3
        ||p.description.length>1000||/[\x00-\x1f<>]/.test(p.description)||/(?:\.{3}|…)\s*$/.test(p.description)))invalid();
      if(p.visibility!==undefined&&!['listed','unlisted'].includes(String(p.visibility)))invalid();return p;
    }
    if(resource==='/active-show'){
      if(!exact(p,'name')||typeof p.name!=='string'||! /^[a-z0-9][a-z0-9-]{0,59}$/.test(p.name)||p.name==='homepage')invalid();return p;
    }
    if(!/^\/collections\/[a-z0-9][a-z0-9-]{0,59}$/.test(resource))invalid();
    let ids:unknown;
    if(resource==='/collections/homepage'){
      const edition=readHomepageEdition(p.edition);if(!exact(p,'edition')||!edition)invalid();ids=[...edition.anchors,...edition.rotation];
    }else{if(!exact(p,'ids'))invalid();ids=p.ids;}
    if(!Array.isArray(ids)||!ids.length||ids.length>24||new Set(ids).size!==ids.length)invalid();
    if(ids.some(id=>typeof id!=='string'||! /^[a-zA-Z0-9._-]{1,100}$/.test(id)))invalid();
    const products=ids.map(id=>snapshot.products.find(product=>(product.publicId===id||resource==='/collections/homepage'&&product.id===id)&&resolvePublicProduct(product,now())));
    if(checkCurrent&&products.some(p=>!p))
      throw new ContentAdminError(409,'collection_product_not_public');
    if(checkCurrent&&new Set(products.map(p=>p!.publicId)).size!==products.length)invalid();
    return p;
  }
  return async(request:Request,env:SiteEnv)=>{
    if(env.CONTENT_ADMIN_ENABLED!=='true'||env.ENVIRONMENT!=='production'||snapshot.dataKind!=='catalog')return response({error:'not_found'},404);
    const url=new URL(request.url);
    if(url.origin!=='https://stupid.gifts'||url.search) return response({error:'not_found'},404);
    try{
      const actor=await contentAdminActor(request,env,now());if(!actor)return response({error:'staff_authentication_required'},403);
      // Access returns the signed-in browser from another origin. A top-level
      // read-only navigation is safe; cross-origin fetches and all writes keep
      // the existing CSRF/origin checks and no CORS response.
      const loginNavigation=request.method==='GET'&&request.headers.get('Sec-Fetch-Mode')==='navigate'
        &&request.headers.get('Sec-Fetch-Dest')==='document';
      if(request.headers.has('Origin')&&request.headers.get('Origin')!==url.origin
        ||request.headers.get('Sec-Fetch-Site')&& !['same-origin','none'].includes(request.headers.get('Sec-Fetch-Site')!)&&!loginNavigation)
        return response({error:'cross_origin_denied'},403);
      if(!['GET','POST','PUT'].includes(request.method))return response({error:'method_not_allowed'},405);
      if(request.method!=='GET'&&request.headers.get('Origin')!==url.origin)return response({error:'origin_required'},403);
      if(!env.DB)return response({error:'admin_storage_unavailable'},503);
      const store=createContentRequestStore(env.DB),path=url.pathname.slice(PREFIX.length);
      const withApplication=async(saved:ContentRequest)=>({...saved,application:await options.readApplication?.(saved.requestId)??null,
        ...(env.CONTENT_ADMIN_DISPATCH_ENABLED==='true'&&saved.action==='admit'
          ?{dispatch:await readAdmissionDispatch(env.DB!,saved.requestId)}:{})});
      if(request.method==='GET'){
        if(path==='/status'){
          const owner=(await env.DB.prepare('SELECT phase,generation,mutation_epoch,external_pending FROM catalog_mutation_scopes LIMIT 1').all()).results[0]??null;
          const pending=(await env.DB.prepare(`SELECT b.state,b.source_revision,b.release_id,b.version_reference,b.error_code,p.release_id matched_live_release
            FROM catalog_build_requests b LEFT JOIN publication_outbox p ON p.release_id=? AND p.catalog_revision=b.source_revision
              AND json_extract(p.intent_json,'$.codeSha')=json_extract(b.request_json,'$.codeSha')
            WHERE b.state NOT IN ('resolved','failed') ORDER BY b.rowid DESC LIMIT 1`).bind(options.releaseIdentity?.release_id??'').all()).results[0]??null;
          const lastRefresh=(await env.DB.prepare("SELECT id,status,mode,completed_at FROM catalog_runs WHERE completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1").all()).results[0]??null;
          const lastBuildFailure=(await env.DB.prepare("SELECT source_revision,release_id,error_code FROM catalog_build_requests WHERE state='failed' ORDER BY rowid DESC LIMIT 1").all()).results[0]??null;
          const livePending=Boolean(options.releaseIdentity&&pending&&(pending.release_id===options.releaseIdentity.release_id
            ||pending.matched_live_release===options.releaseIdentity.release_id));
          return response({serving:options.releaseIdentity??null,catalogRevision:snapshot.catalogRevision,owner,pending,lastRefresh,lastBuildFailure,
            publicationState:livePending?'live_awaiting_bookkeeping':pending?'pending_not_confirmed_live':'no_pending_build',
            hostedSuccessor:await options.hostedStatus?.()??'not_observed',canStartAnotherPublisher:false,requests:await Promise.all((await store.recent()).map(withApplication)),
            applicationEnabled:Boolean(options.applyCollection),applications:{collections:options.applyCollection?'runtime_data':'draft_only',products:options.applyCollection?'runtime_data':'draft_only',admissions:'existing_coordinator_queue'}});
        }
        if(path==='/campaigns'){
          if(options.campaigns)return response(await options.campaigns());
          return response({scope:'compiled_ranking_only',manualActions:null,privateFeed:'not_connected',
            verifiedPreferences:snapshot.products.filter(p=>usableCommissionPriority(merchandisingForProduct(p,metadata),now())>0)
              .map(p=>({publicId:p.publicId,asin:p.id,until:metadata[p.id].commissionUntil}))});
        }
        if(path==='/requests')return response({requests:await Promise.all((await store.recent()).map(withApplication)),applicationEnabled:Boolean(options.applyCollection)});
        if(/^\/requests\/[a-zA-Z0-9_-]{16,100}$/.test(path)){
          const saved=await store.byId(path.slice(10));return response(saved?await withApplication(saved):{error:'request_not_found'},saved?200:404);
        }
        if(/^\/products\/[a-zA-Z0-9._-]{1,100}$/.test(path)){
          const product=identities.get(path.slice(10));if(!product)return response({error:'product_not_found'},404);
          const current='eligibleUntil' in product?resolvePublicProduct(product,now()):product;
          const published=current&&'eligibleUntil' in current?productTitleView(productPresentation(current),metadata):current;
          return response({published,request:await store.get(path)});
        }
        if(path==='/active-show'||/^\/collections\/[a-z0-9][a-z0-9-]{0,59}$/.test(path)){
          const name=path.slice(13),published=path==='/active-show'?{name:options.activeShow}:name==='homepage'?manifest.homepage??null
            :options.showCollections[name]?{ids:options.showCollections[name]}:null;
          return response({published,request:await store.get(path)});
        }
        return response({error:'not_found'},404);
      }
      const restore=path.match(/^(\/collections\/[a-z0-9][a-z0-9-]{0,59})\/restore$/),admit=path==='/admissions';
      if(admit||restore){if(request.method!=='POST')return response({error:'method_not_allowed'},405);}
      else if(request.method!=='PUT')return response({error:'method_not_allowed'},405);
      const input=await body(request);
      if(!exact(input,'catalogRevision,expectedRevision,payload,reason')||typeof input.catalogRevision!=='string'
        ||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>500||/[\x00-\x1f]/.test(input.reason)
        ||!Number.isSafeInteger(input.expectedRevision)||Number(input.expectedRevision)<0)invalid();
      let resource=restore?.[1]??path,action:'admit'|'restore'|'product'|'collection'|'active-show';
      if(admit){const payload=object(input.payload);if(!exact(payload,'asin')||typeof payload.asin!=='string'||! /^[A-Z0-9]{10}$/.test(payload.asin))invalid();
        resource='/admissions/'+payload.asin;action='admit';}
      else action=restore?'restore':path==='/active-show'?'active-show':path.startsWith('/products/')?'product':'collection';
      const requestId=request.headers.get('Idempotency-Key')??'';
      if(!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId))throw new ContentAdminError(400,'idempotency_key_required');
      const prior=await store.byId(requestId);
      if(!prior&&input.catalogRevision!==snapshot.catalogRevision)throw new ContentAdminError(409,'catalog_revision_conflict');
      let payload=input.payload;
      if(restore){const p=object(payload);if(!exact(p,'revision')||!Number.isSafeInteger(p.revision)||Number(p.revision)<1)invalid();
        const saved=await store.get(resource,Number(p.revision));if(!saved)throw new ContentAdminError(404,'revision_not_found');
        payload=saved.payload;}
      validate(resource,payload,!prior);
      if(action==='admit'&&!prior){
        const asin=String(object(payload).asin);
        // ALL identities, including held/private rows, not only current cards.
        const known=(await env.DB.prepare('SELECT public_id FROM products WHERE id=?').bind(asin).all()).results[0];
        if(known)return response({error:'product_already_exists',publicId:known.public_id},409);
      }
      if(resource==='/active-show'){
        const name=String(object(payload).name);
        if(!options.showCollections[name]){
          const saved=await store.get('/collections/'+name);
          const application=saved&&await options.readApplication?.(saved.requestId) as {state?:string}|null;
          if(!saved||options.applyCollection&&application?.state!=='applied')throw new ContentAdminError(409,'collection_not_found');
        }
      }
      const result=await store.save({requestId,resource,action,actor,reason:input.reason,baseCatalogRevision:input.catalogRevision,
        expectedRevision:Number(input.expectedRevision),payload},new Date(now()).toISOString());
      if(options.applyCollection&&['collection','restore','active-show','product'].includes(action)){
        const application=await options.applyCollection(result.request);
        return response({...result,application,publication:'runtime_data_applied',applicationEnabled:true},200);
      }
      let dispatch;
      if(action==='admit'&&env.CONTENT_ADMIN_DISPATCH_ENABLED==='true'){
        try{dispatch=env.GITHUB_CATALOG_DISPATCH_TOKEN?await dispatchAdmission({db:env.DB,requestId,token:env.GITHUB_CATALOG_DISPATCH_TOKEN,
          now:()=>new Date(now()).toISOString()}):{state:'unavailable',reason:'credential_not_configured'};}
        catch{dispatch={state:'unavailable',reason:'dispatch_not_confirmed'};}
      }
      return response({...result,publication:action==='admit'?'queued_for_existing_coordinator':'not_requested',applicationEnabled:false,
        ...(dispatch?{dispatch}:{})},202);
    }catch(error){return error instanceof ContentAdminError?response({error:error.message},error.status):response({error:'admin_temporarily_unavailable'},503);}
  };
}
