import {createHash} from 'node:crypto';
import {canonicalJson,sha256} from './migration.ts';
import {maintenanceEmbeddingText} from './maintenance-state.ts';
import {decodePgvectorSendBase64} from './pgvector-binary.ts';
import {nativeHash} from './vector-outbox.ts';
import {persistentPublicProduct} from '../../lib/catalog/display.ts';
import type {PublicCatalogProduct} from '../../lib/catalog/types.ts';
import type {SemanticProduct} from './maintenance-state.ts';
type Row=Record<string,unknown>;

/** A new photo is not new embedding input. Reuse only independently saved,
 * verified exact text/float32s over the unchanged approved permanent copy.
 * Current supplier facts may differ; retain the NULL current input binding
 * rather than falsely relabeling the original model observation as fresh. */
export function preservedPhotoVector(product:Row,state:Row,previous:PublicCatalogProduct|undefined,
  member:{publicId:string;sourceFactsHash:string;embeddingTextHash:string|null},revision:string){
  const fail=():never=>{throw Error('vector_original_unproven');};
  if(!previous||member.embeddingTextHash!==product.embedding_text_hash
    ||member.publicId!==product.public_id||member.sourceFactsHash!==product.source_facts_hash
    ||state.embedding_present!==1||typeof state.embedding_native_base64!=='string')fail();
  const display=JSON.parse(String(product.public_display_json)),base=persistentPublicProduct(display),prior=persistentPublicProduct(previous!);
  if(!base||!prior||base.imageUrl!=='/images/gift-placeholder.svg'||canonicalJson(base)!==canonicalJson(prior)
    ||typeof display.imageUrl!=='string'||!display.imageUrl.startsWith('https://')||display.eligibleUntil===null)fail();
  const current=JSON.parse(String(state.semantic_json)) as SemanticProduct,proof=JSON.parse(String(state.embedding_provenance_json));
  const text=maintenanceEmbeddingText(current,proof.text),bytes=Buffer.from(String(state.embedding_native_base64),'base64');
  if(current.id!==product.id||current.publicId!==member.publicId||current.sourceFactsHash!==member.sourceFactsHash
    ||proof.input!=='verified'||proof.model!=='text-embedding-3-small'||typeof proof.reference!=='string'||!proof.reference.trim()
    ||proof.text!==text||proof.embeddingTextHash!==sha256(text)
    ||member.embeddingTextHash!==null&&member.embeddingTextHash!==proof.embeddingTextHash
    ||!/^[a-f0-9]{64}$/.test(proof.sourceFactsHash)
    ||createHash('sha256').update(bytes).digest('hex')!==proof.vectorBytesSha256)fail();
  const values=decodePgvectorSendBase64(String(state.embedding_native_base64));
  return{publicId:member.publicId,catalogRevision:revision,sourceFactsHash:member.sourceFactsHash,
    embeddingTextHash:member.embeddingTextHash,values,vectorBytesSha256:nativeHash(values)};
}
