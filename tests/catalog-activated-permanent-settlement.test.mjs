import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir,realpath} from 'node:fs/promises';
import {settleActivatedPermanentWeekly} from '../scripts/catalog/run-cloudflare-weekly.ts';
import {approvedRevisionControl,catalogSuccessorBytes,createPublishedApprovedCatalogSeal,createPublishedApprovedCatalogSealFromControl} from '../scripts/catalog/approved-catalog-seal.ts';
import {createProjectionPacket} from '../lib/catalog/d1.ts';
import {encodePublicationIntent} from '../lib/catalog/publication.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {executePublication} from '../scripts/catalog/publish-release.ts';
import {prunedVectorIds,prunedVectorPlan} from '../lib/catalog/prune-existing-revision.ts';

// Local proof only: real telemetry/fence SQLite, purpose-limited expired-control
// seam, and exact technical native/publication rows. No external provider calls.
const OLD='2026-10-24T15:32:15.176Z',CUTOFF='2026-10-24T17:32:15.176Z',NOW='2026-10-26T12:00:00.000Z';
const RUN='synthetic-maintenance-run',RELEASE='synthetic-distinct-release',CODE='1'.repeat(40),HASH='2'.repeat(64);
const UUID='00000000-0000-4000-8000-000000000001';
const scope={environment:'production',indexName:'synthetic'};
const network=globalThis.fetch;globalThis.fetch=async()=>{throw Error('Live network forbidden');};
test.after(()=>{globalThis.fetch=network;});

