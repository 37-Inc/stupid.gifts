import type { PublicCatalogProduct } from './types.ts';
import { catalogSearchTerms } from './search-terms.ts';
import { appealPriority, usableCommissionPriority, merchandisingForProduct } from './merchandising.ts';
import type { Merchandising } from './merchandising.ts';

type RankedProduct = PublicCatalogProduct & {rankScore:number};
const normalized=(value:string)=>value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

/** Reciprocal rank fusion, then explicit comparable-relevance/appeal tiers.
 * No category admission rules, legacy quality-score boost, or per-query model.
 * Only verified same-design groups spread; every variant stays available. */
export function rankHybridResults<T extends RankedProduct>(query:string,lexical:readonly T[],semantic:readonly T[],
  merchandising:Merchandising={},now=Date.now()):T[]{
  const candidates=new Map<string,{product:T;rrf:number;lexicalRank:number;hasSemantic:boolean}>();
  for(const [list,lane] of [[lexical,'lexical'],[semantic,'semantic']] as const){
    const seen=new Set<string>();
    list.forEach((product,index)=>{
      if(seen.has(product.id))return;seen.add(product.id);
      const entry=candidates.get(product.id)??{product,rrf:0,lexicalRank:Infinity,hasSemantic:false};
      entry.rrf+=1/(60+index+1);
      if(lane==='lexical')entry.lexicalRank=index;
      else {entry.product=product;entry.hasSemantic=true;}
      candidates.set(product.id,entry);
    });
  }
  const terms=catalogSearchTerms(query),needle=normalized(query);
  const ranked=[...candidates.values()].map(entry=>{
    const title=normalized(entry.product.title),description=normalized(entry.product.description);
    const titleCoverage=terms.filter(t=>title.includes(t)).length/Math.max(1,terms.length);
    const fullCoverage=terms.every(t=>title.includes(t)||description.includes(t));
    // Literal objects/variants cannot be displaced by an unrelated campaign.
    const exact=title===needle || terms.length>1&&title.includes(needle);
    // A single retrieval lane stays in one coarse band regardless of an old
    // catalog-ID tie-break. Agreement between both lanes can strengthen it.
    const agreement=Math.floor(entry.rrf/0.02);
    const relevance=exact?100:fullCoverage?30+agreement
      :titleCoverage>=.5?20+agreement:10+agreement;
    const signal=merchandisingForProduct(entry.product,merchandising);
    return{...entry,exact,relevance,appeal:appealPriority(signal?.appeal),
      commission:usableCommissionPriority(signal,now),group:signal?.variantGroup};
  }).sort((a,b)=>b.relevance-a.relevance || b.appeal-a.appeal || b.commission-a.commission
    || b.rrf-a.rrf || Number(b.hasSemantic)-Number(a.hasSemantic)
    || a.lexicalRank-b.lexicalRank || a.product.id.localeCompare(b.product.id));
  const groups=new Set<string>(),first:typeof ranked=[],deferred:typeof ranked=[];
  for(const entry of ranked){
    if(!entry.exact&&entry.group&&groups.has(entry.group))deferred.push(entry);
    else{first.push(entry);if(entry.group)groups.add(entry.group);}
  }
  return [...first,...deferred].map(({product,rrf})=>({...product,rankScore:rrf}));
}
