import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {generateKeyPair,exportJWK,SignJWT,createLocalJWKSet} from 'jose';
import {createContentRequestStore} from '../lib/catalog/content-admin.ts';
import {contentAdminActor} from '../workers/site/content-admin-auth.ts';
import {createSiteWorker} from '../workers/site/index.ts';
import {createContentAdminHandler} from '../workers/site/content-admin.ts';

const NOW=Date.parse('2026-11-11T09:00:00Z'),ISSUER='https://test-content-admin.cloudflareaccess.com',AUD='a'.repeat(64);
const pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'admin-fixture',alg:'RS256',use:'sig'},
  localKeys=createLocalJWKSet({keys:[jwk]});
async function token(overrides={},signer=pair.privateKey){
  return new SignJWT({type:'app',email:'staff@example.invalid',...overrides}).setProtectedHeader({alg:'RS256',kid:'admin-fixture'})
    .setIssuer(ISSUER).setAudience(AUD).setSubject('staff-fixture').setIssuedAt(NOW/1000-10).setExpirationTime(NOW/1000+3600).sign(signer);
}
const config={CONTENT_ADMIN_ENABLED:'true',CONTENT_ADMIN_TEAM_DOMAIN:ISSUER,CONTENT_ADMIN_AUD:AUD,CONTENT_ADMIN_STAFF_EMAILS:'staff@example.invalid'};
async function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(await readFile(new URL('../migrations/d1/0018_content_admin_requests.sql',import.meta.url),'utf8'));
  sql.exec(`CREATE TABLE products(id TEXT PRIMARY KEY,public_id TEXT); INSERT INTO products VALUES('B000000001','public-1'),('B000000099','held-99');
    CREATE TABLE catalog_mutation_scopes(phase,generation,mutation_epoch,external_pending);
    INSERT INTO catalog_mutation_scopes VALUES('freezing',94,1723,0);
    CREATE TABLE catalog_build_requests(state,source_revision,release_id,version_reference,error_code,request_json);
    INSERT INTO catalog_build_requests VALUES('building','accepted',NULL,NULL,NULL,'{"codeSha":"${'b'.repeat(40)}"}');
    CREATE TABLE publication_outbox(release_id,catalog_revision,intent_json);
    INSERT INTO publication_outbox VALUES('live-code','accepted','{"codeSha":"${'b'.repeat(40)}"}');
    CREATE TABLE catalog_runs(id,status,mode,completed_at); INSERT INTO catalog_runs VALUES('last-full','completed','full','2026-11-10T22:00:00.000Z');`);
  let writes=0,reads=0,loseAck=false;
  const db={prepare(query){let params=[];return{bind(...p){params=p;return this;},async all(){reads++;return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},
    async run(){writes++;const result=sql.prepare(query).run(...params);if(loseAck){loseAck=false;throw Error('lost ACK');}return result;}};}};
  const product=n=>({id:`B${String(n).padStart(9,'0')}`,publicId:'public-'+n,slug:'gift-'+n,title:'Complete gift '+n,description:'Factual short description.',
    imageUrl:'/images/gift.svg',affiliateUrl:`https://www.amazon.com/dp/B${String(n).padStart(9,'0')}?tag=goose-gifts-37-20`,source:'amazon',currency:'USD',price:0,
    qualityScore:0.8,isActive:true,eligibleUntil:null,indexable:true});
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:'accepted',generatedAt:new Date(NOW).toISOString(),products:Array.from({length:24},(_,i)=>product(i+1)),
    heldProducts:[{id:'B000000099',publicId:'held-99',slug:'held-gift',path:'/gifts/held-gift',title:'Gift currently unavailable',description:'Held',reason:'unavailable'}],slugHistory:[]};
  const edition={schemaVersion:1,day:'2026-11-11',anchors:snapshot.products.slice(0,6).map(p=>p.publicId),rotation:snapshot.products.slice(6).map(p=>p.publicId)};
  const manifest={schemaVersion:1,releaseId:'live-code',codeSha:'b'.repeat(40),catalogRevision:'accepted',catalogSnapshotSha256:'c'.repeat(64),dataKind:'catalog',
    generatedAt:snapshot.generatedAt,nextExpiry:null,vectorSyncWatermark:0,productCount:24,slugCount:24,priorReleaseId:null,checksums:{},routes:{},homepage:edition};
  const releaseIdentity={release_id:manifest.releaseId,code_sha:manifest.codeSha,catalog_revision:'accepted',catalog_snapshot_sha256:'c'.repeat(64),manifest_sha256:'d'.repeat(64)};
  const env={...config,ENVIRONMENT:'production',DB:db,ASSETS:{fetch(){throw Error('admin must not fetch assets');}}};
  const worker=createSiteWorker({snapshot,manifest,releaseIdentity,canonicalOrigin:'https://stupid.gifts',now:()=>NOW});
  const jwt=await token(),realFetch=globalThis.fetch;
  globalThis.fetch=async url=>{assert.equal(String(url),ISSUER+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]});};
  t.after(()=>{globalThis.fetch=realFetch;});
  let sequence=0;
  const call=(path,{method='GET',payload,headers={},auth=jwt,...rest}={})=>worker.fetch(new Request('https://stupid.gifts/api/content-admin'+path,{method,
    headers:{...(auth?{'Cf-Access-Jwt-Assertion':auth}:{}),...(method!=='GET'?{Origin:'https://stupid.gifts','Content-Type':'application/json','Idempotency-Key':'fixture-request-'+String(++sequence).padStart(4,'0')}:{}),...headers},
    ...(payload!==undefined?{body:JSON.stringify(payload)}:{}),...rest}),env);
  const edit=(payload,extra={})=>({catalogRevision:'accepted',expectedRevision:0,reason:'Owner reviewed exact change',payload,...extra});
  return{sql,db,env,worker,call,edit,snapshot,edition,store:createContentRequestStore(db),counts:()=>({writes,reads}),loseAck(){loseAck=true;}};
}

