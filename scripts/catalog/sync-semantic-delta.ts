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
import {canonicalDescriptionEmbeddingInput,hasRepairedSemanticCopy} from '../../lib/catalog/presentation.ts';
import {validateAutomationCohort} from '../../lib/catalog/automation-cohort.ts';

type Row=Record<string,unknown>;
export type DerivedVector={id:string;values:number[];metadata:ReturnType<typeof semanticVectorMetadata>};
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const hash=(value:unknown)=>sha256(canonicalJson(value));
function refuse():never{throw Error('semantic_delta_source_mismatch');}
/** Absence means the saved embedding describes different public copy. Keep the
 * correct listing/keyword result; optional semantic coverage cannot block it. */
function semanticInputBinding(product:PublicCatalogProduct,text:unknown):{inputRecipe?:'canonical-short-description-v2'}|null {
  if(typeof text!=='string')return null;
  if(text===canonicalDescriptionEmbeddingInput(product))return{inputRecipe:'canonical-short-description-v2'};
  if(semanticProductInput(product,null)===text)return{};
  const prefix=[product.punnyTitle,product.title,product.wittyDescription].filter(Boolean).join('. '),suffix=product.humorTags?.join(' ');
  if(!text.startsWith(prefix+'. ')||suffix&&!text.endsWith('. '+suffix))return null;
  const context=text.slice(prefix.length+2,suffix?-(suffix.length+2):undefined);
  return context&&semanticProductInput(product,context)===text?{}:null;
}
function assertSource(product:PublicCatalogProduct,row:Row,state:Row,
  inventory:{productSha256:string;privateStateSha256:string}) {
  if(product.id!==row.id||product.publicId!==row.public_id||row.is_active!==1||row.duplicate_of_product_id!==null
    ||hash(row)!==inventory.productSha256||hash(state)!==inventory.privateStateSha256||state.product_id!==row.id)refuse();
}

/** Reuse VERIFIED native bytes, not another embedding/model call. The complete
 * private sidecar and products row must belong to the approved inventory. */
export async function deriveMaintenanceSearchVector(product:PublicCatalogProduct,row:Row,state:Row,
  inventory:{productSha256:string;privateStateSha256:string}) {
  assertSource(product,row,state,inventory);
  if(state.embedding_present!==1||typeof state.embedding_native_base64!=='string')refuse();
  const native=decodePgvectorSendBase64(state.embedding_native_base64);
  const proof=JSON.parse(String(state.embedding_provenance_json)),text=maintenanceEmbeddingText(
    maintenanceState({...row,maintenance_semantic:state.semantic_json}),proof.text);
  if(proof.input!=='verified'||proof.model!==DERIVED_SEARCH_PROFILE.model||proof.text!==text
    ||proof.embeddingTextHash!==sha256(text)
    ||proof.vectorBytesSha256!==digest(Buffer.from(state.embedding_native_base64,'base64'))
    ||!/^objects\/[a-f0-9]{64}\.json$/.test(proof.reference))refuse();
  // Supplier facts/photos are not embedding input. The inventory binds the
  // current row/state; the verified saved text/native bytes below bind semantic
  // reuse. Keep the ORIGINAL proof's source facts, never invent a fresh model
  // observation or require a photo-specific exception for unchanged copy.
  // Keep the original retained context verbatim. Never relabel a vector whose
  // public semantic fields have changed independently of its captured input.
  const binding=semanticInputBinding(product,text);if(!binding)refuse();
  const recipe=binding.inputRecipe;
  const values=normalizeSemanticPrefix(native,DERIVED_SEARCH_PROFILE.dimensions);
  const identity={productId:product.id,publicId:product.publicId,publicFieldsSha256:hash(semanticPublicFields(product,recipe)),
    ...(recipe?{inputRecipe:recipe}:{}),
    inputSha256:sha256(text),originalNativeSha256:proof.vectorBytesSha256,
    derivedNativeSha256:digest(Buffer.from(encodePgvectorSendBase64(values),'base64')),
    receiptSha256:proof.reference.slice(8,-5),sourceFactsHash:String(proof.sourceFactsHash)};
  const entry:SemanticCatalogEntry={...identity,vectorId:await semanticVectorIdentity(identity)};
  return {entry,vector:{id:entry.vectorId,values,metadata:semanticVectorMetadata(entry)}};
}

