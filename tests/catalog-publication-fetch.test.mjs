import assert from 'node:assert/strict';
import test from 'node:test';
import { accountedPublicationFetch, accountedPublicationReadFetch, isAccountedPublicationFetch,
  isAccountedPublicationReadFetch } from '../scripts/catalog/publication-read-fetch.ts';
import { createVectorizeRestAdapters, hasAccountedVectorReadback } from '../scripts/catalog/vectorize-rest.ts';

const id='00000000-0000-4000-8000-000000000001';
const scope={accountId:'a'.repeat(32),workerName:'fixture-worker',indexName:'fixture-index',databaseId:id,identityOrigin:'https://fixture.example.invalid'};
const base=`https://api.cloudflare.com/client/v4/accounts/${scope.accountId}`;
const vector=`${base}/vectorize/v2/indexes/${scope.indexName}`,worker=`${base}/workers/scripts/${scope.workerName}`;
const post=body=>({method:'POST',redirect:'error',body:JSON.stringify(body)});
const sample={id,values:Array(1536).fill(0.25),metadata:{catalog_revision:'fixture-r1'}};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function ledger(){const events=[];return{events,async reserveBudget(value){events.push({reserve:value});},async settleBudget(id,value){events.push({id,...value});}};}

test('general companion counts every scoped REST attempt without becoming a read-only sender',async()=>{
  const ws=ledger();let sends=0;
  const send=accountedPublicationFetch(ws,async()=>{sends++;return Response.json({});},scope);
  assert.equal(isAccountedPublicationFetch(send),true);assert.equal(isAccountedPublicationReadFetch(send),false);
  for(const [url,init]of [
    [`${vector}/upsert`,{...post(sample),body:`${JSON.stringify(sample)}\n`}],
    [`${vector}/delete_by_ids`,post({ids:[id]})],[`${vector}/get_by_ids`,post({ids:[id]})],
    [`${worker}/versions?page=1&per_page=10`,{redirect:'error'}],
    [`${worker}/versions/${id}`,{redirect:'error'}],[`${worker}/deployments`,{redirect:'error'}],
    [`${worker}/deployments`,post({strategy:'percentage',versions:[{version_id:id,percentage:100}],annotations:{'workers/message':'fixture-marker'}})],
    [`${base}/d1/database/${id}`,{redirect:'error'}],
    [`${scope.identityOrigin}/.well-known/catalog-release.json`,{redirect:'error'}],
  ])await send(url,init);
  assert.equal(sends,9);assert.equal(ws.events.length,18);
  const reservations=ws.events.filter(event=>event.reserve).map(event=>event.reserve);
  assert.equal(new Set(reservations.map(value=>value.id)).size,9);
  assert.ok(reservations.every(value=>value.units.httpRequests===1&&value.units.sqlStatements===0));
  assert.ok(ws.events.filter(event=>event.status).every(event=>event.status==='known'));
});

test('general companion rejects foreign resources, D1 queries and broadened mutations before reservation',async()=>{
  const ws=ledger(),send=accountedPublicationFetch(ws,async()=>{throw new Error('must not dispatch');},scope);
  for(const [url,init]of [
    [`${base}/d1/database/${id}/query`,post({batch:[]})],
    [`${vector}/upsert`,post({...sample,namespace:'foreign'})],
    [`${vector}/upsert`,post({...sample,values:[0.25]})],
    [`${vector}/upsert`,{...post(sample),body:`${JSON.stringify(sample)}\n${JSON.stringify(sample)}\n`}],
    [`${vector}/delete_by_ids`,post({ids:[id,id]})],
    [`${worker}/deployments`,post({strategy:'percentage',versions:[{version_id:id,percentage:50}],annotations:{'workers/message':'fixture'}})],
    [`${worker}/versions?page=11&per_page=10`,{redirect:'error'}],
    [`${worker}/versions?page=1&page=2&per_page=10`,{redirect:'error'}],
    [`${worker}/versions?page=1&per_page=100`,{redirect:'error'}],
    [`${vector}/info?other=1`,{redirect:'error'}],
    [`${vector}/info`,{redirect:'follow'}],
    ['https://other.example.invalid/.well-known/catalog-release.json',{redirect:'error'}],
  ])await assert.rejects(send(url,init),/scope_invalid/);
  assert.equal(ws.events.length,0);
});

