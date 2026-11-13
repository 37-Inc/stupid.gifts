import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,realpath,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {openRunWorkspace,readRunWorkspace,readSavedAmazonObservation} from '../scripts/catalog/run-workspace.ts';
import {recordSuccessfulPublication,purgeCompletedWorkspaces} from '../scripts/catalog/purge-workspaces.ts';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';
import {encodeBuildRequest} from '../lib/catalog/build-requests.ts';
import {encodePublicationIntent} from '../lib/catalog/publication.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';

const NOW='2026-10-22T18:00:00.000Z',EXPIRED='2026-10-22T19:00:00.000Z',HASH='c'.repeat(64);
const scope={environment:'production',accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000001',databaseName:'fixture',workerName:'fixture',indexName:'fixture'};
const live=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Live network forbidden');};test.after(()=>{globalThis.fetch=live;});
async function fixture(t,{badPrivate=false,finalized=false,observations=[]}={}){
  const parent=await mkdtemp(join(await realpath(tmpdir()),'goose-successor-')),repository=join(parent,'source'),directory=join(parent,'workspace');
  await mkdir(repository,{mode:0o700});t.after(()=>rm(parent,{recursive:true,force:true}));
  let clock=NOW,calls=0,lose=false,afterRead;const handles=[];
  const options={directory,repository,runId:'fixture-run',codeSha:'a'.repeat(40),configSha256:HASH,scope,
    retention:{reviewReference:'test/only',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint'].map(k=>[k,{maxAgeMs:3600000,notAfter:EXPIRED}]))},
    budgetCaps:{httpRequests:50,sqlStatements:100},now:()=>clock};
  const w=await openRunWorkspace({...options,mode:'create'});handles.push(w);
  const unknown={id:'retained-unknown',requestSha256:HASH,units:{httpRequests:1,sqlStatements:0}};
  await w.reserveBudget(unknown);await w.settleBudget(unknown.id,{status:'unknown',usage:null});
  const artifact=await w.putArtifact({supplier:'TEST ONLY EXPIRED BODY'},{kind:'phase',observedAt:NOW});
  for(const receipt of observations)await w.saveReceipt({sha256:sha256(canonicalJson(receipt)),receipt});
  await w.preparePublicationDirectories('fixture-release',NOW,null);
  await mkdir(join(w.directory,'packages','fixture-release'),{mode:0o700});await writeFile(join(w.directory,'packages','fixture-release','body'),'TEST ONLY',{mode:0o600});
  const request={schemaVersion:1,environment:scope.environment,sourceRevision:'fixture-catalog',sourceDigest:HASH,codeSha:options.codeSha,
    priorReleaseId:null,capturedAt:NOW,cutoff:EXPIRED},requestId=sha256(encodeBuildRequest(request)),
    owner={environment:scope.environment,indexName:scope.indexName,token:'fixture-owner',generation:7,epoch:301,phase:'activating',ownerReference:'fixture-run/bulk',operationKey:HASH,capturedAt:NOW},
    intent={releaseId:'fixture-release',codeSha:options.codeSha,catalogRevision:request.sourceRevision,vectorSyncWatermark:0,priorReleaseId:null,
      nextExpiry:null,catalogSnapshotSha256:HASH,manifestSha256:HASH},
    privateReceipt={schemaVersion:1,environment:scope.environment,accountId:scope.accountId,workerName:scope.workerName,releaseId:intent.releaseId,
      versionReference:'fixture-version',requestId,intent},
    control={schemaVersion:1,configSha256:HASH,requestId,runReference:'fixture-run/bulk',stage:'published',build:{requestId,token:'fixture-build',runReference:'fixture-run/bulk',leaseUntil:EXPIRED,request},
      publication:{intentId:'fixture-intent',token:'fixture-publication',leaseUntil:EXPIRED,intent},intent,
      permit:{requestId,token:'fixture-build',runReference:'fixture-run/bulk',releaseId:intent.releaseId,versionReference:'fixture-version',mutationOwner:owner},
      vectorPlan:{catalogRevision:request.sourceRevision,planSha256:HASH,ids:[]},packageSha256:HASH,uploadMarker:'fixture-upload',
      versionReference:'fixture-version',deploymentMarker:'fixture-activation',deploymentId:'fixture-deployment',receiptSha256:sha256(canonicalJson(privateReceipt))};
  if(badPrivate)control.receiptSha256='f'.repeat(64);
  const cp=await w.writeCheckpoint(null,{phase:finalized?'finalized':'attention',owner:finalized?null:owner,state:{supplier:'TEST ONLY CHECKPOINT BODY'},pins:{artifact},phaseComplete:null,control:{publication:control}});
  const rows={receipt:{release_id:intent.releaseId,catalog_revision:intent.catalogRevision,code_sha:intent.codeSha,completed_at:NOW,manifest_json:encodePublicationIntent(intent)},
    build:{request_id:requestId,environment:scope.environment,source_revision:intent.catalogRevision,request_json:encodeBuildRequest(request),state:'resolved',lease_token:'fixture-build',lease_until:null,
      run_reference:control.runReference,release_id:intent.releaseId,version_reference:control.versionReference,error_code:null},
    scope:{environment:scope.environment,index_name:scope.indexName,generation:owner.generation,mutation_epoch:owner.epoch,phase:'idle',owner_token:null,owner_reference:null,operation_key:null,captured_at:null,external_pending:0,activation_request_id:null,observed_at:NOW}};
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.function('strftime',{varargs:true},()=>clock);
  for(const [key,table]of[['receipt','publication_receipts'],['build','catalog_build_requests'],['scope','catalog_mutation_scopes']]){
    const source={...rows[key]};if(key==='scope')delete source.observed_at;
    sql.exec(`CREATE TABLE ${table} (${Object.keys(source).map(k=>`${k}`).join(',')})`);
    sql.prepare(`INSERT INTO ${table} VALUES (${Object.keys(source).map(()=>'?').join(',')})`).run(...Object.values(source));
  }
  const accounting={scope:{accountId:scope.accountId,databaseId:scope.databaseId,databaseName:scope.databaseName},initial:await w.budget(),
    async reserve(r){const root=join(w.directory,'publication-recovery-bounds');await mkdir(root,{mode:0o700,recursive:true});
      await writeFile(join(root,r.id+'.json'),canonicalJson({schemaVersion:1,kind:'publication-recovery-reservation-bound',recoveryBudgetSha256:HASH,helperSha256:HASH,
        bound:{id:r.id,requestSha256:r.requestSha256,sqlStatements:r.units.sqlStatements,statementSha256s:Array(r.units.sqlStatements).fill(HASH),rowsReadBound:r.units.sqlStatements*10,rowsWrittenBound:0}})+'\n',{mode:0o600,flag:'wx'});
      await w.reserveBudget(r);},settle:(id,s)=>w.settleBudget(id,s)};
  const db=await createCatalogD1Rest({...accounting.scope,token:'SYNTHETIC',accounting,fetch:async(_url,init)=>{calls++;
    if(!init.body)return Response.json({success:true,result:{uuid:scope.databaseId,name:scope.databaseName,read_replication:{mode:'disabled'}}});
    if(lose)throw Error('Synthetic lost read');
    const result=JSON.parse(init.body).batch.map(q=>{assert.match(q.sql,/^SELECT\b/);return{success:true,results:sql.prepare(q.sql).all(...q.params).map(r=>({...r})),meta:{served_by_primary:true,rows_read:1,rows_written:0}};});
    await afterRead?.();return Response.json({success:true,result});}});
  const input={workspace:w,db,expectedCheckpointSha256:cp.sha256,receiptSha256:sha256(canonicalJson(rows.receipt)),configSha256:HASH,packageSha256:HASH};
  t.after(async()=>{for(const h of handles)try{await h.close();}catch{}});
  return{w,db,rows,sql,input,artifact,cp,options,calls:()=>calls,setNow(v){clock=v;},lose(){lose=true;},after(fn){afterRead=fn;},
    async reopen(){const h=await openRunWorkspace({...options,mode:'resume'});handles.push(h);return h;}};
}

test('saved admission reader authenticates accepted original receipt without locks, writes or renewed retention',async t=>{
  const id='B0FMXQJW2V',snapshot={title:'TEST ONLY solar peeing dog',imageUrl:'https://example.invalid/dog.jpg',sourceFacts:{shape:'dog'}},
    receipt={schemaVersion:1,kind:'amazon-observation',operation:'getItems',observedAt:NOW,requestedIds:[id],returnedIds:[id],products:[{
      id,availabilityStatus:'IN_STOCK',snapshot,sourceFactsHash:sha256(canonicalJson(snapshot))}]};
  const f=await fixture(t,{finalized:true,observations:[receipt]});
  await recordSuccessfulPublication(f.input);await f.w.close();
  const before=await readRunWorkspace({...f.options,mode:'resume'}),events=await readdir(join(f.w.directory,'events'));
  const saved=await readSavedAmazonObservation({...f.options,mode:'resume'},[id]);
  assert.deepEqual(saved.receipt,receipt);assert.equal(saved.expiresAt,EXPIRED);assert.equal(saved.receipt.observedAt,NOW);
  assert.deepEqual(await readdir(join(f.w.directory,'events')),events);
  assert.deepEqual((await readRunWorkspace({...f.options,mode:'resume'})).budget,before.budget);
  await assert.rejects(readSavedAmazonObservation({...f.options,mode:'resume',now:()=>EXPIRED},[id]),/expired/);
});
test('saved admission cannot resurrect a later omitted gift or read an unfinished run',async t=>{
  const id='B0FMXQJW2V',receipt={schemaVersion:1,kind:'amazon-observation',operation:'getItems',observedAt:NOW,requestedIds:[id],returnedIds:[],products:[]};
  const f=await fixture(t,{finalized:true,observations:[receipt]});await recordSuccessfulPublication(f.input);await f.w.close();
  await assert.rejects(readSavedAmazonObservation({...f.options,mode:'resume'},[id]),/saved_admission_missing/);
  const unfinished=await fixture(t);await unfinished.w.close();
  await assert.rejects(readSavedAmazonObservation({...unfinished.options,mode:'resume'},[id]),/saved_admission_not_accepted/);
});
test('cold hosted saved-admission cache restores original durable evidence with zero remote writes',async t=>{
  const id='B0FMXQJW2V',receipt={schemaVersion:1,kind:'amazon-observation',operation:'getItems',observedAt:NOW,
    requestedIds:[id],returnedIds:[id],products:[{id,availabilityStatus:'IN_STOCK',sourceFactsHash:HASH,
      snapshot:{title:'TEST ONLY dog',imageUrl:'https://example.invalid/dog.jpg',sourceFacts:{shape:'dog'}}}]};
  const f=await fixture(t,{finalized:true,observations:[receipt]});await recordSuccessfulPublication(f.input);await f.w.close();
  const remote=new Map();
  async function collect(dir,relative=''){
    for(const entry of await readdir(dir,{withFileTypes:true})){
      const name=relative+entry.name,file=join(dir,entry.name);
      if(entry.isDirectory())await collect(file,name+'/');else remote.set('runs/fixture-run/'+name,await readFile(file));
    }
  }
  await collect(f.w.directory);
  const directory=f.options.directory+'-cold',run=join(directory,'runs','fixture-run');
  await mkdir(run,{recursive:true,mode:0o700});
  // Retained synthetic recovery metadata is distinct from provider body cache.
  await cp(join(f.w.directory,'publication-recovery-bounds'),join(run,'publication-recovery-bounds'),{recursive:true});
  const durable={get:async key=>remote.has(key)?{bytes:remote.get(key),etag:'fixed-original'}:null,
    listJournal:async()=>[...remote.keys()].filter(k=>k.includes('/events/')).map(k=>k.slice('runs/fixture-run/'.length)),
    putImmutable:async()=>{throw Error('must not write original remote run');},
    compareAndSwap:async()=>{throw Error('must not change original head');},remove:async()=>{throw Error('must not purge');}};
  const saved=await readSavedAmazonObservation({...f.options,directory,mode:'resume',durable},[id]);
  assert.deepEqual(saved.receipt,receipt);assert.equal(saved.expiresAt,EXPIRED);
  assert.deepEqual(await readdir(join(directory,'locks')),[]);
  assert.deepEqual((await readRunWorkspace({...f.options,directory,mode:'resume',durable})).budget,
    (await readRunWorkspace({...f.options,mode:'resume'})).budget);
});

test('actual accounted resolved/idle snapshot records body-free success; expired registered bodies purge without rewriting old controls or charges',async t=>{
  const f=await fixture(t),summary={counts:{refreshed:2},timingsMs:{},usage:null,warnings:[]};
  const control=await f.w.putPublicationControl('summary',summary);
  const before=await f.w.readCheckpoint({controlOnly:true}),oldBudget=await f.w.budget(),proof=await recordSuccessfulPublication(f.input);
  assert.equal(proof.scope.mutation_epoch,301);assert.equal(proof.scope.generation,7);assert.equal(proof.build.state,'resolved');
  assert.equal(proof.usage.unconfirmedRequests,1);assert.equal(proof.usage.httpRequests,oldBudget.httpRequests+1);assert.equal(proof.usage.sqlStatements,oldBudget.sqlStatements+3);
  assert.deepEqual(await f.w.readCheckpoint({controlOnly:true}),before);assert.ok(!JSON.stringify(proof).includes('TEST ONLY'));
  const calls=f.calls();assert.deepEqual(await recordSuccessfulPublication(f.input),proof);assert.equal(f.calls(),calls);
  await assert.rejects(f.w.reserveBudget({id:'never-dispatch',requestSha256:HASH,units:{httpRequests:1,sqlStatements:0}}),/publication_completed/);
  await assert.rejects(f.w.preparePublicationDirectories('fixture-release',NOW,null),/publication_completed/);
  const metadata=await readdir(join(f.w.directory,'publication-recovery-bounds'));await f.w.close();f.setNow(EXPIRED);
  const report=await purgeCompletedWorkspaces({directory:f.options.directory,repository:f.options.repository,now:()=>EXPIRED});
  assert.equal(report.reviewRequired,false);assert.equal(report.runs[0].state,'cleaned');assert.ok(report.runs[0].purged>0);
  const status=await readRunWorkspace({...f.options,mode:'resume'});assert.deepEqual(status.checkpoint,before);assert.deepEqual(status.budget,proof.usage);assert.deepEqual(status.successfulPublication,proof);
  assert.deepEqual(await readdir(join(f.w.directory,'objects')),[]);assert.deepEqual(await readdir(join(f.w.directory,'publication-recovery-bounds')),metadata);
  const again=await purgeCompletedWorkspaces({directory:f.options.directory,repository:f.options.repository,now:()=>EXPIRED});assert.equal(again.runs[0].state,'retained');
  const resumed=await f.reopen();assert.deepEqual(await resumed.publicationSuccess(),proof);await assert.rejects(resumed.readArtifact(f.artifact),/expired/);
  assert.deepEqual(await resumed.readArtifact(control),summary);
  assert.deepEqual(await recordSuccessfulPublication({...f.input,workspace:resumed}),proof);assert.equal(f.calls(),calls);
});

test('foreign, unresolved, nonidle, wrong epoch, forged receipt/config/package, stale clock and checkpoint drift refuse without a success event',async t=>{
  for(const fault of ['foreign','build','scope','epoch','receipt-time','config','package','stale','future','checkpoint','private-receipt'])await t.test(fault,async t=>{
    const f=await fixture(t,{badPrivate:fault==='private-receipt'}),input={...f.input};
    if(fault==='foreign')input.db={...f.db,providerIdentity:'foreign'};
    if(fault==='build')f.sql.exec("UPDATE catalog_build_requests SET state='activating'");
    if(fault==='scope')f.sql.exec("UPDATE catalog_mutation_scopes SET phase='activating',external_pending=1");
    if(fault==='epoch')f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=302');
    if(fault==='receipt-time')f.sql.exec("UPDATE publication_receipts SET completed_at='2026-10-22T18:00:00.001Z'");
    if(fault==='config')input.configSha256='f'.repeat(64);if(fault==='package')input.packageSha256='f'.repeat(64);
    if(fault==='stale')f.sql.function('strftime',{varargs:true},()=>'2026-10-22T17:59:00.000Z');
    if(fault==='future')f.sql.function('strftime',{varargs:true},()=>'2026-10-22T18:01:00.000Z');
    if(fault==='checkpoint')input.expectedCheckpointSha256='f'.repeat(64);
    await assert.rejects(recordSuccessfulPublication(input));assert.equal(await f.w.publicationSuccess(),null);
  });
});

test('new unknown or unaccounted observation never establishes success; later pending charge cannot be ignored',async t=>{
  const f=await fixture(t);f.lose();await assert.rejects(recordSuccessfulPublication(f.input),/result_unknown/);
  assert.equal((await f.w.budget()).unconfirmedRequests,2);assert.equal(await f.w.publicationSuccess(),null);
  const g=await fixture(t);g.after(async()=>{await g.w.reserveBudget({id:'late-pending',requestSha256:HASH,units:{httpRequests:1,sqlStatements:0}});});
  await assert.rejects(recordSuccessfulPublication(g.input));assert.equal(await g.w.publicationSuccess(),null);
});

test('a charge after observation but before completion cannot be hidden, known, pending or unknown',async t=>{
  for(const status of ['known','pending','unknown'])await t.test(status,async t=>{
    const f=await fixture(t),w={...f.w,async recordPublicationSuccess(proof){
      await f.w.reserveBudget({id:'late-charge',requestSha256:HASH,units:{httpRequests:1,sqlStatements:0}});
      if(status!=='pending')await f.w.settleBudget('late-charge',status==='known'?{status:'known',usage:{rowsRead:0,rowsWritten:0}}:{status:'unknown',usage:null});
      return f.w.recordPublicationSuccess(proof);
    }};
    await assert.rejects(recordSuccessfulPublication({...f.input,workspace:w}),/publication_success/);assert.equal(await f.w.publicationSuccess(),null);
    assert.equal((await f.w.budget()).unconfirmedRequests,status==='known'?1:2);
  });
});

test('a numerically unchanged pending-to-unknown transition after observation fails the exact journal CAS',async t=>{
  const f=await fixture(t);await f.w.reserveBudget({id:'prior-pending',requestSha256:HASH,units:{httpRequests:1,sqlStatements:0}});
  const w={...f.w,async recordPublicationSuccess(proof){
    await f.w.settleBudget('prior-pending',{status:'unknown',usage:null});
    assert.deepEqual(await f.w.budget(),proof.usage);return f.w.recordPublicationSuccess(proof);
  }};
  await assert.rejects(recordSuccessfulPublication({...f.input,workspace:w}),/publication_success/);assert.equal(await f.w.publicationSuccess(),null);
});

test('registered metadata is preserved, not trusted by name; mutations/unknown files hold cleanup before any deletion',async t=>{
  for(const fault of ['changed','extra'])await t.test(fault,async t=>{
    const f=await fixture(t);await recordSuccessfulPublication(f.input);
    const root=join(f.w.directory,'publication-recovery-bounds'),names=await readdir(root);
    if(fault==='changed'){const file=join(root,names[0]),value=JSON.parse(await readFile(file));value.helperSha256='f'.repeat(64);await writeFile(file,canonicalJson(value)+'\n',{mode:0o600});}
    else await writeFile(join(root,randomUUID()+'.json'),'{}\n',{mode:0o600});
    await f.w.close();const before=await readdir(join(f.w.directory,'objects'));
    const report=await purgeCompletedWorkspaces({directory:f.options.directory,repository:f.options.repository,now:()=>EXPIRED});
    assert.equal(report.reviewRequired,true);assert.equal(report.runs[0].purged,0);assert.deepEqual(await readdir(join(f.w.directory,'objects')),before);
  });
});