test('weekly driver awaits settlement before its finally closes the protected workspace',async()=>{
  const source=await readFile(new URL('../scripts/catalog/run-cloudflare-weekly.ts',import.meta.url),'utf8');
  assert.match(source,/if\(permanentFinalization\)return await settleActivatedPermanentWeekly\(/);
  assert.match(source,/finally\{try\{await workspace\?\.close\(\)/);
});

test('explicit terminal settlement without its existing authority fails before provider or D1 access',async()=>{
  const sourceRoot=await realpath(new URL('..',import.meta.url)),accountId='a'.repeat(32);
  const config={schemaVersion:1,environment:'production',accountId,workerName:'synthetic-worker',database:{id:UUID,name:'synthetic'},
    indexName:scope.indexName,codeSha:CODE,sourceMode:'stupid-production',sourceRoot,releaseId:RELEASE,
    identityOrigin:'https://stupid.gifts',compatibilityDate:'2026-10-19',prior:null};
  let external=0,sql=0,writes=0;
  const owner={...scope,token:'synthetic-owner',generation:17,epoch:441,phase:'activating',ownerReference:RUN,operationKey:HASH,capturedAt:OLD};
  const ref={sha256:HASH,reference:`objects/${HASH}.json`};
  for(const fault of ['permit','authorization','transport','admission','finite','revision']){
    const publication={intent:{nextExpiry:fault==='finite'?CUTOFF:null},permit:fault==='permit'?null:{mutationOwner:owner}};
    const reviewedUploadRetry={approval:{schemaVersion:4,requestId:HASH,packageSha256:HASH,configSha256:HASH,checkpointSha256:HASH,
      reviewPinSha256:HASH,evidenceSha256:HASH,reviewReference:'synthetic/original-review',reviewedAt:OLD,authorizationSha256:HASH},
      evidence:ref,...(fault==='transport'?{}:{transport:{previous:ref}})};
    const finishAuthorization={authorizationSha256:HASH,reviewedAt:'2026-10-25T00:00:00.000Z',
      activationDeadline:'2026-10-25T02:00:00.000Z',versionReference:'00000000-0000-4000-8000-000000000002'};
    const workspace={repository:sourceRoot,directory:'/synthetic-unused-package',manifest:{codeSha:CODE},async assertHeld(){},async assertScope(){},
      async readCheckpoint(){return{sha256:HASH,checkpoint:{pins:{},control:{publication}}};},
      async budgetRowsReadCeiling(){return fault==='admission'?null:2341389;},async writeControlCheckpoint(){writes++;throw Error('Control writes forbidden');}};
    const db={providerIdentity:`cloudflare:${accountId}:${UUID}`,prepare(){sql++;throw Error('D1 access forbidden');}};
    const run=()=>executePublication({db,workspace,owner,revision:fault==='revision'?{}:null,acceptedReceiptOnly:true,requestId:HASH,runReference:RUN,config,
      reviewedUploadRetry,...(fault==='authorization'?{}:{finishAuthorization}),
      credentials:{cloudflareToken:'SYNTHETIC_ONLY'},dependencies:{async fetch(){external++;throw Error('Provider access forbidden');}}});
    if(fault==='transport'){await assert.rejects(run(),/publication_finish_authorization_invalid/);continue;}
    const result=await run();
    assert.equal(result.state,'pending',fault);assert.equal(result.errorCode,'publication_receipt_settlement_scope',fault);
  }
  assert.equal(external,0);assert.equal(sql,0);assert.equal(writes,0);
});

async function sealFixture({historyOnly=false,overlay=false}={}){
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:'synthetic-catalog',generatedAt:OLD,
    products:[{id:'B000000001',publicId:UUID,slug:'owned-fixture',source:'amazon',title:'Owned fixture gift',
      description:'An independently owned fixture description.',imageUrl:'/images/gift-placeholder.svg',
      affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=fixture-20',currency:'USD',price:0,isActive:true,
      qualityScore:.8,eligibleUntil:null,indexable:false}],heldProducts:[],slugHistory:[]};
  if(overlay){const base=structuredClone(snapshot.products[0]);snapshot.products[0]={...base,
    imageUrl:'https://example.invalid/original-finite-photo.jpg',eligibleUntil:CUTOFF,persistent:base};}
  const packet=await createProjectionPacket(snapshot,{[UUID]:HASH},HASH,new Date(OLD));
  const intent={releaseId:RELEASE,codeSha:CODE,catalogRevision:snapshot.catalogRevision,catalogSnapshotSha256:packet.receipt.snapshot_sha256,
    manifestSha256:HASH,vectorSyncWatermark:0,priorReleaseId:'synthetic-prior',nextExpiry:null};
  const priorIntent={...intent,releaseId:'synthetic-prior',catalogRevision:'prior-catalog',priorReleaseId:null};
  const priorRow={release_id:'synthetic-prior',catalog_revision:'prior-catalog',code_sha:CODE,completed_at:OLD,manifest_json:encodePublicationIntent(priorIntent)};
  const inventory=[{publicId:UUID,sourceRowSha256:HASH,productSha256:HASH,privateStateSha256:HASH}];
  const history=historyOnly?[{source:{releaseId:'synthetic-prior',receiptSha256:HASH,deliveryId:'4'.repeat(64),deliverySha256:'5'.repeat(64)},
    revisionSha256:'6'.repeat(64),planSha256:'7'.repeat(64),ids:[UUID]}]:[];
  const revision={snapshot,packet,priorRow,sourceDigest:HASH,globalVectorWatermark:0,vectorSyncWatermark:0,operationKey:HASH,
    persistent:{generation:17,inventory,nativeHistory:history},nativeHistory:history,sourceRows:[{public_id:UUID}],
    request:{scope,codeSha:CODE,context:{snapshotSha256:HASH,cutoff:CUTOFF,priorPublication:{releaseId:'synthetic-prior',receiptSha256:HASH}},
      previous:snapshot,approval:{schemaVersion:1,runId:RUN,catalogRevision:snapshot.catalogRevision,changes:[]},approvalSha256:HASH}};
  const control=approvedRevisionControl(revision),plan=historyOnly?prunedVectorPlan(revision):{products:[{publicId:UUID}],absentIds:[]},planSha256=sha256(canonicalJson(plan));
  const native={delivery_id:'3'.repeat(64),request_json:JSON.stringify({revisionSha256:control.revisionSha256,planSha256,plan})};
  const receipt={release_id:RELEASE,catalog_revision:snapshot.catalogRevision,code_sha:CODE,completed_at:OLD,manifest_json:encodePublicationIntent(intent)};
  const publication={releaseId:RELEASE,receiptSha256:sha256(canonicalJson(receipt))};
  const vectorPlan={catalogRevision:snapshot.catalogRevision,planSha256,ids:prunedVectorIds(plan)};
  const queries=[];let nativeRows=[native],receipts=[receipt];
  const db={prepare(sql){let params=[];return{bind(...values){params=values;return this;},async all(){queries.push({sql,params});
    if(sql.includes('FROM catalog_vector_deliveries'))return{results:structuredClone(nativeRows)};
    assert.match(sql,/b\.state='resolved'.*o\.state='verified'/s);assert.match(sql,/s\.phase='idle'/);assert.match(sql,/s\.external_pending=0/);
    assert.equal(params[0],RELEASE);return{results:structuredClone(receipts)};}};}};
  return{control,vectorPlan,publication,receipt,native,queries,db,revision,
    setNative:value=>{nativeRows=value;},setReceipts:value=>{receipts=value;}};
}

test('post-expiry successor uses exact current resolved/idle receipt and native plan, not supplier bodies',async()=>{
  const f=await sealFixture(),seal=await createPublishedApprovedCatalogSealFromControl(f.db,f.control,f.publication,f.vectorPlan);
  assert.ok(catalogSuccessorBytes(seal));assert.equal(seal.publication.releaseId,RELEASE);
  assert.equal(seal.currentNative.source.deliverySha256,sha256(canonicalJson(f.native)));
  assert.equal(seal.currentNative.revisionSha256,f.control.revisionSha256);assert.deepEqual(seal.currentNative.ids,[UUID]);
  assert.deepEqual(JSON.parse(seal.envelopeJson).products,[UUID]);assert.equal('sourceRows' in seal,false);
  assert.equal(f.queries.length,2);
});

test('routine permanent successor preserves finite overlay clocks and matches normal acceptance with cleared fallbacks',async()=>{
  const f=await sealFixture({overlay:true,historyOnly:true}),before=structuredClone(f.control);
  const recovered=await createPublishedApprovedCatalogSealFromControl(f.db,f.control,f.publication,f.vectorPlan);
  assert.deepEqual(recovered,await createPublishedApprovedCatalogSeal(f.db,f.revision,f.publication));
  assert.deepEqual(f.control,before);assert.equal(f.control.revision.snapshot.products[0].eligibleUntil,CUTOFF);
  assert.equal(f.control.revision.snapshot.products[0].persistent.eligibleUntil,null);
  const finite=structuredClone(f.control);delete finite.revision.snapshot.products[0].persistent;
  await assert.rejects(createPublishedApprovedCatalogSealFromControl(f.db,finite,f.publication,f.vectorPlan),/cohort_successor_control_invalid/);
});

test('history-only successor verifies all native IDs but matches the original factory current-ID convention',async()=>{
  const f=await sealFixture({historyOnly:true});
  assert.deepEqual(f.vectorPlan.ids,[UUID]);
  const recovered=await createPublishedApprovedCatalogSealFromControl(f.db,f.control,f.publication,f.vectorPlan);
  const normal=await createPublishedApprovedCatalogSeal(f.db,f.revision,f.publication);
  assert.deepEqual(recovered,normal);assert.ok(catalogSuccessorBytes(recovered));
  assert.deepEqual(recovered.currentNative.ids,[]);
  assert.deepEqual(recovered.persistent.nativeHistory,f.revision.persistent.nativeHistory);
  const foreign='00000000-0000-4000-8000-000000000099';
  for(const ids of [[],[foreign],[UUID,foreign]])await assert.rejects(
    createPublishedApprovedCatalogSealFromControl(f.db,f.control,f.publication,{...f.vectorPlan,ids}),/cohort_successor_unpublished/);
  const changed=structuredClone(f.native),request=JSON.parse(changed.request_json);
  request.plan.history[0].ids=[foreign];changed.request_json=JSON.stringify(request);f.setNative([changed]);
  await assert.rejects(createPublishedApprovedCatalogSealFromControl(f.db,f.control,f.publication,f.vectorPlan),/cohort_successor_unpublished/);
});

test('post-expiry successor rejects missing, foreign or drifted actual native/publication rows',async t=>{
  for(const fault of ['missing-native','duplicate-native','revision','plan-hash','plan-ids','receipt','unresolved'])await t.test(fault,async()=>{
    const f=await sealFixture();
    if(fault==='missing-native')f.setNative([]);
    if(fault==='duplicate-native')f.setNative([f.native,f.native]);
    if(['revision','plan-hash','plan-ids'].includes(fault)){
      const changed=structuredClone(f.native),request=JSON.parse(changed.request_json);
      if(fault==='revision')request.revisionSha256='f'.repeat(64);
      if(fault==='plan-hash')request.planSha256='f'.repeat(64);
      if(fault==='plan-ids'){request.plan.products=[];request.planSha256=sha256(canonicalJson(request.plan));}
      changed.request_json=JSON.stringify(request);f.setNative([changed]);
    }
    if(fault==='receipt')f.setReceipts([{...f.receipt,code_sha:'f'.repeat(40)}]);
    if(fault==='unresolved')f.setReceipts([]);
    await assert.rejects(createPublishedApprovedCatalogSealFromControl(f.db,f.control,f.publication,f.vectorPlan),/cohort_successor_unpublished/);
  });
});

async function settlementFixture(t){
  const sqlite=new DatabaseSync(':memory:');t.after(()=>sqlite.close());
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name=>/^00\d\d_.*\.sql$/.test(name)).sort())
    sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  sqlite.function('strftime',{varargs:true},()=>NOW);
  sqlite.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name,generation,mutation_epoch) VALUES(?,?,17,441)').run(scope.environment,scope.indexName);
  const start=canonicalJson({id:RUN,status:'running',counts:{},started_at:OLD});
  sqlite.prepare("INSERT INTO catalog_runs(id,status,mode,dry_run,started_at,completed_at,source_record_json) VALUES(?,'running','daily',0,?,NULL,?)").run(RUN,OLD,start);
  sqlite.prepare('INSERT INTO catalog_run_telemetry(run_id,start_json) VALUES(?,?)').run(RUN,start);
  const sql=[];
  const db={providerIdentity:'synthetic-local',prepare(query){let values=[];return{query,get values(){return values;},bind(...params){values=params;return this;},
    async all(){sql.push(query);return{results:sqlite.prepare(query).all(...values).map(row=>({...row}))};},
    async run(){sql.push(query);return sqlite.prepare(query).run(...values);}};},
    async batch(statements){sqlite.exec('BEGIN');try{for(const statement of statements){sql.push(statement.query);
      assert.ok(statement.values.length<=100);sqlite.prepare(statement.query).all(...statement.values);}sqlite.exec('COMMIT');}
      catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const permitOwner={...scope,token:'original-activation-owner',generation:17,epoch:441,phase:'activating',ownerReference:RUN,operationKey:HASH,capturedAt:OLD};
  const publication={stage:'published',intent:{releaseId:RELEASE},receiptSha256:HASH,permit:{mutationOwner:permitOwner}};
  let current={sha256:'3'.repeat(64),checkpoint:{phase:'published',owner:null,pins:{},phaseComplete:{},control:{publication}}};
  const summary={counts:{refreshed:8},timingsMs:{maintenance:1},usage:{requests:1},warnings:[]};
  const seal={kind:'synthetic-existing-body-free-successor'},budget={httpRequests:400,sqlStatements:900,knownRowsRead:1841389,knownRowsWritten:14444,unconfirmedRequests:1};
  const reads=[];let writes=0,failBefore=0;
  const ws={async readCheckpoint(options){assert.equal(options.controlOnly,true);return structuredClone(current);},
    async readPermanentFinalization(label){reads.push(label);assert.ok(['revision','summary'].includes(label));return label==='summary'?structuredClone(summary):{};},
    async writeControlCheckpoint(expected,patch){assert.equal(expected,current.sha256);writes++;
      if(failBefore===writes)throw Error('synthetic crash before local checkpoint');
      current={sha256:sha256(`checkpoint-${writes}`),checkpoint:{...current.checkpoint,...structuredClone(patch)}};return structuredClone(current);},
    async catalogSuccessor(){return structuredClone(seal);},async budget(){return{...budget};},
    async readArtifact(){throw Error('Expired provider/body read forbidden');},async readBlob(){throw Error('Expired provider/body read forbidden');},
    async putArtifact(){throw Error('New artifact forbidden');},async recordCatalogSuccessor(){throw Error('Existing successor must not be rewritten');}};
  const config={runId:RUN,catalogRevision:'synthetic-catalog',environment:scope.environment,vectorIndex:{name:scope.indexName},publication:{releaseId:RELEASE}};
  const options={db,ws,config,configSha256:HASH,token:'SYNTHETIC_ONLY',publication:{async command(){throw Error('Build/upload forbidden');},
    async fetch(){throw Error('External activation/provider operation forbidden');}},finish:{authorization:{}}};
  return{sqlite,db,ws,config,options,reads,sql,summary,budget,seal,cp:()=>structuredClone(current),
    failBeforeCheckpoint:n=>{failBefore=n;},scopeRow:()=>({...sqlite.prepare('SELECT * FROM catalog_mutation_scopes').get()}),
    run:()=>({...sqlite.prepare('SELECT * FROM catalog_runs').get()})};
}

test('expired permanent telemetry completes once with real fence/receipt and distinct release identity',async t=>{
  const f=await settlementFixture(t),result=await settleActivatedPermanentWeekly(f.options);
  assert.equal(result.state,'finalized');assert.equal(result.releaseId,RELEASE);assert.equal(result.receiptSha256,HASH);
  assert.equal(f.cp().checkpoint.phase,'finalized');assert.equal(f.cp().checkpoint.owner,null);
  assert.equal(f.scopeRow().phase,'idle');assert.equal(f.scopeRow().generation,18);assert.equal(f.scopeRow().mutation_epoch,442);
  const finish=JSON.parse(f.sqlite.prepare('SELECT finish_json FROM catalog_run_telemetry').get().finish_json);
  assert.equal(finish.counts.publication.releaseId,RELEASE);assert.equal(finish.counts.refreshed,8);assert.equal(f.run().status,'completed');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,1);
  assert.deepEqual(result.budget,f.budget);assert.deepEqual(result.catalogSeal,f.seal);assert.deepEqual(f.reads,['revision','summary']);
  assert.equal(f.sql.some(query=>/\b(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:products|catalog_public_products|vector_sync_outbox|catalog_build_requests|publication_outbox)\b/i.test(query)),false);
  const before=f.scopeRow(),again=await settleActivatedPermanentWeekly(f.options);
  assert.equal(again.state,'finalized');assert.deepEqual(f.scopeRow(),before);
});

