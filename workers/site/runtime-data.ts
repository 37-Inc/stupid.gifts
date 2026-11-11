import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import {readRuntimeCatalogData,runtimeDigest,RUNTIME_CATALOG_PREFIX,runtimeOverlayKey} from '../../lib/catalog/runtime-catalog.ts';
import type {RuntimeCatalogData,RuntimeCatalogHead} from '../../lib/catalog/runtime-catalog.ts';
import {validatePublicCatalogProduct} from '../../lib/catalog/snapshot.ts';
import {resolvePublicProduct} from '../../lib/catalog/display.ts';

/** Read-only structural R2 binding. No object key comes from an HTTP caller. */
export interface RuntimeCatalogBucket {
  get(key:string):Promise<{arrayBuffer():Promise<ArrayBuffer>;body?:ReadableStream}|null>;
}
export interface RuntimeCatalogEnv {DB?:CatalogD1;CATALOG_DATA?:RuntimeCatalogBucket;RUNTIME_CATALOG_ENABLED?:string}
export interface RuntimeCatalogView {head:RuntimeCatalogHead;data:RuntimeCatalogData;collections:Record<string,{revision:number;payload:unknown}>}
export function createRuntimeCatalogReader(now=Date.now){
  let cached:RuntimeCatalogView|undefined,base:RuntimeCatalogData|undefined,nextCheck=0,inflight:Promise<RuntimeCatalogView>|undefined;
  let binding:RuntimeCatalogEnv|undefined,overlayDeadline=Infinity,overlayIncomplete=false;
  const currentView=(view:RuntimeCatalogView):RuntimeCatalogView=>{
    const products=view.data.snapshot.products.flatMap(p=>resolvePublicProduct(p,now())??[]),ids=new Set(products.map(p=>p.publicId));
    return{...view,data:{...view.data,snapshot:{...view.data.snapshot,products,heldProducts:(base??view.data).snapshot.heldProducts.filter(p=>!ids.has(p.publicId))}}};
  };
  async function read(env:RuntimeCatalogEnv):Promise<RuntimeCatalogView>{
    if(env.RUNTIME_CATALOG_ENABLED!=='true'||!env.DB||!env.CATALOG_DATA)throw Error('runtime_catalog_unavailable');
    const rows=(await env.DB.prepare(`SELECT p.release_id,p.catalog_revision,p.data_sha256,p.source_snapshot_sha256,p.public_snapshot_sha256,h.version
      FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id WHERE h.singleton=1`).all<{
        release_id:string;catalog_revision:string;data_sha256:string;source_snapshot_sha256:string;public_snapshot_sha256:string;version:number}>()).results;
    if(rows.length!==1)throw Error('runtime_catalog_head_missing');
    const row=rows[0];if(!/^[a-f0-9]{64}$/.test(row.data_sha256)||!Number.isSafeInteger(row.version)||row.version<1)throw Error('runtime_catalog_head_invalid');
    if(!overlayIncomplete&&cached?.head.version===row.version&&cached.head.releaseId===row.release_id&&cached.head.dataSha256===row.data_sha256
      &&cached.head.catalogRevision===row.catalog_revision&&cached.head.snapshotSha256===row.source_snapshot_sha256&&now()<overlayDeadline){nextCheck=Math.min(now()+5000,overlayDeadline);return cached;}
    let data=cached?.head.dataSha256===row.data_sha256?base:undefined;
    if(!data){
      const object=await env.CATALOG_DATA.get(RUNTIME_CATALOG_PREFIX+row.data_sha256+'.json');if(!object)throw Error('runtime_catalog_body_missing');
      const bytes=new Uint8Array(await object.arrayBuffer());
      if(bytes.length>32*1024*1024||await runtimeDigest(bytes)!==row.data_sha256)throw Error('runtime_catalog_body_changed');
      data=readRuntimeCatalogData(JSON.parse(new TextDecoder().decode(bytes)));
    }
    if(data.releaseId!==row.release_id||data.snapshot.catalogRevision!==row.catalog_revision
      ||await runtimeDigest(JSON.stringify(data.snapshot)+'\n')!==row.public_snapshot_sha256)throw Error('runtime_catalog_binding_changed');
    base=data;
    const products=new Map(data.snapshot.products.map(p=>[p.publicId,p]));overlayDeadline=Infinity;overlayIncomplete=false;
    const due=data.overlays.filter(ref=>Date.parse(ref.expiresAt)>now());
    // A failed optional finite-photo read falls back to its actual cleared base,
    // never to invented freshness or a global site outage.
    for(let offset=0;offset<due.length;offset+=8)await Promise.all(due.slice(offset,offset+8).map(async ref=>{
      overlayDeadline=Math.min(overlayDeadline,Date.parse(ref.expiresAt));
      try{
        const object=await env.CATALOG_DATA!.get(runtimeOverlayKey(ref));if(!object)throw Error();
        const bytes=new Uint8Array(await object.arrayBuffer());if(bytes.length>32*1024*1024||await runtimeDigest(bytes)!==ref.sha256)throw Error();
        if(Date.parse(ref.expiresAt)<=now())return;
        const rows=JSON.parse(new TextDecoder().decode(bytes));if(!Array.isArray(rows))throw Error();
        const validated=rows.map(value=>validatePublicCatalogProduct(value,new Date(now())));
        if(new Set(validated.map(p=>p.publicId)).size!==validated.length)throw Error();
        for(const p of validated)if(p.eligibleUntil!==ref.expiresAt||!data!.productOrder.includes(p.publicId))throw Error();
        for(const p of validated)products.set(p.publicId,p);
      }catch{overlayIncomplete=true;/* Affected finite overlay only; base content remains usable. */}
    }));
    const snapshot={...data.snapshot,products:data.productOrder.flatMap(id=>products.has(id)?[products.get(id)!]:[]),
      heldProducts:data.snapshot.heldProducts.filter(p=>!products.has(p.publicId))};
    const versions=(await env.DB.prepare(`SELECT c.name,c.revision,c.payload_json FROM catalog_runtime_collections c
      WHERE c.revision=(SELECT max(v.revision) FROM catalog_runtime_collections v WHERE v.name=c.name)`).all<{name:string;revision:number;payload_json:string}>()).results;
    const collections=Object.fromEntries(versions.map(v=>[v.name,{revision:v.revision,payload:JSON.parse(v.payload_json)}]));
    cached={data:{...data,snapshot},head:{releaseId:row.release_id,catalogRevision:row.catalog_revision,dataSha256:row.data_sha256,snapshotSha256:row.source_snapshot_sha256,version:row.version},collections};
    nextCheck=Math.min(now()+5000,overlayDeadline);return cached;
  }
  return async(env:RuntimeCatalogEnv)=>{
    if(binding&&(binding.DB!==env.DB||binding.CATALOG_DATA!==env.CATALOG_DATA))throw Error('runtime_catalog_scope_changed');
    binding=env;
    if(cached&&now()<nextCheck)return cached;
    if(!inflight)inflight=read(env).catch(error=>{
      // Availability fallback is only the last genuinely accepted data. Every
      // request still resolves original per-product/asset deadlines afterwards.
      if(cached){nextCheck=now()+1000;return currentView(cached);}throw error;
    }).finally(()=>{inflight=undefined;});
    return inflight;
  };
}
