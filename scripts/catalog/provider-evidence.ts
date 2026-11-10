import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ProductRights } from '../../lib/catalog/types.ts';
import { editorialSourceHash, normalizedSourceSnapshot, sourceFactCount, hasCurrentApprovedCopy,completeProductName,SHORT_COPY_PROMPT_VERSION } from '../ops/catalog-editorial-core.mjs';
import { canonicalJson, EMBEDDING_MODEL, sha256 } from './migration.ts';
import { explicitMaintenanceTime, maintenanceEmbeddingText } from './maintenance-state.ts';
import { decodePgvectorSendBase64, encodePgvectorSendBase64 } from './pgvector-binary.ts';
import type { MaintenanceIntent } from './maintenance-d1.ts';
import type { SemanticProduct } from './maintenance-state.ts';

type Product = Record<string, unknown>;
type Observation = { id:string; availabilityStatus:string; sourceFactsHash:string; snapshot:unknown };
type Binding = { id:string; sourceFactsHash:string; text:string; nativeBase64:string; vectorBytesSha256:string };
export type ProviderReceipt =
  { schemaVersion:1; kind:'amazon-observation'; operation:'getItems'|'searchItems'; observedAt:string; products:Observation[];
    returnedIds:string[]; requestedIds?:string[] }
  | { schemaVersion:1; kind:'embedding-response'; observedAt:string; model:typeof EMBEDDING_MODEL; products:Binding[] };
const ID=/^[A-Z0-9]{10}$/;
const REF=/^[a-zA-Z0-9._:/-]{1,200}$/;
const native = (input:unknown):string => {
  if (!Array.isArray(input) || input.length!==1536 || !Array.from(input).every(value=>typeof value==='number'
    && Number.isFinite(value) && Number.isFinite(Math.fround(value)))) throw new Error('provider_evidence_vector');
  return encodePgvectorSendBase64(input.map(Math.fround));
};
const vectorHash = (bytes:string) => createHash('sha256').update(Buffer.from(bytes,'base64')).digest('hex');

/** Explicit private capability for the existing runner; not a credential or
 * provider client. Only the reviewed-short path binds exact new values to the
 * same saved supplier observation and independent copy review. saveReceipt MUST durably save/read-verify immutable
 * bytes keyed by sha256 (idempotently after response loss), protect them outside
 * Git, and apply the reviewed retention policy. Echoing a hash is not independent
 * storage proof. Exact embedding text may include the existing sourceQuery;
 * these receipts must never be logged, sent to telemetry or bundled publicly.
 *
 * The clock is captured immediately BEFORE the existing Amazon request: receipt
 * storage/model/write time cannot renew that conservative real observation.
 * No automatic provider retries, persistence, rights or long-term retention is
 * inferred. Unknown evidence grants no proof. A superseded candidate throws
 * BEFORE its write, blocking this run/publication and requiring review. This is
 * NOT instant revocation of prior stored/published truth or its original expiry.
 * A new run must load/review retained evidence explicitly, not invent database NOW.
 * Wire the SAME instance as store.intent=evidence.intent and as the optional
 * providerEvidence in runCatalogWithBackend (or executeCatalog's fifth arg).
 */
