import assert from 'node:assert/strict';
import test from 'node:test';
import { createVectorizeRestAdapters, hasAccountedVectorReadback,hasAccountedVectorTransport } from '../scripts/catalog/vectorize-rest.ts';
import { accountedPublicationReadFetch,accountedPublicationFetch } from '../scripts/catalog/publication-read-fetch.ts';
import { nativeHash, visible } from '../scripts/catalog/vector-outbox.ts';

const accountId='a'.repeat(32);const publicId='00000000-0000-4000-8000-000000000001';
const mutationId='11111111-1111-4111-8111-111111111111';
const values=Array(1536).fill(Math.fround(.1));values[0]=-0;values[1]=Math.fround(1e-45);
const vector={id:publicId,values,metadata:{catalogRevision:'test-revision',eligible:true,vectorBytesSha256:nativeHash(values)}};
const signal=()=>new AbortController().signal;
const ok=result=>new Response(JSON.stringify({success:true,result}),{headers:{'Content-Type':'application/json'}});
const config={environment:'staging',indexName:'test-index',accountId,token:'TEST_ONLY_NOT_A_CREDENTIAL'};
const delivery={deliveryId:'b'.repeat(64),attempt:1,publicId,vector};
test('bounded native NDJSON batch gets one accounted mutation ACK and preserves signed zero',async()=>{
  let sent=0,reserved=0,settled=0;
  const scope={accountId,workerName:'fixture',indexName:config.indexName,databaseId:publicId,identityOrigin:'https://fixture.invalid'};
  const send=accountedPublicationFetch({async reserveBudget(){reserved++;},async settleBudget(){settled++;}},async(url,init)=>{
    sent++;assert.ok(url.endsWith('/upsert'));const rows=init.body.trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(rows.length,8);assert.ok(rows.every(r=>Object.is(r.values[0],-0)));return ok({mutationId});},scope);
  const api=createVectorizeRestAdapters({...config,fetch:send});
  const batch=Array.from({length:8},(_,i)=>{const id=`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`;return{...delivery,publicId:id,vector:{...vector,id}};});
  assert.deepEqual(await api.dispatchBatch(batch,signal()),{reference:mutationId});assert.equal(sent,1);assert.equal(reserved,1);assert.equal(settled,1);
  await assert.rejects(api.dispatchBatch([...batch,batch[0]],signal()),/invalid_id/);
  await assert.rejects(api.dispatchBatch([batch[0],batch[0]],signal()),/invalid_id/);assert.equal(sent,1);
});
test('owned cleanup joins only the actual factory single AND optional batched readers, not a spread override',()=>{
  const send=accountedPublicationReadFetch({async reserveBudget(){},async settleBudget(){}},async()=>ok([]),
    {accountId,workerName:'test-worker',indexName:config.indexName,databaseId:publicId,identityOrigin:'https://fixture.example.invalid'});
  const adapters=createVectorizeRestAdapters({...config,fetch:send});
  assert.equal(hasAccountedVectorReadback(adapters),true);
  assert.equal(hasAccountedVectorTransport(adapters),true);
  assert.equal(hasAccountedVectorTransport({...adapters}),false);
  assert.equal(hasAccountedVectorReadback({readback:adapters.readback}),true);
  assert.equal(hasAccountedVectorReadback({...adapters,readback:async()=>null}),false);
  assert.equal(hasAccountedVectorReadback({...adapters,readbacks:async()=>[]}),false);
});
test('two-ID native pages keep exact order/absence/signed zero and never accept extra or duplicate IDs',async()=>{
  const second='00000000-0000-4000-8000-000000000002';
  let calls=0;
  const body=JSON.stringify({success:true,result:[vector]}).replace('"values":[0,','"values":[-0,');
  const api=createVectorizeRestAdapters({...config,fetch:async(_url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body),{ids:[second,publicId]});return new Response(body);}});
  const found=await api.readbacks([second,publicId],signal());
  assert.equal(found[0],null);assert.ok(Object.is(found[1].values[0],-0));assert.equal(calls,1);
  for(const ids of [[],[publicId,publicId],Array.from({length:9},(_,i)=>`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`)])await assert.rejects(api.readbacks(ids,signal()),/invalid_id/);
  assert.equal(calls,1);
  for(const result of [[vector,vector],[{...vector,id:mutationId}]]){
    const invalid=createVectorizeRestAdapters({...config,fetch:async()=>ok(result)});
    await assert.rejects(invalid.readbacks([publicId,second],signal()),/provider_failed/);
  }
});
test('eight-ID readback pages preserve every native value within a finite response bound',async()=>{
  const rows=Array.from({length:8},(_,i)=>({...vector,id:`00000000-0000-4000-8000-${String(i+1).padStart(12,'0')}`,
    values:values.map((v,j)=>j<2?v:Math.fround((j%2?-1:1)*1.23456789e-20))}));
  const body=JSON.stringify({success:true,result:rows}).replaceAll('"values":[0,','"values":[-0,');
  assert.ok(Buffer.byteLength(body)>128*1024);assert.ok(Buffer.byteLength(body)<512*1024);
  let calls=0;const api=createVectorizeRestAdapters({...config,fetch:async(_url,init)=>{
    calls++;assert.deepEqual(JSON.parse(init.body).ids,rows.map(v=>v.id));return new Response(body);}});
  const result=await api.readbacks(rows.map(v=>v.id),signal());
  assert.deepEqual(result,rows);assert.equal(calls,1);
});
test('explicit REST bridge binds account/index, preserves negative zero and native bytes, and uses exact-ID readback',async()=>{
  const calls=[];let stored;
  const api=createVectorizeRestAdapters({...config,fetch:async(url,init)=>{
    calls.push({url,init});assert.equal(init.headers.Authorization,`Bearer ${config.token}`);assert.equal(init.redirect,'error');
    if(url.endsWith('/upsert')){stored=JSON.parse(init.body);assert.match(init.body,/"values":\[-0,/);return ok({mutationId});}
    if(url.endsWith('/info'))return ok({dimensions:1536,processedUpToMutation:mutationId});
    assert.ok(url.endsWith('/get_by_ids'));assert.deepEqual(JSON.parse(init.body),{ids:[publicId]});
    // Preserve native zero sign in the mocked HTTP response, just as real JSON
    // transport must do for this explicit exact-byte contract to succeed.
    const body=JSON.stringify({success:true,result:[stored]}).replace('"values":[0,','"values":[-0,');return new Response(body);
  }});
  assert.equal(api.providerIdentity,`cloudflare:${accountId}:test-index`);
  assert.deepEqual(await api.dispatch(delivery,signal()),{reference:mutationId});
  assert.deepEqual(await api.resolve({deliveryId:delivery.deliveryId,attempt:1,reference:mutationId},signal()),{state:'settled',reference:mutationId});
  const actual=await api.readback(publicId,signal());assert.equal(nativeHash(actual.values),nativeHash(vector.values));assert.ok(Object.is(actual.values[0],-0));
  assert.equal(calls.length,3);for(const call of calls)assert.ok(call.url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/test-index/`));
});
test('delete absence uses exact-ID lookup; acceptance alone and different last-processed mutation are pending',async()=>{
  const calls=[];const api=createVectorizeRestAdapters({...config,fetch:async(url,init)=>{calls.push(url);
    if(url.endsWith('/delete_by_ids')){assert.deepEqual(JSON.parse(init.body),{ids:[publicId]});return ok({mutationId});}
    if(url.endsWith('/info'))return ok({dimensions:1536,processedUpToMutation:'22222222-2222-4222-8222-222222222222'});
    return ok([]);
  }});
  assert.deepEqual(await api.dispatch({...delivery,vector:null},signal()),{reference:mutationId});
  assert.deepEqual(await api.resolve({deliveryId:delivery.deliveryId,attempt:1,reference:mutationId},signal()),{state:'pending'});
  const before=calls.length;assert.deepEqual(await api.resolve({deliveryId:delivery.deliveryId,attempt:1,reference:null},signal()),{state:'pending'});
  assert.equal(calls.length,before);assert.equal(await api.readback(publicId,signal()),null);
});
test('short provider JSON decimals decode to exact original float32s, preserving -0 and rejecting changed bits',async()=>{
  for(const changed of [false,true]){
    const decimalValues=Array(1536).fill(.1);decimalValues[0]=-0;decimalValues[1]=1e-45;
    if(changed)decimalValues[2]=.10000001; // Adjacent float32, not another spelling of the original.
    const response=JSON.stringify({success:true,result:[{...vector,values:decimalValues}]}).replace('"values":[0,','"values":[-0,');
    const api=createVectorizeRestAdapters({...config,fetch:async()=>new Response(response)});
    const actual=await api.readback(publicId,signal());
    assert.ok(Object.is(actual.values[0],-0));assert.equal(actual.values[1],Math.fround(1e-45));
    assert.equal(visible(vector,actual),!changed);
    if(changed)assert.notEqual(nativeHash(actual.values),nativeHash(values));
    else{assert.equal(nativeHash(actual.values),nativeHash(values));assert.deepEqual(actual.values,values);}
  }
  for(const invalid of ['0.1',1e40,null]){
    const bad=[...values];bad[2]=invalid;
    const api=createVectorizeRestAdapters({...config,fetch:async()=>ok([{...vector,values:bad}])});
    await assert.rejects(api.readback(publicId,signal()),/vector_provider_invalid_vector/);
  }
});
test('unknown writes never retry; HTTP/provider/malformed responses have fixed safe errors',async()=>{
  for(const response of [()=>{throw new Error('PRIVATE_TOKEN_PROVIDER_BODY');},()=>new Response('PRIVATE_SECRET',{status:503}),
    ()=>new Response('not JSON'),()=>ok({mutationId:'not-an-id'}),()=>new Response(JSON.stringify({success:false,errors:[{message:'PRIVATE'}]}))]){
    let calls=0;const api=createVectorizeRestAdapters({...config,fetch:async()=>{calls++;return response();}});
    await assert.rejects(api.dispatch(delivery,signal()),/^Error: vector_provider_failed$/);assert.equal(calls,1);
  }
});
test('bounded timeout/abort and streamed oversized body fail without retry or unbounded allocation',async()=>{
  let calls=0;const api=createVectorizeRestAdapters({...config,timeoutMs:10,fetch:async(_url,init)=>{calls++;
    return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('PRIVATE abort')),{once:true}));}});
  await assert.rejects(api.dispatch(delivery,signal()),/vector_provider_failed/);assert.equal(calls,1);
  let cancelled=false;const oversized=createVectorizeRestAdapters({...config,fetch:async()=>new Response(new ReadableStream({
    pull(controller){controller.enqueue(new Uint8Array(64*1024));},cancel(){cancelled=true;}}))});
  await assert.rejects(oversized.readback(publicId,signal()),/vector_provider_failed/);assert.equal(cancelled,true);
});
test('background REST defaults to10s, accepts30s and preserves caller abort with no retry',async t=>{
  const scheduled=[];const timer=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{scheduled.push(delay);return timer(callback,delay,...args);});
  const fetch=async()=>ok([]);
  await createVectorizeRestAdapters({...config,fetch}).readback(publicId,signal());
  await createVectorizeRestAdapters({...config,fetch,timeoutMs:30_000}).readback(publicId,signal());
  assert.deepEqual(scheduled,[10_000,30_000]);
  let calls=0;const aborter=new AbortController();
  const api=createVectorizeRestAdapters({...config,fetch:async(_url,init)=>{calls++;
    return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('PRIVATE abort')),{once:true}));}});
  const pending=api.dispatch(delivery,aborter.signal);aborter.abort();
  await assert.rejects(pending,/vector_provider_failed/);assert.equal(calls,1);
});
test('observation abort awaits asynchronous stream cancellation before returning',async()=>{
  let cancelled=false;const controller=new AbortController();
  const api=createVectorizeRestAdapters({...config,fetch:async()=>new Response(new ReadableStream({
    pull(){return new Promise(()=>{});},async cancel(){await new Promise(resolve=>setTimeout(resolve,25));cancelled=true;}}))});
  const pending=api.readback(publicId,controller.signal);await new Promise(resolve=>setTimeout(resolve,5));controller.abort();
  await assert.rejects(pending,/provider_failed/);assert.equal(cancelled,true);
});
test('wrong IDs/namespaces/dimensions and malformed explicit configuration are rejected',async()=>{
  for(const result of [[{...vector,id:'00000000-0000-4000-8000-000000000002'}],[{...vector,namespace:'other'}],
    [{...vector,values:[1,2]}],[vector,vector],{matches:[]},[{...vector,metadata:null}]]){
    const api=createVectorizeRestAdapters({...config,fetch:async()=>ok(result)});await assert.rejects(api.readback(publicId,signal()));
  }
  const api=createVectorizeRestAdapters({...config,fetch:async()=>ok({dimensions:768,processedUpToMutation:mutationId})});
  await assert.rejects(api.resolve({reference:mutationId},signal()));
  for(const override of [{token:''},{accountId:'wrong'},{indexName:'../other'},{environment:'preview'},
    ...[0,9,-1,30_001,10.5,NaN].map(timeoutMs=>({timeoutMs}))])
    assert.throws(()=>createVectorizeRestAdapters({...config,...override}),/invalid_vectorize_configuration/);
});
