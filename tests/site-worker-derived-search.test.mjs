import assert from 'node:assert/strict';
import test from 'node:test';
import { derivedFixture, derivedWorker } from './helpers/derived-search-fixture.mjs';
import { DERIVED_SEARCH_PROFILE, semanticVectorIdentity, verifySemanticCatalogIdentities } from '../lib/catalog/semantic-profile.ts';
import { createDerivedSemanticSearch } from '../workers/site/derived-search.ts';
import { createSearchHandler, openAIEmbedding } from '../workers/site/search.ts';

test('actual Worker serves current cleared products through input-verified derived vectors without D1/native lookup',async()=>{
  const f=await derivedFixture(),w=derivedWorker(f),{response,body}=await w.request();
  assert.equal(response.status,200);assert.equal(body.results[0].matchType,'semantic');
  assert.deepEqual(new Set(body.results.map(p=>p.id)),new Set(f.snapshot.products.map(p=>p.id)));
  assert.deepEqual(w.calls.reserve,[{environment:'staging',index:f.catalog.indexName}]);
  assert.equal(w.calls.vector[0].vector.length,1024);assert.equal(w.calls.legacy,0);
  assert.deepEqual(w.calls.vector[0].params,{topK:50,returnValues:false,returnMetadata:'all'});
  assert.doesNotMatch(JSON.stringify(body),/nativeBase64|receiptSha256|SYNTHETIC retained context|sourceFactsHash|vectorId/);
  await w.request();assert.equal(w.calls.embed,1); // Cached input proof, never a second paid call.
});

test('new content-addressed vector serves from current snapshot without rebuilding the seed inventory',async()=>{
  const f=await derivedFixture(),catalog=structuredClone(f.catalog),entry=catalog.entries.shift();
  const {body}=await derivedWorker(f,{catalog}).request();
  assert.equal(body.results.find(p=>p.id===entry.productId)?.matchType,'semantic');
  for(const edit of [s=>s.products.splice(s.products.findIndex(p=>p.id===entry.productId),1),
    s=>s.heldProducts.push({publicId:entry.publicId}),s=>{s.products.find(p=>p.id===entry.productId).title='changed';},
    s=>{s.products.find(p=>p.id===entry.productId).id='other-product';}]){
    const snapshot=structuredClone(f.snapshot);edit(snapshot);
    const result=await derivedWorker(f,{catalog,snapshot}).request();
    assert.ok(result.body.results.every(p=>p.id!==entry.productId||p.matchType!=='semantic'));
  }
});

test('weak semantic neighbors do not invent results for an unrelated query',async()=>{
  const f=await derivedFixture(),w=derivedWorker(f,{vector:async()=>({matches:f.vectors.map(v=>({id:v.id,score:.33,metadata:v.metadata}))})});
  const {body}=await w.request('zxqvplmnork');
  assert.deepEqual(body.results,[]);
  assert.equal(w.calls.embed,1);
});

test('a literal product interest outranks a slightly higher generic semantic neighbor',async()=>{
  const f=await derivedFixture(),target=f.snapshot.products[0];
  const w=derivedWorker(f,{vector:async()=>({matches:f.vectors.map(v=>({id:v.id,score:v.metadata.publicId===target.publicId ? .54 : .55,metadata:v.metadata}))})});
  const {body}=await w.request(target.title);
  assert.equal(body.results[0].id,target.id);
  assert.equal(body.results[0].matchType,'semantic');
});

test('unchanged vectors survive a new catalog revision, receipt timestamp, description, score and slug',async()=>{
  const f=await derivedFixture(),current=structuredClone(f.snapshot);
  current.catalogRevision='tomorrows-catalog';current.products[0].description='Current cleared description';
  current.products[0].slug='new-paperweight-slug';current.products[0].qualityScore=.81;
  const w=derivedWorker(f,{snapshot:current}),{body}=await w.request();
  const product=body.results.find(p=>p.id===current.products[0].id);
  assert.equal(product.matchType,'semantic');assert.equal(product.description,'Current cleared description');assert.equal(product.slug,'new-paperweight-slug');
  assert.equal(w.calls.vector[0].params.filter,undefined);
  const entry={...f.catalog.entries[0],receiptSha256:'f'.repeat(64),sourceFactsHash:'e'.repeat(64)};
  assert.equal(await semanticVectorIdentity(entry),entry.vectorId); // Observation-only changes are not new vectors.
});

