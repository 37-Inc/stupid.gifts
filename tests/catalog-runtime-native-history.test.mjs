import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './helpers/published-vector-fixture.mjs';
import {prunedVectorPlan,prunedVectorIds} from '../lib/catalog/prune-existing-revision.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {readNativeHistory} from '../scripts/catalog/owned-vector-delivery.ts';

for(const fullPlan of [false,true])test(`runtime native history accepts genuine ${fullPlan?'plan':'reuse'} receipts without a Worker version`,async t=>{
  const f=await setup(t,{fullPlan}),intent=f.original.intent,plan=prunedVectorPlan(f.revision);
  const history=[{source:f.published.source,revisionSha256:sha256(canonicalJson(f.revision)),
    planSha256:sha256(canonicalJson(plan)),ids:prunedVectorIds(plan)}];
  const read=(db=f.db)=>readNativeHistory({db,owner:f.owner,history,adapters:f.adapters});
  let reads=0;
  const accepted=()=>readNativeHistory({db:f.db,owner:f.owner,history,acceptedOnly:true,
    adapters:{...f.adapters,async readback(){reads++;throw Error('unchanged history must not refetch vectors');}}});
  if(!fullPlan)assert.deepEqual(await accepted(),history[0].ids,'preserve original legacy dispatch-reference semantics');
  f.sql.prepare('UPDATE publication_outbox SET dispatch_reference=? WHERE release_id=?')
    .run('version:'+f.original.permit.versionReference,intent.releaseId);
  assert.deepEqual(await read(),history[0].ids);
  assert.deepEqual(await accepted(),history[0].ids);assert.equal(reads,0);
  const build=f.sql.prepare('SELECT * FROM catalog_build_requests WHERE release_id=?').get(intent.releaseId);
  f.sql.prepare('UPDATE catalog_build_requests SET version_reference=NULL,dispatch_reference=? WHERE request_id=?')
    .run('runtime:'+intent.manifestSha256,build.request_id);
  f.sql.prepare('UPDATE publication_outbox SET dispatch_reference=? WHERE release_id=?')
    .run('runtime:'+intent.manifestSha256,intent.releaseId);
  await assert.rejects(read(),'runtime-looking dispatch is not sufficient proof');
  await assert.rejects(accepted(),'accepted-history mode still needs the actual resolved runtime receipt');
  f.sql.prepare(`INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,
    public_snapshot_sha256,request_id,owner_json,previous_release_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(intent.releaseId,intent.catalogRevision,intent.manifestSha256,intent.catalogSnapshotSha256,
      intent.catalogSnapshotSha256,build.request_id,canonicalJson(f.owner),intent.priorReleaseId,f.now().toISOString());
  // Historical receipts remain valid after the head advances. No current-head
  // requirement, new source observation, vector write or provider replay.
  const changes=f.sql.prepare('SELECT total_changes() n').get().n,before=canonicalJson([...f.index]),dispatches=f.dispatches();
  assert.deepEqual(await read(),history[0].ids);
  assert.deepEqual(await accepted(),history[0].ids);assert.equal(reads,0);
  for(const key of ['request_id','catalog_revision','data_sha256','source_snapshot_sha256','previous_release_id']){
    const db={...f.db,prepare(sql){const original=f.db.prepare(sql);
      if(sql!=='SELECT * FROM catalog_runtime_publications WHERE release_id=?')return original;
      return{bind(...values){original.bind(...values);return this;},async all(options){
        const result=await original.all(options);return{...result,results:result.results.map(row=>({...row,[key]:'wrong'}))};}};}};
    await assert.rejects(read(db),/vector_(history|preserved_receipt)_changed/);
  }
  f.sql.prepare('UPDATE catalog_build_requests SET dispatch_reference=? WHERE request_id=?').run('runtime:'+'0'.repeat(64),build.request_id);
  await assert.rejects(read());
  await assert.rejects(accepted());
  assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,changes+1);
  assert.equal(canonicalJson([...f.index]),before);assert.equal(f.dispatches(),dispatches);
});
