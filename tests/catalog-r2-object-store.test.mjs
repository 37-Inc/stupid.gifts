import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {createCatalogR2Store} from '../scripts/catalog/r2-object-store.ts';

const bytes=value=>new TextEncoder().encode(value);
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const objects=new Map(),calls=[];let loseAck=false;
  const config={accountId:'a'.repeat(32),bucket:'private-test-bucket',prefix:'hosted-v1',
    accessKeyId:'SYNTHETIC_ACCESS',secretAccessKey:'SYNTHETIC_SECRET'};
  const store=createCatalogR2Store({...config,send:async request=>{
    const url=new URL(request.url);assert.equal(url.origin,`https://${config.accountId}.r2.cloudflarestorage.com`);
    assert.ok(url.pathname.startsWith('/private-test-bucket/hosted-v1/'));assert.equal(request.redirect,'error');
    assert.match(request.headers.get('authorization'),/^AWS4-HMAC-SHA256 /);
    const key=url.pathname.split('/hosted-v1/')[1],old=objects.get(key);calls.push({key,method:request.method});
    if(request.method==='GET')return old?new Response(old.body,{headers:{etag:old.etag,'x-amz-meta-sha256':old.hash}}):new Response(null,{status:404});
    if(request.method==='DELETE'){objects.delete(key);return new Response(null,{status:204});}
    const expected=request.headers.get('if-match'),absent=request.headers.get('if-none-match');
    assert.ok(expected||absent==='*');
    if(absent==='*'&&old||expected&&old?.etag!==expected)return new Response(null,{status:412});
    assert.equal(request.method,'PUT');const body=new Uint8Array(await request.arrayBuffer()),digest=hash(body);
    assert.equal(request.headers.get('x-amz-meta-sha256'),digest);
    objects.set(key,{body,hash:digest,etag:'"'+digest+'"'});
    if(loseAck){loseAck=false;throw Error('SYNTHETIC_LOST_ACK');}
    return new Response(null,{headers:{etag:'"'+digest+'"'}});
  }});
  return{store,objects,calls,loseNextAck:()=>{loseAck=true;}};
}

test('immutable objects preserve exact bytes and reject conflicting overwrite',async()=>{
  const f=fixture(),body=bytes('original response');
  const first=await f.store.putImmutable('runs/one/objects/body.json',body);
  assert.deepEqual(first.bytes,body);
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