test('supplier-overlay expiry does not expire an independently cleared input-verified semantic result',async()=>{
  const f=await derivedFixture(),snapshot=structuredClone(f.snapshot),base=snapshot.products[0];
  snapshot.products[0]={...base,title:'Different expired supplier overlay',eligibleUntil:'2020-01-01T00:00:00.000Z',persistent:base};
  const {body}=await derivedWorker(f,{snapshot}).request();
  const product=body.results.find(p=>p.id===base.id);assert.equal(product.title,base.title);assert.equal(product.matchType,'semantic');
  assert.equal(product.eligibleUntil,null);assert.doesNotMatch(JSON.stringify(body),/expired supplier/);
});

test('changed title, pun, witty copy, tags or product identity cannot use a stale vector',async()=>{
  for(const patch of [{title:'Changed paperweight title'},{punnyTitle:'A new pun'},{wittyDescription:'Changed witty copy'},
    {humorTags:['changed']},{id:'different-product'}]){
    const f=await derivedFixture(),snapshot=structuredClone(f.snapshot);Object.assign(snapshot.products[0],patch);
    const {body}=await derivedWorker(f,{snapshot}).request();
    assert.ok(body.results.every(p=>p.id!==snapshot.products[0].id||p.matchType==='keyword'));
  }
});

test('removed, excluded, deleted, inactive and nonpublic records cannot return as semantic results',async()=>{
  for(const edit of [s=>s.products.shift(),s=>{const p=s.products.shift();s.heldProducts.push({publicId:p.publicId});},
    s=>s.products[0].isActive=false,s=>s.heldProducts.push({publicId:s.products[0].publicId}),
    s=>s.heldProducts.push({id:s.products[0].id,publicId:'different-held-public-id'}),
    s=>{s.products[0].eligibleUntil='2020-01-01T00:00:00.000Z';delete s.products[0].persistent;}]){
    const f=await derivedFixture(),snapshot=structuredClone(f.snapshot),id=snapshot.products[0].id;edit(snapshot);
    const {body}=await derivedWorker(f,{snapshot}).request();
    assert.ok((body.results??[]).every(p=>p.id!==id||p.matchType!=='semantic'));
  }
});

test('an abort-ignoring late embedding cannot dispatch Vectorize after keyword fallback',async()=>{
  const f=await derivedFixture();let settle,dispatches=0;
  const handler=createSearchHandler({catalogRevision:f.snapshot.catalogRevision,derivedSemantic:createDerivedSemanticSearch(f.snapshot,f.catalog),
    providerTimeoutMs:10,semanticBudgetScope:{environment:'staging',index:'native-fixture'},adapters:{
      storage:()=>({async byPublicIds(){throw new Error('no native');},async keyword(){return[f.snapshot.products[0]];}}),
      async reserveSemantic(){return true;},async embed(){return new Promise(resolve=>{settle=resolve;});}}});
  const env={ENVIRONMENT:'staging',SEMANTIC_SEARCH_ENABLED:'true',SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'50',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'32768',
    SEMANTIC_VECTORIZE:{async query(){dispatches++;return{matches:[]};}}};
  const response=await handler(new Request('https://preview.example/api/search-products?q=paperweight'),env);
  assert.equal((await response.json()).results[0].matchType,'keyword');assert.equal(dispatches,0);
  settle(f.vectors[0].values);await new Promise(resolve=>setImmediate(resolve));assert.equal(dispatches,0);
});

test('wrong model, dimension, transform, recipe or profile disables derived calls rather than opening legacy serving',async()=>{
  for(const patch of [{model:'text-embedding-ada-002'},{dimensions:1536},{sourceDimensions:3072},
    {transform:'unknown'},{inputRecipe:'unknown'},{id:'other-profile'}]){
    const f=await derivedFixture(),catalog=structuredClone(f.catalog);Object.assign(catalog.profile,patch);
    const w=derivedWorker(f,{catalog}),{body}=await w.request();
    assert.equal(body.results[0].matchType,'keyword');assert.equal(w.calls.embed,0);assert.equal(w.calls.reserve.length,0);assert.equal(w.calls.legacy,0);
  }
});

test('wrong returned model/dimensions/transform/profile/input/native/public identity is rejected; ANN misses do not starve limit1 fallback',async()=>{
  for(const patch of [{model:'other'},{dimensions:1536},{transform:'other'},{profile:'other'},
    {inputSha256:'f'.repeat(64)},{originalNativeSha256:'f'.repeat(64)},
    {derivedNativeSha256:'f'.repeat(64)},{publicFieldsSha256:'f'.repeat(64)},{publicId:'unknown'}]){
    const f=await derivedFixture(),w=derivedWorker(f,{vector:async()=>({matches:f.vectors.map(v=>({id:v.id,score:.9,metadata:{...v.metadata,...patch}}))})});
    const {body}=await w.request('paperweight',1);assert.equal(body.results[0].matchType,'keyword');assert.equal(body.results.length,1);
  }
  const f=await derivedFixture(),w=derivedWorker(f,{vector:async()=>({matches:Array.from({length:100},()=>({id:'unknown',score:1}))})});
  assert.equal((await w.request('paperweight',1)).body.results[0].matchType,'keyword');
});

