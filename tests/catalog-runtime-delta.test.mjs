import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,mkdtemp,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assembleRuntimeCatalogDelta} from '../scripts/catalog/runtime-catalog-delta.ts';
import {stageOwnedPublicProjection} from '../scripts/catalog/stage-public-projection.ts';
import {createProjectionPacket,projectionQueries} from '../lib/catalog/d1.ts';
import {claimMutationOwnership,readMutationOwner} from '../lib/catalog/mutation-fence.ts';
import {canonicalJson} from '../scripts/catalog/migration.ts';
import {sha256} from '../scripts/catalog/migration.ts';
import {createD1CatalogMaintenanceStore} from '../scripts/catalog/maintenance-d1.ts';
import {editorialSourceHash} from '../scripts/ops/catalog-editorial-core.mjs';
import {readReviewedRuntimeDelta,runtimeDeltaSourceFence} from '../scripts/catalog/runtime-delta-source.ts';
import {exportRuntimeCatalog} from '../scripts/catalog/export-runtime-catalog.ts';
import {prepareRuntimeDeltaPublication,commitPreparedRuntimeDelta} from '../scripts/catalog/runtime-delta-publication.ts';
import {encodePublicationIntent} from '../lib/catalog/publication.ts';
import {createRuntimeCatalogReader} from '../workers/site/runtime-data.ts';
import {commitRuntimePublication} from '../scripts/catalog/commit-runtime-publication.ts';
import {canonicalDescriptionEmbeddingInput} from '../lib/catalog/presentation.ts';
import {derivedFixture} from './helpers/derived-search-fixture.mjs';
import {drainRuntimeIndexEvents,runtimeIndexDescriptor} from '../scripts/catalog/runtime-index-events.ts';
import {accountedPublicationFetch} from '../scripts/catalog/publication-read-fetch.ts';
import {createDerivedSemanticSearch} from '../workers/site/derived-search.ts';
import {openRunWorkspace} from '../scripts/catalog/run-workspace.ts';
import {runtimeDeltaSealBytes} from '../scripts/catalog/runtime-delta-seal.ts';
import {readAcceptedRuntimeHandoff} from '../scripts/catalog/publish-runtime-catalog.ts';
import {encodeBuildRequest} from '../lib/catalog/build-requests.ts';

const at='2026-11-15T12:00:00.000Z',next='2026-11-15T13:00:00.000Z';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const product=n=>({id:'B'+String(n).padStart(9,'0'),publicId:uuid(n),slug:'gift-'+n,title:'Fixture gift '+n,
  description:'An exact factual gift description.',source:'amazon',currency:'USD',price:0,isActive:true,qualityScore:1,indexable:false,
  eligibleUntil:null,imageUrl:'/images/gift-placeholder.svg',affiliateUrl:'https://www.amazon.com/dp/B'+String(n).padStart(9,'0')+'?tag=goose-gifts-37-20'});
const snapshot=n=>({schemaVersion:1,dataKind:'catalog',catalogRevision:'accepted-previous',generatedAt:at,
  products:Array.from({length:n},(_,i)=>product(i+1)),heldProducts:[],slugHistory:[]});
const identity={catalogRevision:'point-next',generatedAt:next};
const publish=p=>({kind:'publish',id:p.id,publicId:p.publicId,slug:p.slug,product:p});
const held=(p,reason)=>({id:p.id,publicId:p.publicId,slug:p.slug,path:'/gifts/'+p.slug,title:'Gift currently unavailable',
  description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason});

