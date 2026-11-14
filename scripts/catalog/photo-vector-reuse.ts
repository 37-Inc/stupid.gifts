import {createHash} from 'node:crypto';
import {canonicalJson,sha256} from './migration.ts';
import {maintenanceEmbeddingText} from './maintenance-state.ts';
import {decodePgvectorSendBase64} from './pgvector-binary.ts';
import {nativeHash} from './vector-outbox.ts';
import {persistentPublicProduct} from '../../lib/catalog/display.ts';
import {canonicalDescriptionEmbeddingInput} from '../../lib/catalog/presentation.ts';
import type {PublicCatalogProduct} from '../../lib/catalog/types.ts';
import type {SemanticProduct} from './maintenance-state.ts';
import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {CatalogSnapshot} from '../../lib/catalog/types.ts';
type Row=Record<string,unknown>;

/** A real positive stock observation may restore an existing held gift. Its
 * previous accepted PUBLIC bytes then predate the immediately preceding
 * snapshot. Read that last receipted projection, never manufacture a baseline
 * from today's row or relax the exact copy/native checks below. */
export async function readPreservedPhotoVector(db:CatalogD1,product:Row,state:Row,
  previous:CatalogSnapshot,member:{publicId:string;sourceFactsHash:string;embeddingTextHash:string|null},revision:string){
  let prior=previous.products.find(p=>p.publicId===member.publicId);
  if(!prior&&previous.heldProducts.some(p=>p.publicId===member.publicId&&p.id===product.id&&p.slug===product.slug)){
    const rows=(await db.prepare(`SELECT cp.public_display_json FROM catalog_public_products cp
      JOIN publication_receipts r ON r.catalog_revision=cp.catalog_revision
      WHERE cp.product_id=? ORDER BY r.rowid DESC LIMIT 1`).bind(product.id).all()).results;
    if(rows.length===1)prior=JSON.parse(String(rows[0].public_display_json));
  }
  return preservedPhotoVector(product,state,prior,member,revision);
}

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
  // A refreshed supplier title is not the cleared public title. The canonical
  // recipe may bind the unchanged listing, not this incidental supplier text.
  const publicText=canonicalDescriptionEmbeddingInput(base);
  const text=proof.text===publicText&&canonicalDescriptionEmbeddingInput(display)===publicText
    ?publicText:maintenanceEmbeddingText(current,proof.text);
  const bytes=Buffer.from(String(state.embedding_native_base64),'base64');
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
