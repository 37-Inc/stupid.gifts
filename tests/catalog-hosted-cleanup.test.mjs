import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHostedCleanup,registerHostedWorkspaceCleanup,cleanupHostedRuns} from '../scripts/catalog/hosted-cleanup.mjs';
import {CATALOG_SCOPE as scope} from '../scripts/catalog/automation-runtime.mjs';
import {CATALOG_ENVIRONMENT_CREDENTIALS} from '../scripts/catalog/credential-reference.ts';
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
const NOW='2026-11-06T12:00:00.000Z',DUE='2026-11-07T12:00:00.000Z',SOURCE='a'.repeat(40),HASH='b'.repeat(64);
function fixture(){
  const files=new Map(),objects=new Map();let pointer=null,opened=0,purged=0,retained=false;
  const runtime={hosted:true,care:'/home/runner/.codex/private/goose-gifts-migration/daily-catalog-care',workspace:'/home/runner/.codex/private/goose-gifts-migration/weekly-runs',
    durable:{get:async k=>objects.get(k)??null},state:{bytes:async f=>files.get(f),
      readPointer:async()=>{if(pointer)return pointer;const e=Error('missing');e.code='ENOENT';throw e;},
      pointer:async(name,file,v,expected)=>{assert.equal(name,'cleanup-runs');assert.deepEqual(pointer,expected);pointer=bytes(v);return pointer;}}};
  const record={schemaVersion:1,runKey:'canary-2026-11-06-B000000001',kind:'canary',canaryId:'B000000001',day:'2026-11-06',source:SOURCE,
    inputsRef:{schemaVersion:1,key:'inputs/'+HASH+'.json',sha256:HASH}},dir=runtime.care+'/runs/'+record.runKey;
  const repository='/home/runner/stupid-gifts/operators/'+SOURCE,ref={path:'/private/fixture.json',sha256:HASH,observedAt:NOW};
  const credentials=Object.fromEntries(Object.entries(CATALOG_ENVIRONMENT_CREDENTIALS).map(([role,name])=>[role,{type:'environment',name}]));
  const config={schemaVersion:1,runId:'fixture-run',catalogRevision:'fixture-run',codeSha:SOURCE,environment:scope.environment,accountId:scope.accountId,
    database:{id:scope.databaseId,name:scope.databaseName},vectorIndex:{name:scope.indexName,dimensions:1536,metric:'cosine'},catalog:{associateTag:'goose-gifts-37-20',marketplace:'www.amazon.com'},
    credentials:{...credentials,amazonVersion:'3.3'},limits:{requests:6000,statements:12000},backfillLimit:1,inputs:{previous:ref,context:ref,rights:ref},
    retention:{reviewReference:'test-only/original',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint'].map(k=>[k,{maxAgeMs:86400000,notAfter:'2026-11-08T12:00:00.000Z'}]))},
    publication:{schemaVersion:1,environment:scope.environment,accountId:scope.accountId,workerName:scope.workerName,database:{id:scope.databaseId,name:scope.databaseName},
      indexName:scope.indexName,codeSha:SOURCE,sourceMode:'stupid-production',sourceRoot:repository,releaseId:'fixture-run',identityOrigin:'https://stupid.gifts',compatibilityDate:'2026-10-19',prior:null}};
  files.set(dir+'/hosted-run.json',bytes(record));files.set(dir+'/config.json',bytes(config));
  files.set(dir+'/operator.json',bytes({source:SOURCE,runId:config.runId,configPath:dir+'/config.json',configSha256:hash(bytes(config))}));
  objects.set('runs/'+config.runId+'/manifest.json',{bytes:bytes({schemaVersion:1,runId:config.runId,codeSha:SOURCE,configSha256:hash(bytes(config)),retention:config.retention,
    scope,budgetCaps:{httpRequests:6000,sqlStatements:12000},createdAt:NOW})});
  const open=async options=>{opened++;assert.equal(options.repository,repository);assert.equal(options.runId,config.runId);assert.equal(options.codeSha,SOURCE);
    return{readCheckpoint:async()=>({checkpoint:{phase:'finalized',owner:null}}),publicationSuccess:async()=>({original:true}),
      purgeExpired:async()=>{purged++;return[{reference:'objects/registered-original.json'}];},retainedBodies:async()=>retained,close:async()=>{}};};
  return{runtime,record,repository,files,objects,open,pointer:()=>pointer,opened:()=>opened,purged:()=>purged,setRetained:v=>{retained=v;}};
}
test('accepted original run is registered idempotently with its original first expiry, not a renewed deadline',async()=>{
  const f=fixture();await registerHostedCleanup(f.runtime,f.record);const before=f.pointer();await registerHostedCleanup(f.runtime,f.record);
  assert.deepEqual(f.pointer(),before);assert.equal(JSON.parse(before).runs[0].dueAt,DUE);
  const result=await cleanupHostedRuns(f.runtime,()=>{throw Error('not due');},{now:()=>NOW,open:f.open});assert.equal(result.state,'current');assert.equal(f.opened(),0);
});
test('due housekeeping uses only original source/config; unexpired bodies retain the queue, all-purged clears it',async()=>{
  const f=fixture();await registerHostedCleanup(f.runtime,f.record);f.setRetained(true);
  const checkout=async source=>{assert.equal(source,SOURCE);return f.repository;};
  assert.equal((await cleanupHostedRuns(f.runtime,checkout,{now:()=>DUE,open:f.open})).remaining,true);
  assert.equal(JSON.parse(f.pointer()).runs.length,1);f.setRetained(false);
  assert.equal((await cleanupHostedRuns(f.runtime,checkout,{now:()=>DUE,open:f.open})).remaining,false);
  assert.equal(JSON.parse(f.pointer()).runs.length,0);assert.equal(f.purged(),2);
  assert.ok(f.files.has(f.runtime.care+'/runs/'+f.record.runKey+'/operator.json'));
});
test('failed or changed housekeeping leaves the exact registration available for retry, never substitutes source',async()=>{
  const f=fixture();await registerHostedCleanup(f.runtime,f.record);const before=f.pointer();
  await assert.rejects(cleanupHostedRuns(f.runtime,async()=>f.repository,{now:()=>DUE,open:async()=>{throw Error('storage unavailable');}}));
  assert.deepEqual(f.pointer(),before);
  await assert.rejects(cleanupHostedRuns(f.runtime,async()=>'/different-source',{now:()=>DUE,open:f.open}),/cleanup_identity/);assert.equal(f.opened(),0);
  const key='runs/fixture-run/manifest.json',object=f.objects.get(key);f.objects.set(key,{bytes:bytes({...JSON.parse(object.bytes),codeSha:'c'.repeat(40)})});
  await assert.rejects(cleanupHostedRuns(f.runtime,async()=>f.repository,{now:()=>DUE,open:f.open}),/cleanup_identity/);assert.deepEqual(f.pointer(),before);
});
test('optional homepage journals use the same original-manifest queue and cleanup, without requiring a catalog receipt',async()=>{
  const f=fixture(),manifest=JSON.parse(f.objects.get('runs/fixture-run/manifest.json').bytes),runId='homepage-2026-11-06-'+SOURCE.slice(0,8);
  manifest.runId=runId;manifest.retention.reviewReference='catalog-automation-spec/homepage-v1';f.objects.set('runs/'+runId+'/manifest.json',{bytes:bytes(manifest)});
  await registerHostedWorkspaceCleanup(f.runtime,manifest);let purged=false;
  const result=await cleanupHostedRuns(f.runtime,async()=>f.repository,{now:()=>DUE,open:async options=>{
    assert.equal(options.runId,runId);return{readCheckpoint:async()=>({checkpoint:{phase:'editing',owner:null}}),
      publicationSuccess:async()=>{throw Error('not a catalog publication');},purgeExpired:async()=>{purged=true;return[];},retainedBodies:async()=>false,close:async()=>{}};}});
  assert.equal(result.state,'cleaned');assert.equal(purged,true);assert.equal(JSON.parse(f.pointer()).runs.length,0);
});
test('a failed old cleanup retains its identity but does not starve another due workspace',async()=>{
  const f=fixture();await registerHostedCleanup(f.runtime,f.record);
  const second={...JSON.parse(f.objects.get('runs/fixture-run/manifest.json').bytes),runId:'second-original'};
  f.objects.set('runs/second-original/manifest.json',{bytes:bytes(second)});await registerHostedWorkspaceCleanup(f.runtime,second);
  await assert.rejects(cleanupHostedRuns(f.runtime,async()=>{throw Error('old source unavailable');},{now:()=>DUE,open:f.open}));
  assert.deepEqual(JSON.parse(f.pointer()).runs.map(r=>r.runId),['second-original','fixture-run']);assert.equal(f.purged(),0);
});
