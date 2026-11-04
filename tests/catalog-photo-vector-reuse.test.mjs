import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {preservedPhotoVector} from '../scripts/catalog/photo-vector-reuse.ts';
import {maintenanceEmbeddingText} from '../scripts/catalog/maintenance-state.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {sha256} from '../scripts/catalog/migration.ts';
const id='B000000001',publicId='00000000-0000-4000-8000-000000000001';
function fixture(){
  const base={id,publicId,slug:'rooster-puppet',source:'amazon',title:'Rooster puppet',description:'A rooster hand puppet.',
    imageUrl:'/images/gift-placeholder.svg',affiliateUrl:`https://www.amazon.com/dp/${id}?tag=fixture-20`,price:0,currency:'USD',eligibleUntil:null,indexable:true};
  const semantic={id,publicId,title:base.title,wittyDescription:base.description,punnyTitle:null,sourceQuery:'gag gifts',humorTags:['puppet'],sourceFactsHash:'b'.repeat(64)};
  const native=encodePgvectorSendBase64(Array(1536).fill(.125));
  const proof={input:'verified',model:'text-embedding-3-small',reference:'test/original-embedding',text:maintenanceEmbeddingText(semantic),
    embeddingTextHash:sha256(maintenanceEmbeddingText(semantic)),sourceFactsHash:'a'.repeat(64),vectorBytesSha256:createHash('sha256').update(Buffer.from(native,'base64')).digest('hex')};
  return{product:{id,public_id:publicId,source_facts_hash:semantic.sourceFactsHash,embedding_text_hash:null,
    public_display_json:JSON.stringify({...base,imageUrl:'https://example.invalid/fresh-rooster.jpg',eligibleUntil:'2026-11-05T00:00:00.000Z',persistent:base})},
    state:{embedding_present:1,embedding_native_base64:native,embedding_provenance_json:JSON.stringify(proof),semantic_json:JSON.stringify(semantic)},
    previous:{...base,imageUrl:'https://example.invalid/old-rooster.jpg',eligibleUntil:'2026-11-03T00:00:00.000Z',persistent:base},
    member:{publicId,sourceFactsHash:semantic.sourceFactsHash,embeddingTextHash:null}};
}
test('photo refresh reuses exact verified text/native bytes without inventing a fresh source-input binding',()=>{
  const f=fixture(),original=structuredClone(f),v=preservedPhotoVector(f.product,f.state,f.previous,f.member,'fresh-photo');
  assert.equal(v.values.length,1536);assert.equal(v.values[0],.125);assert.equal(v.embeddingTextHash,null);
  assert.equal(v.sourceFactsHash,f.member.sourceFactsHash);assert.equal(v.catalogRevision,'fresh-photo');assert.deepEqual(f,original);
});
for(const mutation of ['text','copy','native','provenance','absent','permanent-photo','binding'])test(`photo-native reuse rejects changed or unproven ${mutation}`,()=>{
  const f=fixture();
  if(mutation==='text'){const s=JSON.parse(f.state.semantic_json);s.wittyDescription='Different joke';f.state.semantic_json=JSON.stringify(s);}
  if(mutation==='copy'){const p=JSON.parse(f.product.public_display_json);p.persistent.description='Different copy';f.product.public_display_json=JSON.stringify(p);}
  if(mutation==='native')f.state.embedding_native_base64=encodePgvectorSendBase64(Array(1536).fill(.25));
  if(mutation==='provenance'){const p=JSON.parse(f.state.embedding_provenance_json);p.input='unverified';f.state.embedding_provenance_json=JSON.stringify(p);}
  if(mutation==='absent')f.state.embedding_present=0;
  if(mutation==='permanent-photo'){const p=JSON.parse(f.product.public_display_json);p.persistent.imageUrl='https://example.invalid/cleared.jpg';f.product.public_display_json=JSON.stringify(p);}
  if(mutation==='binding')f.member.embeddingTextHash='a'.repeat(64);
  assert.throws(()=>preservedPhotoVector(f.product,f.state,f.previous,f.member,'fresh-photo'),/vector_original_unproven/);
});
