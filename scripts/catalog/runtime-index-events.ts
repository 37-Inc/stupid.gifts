import {createHash} from 'node:crypto';
import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {RuntimeCatalogData} from '../../lib/catalog/runtime-catalog.ts';
import {readRuntimeCatalogData} from '../../lib/catalog/runtime-catalog.ts';
import {encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {canonicalDescriptionEmbeddingInput} from '../../lib/catalog/presentation.ts';
import {DERIVED_SEARCH_PROFILE,normalizeSemanticPrefix,semanticPublicFields,semanticVectorIdentity,semanticVectorMetadata} from '../../lib/catalog/semantic-profile.ts';
import {canonicalJson,sha256} from './migration.ts';
import {decodePgvectorSendBase64,encodePgvectorSendBase64} from './pgvector-binary.ts';
import {immutableNativeId,isImmutableNativeVector,nativeVectorDigest} from './immutable-native-vector.ts';
import type {ImmutableNativeVector} from './immutable-native-vector.ts';
import {syncDerivedSearchVectors,syncImmutableNativeVectors} from './sync-semantic-delta.ts';
import type {DerivedVector} from './sync-semantic-delta.ts';
import type {CatalogObjectStore} from './r2-object-store.ts';

type Row=Record<string,unknown>;
type Descriptor={schemaVersion:1;sequence:number;releaseId:string;payloadSha256:string;native:Omit<ImmutableNativeVector,'values'>|null;
  serving:{id:string;nativeBase64:string;metadata:DerivedVector['metadata']}|null;reason?:'not_public'|'copy_mismatch'|'delete_history_retained'};
const byteHash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
function refuse():never{throw Error('runtime_index_evidence_changed');}

async function acceptedData(db:CatalogD1,store:CatalogObjectStore,releaseId:string){
  const rows=(await db.prepare(`SELECT r.*,p.data_sha256,p.source_snapshot_sha256,p.public_snapshot_sha256 FROM publication_receipts r
    JOIN catalog_runtime_publications p USING(release_id) WHERE r.release_id=?`).bind(releaseId).all<Row>()).results;
  if(rows.length!==1)refuse();
  const row=rows[0],intent=JSON.parse(String(row.manifest_json));
  if(encodePublicationIntent(intent)!==row.manifest_json||intent.releaseId!==releaseId||intent.codeSha!==row.code_sha
    ||intent.catalogRevision!==row.catalog_revision||intent.manifestSha256!==row.data_sha256
    ||intent.catalogSnapshotSha256!==row.source_snapshot_sha256)refuse();
  const object=await store.get('public-catalog/'+row.data_sha256+'.json');
  if(!object||byteHash(object.bytes)!==row.data_sha256)refuse();
  const data=readRuntimeCatalogData(JSON.parse(Buffer.from(object.bytes).toString('utf8')));
  if(data.releaseId!==releaseId||data.snapshot.catalogRevision!==row.catalog_revision||data.sourceCodeSha!==row.code_sha
    ||sha256(JSON.stringify(data.snapshot)+'\n')!==row.public_snapshot_sha256)refuse();
  return data;
}

/** Derive only from the original immutable applied payload and the catalog
 * actually accepted with it. Never read a later mutable private product or
 * generate/relabel an embedding. Original payload/native bytes stay retained. */
export async function runtimeIndexDescriptor(input:{sequence:number;releaseId:string;payloadJson:string;data:RuntimeCatalogData}){
  const payload=JSON.parse(input.payloadJson),payloadSha256=sha256(input.payloadJson);
  if(input.data.releaseId!==input.releaseId||payload.sequence!==input.sequence||!Number.isSafeInteger(input.sequence)||input.sequence<1
    ||payload.catalogRevision!==input.data.snapshot.catalogRevision
    ||typeof payload.publicId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(payload.publicId))refuse();
  const base:Descriptor={schemaVersion:1,sequence:input.sequence,releaseId:input.releaseId,payloadSha256,native:null,serving:null};
  // An unlisting does not require deleting native history. Current-public-field
  // resolution already excludes it. Never invent a successful provider delete.
  if(payload.operation==='delete')return{...base,reason:'delete_history_retained' as const};
  if(payload.operation!=='upsert'||payload.model!==DERIVED_SEARCH_PROFILE.model||typeof payload.embeddingText!=='string'
    ||!payload.embeddingText.trim()||Buffer.byteLength(payload.embeddingText)>64000
    ||sha256(payload.embeddingText)!==payload.embeddingTextHash||!HASH.test(payload.sourceFactsHash))refuse();
  const values=Object.hasOwn(payload,'nativeBase64')?decodePgvectorSendBase64(payload.nativeBase64):payload.values;
  if(!Array.isArray(values)||nativeVectorDigest(values)!==payload.vectorBytesSha256)refuse();
  const metadata:ImmutableNativeVector['metadata']={kind:'immutable-native-v1',publicId:payload.publicId,catalogRevision:payload.catalogRevision,
    embeddingTextHash:payload.embeddingTextHash,embeddingModel:payload.model,vectorBytesSha256:payload.vectorBytesSha256,payloadSha256};
  const native={id:immutableNativeId(metadata),values,metadata};if(!isImmutableNativeVector(native))refuse();
  base.native={id:native.id,metadata};
  const product=input.data.snapshot.products.find(p=>p.publicId===payload.publicId);
  if(!product)return{...base,reason:'not_public' as const};
  // Newly generated pipeline embeddings use v2. Do not reinterpret a mismatch
  // as an old context recipe just to get optional coverage. Legacy seed entries
  // and their original bytes/recipes remain intact and resolve independently.
  if(canonicalDescriptionEmbeddingInput(product)!==payload.embeddingText)return{...base,reason:'copy_mismatch' as const};
  const binding={inputRecipe:'canonical-short-description-v2' as const};
  const derived=normalizeSemanticPrefix(values,1024),identity={productId:product.id,publicId:product.publicId,
    publicFieldsSha256:sha256(canonicalJson(semanticPublicFields(product,binding.inputRecipe))),...binding,
    inputSha256:payload.embeddingTextHash,originalNativeSha256:payload.vectorBytesSha256,derivedNativeSha256:nativeVectorDigest(derived)};
  const entry={...identity,vectorId:await semanticVectorIdentity(identity)};
  base.serving={id:entry.vectorId,nativeBase64:encodePgvectorSendBase64(derived),metadata:semanticVectorMetadata(entry)};
  return base;
}

/** One bounded post-publication pass. Its DB writes are delivery/receipt state
 * only. No catalog owner, product/source/head write, provider fetch or model.
 * Caller supplies the existing accounted scoped network sender and retries this
 * SAME immutable work later if Vectorize is still making it visible. */
export async function drainRuntimeIndexEvents(input:{db:CatalogD1;store:CatalogObjectStore;accountId:string;nativeIndexName:string;
  servingIndexName:string;token:string;fetch:typeof fetch;maxEvents?:number;now?:()=>Date}){
  const {db}=input,max=input.maxEvents??30;
  if(!Number.isInteger(max)||max<1||max>30||input.nativeIndexName===input.servingIndexName)throw Error('runtime_index_configuration');
  const pending=(await db.prepare(`SELECT e.sequence,e.release_id,e.operation_id FROM catalog_runtime_index_events e
    JOIN publication_receipts r USING(release_id) WHERE e.state='pending' AND(e.retry_after IS NULL OR e.retry_after<=?)
    ORDER BY e.sequence LIMIT ?`).bind((input.now??(()=>new Date()))().toISOString(),max).all<Row>()).results;
  const cache=new Map<string,RuntimeCatalogData>(),outcomes:Array<{sequence:number;state:'complete'|'pending'|'attention';errorCode?:string}>=[];
  for(const item of pending){const sequence=Number(item.sequence),releaseId=String(item.release_id);
    try{
      let data=cache.get(releaseId);if(!data){data=await acceptedData(db,input.store,releaseId);cache.set(releaseId,data);}
      if(data.semanticCatalog?.indexName!==input.servingIndexName)throw Error('runtime_index_serving_scope_changed');
      const row=(await db.prepare(`SELECT e.*,m.payload_json FROM catalog_runtime_index_events e
        JOIN catalog_maintenance_vector_payloads m ON m.sequence=e.sequence AND m.operation_id=e.operation_id
        WHERE e.sequence=? AND e.release_id=? AND e.operation_id=?`).bind(sequence,releaseId,item.operation_id).all<Row>()).results[0];
      if(!row)refuse();if(row.state==='complete'){outcomes.push({sequence,state:'complete'});continue;}
      const expected=await runtimeIndexDescriptor({sequence,releaseId,payloadJson:String(row.payload_json),data}),encoded=canonicalJson(expected);
      if(row.descriptor_json!==null&&row.descriptor_json!==encoded)refuse();
      if(row.descriptor_json===null){await db.prepare('UPDATE catalog_runtime_index_events SET descriptor_json=? WHERE sequence=? AND descriptor_json IS NULL')
        .bind(encoded,sequence).run();
        const actual=(await db.prepare('SELECT descriptor_json FROM catalog_runtime_index_events WHERE sequence=?').bind(sequence).all<Row>()).results[0];
        if(actual?.descriptor_json!==encoded)refuse();}
      const acknowledged=(lane:'native'|'serving')=>async(id:string,reference:string)=>{
        const receipt=canonicalJson({id,reference});
        await db.prepare(`UPDATE catalog_runtime_index_events SET delivery_json=json_insert(delivery_json,'$.${lane}[#]',json(?))
          WHERE sequence=? AND state='pending' AND descriptor_json=? AND NOT EXISTS(
            SELECT 1 FROM json_each(delivery_json,'$.${lane}') WHERE json_extract(value,'$.reference')=?)`)
          .bind(receipt,sequence,encoded,reference).run();
        const actual=(await db.prepare(`SELECT EXISTS(SELECT 1 FROM json_each(delivery_json,'$.${lane}')
          WHERE json_extract(value,'$.id')=? AND json_extract(value,'$.reference')=?) ok
          FROM catalog_runtime_index_events WHERE sequence=? AND descriptor_json=?`).bind(id,reference,sequence,encoded).all<Row>()).results[0];
        if(actual?.ok!==1)throw Error('runtime_index_acknowledgement_unknown');
      };
      const payload=JSON.parse(String(row.payload_json)),values=expected.native
        ?Object.hasOwn(payload,'nativeBase64')?decodePgvectorSendBase64(payload.nativeBase64):payload.values:[];
      const native=expected.native?await syncImmutableNativeVectors({...input,indexName:input.nativeIndexName,
        vectors:[{...expected.native,values}],deferVisibility:true,acknowledged:acknowledged('native')}):{pending:0};
      const serving=expected.serving?await syncDerivedSearchVectors({...input,indexName:input.servingIndexName,
        vectors:[{id:expected.serving.id,metadata:expected.serving.metadata,values:decodePgvectorSendBase64(expected.serving.nativeBase64,1024)}],
        deferVisibility:true,acknowledged:acknowledged('serving')}):{pending:0};
      if(native.pending||serving.pending){outcomes.push({sequence,state:'pending'});continue;}
      const at=(input.now??(()=>new Date()))().toISOString();
      // A later run may have superseded an entirely unsent old outbox entry.
      // Its immutable payload/event still completes here without resurrecting it.
      await db.batch([db.prepare(`UPDATE vector_sync_outbox SET status='complete',completed_at=?,lease_until=NULL,
        lease_token=?,error_code=NULL WHERE sequence=? AND status='pending' AND lease_token IS NULL AND operation='upsert'`)
        .bind(at,'runtime-index-'+sequence,sequence),
        db.prepare("UPDATE catalog_runtime_index_events SET state='complete',completed_at=?,retry_after=NULL WHERE sequence=? AND state='pending' AND descriptor_json=?")
          .bind(at,sequence,encoded)]);
      const complete=(await db.prepare('SELECT state FROM catalog_runtime_index_events WHERE sequence=?').bind(sequence).all<Row>()).results[0];
      if(complete?.state!=='complete')throw Error('runtime_index_completion_unknown');
      outcomes.push({sequence,state:'complete'});
    }catch(error){const message=error instanceof Error?error.message:'';
      const delay=(error as {retryAfterMs?:unknown})?.retryAfterMs;
      if(message==='semantic_delta_throttled'&&typeof delay==='number'&&Number.isFinite(delay)&&delay>=0){
        const retry=new Date((input.now??(()=>new Date()))().getTime()+delay);
        if(Number.isFinite(retry.getTime()))await db.prepare("UPDATE catalog_runtime_index_events SET retry_after=? WHERE sequence=? AND state='pending'")
          .bind(retry.toISOString(),sequence).run();
      }
      outcomes.push({sequence,state:'attention',errorCode:/^(?:runtime_index|semantic_delta)_[a-z0-9_]{1,140}$/.test(message)?message:'runtime_index_delivery_failed'});
      if(message==='semantic_delta_throttled'||message.startsWith('semantic_delta_provider')||message.startsWith('publication_read_'))break;
    }
  }
  const remaining=(await db.prepare("SELECT count(*) n FROM catalog_runtime_index_events WHERE state='pending'").all<{n:number}>()).results[0].n;
  return{outcomes,complete:outcomes.filter(v=>v.state==='complete').length,pending:remaining};
}