/** At most the reviewed cohort, never a catalog-wide model/index rebuild. */
export async function prepareMaintenanceSearchDelta(db:CatalogD1,revision:ApprovedCohortRevision,catalogInput:unknown) {
  const catalog=await verifySemanticCatalogIdentities(catalogInput);
  const known=new Map(catalog.entries.map(e=>[e.publicId,e]));
  const products=new Map(revision.snapshot.products.flatMap(p=>{const base=persistentPublicProduct(p);return base?[[base.publicId,base] as const]:[];}));
  const changes=revision.request.approval.changes;
  if(revision.request.automation)validateAutomationCohort(revision.request.automation,revision.request.approval);
  if(!revision.request.automation&&changes.length>30||new Set(changes.map(c=>c.publicId)).size!==changes.length||!revision.persistent)refuse();
  const vectors:DerivedVector[]=[],entries:SemanticCatalogEntry[]=[];
  for(const change of changes){
    const product=products.get(change.publicId);
    if(!product)continue;
    const existing=known.get(product.publicId);
    if(existing&&!hasRepairedSemanticCopy(product)
      &&existing.publicFieldsSha256===hash(semanticPublicFields(product,existing.inputRecipe)))continue;
    const captured=revision.persistent.inventory.find(p=>p.publicId===product.publicId);if(!captured)refuse();
    const rows=(await db.prepare('SELECT * FROM products WHERE id=?').bind(product.id).all()).results;
    const states=(await db.prepare('SELECT * FROM catalog_maintenance_products WHERE product_id=?').bind(product.id).all()).results;
    if(rows.length!==1||states.length!==1)refuse();
    assertSource(product,rows[0],states[0],captured);
    // Preserved legacy listings may have no native embedding. Their exact
    // source still must match; missing optional coverage is not corruption or
    // permission to generate a vector, hide a listing or remove index history.
    if((states[0].embedding_present===null||states[0].embedding_present===0)
      &&states[0].embedding_native_base64===null)continue;
    if(states[0].embedding_present!==1||typeof states[0].embedding_native_base64!=='string')refuse();
    const proof=JSON.parse(String(states[0].embedding_provenance_json));
    const prior=known.get(product.publicId);
    if(prior&&prior.originalNativeSha256===proof.vectorBytesSha256
      &&prior.publicFieldsSha256===hash(semanticPublicFields(product,prior.inputRecipe)))continue;
    if(!semanticInputBinding(product,proof.text))continue;
    const projected=await deriveMaintenanceSearchVector(product,rows[0],states[0],captured);
    if(known.get(product.publicId)?.vectorId!==projected.entry.vectorId){entries.push(projected.entry);vectors.push(projected.vector);}
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
    if(!response.ok||result.success!==true){
      const codes=Array.isArray(result.errors)?result.errors.flatMap((e:{code?:unknown})=>Number.isSafeInteger(e?.code)?[e.code]:[]).slice(0,3):[];
      throw Error(`semantic_delta_provider_failed_${path}_http_${response.status}${codes.map(code=>`_code_${code}`).join('')}`);
    }return result.result;
  };
  const read=async()=>{
    // Vectorize accepts at most20 IDs per lookup, independently of upsert batch
    // size. This is a transport chunk, never a cap on the approved delta.
    const result:Array<DerivedVector & {namespace?:string}>=[];
    for(let offset=0;offset<vectors.length;offset+=20){
      const page=await request('get_by_ids',JSON.stringify({ids:vectors.slice(offset,offset+20).map(v=>v.id)}));
      if(!Array.isArray(page))throw Error('semantic_delta_provider_failed');result.push(...page);
    }
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
    if(attempt<5)await (input.wait??(ms=>new Promise(resolve=>setTimeout(resolve,ms))))(30000);
  }
  throw Error('semantic_delta_pending');
}

export async function syncApprovedSearchDelta(input:{db:CatalogD1;owner:MutationOwner;revision:ApprovedCohortRevision;
  catalog:unknown;accountId:string;token:string;fetch:typeof fetch}) {
  await input.db.batch([mutationAssertion(input.db,input.owner,['freezing'])]);
  const delta=await prepareMaintenanceSearchDelta(input.db,input.revision,input.catalog);
  const result={verified:0,upserted:0};
  for(let offset=0;offset<delta.vectors.length;offset+=30){
    const part=await syncDerivedSearchVectors({...input,indexName:delta.indexName,vectors:delta.vectors.slice(offset,offset+30)});
    result.verified+=part.verified;result.upserted+=part.upserted;
  }
  await input.db.batch([mutationAssertion(input.db,input.owner,['freezing'])]);
  return {indexName:delta.indexName,entries:delta.entries,...result};
}