export function createCatalogProviderEvidence(options: {
  saveReceipt(input:Readonly<{sha256:string;receipt:ProviderReceipt}>):Promise<{sha256:string;reference:string}>;
  /** Existing protected storage must verify the original object, digest and
   * retention before returning it. Never accept a caller-supplied receipt body. */
  readReceipt?(input:Readonly<{sha256:string;reference:string}>):Promise<ProviderReceipt>;
  reviewedRightsById?:Record<string,ProductRights>;
  reviewedDeleteReference?:string;
  associateTag?:string;
  saveReviewedShort?(input:Readonly<{id:string;sourceFactsHash:string;title:string;description:string;observationReference:string;reviewedAt:string;quality:number}>):Promise<{reference:string}>;
  now?:()=>string;
}) {
  if (typeof options.saveReceipt!=='function' || options.reviewedDeleteReference!==undefined
    && !REF.test(options.reviewedDeleteReference)) throw new Error('provider_evidence_configuration');
  const rights=structuredClone(options.reviewedRightsById || {});
  const observations=new Map<string,{reference:string;observedAt:string;availabilityStatus:string;sourceFactsHash:string}>();
  const touched=new Set<string>();
  const embeddings=new Map<string,Binding & {reference:string}>();
  const shortRights=new Map<string,ProductRights>();
  let receipts=0;
  const clock=()=>explicitMaintenanceTime((options.now || (()=>new Date().toISOString()))());
  async function save(receipt:ProviderReceipt) {
    if (++receipts>512 || Buffer.byteLength(canonicalJson(receipt))>512*1024) throw new Error('provider_evidence_bound');
    const digest=sha256(canonicalJson(receipt));
    let saved;
    try { saved=await options.saveReceipt({sha256:digest,receipt:structuredClone(receipt)}); }
    catch { throw new Error('provider_evidence_storage_unconfirmed'); }
    if (!saved || saved.sha256!==digest || typeof saved.reference!=='string' || !REF.test(saved.reference))
      throw new Error('provider_evidence_storage_unconfirmed');
    return saved.reference;
  }
  async function restoreReceipt(input:Readonly<{sha256:string;reference:string}>) {
    if(typeof options.readReceipt!=='function'||!input||!/^[a-f0-9]{64}$/.test(input.sha256)
      ||!REF.test(input.reference)||Object.keys(input).sort().join(',')!=='reference,sha256')throw Error('provider_evidence_restore_reference');
    const receipt=await options.readReceipt({...input});
    if(!receipt||receipt.schemaVersion!==1||sha256(canonicalJson(receipt))!==input.sha256
      ||!Array.isArray(receipt.products)||receipt.products.length>20||explicitMaintenanceTime(receipt.observedAt)>clock())
      throw Error('provider_evidence_restore_invalid');
    if(receipt.kind==='amazon-observation'){
      const ids=[receipt.returnedIds,...(receipt.requestedIds?[receipt.requestedIds]:[])];
      if(Object.keys(receipt).sort().join(',')!==`kind,observedAt,operation,products,${receipt.requestedIds?'requestedIds,':''}returnedIds,schemaVersion`
        ||!['searchItems','getItems'].includes(receipt.operation)||receipt.requestedIds&&receipt.operation!=='getItems'
        ||ids.some(list=>!Array.isArray(list)||list.length>10||new Set(list).size!==list.length||list.some(id=>!ID.test(id))))
        throw Error('provider_evidence_restore_invalid');
      for(const entry of receipt.products){
        if(Object.keys(entry).sort().join(',')!=='availabilityStatus,id,snapshot,sourceFactsHash'||!ID.test(entry.id)
          ||!receipt.returnedIds.includes(entry.id)||typeof entry.availabilityStatus!=='string'||!entry.availabilityStatus
          ||editorialSourceHash(entry.snapshot)!==entry.sourceFactsHash)
          throw Error('provider_evidence_restore_invalid');
      }
      for(const id of new Set([...(receipt.requestedIds||[]),...receipt.returnedIds])){
        touched.add(id);shortRights.delete(id);
        for(const key of observations.keys())if(key.startsWith(`${id}:`))observations.delete(key);
      }
      for(const entry of receipt.products)observations.set(`${entry.id}:${entry.sourceFactsHash}`,{
        reference:input.reference,observedAt:receipt.observedAt,availabilityStatus:entry.availabilityStatus,sourceFactsHash:entry.sourceFactsHash});
    }else if(receipt.kind==='embedding-response'){
      if(Object.keys(receipt).sort().join(',')!=='kind,model,observedAt,products,schemaVersion'||receipt.model!==EMBEDDING_MODEL
        ||new Set(receipt.products.map(p=>p.id)).size!==receipt.products.length)throw Error('provider_evidence_restore_invalid');
      for(const p of receipt.products){
        if(Object.keys(p).sort().join(',')!=='id,nativeBase64,sourceFactsHash,text,vectorBytesSha256'||!ID.test(p.id)
          ||typeof p.text!=='string'||Buffer.byteLength(p.text)>64000||!/^[a-f0-9]{64}$/.test(p.sourceFactsHash)
          ||vectorHash(p.nativeBase64)!==p.vectorBytesSha256||native(decodePgvectorSendBase64(p.nativeBase64,1536))!==p.nativeBase64)
          throw Error('provider_evidence_restore_invalid');
      }
      for(const p of receipt.products)embeddings.set(p.id,{...p,reference:input.reference});
    }else throw Error('provider_evidence_restore_invalid');
  }
  return Object.freeze({
    restoreReceipt,
    async amazon(operation:'getItems'|'searchItems',load:()=>Promise<Product[]>,normalize?:(product:Product)=>Product,requestedIds?:string[]) {
      if (!['getItems','searchItems'].includes(operation) || requestedIds!==undefined && (operation!=='getItems'
        || !Array.isArray(requestedIds) || requestedIds.length>10 || requestedIds.some(id=>typeof id!=='string' || !ID.test(id))
        || new Set(requestedIds).size!==requestedIds.length)) throw new Error('provider_evidence_operation');
      requestedIds=requestedIds ? [...requestedIds] : undefined;
      const observedAt=clock(); const products=await load();
      const returnedIds=(Array.isArray(products)?products:[]).map(p=>p?.id).filter((id):id is string=>typeof id==='string' && ID.test(id));
      // Only the latest response may support this run's verification. Clear
      // prior variants even if the new response is missing/unverified or its
      // storage acknowledgement is uncertain. GetItems omission is conservative
      // proof invalidation, NOT a claim of unavailability; search omission is not.
      for (const id of new Set([...(requestedIds || []),...returnedIds])) {
        touched.add(id);
        shortRights.delete(id);
        for (const key of observations.keys()) if (key.startsWith(`${id}:`)) observations.delete(key);
      }
      if (!Array.isArray(products) || products.length>10 || new Set(products.map(p=>p?.id)).size!==products.length)
        throw new Error('provider_evidence_products');
      const entries:Observation[]=[];
      for (const original of products) {
        // A Google title fallback, a missing source image or an unverified row
        // cannot become a fresh Amazon observation through later runner merges.
        if (typeof original?.id!=='string' || !ID.test(original.id) || original.source!=='amazon' || original.remotelyVerified!==true
          || typeof original.title!=='string' || !original.title.trim() || typeof original.imageUrl!=='string' || !original.imageUrl
          || typeof original.availabilityStatus!=='string' || !original.availabilityStatus || !original.sourceFacts
          || typeof original.sourceFacts!=='object' || Array.isArray(original.sourceFacts) || sourceFactCount(original)<1) continue;
        const variants=[structuredClone(original)];
        if (normalize) {
          const normalized=normalize(structuredClone(variants[0]));
          // Only the runner's existing deterministic image cleanup is allowed.
          // Provider JS objects can legitimately carry explicit undefined
          // optional ratings. Compare them exactly; only receipts are JSON.
          if (!isDeepStrictEqual({...normalized,imageUrl:variants[0].imageUrl},variants[0])) throw new Error('provider_evidence_normalization');
          variants.push(normalized);
        }
        for (const p of variants) {
          const entry={id:String(p.id),availabilityStatus:String(p.availabilityStatus),sourceFactsHash:editorialSourceHash(p),snapshot:normalizedSourceSnapshot(p)};
          if (!entries.some(value=>value.id===entry.id && value.sourceFactsHash===entry.sourceFactsHash)) entries.push(entry);
        }
      }
      const reference=await save({schemaVersion:1,kind:'amazon-observation',operation,observedAt,products:entries,returnedIds,
        ...(requestedIds ? {requestedIds:[...requestedIds]} : {})});
      for (const entry of entries) observations.set(`${entry.id}:${entry.sourceFactsHash}`,{reference,observedAt,
        availabilityStatus:entry.availabilityStatus,sourceFactsHash:entry.sourceFactsHash});
      return products; // Exact original values/references: no provider payload changes.
    },
    async reviewedShort(p:Product, review:Product|undefined) {
      if(!options.saveReviewedShort || typeof options.associateTag!=='string' || !/^[a-z0-9-]{1,100}$/i.test(options.associateTag)
        || typeof p?.id!=='string' || !ID.test(p.id) || review?.approved!==true
        || p.editorialStatus!=='short_ready' || !hasCurrentApprovedCopy(p) || p.isActive!==true || p.requiresManualReview===true
        || !(Number(review.qualityScore)>=0.8 && Number(review.qualityScore)<=1))return false;
      const sourceFactsHash=editorialSourceHash(p),observation=observations.get(`${p.id}:${sourceFactsHash}`);
      if(!observation || observation.availabilityStatus!==p.availabilityStatus || p.editorialSourceHash!==sourceFactsHash
        || typeof p.title!=='string' || typeof p.imageUrl!=='string' || typeof p.wittyDescription!=='string'
        || typeof p.affiliateUrl!=='string')return false;
      let affiliate:URL;try{affiliate=new URL(p.affiliateUrl);}catch{return false;}
      if(affiliate.protocol!=='https:'||affiliate.hostname!=='www.amazon.com'||affiliate.username||affiliate.password||affiliate.port||affiliate.pathname!==`/dp/${p.id}`
        ||affiliate.searchParams.get('tag')!==options.associateTag||[...affiliate.searchParams.keys()].some(k=>k!=='tag')
        ||affiliate.searchParams.getAll('tag').length!==1||affiliate.hash)return false;
      const reviewedAt=clock(),observedAt=new Date(observation.observedAt).toISOString(),expiresAt=new Date(Date.parse(observation.observedAt)+86400000).toISOString();
      if(Date.parse(reviewedAt)>=Date.parse(expiresAt))return false;
      const title=p.editorialPromptVersion===SHORT_COPY_PROMPT_VERSION&&typeof p.punnyTitle==='string'&&completeProductName(p.punnyTitle)?p.punnyTitle:p.title;
      if(p.editorialPromptVersion===SHORT_COPY_PROMPT_VERSION&&!completeProductName(p.punnyTitle))return false;
      const saved=await options.saveReviewedShort({id:p.id,sourceFactsHash,title,description:p.wittyDescription,
        observationReference:observation.reference,reviewedAt,quality:Number(review.qualityScore)});
      if(!saved||typeof saved.reference!=='string'||!REF.test(saved.reference))throw new Error('provider_evidence_storage_unconfirmed');
      const merchant=(value:string)=>({basis:'merchant' as const,reference:observation.reference,value,observedAt,expiresAt});
      const authored=(value:string)=>({basis:'owned' as const,reference:saved.reference,value});
      shortRights.set(p.id,{title:merchant(p.title),imageUrl:merchant(p.imageUrl),affiliateUrl:authored(p.affiliateUrl),
        description:authored(p.wittyDescription),wittyDescription:authored(p.wittyDescription),
        // A reviewed factual name, original short copy and canonical link keep
        // the new identity usable after its supplier photo expires. The existing
        // photo overlay renders that photo only until its original deadline.
        // This never relabels supplier imagery as permanently licensed, nor
        // replaces an existing independently cleared product base.
        persistent:{title:authored(title),description:authored(p.wittyDescription),affiliateUrl:authored(p.affiliateUrl),
          imageUrl:{basis:'owned',reference:'site/images/gift-placeholder.svg',value:'/images/gift-placeholder.svg'}}});
      return true;
    },
    async embeddings(input:{products:Product[];model:string;inputs:string[];response:unknown}) {
      const {products,model,inputs}=input;
      const response=input.response as {model?:unknown;data?:Array<{index?:unknown;embedding?:unknown}>};
      if (model!==EMBEDDING_MODEL || response?.model!==model || !Array.isArray(products) || !products.length || products.length>20
        || !Array.isArray(inputs) || inputs.length!==products.length || !Array.isArray(response.data) || response.data.length!==products.length
        || new Set(products.map(p=>p.id)).size!==products.length) throw new Error('provider_evidence_embedding_response');
      const entries=products.map((p,index)=>{
        if (typeof p?.id!=='string' || !ID.test(p.id) || response.data![index]?.index!==index || typeof inputs[index]!=='string'
          || Buffer.byteLength(inputs[index])>64000 || inputs[index]!==maintenanceEmbeddingText(p as SemanticProduct,inputs[index]))
          throw new Error('provider_evidence_embedding_input');
        const bytes=native(response.data![index].embedding);
        return {id:String(p.id),sourceFactsHash:editorialSourceHash(p),text:inputs[index],nativeBase64:bytes,vectorBytesSha256:vectorHash(bytes)};
      });
      const reference=await save({schemaVersion:1,kind:'embedding-response',observedAt:clock(),model,products:entries});
      for (const entry of entries) embeddings.set(entry.id,{...entry,reference});
    },
    intent(method:string,args:unknown[]):MaintenanceIntent {
      const intent:MaintenanceIntent=options.reviewedDeleteReference ? {reviewedDeleteReference:options.reviewedDeleteReference} : {};
      if (method!=='upsertProduct') return intent;
      const p=args[0] as SemanticProduct;const sourceFactsHash=args[1];
      if (!p || typeof p.id!=='string' || !ID.test(p.id)) return intent;
      const observation=observations.get(`${p.id}:${sourceFactsHash}`);
      const matches=Boolean(observation && p.source==='amazon' && p.remotelyVerified!==false
        && sourceFactsHash===editorialSourceHash(p) && observation.availabilityStatus===p.availabilityStatus);
      // Absence cannot revoke a stored observation: the maintenance store may
      // correctly carry it (including equal DB milliseconds). Explicitly stop
      // stale writes rather than relying on a new SQL timestamp to erase it.
      if (touched.has(p.id) && !matches) throw new Error('provider_evidence_superseded');
      if (p.source!=='amazon' || sourceFactsHash!==editorialSourceHash(p)) return intent;
      if (rights[p.id] || shortRights.has(p.id)) intent.rightsById={[p.id]:structuredClone(rights[p.id] ?? shortRights.get(p.id)!)};
      if (observation && p.remotelyVerified!==false && observation.availabilityStatus===p.availabilityStatus)
        intent.verificationById={[p.id]:{reference:observation.reference,observedAt:observation.observedAt,sourceFactsHash}};
      const embedding=embeddings.get(p.id);
      // The store's canonical operation JSON normalizes -0 to0; its optional
      // third argument preserves ORIGINAL native bytes. Accept that documented
      // representation only when every numerical float32 still matches.
      let incomingNative:string|null=null;
      if (Array.isArray(p.embedding)) {
        incomingNative=native(p.embedding);
        if (args[2]!==undefined) {
          const exact=decodePgvectorSendBase64(args[2]);
          incomingNative=exact.every((v,i)=>v===Math.fround(p.embedding![i])) ? String(args[2]) : null;
        }
      }
      if (embedding && embedding.sourceFactsHash===sourceFactsHash && embedding.text===maintenanceEmbeddingText(p,embedding.text)
        && incomingNative===embedding.nativeBase64)
        intent.embeddingById={[p.id]:{reference:embedding.reference,model:EMBEDDING_MODEL,text:embedding.text,sourceFactsHash}};
      return intent;
    },
  });
}
