import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {derivedFixture} from './helpers/derived-search-fixture.mjs';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {maintenanceEmbeddingText,snake} from '../scripts/catalog/maintenance-state.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {deriveMaintenanceSearchVector,prepareMaintenanceSearchDelta,syncDerivedSearchVectors} from '../scripts/catalog/sync-semantic-delta.ts';
import {accountedPublicationFetch,accountedPublicationReadFetch} from '../scripts/catalog/publication-read-fetch.ts';

const digest=b=>createHash('sha256').update(b).digest('hex');
const hash=v=>sha256(canonicalJson(v));
async function fixture(){
  const f=await derivedFixture(),product=structuredClone(f.snapshot.products[0]);
  const p={...product,source:'amazon',sourceQuery:'SYNTHETIC retained context',qualityScore:null,isActive:true};
  const row={id:p.id,public_id:p.publicId,slug:p.slug,source:'amazon',is_active:1,quality_score:null};
  for(const key of ['editorialStatus','duplicateOfProductId','availabilityStatus','sourceFactsHash','editorialSourceHash',
    'availabilityCheckedAt','lastVerifiedAt','createdAt','updatedAt']){p[key]=null;row[snake(key)]=null;}
  p.sourceFactsHash=row.source_facts_hash='a'.repeat(64);
  const native=encodePgvectorSendBase64(Array.from({length:1536},(_,i)=>Math.fround((i%17-8)/100))),text=maintenanceEmbeddingText(p);
  row.embedding_text_hash=sha256(text);
  const state={product_id:p.id,version:1,semantic_json:JSON.stringify(p),embedding_present:1,embedding_native_base64:native,
    embedding_provenance_json:JSON.stringify({input:'verified',reference:'objects/'+ 'b'.repeat(64)+'.json',
      model:'text-embedding-3-small',text,sourceFactsHash:p.sourceFactsHash,embeddingTextHash:sha256(text),vectorBytesSha256:digest(Buffer.from(native,'base64'))})};
  return {f,product,row,state,inventory:{productSha256:hash(row),privateStateSha256:hash(state)}};
}
test('saved verified native projects exactly, retains originals and tolerates private short-copy context',async()=>{
  const x=await fixture(),before=structuredClone(x),a=await deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory);
  assert.equal(a.vector.values.length,1024);assert.ok(Math.abs(Math.hypot(...a.vector.values)-1)<1e-6);
  assert.equal(a.entry.inputSha256,x.row.embedding_text_hash);assert.deepEqual(x,before);
  delete x.product.punnyTitle;delete x.product.wittyDescription;delete x.product.humorTags;
  const b=await deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory);
  assert.deepEqual(b.vector.values,a.vector.values);assert.notEqual(b.entry.publicFieldsSha256,a.entry.publicFieldsSha256);
});
test('source/state/input/model/native drift cannot be relabeled as a new semantic projection',async()=>{
  for(const edit of [x=>x.row.slug='unreviewed',x=>x.state.version++,x=>x.product.title='Different title',
    x=>{const p=JSON.parse(x.state.embedding_provenance_json);p.model='other';x.state.embedding_provenance_json=JSON.stringify(p);x.inventory.privateStateSha256=hash(x.state);},
    x=>{x.state.embedding_native_base64=encodePgvectorSendBase64(Array(1536).fill(0));x.inventory.privateStateSha256=hash(x.state);}]){
    const x=await fixture();edit(x);await assert.rejects(deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory));
  }
});
test('photo-only fact refresh reuses the original serving identity and observation, without re-embedding',async()=>{
  const x=await fixture();x.product.imageUrl='/images/gift-placeholder.svg';
  const original=await deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory);
  x.row.embedding_text_hash=null;x.row.source_facts_hash='c'.repeat(64);
  const p=JSON.parse(x.state.semantic_json);p.sourceFactsHash=x.row.source_facts_hash;x.state.semantic_json=JSON.stringify(p);
  x.row.public_display_json=JSON.stringify({...x.product,imageUrl:'https://example.invalid/fresh-photo.jpg',
    eligibleUntil:'2026-11-05T00:00:00.000Z',persistent:x.product});
  x.inventory={productSha256:hash(x.row),privateStateSha256:hash(x.state)};
  await assert.rejects(deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory));
  const before=structuredClone(x),current=await deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory,x.product);
  assert.deepEqual(current,original);assert.deepEqual(x,before);
});
test('delta visits only reviewed public changes, skipping unchanged seed entries and excluded products',async()=>{
  const x=await fixture(),calls=[],catalog=structuredClone(x.f.catalog);
  catalog.entries=catalog.entries.filter(e=>e.publicId!==x.product.publicId);
  const db={prepare(sql){return{bind(id){return{async all(){calls.push(id);return{results:[sql.includes('maintenance_products')?x.state:x.row]};}};}};}};
  const revision={snapshot:x.f.snapshot,persistent:{inventory:[{publicId:x.product.publicId,...x.inventory}]},
    request:{approval:{changes:x.f.snapshot.products.map(p=>({publicId:p.publicId})).concat([{publicId:'excluded'}])}}};
  const result=await prepareMaintenanceSearchDelta(db,revision,catalog);
  assert.equal(result.vectors.length,1);assert.deepEqual(calls,[x.product.id,x.product.id]);
});
test('same immutable payload retries after an uncertain upsert without a second write; original index is untouched',async()=>{
  const x=await fixture(),{vector}=await deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory);
  const events=[],stored=new Map();let lose=true,upserts=0;
  const scope={accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000001',workerName:'fixture',
    identityOrigin:'https://fixture.invalid',indexName:'native',derivedIndexName:'derived'};
  const ws={async reserveBudget(e){events.push(e);},async settleBudget(_id,e){events.push(e);}};
  const raw=async(url,init)=>{
    assert.ok(url.includes('/indexes/derived/'));let result;
    if(url.endsWith('/get_by_ids'))result=JSON.parse(init.body).ids.flatMap(id=>stored.has(id)?[stored.get(id)]:[]);
    else{assert.ok(url.endsWith('/upsert'));upserts++;const v=JSON.parse(init.body);stored.set(v.id,v);
      if(lose){lose=false;throw Error('synthetic lost acknowledgment');}result={mutationId:'mutation'};}
    return Response.json({success:true,result});
  };
  const send=accountedPublicationFetch(ws,raw,scope),options={accountId:scope.accountId,indexName:'derived',token:'FIXTURE_ONLY',vectors:[vector],fetch:send,wait:async()=>{}};
  await assert.rejects(syncDerivedSearchVectors(options),/unavailable/);
  assert.deepEqual(await syncDerivedSearchVectors(options),{verified:1,upserted:0});assert.equal(upserts,1);
  assert.equal(events.filter(e=>e.status==='unknown').length,1);
  const read=accountedPublicationReadFetch(ws,raw,scope);
  await assert.rejects(read('https://api.cloudflare.com/client/v4/accounts/'+scope.accountId+'/vectorize/v2/indexes/derived/upsert',
    {method:'POST',redirect:'error',body:JSON.stringify(vector)}),/scope_invalid/);
});
test('provider corruption and overlarge responses fail closed; pending visibility retries are bounded',async()=>{
  const x=await fixture(),{vector}=await deriveMaintenanceSearchVector(x.product,x.row,x.state,x.inventory);
  const options={accountId:'a'.repeat(32),indexName:'derived',token:'FIXTURE_ONLY',vectors:[vector],wait:async()=>{}};
  await assert.rejects(syncDerivedSearchVectors({...options,fetch:async()=>Response.json({success:true,result:[{...vector,values:Array(1024).fill(.1)}]})}),/readback_mismatch/);
  let calls=0;await assert.rejects(syncDerivedSearchVectors({...options,fetch:async(url)=>{calls++;
    return Response.json({success:true,result:url.endsWith('/upsert')?{mutationId:'mutation'}:[]});}}),/pending/);
  assert.equal(calls,8);
  await assert.rejects(syncDerivedSearchVectors({...options,fetch:async()=>new Response('x'.repeat(1024*1024+1))}),/too_large/);
});