test('bad artifact vector identity fails build verification and fails closed at serving',async()=>{
  const f=await derivedFixture(),catalog=structuredClone(f.catalog);catalog.entries[0].inputSha256='f'.repeat(64);
  await assert.rejects(verifySemanticCatalogIdentities(catalog),/identity_mismatch/);
  const {body}=await derivedWorker(f,{catalog}).request();
  assert.ok(body.results.every(p=>p.id!==f.snapshot.products[0].id||p.matchType==='keyword'));
});

test('binding absence, flag OFF and budget refusal cause no embedding or vector call',async()=>{
  for(const options of [{env:{SEMANTIC_VECTORIZE:undefined}},{env:{SEMANTIC_SEARCH_ENABLED:'false'}},{reserve:false}]){
    const f=await derivedFixture(),w=derivedWorker(f,options),{body}=await w.request();
    assert.equal(body.results[0].matchType,'keyword');assert.equal(w.calls.embed,0);assert.equal(w.calls.vector.length,0);
  }
});

test('mocked embedding/vector/proof errors and timeouts preserve keyword fallback without native lookup',async()=>{
  const f=await derivedFixture();
  for(const fault of ['embed-error','embed-timeout','vector-error','vector-timeout','proof-timeout','bad-vector','bad-response']){
    const derived=createDerivedSemanticSearch(f.snapshot,f.catalog);let keywords=0,native=0;
    if(fault==='proof-timeout')derived.resolve=async()=>new Promise(()=>{});
    const search=createSearchHandler({catalogRevision:f.snapshot.catalogRevision,derivedSemantic:derived,providerTimeoutMs:10,
      semanticBudgetScope:{environment:'staging',index:'native-fixture'},adapters:{storage:()=>({async byPublicIds(){native++;return[];},
        async keyword(){keywords++;return[f.snapshot.products[0]];}}),async reserveSemantic(){return true;},
        async embed(){if(fault==='embed-error')throw new Error('PRIVATE');if(fault==='embed-timeout')return new Promise(()=>{});
          return fault==='bad-vector'?[1]:f.vectors[0].values;}}});
    const env={ENVIRONMENT:'staging',SEMANTIC_SEARCH_ENABLED:'true',SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'50',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'32768',
      SEMANTIC_VECTORIZE:{async query(){if(fault==='vector-error')throw new Error('PRIVATE');if(fault==='vector-timeout')return new Promise(()=>{});
        return fault==='bad-response'?{}:{matches:f.vectors.map(v=>({id:v.id,score:.9,metadata:v.metadata}))};}}};
    const response=await search(new Request('https://preview.example/api/search-products?q=paperweight'),env);
    assert.equal(response.status,200);const body=await response.json();assert.equal(body.results[0].matchType,'keyword');
    assert.equal(native,0);assert.equal(keywords,1);assert.doesNotMatch(JSON.stringify(body),/PRIVATE/);
  }
});

test('OpenAI query adapter uses same source model and prefix normalization, rejects unverified model/zero source',async t=>{
  const input=Array.from({length:1536},(_,i)=>Math.fround((i%9-4)/100));
  let model='text-embedding-3-small',values=input;
  t.mock.method(globalThis,'fetch',async(_url,init)=>{
    assert.deepEqual(JSON.parse(init.body),{model:'text-embedding-3-small',input:'SYNTHETIC QUERY',encoding_format:'float'});
    return Response.json({model,data:[{embedding:values}]});});
  const env={OPENAI_API_KEY:'SYNTHETIC-NOT-A-KEY'},signal=new AbortController().signal;
  const result=await openAIEmbedding('SYNTHETIC QUERY',env,signal,DERIVED_SEARCH_PROFILE);
  assert.equal(result.length,1024);assert.ok(Math.abs(Math.hypot(...result)-1)<1e-6);
  model='unknown';await assert.rejects(openAIEmbedding('SYNTHETIC QUERY',env,signal,DERIVED_SEARCH_PROFILE),/model_invalid/);
  model='text-embedding-3-small';values=Array(1536).fill(0);
  await assert.rejects(openAIEmbedding('SYNTHETIC QUERY',env,signal,DERIVED_SEARCH_PROFILE),/zero_norm/);
});
