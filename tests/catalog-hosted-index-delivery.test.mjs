import test from 'node:test';
import assert from 'node:assert/strict';
import {runHostedIndexDelivery} from '../scripts/catalog/hosted-index-delivery.mjs';
import {publishHostedInputs} from '../scripts/catalog/hosted-inputs.ts';
import {CATALOG_SCOPE} from '../scripts/catalog/automation-runtime.mjs';

async function fixture(enabled=true){
  const objects=new Map(),records=new Map(),reads=[],waits=[];let tokenReads=0,accounting;
  const durable={async get(key){reads.push(key);return objects.get(key)??null;},async putImmutable(key,bytes){
    assert.equal(objects.has(key),false);const value={bytes:Buffer.from(bytes),etag:'"fixture"'};objects.set(key,value);return value;},
    async compareAndSwap(key,etag,bytes){assert.equal(etag,null);const value={bytes:Buffer.from(bytes),etag:'"fixture"'};objects.set(key,value);return value;}};
  await publishHostedInputs(durable,[{relative:'daily-catalog-care/semantic-search.json',bytes:Buffer.from(JSON.stringify({enabled:true,derivedCatalog:{indexName:'fixture-serving'}}))},
    {relative:'daily-catalog-care/automation-policy.json',bytes:Buffer.from('{"schemaVersion":1}')}],null);reads.length=0;
  const runtime={hosted:true,durable,care:'/private/care',async token(){tokenReads++;return'TEST_ONLY';},state:{async put(key,value){
    assert.equal(records.has(key),false);records.set(key,structuredClone(value));}}};
  const db={prepare(sql){assert.match(sql,/sqlite_master/);return{async all(){return{results:enabled?[{1:1}]:[]};}};},metrics:()=>({requests:1,statements:1,reportedRowsRead:1,reportedRowsWritten:0,unconfirmedRequests:0})};
  const deps={openDatabase:async options=>{assert.equal(options.accountId,CATALOG_SCOPE.accountId);assert.equal(options.requestLimit,'observe');accounting=options.accounting;return db;},
    send:async()=>{throw Error('external networking forbidden');},wait:async ms=>waits.push(ms),now:()=>new Date('2026-11-15T23:00:00.000Z')};
  return{runtime,deps,records,reads,waits,accounting:()=>accounting,tokenReads:()=>tokenReads};
}
test('index sidecar uses only current protected policy and existing saved delivery, never owns catalog publication',async()=>{
  const f=await fixture();let passes=0;
  const result=await runHostedIndexDelivery(f.runtime,{...f.deps,drain:async input=>{
    passes++;assert.equal(input.nativeIndexName,CATALOG_SCOPE.indexName);assert.equal(input.servingIndexName,'fixture-serving');assert.equal(input.store,f.runtime.durable);
    assert.equal(input.token,'TEST_ONLY');assert.equal(Object.hasOwn(input,'owner'),false);
    return{pending:passes===1?1:0,outcomes:[{state:passes===1?'pending':'complete',sequence:1}]};}});
  assert.equal(result.state,'complete');assert.equal(result.catalogBlocked,false);assert.equal(passes,2);assert.deepEqual(f.waits,[45000]);
  assert.equal(f.tokenReads(),1);assert.equal(f.reads.length,3,'pointer, manifest and just the semantic policy');
  assert.equal(f.records.size,1);assert.equal([...f.records.values()][0].unknown,0);
});
test('index failures preserve charged unknown attempts and report attention without invalidating an accepted catalog',async()=>{
  const f=await fixture();
  const result=await runHostedIndexDelivery(f.runtime,{...f.deps,drain:async()=>{
    await f.accounting().reserve({id:'test-unknown',requestSha256:'a'.repeat(64),units:{httpRequests:1,sqlStatements:0}});
    await f.accounting().settle('test-unknown',{status:'unknown',usage:null});
    return{pending:1,outcomes:[{sequence:1,state:'attention',errorCode:'runtime_index_source_changed'}]};}});
  assert.equal(result.state,'attention');assert.equal(result.catalogBlocked,false);assert.equal(f.waits.length,0);
  const summary=[...f.records.entries()].find(([key])=>key.endsWith('/accounting.json'))[1];assert.equal(summary.requests,1);assert.equal(summary.unknown,1);
  assert.equal(f.records.size,3);
});
test('pre-cutover missing index table is a read-only healthy skip and cannot call delivery or policy',async()=>{
  const f=await fixture(false),result=await runHostedIndexDelivery(f.runtime,{...f.deps,drain:()=>{throw Error('unexpected delivery');}});
  assert.equal(result.state,'not_enabled');assert.equal(result.catalogBlocked,false);assert.deepEqual(f.reads,[]);
});
