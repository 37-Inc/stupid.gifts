import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { abandonExpiredPrunedRevision, deliverOwnedOutboxEvent, drainOwnedVectorOutbox, deliverOwnedPrunedVector, readOwnedPrunedVectors, resumeOwnedPrunedDelete } from '../scripts/catalog/owned-vector-delivery.ts';
import { claimMutationOwnership, mutationAdvance, mutationAssertion, readMutationOwner, releaseMutationOwnership } from '../lib/catalog/mutation-fence.ts';
import { createCatalogSnapshot } from '../lib/catalog/snapshot.ts';
import { createProjectionPacket, projectionQueries } from '../lib/catalog/d1.ts';
import { pruneExistingRevision, pruneOperationKey, prunedVectorPlan, settlePrunedRevision } from '../lib/catalog/prune-existing-revision.ts';
import { createSealedSnapshotEnvelope } from '../scripts/catalog/export-d1-snapshot.ts';
import { canonicalJson, sha256 } from '../scripts/catalog/migration.ts';
import { createReviewedVectorDelete } from '../scripts/catalog/vector-delete.ts';
import { nativeHash } from '../scripts/catalog/vector-outbox.ts';
import { createD1CatalogMaintenanceStore, loadMaintenanceVectorPayload } from '../scripts/catalog/maintenance-d1.ts';
import { maintenanceEmbeddingText } from '../scripts/catalog/maintenance-state.ts';
import { editorialSourceHash } from '../scripts/ops/catalog-editorial-core.mjs';
import { beginBuildActivation, claimBuildRequest } from '../lib/catalog/build-requests.ts';
import { enqueuePublication, claimPublication, recordPublicationDispatch } from '../lib/catalog/publication.ts';
import {accountedPublicationFetch} from '../scripts/catalog/publication-read-fetch.ts';
import {createVectorizeRestAdapters} from '../scripts/catalog/vectorize-rest.ts';