test('routine completion finishes from permanent controls without a recovery-budget authorization',async t=>{
  const f=await settlementFixture(t);delete f.options.finish;
  f.config.cadence={day:'2026-10-26',featuredIds:[]};
  const result=await settleActivatedPermanentWeekly(f.options);
  assert.equal(result.state,'finalized');assert.deepEqual(result.budget,f.budget);assert.equal(f.scopeRow().phase,'idle');
  const reads=[...f.reads],before=f.scopeRow();await settleActivatedPermanentWeekly(f.options);
  assert.deepEqual(f.reads,reads);assert.deepEqual(f.scopeRow(),before);
});

test('telemetry commit and idle release lost local acknowledgments resume without another generation or write',async t=>{
  for(const checkpoint of [1,2,3])await t.test(`before checkpoint ${checkpoint}`,async sub=>{
    const f=await settlementFixture(sub);f.failBeforeCheckpoint(checkpoint);
    await assert.rejects(settleActivatedPermanentWeekly(f.options),/synthetic crash/);
    const result=await settleActivatedPermanentWeekly(f.options);
    assert.equal(result.state,'finalized');assert.equal(f.scopeRow().generation,18);assert.equal(f.scopeRow().mutation_epoch,442);
    assert.equal(f.scopeRow().phase,'idle');assert.equal(f.cp().checkpoint.owner,null);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,1);
    assert.deepEqual(result.budget,f.budget);
  });
});

test('completed telemetry with drifted counts or foreign owner cannot be adopted',async t=>{
  for(const fault of ['counts','foreign-owner','advanced-idle'])await t.test(fault,async sub=>{
    const f=await settlementFixture(sub);f.failBeforeCheckpoint(2);
    await assert.rejects(settleActivatedPermanentWeekly(f.options),/synthetic crash/);
    if(fault==='counts')f.summary.counts.refreshed=9;
    if(fault==='foreign-owner')f.sqlite.prepare("UPDATE catalog_mutation_scopes SET owner_token='foreign-owner'").run();
    if(fault==='advanced-idle')f.sqlite.prepare("UPDATE catalog_mutation_scopes SET phase='idle',owner_token=NULL,owner_reference=NULL,operation_key=NULL,captured_at=NULL,generation=generation+1").run();
    await assert.rejects(settleActivatedPermanentWeekly(f.options),/weekly_finalization_mismatch|weekly_finalize_owner|weekly_release_uncertain/);
    assert.notEqual(f.cp().checkpoint.phase,'finalized');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,1);
  });
});
