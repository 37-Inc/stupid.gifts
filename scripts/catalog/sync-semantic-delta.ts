import {createHash} from 'node:crypto';
import {canonicalJson,sha256} from './migration.ts';
import {maintenanceEmbeddingText,maintenanceState} from './maintenance-state.ts';
import {decodePgvectorSendBase64,encodePgvectorSendBase64} from './pgvector-binary.ts';
import {persistentPublicProduct} from '../../lib/catalog/display.ts';
import {DERIVED_SEARCH_PROFILE,normalizeSemanticPrefix,semanticProductInput,semanticPublicFields,
  semanticVectorIdentity,semanticVectorMetadata,verifySemanticCatalogIdentities} from '../../lib/catalog/semantic-profile.ts';
import type {PublicCatalogProduct} from '../../lib/catalog/types.ts';
import type {SemanticCatalogEntry} from '../../lib/catalog/semantic-profile.ts';
import type {ApprovedCohortRevision} from '../../lib/catalog/freeze-approved-cohort.ts';
import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import {mutationAssertion} from '../../lib/catalog/mutation-fence.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';

type Row=Record<string,unknown>;
export type DerivedVector={id:string;values:number[];metadata:ReturnType<typeof semanticVectorMetadata>};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hash=(value:unknown)=>sha256(canonicalJson(value));
function refuse():never{throw Error('semantic_delta_source_mismatch');}

/** Reuse VERIFIED native bytes, not another embedding/model call. The complete
 * private sidecar and products row must belong to the approved inventory. */
export async function deriveMaintenanceSearchVector(product:PublicCatalogProduct,row:Row,state:Row,
  inventory:{sourceRowSha256?:string;productSha256:string;privateStateSha256:string}) {
  if(product.id!==row.id||product.publicId!==row.public_id||row.is_active!==1||row.duplicate_of_product_id!==null
    ||hash(row)!==inventory.productSha256||hash(state)!==inventory.privateStateSha256
    ||state.product_id!==row.id||state.embedding_present!==1||typeof state.embedding_native_base64!=='string')refuse();
  const native=decodePgvectorSendBase64(state.embedding_native_base64);
  const proof=JSON.parse(String(state.embedding_provenance_json)),text=maintenanceEmbeddingText(
    maintenanceState({...row,maintenance_semantic:state.semantic_json}));
  if(proof.input!=='verified'||proof.model!==DERIVED_SEARCH_PROFILE.model||proof.text!==text
    ||proof.embeddingTextHash!==sha256(text)||row.embedding_text_hash!==proof.embeddingTextHash
    ||proof.sourceFactsHash!==row.source_facts_hash
    ||proof.vectorBytesSha256!==digest(Buffer.from(state.embedding_native_base64,'base64'))
    ||!/^objects\/[a-f0-9]{64}\.json$/.test(proof.reference))refuse();
  // Keep the original retained context verbatim. Never relabel a vector whose
  // public semantic fields have changed independently of its captured input.
  const prefix=[product.punnyTitle,product.title,product.wittyDescription].filter(Boolean).join('. ');
  const suffix=product.humorTags?.join(' ');
  let context:string|null=null;
  if(semanticProductInput(product,null)!==text){
    if(!text.startsWith(prefix+'. ')||suffix&&!text.endsWith('. '+suffix))refuse();
    context=text.slice(prefix.length+2,suffix?-(suffix.length+2):undefined);
    if(!context||semanticProductInput(product,context)!==text)refuse();
  }
  const values=normalizeSemanticPrefix(native,DERIVED_SEARCH_PROFILE.dimensions);
  const identity={productId:product.id,publicId:product.publicId,publicFieldsSha256:hash(semanticPublicFields(product)),
    inputSha256:sha256(text),originalNativeSha256:proof.vectorBytesSha256,
    derivedNativeSha256:digest(Buffer.from(encodePgvectorSendBase64(values),'base64')),
    receiptSha256:proof.reference.slice(8,-5),sourceFactsHash:String(row.source_facts_hash)};
  const entry:SemanticCatalogEntry={...identity,vectorId:await semanticVectorIdentity(identity)};
  return {entry,vector:{id:entry.vectorId,values,metadata:semanticVectorMetadata(entry)}};
}

/** At most the reviewed cohort, never a catalog-wide model/index rebuild. */
export async function prepareMaintenanceSearchDelta(db:CatalogD1,revision:ApprovedCohortRevision,catalogInput:unknown) {
  const catalog=await verifySemanticCatalogIdentities(catalogInput);
  const known=new Map(catalog.entries.map(e=>[e.publicId,e]));
  const products=new Map(revision.snapshot.products.flatMap(p=>{const base=persistentPublicProduct(p);return base?[[base.publicId,base] as const]:[];}));
  const changes=revision.request.approval.changes;
  if(changes.length>30||new Set(changes.map(c=>c.publicId)).size!==changes.length||!revision.persistent)refuse();
  const vectors:DerivedVector[]=[],entries:SemanticCatalogEntry[]=[];
  for(const change of changes){
    const product=products.get(change.publicId);
    if(!product||known.get(product.publicId)?.publicFieldsSha256===hash(semanticPublicFields(product)))continue;
    const captured=revision.persistent.inventory.find(p=>p.publicId===product.publicId);if(!captured)refuse();
    const rows=(await db.prepare('SELECT * FROM products WHERE id=?').bind(product.id).all()).results;
    const states=(await db.prepare('SELECT * FROM catalog_maintenance_products WHERE product_id=?').bind(product.id).all()).results;
    if(rows.length!==1||states.length!==1)refuse();
    const projected=await deriveMaintenanceSearchVector(product,rows[0],states[0],captured);
    entries.push(projected.entry);vectors.push(projected.vector);
  }
  return {indexName:catalog.indexName,vectors,entries};
}

