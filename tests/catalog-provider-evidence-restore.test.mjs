import assert from 'node:assert/strict';
import test from 'node:test';
import {createCatalogProviderEvidence} from '../scripts/catalog/provider-evidence.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {editorialSourceHash} from '../scripts/ops/catalog-editorial-core.mjs';
import {maintenanceEmbeddingText} from '../scripts/catalog/maintenance-state.ts';

const NOW='2026-11-06T20:00:00.000Z',LATER='2026-11-06T21:00:00.000Z';
const product={id:'B000000001',title:'TEST ONLY brass lobster desk bell',source:'amazon',isActive:true,
  imageUrl:'https://example.invalid/lobster.jpg',availabilityStatus:'IN_STOCK',remotelyVerified:true,
  sourceFacts:{material:'brass',shape:'lobster'},humorTags:['lobster','desk'],punnyTitle:'Shell service',
  wittyDescription:'A brass lobster desk bell with a small tabletop shape.',
  affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=fixture-20'};
function savedStore(){
  const receipts=new Map();let writes=0,reads=0;
  return{receipts,get writes(){return writes;},get reads(){return reads;},
    async saveReceipt(input){writes++;const reference=`fixture/${input.sha256}`;receipts.set(reference,structuredClone(input.receipt));return{sha256:input.sha256,reference};},
    async readReceipt(ref){reads++;return structuredClone(receipts.get(ref.reference));},
    references(){return[...receipts].map(([reference,receipt])=>({reference,sha256:sha256(canonicalJson(receipt))}));}};
}
test('restored private observation/native receipts preserve original time, input and exact vector without provider work',async()=>{
  const saved=savedStore(),first=createCatalogProviderEvidence({...saved,now:()=>NOW});let providerCalls=0;
  await first.amazon('searchItems',async()=>{providerCalls++;return[product];});
  const vector=Array(1536).fill(.25);vector[0]=-0;
  await first.embeddings({products:[product],model:'text-embedding-3-small',inputs:[maintenanceEmbeddingText(product)],
    response:{model:'text-embedding-3-small',data:[{index:0,embedding:vector}]}});
  const refs=saved.references(),before=saved.writes;
  const restored=createCatalogProviderEvidence({readReceipt:saved.readReceipt,saveReceipt:async()=>{throw Error('must not save a new observation');},now:()=>LATER});
  for(const ref of refs)await restored.restoreReceipt(ref);
  const intent=restored.intent('upsertProduct',[{...product,embedding:vector},editorialSourceHash(product)]);
  assert.equal(intent.verificationById[product.id].observedAt,saved.receipts.get(refs[0].reference).observedAt);
  assert.equal(intent.verificationById[product.id].reference,refs[0].reference);
  assert.equal(intent.embeddingById[product.id].reference,refs[1].reference);
  assert.equal(intent.embeddingById[product.id].text,maintenanceEmbeddingText(product));
  assert.equal(saved.writes,before);assert.equal(providerCalls,1);
});
test('restored missing-response invalidation keeps chronological semantics rather than resurrecting prior proof',async()=>{
  const saved=savedStore(),first=createCatalogProviderEvidence({...saved,now:()=>NOW});
  await first.amazon('getItems',async()=>[product],undefined,[product.id]);
  await first.amazon('getItems',async()=>[],undefined,[product.id]);
  const restored=createCatalogProviderEvidence({...saved,now:()=>LATER});
  for(const ref of saved.references())await restored.restoreReceipt(ref);
  assert.throws(()=>restored.intent('upsertProduct',[product,editorialSourceHash(product)]),/provider_evidence_superseded/);
});
test('a restored source supports only its original photo deadline, never a fresh observation',async()=>{
  const saved=savedStore(),first=createCatalogProviderEvidence({...saved,now:()=>NOW});
  const source={...product,affiliateUrl:product.affiliateUrl.replace('fixture-20','goose-gifts-37-20')};
  await first.amazon('searchItems',async()=>[source]);
  const restored=createCatalogProviderEvidence({...saved,associateTag:'goose-gifts-37-20',now:()=>LATER,
    saveReviewedShort:async()=>({reference:'fixture/original-copy-review'})});
  await restored.restoreReceipt(saved.references()[0]);
  const candidate={...source,editorialSourceHash:editorialSourceHash(source),editorialStatus:'short_ready',editorialQualityScore:.9};
  assert.equal(await restored.reviewedShort(candidate,{approved:true,qualityScore:.9}),true);
  const rights=restored.intent('upsertProduct',[candidate,editorialSourceHash(candidate)]).rightsById[product.id];
  assert.equal(rights.imageUrl.observedAt,NOW);assert.equal(rights.imageUrl.expiresAt,'2026-11-07T20:00:00.000Z');
});
test('restore requires protected read capability and exact original receipt structure/hash/input',async()=>{
  const saved=savedStore(),first=createCatalogProviderEvidence({...saved,now:()=>NOW});
  await first.amazon('searchItems',async()=>[product]);
  const ref=saved.references()[0],receipt=saved.receipts.get(ref.reference);
  await assert.rejects(createCatalogProviderEvidence({saveReceipt:saved.saveReceipt}).restoreReceipt(ref),/restore_reference/);
  for(const changed of [
    {...receipt,observedAt:'2027-01-01T00:00:00.000Z'},
    {...receipt,secret:'forbidden'},
    {...receipt,products:[{...receipt.products[0],sourceFactsHash:'a'.repeat(64)}]},
    {...receipt,returnedIds:[]},
  ]){
    const candidate={reference:'fixture/tampered',sha256:sha256(canonicalJson(changed))};
    const evidence=createCatalogProviderEvidence({saveReceipt:saved.saveReceipt,readReceipt:async()=>changed,now:()=>LATER});
    await assert.rejects(evidence.restoreReceipt(candidate),/restore_invalid/);
  }
  const evidence=createCatalogProviderEvidence({saveReceipt:saved.saveReceipt,readReceipt:async()=>({...receipt,observedAt:LATER}),now:()=>LATER});
  await assert.rejects(evidence.restoreReceipt(ref),/restore_invalid/);
});