test('neither companion can nest an already-accounted sender or borrow its ledger',()=>{
  const first=ledger(),second=ledger(),raw=async()=>Response.json({});
  for(const sender of [accountedPublicationFetch(first,raw,scope),accountedPublicationReadFetch(first,raw,scope)]){
    assert.throws(()=>accountedPublicationFetch(second,sender,scope),/already_accounted/);
    assert.throws(()=>accountedPublicationReadFetch(second,sender,scope),/already_accounted/);
  }
  assert.equal(first.events.length,0);assert.equal(second.events.length,0);
});

test('mutation abort during reservation dispatches nothing and awaits exactly one durable unknown',async()=>{
  let reserveDone,settleDone,sends=0,returned=false;const events=[];
  const ws={async reserveBudget(){events.push('reserve');await new Promise(resolve=>{reserveDone=resolve;});},
    async settleBudget(_id,result){events.push(result.status);await new Promise(resolve=>{settleDone=resolve;});}};
  const send=accountedPublicationFetch(ws,async()=>{sends++;return Response.json({});},scope),abort=new AbortController();
  const pending=send(`${vector}/upsert`,{...post(sample),signal:abort.signal}).finally(()=>{returned=true;});
  const rejected=assert.rejects(pending,/unavailable/);abort.abort();reserveDone();await pause(5);
  assert.equal(sends,0);assert.equal(returned,false);assert.deepEqual(events,['reserve','unknown']);
  settleDone();await rejected;assert.equal(returned,true);
});

test('owned Vectorize mutation waits for its accounting even when settlement outlives adapter timeout',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let dispatched=false,returned=false,releaseSettle;const events=[];
  const ws={async reserveBudget(){events.push('reserve');},async settleBudget(_id,result){events.push(result.status);await new Promise(resolve=>{releaseSettle=resolve;});}};
  const send=accountedPublicationFetch(ws,async()=>{dispatched=true;return new Promise(()=>{});},scope);
  const api=createVectorizeRestAdapters({...scope,environment:'staging',token:'TEST_ONLY',fetch:send,timeoutMs:10});
  const pending=api.dispatch({publicId:id,vector:sample},new AbortController().signal).finally(()=>{returned=true;});
  const rejected=assert.rejects(pending,/provider_failed/);
  for(let i=0;i<8;i++)await Promise.resolve();assert.equal(dispatched,true);
  t.mock.timers.tick(10_000);for(let i=0;i<8;i++)await Promise.resolve();
  assert.deepEqual(events,['reserve','unknown']);assert.equal(returned,false);
  t.mock.timers.tick(10_000);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(returned,false);
  releaseSettle();await rejected;assert.equal(returned,true);assert.deepEqual(events,['reserve','unknown']);
});

test('general-accounted native read advertises and retains durable cleanup ownership',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let dispatched=false,returned=false,releaseSettle;
  const ws={async reserveBudget(){},async settleBudget(){await new Promise(resolve=>{releaseSettle=resolve;});}};
  const send=accountedPublicationFetch(ws,async()=>{dispatched=true;return new Promise(()=>{});},scope);
  const api=createVectorizeRestAdapters({...scope,environment:'staging',token:'TEST_ONLY',fetch:send,timeoutMs:10});
  assert.equal(hasAccountedVectorReadback(api),true);
  const pending=api.readback(id,new AbortController().signal).finally(()=>{returned=true;});
  const rejected=assert.rejects(pending,/provider_failed/);
  for(let i=0;i<8;i++)await Promise.resolve();assert.equal(dispatched,true);
  t.mock.timers.tick(10);for(let i=0;i<8;i++)await Promise.resolve();
  t.mock.timers.tick(10_000);for(let i=0;i<8;i++)await Promise.resolve();assert.equal(returned,false);
  releaseSettle();await rejected;assert.equal(returned,true);
});

test('mutation deadline fences an arbitrary late raw response without late ledger writes',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let resolveResponse,cancelled=false;const ws=ledger();
  const send=accountedPublicationFetch(ws,async()=>new Promise(resolve=>{resolveResponse=resolve;}),scope);
  const pending=send(`${vector}/upsert`,post(sample)),rejected=assert.rejects(pending,/unavailable/);
  await Promise.resolve();t.mock.timers.tick(10_000);await rejected;
  assert.deepEqual(ws.events.filter(event=>event.status).map(event=>event.status),['unknown']);
  resolveResponse(new Response(new ReadableStream({cancel(){cancelled=true;}})));
  for(let i=0;i<8;i++)await Promise.resolve();assert.equal(cancelled,true);
  assert.equal(ws.events.length,2);
});
