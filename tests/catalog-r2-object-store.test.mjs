import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createCatalogR2Store} from '../scripts/catalog/r2-object-store.ts';

const bytes=value=>new TextEncoder().encode(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const objects=new Map(),calls=[];let loseAck=false,oddAck=false,readFaults=[],writeFaults=[];
  const config={accountId:'a'.repeat(32),bucket:'private-test-bucket',prefix:'hosted-v1',
    accessKeyId:'SYNTHETIC_ACCESS',secretAccessKey:'SYNTHETIC_SECRET'};
  const store=createCatalogR2Store({...config,send:async request=>{
    const url=new URL(request.url);assert.equal(url.origin,`https://${config.accountId}.r2.cloudflarestorage.com`);
    assert.ok(url.pathname.startsWith('/private-test-bucket/hosted-v1/'));assert.equal(request.redirect,'error');
    assert.match(request.headers.get('authorization'),/^AWS4-HMAC-SHA256 /);
    const key=url.pathname.split('/hosted-v1/')[1],old=objects.get(key);calls.push({key,method:request.method,
      expected:request.headers.get('if-match'),absent:request.headers.get('if-none-match')});
    if(request.method==='GET'){
      if(readFaults.length){const fault=readFaults.shift();if(fault instanceof Error)throw fault;return typeof fault==='function'?fault():fault;}
      return old?new Response(old.body,{headers:{etag:old.etag,'x-amz-meta-sha256':old.hash}}):new Response(null,{status:404});}
    if(request.method==='DELETE'){objects.delete(key);return new Response(null,{status:204});}
    if(writeFaults.length){const fault=writeFaults.shift();if(fault instanceof Error)throw fault;return fault;}
    const expected=request.headers.get('if-match'),absent=request.headers.get('if-none-match');
    assert.ok(expected||absent==='*');
    if(absent==='*'&&old||expected&&old?.etag!==expected)return new Response(null,{status:412});
    assert.equal(request.method,'PUT');const body=new Uint8Array(await request.arrayBuffer()),digest=hash(body),md5=createHash('md5').update(body).digest();
    assert.equal(request.headers.get('x-amz-meta-sha256'),digest);
    assert.equal(request.headers.get('content-md5'),md5.toString('base64'));
    objects.set(key,{body,hash:digest,etag:'"'+md5.toString('hex')+'"'});
    if(loseAck){loseAck=false;throw Error('SYNTHETIC_LOST_ACK');}
    if(oddAck){oddAck=false;return new Response(null,{headers:{etag:'"unrecognized-ack"'}});}
    return new Response(null,{headers:{etag:'"'+md5.toString('hex')+'"'}});
  }});
  return{store,objects,calls,loseNextAck:()=>{loseAck=true;},oddNextAck:()=>{oddAck=true;},failReads:(...faults)=>{readFaults=faults;},failWrites:(...faults)=>{writeFaults=faults;}};
}

