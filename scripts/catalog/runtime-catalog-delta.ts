import type {CatalogSnapshot,PublicCatalogProduct} from '../../lib/catalog/types.ts';
import {validateCatalogSnapshot,validatePublicCatalogProduct} from '../../lib/catalog/snapshot.ts';
import {persistentPublicProduct,resolvePublicProduct} from '../../lib/catalog/display.ts';

/** Already reviewed source changes. The publisher must authenticate their full
 * row/operation/private-version CAS; these are not client-supplied products. */
export type RuntimeCatalogChange={id:string;publicId:string;slug:string}&(
  {kind:'publish';product:PublicCatalogProduct;restoreUnavailable?:true}
  |{kind:'unavailable'}|{kind:'preserve'});

/** Inherit the accepted PUBLIC catalog, never mutable unrelated source rows.
 * No discovery, private inventory/native audit, re-enrichment or new grants.
 * Expired overlays fall back to their original cleared base at the real clock. */
export function assembleRuntimeCatalogDelta(previousInput:CatalogSnapshot,changes:RuntimeCatalogChange[],
  identity:{catalogRevision:string;generatedAt:string}){
  const previous=validateCatalogSnapshot(previousInput,new Date(previousInput.generatedAt)),at=new Date(identity.generatedAt);
  if(!Number.isFinite(at.getTime())||at.toISOString()!==identity.generatedAt||at.getTime()<Date.parse(previous.generatedAt)
    ||identity.catalogRevision===previous.catalogRevision||!Array.isArray(changes)||changes.length>10000
    ||new Set(changes.map(c=>c.id)).size!==changes.length||new Set(changes.map(c=>c.publicId)).size!==changes.length)
    throw Error('runtime_delta_invalid');
  const products=new Map(previous.products.map(p=>[p.publicId,resolvePublicProduct(p,at)]).filter((p):p is [string,PublicCatalogProduct]=>Boolean(p[1])));
  const held=new Map(previous.heldProducts.map(p=>[p.publicId,p]));
  for(const p of previous.products)if(!products.has(p.publicId))held.set(p.publicId,{id:p.id,publicId:p.publicId,slug:p.slug,path:'/gifts/'+p.slug,
    title:'Gift currently unavailable',description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'expired'});
  const identities=new Map([...previous.products,...previous.heldProducts].map(p=>[p.publicId,p]));
  const slugs=new Map([...identities.values(),...previous.slugHistory.map(s=>({slug:s.slug,publicId:s.publicId}))].map(p=>[p.slug,p.publicId]));
  const ids=new Map([...identities.values()].map(p=>[p.id,p.publicId])),deferred:string[]=[];
  for(const change of changes){
    const before=identities.get(change.publicId);
    if(before&&(before.id!==change.id||before.slug!==change.slug)||ids.has(change.id)&&ids.get(change.id)!==change.publicId
      ||slugs.has(change.slug)&&slugs.get(change.slug)!==change.publicId)throw Error('runtime_delta_identity_changed');
    if(change.kind==='preserve'){if(!before)throw Error('runtime_delta_identity_missing');deferred.push(change.publicId);continue;}
    if(change.kind==='unavailable'){
      if(!before)throw Error('runtime_delta_identity_missing');
      if(held.has(change.publicId)&&held.get(change.publicId)!.reason!=='unavailable'){deferred.push(change.publicId);continue;}
      products.delete(change.publicId);held.set(change.publicId,{id:change.id,publicId:change.publicId,slug:change.slug,path:'/gifts/'+change.slug,
        title:'Gift currently unavailable',description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'unavailable'});
      continue;
    }
    if(change.kind!=='publish')throw Error('runtime_delta_invalid');
    const product=validatePublicCatalogProduct(change.product,at);
    if(product.id!==change.id||product.publicId!==change.publicId||product.slug!==change.slug||!persistentPublicProduct(product))throw Error('runtime_delta_identity_changed');
    const priorHold=held.get(change.publicId);
    // A normal refresh cannot erase an explicit exclusion. Only a genuine
    // positive retailer observation can restore a previously stock-held gift.
    if(priorHold&&(priorHold.reason!=='unavailable'||!change.restoreUnavailable)){deferred.push(change.publicId);continue;}
    products.set(change.publicId,product);held.delete(change.publicId);
    ids.set(change.id,change.publicId);slugs.set(change.slug,change.publicId);
  }
  const snapshot=validateCatalogSnapshot({...previous,...identity,products:[...products.values()],heldProducts:[...held.values()]},at);
  return{snapshot,deferred};
}
