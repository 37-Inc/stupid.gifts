import {productPresentation,hasRepairedSemanticCopy} from '../../lib/catalog/presentation.ts';
import {productTitleView,merchandisingForProduct} from '../../lib/catalog/merchandising.ts';
import type {Merchandising} from '../../lib/catalog/merchandising.ts';
import {validateCatalogSnapshot} from '../../lib/catalog/snapshot.ts';
import {runtimeDataBytes,runtimeDigest,runtimeOverlayKey} from '../../lib/catalog/runtime-catalog.ts';
import type {RuntimeCatalogData,RuntimeCatalogAsset} from '../../lib/catalog/runtime-catalog.ts';
import type {CatalogSnapshot,PublicCatalogProduct,SafeHeldProduct,SiteAssetManifest} from '../../lib/catalog/types.ts';
import type {CatalogObjectStore} from './r2-object-store.ts';
import {persistentPublicProduct} from '../../lib/catalog/display.ts';
import {semanticPublicFields} from '../../lib/catalog/semantic-profile.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';

/** Only public, already approved bytes. This is transport, not enrichment:
 * source seal, native embeddings and original licence clocks remain unchanged. */
export async function exportRuntimeCatalog(input:{snapshot:CatalogSnapshot;releaseId:string;sourceCodeSha:string;
  homepage?:SiteAssetManifest['homepage'];merchandising?:SiteAssetManifest['merchandising'];semanticCatalog?:SiteAssetManifest['semanticCatalog'];
  assets?:Record<string,RuntimeCatalogAsset>;disclosures?:Record<string,string>;store:CatalogObjectStore;
  registerFinite?:(ref:{key:string;sha256:string;notAfter:string})=>Promise<void>;now?:()=>number}){
  const source=validateCatalogSnapshot(input.snapshot,new Date(input.snapshot.generatedAt));
  const materialize=(p:PublicCatalogProduct):PublicCatalogProduct=>{
    const view=productTitleView(productPresentation(p),input.merchandising??{});
    return{...view,...(p.persistent?{persistent:{...productTitleView(productPresentation(p.persistent),input.merchandising??{}),eligibleUntil:null,indexable:p.persistent.indexable}}:{})};
  };
  const products:PublicCatalogProduct[]=[],held=[...source.heldProducts],groups=new Map<string,PublicCatalogProduct[]>();
  for(const raw of source.products){
    const product=materialize(raw);
    for(const p of [product,...(product.persistent?[product.persistent]:[])]){
      const url=new URL(p.imageUrl,'https://stupid.gifts');
      if(url.origin==='https://stupid.gifts'&&url.pathname!=='/images/gift-placeholder.svg'
        &&(!input.assets?.[url.pathname]||p.eligibleUntil===null&&input.assets[url.pathname].eligibleUntil!==null))throw Error('runtime_local_image_not_bound');
    }
    if(product.eligibleUntil===null){delete product.persistent;products.push(product);continue;}
    const expiry=product.eligibleUntil,group=groups.get(expiry)??[];group.push(product);groups.set(expiry,group);
    if(product.persistent)products.push({...product.persistent});
    else held.push({id:product.id,publicId:product.publicId,slug:product.slug,path:`/gifts/${product.slug}`,title:'Gift currently unavailable',
      description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'expired'} as SafeHeldProduct);
  }
  const overlays:RuntimeCatalogData['overlays']=[],retention:Array<{key:string;sha256:string;notAfter:string}>=[];
  for(const [expiresAt,rows]of groups){
    if(Date.parse(expiresAt)<=(input.now??Date.now)())continue;
    const bytes=new TextEncoder().encode(JSON.stringify(rows)+'\n'),sha256=await runtimeDigest(bytes),ref={sha256,expiresAt},key=runtimeOverlayKey(ref).slice('catalog-v1/'.length);
    const registration={key,sha256,notAfter:expiresAt};
    if(!input.registerFinite)throw Error('runtime_retention_registration_required');
    await input.registerFinite(registration);await input.store.putImmutable(key,bytes);overlays.push(ref);retention.push(registration);
  }
  const snapshot={...source,products,heldProducts:held};
  // Presentation is materialized once. Ranking keeps only verified non-copy
  // signals, not another evergreen source-title/description overlay.
  const merchandising:Record<string,Merchandising[string]>={};
  for(const raw of source.products){const p=productPresentation(persistentPublicProduct(raw)??raw),signal=merchandisingForProduct(p,input.merchandising??{});
    if(signal){const {appeal,variantGroup,commissionPriority,commissionUntil}=signal;
      const item={...(appeal?{appeal}:{}),...(variantGroup?{variantGroup}:{}),...(commissionPriority?{commissionPriority,commissionUntil}: {})};
      if(Object.keys(item).length)merchandising[p.id]=item;}}
  const data:RuntimeCatalogData={schemaVersion:1,releaseId:input.releaseId,sourceCodeSha:input.sourceCodeSha,snapshot,
    productOrder:source.products.map(p=>p.publicId),overlays,assets:input.assets??{},
    repairedSemanticIds:source.products.filter(p=>hasRepairedSemanticCopy(p)||p.persistent&&hasRepairedSemanticCopy(p.persistent)).map(p=>p.publicId),
    legacySemanticFieldsSha256:Object.fromEntries(await Promise.all(source.products.flatMap(p=>{
      const base=persistentPublicProduct(p);return base?[base]:[];}).map(async p=>[p.publicId,await runtimeDigest(canonicalJson(semanticPublicFields(p)))]))),
    ...(input.homepage?{homepage:input.homepage}:{}),...(input.merchandising?{merchandising}:{}),
    ...(input.semanticCatalog?{semanticCatalog:input.semanticCatalog}:{}),...(input.disclosures?{disclosures:input.disclosures}:{})};
  const bytes=runtimeDataBytes(data),dataSha256=await runtimeDigest(bytes),publicSnapshotSha256=await runtimeDigest(JSON.stringify(snapshot)+'\n');
  await input.store.putImmutable('public-catalog/'+dataSha256+'.json',bytes);
  return{data,dataSha256,publicSnapshotSha256,sourceSnapshotSha256:await runtimeDigest(JSON.stringify(source)+'\n'),retention};
}