test('immutable objects preserve exact bytes and reject conflicting overwrite',async()=>{
  const f=fixture(),body=bytes('original response');
  const first=await f.store.putImmutable('runs/one/objects/body.json',body);
  assert.deepEqual(first.bytes,body);
  assert.deepEqual(f.calls.map(c=>c.method),['PUT']); // checksum-verified durable ACK; no second read
  assert.deepEqual(await f.store.putImmutable('runs/one/objects/body.json',body),first);
  await assert.rejects(f.store.putImmutable('runs/one/objects/body.json',bytes('different')),/conflict/);
  assert.deepEqual((await f.store.get('runs/one/objects/body.json')).bytes,body);
});
test('head CAS is exact, repeat-safe and refuses a competing head',async()=>{
  const {store}=fixture(),key='runs/one/head.json',first=await store.compareAndSwap(key,null,bytes('head0'));
  const second=await store.compareAndSwap(key,first.etag,bytes('head1'));
  assert.deepEqual(await store.compareAndSwap(key,first.etag,bytes('head1')),second);
  await assert.rejects(store.compareAndSwap(key,first.etag,bytes('foreign')),/conflict/);
  assert.deepEqual((await store.get(key)).bytes,bytes('head1'));
});
test('lost write ACK resolves from exact readback without a second dispatch',async()=>{
  const f=fixture();f.loseNextAck();
  assert.deepEqual((await f.store.putImmutable('runs/one/events/event.json',bytes('charged before provider'))).bytes,bytes('charged before provider'));
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);
});
test('an unfamiliar successful ACK still requires exact SHA-256 byte readback, never a second write',async()=>{
  const f=fixture();f.oddNextAck();const body=bytes('same original bytes');
  assert.deepEqual((await f.store.putImmutable('runs/one/objects/body.json',body)).bytes,body);
  assert.deepEqual(f.calls.map(c=>c.method),['PUT','GET']);
});
test('transient readback network/503 failures retry the same GET, never the uncertain PUT',async()=>{
  const f=fixture();f.loseNextAck();f.failReads(Error('network interruption'),new Response(null,{status:503,headers:{'retry-after':'0'}}));
  assert.deepEqual((await f.store.putImmutable('runs/one/events/event.json',bytes('original'))).bytes,bytes('original'));
  assert.equal(f.calls.filter(c=>c.method==='PUT').length,1);assert.equal(f.calls.filter(c=>c.method==='GET').length,3);
});
test('read retries are bounded; credentials, corrupt bytes and long provider throttles are not retried',async()=>{
  const f=fixture();f.failReads(...Array.from({length:3},()=>Error('network interruption')));
  await assert.rejects(f.store.get('runs/one/head.json'),/unavailable/);assert.equal(f.calls.length,3);
  for(const response of [new Response(null,{status:401}),new Response(null,{status:429,headers:{'retry-after':'60'}})]){
    const before=f.calls.length;f.failReads(response);await assert.rejects(f.store.get('runs/one/head.json'),/read_refused|read_throttled/);
    assert.equal(f.calls.length,before+1);
  }
});
test('transient immutable and CAS writes retry exact bytes with the ORIGINAL condition',async()=>{
  for(const cas of [false,true]){
    const f=fixture(),key=cas?'runs/one/head.json':'runs/one/objects/body.json',body=bytes('new original bytes');
    const prior=cas?await f.store.compareAndSwap(key,null,bytes('prior')):null,before=f.calls.length;
    f.failWrites(new Response(null,{status:503,headers:{'retry-after':'0'}}));
    const result=cas?await f.store.compareAndSwap(key,prior.etag,body):await f.store.putImmutable(key,body);
    assert.deepEqual(result.bytes,body);const calls=f.calls.slice(before);assert.deepEqual(calls.map(c=>c.method),['PUT','GET','PUT']);
    const puts=calls.filter(c=>c.method==='PUT');assert.ok(puts.every(c=>c.key===key&&c.expected===(prior?.etag??null)&&c.absent===(cas?null:'*')));
  }
});
test('a late ambiguous write after a negative read is reconciled, never overwritten or duplicated',async()=>{
  for(const cas of [false,true]){
    const f=fixture(),key=cas?'runs/one/head.json':'runs/one/objects/body.json',body=bytes('original'),md5=createHash('md5').update(body).digest('hex');
    const prior=cas?await f.store.compareAndSwap(key,null,bytes('prior')):null,before=f.calls.length;
    f.failWrites(Error('lost connection; original still in flight'));
    f.failReads(()=>{const response=prior?new Response(prior.bytes,{headers:{etag:prior.etag,'x-amz-meta-sha256':hash(prior.bytes)}}):new Response(null,{status:404});
      f.objects.set(key,{body,hash:hash(body),etag:'"'+md5+'"'});return response;});
    const result=cas?await f.store.compareAndSwap(key,prior.etag,body):await f.store.putImmutable(key,body);
    assert.deepEqual(result.bytes,body);const calls=f.calls.slice(before);assert.deepEqual(calls.map(c=>c.method),['PUT','GET','PUT','GET']);
    assert.equal(f.objects.size,1);assert.ok(calls.filter(c=>c.method==='PUT').every(c=>c.expected===(prior?.etag??null)&&c.absent===(cas?null:'*')));
  }
});
test('write retries never re-anchor a competing head or bypass uncertainty, credentials or long throttles',async()=>{
  const f=fixture(),key='runs/one/head.json',prior=await f.store.compareAndSwap(key,null,bytes('prior'));
  f.failWrites(new Response(null,{status:503}));f.failReads(()=>{
    const body=bytes('competing');f.objects.set(key,{body,hash:hash(body),etag:'"competing"'});
    return new Response(body,{headers:{etag:'"competing"','x-amz-meta-sha256':hash(body)}});});
  const before=f.calls.length;await assert.rejects(f.store.compareAndSwap(key,prior.etag,bytes('ours')),/conflict/);
  assert.equal(f.calls.slice(before).filter(c=>c.method==='PUT').length,1);
  for(const fault of [new Response(null,{status:401}),new Response(null,{status:429,headers:{'retry-after':'60'}})]){
    const g=fixture();g.failWrites(fault);await assert.rejects(g.store.putImmutable('runs/one/objects/body.json',bytes('body')),/write_refused|write_throttled/);
    assert.equal(g.calls.filter(c=>c.method==='PUT').length,1);
  }
  const g=fixture();g.failWrites(Error('write unknown'));g.failReads(...Array.from({length:3},()=>Error('read unknown')));
  await assert.rejects(g.store.putImmutable('runs/one/objects/body.json',bytes('body')),/unavailable/);
  assert.equal(g.calls.filter(c=>c.method==='PUT').length,1);
  const h=fixture();h.failWrites(...Array.from({length:3},()=>new Response(null,{status:503,headers:{'retry-after':'0'}})));
  await assert.rejects(h.store.putImmutable('runs/one/objects/body.json',bytes('body')),/write_refused/);
  assert.equal(h.calls.filter(c=>c.method==='PUT').length,3);
});
test('cleanup is immutable-body only and checks exact identity without claiming atomic conditional delete',async()=>{
  const {store,objects}=fixture(),key='runs/one/objects/expired.json',first=await store.putImmutable(key,bytes('body'));
  await assert.rejects(store.compareAndSwap(key,first.etag,bytes('replacement')),/immutable_key/);
  const replacement=bytes('unexpected changed body'),second={body:replacement,hash:hash(replacement),etag:'"'+hash(replacement)+'"'};
  objects.set(key,second);
  await assert.rejects(store.remove(key,first.etag),/conflict/);
  assert.deepEqual((await store.get(key)).bytes,second.body);
  await store.remove(key,second.etag);await store.remove(key,second.etag);
  assert.equal(await store.get(key),null);
  await assert.rejects(store.remove('runs/one/head.json',second.etag),/mutable_key/);
});
test('traversal, local locks, foreign paths and malformed metadata are refused',async()=>{
  const f=fixture();
  for(const key of ['../outside','runs/one/../two','/absolute','runs//one','locks/old.lock','runs/one/%2e%2e'])
    await assert.rejects(f.store.get(key),/key/);
  assert.equal(f.calls.length,0);
  await f.store.putImmutable('runs/one/objects/body.json',bytes('body'));
  f.objects.get('runs/one/objects/body.json').hash='b'.repeat(64);
  await assert.rejects(f.store.get('runs/one/objects/body.json'),/digest/);
});