test('staff auth verifies signed audience/issuer/time and exact staff identity, not email/header assertions',async()=>{
  const request=jwt=>new Request('https://stupid.gifts/api/content-admin/status',{headers:{'Cf-Access-Jwt-Assertion':jwt}});
  assert.equal(await contentAdminActor(request(await token()),config,NOW,localKeys),'staff-fixture');
  for(const jwt of [await token({email:'outsider@example.invalid'}),await token({type:'service'}),await token({},(await generateKeyPair('RS256')).privateKey),'not.a.jwt'])
    assert.equal(await contentAdminActor(request(jwt),config,NOW,localKeys),null);
  assert.equal(await contentAdminActor(request(await token()),{...config,CONTENT_ADMIN_AUD:'e'.repeat(64)},NOW,localKeys),null);
  assert.equal(await contentAdminActor(request(await token()),config,NOW+7200_000,localKeys),null);
  assert.equal(await contentAdminActor(request(await token()),{...config,CONTENT_ADMIN_ENABLED:undefined},NOW,localKeys),null);
});
test('disabled/unauthorized/forged headers and CSRF cannot access storage or mutate; old admin stays retired',async t=>{
  const f=await fixture(t);
  for(const headers of [{},{'Cf-Access-Authenticated-User-Email':'staff@example.invalid'}])assert.equal((await f.call('/status',{auth:null,headers})).status,403);
  assert.deepEqual(f.counts(),{writes:0,reads:0});
  for(const headers of [{Origin:'https://evil.invalid'},{Origin:'null'},{Origin:''},{'Sec-Fetch-Site':'cross-site'}])
    assert.equal((await f.call('/products/public-1',{method:'PUT',payload:f.edit({title:'New factual title'}),headers})).status,403);
  assert.equal(f.counts().writes,0);
  f.env.CONTENT_ADMIN_ENABLED=undefined;assert.equal((await f.call('/status')).status,404);
  assert.equal((await f.worker.fetch(new Request('https://stupid.gifts/api/admin'),f.env)).status,404);
});
test('private status distinguishes already serving from bookkeeping pending and does not claim R2 acceptance',async t=>{
  const f=await fixture(t),res=await f.call('/status'),state=await res.json();
  assert.equal(res.status,200);assert.equal(res.headers.get('Cache-Control'),'private, no-store');assert.equal(res.headers.get('X-Robots-Tag'),'noindex, nofollow');
  assert.equal(state.publicationState,'live_awaiting_bookkeeping');assert.equal(state.serving.release_id,'live-code');
  assert.equal(state.hostedSuccessor,'not_observed');assert.equal(state.canStartAnotherPublisher,false);assert.equal(state.applicationEnabled,false);
  assert.equal(f.counts().writes,0);
});
test('signed-in Access return navigation can read status; cross-site fetches and writes stay denied',async t=>{
  const f=await fixture(t),navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
  const response=await f.call('/status',{headers:navigation});assert.equal(response.status,200);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);assert.equal(f.counts().writes,0);
  assert.equal((await f.call('/status',{auth:null,headers:navigation})).status,403);
  assert.equal((await f.call('/status',{headers:{...navigation,'Sec-Fetch-Mode':'cors','Sec-Fetch-Dest':'empty'}})).status,403);
  assert.equal((await f.call('/products/public-1',{method:'PUT',payload:f.edit({title:'New title'}),headers:navigation})).status,403);
  assert.equal(f.counts().writes,0);
});
test('admin published preview uses the same permanent fallback, not expired supplier copy',async t=>{
  const f=await fixture(t),product=f.snapshot.products[0],base=structuredClone(product);
  product.persistent=base;product.title='EXPIRED SUPPLIER TITLE';product.description='EXPIRED SUPPLIER COPY';
  product.eligibleUntil=new Date(NOW-1).toISOString();
  const result=await(await f.call('/products/public-1')).json();assert.equal(result.published.title,base.title);
  assert.doesNotMatch(JSON.stringify(result),/EXPIRED SUPPLIER/);assert.equal(f.counts().writes,0);
});
test('exact-ASIN requests dedup ALL identities and idempotently save without starting a provider job',async t=>{
  const f=await fixture(t),key={'Idempotency-Key':'same-admission-request'},payload=f.edit({asin:'B000000777'});
  for(const asin of ['B000000001','B000000099'])assert.equal((await f.call('/admissions',{method:'POST',payload:f.edit({asin})})).status,409);
  const a=await f.call('/admissions',{method:'POST',payload,headers:key}),b=await f.call('/admissions',{method:'POST',payload,headers:key});
  assert.equal(a.status,202);assert.equal(b.status,202);const saved=await b.json();assert.equal(saved.replayed,true);
  assert.equal(saved.request.state,'awaiting_application');assert.equal(saved.publication,'queued_for_existing_coordinator');assert.equal(f.counts().writes,1);
  assert.equal((await f.call('/admissions',{method:'POST',payload:f.edit({asin:'B000000778'}),headers:key})).status,409);
  assert.equal((await f.call('/admissions',{method:'POST',payload})).status,409,'Different key cannot queue the same ASIN twice at revision zero');
});
test('canonical copy/visibility are versioned drafts, preserve identity and reject malformed/stale updates',async t=>{
  const f=await fixture(t),before=f.sql.prepare('SELECT * FROM products ORDER BY id').all();
  const edit=f.edit({title:'Complete untruncated book title',description:'One factual short description.',visibility:'unlisted'});
  assert.equal((await f.call('/products/public-1',{method:'PUT',payload:edit})).status,202);
  const current=await(await f.call('/products/public-1')).json();assert.equal(current.published.title,'Complete gift 1');assert.equal(current.request.revision,1);
  assert.equal(current.request.payload.title,edit.payload.title);assert.equal(current.request.reason,edit.reason);
  assert.equal((await f.call('/products/public-1',{method:'PUT',payload:edit})).status,409);
  for(const payload of [{title:'Truncated ...'},{description:'<script>oops</script>'},{price:1},{affiliateUrl:'https://evil.invalid'},{visibility:'deleted'}])
    assert.equal((await f.call('/products/public-1',{method:'PUT',payload:f.edit(payload,{expectedRevision:1})})).status,400);
  assert.equal((await f.call('/products/public-1',{method:'PUT',payload:f.edit({title:'Valid title'},{catalogRevision:'old'})})).status,409);
  assert.deepEqual(f.sql.prepare('SELECT * FROM products ORDER BY id').all(),before);assert.equal(f.counts().writes,2,'Stale CAS attempts are harmless conditional INSERTs');
});
test('enabled runtime adapter applies authenticated factual edits and reports the real application',async t=>{
  const f=await fixture(t),applied=[];
  const handler=createContentAdminHandler({snapshot:f.snapshot,manifest:{merchandising:{}},showCollections:{},activeShow:'matan',now:()=>NOW,
    applyCollection:async request=>{applied.push(request);return{state:'applied',revision:request.revision};}});
  const response=await handler(new Request('https://stupid.gifts/api/content-admin/products/public-1',{method:'PUT',headers:{
    'Cf-Access-Jwt-Assertion':await token(),Origin:'https://stupid.gifts','Content-Type':'application/json','Idempotency-Key':'live-adapter-fixture'},
    body:JSON.stringify(f.edit({title:'Reviewed factual handset',description:'A wired handset.'}))}),f.env);
  assert.equal(response.status,200);assert.equal((await response.json()).application.state,'applied');
  assert.equal(applied[0].actor,'staff-fixture');assert.equal(applied[0].action,'product');
  assert.equal(f.sql.prepare('SELECT public_id FROM products WHERE id=?').get('B000000001').public_id,'public-1');
});
test('home and show collections save/order/activate/restore without changing live cards or invoking ingestion',async t=>{
  const f=await fixture(t),ids=['public-2','public-1'];
  const save=await f.call('/collections/billy-ray',{method:'PUT',payload:f.edit({ids})});assert.equal(save.status,202);
  assert.equal((await f.call('/collections/billy-ray',{method:'PUT',payload:f.edit({ids:[...ids].reverse()},{expectedRevision:1})})).status,202);
  assert.equal((await f.call('/collections/billy-ray/restore',{method:'POST',payload:f.edit({revision:1},{expectedRevision:2})})).status,202);
  const restored=await(await f.call('/collections/billy-ray')).json();assert.deepEqual(restored.request.payload,{ids});assert.equal(restored.request.revision,3);
  assert.equal((await f.call('/active-show',{method:'PUT',payload:f.edit({name:'billy-ray'})})).status,202);
  assert.equal((await f.call('/collections/homepage',{method:'PUT',payload:f.edit({edition:f.edition})})).status,202);
  for(const list of [['public-1','public-1'],['held-99'],['missing']])assert.equal((await f.call('/collections/new',{method:'PUT',payload:f.edit({ids:list})})).status,list[0]==='public-1'?400:409);
  assert.equal((await f.call('/campaigns')).status,200);assert.equal((await(await f.call('/campaigns')).json()).manualActions,null);
});
test('lost INSERT acknowledgement settles by exact readback; history is append-only',async t=>{
  const f=await fixture(t),input={requestId:'lost-ack-request-1',resource:'/products/public-1',expectedRevision:0,actor:'staff-fixture',reason:'Correction',
    baseCatalogRevision:'accepted',action:'product',payload:{title:'Complete name'}};
  f.loseAck();const saved=await f.store.save(input,new Date(NOW).toISOString());assert.equal(saved.request.revision,1);
  assert.equal((await f.store.save(input,new Date(NOW+1000).toISOString())).replayed,true);assert.equal(f.counts().writes,1);
  assert.throws(()=>f.sql.exec('DELETE FROM content_admin_requests'),/retained/);assert.throws(()=>f.sql.exec("UPDATE content_admin_requests SET reason='changed'"),/append-only/);
});
test('homepage accepts existing merchant IDs but cannot duplicate a product through aliases',async t=>{
  const f=await fixture(t),edition={...f.edition,anchors:f.snapshot.products.slice(0,6).map(p=>p.id)};
  assert.equal((await f.call('/collections/homepage',{method:'PUT',payload:f.edit({edition})})).status,202);
  edition.rotation=[f.snapshot.products[0].publicId,...edition.rotation.slice(1)];
  assert.equal((await f.call('/collections/homepage',{method:'PUT',payload:f.edit({edition},{expectedRevision:1})})).status,400);
});
test('concurrent revisions have one winner and exact concurrent retries create one retained record',async t=>{
  const f=await fixture(t),base={resource:'/products/public-1',expectedRevision:0,actor:'staff-fixture',reason:'Correction',
    baseCatalogRevision:'accepted',action:'product',payload:{title:'Complete name'}};
  const results=await Promise.allSettled(['concurrent-request-a','concurrent-request-b'].map(requestId=>f.store.save({...base,requestId},new Date(NOW).toISOString())));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.message,'revision_conflict');
  const input={...base,resource:'/products/public-2',requestId:'concurrent-same-request'};
  const same=await Promise.all([f.store.save(input,new Date(NOW).toISOString()),f.store.save(input,new Date(NOW).toISOString())]);
  assert.equal(same[0].request.requestId,same[1].request.requestId);assert.equal(f.sql.prepare('SELECT count(*) n FROM content_admin_requests').get().n,2);
});
test('exact saved collection retry survives later catalog/eligibility changes without rewriting history',async t=>{
  const f=await fixture(t),payload=f.edit({ids:['public-1','public-2']}),headers={'Idempotency-Key':'collection-stable-retry'};
  assert.equal((await f.call('/collections/saved',{method:'PUT',payload,headers})).status,202);
  f.snapshot.products.splice(0,2);f.snapshot.catalogRevision='next';
  const replay=await f.call('/collections/saved',{method:'PUT',payload,headers});assert.equal(replay.status,202);
  assert.equal((await replay.json()).replayed,true);assert.equal(f.counts().writes,1);
});
test('invalid bodies, oversized/chunked input, methods, encoded paths and aliases cannot save requests',async t=>{
  const f=await fixture(t),edit=f.edit({title:'Complete title'});
  for(const [path,options,status]of [
    ['/products/public-1',{method:'PUT',payload:{...edit,extra:true}},400],
    ['/products/public-1',{method:'PUT',payload:edit,headers:{'Idempotency-Key':''}},400],
    ['/products/public-1',{method:'PUT',payload:edit,headers:{'Content-Type':'text/plain'}},415],
    ['/products/public-1',{method:'PUT',payload:edit,body:'{'},400],
    ['/products/public-1',{method:'PUT',payload:edit,body:' '.repeat(20001)},413],
    ['/products/public-1',{method:'DELETE'},405],
    ['/products/%70ublic-1',{method:'PUT',payload:edit},404],
    ['/missing',{method:'PUT',payload:edit},400],
  ])assert.equal((await f.call(path,options)).status,status,path);
  const alias=await f.worker.fetch(new Request('https://www.stupid.gifts/api/content-admin/status'),f.env);assert.equal(alias.status,404);
  assert.equal(f.counts().writes,0);
});
