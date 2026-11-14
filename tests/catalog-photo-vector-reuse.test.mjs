import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {preservedPhotoVector,readPreservedPhotoVector} from '../scripts/catalog/photo-vector-reuse.ts';
import {unchangedPhotoNativeIds} from '../scripts/catalog/owned-vector-delivery.ts';
import {canonicalDescriptionEmbeddingInput} from '../lib/catalog/presentation.ts';
import {maintenanceEmbeddingText} from '../scripts/catalog/maintenance-state.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
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
test('saved verified binding remains exact when supplier availability produces no new outbox entry',()=>{
  const f=fixture(),proof=JSON.parse(f.state.embedding_provenance_json);
  f.member.embeddingTextHash=f.product.embedding_text_hash=proof.embeddingTextHash;
  assert.equal(preservedPhotoVector(f.product,f.state,f.previous,f.member,'fresh-photo').embeddingTextHash,proof.embeddingTextHash);
});
test('returning held gift reuses only its last accepted projection and exact saved vector',async()=>{
  const f=fixture();f.product.slug=f.previous.slug;let reads=0;
  const db={prepare(sql){assert.match(sql,/JOIN publication_receipts/);assert.match(sql,/LIMIT 1/);
    return{bind(id){assert.equal(id,f.product.id);return{async all(){reads++;return{results:[{public_display_json:JSON.stringify(f.previous)}]};}};}};}};
  const previous={products:[],heldProducts:[{id:f.product.id,publicId:f.product.public_id,slug:f.product.slug}]};
  const v=await readPreservedPhotoVector(db,f.product,f.state,previous,f.member,'returning');
  assert.equal(reads,1);assert.equal(v.values[0],.125);assert.equal(v.embeddingTextHash,null);
  const before=structuredClone(f);
  for(const mismatch of [{id:'different'},{slug:'different'},{publicId:'different'}]){
    await assert.rejects(readPreservedPhotoVector(db,f.product,f.state,
      {products:[],heldProducts:[{...previous.heldProducts[0],...mismatch}]},f.member,'returning'),/vector_original_unproven/);
  }
  assert.equal(reads,1);assert.deepEqual(f,before);
  const bad=structuredClone(f.previous);bad.persistent.description='Different copy';
  const badDb={prepare(){return{bind(){return{async all(){return{results:[{public_display_json:JSON.stringify(bad)}]};}};}};}};
  await assert.rejects(readPreservedPhotoVector(badDb,f.product,f.state,previous,f.member,'returning'),/vector_original_unproven/);
});
test('current public gift never reads older projections to evade a changed-copy failure',async()=>{
  const f=fixture(),db={prepare(){throw Error('must_not_read_history');}};
  const before=structuredClone(f.previous);before.persistent.description='Different previous copy';
  await assert.rejects(readPreservedPhotoVector(db,f.product,f.state,{products:[before],heldProducts:[]},f.member,'next'),/vector_original_unproven/);
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
test('photo-only refresh retains exact canonical public input across a raw retailer title change',()=>{
  const f=fixture(),display=JSON.parse(f.product.public_display_json),proof=JSON.parse(f.state.embedding_provenance_json);
  proof.text=canonicalDescriptionEmbeddingInput(display.persistent);proof.embeddingTextHash=sha256(proof.text);
  f.state.embedding_provenance_json=JSON.stringify(proof);
  const semantic=JSON.parse(f.state.semantic_json);semantic.title='New long supplier wording';f.state.semantic_json=JSON.stringify(semantic);
  assert.notEqual(maintenanceEmbeddingText(semantic,proof.text),proof.text);
  assert.equal(preservedPhotoVector(f.product,f.state,f.previous,f.member,'fresh-photo').embeddingTextHash,null);
  display.title='Different public product';display.punnyTitle=null;f.product.public_display_json=JSON.stringify(display);
  assert.throws(()=>preservedPhotoVector(f.product,f.state,f.previous,f.member,'fresh-photo'),/vector_original_unproven/);
});
test('renewed photos retain only the exact receipted original, otherwise use ordinary delivery',async t=>{
  const f=fixture(),sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  const db={prepare:s=>({bind:(...args)=>({all:async()=>({results:sql.prepare(s).all(...args)})})})};
  sql.exec('CREATE TABLE catalog_vector_deliveries(delivery_id TEXT PRIMARY KEY,owner_json,request_json,status,disposition);CREATE TABLE products(id,public_id,source_facts_hash,embedding_text_hash);CREATE TABLE catalog_maintenance_products(product_id,embedding_native_base64,embedding_provenance_json);CREATE TABLE vector_sync_outbox(public_id,source_revision)');
  const digest=x=>sha256(canonicalJson(x)),owner={environment:'production',indexName:'catalog',generation:2,epoch:7,token:'test',phase:'freezing',ownerReference:'original',operationKey:'f'.repeat(64),capturedAt:'2026-11-01T00:00:00.000Z'};
  const plan={products:[f.member]},planHash=digest(plan),request={kind:'approved-cohort-plan',plan,revisionSha256:'a'.repeat(64),providerIdentity:'test'};
  const insert=sql.prepare('INSERT INTO catalog_vector_deliveries VALUES(?,?,?,?,?)');
  insert.run('previous',canonicalJson(owner),canonicalJson(request),'complete','verified');
  const binding={source:{deliveryId:'previous',deliverySha256:digest(sql.prepare('SELECT * FROM catalog_vector_deliveries').get())},planSha256:planHash,revisionSha256:request.revisionSha256,ids:[publicId]};
  const delivery=digest({environment:owner.environment,indexName:owner.indexName,generation:owner.generation,operationKey:owner.operationKey,identity:{kind:'prune',planHash,publicId}});
  const state={...f.state,product_id:id},proof=JSON.parse(state.embedding_provenance_json);
  const vector={id:publicId,nativeBase64:state.embedding_native_base64,metadata:{eligible:true,sourceFactsHash:f.member.sourceFactsHash,vectorBytesSha256:proof.vectorBytesSha256}};
  insert.run(delivery,canonicalJson(owner),canonicalJson({kind:'prune',providerIdentity:'test',planSha256:planHash,vector}),'complete','verified');
  sql.prepare('INSERT INTO products VALUES(?,?,?,?)').run(id,publicId,f.member.sourceFactsHash,null);
  sql.prepare('INSERT INTO catalog_maintenance_products VALUES(?,?,?)').run(id,state.embedding_native_base64,state.embedding_provenance_json);
  const check=()=>unchangedPhotoNativeIds(db,[binding],new Set([publicId]),{products:[f.previous]},new Map([[publicId,f.product]]),[state],'next');
  assert.deepEqual([...await check()],[publicId]);
  const previousDisplay=f.product.public_display_json;
  for(const noDisplay of [null,'null']){f.product.public_display_json=noDisplay;assert.equal((await check()).size,0);}
  f.product.public_display_json=previousDisplay;
  sql.prepare('INSERT INTO vector_sync_outbox VALUES(?,?)').run(publicId,'next');assert.equal((await check()).size,0);
  sql.exec('DELETE FROM vector_sync_outbox');sql.prepare("UPDATE catalog_vector_deliveries SET status='pending' WHERE delivery_id=?").run(delivery);assert.equal((await check()).size,0);
  sql.prepare("UPDATE catalog_vector_deliveries SET status='complete' WHERE delivery_id=?").run(delivery);
  sql.exec("UPDATE catalog_maintenance_products SET embedding_native_base64='different'");assert.equal((await check()).size,0);
  binding.source.deliverySha256='f'.repeat(64);await assert.rejects(check,/vector_history_changed/);
});
