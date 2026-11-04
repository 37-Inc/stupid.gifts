import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { headroom, currentD1Plan, routineLimits, routineSearchPolicy, routineServingPrior, assertNoUnsealedMaintenance, operatorInvocation } from '../scripts/catalog/daily-operator.mjs';

test('scheduled identity prevents duplicate invocations while named runs can repeat on the same day',()=>{
  const calendar={day:'2026-11-02'};
  assert.deepEqual(operatorInvocation(['prepare'],calendar),{command:'prepare',approvalSha:undefined,runKey:'scheduled-2026-11-02'});
  assert.equal(operatorInvocation(['prepare','--run','fresh-discovery'],calendar).runKey,'fresh-discovery');
  assert.equal(operatorInvocation(['--run','fresh-discovery','publish','a'.repeat(64)],calendar).approvalSha,'a'.repeat(64));
  for(const args of [['prepare','--run'],['prepare','--run','../escape'],['start','extra'],
    ['prepare','--run','one','--run','two'],['publish'],['unknown']])assert.throws(()=>operatorInvocation(args,calendar),/routine_command/);
});

const usage = (rowsRead, rowsWritten) => async url => {
  assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
  return Response.json({data:{viewer:{accounts:[{d1AnalyticsAdaptiveGroups:[{sum:{rowsRead,rowsWritten}}]}]}}});
};
test('unpublished maintenance is detected before the next merchant batch',async()=>{
  let args;const rows=[];const db={prepare(sql){assert.match(sql,/catalog_maintenance_operations/);assert.match(sql,/generation>\?/);
    return {bind(...values){args=values;return {async all(){return {results:rows};}};}};}};
  const scope={environment:'production',indexName:'test-index'};
  await assertNoUnsealedMaintenance(db,{kind:'approved-catalog-seal',persistent:{generation:21}},scope);
  assert.deepEqual(args,['production','test-index',21]);
  rows.push({1:1});await assert.rejects(assertNoUnsealedMaintenance(db,{kind:'approved-catalog-seal',persistent:{generation:21}},scope),/unsealed_maintenance/);
  rows.length=0;await assertNoUnsealedMaintenance(db,{kind:'permanent-catalog-seal',control:{installationOwner:{generation:20}}},scope);
  assert.deepEqual(args,['production','test-index',21]);
  await assert.rejects(assertNoUnsealedMaintenance(db,{kind:'approved-catalog-seal',persistent:{}},scope),/prior_generation/);
});
test('preflight distinguishes recorded later product writes from old and unrelated operations',async()=>{
  const sql=new DatabaseSync(':memory:');try{
    sql.exec('CREATE TABLE catalog_maintenance_operations(environment TEXT,index_name TEXT,generation INTEGER,changes_json TEXT)');
    const add=sql.prepare('INSERT INTO catalog_maintenance_operations VALUES(?,?,?,?)');
    add.run('production','gifts',21,'[{"productId":"already-sealed"}]');
    add.run('production','gifts',22,'[]');
    add.run('production','other',23,'[{"productId":"other-project"}]');
    const db={prepare(query){return {bind(...values){return {async all(){return {results:sql.prepare(query).all(...values)};}};}};}};
    const seal={kind:'approved-catalog-seal',persistent:{generation:21}},scope={environment:'production',indexName:'gifts'};
    await assertNoUnsealedMaintenance(db,seal,scope);
    add.run('production','gifts',23,'[{"productId":"recovered-run"}]');
    await assert.rejects(assertNoUnsealedMaintenance(db,seal,scope),/unsealed_maintenance/);
  }finally{sql.close();}
});
test('preparation pins the settled storefront only when it serves the sealed catalog',async()=>{
  const seal={snapshotSha256:'a'.repeat(64),projectionReceipt:{catalog_revision:'catalog-one'}};
  const raw={release_id:'code-only',code_sha:'b'.repeat(40),catalog_revision:'catalog-one',
    catalog_snapshot_sha256:seal.snapshotSha256,manifest_sha256:'c'.repeat(64)};
  const version='01234567-89ab-cdef-0123-456789abcdef';
  const make=(identity=raw,second=version)=>{let calls=0;return async url=>{
    if(url.includes('catalog-release.json'))return Response.json(identity);
    return Response.json({success:true,result:{deployments:[{id:version,versions:[{version_id:++calls===1?version:second,percentage:100}]}]}});
  };};
  const result=await routineServingPrior('synthetic',seal,make());
  assert.equal(result.releaseId,'code-only');assert.equal(result.versionReference,version);
  await assert.rejects(routineServingPrior('synthetic',seal,make({...raw,catalog_snapshot_sha256:'d'.repeat(64)})),/serving_identity/);
  await assert.rejects(routineServingPrior('synthetic',seal,make(raw,'11234567-89ab-cdef-0123-456789abcdef')),/serving_identity/);
  await assert.rejects(routineServingPrior('synthetic',seal,make({...raw,extra:true})),/serving_identity/);
});
test('routine publication strips retired search budgets while preserving the verified index',()=>{
  assert.deepEqual(routineSearchPolicy(null),{enabled:false});
  const policy={enabled:true,dailyRequestCap:50,dailyTokenCap:32768,derivedCatalog:{
    path:'/Users/cameronehrlich/.codex/private/goose-gifts-migration/search/catalog.json',sha256:'a'.repeat(64),indexName:'stupid-gifts-semantic-v1'}};
  const current={enabled:true,derivedCatalog:policy.derivedCatalog};
  assert.deepEqual(routineSearchPolicy(policy),current);assert.deepEqual(routineSearchPolicy(current),current);
  for(const change of [{dailyRequestCap:51},{dailyTokenCap:32769},{enabled:false},{extra:true},
    {derivedCatalog:{...policy.derivedCatalog,indexName:'stupid-gifts-production'}},
    {derivedCatalog:{...policy.derivedCatalog,path:'/tmp/catalog.json'}},
    {derivedCatalog:{...policy.derivedCatalog,path:'/Users/cameronehrlich/.codex/private/goose-gifts-migration/../catalog.json'}}])
    assert.throws(()=>routineSearchPolicy({...policy,...change}),/semantic_policy/);
});
test('routine Free admission accepts an empty provider error array but refuses actual or malformed errors',async()=>{
  const send=errors=>async(...args)=>Response.json({...await(await usage(0,0)(...args)).json(),errors});
  assert.equal((await headroom('synthetic',undefined,null,send([]))).rowsRead,0);
  for(const errors of [[{message:'provider unavailable'}],{},'invalid'])
    await assert.rejects(headroom('synthetic',undefined,null,send(errors)),/headroom_unavailable/);
  await assert.rejects(headroom('synthetic',undefined,null,send([{extensions:{code:'budget'}}])),/headroom_rate_limited/);
  await headroom('synthetic',undefined,null,async(url,init)=>{
    assert.match(JSON.parse(init.body).query,/limit:1000,/);return usage(0,0)(url,init);
  });
  await assert.rejects(headroom('synthetic',undefined,null,async()=>Response.json({data:{viewer:{accounts:[{
    d1AnalyticsAdaptiveGroups:Array.from({length:1000},()=>({sum:{rowsRead:0,rowsWritten:0}}))}]}}})),/headroom_unavailable/);
});