const AT = Date.parse('2026-10-20T12:00:00.000Z');
const at = ms => new Date(AT+ms).toISOString();
const FACTS = 'a'.repeat(64); const SOURCE = 'b'.repeat(64); const TEXT = 'Exact original test embedding input'; const INPUT = sha256(TEXT);
const scope = { environment:'staging',indexName:'test-index' };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const values = Array(1536).fill(Math.fround(.1)); values[0]=-0; values[1]=Math.fround(1e-45);
test('0011 is additive on an existing revision and does not enable ownership or invent abandonment',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name=>/^\d{4}.*\.sql$/.test(name)&&name<'0011_').sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run('old',at(0),SOURCE,'published');
  const before={...sql.prepare('SELECT rowid,* FROM catalog_revisions').get()};
  sql.exec(await readFile(new URL('../migrations/d1/0011_owned_vector_delivery.sql',import.meta.url),'utf8'));
  const after={...sql.prepare('SELECT rowid,* FROM catalog_revisions').get()};
  assert.deepEqual(after,{...before,abandonment_delivery_id:null,abandonment_epoch:null});
  assert.equal(sql.prepare('SELECT count(*) n FROM catalog_mutation_scopes').get().n,0);
  assert.equal(sql.prepare('SELECT count(*) n FROM catalog_vector_deliveries').get().n,0);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
});
async function setup(t,{prune=false,operation='upsert',legacy=false,merchantMarker=null}={}) {
  const sql=new DatabaseSync(':memory:');t.after(() => sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name => /^\d{4}.*\.sql$/.test(name)).sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  let clock=AT; let before; let lose; let after;
  sql.function('strftime',(format,instant) => {assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return new Date(clock).toISOString();});
  const db={prepare(query){let params=[];return{query,bind(...args){assert.ok(args.length<=100);params=args;return this;},
    async all(){return{results:sql.prepare(query).all(...params).map(row => ({...row}))};},async run(){before?.(query);return sql.prepare(query).run(...params);},
    execute(){before?.(query);sql.prepare(query).all(...params);}};},async batch(statements){
    sql.exec('BEGIN');try{for(const stmt of statements)stmt.execute();sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}
    after?.(statements);if(lose?.(statements)){lose=undefined;throw new Error('PRIVATE DB response lost');}
  }};
  const products=Array.from({length:prune?2:1},(_,i)=>({id:`B${String(i+1).padStart(9,'0')}`,publicId:uuid(i+1),slug:`funny-fixture-${i+1}`,
    title:`Funny Fixture${i} Example${i}`,description:`A factual owned object ${i}.`,imageUrl:`https://example.invalid/image-${i}.jpg`,
    affiliateUrl:`https://www.amazon.com/dp/B${String(i+1).padStart(9,'0')}?tag=test-20`,source:'amazon',currency:'USD',qualityScore:.8,
    isActive:true,availabilityStatus:'IN_STOCK',availabilityCheckedAt:at(0),editorialStatus:'generated_ready',editorialQualityScore:.9,
    sourceFactsHash:FACTS,editorialSourceHash:FACTS,editorialWriteup:Array(2).fill(Array(55).fill(`Specific useful editorial ${i}`).join(' ')).join('\n\n')
      +(merchantMarker?`\n\n${merchantMarker}`:'')}));
  const rights=Object.fromEntries(products.map((p,i)=>[p.id,Object.fromEntries(['title','description','imageUrl','affiliateUrl','editorialWriteup'].map(field=>[field,
    field==='imageUrl'?{basis:'merchant',reference:`test-receipt/${p.id}`,value:p[field],observedAt:at(0),expiresAt:at(86400000)}
      :{basis:'owned',reference:`test-owned/${p.id}/${field}`,value:p[field],...(prune&&i===0?{expiresAt:at(2*3600000)}:{})}]))]));
  const previous=createCatalogSnapshot(products,rights,{catalogRevision:'r1',now:new Date(AT)});
  for(const p of products){const dto=previous.products.find(value=>value.publicId===p.publicId);assert.ok(dto);
    sql.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,quality_score,is_active,editorial_status,
      availability_status,availability_checked_at,source_facts_hash,editorial_source_hash,embedding_text_hash,catalog_revision,
      eligible_until,public_display_json,rights_json,source_record_json,created_at,updated_at,timestamp_provenance_json)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,p.publicId,p.slug,p.source,p.title,p.currency,.8,operation==='upsert'?1:0,
      'generated_ready','IN_STOCK',at(0),FACTS,FACTS,legacy?null:INPUT,'r1',dto.eligibleUntil,operation==='upsert'?JSON.stringify(dto):null,
      JSON.stringify(rights[p.id]),JSON.stringify({id:p.id,public_id:p.publicId,source:p.source,availability_checked_at:at(0),last_verified_at:null,
        ...(merchantMarker?{merchantBody:merchantMarker}:{})}),null,at(0),'{}');
  }
  let request;let owner;let priorIntent;
  if(prune){
    sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run('r1',at(0),SOURCE,'published');
    const packet=await createProjectionPacket(previous,Object.fromEntries(previous.products.map(p=>[p.publicId,FACTS])),SOURCE,new Date(AT));
    for(const query of projectionQueries(packet))sql.prepare(query.sql).run(...query.params);
    priorIntent={releaseId:'prior',catalogRevision:'r1',codeSha:'c'.repeat(40),catalogSnapshotSha256:packet.receipt.snapshot_sha256,
      manifestSha256:'f'.repeat(64),vectorSyncWatermark:0,priorReleaseId:null,nextExpiry:previous.products[0].eligibleUntil};
    const prior={release_id:'prior',catalog_revision:'r1',code_sha:priorIntent.codeSha,completed_at:at(0),manifest_json:JSON.stringify(priorIntent)};
    sql.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(...Object.values(prior));
    const envelope=createSealedSnapshotEnvelope(previous);
    request={previous,scope,codeSha:'d'.repeat(40),context:{envelopeSha256:sha256(`${JSON.stringify(envelope)}\n`),snapshotSha256:packet.receipt.snapshot_sha256,
      projectionSha256:packet.receipt.projection_sha256,sourceExportSha256:SOURCE,vectorSyncWatermark:0,publicationReceiptWatermark:1,
      cutoff:at(6*3600000),priorPublication:{releaseId:'prior',receiptSha256:sha256(canonicalJson(prior))}}};
  }else{
    let review=null;
    if(legacy){const row={...sql.prepare('SELECT * FROM products').get()};review=createReviewedVectorDelete(row,{reviewedAt:at(0),reviewReference:'test-reviewed-held-delete'});
      const bytes=canonicalJson(review);sql.prepare('INSERT INTO vector_delete_mutations VALUES(?,?,?,?)').run(sha256(bytes),uuid(1),'r1',bytes);}
    sql.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at,delete_mutation_sha256)
      VALUES(?,'r1',?,?,?,?)`).run(uuid(1),legacy?null:INPUT,operation,at(0),review?sha256(canonicalJson(review)):null);
  }
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  owner=await claimMutationOwnership(db,scope,{phase:prune?'freezing':'writing',ownerReference:'test-run',operationKey:prune?pruneOperationKey(request):'e'.repeat(64)});
  const event={sequence:1,publicId:uuid(1),catalogRevision:'r1',embeddingTextHash:legacy?null:INPUT,operation,
    ...(legacy&&!prune?{deleteMutationSha256:sql.prepare('SELECT delete_mutation_sha256 FROM vector_sync_outbox').get().delete_mutation_sha256}:{})};
  const payload=legacy&&!prune?{...event,mutation:JSON.parse(sql.prepare('SELECT mutation_json FROM vector_delete_mutations').get().mutation_json)}
    :{...event,model:'text-embedding-3-small',embeddingText:TEXT,sourceFactsHash:FACTS,...(operation==='upsert'?{values:[...values],vectorBytesSha256:nativeHash(values)}:{})};
  const vectors=new Map();const sent=[];let resolution='settled';let reads=0;let dispatches=0;let resolves=0;
  const adapters={...scope,providerIdentity:'test:account/test-index',async dispatch(input){dispatches++;sent.push(structuredClone(input));
    if(input.vector)vectors.set(input.publicId,structuredClone(input.vector));else vectors.delete(input.publicId);return{reference:`mutation-${dispatches}`};},
  async resolve(input){resolves++;return resolution==='pending'?{state:'pending'}:{state:resolution,reference:input.reference??`mutation-${dispatches}`};},
  async readback(id){reads++;return structuredClone(vectors.get(id)??null);}};
  return{sql,db,owner,request,previous,payload,adapters,vectors,sent,event,priorIntent,now:()=>new Date(clock),
    counts:()=>({reads,dispatches,resolves}),resolution(value){resolution=value;},before(fn){before=fn;},after(fn){after=fn;},lose(fn){lose=fn;},advance(ms){clock+=ms;},
    async deliver(current=owner,overrides={}){return deliverOwnedOutboxEvent({db,owner:current,sequence:1,catalogRevision:'r1',
      loadPayload:async()=>structuredClone(payload),adapters,...overrides});},
    row:()=>({...sql.prepare('SELECT * FROM vector_sync_outbox WHERE sequence=1').get()}),
    scope:()=>({...sql.prepare('SELECT * FROM catalog_mutation_scopes').get()}),
    journals:()=>sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY prior_epoch').all().map(row=>({...row})),
  };
}
test('accepted is not complete; settled exact readback completes under the same owner and duplicate retry is a no-op',async t=>{
  const f=await setup(t);const first=await f.deliver();assert.equal(first.state,'pending');assert.equal(first.owner.epoch,1);
  assert.equal(f.row().status,'pending');assert.equal(f.scope().external_pending,1);assert.equal(f.row().attempts,1);
  await assert.rejects(releaseMutationOwnership(f.db,first.owner));
  await assert.rejects(f.db.batch([mutationAssertion(f.db,first.owner)]));
  assert.equal(await claimMutationOwnership(f.db,scope,{phase:'writing',ownerReference:'other',operationKey:'f'.repeat(64)}),null);
  f.resolution('pending');assert.equal((await f.deliver(first.owner)).state,'pending');assert.equal(f.counts().dispatches,1);
  f.resolution('settled');const complete=await f.deliver(first.owner);assert.equal(complete.state,'complete');assert.equal(complete.owner.epoch,2);
  assert.equal(f.row().status,'complete');assert.equal(f.scope().external_pending,0);
  assert.deepEqual(f.sent[0].vector.values,values);assert.equal(nativeHash(f.sent[0].vector.values),nativeHash(values));
  const counts=f.counts();assert.deepEqual(await f.deliver(f.owner),complete);assert.deepEqual(f.counts(),counts);
  assert.throws(()=>f.sql.exec("UPDATE catalog_vector_deliveries SET evidence_json='[]'"),/immutable/);
});
test('owned native delivery excludes slow durable I/O from its outer provider clock',async t=>{
  const f=await setup(t),events=[],vectors=new Map(),reference=uuid(80);let upserts=0;
  const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
  const send=accountedPublicationFetch({async reserveBudget(){events.push('reserve');await pause();},
    async settleBudget(_id,value){events.push(value.status);await pause();}},async(url,init)=>{
    if(url.endsWith('/upsert')){const vector=JSON.parse(init.body);vectors.set(vector.id,vector);upserts++;return Response.json({success:true,result:{mutationId:reference}});}
    if(url.endsWith('/info'))return Response.json({success:true,result:{dimensions:1536,processedUpToMutation:reference}});
    assert.ok(url.endsWith('/get_by_ids'));
    const found=JSON.parse(init.body).ids.flatMap(id=>{const v=vectors.get(id);return v?[`{"id":${JSON.stringify(id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':n).join(',')}],"metadata":${JSON.stringify(v.metadata)}}`]:[];});
    return new Response(`{"success":true,"result":[${found.join(',')}]}`);
  },{...scope,accountId:'a'.repeat(32),databaseId:uuid(70),workerName:'fixture',identityOrigin:'https://fixture.invalid'});
  const adapters=createVectorizeRestAdapters({...scope,accountId:'a'.repeat(32),token:'TEST_ONLY',fetch:send,timeoutMs:10});
  const first=await f.deliver(f.owner,{adapters,timeoutMs:10});assert.equal(first.state,'pending');assert.equal(upserts,1);
  const done=await f.deliver(first.owner,{adapters,timeoutMs:10});assert.equal(done.state,'complete');assert.equal(upserts,1);
  assert.ok(!events.includes('unknown'));assert.equal(f.scope().external_pending,0);
});
test('lost provider response survives restart without blind replay, even when desired bytes are already visible',async t=>{
  const f=await setup(t);const dispatch=f.adapters.dispatch;
  f.adapters.dispatch=async input=>{await dispatch(input);throw new Error('PRIVATE provider body');};
  const first=await f.deliver();assert.equal(first.errorCode,'mutation_unknown');assert.equal(f.journals()[0].mutation_reference,null);
  f.resolution('pending');const restarted=await f.deliver(await readMutationOwner(f.db,scope));
  assert.equal(restarted.state,'pending');assert.equal(f.counts().dispatches,1);
  f.adapters.dispatch=async()=>{throw new Error('Must not resend');};f.resolution('settled');
  const completed=await f.deliver(first.owner);assert.equal(completed.state,'complete');assert.equal(f.row().mutation_reference,'mutation-1');
  assert.doesNotMatch(JSON.stringify(completed),/PRIVATE/);
});
test('conclusively not submitted allows a bounded next-call retry; errors/timeouts do not',async t=>{
  const f=await setup(t);f.adapters.dispatch=async()=>{throw new Error('PRIVATE failure');};
  const first=await f.deliver();f.resolution('not_submitted');const resolved=await f.deliver(first.owner);
  assert.equal(resolved.state,'pending');assert.equal(f.journals()[0].dispatch_token,null);
  assert.match(f.journals()[0].evidence_json,/not_submitted/);
  for(let i=1;i<3;i++){await f.deliver(first.owner);await f.deliver(first.owner);}
  assert.equal(f.journals()[0].attempts,3);assert.equal((await f.deliver(first.owner)).errorCode,'attempts_exhausted');
  assert.equal(f.scope().external_pending,1);assert.equal(f.row().status,'pending');
  const accepted=await setup(t);const a=await accepted.deliver();accepted.resolution('not_submitted');
  await assert.rejects(accepted.deliver(a.owner),/resolution_invalid/);assert.equal(accepted.counts().dispatches,1);
});
test('real SQLite intent/acceptance/completion response loss recovers exact owner and receipt',async t=>{
  for(const stage of ['intent','acceptance','completion']){
    const f=await setup(t);let active=true;
    f.lose(statements=>active&&statements.some(s=>stage==='intent'?s.query.includes('INSERT INTO catalog_vector_deliveries')
      :stage==='acceptance'?s.query.includes('SET mutation_reference=?')&&s.query.includes('mutation_reference IS NULL')
        :s.query.includes("SET status='complete'"))&&(active=false,true));
    const first=await f.deliver();assert.equal(first.state,'pending');const result=await f.deliver(f.owner);
    assert.equal(result.state,'complete');assert.equal(result.owner.epoch,2);assert.equal(f.counts().dispatches,1);assert.equal(f.journals().length,1);
  }
});
test('rollback before durable intent never calls provider; restart resumes before dispatch safely',async t=>{
  const f=await setup(t);let fail=true;
  f.before(query=>{if(fail&&query.includes('INSERT INTO catalog_vector_deliveries'))throw new Error('PRIVATE transaction error');});
  await assert.rejects(f.deliver(),/^Error: vector_intent_unconfirmed$/);assert.equal(f.counts().reads,0);assert.equal(f.counts().dispatches,0);
  assert.equal(f.scope().external_pending,0);assert.equal(f.journals().length,0);assert.equal(f.row().lease_token,null);
  fail=false;const first=await f.deliver();assert.equal(first.state,'pending');assert.equal((await f.deliver(first.owner)).state,'complete');
});
test('parallel handlers cannot dispatch the same UUID twice or overlap a different delivery',async t=>{
  const f=await setup(t);const results=await Promise.allSettled([f.deliver(),f.deliver()]);
  assert.ok(results.some(r=>r.status==='fulfilled'));assert.equal(f.counts().dispatches,1);assert.equal(f.journals().length,1);
  f.sql.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at)
    VALUES(?,'r1',?,'delete',?)`).run(uuid(1),INPUT,at(0));
  await assert.rejects(f.deliver((await readMutationOwner(f.db,scope)),{sequence:2}));assert.equal(f.counts().dispatches,1);
});
test('explicit bounded drainer stops at uncertain work, rejects stale epochs and invalid bounds',async t=>{
  const f=await setup(t);const options={db:f.db,owner:f.owner,catalogRevision:'r1',loadPayload:async()=>f.payload,adapters:f.adapters,maxEvents:1};
  const result=await drainOwnedVectorOutbox(options);assert.equal(result.outcomes.length,1);assert.equal(result.outcomes[0].state,'pending');
  await assert.rejects(f.deliver({...result.owner,epoch:999}),/owner_changed/);
  await assert.rejects(drainOwnedVectorOutbox({...options,maxEvents:11}),/invalid_owned_vector_bound/);
  assert.equal(f.counts().dispatches,1);
});
test('changed current state or owner epoch fences completion, never clearing uncertainty',async t=>{
  for(const change of [f=>f.sql.exec("UPDATE products SET source_facts_hash='changed'"),f=>f.sql.exec("UPDATE products SET public_display_json=NULL"),
    f=>f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1')]){
    const f=await setup(t);const first=await f.deliver();change(f);await assert.rejects(f.deliver(first.owner));
    assert.equal(f.row().status,'pending');assert.equal(f.scope().external_pending,1);assert.equal(f.counts().dispatches,1);
  }
});
test('expiry after acceptance permits exact settled recovery and release, but never publishable success',async t=>{
  const f=await setup(t);const first=await f.deliver();f.advance(2*86400000);f.resolution('pending');
  assert.equal((await f.deliver(first.owner)).state,'pending');assert.equal(f.scope().external_pending,1);
  f.resolution('settled');const expired=await f.deliver(first.owner);assert.equal(expired.state,'expired');
  assert.equal(f.journals()[0].disposition,'expired');assert.equal(f.row().status,'complete');assert.equal(f.counts().dispatches,1);
  await releaseMutationOwnership(f.db,expired.owner);assert.equal(f.scope().phase,'idle');
  assert.ok(await claimMutationOwnership(f.db,scope,{phase:'writing',ownerReference:'revalidation',operationKey:'f'.repeat(64)}));
});
test('expiry before dispatch safely abandons only unsent intent and retains pending revalidation work',async t=>{
  const f=await setup(t);f.adapters.readback=async()=>{f.advance(2*86400000);return null;};
  const expired=await f.deliver();assert.equal(expired.state,'expired');assert.equal(f.counts().dispatches,0);
  assert.equal(f.journals()[0].disposition,'expired_unsubmitted');assert.equal(f.row().status,'pending');
  assert.equal(f.row().attempts,0);assert.equal(f.row().lease_token,null);assert.equal(f.scope().external_pending,0);
  await releaseMutationOwnership(f.db,expired.owner);
});
test('explicitly proven non-submission can expire/release with its attempt evidence retained',async t=>{
  const f=await setup(t);f.adapters.dispatch=async()=>{throw new Error('UNKNOWN transport result');};
  const first=await f.deliver();f.resolution('not_submitted');await f.deliver(first.owner);f.advance(2*86400000);
  const expired=await f.deliver(first.owner);assert.equal(expired.state,'expired');assert.equal(f.row().status,'pending');
  assert.equal(f.row().attempts,1);assert.equal(f.row().lease_token,null);assert.match(f.journals()[0].evidence_json,/not_submitted/);
  assert.equal(f.scope().external_pending,0);await releaseMutationOwnership(f.db,expired.owner);
});
test('a dispatch timeout stays owned/unknown after abort, with no blind second attempt',async t=>{
  const f=await setup(t);let calls=0;
  f.adapters.dispatch=(_input,signal)=>{calls++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('PRIVATE')),{once:true}));};
  const first=await f.deliver(f.owner,{timeoutMs:10});assert.equal(first.errorCode,'mutation_unknown');
  f.resolution('pending');assert.equal((await f.deliver(first.owner)).state,'pending');assert.equal(calls,1);assert.equal(f.scope().external_pending,1);
});
test('background delivery defaults to10s, permits explicit30s and rejects unsafe timeout bounds',async t=>{
  const scheduled=[];const timer=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(callback,delay,...args)=>{scheduled.push(delay);return timer(callback,delay,...args);});
  const defaultRun=await setup(t);await defaultRun.deliver();assert.deepEqual(scheduled,[10_000,10_000,10_000]);
  scheduled.length=0;const explicit=await setup(t);await explicit.deliver(explicit.owner,{timeoutMs:30_000});
  assert.deepEqual(scheduled,[30_000,30_000,30_000]);
  for(const timeoutMs of [0,9,-1,30_001,10.5,NaN])await assert.rejects(explicit.deliver(explicit.owner,{timeoutMs}),/invalid_vector_timeout/);
});
test('wrong environment/index/account binding refuses before provider calls and remains bound across restart',async t=>{
  const f=await setup(t);
  for(const wrong of [{environment:'production'},{indexName:'other'}])await assert.rejects(f.deliver(f.owner,{adapters:{...f.adapters,...wrong}}),/scope_mismatch/);
  assert.equal(f.counts().reads,0);const first=await f.deliver();const before=f.counts();
  await assert.rejects(f.deliver(first.owner,{adapters:{...f.adapters,providerIdentity:'test:different-account'}}),/scope_mismatch/);
  assert.deepEqual(f.counts(),before);assert.equal(f.scope().external_pending,1);
});
test('settled is insufficient for missing/wrong values, metadata or namespace, and read errors are sanitized',async t=>{
  for(const mutate of [f=>f.vectors.clear(),f=>{f.vectors.get(uuid(1)).values[2]=Math.fround(.2);},
    f=>{f.vectors.get(uuid(1)).metadata.catalogRevision='wrong';},f=>{f.vectors.get(uuid(1)).namespace='other';}]){
    const f=await setup(t);const first=await f.deliver();mutate(f);assert.equal((await f.deliver(first.owner)).errorCode,'not_visible');
    assert.equal(f.row().status,'pending');assert.equal(f.counts().dispatches,1);
  }
  const f=await setup(t);f.adapters.readback=async()=>{throw new Error('PRIVATE read failure');};
  const result=await f.deliver();assert.equal(result.errorCode,'provider_failed');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);assert.equal(f.counts().dispatches,0);
});
test('malformed/stale payloads and unsafe legacy attempts fail before any provider operation',async t=>{
  for(const mutate of [f=>{f.payload.embeddingText='changed';},f=>{f.payload.values=[1,2];},f=>{f.payload.sourceFactsHash='b'.repeat(64);},
    f=>f.sql.exec("UPDATE products SET catalog_revision='other'"),f=>f.sql.exec('UPDATE vector_sync_outbox SET attempts=1'),
    f=>f.sql.exec("UPDATE vector_sync_outbox SET lease_token='old',lease_until='2000-01-01T00:00:00.000Z'"),
    f=>f.sql.exec("UPDATE vector_sync_outbox SET mutation_reference='unowned-accepted'")]){
    const f=await setup(t);mutate(f);await assert.rejects(f.deliver());assert.equal(f.counts().dispatches,0);assert.equal(f.counts().reads,0);
  }
  const f=await setup(t);await assert.rejects(f.deliver(f.owner,{catalogRevision:'wrong'}),/event_changed/);
  await assert.rejects(f.deliver(f.owner,{timeoutMs:30_001}),/invalid_vector_timeout/);
});
test('reviewed unknown-hash delete preserves provenance and requires settled verified absence',async t=>{
  const f=await setup(t,{operation:'delete',legacy:true});f.vectors.set(uuid(1),{id:uuid(1),values,metadata:{catalogRevision:'r1'}});
  const first=await f.deliver();assert.equal(first.state,'pending');assert.equal(f.sent[0].vector,null);
  assert.equal(f.row().embedding_text_hash,null);assert.equal(f.journals()[0].mutation_reference,'mutation-1');
  assert.equal((await f.deliver(first.owner)).state,'complete');assert.equal(f.row().embedding_text_hash,null);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM vector_delete_mutations').get().n,1);
  const bad=await setup(t,{operation:'delete',legacy:true});bad.payload.mutation.reviewReference='changed';await assert.rejects(bad.deliver());
  assert.equal(bad.counts().dispatches,0);
});
test('already-visible exact vector is a fenced no-op, without dispatch or invented mutation reference',async t=>{
  const f=await setup(t);f.vectors.set(uuid(1),{id:uuid(1),values:[...values],metadata:{catalogRevision:'r1',eligible:true,
    embeddingTextHash:INPUT,embeddingModel:'text-embedding-3-small',sourceFactsHash:FACTS,vectorBytesSha256:nativeHash(values)}});
  const result=await f.deliver();assert.equal(result.state,'complete');assert.equal(f.counts().dispatches,0);assert.equal(f.row().mutation_reference,null);
  assert.equal(f.journals()[0].attempts,0);assert.match(f.journals()[0].evidence_json,/already_visible/);
});
test('actual MaintenanceStore immutable native payload feeds owned delivery without regeneration or implicit cursor refresh',async t=>{
  const f=await setup(t);const p={id:'B000000099',title:'Synthetic Octopus Lamp',price:0,currency:'USD',imageUrl:'https://example.invalid/lamp.jpg',
    affiliateUrl:'https://www.amazon.com/dp/B000000099?tag=test-20',source:'amazon',sourceQuery:'test-fixture',humorTags:['octopus'],punnyTitle:'Test Lamp',
    wittyDescription:'Synthetic owned lamp description.',qualityScore:.9,isActive:true,availabilityStatus:'IN_STOCK',editorialStatus:'generated_ready',
    editorialQualityScore:.95,editorialWriteup:Array(2).fill(Array(60).fill('Synthetic lamp factual editorial description.').join(' ')).join('\n\n'),
    sourceFacts:{fixture:true,kind:'lamp'},remotelyVerified:true,embedding:[...values]};
  const facts=editorialSourceHash(p);p.editorialSourceHash=facts;
  const rights=Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,affiliateUrl:p.affiliateUrl,
    punnyTitle:p.punnyTitle,wittyDescription:p.wittyDescription,editorialWriteup:p.editorialWriteup,humorTags:JSON.stringify(p.humorTags)})
    .map(([field,value])=>[field,{basis:'owned',reference:'test-owned-copy',value}]));
  const cursor={current:f.owner};const store=createD1CatalogMaintenanceStore({db:f.db,owner:f.owner,ownerCursor:cursor,runId:'actual-store',
    catalogRevision:'maintenance-r2',newPublicId:()=>uuid(99),intent:()=>({rightsById:{[p.id]:rights},
      verificationById:{[p.id]:{reference:'test-observed',observedAt:at(0),sourceFactsHash:facts}},
      embeddingById:{[p.id]:{reference:'test-original-vector',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:facts}}})});
  await store.upsertProduct(p,facts);assert.equal(cursor.current.epoch,1);
  const event=f.sql.prepare('SELECT sequence FROM vector_sync_outbox WHERE public_id=?').get(uuid(99));
  const options={db:f.db,owner:cursor.current,sequence:event.sequence,catalogRevision:'maintenance-r2',
    loadPayload:event=>loadMaintenanceVectorPayload(f.db,event),adapters:f.adapters};
  const first=await deliverOwnedOutboxEvent(options);const complete=await deliverOwnedOutboxEvent({...options,owner:first.owner});
  assert.equal(complete.state,'complete');assert.equal(nativeHash(f.vectors.get(uuid(99)).values),nativeHash(values));
  await assert.rejects(store.upsertProduct(p,facts),/fenced/);cursor.current=complete.owner;
  await store.upsertProduct(p,facts);assert.equal(cursor.current.epoch,complete.owner.epoch);
});
const MERCHANT_MARKER='EXPIRED_PRIVATE_MERCHANT_BODY_"quoted"\\slash\nline';
async function pruneDeleteFixture(t,maintenance=false){
  const f=await setup(t,{prune:true,merchantMarker:MERCHANT_MARKER});
  if(maintenance){
    const id='9'.repeat(64);
    f.sql.prepare('INSERT INTO catalog_maintenance_operations VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,'8'.repeat(64),'original-maintenance','r1','staging','test-index',1,0,1,at(0),'{}','[]');
    f.sql.prepare('UPDATE products SET timestamp_provenance_json=? WHERE public_id=?')
      .run(canonicalJson({fields:{availability_checked_at:{basis:'maintenance_operation',operationId:id}}}),uuid(1));
  }
  f.advance(3*3600000);
  const prepared=await pruneExistingRevision(f.db,f.owner,f.request),revision=prepared.revision;
  f.vectors.set(uuid(1),{id:uuid(1),values:[...values],metadata:{catalogRevision:'r1'}});
  return{...f,revision,owner:prepared.owner,deliverDelete:(owner=prepared.owner,rev=revision)=>deliverOwnedPrunedVector({
    db:f.db,owner,revision:rev,publicId:uuid(1),adapters:f.adapters})};
}
function assertBodyFree(row){
  for(const key of ['owner_json','request_json','product_json','evidence_json']){
    assert.doesNotMatch(row[key],/EXPIRED_PRIVATE_MERCHANT_BODY|source_record_json|public_display_json|rights_json/);
    assert.doesNotMatch(JSON.stringify(JSON.parse(row[key])),/EXPIRED_PRIVATE_MERCHANT_BODY/);
  }
  const request=JSON.parse(row.request_json),product=JSON.parse(row.product_json);
  assert.equal(request.pruneDeleteControl.schemaVersion,1);assert.equal(request.pruneCurrent,null);
  assert.match(request.pruneDeleteControl.productSha256,/^[a-f0-9]{64}$/);assert.match(request.pruneDeleteControl.sourceSha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(product).sort(),['kind','publicId','schemaVersion','sha256']);assert.equal(product.kind,'prune-delete-product-control');
}
async function pendingDelete(t,maintenance=false){
  const f=await pruneDeleteFixture(t,maintenance),first=await f.deliverDelete();
  const options={db:f.db,owner:first.owner,deliveryId:first.deliveryId,plan:prunedVectorPlan(f.revision),adapters:f.adapters};
  return{f,first,options,resume:extra=>resumeOwnedPrunedDelete({...options,...extra})};
}
test('resume-only accepted prune DELETE settles late with exact source/receipt/CAS and zero new dispatch',async t=>{
  const {f,first,options,resume}=await pendingDelete(t,true),before=f.counts(),product={...f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(1))};
  assert.ok(f.revision.sourceRows.find(row=>row.public_id===uuid(1)).verification_operation_json);
  f.advance(2*86400000);f.resolution('pending');const pending=await resume();
  assert.equal(pending.state,'pending');assert.equal(pending.owner.epoch,first.owner.epoch);assert.equal(f.scope().external_pending,1);
  f.resolution('settled');f.before(query=>{if(query.includes('INSERT INTO catalog_revisions'))throw new Error('Must not reprune');});
  const complete=await resume();assert.equal(complete.state,'complete');assert.equal(complete.owner.epoch,first.owner.epoch+1);
  assert.equal(f.scope().external_pending,0);assert.equal(f.counts().dispatches,before.dispatches);assert.equal(f.vectors.has(uuid(1)),false);
  assert.deepEqual({...f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(1))},product);assertBodyFree(f.journals()[0]);
  const counts=f.counts(),journal=f.journals()[0];
  assert.deepEqual(await resumeOwnedPrunedDelete({...options,owner:complete.owner}),complete);
  assert.deepEqual(f.counts(),counts);assert.deepEqual(f.journals()[0],journal); // original completion reconciliation only
  await assert.rejects(resumeOwnedPrunedDelete({...options,owner:{...complete.owner,epoch:complete.owner.epoch+1}}));
});
test('resume-only refuses owner, plan, source, full-product, receipt and maintenance-observation drift before provider reads',async t=>{
  const cases=[
    {extra:o=>({owner:{...o.owner,epoch:o.owner.epoch-1}})},
    {extra:o=>({owner:{...o.owner,token:'wrong-token'}})},
    {change:f=>f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1')},
    {extra:o=>({plan:{...o.plan,absentIds:[uuid(2)]}})},
    {extra:o=>({plan:{...o.plan,globalWatermark:1}})},
    {extra:o=>({adapters:{...o.adapters,providerIdentity:'test:wrong-account'}})},
    {change:f=>f.sql.exec("UPDATE products SET title='changed non-captured full row'")},
    {change:f=>{f.sql.exec('DROP TRIGGER products_archive_immutable');f.sql.exec("UPDATE products SET source_record_json=json_set(source_record_json,'$.last_verified_at','changed')");}},
    {change:f=>{f.sql.exec('DROP TRIGGER catalog_projection_receipt_immutable');f.sql.prepare('UPDATE catalog_projection_receipts SET source_export_sha256=? WHERE catalog_revision=?').run('f'.repeat(64),f.revision.snapshot.catalogRevision);}},
    {maintenance:true,change:f=>{f.sql.exec('DROP TRIGGER catalog_maintenance_operations_immutable');f.sql.exec("UPDATE catalog_maintenance_operations SET result_json='{\"changed\":true}'");}},
  ];
  for(const scenario of cases){
    const {f,options,resume}=await pendingDelete(t,scenario.maintenance);scenario.change?.(f);const before=f.counts();
    await assert.rejects(resume(scenario.extra?.(options)));assert.deepEqual(f.counts(),before);
    assert.equal(f.journals()[0].status,'pending');assert.equal(f.scope().external_pending,1);assertBodyFree(f.journals()[0]);
  }
});
test('resume-only rejects new, unknown-reference, legacy, unsupported captured-source and changed control journals',async t=>{
  const empty=await pruneDeleteFixture(t);
  await assert.rejects(resumeOwnedPrunedDelete({db:empty.db,owner:empty.owner,deliveryId:'f'.repeat(64),plan:prunedVectorPlan(empty.revision),adapters:empty.adapters}));
  assert.equal(empty.journals().length,0);assert.deepEqual(empty.counts(),{reads:0,dispatches:0,resolves:0});assert.equal(empty.scope().external_pending,0);
  for(const kind of ['new','missing-reference','missing-dispatch','legacy','source-hash','product-hash','unsupported-approval']){
    const {f,options,resume}=await pendingDelete(t);
    if(kind!=='new'){
      f.sql.exec('DROP TRIGGER catalog_vector_delivery_identity_immutable');const row=f.journals()[0],request=JSON.parse(row.request_json);
      if(kind==='missing-reference')f.sql.exec('UPDATE catalog_vector_deliveries SET mutation_reference=NULL');
      if(kind==='missing-dispatch')f.sql.exec('UPDATE catalog_vector_deliveries SET dispatch_token=NULL,mutation_reference=NULL');
      if(kind==='legacy')delete request.pruneDeleteControl;
      if(kind==='source-hash')request.pruneDeleteControl.sourceSha256='f'.repeat(64);
      if(kind==='product-hash')request.pruneDeleteControl.productSha256='f'.repeat(64);
      if(kind==='unsupported-approval')request.pruneDeleteControl.sourceSha256=sha256(canonicalJson({...f.revision.sourceRows.find(r=>r.public_id===uuid(1)),approved_product_json:'{}'}));
      if(!['missing-reference','missing-dispatch'].includes(kind))f.sql.prepare('UPDATE catalog_vector_deliveries SET request_json=?').run(canonicalJson(request));
    }
    const before=f.counts();await assert.rejects(resume(kind==='new'?{deliveryId:'f'.repeat(64)}:undefined));
    assert.deepEqual(f.counts(),before);assert.equal(f.scope().external_pending,1);assert.equal(f.journals().length,1);
    if(kind==='new')assertBodyFree(f.journals()[0]);assert.equal(options.owner.epoch,f.scope().mutation_epoch);
  }
});
test('resume-only provider pending/errors/wrong reference/present vector never clear ownership or infer non-submission',async t=>{
  for(const kind of ['pending','error','not_submitted','wrong-reference','still-present','read-error']){
    const {f,resume}=await pendingDelete(t),before=f.counts().dispatches;
    if(kind==='pending')f.resolution('pending');
    if(kind==='not_submitted')f.resolution('not_submitted');
    if(kind==='error')f.adapters.resolve=async()=>{throw new Error('PRIVATE provider failure');};
    if(kind==='wrong-reference')f.adapters.resolve=async()=>({state:'settled',reference:'wrong-reference'});
    if(kind==='still-present')f.vectors.set(uuid(1),{id:uuid(1),values:[...values],metadata:{catalogRevision:'r1'}});
    if(kind==='read-error')f.adapters.readback=async()=>{throw new Error('PRIVATE native read failure');};
    if(['not_submitted','wrong-reference'].includes(kind))await assert.rejects(resume(),/resolution_invalid/);
    else{const result=await resume();assert.equal(result.state,'pending');assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);}
    assert.equal(f.counts().dispatches,before);assert.equal(f.scope().external_pending,1);assert.equal(f.journals()[0].status,'pending');
    assert.equal(f.journals()[0].attempts,1);assert.ok(f.journals()[0].dispatch_token);assertBodyFree(f.journals()[0]);
  }
});
test('resume-only retains full row CAS across native readback and lost committed completion responses',async t=>{
  const race=await pendingDelete(t);race.f.adapters.readback=async()=>{race.f.sql.exec("UPDATE products SET title='changed during readback'");return null;};
  assert.equal((await race.resume()).state,'pending');assert.equal(race.f.scope().external_pending,1);assert.equal(race.f.journals()[0].status,'pending');
  const lost=await pendingDelete(t);lost.f.lose(statements=>statements.some(s=>s.query.includes("SET status='complete'")));
  const result=await lost.resume();assert.equal(result.state,'complete');assert.equal(result.owner.epoch,lost.first.owner.epoch+1);
  assert.equal(lost.f.scope().external_pending,0);assert.equal(lost.f.counts().dispatches,1);assertBodyFree(lost.f.journals()[0]);
  const before=lost.f.counts();lost.f.sql.exec("UPDATE products SET title='changed after completion'");
  await assert.rejects(lost.resume({owner:result.owner}));assert.deepEqual(lost.f.counts(),before);
});
test('new prune DELETE journals contain only versioned hashes/IDs/receipts, including escaped expired merchant bodies',async t=>{
  const f=await pruneDeleteFixture(t),before=f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(1));
  for(const field of ['source_record_json','public_display_json','rights_json'])assert.match(before[field],/EXPIRED_PRIVATE_MERCHANT_BODY/);
  const first=await f.deliverDelete();assert.equal(first.state,'pending');assertBodyFree(f.journals()[0]);
  const request=JSON.parse(f.journals()[0].request_json);
  assert.equal(request.pruneDeleteControl.productSha256,sha256(canonicalJson({...before})));
  assert.equal(request.pruneDeleteControl.sourceSha256,sha256(canonicalJson(f.revision.sourceRows.find(p=>p.public_id===uuid(1)))));
  const complete=await f.deliverDelete(first.owner,structuredClone(f.revision));assert.equal(complete.state,'complete');
  assert.equal(f.counts().dispatches,1);assertBodyFree(f.journals()[0]);assert.equal(f.vectors.has(uuid(1)),false);
  assert.deepEqual(f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(1)),before);
});
test('body-free prune DELETE verifies raw full-row, captured source, plan/receipt, owner and epoch before provider recovery',async t=>{
  const cases=[
    {change:f=>f.sql.prepare('UPDATE products SET public_display_json=json_set(public_display_json,\'$.description\',?) WHERE public_id=?').run('CHANGED EXPIRED BODY',uuid(1))},
    {change:f=>f.sql.exec("DROP TRIGGER products_archive_immutable; UPDATE products SET source_record_json=json_set(source_record_json,'$.merchantBody','changed archive')")},
    {change:f=>f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1')},
    {change:f=>f.sql.exec("UPDATE catalog_mutation_scopes SET owner_token='other-owner'")},
    {rev:r=>{r.sourceRows.find(p=>p.public_id===uuid(1)).archived_last_verified_at=at(1);return r;}},
    {rev:r=>{r.packet.receipt.source_export_sha256='f'.repeat(64);return r;}},
    {rev:r=>{r.packet.receipt.snapshot_sha256='f'.repeat(64);return r;}},
  ];
  for(const scenario of cases){
    const f=await pruneDeleteFixture(t),first=await f.deliverDelete();scenario.change?.(f);
    const before=f.counts();await assert.rejects(f.deliverDelete(first.owner,scenario.rev?.(structuredClone(f.revision))||f.revision));
    assert.deepEqual(f.counts(),before);assert.equal(f.journals()[0].status,'pending');assert.equal(f.scope().external_pending,1);
    assertBodyFree(f.journals()[0]);
  }
});
test('body-free digest/control tampering refuses before resolving or resending a pending delete',async t=>{
  for(const kind of ['product','source','product-json','version']){
    const f=await pruneDeleteFixture(t),first=await f.deliverDelete();f.sql.exec('DROP TRIGGER catalog_vector_delivery_identity_immutable');
    const row=f.journals()[0],request=JSON.parse(row.request_json),product=JSON.parse(row.product_json);
    if(kind==='product')request.pruneDeleteControl.productSha256='f'.repeat(64);
    if(kind==='source')request.pruneDeleteControl.sourceSha256='f'.repeat(64);
    if(kind==='version')request.pruneDeleteControl.schemaVersion=2;
    if(kind==='product-json')product.sha256='f'.repeat(64);
    f.sql.prepare('UPDATE catalog_vector_deliveries SET request_json=?,product_json=?').run(canonicalJson(request),canonicalJson(product));
    const before=f.counts();await assert.rejects(f.deliverDelete(first.owner),/control_changed|product_changed/);
    assert.deepEqual(f.counts(),before);assert.equal(f.scope().external_pending,1);
  }
});
test('body-free reread is not a weaker subset CAS: source changes after read roll back dispatch marker',async t=>{
  const f=await pruneDeleteFixture(t);let changed=false;
  f.adapters.readback=async()=>{
    f.sql.prepare("UPDATE products SET rights_json=json_set(rights_json,'$.imageUrl.value','changed after verified read') WHERE public_id=?").run(uuid(1));
    changed=true;return{id:uuid(1),values:[...values],metadata:{catalogRevision:'r1'}};
  };
  await assert.rejects(f.deliverDelete());assert.equal(changed,true);assert.equal(f.counts().dispatches,0);
  assert.equal(f.journals()[0].dispatch_token,null);assert.equal(f.journals()[0].attempts,0);assert.equal(f.scope().external_pending,1);
});
test('body-free prune delete survives lost intent/acceptance/completion and provider responses exactly once',async t=>{
  for(const stage of ['intent','acceptance','completion','provider']){
    const f=await pruneDeleteFixture(t);let active=true;
    f.lose(statements=>active&&statements.some(s=>stage==='intent'?s.query.includes('INSERT INTO catalog_vector_deliveries')
      :stage==='acceptance'?s.query.includes('SET mutation_reference=?')&&s.query.includes('mutation_reference IS NULL')
        :stage==='completion'?s.query.includes("SET status='complete'"):false)&&(active=false,true));
    if(stage==='provider'){const send=f.adapters.dispatch;f.adapters.dispatch=async input=>{await send(input);throw new Error('UNKNOWN transport outcome');};}
    const first=await f.deliverDelete();assert.equal(first.state,'pending');assertBodyFree(f.journals()[0]);
    f.resolution('pending');assert.equal((await f.deliverDelete(await readMutationOwner(f.db,scope),structuredClone(f.revision))).state,'pending');
    assert.equal(f.counts().dispatches,1);
    f.resolution('settled');const complete=await f.deliverDelete(first.owner,structuredClone(f.revision));assert.equal(complete.state,'complete');
    assert.equal(f.counts().dispatches,1);assert.equal(f.journals().length,1);assertBodyFree(f.journals()[0]);
    assert.equal((await f.deliverDelete(complete.owner)).state,'complete');assert.equal(f.counts().dispatches,1);
  }
});
test('historical full-row prune DELETE journals remain readable without rewriting their immutable payload',async t=>{
  const f=await pruneDeleteFixture(t),first=await f.deliverDelete();const row=f.journals()[0],request=JSON.parse(row.request_json);
  delete request.pruneDeleteControl;request.pruneCurrent=f.revision.sourceRows.find(p=>p.public_id===uuid(1));
  const product={...f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(1))};
  // Install an isolated historical-format fixture, not a production migration.
  f.sql.exec('DROP TRIGGER catalog_vector_delivery_identity_immutable');
  f.sql.prepare('UPDATE catalog_vector_deliveries SET request_json=?,product_json=?').run(canonicalJson(request),canonicalJson(product));
  const saved=f.journals()[0];assert.match(saved.product_json,/EXPIRED_PRIVATE_MERCHANT_BODY/);
  const complete=await f.deliverDelete(first.owner);assert.equal(complete.state,'complete');assert.equal(f.counts().dispatches,1);
  assert.equal(f.journals()[0].request_json,saved.request_json);assert.equal(f.journals()[0].product_json,saved.product_json);
});
test('prune promotion/deletion uses exact original bytes, keeps unknown input unknown, then concretely settles the build',async t=>{
  const f=await setup(t,{prune:true,legacy:true});const prepared=await pruneExistingRevision(f.db,f.owner,f.request);let owner=prepared.owner;
  const revision=prepared.revision;assert.equal(revision.snapshot.products.length,1);const kept=revision.snapshot.products[0];
  f.vectors.set(uuid(1),{id:uuid(1),values:[...values],metadata:{catalogRevision:'r1'}});
  const original={publicId:kept.publicId,catalogRevision:'r1',sourceFactsHash:FACTS,embeddingTextHash:null,values:[...values],vectorBytesSha256:nativeHash(values)};
  const source={sha256:sha256(canonicalJson(original)),load:async()=>structuredClone(original)};
  const deliver=(id,current,extra={})=>deliverOwnedPrunedVector({db:f.db,owner:current,revision,publicId:id,adapters:f.adapters,...extra});
  const first=await deliver(kept.publicId,owner,{original:source});assert.equal(first.state,'pending');
  owner=(await deliver(kept.publicId,first.owner,{original:source})).owner;
  const dropped=uuid(1);const deletion=await deliver(dropped,owner);owner=(await deliver(dropped,deletion.owner)).owner;
  assert.equal(f.vectors.has(dropped),false);const promoted=f.vectors.get(kept.publicId);
  assert.equal(promoted.metadata.catalogRevision,revision.snapshot.catalogRevision);assert.equal(promoted.metadata.legacyInputProvenance,'unverified');
  assert.equal('embeddingTextHash'in promoted.metadata,false);assert.equal(nativeHash(promoted.values),original.vectorBytesSha256);
  assert.equal(f.sql.prepare('SELECT catalog_revision FROM products WHERE public_id=?').get(kept.publicId).catalog_revision,'r1');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n,0);
  assert.equal((await readOwnedPrunedVectors(f.db,owner,revision,f.adapters)).settled,true);
  promoted.values[3]=Math.fround(.2);await assert.rejects(readOwnedPrunedVectors(f.db,owner,revision,f.adapters));promoted.values[3]=values[3];
  const queued=await settlePrunedRevision(f.db,owner,revision,()=>readOwnedPrunedVectors(f.db,owner,revision,f.adapters));
  assert.equal(queued.state,'build_queued');assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,1);
});
test('prune proof refuses omission and unreviewed originals with invented input hash',async t=>{
  const f=await setup(t,{prune:true,legacy:true});const prepared=await pruneExistingRevision(f.db,f.owner,f.request);const revision=prepared.revision;
  await assert.rejects(readOwnedPrunedVectors(f.db,prepared.owner,revision,f.adapters),/incomplete/);
  const oversized=structuredClone(revision);oversized.request.previous.products=Array(21).fill(f.previous.products[0]);
  await assert.rejects(readOwnedPrunedVectors(f.db,prepared.owner,oversized,f.adapters),/plan_invalid/);assert.equal(f.counts().reads,0);
  const kept=revision.snapshot.products[0];const original={publicId:kept.publicId,catalogRevision:'r1',sourceFactsHash:FACTS,embeddingTextHash:INPUT,values:[...values],vectorBytesSha256:nativeHash(values)};
  await assert.rejects(deliverOwnedPrunedVector({db:f.db,owner:prepared.owner,revision,publicId:kept.publicId,adapters:f.adapters,
    original:{sha256:sha256(canonicalJson(original)),load:async()=>original}}),/unproven/);
  assert.equal(f.counts().dispatches,0);assert.equal(f.scope().external_pending,0);
});
test('prune acceptance crossing target deadline can settle/release but never queues the expired revision',async t=>{
  const f=await setup(t,{prune:true,legacy:true});const prepared=await pruneExistingRevision(f.db,f.owner,f.request);const revision=prepared.revision;
  const kept=revision.snapshot.products[0];const original={publicId:kept.publicId,catalogRevision:'r1',sourceFactsHash:FACTS,embeddingTextHash:null,values:[...values],vectorBytesSha256:nativeHash(values)};
  const options={db:f.db,owner:prepared.owner,revision,publicId:kept.publicId,adapters:f.adapters,
    original:{sha256:sha256(canonicalJson(original)),load:async()=>original}};
  const first=await deliverOwnedPrunedVector(options);f.advance(2*86400000);
  await assert.rejects(abandonExpiredPrunedRevision(f.db,first.owner,revision)); // Unknown mutation must never be discarded.
  const expired=await deliverOwnedPrunedVector({...options,owner:first.owner});assert.equal(expired.state,'expired');
  assert.equal(f.counts().dispatches,1);assert.equal(f.scope().external_pending,0);
  await assert.rejects(readOwnedPrunedVectors(f.db,expired.owner,revision,f.adapters),/incomplete/);
  await assert.rejects(settlePrunedRevision(f.db,expired.owner,revision,()=>readOwnedPrunedVectors(f.db,expired.owner,revision,f.adapters)));
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_build_requests').get().n,0);
  f.lose(statements=>statements.some(s=>s.query.includes('SET abandonment_delivery_id=?')));
  const abandoned=await abandonExpiredPrunedRevision(f.db,expired.owner,revision);assert.equal(abandoned.state,'abandoned');
  assert.deepEqual(await abandonExpiredPrunedRevision(f.db,expired.owner,revision),abandoned);
  assert.equal(f.sql.prepare('SELECT status FROM catalog_revisions WHERE revision=?').get(revision.snapshot.catalogRevision).status,'importing');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM catalog_projection_receipts').get().n,2);
  await assert.rejects(pruneExistingRevision(f.db,abandoned.owner,revision.request),/abandoned|elapsed/);
  const later={...abandoned.owner,epoch:abandoned.owner.epoch+1};
  await f.db.batch([mutationAssertion(f.db,abandoned.owner,['freezing']),mutationAdvance(f.db,abandoned.owner,
    {sql:'SELECT 1 FROM catalog_revisions WHERE abandonment_delivery_id IS NOT NULL',params:[]}),mutationAssertion(f.db,later,['freezing'])]);
  await assert.rejects(abandonExpiredPrunedRevision(f.db,abandoned.owner,revision),/owner_changed/);
  assert.equal((await abandonExpiredPrunedRevision(f.db,later,revision)).owner.epoch,later.epoch);
  await releaseMutationOwnership(f.db,later);assert.equal(f.scope().phase,'idle');
  const nextRequest={...f.request,context:{...f.request.context,cutoff:at(2*86400000+6*3600000)}};
  const nextOwner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'new-daily-run',operationKey:pruneOperationKey(nextRequest)});
  const next=await pruneExistingRevision(f.db,nextOwner,nextRequest);assert.equal(next.state,'all_held');
  assert.notEqual(next.revision.snapshot.catalogRevision,revision.snapshot.catalogRevision);
  let current=next.owner;
  for(const publicId of f.previous.products.map(p=>p.publicId)){
    const options={db:f.db,owner:current,revision:next.revision,publicId,adapters:f.adapters};
    const first=await deliverOwnedPrunedVector(options);
    current=first.state==='pending'?(await deliverOwnedPrunedVector({...options,owner:first.owner})).owner:first.owner;
  }
  const queued=await settlePrunedRevision(f.db,current,next.revision,()=>readOwnedPrunedVectors(f.db,current,next.revision,f.adapters));
  const intent={releaseId:'replacement-release',codeSha:nextRequest.codeSha,catalogRevision:next.revision.snapshot.catalogRevision,
    catalogSnapshotSha256:next.revision.packet.receipt.snapshot_sha256,manifestSha256:'e'.repeat(64),vectorSyncWatermark:0,priorReleaseId:'prior',nextExpiry:null};
  const build=await claimBuildRequest(f.db,queued.requestId,'test-workflow',f.now());
  await enqueuePublication(f.db,next.revision.snapshot,intent,f.now());const publication=await claimPublication(f.db,next.revision.snapshot,intent.releaseId,f.now());
  await recordPublicationDispatch(f.db,next.revision.snapshot,publication,'test-dispatch',f.now());
  const before={environment:'staging',settled:true,active:{releaseId:f.priorIntent.releaseId,codeSha:f.priorIntent.codeSha,
    catalogRevision:f.priorIntent.catalogRevision,catalogSnapshotSha256:f.priorIntent.catalogSnapshotSha256,manifestSha256:f.priorIntent.manifestSha256,
    versionReference:'prior-version'}};
  const permit=await beginBuildActivation(f.db,build,next.revision.snapshot,publication,'test-uploaded-version',async()=>before,f.now(),queued.owner);
  assert.equal(permit.mutationOwner.phase,'activating');assert.equal(f.scope().external_pending,1); // Permission, not deployed/published.
});