test('a single addition inherits every accepted product/URL and never scans mutable private source',()=>{
  const previous=snapshot(3000),before=canonicalJson(previous),p={...product(3001),title:'Instant emergency disco underpants'};
  const {snapshot:updated}=assembleRuntimeCatalogDelta(previous,[publish(p)],identity);
  assert.equal(updated.products.length,3001);assert.deepEqual(updated.products.slice(0,3000),previous.products);
  assert.deepEqual(updated.products.at(-1),p);assert.equal(canonicalJson(previous),before);
  assert.deepEqual(updated.slugHistory,previous.slugHistory);
});
test('real stock changes preserve identity and explicit exclusions; expiry cannot delete or renew clearance',()=>{
  const previous=snapshot(3),expiry='2026-11-15T12:30:00.000Z';
  previous.products[0]={...product(1),eligibleUntil:expiry,imageUrl:'https://example.invalid/finite.jpg',persistent:product(1)};
  previous.products[1]={...product(2),eligibleUntil:expiry};
  previous.heldProducts=[held(product(4),'editorial_hold'),held(product(5),'unavailable')];
  const {snapshot:updated,deferred}=assembleRuntimeCatalogDelta(previous,[
    {...publish(product(4)),restoreUnavailable:true},publish(product(5)),
    {kind:'unavailable',id:product(3).id,publicId:uuid(3),slug:product(3).slug}],identity);
  assert.deepEqual(updated.products,[product(1)]);
  assert.equal(updated.heldProducts.find(p=>p.publicId===uuid(2)).reason,'expired');
  assert.equal(updated.heldProducts.find(p=>p.publicId===uuid(3)).reason,'unavailable');
  assert.deepEqual(deferred,[uuid(4),uuid(5)]);
  const restored=assembleRuntimeCatalogDelta(updated,[{...publish(product(5)),restoreUnavailable:true}],{...identity,catalogRevision:'restored-next'});
  assert.ok(restored.snapshot.products.some(p=>p.publicId===uuid(5)));
  assert.equal(updated.products[0].eligibleUntil,null);assert.equal(updated.products[0].imageUrl,product(1).imageUrl);
});
test('changed identity, duplicate changes, reused slugs and finite-only new listings refuse',()=>{
  const previous=snapshot(2),p=product(3);
  for(const changes of [[publish({...product(1),id:p.id})],[publish({...p,slug:product(1).slug})],
    [publish(p),publish(p)],[publish({...p,eligibleUntil:'2026-11-16T00:00:00.000Z'})]])
    assert.throws(()=>assembleRuntimeCatalogDelta(previous,changes,identity),/runtime_delta_/);
  assert.throws(()=>assembleRuntimeCatalogDelta(previous,[],{...identity,catalogRevision:previous.catalogRevision}),/runtime_delta_invalid/);
});