/** Immutable content-addressed IDs make same-payload retries safe, unlike the
 * native mutable-ID outbox. No deletion, model call, source mutation or takeover.
 * Only an explicitly scoped/accounted sender is used by the routine driver. */
export async function syncDerivedSearchVectors(input:{accountId:string;indexName:string;token:string;vectors:DerivedVector[];
  fetch:typeof fetch;wait?:(ms:number)=>Promise<void>}) {
  const {vectors}=input;
  if(!/^[a-f0-9]{32}$/.test(input.accountId)||!vectors.length||vectors.length>30
    ||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(input.indexName)
    ||vectors.some(v=>!/^[a-f0-9]{64}$/.test(v.id)||v.values.length!==DERIVED_SEARCH_PROFILE.dimensions
      ||v.values.some(n=>!Number.isFinite(n)||!Object.is(Math.fround(n),n))
      ||Math.abs(Math.hypot(...v.values)-1)>1e-6
      ||digest(Buffer.from(encodePgvectorSendBase64(v.values),'base64'))!==v.metadata.derivedNativeSha256)
    ||new Set(vectors.map(v=>v.id)).size!==vectors.length)throw Error('semantic_delta_invalid');
  const base=`https://api.cloudflare.com/client/v4/accounts/${input.accountId}/vectorize/v2/indexes/${input.indexName}`;
  const request=async(path:string,body:string,ndjson=false)=>{
    const signal=AbortSignal.timeout(15000);
    const response=await input.fetch(base+'/'+path,{method:'POST',redirect:'error',signal,
      headers:{Authorization:`Bearer ${input.token}`,'Content-Type':ndjson?'application/x-ndjson':'application/json'},body});
    // Response streaming is bounded as well as dispatch; no unbounded .json().
    if(!response.body)throw Error('semantic_delta_provider_failed');
    const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,rejectAbort:(error:Error)=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});void aborted.catch(()=>{});
    const cancel=()=>{void reader.cancel().catch(()=>{});rejectAbort(Error('semantic_delta_timeout'));};
    signal.addEventListener('abort',cancel,{once:true});
    try{for(;;){signal.throwIfAborted();const part=await Promise.race([reader.read(),aborted]);if(part.done)break;
      bytes+=part.value.length;if(bytes>1024*1024)throw Error('semantic_delta_response_too_large');chunks.push(part.value);}}
    finally{signal.removeEventListener('abort',cancel);void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
    signal.throwIfAborted();const result=JSON.parse(Buffer.concat(chunks).toString());
    if(!response.ok||result.success!==true)throw Error('semantic_delta_provider_failed');return result.result;
  };
  const read=async()=>{
    const result=await request('get_by_ids',JSON.stringify({ids:vectors.map(v=>v.id)}));
    if(!Array.isArray(result)||result.length>vectors.length||new Set(result.map(v=>v.id)).size!==result.length)
      throw Error('semantic_delta_provider_failed');
    for(const returned of result){const expected=vectors.find(v=>v.id===returned.id);
      if(!expected||returned.namespace||canonicalJson(returned.metadata)!==canonicalJson(expected.metadata)
        ||!Array.isArray(returned.values)||returned.values.length!==DERIVED_SEARCH_PROFILE.dimensions
        ||returned.values.some((v:unknown)=>typeof v!=='number'||!Number.isFinite(v))
        ||hash(returned.values.map(Math.fround))!==hash(expected.values))throw Error('semantic_delta_readback_mismatch');}
    return new Set(result.map(v=>v.id));
  };
  const found=await read(),missing=vectors.filter(v=>!found.has(v.id));
  // One vector per request fits the same bounded accounting bridge as native
  // delivery. Existing immutable matches are not written again on resume.
  for(const vector of missing){
    const result=await request('upsert',JSON.stringify(vector)+'\n',true);
    if(typeof result?.mutationId!=='string')throw Error('semantic_delta_provider_failed');
  }
  for(let attempt=0;attempt<6;attempt++){
    if((await read()).size===vectors.length)return {verified:vectors.length,upserted:missing.length};
    if(attempt<5)await (input.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(2000);
  }
  throw Error('semantic_delta_pending');
}

export async function syncApprovedSearchDelta(input:{db:CatalogD1;owner:MutationOwner;revision:ApprovedCohortRevision;
  catalog:unknown;accountId:string;token:string;fetch:typeof fetch}) {
  await input.db.batch([mutationAssertion(input.db,input.owner,['freezing'])]);
  const delta=await prepareMaintenanceSearchDelta(input.db,input.revision,input.catalog);
  const result=delta.vectors.length?await syncDerivedSearchVectors({...input,...delta}):{verified:0,upserted:0};
  await input.db.batch([mutationAssertion(input.db,input.owner,['freezing'])]);
  return {indexName:delta.indexName,entries:delta.entries,...result};
}
