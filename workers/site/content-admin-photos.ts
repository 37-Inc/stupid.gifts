import {ContentAdminError,createContentRequestStore} from '../../lib/catalog/content-admin.ts';
import type {ContentRequest} from '../../lib/catalog/content-admin.ts';
import {resolvePublicProduct} from '../../lib/catalog/display.ts';
import {PHOTO_PRODUCT_ID,PHOTO_TYPES,PRODUCT_PHOTO_MAX,PRODUCT_PHOTO_ROOT,productPhotoFormat,productPhotoKey} from '../../lib/catalog/product-photos.ts';
import type {ProductPhoto} from '../../lib/catalog/product-photos.ts';
import {runtimeDigest} from '../../lib/catalog/runtime-catalog.ts';
import type {CatalogSnapshot,PublicCatalogProduct} from '../../lib/catalog/types.ts';
import {boundedAdminBody} from './content-admin-body.ts';
import type {ProductMediaBucket} from './product-media.ts';

export const PRODUCT_PHOTO_EDITOR='/api/content-admin/photos';
const HEADERS={'Cache-Control':'private, no-store','X-Robots-Tag':'noindex, nofollow','Vary':'Cf-Access-Jwt-Assertion',
  'Content-Security-Policy':"default-src 'none'; img-src 'self' https:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const input=(name:string,value:string)=>`<input type="hidden" name="${name}" value="${escape(value)}">`;
function page(gift:string,product?:PublicCatalogProduct,fields='',saved=false){
  const edit=product?`<h2>${escape(product.title)}</h2>
  <p><img src="${escape(product.imageUrl)}" alt="" width="180"></p>
  <form action="${PRODUCT_PHOTO_EDITOR}" method="post" enctype="multipart/form-data">
    ${fields}${input('action','upload')}
    <p><label>New photo (JPEG, PNG or WebP, up to 2 MB) <input name="image" type="file" accept="image/jpeg,image/png,image/webp" required></label></p>
    <p>Only upload images you own or have permission to host.</p>
    <button>Use this photo</button>
  </form>
  ${product.imageUrl.startsWith(PRODUCT_PHOTO_ROOT)?`<form action="${PRODUCT_PHOTO_EDITOR}" method="post" enctype="multipart/form-data">
    ${fields}${input('action','restore')}<p><button>Restore catalog photo</button></p></form>`:''}`:'';
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Product photos · Stupid Gifts</title><main><h1>Product photos</h1>
    <form action="${PRODUCT_PHOTO_EDITOR}" method="get"><label>Gift page URL or slug
    <input name="gift" value="${escape(gift)}" maxlength="300" required></label> <button>Find gift</button></form>
    ${saved?'<p role="status">Photo updated.</p>':''}${gift&&!product?'<p>No public gift found.</p>':''}${edit}</main></html>`,
    {headers:{...HEADERS,'Content-Type':'text/html; charset=utf-8'}});
}

export async function adminProductPhoto({request,snapshot,store,actor,bucket,apply,now}:{
  request:Request;snapshot:CatalogSnapshot;store:ReturnType<typeof createContentRequestStore>;actor:string;bucket:ProductMediaBucket;
  apply:(request:ContentRequest)=>Promise<unknown>;now:number;
}){
  const url=new URL(request.url),param=url.searchParams;
  const invalid=()=>new ContentAdminError(400,'invalid_request');
  const publicProduct=(p:PublicCatalogProduct|undefined)=>{
    const current=p&&resolvePublicProduct(p,now);return current?.isActive?current:undefined;
  };
  if(request.method==='GET'){
    if([...param].some(([name])=>!['gift','saved'].includes(name)||param.getAll(name).length!==1))throw invalid();
    const gift=(param.get('gift')??'').trim();
    if(gift.length>300)throw invalid();
    const slug=/^(?:https:\/\/stupid\.gifts\/gifts\/)?([a-z0-9][a-z0-9-]{0,199})\/?$/.exec(gift)?.[1];
    const product=slug?publicProduct(snapshot.products.find(p=>p.slug===slug&&PHOTO_PRODUCT_ID.test(p.publicId))):undefined;
    if(!product)return page(gift);
    const fields=input('publicId',product.publicId)+input('catalogRevision',snapshot.catalogRevision)
      +input('requestId',crypto.randomUUID())+input('expectedRevision',String((await store.get('/products/'+product.publicId))?.revision??0));
    return page(product.slug,product,fields,param.get('saved')==='1');
  }
  if(request.method!=='POST')return new Response(null,{status:405,headers:{...HEADERS,Allow:'GET, POST'}});
  if(url.search)throw invalid();
  const type=request.headers.get('Content-Type')??'';
  if(!/^multipart\/form-data\s*;/i.test(type))throw new ContentAdminError(415,'multipart_required');
  const bytes=await boundedAdminBody(request,PRODUCT_PHOTO_MAX+32768);
  const form=await new Response(bytes,{headers:{'Content-Type':type}}).formData().catch(()=>{throw invalid();});
  const field=(key:string)=>form.get(key);
  const action=field('action'),id=field('publicId'),revision=field('expectedRevision'),catalog=field('catalogRevision'),requestId=field('requestId');
  // Preserve older open forms and exact retries without requiring the old checkbox.
  const legacy=action==='upload'&&field('rights')==='yes';
  const fields=['action','publicId','expectedRevision','catalogRevision','requestId',...(action==='upload'?['image']:[]),...(legacy?['rights']:[])];
  if(action!=='upload'&&action!=='restore'||[...form.keys()].length!==fields.length||fields.some(key=>form.getAll(key).length!==1)
    ||typeof id!=='string'||!PHOTO_PRODUCT_ID.test(id)||typeof revision!=='string'||!/^\d{1,15}$/.test(revision)
    ||typeof catalog!=='string'||!catalog||catalog.length>200||typeof requestId!=='string'||!/^[-\w]{16,100}$/.test(requestId))throw invalid();
  const product=publicProduct(snapshot.products.find(p=>p.publicId===id));
  if(!product)throw new ContentAdminError(404,'product_not_found');
  const resource='/products/'+id,prior=await store.byId(requestId);
  if(!prior&&(catalog!==snapshot.catalogRevision||((await store.get(resource))?.revision??0)!==Number(revision)))
    throw new ContentAdminError(409,'photo_revision_conflict');
  let photo:ProductPhoto|null=null;
  if(action==='upload'){
    const image=field('image');
    if(!image||typeof image==='string')throw invalid();
    if(image.size>PRODUCT_PHOTO_MAX)throw new ContentAdminError(413,'request_too_large');
    const content=new Uint8Array(await image.arrayBuffer()),format=productPhotoFormat(content);
    if(!format||image.type!==PHOTO_TYPES[format])throw new ContentAdminError(415,'unsupported_photo');
    photo={format,bytes:content.length,sha256:await runtimeDigest(content)};
    if(!prior){
      const stored=await bucket.put(productPhotoKey(id,photo),content,{sha256:photo.sha256,httpMetadata:{contentType:PHOTO_TYPES[format]}});
      if(stored.size!==photo.bytes)throw new ContentAdminError(503,'photo_storage_unconfirmed');
    }
  }
  const reason=photo?(legacy?'Staff confirmed permission to host this photo':'Staff uploaded a product photo'):'Restore catalog photo';
  const result=await store.save({requestId,resource,action:'product',actor,baseCatalogRevision:catalog,
    reason,expectedRevision:Number(revision),payload:{photo}},new Date(now).toISOString());
  await apply(result.request);
  return new Response(null,{status:303,headers:{...HEADERS,Location:PRODUCT_PHOTO_EDITOR+'?gift='+encodeURIComponent(product.slug)+'&saved=1'}});
}