async function fixture(t,count=3000,transform=s=>s){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort())
    sql.exec(await readFile(new URL('../migrations/d1/'+name,import.meta.url),'utf8'));
  sql.function('strftime',{varargs:true},()=>next);
  const previous=transform(snapshot(count)),p=product(count+1),facts=Object.fromEntries([...previous.products,p].map(p=>[p.publicId,'a'.repeat(64)]));
  const old=await createProjectionPacket(previous,facts,'b'.repeat(64),new Date(at));
  const updated=assembleRuntimeCatalogDelta(previous,[publish(p)],identity).snapshot;
  const packet=await createProjectionPacket(updated,facts,'c'.repeat(64),new Date(next));
  const insert=sql.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,is_active,editorial_status,catalog_revision,rights_json,source_record_json,updated_at)
    VALUES(?,?,?,'amazon',?,'USD',1,'short_ready','private-source','{}',?,'2026-11-15T12:00:00.000Z')`);
  sql.exec('BEGIN');for(const item of [...previous.products,p])insert.run(item.id,item.publicId,item.slug,item.title,JSON.stringify({privateFixture:true}));
  for(const q of projectionQueries(old,9))sql.prepare(q.sql).run(...q.params);sql.exec('COMMIT');
  sql.exec("INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES('staging','fixture');");
  let queries=0,batches=0,copies=0,inserts=0,lose=false,loseCommit=false,failCommit=false,commits=0,corrupt=false,sourceReads=false;const reads=[];
  const db={prepare(query){let params=[];return{sql:query,get params(){return params;},bind(...p){params=p;return this;},async all(){queries++;
    reads.push(query);
    if(!sourceReads)assert.ok(!/\bFROM products\b|catalog_maintenance_products|catalog_vector_deliveries|vector_sync_outbox/.test(query),'Only public projection/control reads');
    return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},async run(){queries++;return sql.prepare(query).run(...params);}};},async batch(statements){
    batches++;sql.exec('BEGIN');let copied=false;
    try{for(const s of statements){let query=s.sql;
      if(query.startsWith('INSERT INTO publication_receipts'))commits++;
      if(query.includes('FROM catalog_public_products WHERE catalog_revision=? AND public_id IN')){copies++;copied=true;
        if(corrupt)query=query.replace('SELECT ?,public_id,product_id,slug,title,description,',"SELECT ?,public_id,product_id,slug,title,'tampered',");}
      else if(query.startsWith('INSERT INTO catalog_public_products'))inserts++;
      sql.prepare(query).run(...s.params);
      if(failCommit&&query.startsWith('INSERT INTO publication_receipts')){failCommit=false;throw Error('test_only_interrupted_commit');}
    }sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}
    if(lose&&copied){lose=false;throw Error('test_only_lost_copy_ack');}
    if(loseCommit&&statements.some(s=>s.sql.startsWith('INSERT INTO publication_receipts'))){loseCommit=false;throw Error('test_only_lost_commit_ack');}
  }};
  const owner=await claimMutationOwnership(db,{environment:'staging',indexName:'fixture'},{phase:'writing',ownerReference:'point-fixture',operationKey:'d'.repeat(64)});
  assert.ok(owner);
  const stats=()=>({queries,batches,copies,inserts,commits});queries=0;batches=0;
  return{sql,db,owner,packet,old,previous,stats,reads,allowSourceReads(){sourceReads=true;},lose(){lose=true;},loseCommit(){loseCommit=true;},failCommit(){failCommit=true;},corrupt(){corrupt=true;}};
}
test('3000 accepted public rows copy in SQL; only one added row transfers, with no receipt/head/index side effects',async t=>{
  const f=await fixture(t),before=await readMutationOwner(f.db,f.owner);
  const result=await stageOwnedPublicProjection({db:f.db,owner:f.owner,packet:f.packet,previousRevision:f.old.receipt.catalog_revision,previousRows:f.old.rows});
  assert.deepEqual(result,{copied:3000,inserted:1});assert.equal(f.stats().copies,1);assert.equal(f.stats().inserts,1);
  assert.equal(f.stats().batches,2);assert.ok(f.stats().queries<25);
  assert.deepEqual(await readMutationOwner(f.db,f.owner),before);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1,'Staging is not acceptance');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,0);
  t.diagnostic(JSON.stringify({fixturePublicProducts:3001,...f.stats(),privateOrIndexReads:0}));
});

async function sourceFixture(t,count=20,transform,embedding=false){
  const f=await fixture(t,count,transform);f.allowSourceReads();const n=count+79;
  const id=product(n).id,p={id,title:'Instant emergency underpants',source:'amazon',price:0,currency:'USD',
    wittyDescription:'A small compressed cloth package that expands into emergency underpants.',
    imageUrl:'/images/gift-placeholder.svg',affiliateUrl:product(n).affiliateUrl,sourceFacts:{material:'cloth'},
    availabilityStatus:'IN_STOCK',remotelyVerified:true,isActive:true,qualityScore:.7777777777777778,humorTags:[],
    editorialStatus:'short_ready',editorialQualityScore:.95};
  const factsHash=editorialSourceHash(p);p.editorialSourceHash=factsHash;
  if(embedding){p.embedding=Array.from({length:1536},(_,i)=>Math.fround((i%17-8)/100));p.embedding[0]=-0;}
  const rights=Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,affiliateUrl:p.affiliateUrl})
    .map(([field,value])=>[field,{basis:'owned',reference:'test-only-reviewed',value}]));
  const cursor={current:f.owner};
  const store=createD1CatalogMaintenanceStore({db:f.db,owner:f.owner,ownerCursor:cursor,runId:'point-source',catalogRevision:'staged-source',
    preservePermanentListings:true,newPublicId:()=>uuid(n),intent:()=>({rightsById:{[id]:{...rights,persistent:rights}},verificationById:{[id]:{
      reference:'test-only-observation',observedAt:at,sourceFactsHash:factsHash}},...(embedding?{embeddingById:{[id]:{
        reference:'objects/'+'e'.repeat(64)+'.json',model:'text-embedding-3-small',text:canonicalDescriptionEmbeddingInput(p),sourceFactsHash:factsHash}}}:{})})});
  await store.upsertProduct(p,factsHash);
  const row={...f.sql.prepare('SELECT * FROM products WHERE id=?').get(id)},op={...f.sql.prepare('SELECT * FROM catalog_maintenance_operations ORDER BY next_epoch DESC LIMIT 1').get()};
  const approval={schemaVersion:1,runId:'point-source',catalogRevision:'staged-source',changes:[{
    publicId:uuid(n),operationId:op.operation_id,inputSha256:op.input_sha256,productSha256:sha256(canonicalJson(row)),displaySha256:sha256(row.public_display_json)}]};
  const args={db:f.db,owner:cursor.current,approval,approvalSha256:sha256(canonicalJson(approval)),previous:f.previous,now:new Date(next)};
  return{...f,args,row};
}
test('short publication checks the exact normal maintenance receipt/rights/copy, and final source CAS catches any later change',async t=>{
  const f=await sourceFixture(t),before=f.reads.length,proof=await readReviewedRuntimeDelta(f.args);
  assert.equal(proof.changes.length,1);assert.equal(proof.changes[0].kind,'publish');assert.equal(proof.changes[0].id,product(99).id);
  assert.ok(f.reads.slice(before).every(sql=>!sql.includes('embedding_native_base64')&&!sql.includes('catalog_vector_deliveries')));
  const gate=runtimeDeltaSourceFence(proof.sourceVersion),check=()=>f.db.prepare(`SELECT json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'source_changed' END)`).bind(...gate.params).all();
  await check();
  f.sql.prepare("UPDATE products SET title='Unrelated private update' WHERE id=?").run(product(1).id);
  await assert.rejects(check(),/malformed JSON/,'The SQL assertion fails after any source write');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,0);
});

async function publicationFixture(t,count=20,transform,embedding=false){
  const f=await sourceFixture(t,count,transform,embedding),objects=new Map();
  const store={async get(key){return objects.has(key)?{bytes:objects.get(key),etag:'"fixture"'}:null;},async putImmutable(key,value){
    const old=objects.get(key);if(old)assert.deepEqual(old,value);else objects.set(key,new Uint8Array(value));return{bytes:value,etag:'"fixture"'};}};
  const exported=await exportRuntimeCatalog({snapshot:f.args.previous,releaseId:'previous-live',sourceCodeSha:'a'.repeat(40),store,
    ...(embedding?{semanticCatalog:(await derivedFixture()).catalog}:{}),
    now:()=>Date.parse(next),registerFinite:async()=>{}});
  const receipt={release_id:'previous-live',catalog_revision:f.args.previous.catalogRevision,code_sha:'a'.repeat(40),completed_at:at,
    manifest_json:encodePublicationIntent({releaseId:'previous-live',catalogRevision:f.args.previous.catalogRevision,codeSha:'a'.repeat(40),
      catalogSnapshotSha256:exported.sourceSnapshotSha256,manifestSha256:exported.dataSha256,vectorSyncWatermark:0,priorReleaseId:null,nextExpiry:null})};
  f.sql.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,'published')")
    .run(receipt.catalog_revision,at,f.old.receipt.source_export_sha256);
  f.sql.prepare('INSERT INTO publication_receipts(release_id,catalog_revision,code_sha,completed_at,manifest_json) VALUES(?,?,?,?,?)')
    .run(receipt.release_id,receipt.catalog_revision,receipt.code_sha,receipt.completed_at,receipt.manifest_json);
  f.sql.prepare(`INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,owner_json,created_at)
    VALUES(?,?,?,?,?,'{}',?)`).run(receipt.release_id,receipt.catalog_revision,exported.dataSha256,exported.sourceSnapshotSha256,exported.publicSnapshotSha256,at);
  f.sql.prepare('INSERT INTO catalog_runtime_head VALUES(1,?,1,1)').run(receipt.release_id);
  const history=Buffer.from(canonicalJson({kind:'fixture-original-native-history'})),nativeHistorySha256=sha256(history);
  await store.putImmutable('catalog-history/'+nativeHistorySha256+'.json',history);
  const input={...f.args,store,previous:{releaseId:receipt.release_id,dataSha256:exported.dataSha256,receiptSha256:sha256(canonicalJson(receipt))},
    releaseId:'delta-live',codeSha:'b'.repeat(40),runReference:'point-source',nativeHistorySha256};
  return{...f,store,objects,input};
}
test('COMPOSED 3000 accepted gifts plus one real maintenance addition: short commit, working public reader, lost ACK and body-free replay',async t=>{
  const f=await publicationFixture(t,3000),before=f.reads.length;
  const staged=await prepareRuntimeDeltaPublication(f.input);
  assert.equal(staged.products,3001);assert.equal(staged.changes,1);
  assert.equal(f.sql.prepare('SELECT release_id FROM catalog_runtime_head').get().release_id,'previous-live','Staging never publishes');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1);
  f.loseCommit();const accepted=await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256});
  assert.equal(accepted.seal.kind,'runtime-delta-seal');assert.equal(accepted.seal.indexDelivery,'asynchronous');
  assert.equal(accepted.seal.nativeHistorySha256,f.input.nativeHistorySha256);
  assert.equal(await readMutationOwner(f.db,f.input.owner),null);
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'resolved');
  const view=await createRuntimeCatalogReader(()=>Date.parse(next))({RUNTIME_CATALOG_ENABLED:'true',DB:f.db,CATALOG_DATA:{async get(key){
    const value=f.objects.get(key.replace(/^catalog-v1\//,''));return value?{async arrayBuffer(){return new Uint8Array(value).buffer;}}:null;}}});
  assert.equal(view.data.snapshot.products.length,3001);assert.equal(view.data.snapshot.products.at(-1).title,'Instant emergency underpants');
  assert.ok(view.data.snapshot.products.at(-1).affiliateUrl.endsWith('?tag=goose-gifts-37-20'));
  const count=f.stats().commits,reads=f.reads.length;
  // Expired/missing source bodies cannot break recovery after genuine acceptance.
  f.sql.prepare('DELETE FROM catalog_maintenance_products WHERE product_id=?').run(f.row.id);
  assert.deepEqual(await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256}),accepted);
  assert.equal(f.stats().commits,count);
  assert.ok(f.reads.slice(reads).every(q=>!q.includes('FROM products')&&!q.includes('catalog_maintenance')&&!q.includes('vector_')));
  assert.ok(f.reads.slice(before).every(q=>!q.includes('catalog_vector_deliveries')&&!q.includes('embedding_native_base64')));
  t.diagnostic(JSON.stringify({fixturePublicProducts:3001,...f.stats(),supplierCalls:0,modelCalls:0,privateInventoryScans:0,nativeReads:0}));
});
test('short commit fences source or predecessor drift and commits neither a receipt nor partial head',async t=>{
  for(const drift of ['source','head']){
    const f=await publicationFixture(t),staged=await prepareRuntimeDeltaPublication(f.input);
    if(drift==='source')f.sql.prepare("UPDATE products SET title='Later changed source' WHERE id=?").run(f.row.id);
    else{
      f.sql.exec(`INSERT INTO publication_receipts SELECT 'another-live',catalog_revision,code_sha,completed_at,manifest_json FROM publication_receipts;
        INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,owner_json,created_at)
        SELECT 'another-live',catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,owner_json,created_at FROM catalog_runtime_publications;
        UPDATE catalog_runtime_head SET release_id='another-live',version=version+1`);
    }
    await assert.rejects(commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256}),/malformed JSON/);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='delta-live'").get().n,0);
    assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1);
    assert.ok(await readMutationOwner(f.db,f.input.owner));
  }
});
test('short publication preserves accepted finite photos and holds at their ORIGINAL deadline; unreadable accepted bytes cannot silently remove photos',async t=>{
  const expiry='2026-11-15T14:00:00.000Z',f=await publicationFixture(t,20,s=>({...s,
    products:s.products.map((p,i)=>i? p:{...p,imageUrl:'https://m.media-amazon.com/images/I/accepted-photo.jpg',eligibleUntil:expiry,persistent:p}),
    heldProducts:[held(product(50),'editorial_hold')]}));
  const key=[...f.objects.keys()].find(k=>k.startsWith('public-overlays/')),saved=f.objects.get(key);f.objects.delete(key);
  await assert.rejects(prepareRuntimeDeltaPublication(f.input),/runtime_delta_object_changed/);
  assert.equal(f.sql.prepare('SELECT release_id FROM catalog_runtime_head').get().release_id,'previous-live');
  f.objects.set(key,saved);const staged=await prepareRuntimeDeltaPublication(f.input);
  const result=await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256});
  const data=JSON.parse(Buffer.from(f.objects.get('public-catalog/'+result.seal.dataSha256+'.json')));
  assert.equal(data.overlays[0].expiresAt,expiry);assert.equal(data.snapshot.heldProducts[0].reason,'editorial_hold');
  const reader=createRuntimeCatalogReader(()=>clock),env={RUNTIME_CATALOG_ENABLED:'true',DB:f.db,CATALOG_DATA:{async get(key){
    const value=f.objects.get(key.replace(/^catalog-v1\//,''));return value?{async arrayBuffer(){return new Uint8Array(value).buffer;}}:null;}}};
  let clock=Date.parse(next),view=await reader(env);
  assert.equal(view.data.snapshot.products[0].imageUrl,'https://m.media-amazon.com/images/I/accepted-photo.jpg');
  clock=Date.parse(expiry)+1;view=await reader(env);assert.equal(view.data.snapshot.products[0].imageUrl,product(1).imageUrl);
});
test('interrupted atomic commit rolls back completely and retries the SAME saved handoff, without repeating staging or source work',async t=>{
  const f=await publicationFixture(t),staged=await prepareRuntimeDeltaPublication(f.input),copies=f.stats().copies;
  f.failCommit();await assert.rejects(commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256}),/interrupted_commit/);
  assert.equal(f.sql.prepare('SELECT release_id FROM catalog_runtime_head').get().release_id,'previous-live');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,1);
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'pending');
  assert.deepEqual(await readMutationOwner(f.db,f.input.owner),f.input.owner);
  const start=f.reads.length;
  await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256});
  assert.equal(f.stats().copies,copies);
  assert.ok(f.reads.slice(start).every(q=>!q.includes('FROM products')&&!q.includes('catalog_maintenance')&&!q.includes('vector_')));
});
test('the shared atomic commit retains the legacy freezing-owner fence',async t=>{
  const f=await publicationFixture(t),staged=await prepareRuntimeDeltaPublication(f.input);
  const handoff=JSON.parse(Buffer.from(f.objects.get('runtime-handoffs/'+staged.handoffSha256+'.json')));
  f.sql.prepare("UPDATE catalog_mutation_scopes SET phase='freezing'").run();
  const owner={...f.input.owner,phase:'freezing'},r=handoff.seal.projectionReceipt;
  const receipt=await commitRuntimePublication(f.db,{...handoff.commit,owner,handoffSha256:staged.handoffSha256},runtimeDeltaSourceFence(handoff.sourceVersion),[
    f.db.prepare(`INSERT INTO catalog_projection_receipts(catalog_revision,snapshot_sha256,projection_sha256,source_export_sha256,product_count,created_at)
      VALUES(?,?,?,?,?,?)`).bind(r.catalog_revision,r.snapshot_sha256,r.projection_sha256,r.source_export_sha256,r.product_count,r.created_at)]);
  assert.equal(receipt.release_id,'delta-live');assert.equal(await readMutationOwner(f.db,owner),null);
});
test('COMPOSED acceptance registers existing immutable embeddings; post-publication delivery survives a lost ACK without a second native write or a catalog owner',async t=>{
  const f=await publicationFixture(t,20,undefined,true),stored=new Map(),calls=[],settlements=[],writes=[],nativeIndexName='fixture-native',servingIndexName='synthetic-derived-index';
  const originalNative={historical:true};stored.set(nativeIndexName+':'+uuid(1),originalNative);
  let lost=false;
  const vectorJson=v=>`{"id":${JSON.stringify(v.id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':JSON.stringify(n)).join(',')}],"metadata":${JSON.stringify(v.metadata)}}`;
  const send=accountedPublicationFetch({async reserveBudget(){},async settleBudget(id,value){settlements.push(value);}},async(url,init)=>{
    const match=new URL(url).pathname.match(/\/indexes\/([^/]+)\/(get_by_ids|upsert)$/);assert.ok(match);const [,index,action]=match;
    calls.push({index,action});const body=JSON.parse(init.body);
    if(action==='get_by_ids'){const rows=body.ids.flatMap(id=>stored.has(index+':'+id)?[stored.get(index+':'+id)]:[]);
      return new Response('{"success":true,"result":['+rows.map(vectorJson).join(',')+']}');}
    assert.match(body.id,/^[a-f0-9]{64}$/);stored.set(index+':'+body.id,body);writes.push({index,id:body.id});
    if(index===nativeIndexName&&!lost){lost=true;throw Error('test-only-lost-native-ACK');}
    return new Response(JSON.stringify({success:true,result:{mutationId:'11111111-1111-4111-8111-111111111111'}}));
  },{accountId:'a'.repeat(32),databaseId:uuid(1),workerName:'fixture-worker',indexName:nativeIndexName,derivedIndexName:servingIndexName,
    immutableNative:true,identityOrigin:'https://fixture.invalid'});
  const input={db:f.db,store:f.store,accountId:'a'.repeat(32),nativeIndexName,servingIndexName,token:'TEST_ONLY_TOKEN',fetch:send,now:()=>new Date(next)};
  assert.equal((await drainRuntimeIndexEvents(input)).outcomes.length,0);assert.equal(calls.length,0,'No index dispatch before acceptance');
  const staged=await prepareRuntimeDeltaPublication(f.input);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_runtime_index_events').get().n,0);
  await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256});
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_runtime_index_events').get().n,1);
  const before=f.sql.prepare('SELECT version FROM catalog_source_version').get().version;
  const start=f.reads.length;
  const first=await drainRuntimeIndexEvents(input);assert.equal(first.outcomes[0].state,'attention');
  assert.equal((await drainRuntimeIndexEvents(input)).outcomes[0].state,'pending');
  assert.equal((await drainRuntimeIndexEvents(input)).outcomes[0].state,'complete');
  assert.equal(writes.filter(w=>w.index===nativeIndexName).length,1,'Unknown immutable native upsert is reconciled by exact readback');
  assert.equal(writes.filter(w=>w.index===servingIndexName).length,1);assert.equal(settlements.filter(s=>s.status==='unknown').length,1);
  assert.equal(stored.get(nativeIndexName+':'+uuid(1)),originalNative,'Historical UUID native entry untouched');
  assert.equal(f.sql.prepare('SELECT version FROM catalog_source_version').get().version,before);
  assert.equal(await readMutationOwner(f.db,f.input.owner),null);
  assert.ok(f.reads.slice(start).every(q=>!q.includes('FROM products')&&!q.includes('catalog_maintenance_products')&&!q.includes('catalog_vector_deliveries')));
  const row=f.sql.prepare('SELECT * FROM catalog_runtime_index_events').get(),descriptor=JSON.parse(row.descriptor_json);
  assert.equal(JSON.parse(row.delivery_json).native.length,0,'No fabricated native mutation reference after the lost ACK');
  assert.equal(JSON.parse(row.delivery_json).serving.length,1);
  const data=JSON.parse(Buffer.from(f.objects.get('public-catalog/'+staged.seal.dataSha256+'.json')));
  const actual=stored.get(servingIndexName+':'+descriptor.serving.id),matches=await createDerivedSemanticSearch(data.snapshot,data.semanticCatalog)
    .resolve([{id:actual.id,score:.9,metadata:actual.metadata}]);
  assert.equal(matches[0].product.id,f.row.id,'Real resolver adopts the new current-field vector without seed edits or model calls');
  assert.equal(f.sql.prepare('SELECT status FROM vector_sync_outbox').get().status,'complete');
  const count=calls.length;assert.equal((await drainRuntimeIndexEvents(input)).outcomes.length,0);assert.equal(calls.length,count);
  assert.throws(()=>f.sql.prepare("UPDATE catalog_runtime_index_events SET descriptor_json='{}'").run(),/immutable/);
});
test('old saved text never masquerades as new public copy; native history stays append-only while keyword content remains valid',async t=>{
  const f=await publicationFixture(t,20,undefined,true),staged=await prepareRuntimeDeltaPublication(f.input);
  await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256});
  const payloadJson=f.sql.prepare('SELECT payload_json FROM catalog_maintenance_vector_payloads').get().payload_json;
  const payload=JSON.parse(payloadJson),data=JSON.parse(Buffer.from(f.objects.get('public-catalog/'+staged.seal.dataSha256+'.json')));
  const product=data.snapshot.products.find(p=>p.publicId===payload.publicId);product.description='A different correct description with no corresponding saved embedding.';
  const result=await runtimeIndexDescriptor({sequence:payload.sequence,releaseId:data.releaseId,payloadJson,data});
  assert.equal(result.reason,'copy_mismatch');assert.equal(result.serving,null);assert.ok(result.native);
  assert.ok(data.snapshot.products.includes(product));
});
test('flat delta successor survives a cold expired workspace, rejects cross-index/code changes, and permits ONLY its exact finalization owner',async t=>{
  const f=await publicationFixture(t),staged=await prepareRuntimeDeltaPublication(f.input);
  const accepted=await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256}),seal=accepted.seal;
  const directory=await mkdtemp(join(await realpath(tmpdir()),'stupid-delta-control-')),handles=[];
  t.after(async()=>{for(const w of handles.reverse())await w.close();await rm(directory,{recursive:true,force:true});});
  let clock=next;
  const configSha256='f'.repeat(64),options={directory:join(directory,'workspace'),repository:await realpath(new URL('..',import.meta.url).pathname),runId:seal.publication.releaseId,
    codeSha:f.input.codeSha,configSha256,scope:{...f.input.owner,accountId:'a'.repeat(32),databaseId:uuid(1),databaseName:'fixture',workerName:'fixture'},
    retention:{reviewReference:'test-only/delta',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
      .map(k=>[k,{maxAgeMs:3600000,notAfter:'2026-11-15T14:00:00.000Z'}]))},
    budgetCaps:{httpRequests:50,sqlStatements:100},now:()=>clock};
  // Scope is a resource identity, never a copied catalog owner/secret.
  for(const k of ['token','generation','epoch','phase','ownerReference','operationKey','capturedAt'])delete options.scope[k];
  const w=await openRunWorkspace({...options,mode:'create'});handles.push(w);
  const bad={...seal,scope:{...seal.scope,indexName:'other-index'}};
  await assert.rejects(w.recordCatalogSuccessor(bad),/catalog_successor_scope/);
  await assert.rejects(w.recordCatalogSuccessor({...seal,request:{...seal.request,codeSha:'c'.repeat(40)}}),/catalog_successor_scope/);
  await w.putArtifact({supplier:'test-only-expiring-body'},{kind:'phase',observedAt:next});
  await w.recordCatalogSuccessor(seal);assert.deepEqual(await w.catalogSuccessor(),seal);await w.close();handles.pop();
  clock='2026-11-16T15:00:00.000Z';const resumed=await openRunWorkspace({...options,mode:'resume'});handles.push(resumed);
  assert.deepEqual(await resumed.catalogSuccessor(),seal);assert.ok(runtimeDeltaSealBytes(seal).length<16384);
  assert.throws(()=>runtimeDeltaSealBytes({...seal,indexDelivery:'verified'}),/seal_invalid/);
  const control={schemaVersion:1,configSha256,requestId:sha256(encodeBuildRequest(seal.request)),runReference:f.input.runReference,
    releaseId:seal.publication.releaseId,dataSha256:seal.dataSha256,sourceSnapshotSha256:seal.snapshotSha256,
    publicSnapshotSha256:seal.publicSnapshotSha256,previousReleaseId:seal.request.priorReleaseId,handoffSha256:staged.handoffSha256,stage:'prepared'};
  assert.equal((await readAcceptedRuntimeHandoff(f.db,f.store,control)).seal.kind,'runtime-delta-seal');
  const owner=await claimMutationOwnership(f.db,f.input.owner,{phase:'writing',ownerReference:f.input.runReference+':finalize',operationKey:sha256('finalize:'+configSha256)});
  assert.ok(owner);assert.equal((await readAcceptedRuntimeHandoff(f.db,f.store,control)).seal.publication.releaseId,control.releaseId);
  f.sql.prepare("UPDATE catalog_mutation_scopes SET owner_reference='another-run'").run();
  await assert.rejects(readAcceptedRuntimeHandoff(f.db,f.store,control),/runtime_acceptance_changed/);
});
test('actual provider Retry-After defers only index delivery; accepted catalog and its idle writer remain available',async t=>{
  const f=await publicationFixture(t,20,undefined,true),staged=await prepareRuntimeDeltaPublication(f.input);
  await commitPreparedRuntimeDelta({...f.input,handoffSha256:staged.handoffSha256});
  let calls=0,clock=Date.parse(next);
  const input={db:f.db,store:f.store,accountId:'a'.repeat(32),nativeIndexName:'fixture-native',servingIndexName:'synthetic-derived-index',token:'TEST_ONLY',
    now:()=>new Date(clock),fetch:async()=>{calls++;return new Response('{}',{status:429,headers:{'retry-after':'20'}});}};
  const first=await drainRuntimeIndexEvents(input);assert.equal(first.outcomes[0].errorCode,'semantic_delta_throttled');assert.equal(calls,1);
  assert.equal(f.sql.prepare('SELECT retry_after FROM catalog_runtime_index_events').get().retry_after,'2026-11-15T13:00:20.000Z');
  assert.equal((await drainRuntimeIndexEvents(input)).outcomes.length,0);assert.equal(calls,1);
  clock+=21000;assert.equal((await drainRuntimeIndexEvents(input)).pending,1);assert.equal(calls,2);
  assert.equal(f.sql.prepare('SELECT release_id FROM catalog_runtime_head').get().release_id,'delta-live');
  assert.equal(await readMutationOwner(f.db,f.input.owner),null);
});
test('wrong approval/row/copy and missing source trigger refuse; no provider or catalog head is touched',async t=>{
  const f=await sourceFixture(t);
  await assert.rejects(readReviewedRuntimeDelta({...f.args,approvalSha256:'0'.repeat(64)}),/source_changed/);
  f.sql.prepare("UPDATE products SET title='Changed after review' WHERE id=?").run(product(99).id);
  await assert.rejects(readReviewedRuntimeDelta(f.args),/source_changed/);
  const g=await sourceFixture(t);g.sql.exec('DROP TRIGGER catalog_source_private_update');
  await assert.rejects(readReviewedRuntimeDelta(g.args),/source_version_required/);
});
test('an existing independently cleared listing is not blocked by stale optional semantic copy',async t=>{
  const f=await sourceFixture(t),display=JSON.parse(f.row.public_display_json);
  const state=JSON.parse(f.sql.prepare('SELECT semantic_json FROM catalog_maintenance_products WHERE product_id=?').get(f.row.id).semantic_json);
  state.wittyDescription='Different old semantic context which must not replace the cleared description.';
  f.sql.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?').run(JSON.stringify(state),f.row.id);
  await assert.rejects(readReviewedRuntimeDelta(f.args),/source_changed/,'A new admission still needs matching reviewed short copy');
  const prior={...f.args.previous,products:[...f.args.previous.products,display]};
  const checked=await readReviewedRuntimeDelta({...f.args,previous:prior});
  assert.equal(checked.changes[0].product.description,display.description,'The exact independently cleared fallback stays usable');
});
test('lost copy acknowledgement resumes exact staged rows without copying again; corrupted packets/copies refuse',async t=>{
  const f=await fixture(t,10),args={db:f.db,owner:f.owner,packet:f.packet,previousRevision:f.old.receipt.catalog_revision,previousRows:f.old.rows};
  f.lose();await assert.rejects(stageOwnedPublicProjection(args),/lost_copy_ack/);
  await stageOwnedPublicProjection(args);assert.equal(f.stats().copies,1);assert.equal(f.stats().inserts,1);
  assert.throws(()=>f.sql.prepare("UPDATE catalog_public_products SET description='changed' WHERE catalog_revision=? AND public_id=?")
    .run(f.packet.receipt.catalog_revision,uuid(1)),/immutable/);
  const changed=structuredClone(f.packet);changed.rows[0].description='changed';
  await assert.rejects(stageOwnedPublicProjection({...args,packet:changed}),/projection_changed/);
  const g=await fixture(t,10);g.corrupt();await assert.rejects(stageOwnedPublicProjection({db:g.db,owner:g.owner,packet:g.packet,
    previousRevision:g.old.receipt.catalog_revision,previousRows:g.old.rows}),/projection_changed/);
});
