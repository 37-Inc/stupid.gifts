import assert from 'node:assert/strict';
import test from 'node:test';
import { derivedFixture, digest } from './helpers/derived-search-fixture.mjs';
import { canonicalJson } from '../lib/catalog/canonical-json.ts';
import { prepareSemanticCatalog } from '../scripts/catalog/prepare-semantic-catalog.ts';
import { validatePublicationConfig, verifyPublicationSemanticCatalog } from '../scripts/catalog/publish-release.ts';

test('offline receipt-to-serving artifact keeps originals, pins exact input, has stable IDs and no daily revision metadata',async()=>{
  const f=await derivedFixture(),before=structuredClone(f.sources),snapshot=structuredClone(f.snapshot);
  snapshot.catalogRevision='another-day';snapshot.products[0].description='New cleared description, not an embedding input';
  const next=await prepareSemanticCatalog({snapshot,indexName:f.catalog.indexName,sources:f.sources});
  assert.deepEqual(f.sources,before);assert.deepEqual(next.vectors,f.vectors);assert.deepEqual(next.catalog,f.catalog);
  assert.equal(next.executionAuthorized,false);assert.equal(next.providerCalls,0);assert.equal(next.retrievalQualityAccepted,false);
  assert.doesNotMatch(JSON.stringify(next.catalog),/retained context|nativeBase64|receiptReference|catalogRevision|observedAt/);
});

test('receipt preparation cannot relabel different current public input, missing/held records or fake provenance',async()=>{
  const f=await derivedFixture();
  for(const mutate of [s=>s.products[0].title='Other title',s=>s.products.shift()]){
    const snapshot=structuredClone(f.snapshot);mutate(snapshot);
    await assert.rejects(prepareSemanticCatalog({snapshot,indexName:f.catalog.indexName,sources:f.sources}));
  }
  const sources=structuredClone(f.sources);sources[0].expectedInput='Forged input';
  await assert.rejects(prepareSemanticCatalog({snapshot:f.snapshot,indexName:f.catalog.indexName,sources}),/input_mismatch/);
  const forged=structuredClone(f.sources);forged[0].receiptSha256='f'.repeat(64);
  await assert.rejects(prepareSemanticCatalog({snapshot:f.snapshot,indexName:f.catalog.indexName,sources:forged}),/receipt_mismatch/);
});

test('incremental plan does not rewrite unchanged vectors or delete prior stored history',async()=>{
  const f=await derivedFixture(),previous=f.vectors.map(v=>v.id),retained='f'.repeat(64);
  const next=await prepareSemanticCatalog({snapshot:{...f.snapshot,catalogRevision:'next-day'},indexName:f.catalog.indexName,
    sources:f.sources,previousVectorIds:[...previous,retained]});
  assert.equal(next.vectors.length,0);assert.equal(next.unchangedVectors,3);assert.deepEqual(next.retainedPreviousVectorIds,[retained]);
  assert.deepEqual(next.catalog,f.catalog);assert.equal(next.executionAuthorized,false);
  const partial=await prepareSemanticCatalog({snapshot:f.snapshot,indexName:f.catalog.indexName,sources:f.sources,previousVectorIds:previous.slice(1)});
  assert.equal(partial.vectors.length,1);assert.equal(partial.vectors[0].id,previous[0]);
  await assert.rejects(prepareSemanticCatalog({snapshot:f.snapshot,indexName:f.catalog.indexName,sources:f.sources,previousVectorIds:['bad']}),/inventory_invalid/);
});

function config(derivedCatalog){return {schemaVersion:1,environment:'production',accountId:'a'.repeat(32),workerName:'fixture-worker',
  database:{id:'00000000-0000-4000-8000-000000000001',name:'fixture-db'},indexName:'original-native-index',codeSha:'b'.repeat(40),
  sourceMode:'stupid-production',sourceRoot:'/fixture/source',releaseId:'fixture-release',identityOrigin:'https://stupid.gifts',
  compatibilityDate:'2026-10-19',prior:null,semanticSearch:{enabled:false,dailyRequestCap:50,dailyTokenCap:32768,derivedCatalog}};}

test('publication binds optional prepared artifact and separate index without changing native identity or enabling paid calls',async()=>{
  const f=await derivedFixture(),derived={path:'/fixture/private/search.json',sha256:digest(canonicalJson(f.catalog)),indexName:f.catalog.indexName};
  const c=validatePublicationConfig(config(derived));assert.equal(c.semanticSearch.enabled,false);assert.equal(c.indexName,'original-native-index');
  // Files may be pretty-printed/newline-terminated. The existing binding is
  // canonical JSON, not a second raw-file digest invented by runtime loaders.
  const bytes=JSON.stringify(f.catalog,null,2)+'\n';assert.notEqual(digest(bytes),derived.sha256);
  assert.deepEqual(await verifyPublicationSemanticCatalog({semanticCatalog:JSON.parse(bytes)},c),f.catalog);
  await assert.rejects(verifyPublicationSemanticCatalog({semanticCatalog:{...f.catalog,indexName:'wrong-index'}},c),/changed/);
  await assert.rejects(verifyPublicationSemanticCatalog({},c));
  const old={...c};delete old.semanticSearch;await verifyPublicationSemanticCatalog({},old);
  await assert.rejects(verifyPublicationSemanticCatalog({semanticCatalog:f.catalog},old),/unconfigured/);
  for(const patch of [{indexName:c.indexName},{indexName:123},{sha256:''},{path:'relative.json'}])
    assert.throws(()=>validatePublicationConfig(config({...derived,...patch})),/configuration_invalid/);
  assert.throws(()=>validatePublicationConfig(config(null)),/configuration_invalid/);
});
