import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {exportRuntimeCatalog} from '../scripts/catalog/export-runtime-catalog.ts';
import {runtimeDigest,runtimeOverlayKey} from '../lib/catalog/runtime-catalog.ts';
import {createRuntimeCatalogReader} from '../workers/site/runtime-data.ts';
import {createContentRequestStore} from '../lib/catalog/content-admin.ts';
import {applyRuntimeCollection} from '../lib/catalog/runtime-collections.ts';

const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,source='a'.repeat(40);
const product=n=>({id:'B'+String(n).padStart(9,'0'),publicId:uuid(n),slug:'desk-goose-'+n,title:'Magnetic desk goose '+n,
  description:'A goose that holds paperclips.',source:'amazon',currency:'USD',price:0,isActive:true,qualityScore:1,indexable:false,
  eligibleUntil:null,imageUrl:'/images/gift-placeholder.svg',affiliateUrl:'https://www.amazon.com/dp/B'+String(n).padStart(9,'0')+'?tag=goose-gifts-37-20'});
async function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec('CREATE TABLE publication_receipts(release_id TEXT PRIMARY KEY);CREATE TABLE catalog_build_requests(request_id TEXT PRIMARY KEY);');
  for(const name of ['0018_content_admin_requests.sql','0019_runtime_catalog.sql'])sql.exec(await readFile(new URL('../migrations/d1/'+name,import.meta.url),'utf8'));
  let lost=false;
  const db={prepare(query){let params=[];return{bind(...p){params=p;return this;},async all(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},async run(){return sql.prepare(query).run(...params);}};},
    async batch(statements){sql.exec('BEGIN');try{for(const statement of statements)await statement.run();sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}
      if(lost){lost=false;throw Error('synthetic lost batch ACK');}}};
  const objects=new Map(),events=[],time={now:Date.now()};
  const store={async get(key){return objects.has(key)?{bytes:objects.get(key),etag:'"fixture"'}:null;},async putImmutable(key,bytes){events.push(['put',key]);const old=objects.get(key);
    if(old)assert.deepEqual(old,bytes);else objects.set(key,new Uint8Array(bytes));return{bytes,etag:'"fixture"'};}};
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:'test-public',generatedAt:new Date(time.now-1000).toISOString(),products:[product(1),product(2)],heldProducts:[],slugHistory:[]};
  const publish=async sourceSnapshot=>{
    const result=await exportRuntimeCatalog({snapshot:sourceSnapshot,releaseId:'accepted-test',sourceCodeSha:source,store,registerFinite:async ref=>events.push(['register',ref.key])});
    sql.exec("DELETE FROM catalog_runtime_head;INSERT OR IGNORE INTO publication_receipts VALUES('accepted-test');");
    // A test creates a fresh data fixture, not a mutation of immutable receipts.
    if(!sql.prepare('SELECT 1 FROM catalog_runtime_publications').get())sql.prepare('INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,owner_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('accepted-test',sourceSnapshot.catalogRevision,result.dataSha256,result.sourceSnapshotSha256,result.publicSnapshotSha256,'{}',new Date(time.now).toISOString());
    sql.prepare('INSERT INTO catalog_runtime_head(singleton,release_id,version,enabled) VALUES(1,?,1,1)').run('accepted-test');return result;
  };
  const env={RUNTIME_CATALOG_ENABLED:'true',DB:db,CATALOG_DATA:{async get(key){const bytes=objects.get(key.replace(/^catalog-v1\//,''));return bytes?{async arrayBuffer(){return new Uint8Array(bytes).buffer;}}:null;}}};
  return{sql,db,store,objects,events,time,snapshot,publish,env,loseAck(){lost=true;}};
}
test('finite DTOs register original retention BEFORE upload and remain outside permanent base; missing/expired overlays use cleared data',async t=>{
  const f=await fixture(t),finite={...product(1),description:'A finite supplier observation.',imageUrl:'https://m.media-amazon.com/images/I/fixture.jpg',eligibleUntil:new Date(f.time.now+20000).toISOString(),persistent:product(1)};
  f.snapshot.products[0]=finite;const exported=await f.publish(f.snapshot),ref=exported.data.overlays[0],key=runtimeOverlayKey(ref).slice(11),body=f.objects.get(key);
  assert.equal(exported.data.snapshot.products[0].description,product(1).description);
  assert.ok(!JSON.stringify(exported.data.snapshot).includes('finite supplier'));
  assert.ok(f.events.findIndex(e=>e[0]==='register'&&e[1]===key)<f.events.findIndex(e=>e[0]==='put'&&e[1]===key));
  f.objects.delete(key);const read=createRuntimeCatalogReader(()=>f.time.now);
  assert.equal((await read(f.env)).data.snapshot.products[0].description,product(1).description);
  f.objects.set(key,body);f.time.now+=5001;
  assert.equal((await read(f.env)).data.snapshot.products[0].description,finite.description,'A failed optional read is retried without a new data release');
  f.time.now+=20000;const before=f.env.DB;f.env.DB={...before,prepare(){throw Error('synthetic outage');}};
  // Keep the same binding identity; scope changes must never inherit a cache.
  f.env.DB=before;const original=before.prepare;before.prepare=()=>{throw Error('synthetic outage');};
  assert.equal((await read(f.env)).data.snapshot.products[0].description,product(1).description);
  before.prepare=original;
});
test('malformed overlay is atomic per group and hash/identity-bound; missing local images fail before transport',async t=>{
  const f=await fixture(t);f.snapshot.products[0]={...product(1),eligibleUntil:new Date(f.time.now+20000).toISOString(),persistent:product(1)};
  const result=await f.publish(f.snapshot),ref=result.data.overlays[0],key=runtimeOverlayKey(ref).slice(11);
  f.objects.set(key,new TextEncoder().encode('corrupt'));
  assert.equal((await createRuntimeCatalogReader(()=>f.time.now)(f.env)).data.snapshot.products[0].eligibleUntil,null);
  const bad=structuredClone(f.snapshot);bad.products[1].imageUrl='/images/not-exported.jpg';
  await assert.rejects(exportRuntimeCatalog({snapshot:bad,releaseId:'bad',sourceCodeSha:source,store:f.store}),/runtime_local_image_not_bound/);
  assert.equal(await runtimeDigest(f.objects.get('public-catalog/'+result.dataSha256+'.json')),result.dataSha256);
});
test('shared collections apply atomically, retain audit/history, recover a lost ACK and reject stale manual/daily races',async t=>{
  const f=await fixture(t);await f.publish(f.snapshot);const requests=createContentRequestStore(f.db);
  const input={requestId:'manual-collection-fixture-001',resource:'/collections/matan',action:'collection',actor:'staff-fixture',reason:'Reviewed lineup',
    baseCatalogRevision:f.snapshot.catalogRevision,expectedRevision:0,payload:{ids:[uuid(2),uuid(1)]}};
  const saved=await requests.save(input,new Date(f.time.now).toISOString());f.loseAck();
  assert.equal((await applyRuntimeCollection(f.db,saved.request)).state,'applied');
  assert.equal(f.sql.prepare('SELECT version FROM catalog_runtime_head').get().version,2);
  await applyRuntimeCollection(f.db,saved.request);assert.equal(f.sql.prepare('SELECT version FROM catalog_runtime_head').get().version,2);
  const stale=await requests.save({...input,requestId:'manual-collection-fixture-002',expectedRevision:1,payload:{ids:[uuid(1)]}},new Date(f.time.now).toISOString());
  const latest=await requests.save({...input,requestId:'manual-collection-fixture-003',expectedRevision:2,payload:{ids:[uuid(2)]}},new Date(f.time.now).toISOString());
  await assert.rejects(applyRuntimeCollection(f.db,stale.request),/revision_conflict/);
  await applyRuntimeCollection(f.db,latest.request);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM content_admin_requests').get().n,3);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_runtime_collections').get().n,2);
  const read=await createRuntimeCatalogReader(()=>f.time.now)(f.env);assert.deepEqual(read.collections['/collections/matan'].payload.ids,[uuid(2)]);
  assert.throws(()=>f.sql.prepare("UPDATE catalog_runtime_collections SET payload_json='{}'").run(),/immutable/);
});
