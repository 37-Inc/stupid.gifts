import type {CatalogSnapshot,PublicCatalogProduct} from './types.ts';

export type RuntimeEdits=Record<string,{revision:number;payload:unknown}>;
/** One presentation projection for every public consumer. The accepted source
 * and original licensed/native history remain immutable. A listed intent only
 * removes our editorial hold; it cannot revive a supplier/rights-held product. */
export function runtimePresentation(snapshot:CatalogSnapshot,edits:RuntimeEdits){
  const repaired:string[]=[],held=[...snapshot.heldProducts];
  const products=snapshot.products.flatMap(original=>{
    const edit=edits['/products/'+original.publicId]?.payload as {title?:string;description?:string;visibility?:string}|undefined;
    if(!edit)return[original];
    if(edit.visibility==='unlisted'){
      held.push({id:original.id,publicId:original.publicId,slug:original.slug,path:'/gifts/'+original.slug,
        title:'Gift currently unavailable',description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'editorial_hold'});
      return[];
    }
    const changed=edit.title!==undefined&&edit.title!==original.title||edit.description!==undefined&&edit.description!==original.description;
    if(changed)repaired.push(original.publicId);
    const apply=<T extends PublicCatalogProduct>(p:T):T=>({...p,
      ...(edit.title!==undefined?{title:edit.title}:{}),...(edit.description!==undefined?{description:edit.description}:{}),
      ...(changed?{punnyTitle:undefined,wittyDescription:edit.description??p.description,humorTags:[]}:{})});
    return[{...apply(original),...(original.persistent?{persistent:apply(original.persistent)}:{})}];
  });
  return{snapshot:{...snapshot,products,heldProducts:held},repaired};
}