test('routine Free admission includes remaining work, uncertainty, and untouched shared headroom',async()=>{
  const result=await headroom('synthetic',undefined,null,usage(2_000_000,20_000));
  assert.equal(result.rowsRead,2_000_000);
  assert.equal(result.untouchedReads,300_000);
  await assert.rejects(headroom('synthetic',undefined,null,usage(2_700_000,20_000)),/free_headroom/);
  await assert.rejects(headroom('synthetic',undefined,null,usage(2_000_000,56_000)),/free_headroom/);
});
test('settled work is not double charged but delayed analytics cannot erase it',async()=>{
  const spent={knownRowsRead:100_000,knownRowsWritten:1_000};
  await headroom('synthetic',spent,{rowsRead:2_000_000,rowsWritten:20_000},usage(2_100_000,21_000));
  await assert.rejects(headroom('synthetic',spent,{rowsRead:2_700_000,rowsWritten:20_000},usage(0,0)),/free_headroom/);
});
test('missing, malformed, exceeded or uncertain usage cannot authorize provider work',async()=>{
  for(const [read,write]of [[null,0],[0,null],[-1,0],[0,-1],[Number.MAX_SAFE_INTEGER+1,0]])
    await assert.rejects(headroom('synthetic',undefined,null,usage(read,write)),/headroom_invalid/);
  for(const spent of [{knownRowsRead:-1,knownRowsWritten:0},{knownRowsRead:1_500_001,knownRowsWritten:0},
    {knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:-1}])
    await assert.rejects(headroom('synthetic',spent,null,usage(0,0)),/run_budget_exceeded/);
});
test('historical unknowns remain charged but do not categorically prohibit current readback',async()=>{
  await headroom('synthetic',{knownRowsRead:100,knownRowsWritten:20,unconfirmedRequests:2},null,usage(100,20));
});
test('verified Standard uses measured finite full-catalog margin without relaxing Free or merchant limits',async()=>{
  assert.deepEqual(routineLimits('free'),{requests:5000,statements:12000,reportedRowsRead:1500000,reportedRowsWritten:30000});
  assert.deepEqual(routineLimits('standard'),{requests:6000,statements:12000,reportedRowsRead:3000000,reportedRowsWritten:40000});
  await headroom('synthetic',{knownRowsRead:1_830_000,knownRowsWritten:20_373},null,usage(30_000_000,200_000),'standard');
  await assert.rejects(headroom('synthetic',{knownRowsRead:3_000_001,knownRowsWritten:0},null,usage(0,0),'standard'),/run_budget_exceeded/);
  assert.throws(()=>routineLimits('unknown'),/plan_unavailable/);
});
test('provider-confirmed Standard skips obsolete Free account ceilings but keeps its finite run limit',async()=>{
  assert.equal(await currentD1Plan('synthetic',async()=>Response.json({success:true,result:{standard:true}})),'standard');
  assert.equal(await currentD1Plan('synthetic',async()=>Response.json({success:true,result:{standard:false}})),'free');
  await assert.rejects(currentD1Plan('synthetic',async()=>Response.json({success:true,result:{}})),/plan_unavailable/);
  await headroom('synthetic',undefined,null,usage(6_000_000,200_000),'standard');
  await assert.rejects(headroom('synthetic',undefined,null,usage(6_000_000,200_000),'free'),/free_headroom/);
  await assert.rejects(headroom('synthetic',{knownRowsRead:3_000_001,knownRowsWritten:0},null,usage(0,0),'standard'),/run_budget_exceeded/);
});
