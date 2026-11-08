import assert from 'node:assert/strict';
import test from 'node:test';
import { accountedPublicationReadFetch, accountedPublicationFetch, isAccountedPublicationReadFetch } from '../scripts/catalog/publication-read-fetch.ts';
import { createVectorizeRestAdapters } from '../scripts/catalog/vectorize-rest.ts';

const id='00000000-0000-4000-8000-000000000001';
const scope={accountId:'a'.repeat(32),workerName:'fixture-worker',indexName:'fixture-index',databaseId:id,identityOrigin:'https://fixture.example.invalid'};
const vector=`https://api.cloudflare.com/client/v4/accounts/${scope.accountId}/vectorize/v2/indexes/${scope.indexName}`;
const init={method:'POST',redirect:'error',body:JSON.stringify({ids:[id]})};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('derived lookups match the provider20-ID transport boundary before reservation',async()=>{
  for(const factory of [accountedPublicationReadFetch,accountedPublicationFetch]){
    let sent=0;const events=[],ws={async reserveBudget(e){events.push(e);},async settleBudget(_id,e){events.push(e);}};
    const read=factory(ws,async()=>{sent++;return Response.json({success:true,result:[]});},{...scope,derivedIndexName:'derived'});
    const ids=Array.from({length:21},(_,n)=>String(n).padStart(64,'0')),url=vector.replace(scope.indexName,'derived')+'/get_by_ids';
    await read(url,{...init,body:JSON.stringify({ids:ids.slice(0,20)})});
    await assert.rejects(read(url,{...init,body:JSON.stringify({ids})}),/scope_invalid/);
    assert.equal(sent,1);assert.equal(events.length,2);
  }
});
test('explicit derived index permits accounted identity metadata only, never vectors or mutations',async()=>{
  const derived=vector.replace(scope.indexName,'fixture-derived');
  for(const factory of [accountedPublicationReadFetch,accountedPublicationFetch]){
    const events=[],ws={async reserveBudget(x){events.push(x);},async settleBudget(_id,x){events.push(x);}};
    const read=factory(ws,async()=>Response.json({success:true,result:{name:'fixture-derived'}}),{...scope,derivedIndexName:'fixture-derived'});
    await read(derived,{method:'GET',redirect:'error'});assert.equal(events.length,2);
    for(const [url,options]of [[derived+'/info',{method:'GET',redirect:'error'}],[derived+'/get_by_ids',init],
      [derived+'/delete_by_ids',init],[derived+'/upsert',init],[derived.replace('fixture-derived','foreign'),{method:'GET',redirect:'error'}]])
      await assert.rejects(read(url,options),/scope_invalid/);
    assert.equal(events.length,2);
    const ordinary=factory(ws,async()=>Response.json({}),scope);
    await assert.rejects(ordinary(derived,{method:'GET',redirect:'error'}),/scope_invalid/);
    for(const name of [scope.indexName,'bad/name','x'.repeat(65)])
      assert.throws(()=>factory(ws,fetch,{...scope,derivedIndexName:name}),/scope_invalid/);
  }
});
test('scoped read companion refuses mutation/foreign/oversize requests before any reservation',async()=>{
  const events=[];const ws={async reserveBudget(value){events.push(value);},async settleBudget(_id,value){events.push(value);}};
  const read=accountedPublicationReadFetch(ws,async()=>Response.json({success:true,result:[]}),scope);
  assert.equal(isAccountedPublicationReadFetch(read),true);assert.equal(isAccountedPublicationReadFetch(async()=>{}),false);
  for(const [url,options]of [[`${vector}/upsert`,init],[`${vector}/get_by_ids`,{...init,body:JSON.stringify({ids:[id,id]})}],
    [`${vector}/get_by_ids`,{...init,body:'x'.repeat(4097)}],[`${vector}/get_by_ids?other=1`,init],
    ['https://other.invalid/.well-known/catalog-release.json',{method:'GET',redirect:'error'}],
    [`${vector}/info`,{method:'GET',redirect:'follow'}]])await assert.rejects(read(url,options),/scope_invalid/);
  assert.equal(events.length,0);
  await read(`${vector}/get_by_ids`,init);assert.equal(events[0].units.httpRequests,1);assert.deepEqual(events[1],{status:'known',usage:{rowsRead:0,rowsWritten:0}});
});
test('abort during reserve never dispatches, preserves unknown once and awaits own settlement',async()=>{
  let releaseReserve,releaseSettle,sends=0;const events=[];
  const ws={async reserveBudget(){events.push('reserve');await new Promise(resolve=>{releaseReserve=resolve;});},
    async settleBudget(_id,value){events.push(value.status);await new Promise(resolve=>{releaseSettle=resolve;});events.push('settled');}};
  const read=accountedPublicationReadFetch(ws,async()=>{sends++;return Response.json({});},scope),controller=new AbortController();
  let returned=false;const pending=read(`${vector}/get_by_ids`,{...init,signal:controller.signal}).finally(()=>{returned=true;});
  const rejected=assert.rejects(pending,/read_unavailable/);controller.abort();releaseReserve();await pause(5);
  assert.equal(returned,false);assert.equal(sends,0);assert.deepEqual(events,['reserve','unknown']);releaseSettle();await rejected;
  assert.deepEqual(events,['reserve','unknown','settled']);
});
test('slow durable reservation and settlement do not consume provider or body timeouts',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let releaseReserve,releaseSettle,sends=0;const events=[];
  const ws={async reserveBudget(){events.push('reserve');await new Promise(resolve=>{releaseReserve=resolve;});},
    async settleBudget(_id,value){events.push(value.status);await new Promise(resolve=>{releaseSettle=resolve;});}};
  const read=accountedPublicationReadFetch(ws,async()=>{sends++;return Response.json({success:true,result:[]});},scope);
  const api=createVectorizeRestAdapters({...scope,environment:'staging',token:'TEST_ONLY',fetch:read,timeoutMs:10});
  const pending=api.readback(id,new AbortController().signal);
  t.mock.timers.tick(12_000);assert.equal(sends,0);releaseReserve();
  for(let n=0;n<20;n++)await Promise.resolve();
  assert.equal(sends,1);assert.deepEqual(events,['reserve','known']);
  t.mock.timers.tick(12_000);releaseSettle();assert.equal(await pending,null);
  assert.deepEqual(events,['reserve','known']);
});
test('default read timeout fences arbitrary raw sender and late response cannot touch ledger',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let deliver,cancelled=false;const events=[];
  const ws={async reserveBudget(){events.push('reserve');},async settleBudget(_id,value){events.push(value.status);}};
  const read=accountedPublicationReadFetch(ws,async()=>new Promise(resolve=>{deliver=resolve;}),scope);
  const pending=read(`${vector}/get_by_ids`,init),rejected=assert.rejects(pending,/read_unavailable/);
  await Promise.resolve();t.mock.timers.tick(10_000);await rejected;assert.deepEqual(events,['reserve','unknown']);
  deliver(new Response(new ReadableStream({cancel(){cancelled=true;}})));await Promise.resolve();await Promise.resolve();
  assert.equal(cancelled,true);assert.deepEqual(events,['reserve','unknown']);
});
test('owned native read waits for delayed durable cleanup beyond the generic ten-second drain',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let sent=false,settled=false,returned=false;const events=[];
  const ws={async reserveBudget(){events.push('reserve');},async settleBudget(_id,value){events.push(value.status);await pause(12_000);settled=true;}};
  const read=accountedPublicationReadFetch(ws,async()=>{sent=true;return new Promise(()=>{});},scope);
  const api=createVectorizeRestAdapters({...scope,environment:'staging',token:'TEST_ONLY',fetch:read,timeoutMs:10});
  const pending=api.readback(id,new AbortController().signal).finally(()=>{returned=true;}),rejected=assert.rejects(pending,/provider_failed/);
  await Promise.resolve();assert.equal(sent,true);t.mock.timers.tick(10_000);await Promise.resolve();await Promise.resolve();
  assert.deepEqual(events,['reserve','unknown']);t.mock.timers.tick(10_000);await Promise.resolve();assert.equal(returned,false);assert.equal(settled,false);
  t.mock.timers.tick(2000);await rejected;assert.equal(settled,true);assert.equal(returned,true);assert.deepEqual(events,['reserve','unknown']);
});
test('failed settlement is never retried or changed to another status',async()=>{
  const events=[];const ws={async reserveBudget(){},async settleBudget(_id,value){events.push(value.status);throw new Error('durability failure');}};
  const read=accountedPublicationReadFetch(ws,async()=>Response.json({}),scope);
  await assert.rejects(read(`${vector}/get_by_ids`,init),/durability failure/);assert.deepEqual(events,['known']);
});
test('owned send accounting never grants an unbounded response-parser or stream-cancel join',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let settled=0,cancelled=false;
  const read=accountedPublicationReadFetch({async reserveBudget(){},async settleBudget(){settled++;}},async()=>new Response(new ReadableStream({
    start(c){c.enqueue(new Uint8Array(128*1024+1));},cancel(){cancelled=true;return new Promise(()=>{});}})),scope);
  const api=createVectorizeRestAdapters({...scope,environment:'staging',token:'TEST_ONLY',fetch:read,timeoutMs:10});
  const pending=api.readback(id,new AbortController().signal),rejected=assert.rejects(pending,/cleanup_pending/);
  for(let i=0;i<12;i++)await Promise.resolve();assert.equal(settled,1);assert.equal(cancelled,true);
  t.mock.timers.tick(10);for(let i=0;i<12;i++)await Promise.resolve();
  t.mock.timers.tick(10_000);await rejected;assert.equal(settled,1);
});
