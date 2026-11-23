import {catalogDeadline,resolvePublicProduct} from '../../lib/catalog/display.ts';
import {PHOTO_PRODUCT_ID,PHOTO_TYPES,PRODUCT_PHOTO_ROOT,productPhotoKey,productPhotoPath,readProductPhoto} from '../../lib/catalog/product-photos.ts';
import type {RuntimeCatalogView} from './runtime-data.ts';

export interface ProductMediaBucket {
  put(key:string,bytes:Uint8Array,options:{sha256:string;httpMetadata:{contentType:string}}):Promise<{size:number}>;
  get(key:string):Promise<{size:number;body:ReadableStream}|null>;
}

/** Only an exact, currently attached image of a public gift can address this
 * private binding. Never use a caller's path directly as an R2 key. */
export async function serveProductMedia(request:Request,url:URL,view:RuntimeCatalogView,bucket:ProductMediaBucket|undefined,now:()=>number){
  const noStore={'Cache-Control':'no-store'};
  if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{...noStore,Allow:'GET, HEAD'}});
  const id=url.pathname.slice(PRODUCT_PHOTO_ROOT.length).split('/')[0];
  const photo=PHOTO_PRODUCT_ID.test(id)?readProductPhoto((view.collections['/products/'+id]?.payload as {photo?:unknown}|undefined)?.photo):null;
  const product=photo&&view.data.snapshot.products.find(p=>p.publicId===id);
  const current=product&&resolvePublicProduct(product,now());
  if(!photo||!current||!current.isActive||current.imageUrl!==url.pathname||url.pathname!==productPhotoPath(id,photo))
    return new Response(null,{status:404,headers:noStore});
  if(url.host==='www.stupid.gifts')return new Response(null,{status:308,headers:{...noStore,Location:'https://stupid.gifts'+url.pathname}});
  const object=await bucket?.get(productPhotoKey(id,photo));
  if(!object||object.size!==photo.bytes){await object?.body.cancel();return new Response(null,{status:503,headers:noStore});}
  const remaining=catalogDeadline(current.eligibleUntil)-now();
  if(!(remaining>0)){await object.body.cancel();return new Response(null,{status:404,headers:noStore});}
  if(request.method==='HEAD')await object.body.cancel();
  const seconds=Math.min(300,Math.floor(remaining/1000));
  return new Response(request.method==='HEAD'?null:object.body,{headers:{
    'Cache-Control':`public, max-age=${seconds}, must-revalidate`,'Content-Type':PHOTO_TYPES[photo.format],
    'Content-Length':String(photo.bytes),'X-Content-Type-Options':'nosniff',ETag:'"'+photo.sha256+'"',
  }});
}
