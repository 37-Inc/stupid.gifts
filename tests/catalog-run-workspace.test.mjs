import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, chmod, mkdir, readFile, writeFile, readdir, lstat, symlink, link, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openRunWorkspace, readRunWorkspace, WORKSPACE_BLOB_LIMITS, assertPublicationCleanupEntryCount } from '../scripts/catalog/run-workspace.ts';
import { canonicalJson, sha256 } from '../scripts/catalog/migration.ts';
import { encodeBuildRequest } from '../lib/catalog/build-requests.ts';
import {encodePublicationIntent} from '../lib/catalog/publication.ts';
import { createCatalogProviderEvidence } from '../scripts/catalog/provider-evidence.ts';
import {createProjectionPacket} from '../lib/catalog/d1.ts';
import {putOrdered} from '../scripts/catalog/run-cloudflare-weekly.ts';
import {activatedPermanentRevisionControl} from '../scripts/catalog/activated-permanent-control.ts';
import { encodePgvectorSendBase64, decodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';

// Isolated local fixtures only. No providers, credentials, real merchant content,
// automatic deletion policy, database writes or public artifacts.
const NOW='2026-10-20T12:00:00.000000Z',LATER='2026-10-20T14:00:00.000000Z';
const HASH='a'.repeat(64),CODE='b'.repeat(40),ID='B000000001';
const scope={environment:'staging',accountId:'test-account',databaseId:'test-db',databaseName:'test-db-name',workerName:'test-worker',indexName:'test-index'};
const kinds=['amazon-observation','embedding-response','phase','publication','checkpoint'];
function policy(){return{reviewReference:'test-only/reviewed-retention',rules:Object.fromEntries(kinds.map(kind=>[kind,{maxAgeMs:3_600_000,notAfter:'2026-10-21T00:00:00.000Z'}]))};}
async function fixture(t,overrides={}){
  const parent=await mkdtemp(join(await realpath(tmpdir()),'goose-workspace-test-'));await chmod(parent,0o700);
  t.after(()=>rm(parent,{recursive:true,force:true}));let clock=NOW;
  const input={directory:join(parent,'workspace'),repository:await realpath(new URL('..',import.meta.url).pathname),mode:'create',runId:'test-run',
    configSha256:HASH,codeSha:CODE,scope,retention:policy(),budgetCaps:{httpRequests:30,sqlStatements:100},now:()=>clock,...overrides};
  const handles=[];const open=async(options={})=>{const w=await openRunWorkspace({...input,...options});handles.push(w);return w;};
  t.after(async()=>{for(const w of handles.reverse())try{await w.close();}catch{/* deliberately corrupt/closed fixtures */}});
  return{parent,input,open,setNow:value=>{clock=value;}};
}
const cp=(state={private:'test-only'})=>({phase:'created',owner:null,state,pins:{},phaseComplete:null});
const observation=()=>({schemaVersion:1,kind:'amazon-observation',operation:'getItems',observedAt:NOW,
  products:[{id:ID,availabilityStatus:'IN_STOCK',sourceFactsHash:HASH,snapshot:{title:'TEST ONLY gift',imageUrl:'https://example.invalid/test.jpg',sourceFacts:{fixture:true}}}],
  returnedIds:[ID],requestedIds:[ID]});
const reservation=(id='request-1',sqlStatements=2)=>({id,requestSha256:HASH,units:{httpRequests:1,sqlStatements}});
async function tamper(path,value){await writeFile(path,`${canonicalJson(value)}\n`,{mode:0o600});}

test('durable receipt capability independently reloads exact canonical provider receipts and original deadline',async t=>{
  const f=await fixture(t),w=await f.open();const receipt=observation(),digest=sha256(canonicalJson(receipt));
  const saved=await w.saveReceipt({sha256:digest,receipt});assert.equal(saved.sha256,digest);
  assert.deepEqual(await w.readReceipt(saved),receipt);assert.deepEqual(await w.saveReceipt({sha256:digest,receipt}),saved);
  const disk=JSON.parse(await readFile(join(w.directory,saved.reference),'utf8'));
  assert.equal(disk.observedAt,NOW);assert.equal(disk.expiresAt,'2026-10-20T13:00:00.000Z');
  await w.assertScope(scope);await assert.rejects(w.assertScope({...scope,workerName:'other-worker'}),/scope_mismatch/);
  await w.close();const resumed=await f.open({mode:'resume',expectedManifestSha256:w.manifestSha256});
  assert.deepEqual(await resumed.readReceipt(saved),receipt);
  for(const path of [w.directory,join(w.directory,'objects'),join(w.directory,'events')])assert.equal((await lstat(path)).mode&0o777,0o700);
  assert.equal((await lstat(join(w.directory,saved.reference))).mode&0o777,0o600);
});

test('existing providerEvidence saveReceipt signature is concrete, private and handles raw+normalized variants',async t=>{
  const f=await fixture(t),w=await f.open();const evidence=createCatalogProviderEvidence({saveReceipt:w.saveReceipt,now:()=>NOW});
  const products=Array.from({length:10},(_,i)=>({id:`B${String(i).padStart(9,'0')}`,title:`TEST ONLY ${i}`,imageUrl:`https://example.invalid/${i}_SL300_.jpg`,
    source:'amazon',remotelyVerified:true,availabilityStatus:'IN_STOCK',sourceFacts:{fixture:true}}));
  await evidence.amazon('getItems',async()=>products,p=>({...p,imageUrl:p.imageUrl.replace('_SL300_','')}),products.map(p=>p.id));
  const files=await readdir(join(w.directory,'objects'));assert.equal(files.length,1);
  const saved=JSON.parse(await readFile(join(w.directory,'objects',files[0]),'utf8'));assert.equal(saved.value.products.length,20);
  const values=Array(1536).fill(Math.fround(.1));values[0]=-0;const nativeBase64=encodePgvectorSendBase64(values);
  const receipt={schemaVersion:1,kind:'embedding-response',observedAt:NOW,model:'text-embedding-3-small',products:Array.from({length:20},(_,i)=>({
    id:`B${String(i).padStart(9,'0')}`,sourceFactsHash:HASH,text:'TEST ONLY immutable embedding text',nativeBase64,
    vectorBytesSha256:sha256(Buffer.from(nativeBase64,'base64'))}))};
  const ref=await w.saveReceipt({sha256:sha256(canonicalJson(receipt)),receipt});assert.deepEqual(await w.readReceipt(ref),receipt);
});

test('checkpoint CAS, lost-response replay and immutable phase-complete/pins prevent history rewrites',async t=>{
  const f=await fixture(t),w=await f.open();const artifact=await w.putArtifact({fixture:'complete'},{kind:'phase',observedAt:NOW});
  const first={...cp(),phase:'phases_complete',pins:{phase:artifact},phaseComplete:artifact};
  const result=await w.writeCheckpoint(null,first);assert.deepEqual(await w.writeCheckpoint(null,first),result);
  const next={...first,phase:'draining',state:{count:3}};const second=await w.writeCheckpoint(result.sha256,next);
  assert.deepEqual((await w.readCheckpoint()).checkpoint,next);
  await assert.rejects(w.writeCheckpoint(null,first),/checkpoint_cas/);
  await assert.rejects(w.writeCheckpoint(second.sha256,{...next,pins:{}}),/pin_rewrite/);
  await assert.rejects(w.writeCheckpoint(second.sha256,{...next,phaseComplete:null}),/phase_complete_rewrite/);
  const other=await w.putArtifact({fixture:'other'},{kind:'phase',observedAt:NOW});
  await assert.rejects(w.writeCheckpoint(second.sha256,{...next,pins:{phase:other}}),/pin_rewrite/);
  assert.equal((await w.readCheckpoint({controlOnly:true})).checkpoint.state,undefined);
});

test('same artifact retry after lost checkpoint ack reuses original observation/deadline, never renews',async t=>{
  const f=await fixture(t),w=await f.open();const value={fixture:'immutable phase seal'};
  const first=await w.putArtifact(value,{kind:'publication',observedAt:NOW});const bytes=await readFile(join(w.directory,first.reference));
  f.setNow('2026-10-20T12:30:00.000Z');await w.close();const resumed=await f.open({mode:'resume'});
  assert.deepEqual(await resumed.putArtifact(value,{kind:'publication',observedAt:'2026-10-20T12:30:00.000Z'}),first);
  assert.deepEqual(await readFile(join(w.directory,first.reference)),bytes);
  await assert.rejects(resumed.putArtifact(value,{kind:'phase',observedAt:NOW}),/kind/);
  f.setNow('2026-10-20T13:00:00.000Z');
  await assert.rejects(resumed.putArtifact(value,{kind:'publication',observedAt:'2026-10-20T13:00:00.000Z'}),/expired/);
  assert.deepEqual(await readFile(join(w.directory,first.reference)),bytes);
});

test('budget reservations are charged before dispatch, exact-idempotent, capped, and unknown across reopen',async t=>{
  const f=await fixture(t,{budgetCaps:{httpRequests:3,sqlStatements:5}}),w=await f.open();
  await w.reserveBudget(reservation('identity',0));await w.settleBudget('identity',{status:'known',usage:{rowsRead:0,rowsWritten:0}});
  await w.reserveBudget(reservation());await w.reserveBudget(reservation());
  await assert.rejects(w.reserveBudget({...reservation(),requestSha256:'c'.repeat(64)}),/budget_replay/);
  await w.reserveBudget(reservation('lost',3));
  await w.settleBudget('request-1',{status:'known',usage:{rowsRead:7,rowsWritten:2}});
  await w.settleBudget('request-1',{status:'known',usage:{rowsRead:7,rowsWritten:2}});
  assert.deepEqual(await w.budget(),{httpRequests:3,sqlStatements:5,knownRowsRead:7,knownRowsWritten:2,unconfirmedRequests:1});
  await assert.rejects(w.reserveBudget(reservation('over',0)),/budget_exceeded/);await w.close();
  const resumed=await f.open({mode:'resume'});assert.equal((await resumed.budget()).unconfirmedRequests,1);
  await resumed.settleBudget('lost',{status:'unknown',usage:null});
  await assert.rejects(resumed.settleBudget('lost',{status:'known',usage:{rowsRead:0,rowsWritten:0}}),/settlement_replay/);
  assert.equal((await resumed.budget()).httpRequests,3);
});

test('serialized concurrent reservations cannot overspend a single remaining slot',async t=>{
  const f=await fixture(t,{budgetCaps:{httpRequests:1,sqlStatements:3}}),w=await f.open();
  const outcomes=await Promise.allSettled([w.reserveBudget(reservation('a')),w.reserveBudget(reservation('b'))]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal((await w.budget()).httpRequests,1);
});

test('expiry refuses body/new content without renewing on replay, but keeps control metadata and budget usable',async t=>{
  const f=await fixture(t),w=await f.open(),receipt=observation();const ref=await w.saveReceipt({sha256:sha256(canonicalJson(receipt)),receipt});
  await w.writeCheckpoint(null,cp({private:'DO NOT EXPOSE EXPIRED BODY'}));f.setNow(LATER);
  await assert.rejects(w.readReceipt(ref),/expired/);await assert.rejects(w.readCheckpoint(),/expired/);
  await assert.rejects(w.saveReceipt({sha256:ref.sha256,receipt}),/expired/);
  await assert.rejects(w.putArtifact({renew:true},{kind:'phase',observedAt:LATER}),/expired/);
  assert.equal((await w.readCheckpoint({controlOnly:true})).checkpoint.phase,'created');
  await w.reserveBudget(reservation('reconciliation',0));await w.settleBudget('reconciliation',{status:'known',usage:{rowsRead:0,rowsWritten:0}});
  const status=await readRunWorkspace({...f.input,mode:'resume'});assert.equal(status.checkpoint.checkpoint.state,undefined);
  assert.equal(status.expired.length,2);assert.ok(!JSON.stringify(status).includes('DO NOT EXPOSE'));
  await w.close();const resumed=await f.open({mode:'resume'});await assert.rejects(resumed.readReceipt(ref),/expired/);
  assert.equal((await resumed.budget()).httpRequests,1);
});

function publication(){const request={schemaVersion:1,environment:'staging',sourceRevision:'test-revision',sourceDigest:HASH,codeSha:CODE,priorReleaseId:null,capturedAt:new Date(NOW).toISOString(),cutoff:new Date(LATER).toISOString()};
  const intent={releaseId:'test-release',codeSha:CODE,catalogRevision:'test-revision',vectorSyncWatermark:0,priorReleaseId:null,nextExpiry:LATER,catalogSnapshotSha256:HASH,manifestSha256:HASH};
  return{schemaVersion:1,configSha256:HASH,requestId:'test-request',runReference:'test/run',stage:'activating',
    build:{requestId:'test-request',token:'test-token',runReference:'test/run',leaseUntil:LATER,request},
    publication:{intentId:'test-intent',token:'test-publish-token',leaseUntil:LATER,intent},intent,
    permit:{requestId:'test-request',token:'test-token',runReference:'test/run',releaseId:'test-release',versionReference:'test-version'},
    vectorPlan:{catalogRevision:'test-revision',planSha256:HASH,ids:[]},packageSha256:HASH,uploadMarker:'test-upload',versionReference:'test-version',deploymentMarker:'test-deploy',deploymentId:null};}

function recoveryCheckpoint(runId='test-run'){
  const p=publication(),requestId=sha256(encodeBuildRequest(p.build.request));
  const owner={environment:scope.environment,indexName:scope.indexName,token:'recovery-owner',generation:3,epoch:27,phase:'activating',
    ownerReference:`${runId}:freeze`,operationKey:HASH,capturedAt:new Date(NOW).toISOString()};
  Object.assign(p,{requestId,runReference:runId});Object.assign(p.build,{requestId,runReference:runId});
  Object.assign(p.permit,{requestId,runReference:runId,mutationOwner:structuredClone(owner)});
  return{...cp({private:'ORIGINAL BODY'}),phase:'attention',owner,control:{publication:p}};
}
const recoveryGrant=(checkpoint,allowance={httpRequests:2,sqlStatements:3})=>({expectedCheckpointSha256:checkpoint.sha256,approvalReference:'c'.repeat(64),allowance});

test('pre-upload request continuation is once-only and preserves original caps, charges and SQL allowance',async t=>{
  const f=await fixture(t,{budgetCaps:{httpRequests:1,sqlStatements:2}}),w=await f.open();
  await w.reserveBudget(reservation('old',2));await w.settleBudget('old',{status:'known',usage:{rowsRead:150,rowsWritten:5}});
  const value=recoveryCheckpoint();value.phase='publishing';value.owner.phase='freezing';
  Object.assign(value.control.publication,{stage:'claimed',permit:null,publication:null,intent:null,versionReference:null,packageSha256:null});
  const p=value.control.publication;p.build.request.cutoff=new Date(Date.parse(NOW)+60000).toISOString();
  p.build.leaseUntil=p.build.request.cutoff;
  p.requestId=p.build.requestId=sha256(encodeBuildRequest(p.build.request));
  const saved=await w.writeCheckpoint(null,value),manifest=await readFile(join(w.directory,'manifest.json'));
  const grant={expectedCheckpointSha256:saved.sha256,approvalReference:HASH,additionalHttpRequests:750,
    approvedAt:new Date(NOW).toISOString(),publicationUntil:new Date(LATER).toISOString()};
  for(const patch of [{additionalHttpRequests:751},{additionalHttpRequests:0},{expectedCheckpointSha256:'0'.repeat(64)},{approvalReference:'unapproved'}])
    await assert.rejects(w.grantPublicationRequestBudget({...grant,...patch}),/request_budget_binding/);
  const reclaimed=structuredClone(value);reclaimed.control.publication.build.token='00000000-0000-4000-8000-000000000001';
  reclaimed.control.publication.build.leaseUntil=new Date(Date.parse(NOW)+300000).toISOString();
  await assert.rejects(w.writeCheckpoint(saved.sha256,reclaimed),/control_rewrite/);
  assert.deepEqual(await w.grantPublicationRequestBudget(grant),{httpRequests:751,sqlStatements:2});
  assert.deepEqual(await w.publicationRequestBudget(),grant);
  await w.writeCheckpoint(saved.sha256,reclaimed);
  assert.deepEqual(await readFile(join(w.directory,'manifest.json')),manifest);assert.equal((await w.budget()).knownRowsWritten,5);
  await w.close();const resumed=await f.open({mode:'resume'});
  assert.deepEqual(await resumed.grantPublicationRequestBudget(grant),{httpRequests:751,sqlStatements:2});
  await assert.rejects(resumed.grantPublicationRequestBudget({...grant,additionalHttpRequests:1}),/request_budget_replay/);
  await assert.rejects(resumed.reserveBudget(reservation('no-extra-sql',1)),/budget_exceeded/);
});

test('acknowledged-upload finish budget is once-only, retains charges and cannot fund a second upload or arbitrary phase',async t=>{
  const f=await fixture(t,{budgetCaps:{httpRequests:1,sqlStatements:2}}),w=await f.open();
  await w.reserveBudget(reservation('original',2));await w.settleBudget('original',{status:'known',usage:{rowsRead:150,rowsWritten:5}});
  const value=recoveryCheckpoint();value.phase='publishing';value.owner.phase='freezing';
  value.control.publication.stage='uploaded';value.control.publication.permit=null;
  const ack=await w.putArtifact({fixture:'actual-upload-ack'},{kind:'publication',observedAt:NOW});
  value.pins.publicationUploadTransportAcknowledged=ack;
  const saved=await w.writeCheckpoint(null,value),grant={expectedCheckpointSha256:saved.sha256,approvalReference:HASH,
    versionReference:value.control.publication.versionReference,allowance:{httpRequests:2,sqlStatements:3},reportedRowsRead:1000};
  const original=await readFile(join(w.directory,'manifest.json'));
  for(const change of [{reportedRowsRead:3000001},{allowance:{httpRequests:5001,sqlStatements:3}},{versionReference:'another-version'}])
    await assert.rejects(w.grantPublicationFinishBudget({...grant,...change}),/finish_budget_binding/);
  assert.deepEqual(await w.grantPublicationFinishBudget(grant),{httpRequests:3,sqlStatements:5});
  assert.deepEqual(await w.publicationFinishBudget(),grant);
  assert.deepEqual(await readFile(join(w.directory,'manifest.json')),original);
  assert.equal((await w.budget()).knownRowsRead,150);await w.close();const resumed=await f.open({mode:'resume'});
  assert.deepEqual(await resumed.grantPublicationFinishBudget(grant),{httpRequests:3,sqlStatements:5});
  await assert.rejects(resumed.grantPublicationFinishBudget({...grant,reportedRowsRead:1100}),/finish_budget_replay/);
  assert.equal((await resumed.budget()).knownRowsWritten,5);
});

test('ordinary acknowledged upload admits explicit Free-quota finish without changing original caps or charges',async t=>{
  const f=await fixture(t),w=await f.open(),value=recoveryCheckpoint();
  value.phase='publishing';value.owner.phase='freezing';value.control.publication.stage='uploaded';value.control.publication.permit=null;
  const saved=await w.writeCheckpoint(null,value),grant={expectedCheckpointSha256:saved.sha256,approvalReference:HASH,
    versionReference:value.control.publication.versionReference,allowance:{httpRequests:1000,sqlStatements:2000},reportedRowsRead:3000000};
  await assert.rejects(w.grantPublicationFinishBudget(grant),/finish_budget_binding/);
  value.pins.publicationUploadAcknowledged=await w.putArtifact({fixture:'ordinary-upload-ack'},{kind:'publication',observedAt:NOW});
  const acknowledged=await w.writeCheckpoint(saved.sha256,value),bound={...grant,expectedCheckpointSha256:acknowledged.sha256};
  const original=await readFile(join(w.directory,'manifest.json'));
  assert.deepEqual(await w.grantPublicationFinishBudget(bound),{httpRequests:1000,sqlStatements:2000});
  assert.deepEqual(await w.publicationFinishBudget(),bound);assert.deepEqual(await readFile(join(w.directory,'manifest.json')),original);
  assert.equal((await w.budget()).knownRowsRead,0);await w.close();const reopened=await f.open({mode:'resume'});
  assert.deepEqual(await reopened.publicationFinishBudget(),bound);
});

test('an acknowledged preactivation finish preserves multiple settled unknowns and rejects an in-flight request',async t=>{
  const f=await fixture(t),w=await f.open(),value=recoveryCheckpoint();
  value.phase='publishing';value.owner.phase='freezing';value.control.publication.stage='activating';value.control.publication.permit=null;
  value.pins.publicationUploadAcknowledged=await w.putArtifact({fixture:'ack'},{kind:'publication',observedAt:NOW});
  const saved=await w.writeCheckpoint(null,value);
  const grant={expectedCheckpointSha256:saved.sha256,approvalReference:HASH,versionReference:value.control.publication.versionReference,
    allowance:{httpRequests:1000,sqlStatements:2000},reportedRowsRead:3000000};
  for(const id of ['read-timeout','identity-timeout']){
    await w.reserveBudget(reservation(id,0));
    await assert.rejects(w.grantPublicationFinishBudget(grant),/finish_budget_binding/);
    await w.settleBudget(id,{status:'unknown',usage:null});
  }
  const before=await w.budget();await w.grantPublicationFinishBudget(grant);
  assert.deepEqual(await w.budget(),before);assert.equal(before.unconfirmedRequests,2);
});

async function finalizationFixture(t,{finite=false,skipFinish=false,noDeployment=false,preactivation=false}={}){
  const f=await fixture(t);f.input.repository=join(f.parent,'operator');
  await mkdir(f.input.repository,{mode:0o700});
  const w=await f.open(),value=recoveryCheckpoint(),p=value.control.publication;
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:p.intent.catalogRevision,generatedAt:new Date(NOW).toISOString(),
    products:[{id:ID,publicId:'00000000-0000-4000-8000-000000000001',slug:'fixture-gift',source:'amazon',title:'Owned fixture gift',
      description:'An independently owned synthetic fixture gift.',imageUrl:'/images/gift-placeholder.svg',
      affiliateUrl:'https://www.amazon.com/dp/'+ID+'?tag=fixture-20',currency:'USD',price:0,isActive:true,qualityScore:.85,
      eligibleUntil:finite?LATER:null,indexable:false}],heldProducts:[],slugHistory:[]};
  const bytes=`${JSON.stringify(snapshot)}\n`,digest=sha256(bytes);
  p.intent.nextExpiry=null;p.intent.catalogSnapshotSha256=digest;p.build.request.sourceDigest=digest;
  p.requestId=p.build.requestId=sha256(encodeBuildRequest(p.build.request));
  const permit={...p.permit,requestId:p.requestId};p.permit=null;p.stage='uploaded';value.owner.phase='freezing';value.phase='publishing';
  await w.preparePublicationDirectories(p.intent.releaseId,NOW,null);
  const directory=join(w.directory,'packages',p.intent.releaseId);await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'catalog.snapshot.json'),bytes,{mode:0o600});
  const ack=await w.putArtifact({fixture:'genuine original transport ack'},{kind:'publication',observedAt:NOW});
  value.pins[preactivation?'publicationUploadAcknowledged':'publicationUploadTransportAcknowledged']=ack;
  await w.reserveBudget(reservation('original-charge',2));await w.settleBudget('original-charge',{status:'known',usage:{rowsRead:1841389,rowsWritten:14444}});
  let saved=await w.writeCheckpoint(null,value);
  const finish={expectedCheckpointSha256:saved.sha256,approvalReference:HASH,versionReference:p.versionReference,
    allowance:{httpRequests:1000,sqlStatements:2000},reportedRowsRead:2000000};
  if(!skipFinish)await w.grantPublicationFinishBudget(finish);
  await w.reserveBudget(reservation('retained-unknown',0));await w.settleBudget('retained-unknown',{status:'unknown',usage:null});
  const activated=structuredClone(value);activated.phase='attention';activated.owner.phase='activating';
  Object.assign(activated.control.publication,{stage:'activating',permit,deploymentId:noDeployment?null:'actual-original-deployment'});
  if(preactivation){activated.phase='publishing';activated.owner.phase='freezing';activated.control.publication.permit=null;activated.control.publication.deploymentId=null;}
  saved=await w.writeCheckpoint(saved.sha256,activated);
  const grant={...recoveryGrant(saved,{httpRequests:1000,sqlStatements:8000}),scope:'approved-permanent-finalization',reportedRowsRead:2341389};
  return{f,w,saved,grant,finish,directory,snapshot};
}

async function permanentControlFixture(t,{blob=false,mutate,summaryMutate,preactivation=false}={}){
  const input=await finalizationFixture(t,{preactivation}),{w,snapshot,saved}=input,p=saved.checkpoint.control.publication;
  const owner=p.permit?.mutationOwner??saved.checkpoint.owner;
  const packet=await createProjectionPacket(snapshot,{[snapshot.products[0].publicId]:HASH},HASH,new Date(NOW));
  const previous={...snapshot,catalogRevision:'prior-fixture',products:[snapshot.products[0].publicId]};
  const approval={schemaVersion:1,runId:'fixture-maintenance',catalogRevision:snapshot.catalogRevision,changes:[]};
  const value={schemaVersion:1,kind:'approved-revision-control',sourceIds:previous.products,sourceRowsSha256:HASH,revisionSha256:HASH,
    request:{schemaVersion:1,kind:'approved-request-control',request:{scope:{environment:scope.environment,indexName:scope.indexName},codeSha:CODE,
      context:{envelopeSha256:HASH,snapshotSha256:HASH,projectionSha256:HASH,sourceExportSha256:HASH,
        vectorSyncWatermark:0,publicationReceiptWatermark:0,cutoff:LATER,priorPublication:null},
      approval,approvalSha256:sha256(canonicalJson(approval))},
      previous:{envelopeJson:JSON.stringify(previous),snapshotSha256:HASH,projectionReceipt:packet.receipt},requestSha256:HASH},
    revision:{snapshot,packet,priorRow:{release_id:'prior-fixture',catalog_revision:'prior-fixture',code_sha:CODE,completed_at:NOW,
      manifest_json:encodePublicationIntent({...p.intent,releaseId:'prior-fixture',catalogRevision:'prior-fixture',catalogSnapshotSha256:HASH})},
      sourceDigest:HASH,globalVectorWatermark:0,vectorSyncWatermark:0,operationKey:owner.operationKey,
      persistent:{generation:owner.generation,inventory:[{publicId:previous.products[0],sourceRowSha256:HASH,
        productSha256:HASH,privateStateSha256:HASH}],nativeHistory:[]},nativeHistory:[]}};
  mutate?.(value);
  const revision=blob?await w.putBlob(Buffer.from(JSON.stringify(value)),{kind:'publication',observedAt:NOW}):await putOrdered(w,value,NOW);
  const summary={counts:{refreshed:10},timingsMs:{catalog:1},usage:{requests:1,model:'fixture-model'},warnings:[]};summaryMutate?.(summary);
  const complete=await w.putArtifact(summary,{kind:'publication',observedAt:NOW});
  const current=await w.writeCheckpoint(saved.sha256,{...saved.checkpoint,pins:{...saved.checkpoint.pins,revision},phaseComplete:complete});
  input.f.setNow('2026-10-22T14:00:00.000Z');
  if(!preactivation)await w.grantActivationRecoveryBudget({...input.grant,expectedCheckpointSha256:current.sha256});
  return{...input,value,summary,current,revision,complete};
}

test('only exact permanent technical controls survive both retention and activation deadlines; supplier reads still fail',async t=>{
  for(const blob of [false,true])await t.test(blob?'blob':'ordered artifact',async sub=>{
    const {w,f,value,summary,revision,complete}=await permanentControlFixture(sub,{blob});
    const before=await w.budget(),manifest=await readFile(join(w.directory,'manifest.json'));
    assert.deepEqual(await w.readPermanentFinalization('revision'),value);
    assert.deepEqual(await w.readPermanentFinalization('summary'),summary);
    await assert.rejects(w.readCheckpoint(),/expired/);await assert.rejects(w.readArtifact(revision),/expired/);
    await assert.rejects(w.readBlob(revision),/expired/);await assert.rejects(w.readArtifact(complete),/expired/);
    await assert.rejects(w.readPermanentFinalization('provider-body'),/permanent_control/);
    assert.deepEqual(await w.budget(),before);assert.deepEqual(await readFile(join(w.directory,'manifest.json')),manifest);
    await w.close();const resumed=await f.open({mode:'resume'});
    assert.deepEqual(await resumed.readPermanentFinalization('revision'),value);assert.equal((await resumed.budget()).unconfirmedRequests,1);
  });
});

test('permanent preactivation control is tied to the unchanged freezing owner, not a fabricated activation permit',async t=>{
  const {value,current}=await permanentControlFixture(t),p=structuredClone(current.checkpoint.control.publication);
  const owner={...p.permit.mutationOwner,phase:'freezing'};p.permit=null;
  assert.deepEqual(activatedPermanentRevisionControl(value,p,owner),value);
  assert.throws(()=>activatedPermanentRevisionControl(value,p),/permanent_control/);
  assert.throws(()=>activatedPermanentRevisionControl(value,p,{...owner,generation:owner.generation+1}),/permanent_control/);
});

test('the ordinary acknowledged-upload continuation reads only permanent controls after supplier retention expires',async t=>{
  const {w,value,summary}=await permanentControlFixture(t,{preactivation:true,blob:true});
  const before=await w.budget();
  assert.deepEqual(await w.readPermanentFinalization('revision'),value);
  assert.deepEqual(await w.readPermanentFinalization('summary'),summary);
  await assert.rejects(w.readCheckpoint(),/expired/);
  assert.deepEqual(await w.budget(),before);
});

test('post-expiry purpose reader rejects finite overlays, raw supplier fields, snapshot drift and summary relabeling',async t=>{
  const faults={finite:v=>{v.revision.snapshot.products[0].eligibleUntil=LATER;},
    nestedFinite:v=>{const p=v.revision.snapshot.products[0];p.persistent={...p};p.eligibleUntil=LATER;},
    sourceRows:v=>{v.revision.sourceRows=[{source_record_json:'supplier body'}];},
    rawFacts:v=>{v.request.request.predecessor={sourceFacts:{title:'supplier body'}};},
    changedSnapshot:v=>{v.revision.snapshot.products[0].title='Different gift';},
    changedProjection:v=>{v.revision.packet.rows[0].title='Different projection';},
    receiptRaw:v=>{v.revision.packet.receipt.sourceFacts={title:'expired supplier text'};},
    nativeRaw:v=>{v.revision.nativeHistory=[{sourceFacts:'expired supplier text'}];},
    absentRaw:v=>{v.revision.additionalAbsentIds=[{title:'expired supplier text'}];},
    contextRaw:v=>{v.request.request.context.supplier='expired supplier text';},
    predecessorRaw:v=>{v.request.request.predecessor={body:'expired supplier text'};},
    priorRaw:v=>{v.revision.priorRow.manifest_json=JSON.stringify({sourceFacts:'expired supplier text'});},
    historyRaw:v=>{const old=JSON.parse(v.request.previous.envelopeJson);old.slugHistory=[{body:'expired supplier text'}];
      v.request.previous.envelopeJson=JSON.stringify(old);}};
  for(const [name,mutate]of Object.entries(faults))await t.test(name,async sub=>{
    const {w}=await permanentControlFixture(sub,{mutate});await assert.rejects(w.readPermanentFinalization('revision'),/permanent_control|snapshot|eligible|invalid_publication_intent/i);
  });
  const {w}=await permanentControlFixture(t,{summaryMutate:s=>{s.usage={sourceFacts:{title:'expired supplier text'}};}});
  await assert.rejects(w.readPermanentFinalization('summary'),/permanent_control/);
});

test('expired activated-permanent control settles only the exact receipt and one telemetry epoch without repinning bodies',async t=>{
  const {w,f,current,grant,summary}=await permanentControlFixture(t),before=await w.budget();
  const published={...current.checkpoint.control.publication,stage:'published',receiptSha256:HASH};
  let saved=await w.writeControlCheckpoint(current.sha256,{phase:'published',owner:null,control:{publication:published}});
  const a=published.permit.mutationOwner,writer={...a,phase:'writing',generation:a.generation+1,token:'exact-finalizer',
    ownerReference:'test-run:finalize',operationKey:sha256(`finalize:${HASH}`)};
  for(const changed of [{...writer,generation:writer.generation+1},{...writer,epoch:writer.epoch+2},{...writer,ownerReference:'another-run'}])
    await assert.rejects(w.writeControlCheckpoint(saved.sha256,{phase:'published',owner:changed,control:{publication:published}}),/control_owner|recovery_control/);
  saved=await w.writeControlCheckpoint(saved.sha256,{phase:'published',owner:writer,control:{publication:published}});
  await assert.rejects(w.writeControlCheckpoint(saved.sha256,{phase:'finalized',owner:null,control:{publication:published}}),/control_owner/);
  await assert.rejects(w.writeControlCheckpoint(saved.sha256,{phase:'published',owner:{...writer,token:'different-finalizer'},control:{publication:published}}),/control_owner/);
  const finished={...writer,epoch:writer.epoch+1};
  saved=await w.writeControlCheckpoint(saved.sha256,{phase:'published',owner:finished,control:{publication:published}});
  saved=await w.writeControlCheckpoint(saved.sha256,{phase:'finalized',owner:null,control:{publication:published}});
  assert.deepEqual(saved.checkpoint.pins,current.checkpoint.pins);assert.deepEqual(saved.checkpoint.phaseComplete,current.checkpoint.phaseComplete);
  assert.deepEqual(await w.readPermanentFinalization('summary'),summary);assert.deepEqual(await w.budget(),before);
  await w.close();const resumed=await f.open({mode:'resume'});
  assert.equal((await resumed.readCheckpoint({controlOnly:true})).checkpoint.phase,'finalized');
  assert.deepEqual(await resumed.budgetCeiling(),{httpRequests:before.httpRequests+grant.allowance.httpRequests,sqlStatements:before.sqlStatements+grant.allowance.sqlStatements});
  await assert.rejects(resumed.readCheckpoint(),/expired/);assert.equal((await resumed.budget()).unconfirmedRequests,1);
});

test('approved permanent finalization retains both grants/unknowns through exact telemetry and finalized readback',async t=>{
  const {f,w,saved,grant,finish}=await finalizationFixture(t),manifest=await readFile(join(w.directory,'manifest.json'));
  const initial=await w.budget();
  assert.deepEqual(await w.grantActivationRecoveryBudget(grant),{httpRequests:1002,sqlStatements:8002});
  assert.equal(await w.budgetRowsReadCeiling(),2341389);assert.deepEqual(await w.budget(),initial);
  assert.deepEqual(await w.grantPublicationFinishBudget(finish),{httpRequests:1002,sqlStatements:8002});
  assert.equal((await w.budget()).unconfirmedRequests,1);
  const p={...saved.checkpoint.control.publication,stage:'published',receiptSha256:HASH};
  let current=await w.writeControlCheckpoint(saved.sha256,{phase:'published',owner:null,control:{publication:p}});
  const a=p.permit.mutationOwner,writer={...a,token:'finalize-owner',generation:a.generation+1,phase:'writing',
    ownerReference:'test-run:finalize',operationKey:sha256(`finalize:${HASH}`)};
  const published={...saved.checkpoint,phase:'published',owner:writer,control:{publication:p}};
  for(const change of [{generation:a.generation},{epoch:a.epoch+2},{ownerReference:'test-run:other'},{operationKey:HASH},{token:a.token}]){
    current=await w.writeCheckpoint(current.sha256,{...published,owner:{...writer,...change}});
    await assert.rejects(w.reserveBudget(reservation('not-the-finalizer',0)),/recovery_control/);
  }
  for(const epoch of [a.epoch,a.epoch+1]){
    current=await w.writeCheckpoint(current.sha256,{...published,owner:{...writer,epoch}});
    await w.reserveBudget(reservation(`finalize-${epoch}`,1));await w.settleBudget(`finalize-${epoch}`,{status:'known',usage:{rowsRead:1,rowsWritten:0}});
  }
  await w.writeCheckpoint(current.sha256,{...published,phase:'finalized',owner:null});
  await w.reserveBudget(reservation('finalized-successor',0));await w.settleBudget('finalized-successor',{status:'known',usage:{rowsRead:0,rowsWritten:0}});
  await w.close();f.setNow(LATER);const reopened=await f.open({mode:'resume'});
  assert.deepEqual(await reopened.grantActivationRecoveryBudget(grant),{httpRequests:1002,sqlStatements:8002});
  assert.deepEqual(await reopened.grantPublicationFinishBudget(finish),{httpRequests:1002,sqlStatements:8002});
  assert.equal(await reopened.budgetRowsReadCeiling(),2341389);assert.equal((await reopened.budget()).unconfirmedRequests,1);
  await reopened.reserveBudget(reservation('body-free-observer',0));
  assert.deepEqual(await readFile(join(w.directory,'manifest.json')),manifest);
  await assert.rejects(reopened.grantActivationRecoveryBudget({...grant,approvalReference:HASH}),/recovery_replay/);
  await assert.rejects(reopened.grantActivationRecoveryBudget({...grant,reportedRowsRead:2341388}),/recovery_replay/);
});

test('permanent finalization rejects finite/drifted snapshots, missing finish/deployment, excessive caps and unknown additions',async t=>{
  for(const change of [
    {scope:'other'}, {reportedRowsRead:2341390}, {reportedRowsRead:1841389}, {reportedRowsRead:3000001},
    {allowance:{httpRequests:1001,sqlStatements:8000}}, {allowance:{httpRequests:1000,sqlStatements:8001}},
  ])await t.test(JSON.stringify(change),async sub=>{
    const {w,grant}=await finalizationFixture(sub);await assert.rejects(w.grantActivationRecoveryBudget({...grant,...change}),/recovery_allowance|recovery_binding/);
  });
  for(const input of [{finite:true},{skipFinish:true},{noDeployment:true}])await t.test(JSON.stringify(input),async sub=>{
    const {w,grant}=await finalizationFixture(sub,input);await assert.rejects(w.grantActivationRecoveryBudget(grant),/recovery_snapshot|recovery_control/);
  });
  for(const kind of ['snapshot','pending','stale'])await t.test(kind,async sub=>{
    const {w,saved,grant,directory}=await finalizationFixture(sub);let actual=grant;
    if(kind==='snapshot')await writeFile(join(directory,'catalog.snapshot.json'),'{}\n',{mode:0o600});
    if(kind==='pending')await w.reserveBudget(reservation('still-pending',0));
    if(kind==='stale')actual={...grant,expectedCheckpointSha256:HASH};
    await assert.rejects(w.grantActivationRecoveryBudget(actual),/recovery_snapshot|recovery_binding|checkpoint_cas/);
    assert.equal((await w.readCheckpoint({controlOnly:true})).sha256,saved.sha256);
  });
  const {w,grant}=await finalizationFixture(t);await w.grantActivationRecoveryBudget(grant);
  await w.reserveBudget(reservation('new-unknown',0));await w.settleBudget('new-unknown',{status:'unknown',usage:null});
  await assert.rejects(w.reserveBudget(reservation('cannot-spend-after-unknown',0)),/recovery_read_budget/);
  assert.equal((await w.budget()).unconfirmedRequests,2);
});

test('catalog-sized technical vector coverage survives reopen; over-bound and duplicate IDs still refuse without native calls',async t=>{
  const f=await fixture(t),w=await f.open(),value=recoveryCheckpoint();
  value.control.publication.vectorPlan.ids=Array.from({length:10000},(_,i)=>`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`);
  const bad=structuredClone(value);bad.control.publication.vectorPlan.ids.push('00000000-0000-4000-8000-999999999999');
  await assert.rejects(w.writeCheckpoint(null,bad),/control/);
  const duplicate=structuredClone(value);duplicate.control.publication.vectorPlan.ids[9999]=duplicate.control.publication.vectorPlan.ids[0];
  await assert.rejects(w.writeCheckpoint(null,duplicate),/control/);
  await w.writeCheckpoint(null,value);await w.close();const reopened=await f.open({mode:'resume'});
  assert.equal((await reopened.readCheckpoint({controlOnly:true})).checkpoint.control.publication.vectorPlan.ids.length,10000);
  assert.equal((await reopened.budget()).httpRequests,0);
});

test('reviewed unactivated upload can adopt capped replacement claims, never a different package/version/permit',async t=>{
  const f=await fixture(t),w=await f.open(),value=recoveryCheckpoint();value.phase='publishing';value.owner.phase='freezing';
  const p=value.control.publication;p.permit=null;p.build.leaseUntil=p.publication.leaseUntil='2026-10-20T12:10:00.000Z';
  const pending=await w.putArtifact({fixture:'independent unactivated/provider and original-row proof'},{kind:'phase',observedAt:NOW});
  value.pins={publicationUploadAcknowledged:pending,leaseRecoveryPending:pending};
  const saved=await w.writeCheckpoint(null,value),ack=await w.putArtifact({fixture:'normal capped replacement claims'},{kind:'phase',observedAt:NOW});
  const next=structuredClone(value);next.pins.leaseRecoveryAcknowledged=ack;
  next.control.publication.build={...p.build,token:'00000000-0000-4000-8000-000000000001',leaseUntil:'2026-10-20T12:25:00.000Z'};
  next.control.publication.publication={...p.publication,token:'00000000-0000-4000-8000-000000000002',leaseUntil:'2026-10-20T12:25:00.000Z'};
  const faults=[c=>{delete c.pins.leaseRecoveryAcknowledged;},c=>{c.control.publication.versionReference='another-version';},
    c=>{c.control.publication.packageSha256='d'.repeat(64);},c=>{c.control.publication.build.request.codeSha='e'.repeat(40);},
    c=>{c.control.publication.build.leaseUntil='2026-10-20T15:00:00.000Z';},c=>{c.owner.epoch++;},
    c=>{c.control.publication.publication.intent.releaseId='different-release';},c=>{c.control.publication.permit=p.permit??publication().permit;}];
  for(const mutate of faults){const bad=structuredClone(next);mutate(bad);await assert.rejects(w.writeCheckpoint(saved.sha256,bad),/control|pin/);}
  const adopted=await w.writeCheckpoint(saved.sha256,next);await w.close();const resumed=await f.open({mode:'resume'});
  assert.deepEqual((await resumed.readCheckpoint()).checkpoint,adopted.checkpoint);
  assert.equal((await resumed.budget()).httpRequests,0);
});

test('explicit recovery grant fixes the ceiling at actual usage, keeps unknown charges, and resumes exactly once',async t=>{
  const f=await fixture(t,{budgetCaps:{httpRequests:1,sqlStatements:100}}),w=await f.open();
  assert.deepEqual(await w.budgetCeiling(),f.input.budgetCaps);
  await w.reserveBudget(reservation('original-unknown',2));await w.settleBudget('original-unknown',{status:'unknown',usage:null});
  const original=await w.writeCheckpoint(null,recoveryCheckpoint()),grant=recoveryGrant(original);
  const manifestBytes=await readFile(join(w.directory,'manifest.json')),bodyBytes=await readFile(join(w.directory,'objects',`${original.sha256}.json`));
  assert.deepEqual(await w.grantActivationRecoveryBudget(grant),{httpRequests:3,sqlStatements:5}); // NOT 100 + 3 SQL.
  const grantFile=(await readdir(join(w.directory,'events'))).sort().at(-1);
  const grantRecord=JSON.parse(await readFile(join(w.directory,'events',grantFile)));
  assert.equal(grantRecord.event.grant.permitSha256,sha256(canonicalJson(original.checkpoint.control.publication.permit)));
  assert.ok(!JSON.stringify(grantRecord).includes('ORIGINAL BODY'));assert.ok(!JSON.stringify(grantRecord).includes('recovery-owner'));
  assert.deepEqual(await w.budget(),{httpRequests:1,sqlStatements:2,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:1});
  const next=await w.writeControlCheckpoint(original.sha256,{phase:'attention',owner:original.checkpoint.owner,
    control:{publication:{...original.checkpoint.control.publication,deploymentId:'observed-original-deployment'}}});
  await w.reserveBudget(reservation('reconcile',3));await w.settleBudget('reconcile',{status:'known',usage:{rowsRead:4,rowsWritten:1}});
  const events=await readdir(join(w.directory,'events'));
  assert.deepEqual(await w.grantActivationRecoveryBudget(grant),{httpRequests:3,sqlStatements:5});
  assert.deepEqual(await readdir(join(w.directory,'events')),events);
  await assert.rejects(w.grantActivationRecoveryBudget({...grant,expectedCheckpointSha256:next.sha256}),/recovery_replay/);
  await assert.rejects(w.grantActivationRecoveryBudget({...grant,approvalReference:HASH}),/recovery_replay/);
  await assert.rejects(w.grantActivationRecoveryBudget({...grant,allowance:{httpRequests:3,sqlStatements:3}}),/recovery_replay/);
  await assert.rejects(w.reserveBudget(reservation('sql-over',1)),/budget_exceeded/);
  await w.reserveBudget(reservation('status-only',0));await assert.rejects(w.reserveBudget(reservation('http-over',0)),/budget_exceeded/);
  assert.deepEqual(await readFile(join(w.directory,'manifest.json')),manifestBytes);
  assert.deepEqual(await readFile(join(w.directory,'objects',`${original.sha256}.json`)),bodyBytes);
  await w.close();const reopened=await f.open({mode:'resume',expectedManifestSha256:w.manifestSha256});
  assert.deepEqual(await reopened.budgetCeiling(),{httpRequests:3,sqlStatements:5});
  assert.deepEqual(await reopened.grantActivationRecoveryBudget(grant),{httpRequests:3,sqlStatements:5});
  assert.equal((await reopened.budget()).unconfirmedRequests,2);
  const status=await readRunWorkspace({...f.input,mode:'resume'});assert.deepEqual(status.budgetCeiling,{httpRequests:3,sqlStatements:5});
  assert.equal(status.manifest.budgetCaps.sqlStatements,100);assert.equal(status.budget.sqlStatements,5);
});

test('recovery grant refuses missing/foreign/preactivation controls, mismatched permit owners, invalid allowances and stale CAS',async t=>{
  const mutations={missing:c=>{delete c.control;},foreign:c=>{const p=c.control.publication;p.runReference=p.build.runReference=p.permit.runReference='foreign-run';},
    ownerReference:c=>{c.owner.ownerReference='test-run:other';c.control.publication.permit.mutationOwner=structuredClone(c.owner);},
    preactivation:c=>{c.control.publication.stage='uploaded';},published:c=>{c.control.publication.stage='published';c.control.publication.receiptSha256=HASH;},missingPermit:c=>{c.control.publication.permit=null;},
    missingPermitOwner:c=>{delete c.control.publication.permit.mutationOwner;},
    mismatch:c=>{c.control.publication.permit.mutationOwner.epoch++;},
    wrongPhase:c=>{c.owner.phase='freezing';c.control.publication.permit.mutationOwner=structuredClone(c.owner);},
    requestId:c=>{const p=c.control.publication;p.requestId=p.build.requestId=p.permit.requestId='not-the-request-digest';}};
  for(const [name,mutate]of Object.entries(mutations))await t.test(name,async sub=>{
    const f=await fixture(sub),w=await f.open(),value=recoveryCheckpoint();mutate(value);const saved=await w.writeCheckpoint(null,value);
    await assert.rejects(w.grantActivationRecoveryBudget(recoveryGrant(saved)),/recovery_control/);
    assert.deepEqual(await w.budgetCeiling(),f.input.budgetCaps);
  });
  const f=await fixture(t),w=await f.open();await assert.rejects(w.grantActivationRecoveryBudget(recoveryGrant({sha256:HASH})),/checkpoint_cas/);
  const saved=await w.writeCheckpoint(null,recoveryCheckpoint());
  await assert.rejects(w.grantActivationRecoveryBudget({...recoveryGrant(saved),expectedCheckpointSha256:HASH}),/checkpoint_cas/);
  for(const bad of [{httpRequests:151,sqlStatements:3},{httpRequests:2,sqlStatements:301},{httpRequests:-1,sqlStatements:0},{httpRequests:1.5,sqlStatements:0}])
    await assert.rejects(w.grantActivationRecoveryBudget(recoveryGrant(saved,bad)),/recovery_allowance/);
  await assert.rejects(w.grantActivationRecoveryBudget({...recoveryGrant(saved),approvalReference:'unapproved'}),/recovery_allowance/);
  await assert.rejects(w.grantActivationRecoveryBudget({...recoveryGrant(saved),extra:true}),/recovery_allowance/);
  await assert.rejects(w.grantActivationRecoveryBudget(recoveryGrant(saved,{httpRequests:1,sqlStatements:1,extra:1})),/recovery_allowance/);
  const grants=await Promise.allSettled([w.grantActivationRecoveryBudget(recoveryGrant(saved,{httpRequests:150,sqlStatements:300})),
    w.grantActivationRecoveryBudget(recoveryGrant(saved,{httpRequests:149,sqlStatements:300}))]);
  assert.equal(grants.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(await w.budgetCeiling(),{httpRequests:150,sqlStatements:300});
});

test('recovery allowance remains activation-bound and permits only exact published control reconciliation',async t=>{
  const f=await fixture(t),w=await f.open(),saved=await w.writeCheckpoint(null,recoveryCheckpoint());
  await w.grantActivationRecoveryBudget(recoveryGrant(saved));
  const changed={...saved.checkpoint,owner:{...saved.checkpoint.owner,phase:'writing'}};
  const writing=await w.writeCheckpoint(saved.sha256,changed);
  await assert.rejects(w.reserveBudget(reservation('cannot-write',0)),/recovery_control/);
  const restored=await w.writeCheckpoint(writing.sha256,saved.checkpoint);
  const published={...saved.checkpoint.control.publication,stage:'published',deploymentId:'original-deployment'};
  const noReceipt=await w.writeControlCheckpoint(restored.sha256,{phase:'attention',owner:saved.checkpoint.owner,control:{publication:published}});
  await assert.rejects(w.reserveBudget(reservation('cannot-resolve-without-receipt',0)),/recovery_control/);
  published.receiptSha256=HASH;
  const accepted=await w.writeControlCheckpoint(noReceipt.sha256,{phase:'attention',owner:saved.checkpoint.owner,control:{publication:published}});
  await w.reserveBudget(reservation('resolve-original-build-activation',0));
  await w.settleBudget('resolve-original-build-activation',{status:'known',usage:{rowsRead:1,rowsWritten:1}});
  await w.writeControlCheckpoint(accepted.sha256,{phase:'published',owner:null,control:{publication:published}});
  await w.reserveBudget(reservation('final-read-only-confirmation',0));
  assert.deepEqual(await w.grantActivationRecoveryBudget(recoveryGrant(saved)),{httpRequests:2,sqlStatements:3});
  await assert.rejects(w.grantActivationRecoveryBudget({...recoveryGrant(restored),approvalReference:HASH}),/recovery_replay/);
});

test('recovery journal semantic replay rejects forged usage, permit, checkpoint and duplicate grants even with valid hash chain',async t=>{
  for(const kind of ['usage','permit','checkpoint','duplicate','unknown'])await t.test(kind,async sub=>{
    const f=await fixture(sub),w=await f.open(),saved=await w.writeCheckpoint(null,recoveryCheckpoint());
    await w.reserveBudget(reservation('before-grant',2));await w.grantActivationRecoveryBudget(recoveryGrant(saved));await w.close();
    const directory=join(w.directory,'events'),names=(await readdir(directory)).sort(),records=await Promise.all(names.map(async name=>JSON.parse(await readFile(join(directory,name)))));
    const record=records.at(-1);
    if(kind==='usage')record.event.grant.usage.sqlStatements=0;
    if(kind==='permit')record.event.grant.permitSha256=HASH;
    if(kind==='checkpoint')record.event.grant.expectedCheckpointSha256=HASH;
    if(kind==='unknown')record.event.type='unknown-recovery-budget';
    if(kind==='duplicate')records.push({...structuredClone(record),sequence:record.sequence+1});
    for(const name of names)await unlink(join(directory,name));let parent=null;
    for(const value of records){value.parent=parent;parent=sha256(canonicalJson(value));await tamper(join(directory,`${String(value.sequence).padStart(6,'0')}.${parent}.json`),value);}
    await tamper(join(w.directory,'head.json'),{sequence:records.length,sha256:parent});
    await assert.rejects(f.open({mode:'resume'}),/recovery_binding|checkpoint_cas|recovery_duplicate|run_workspace_event/);
  });
});

test('expired control-only reconciliation preserves hidden state and all claims without content renewal',async t=>{
  const f=await fixture(t),w=await f.open();const first=await w.writeCheckpoint(null,{...cp({private:'OLD SEALED STATE'}),phase:'publishing',control:{publication:publication()}});
  f.setNow(LATER);const p={...publication(),stage:'published',deploymentId:'test-deployed',receiptSha256:HASH};
  const result=await w.writeControlCheckpoint(first.sha256,{phase:'published',owner:null,control:{publication:p}});
  assert.equal(result.checkpoint.phase,'published');assert.equal(result.checkpoint.state,undefined);
  assert.deepEqual(await w.writeControlCheckpoint(first.sha256,{phase:'published',owner:null,control:{publication:p}}),result);
  await assert.rejects(w.readCheckpoint(),/expired/);
  await assert.rejects(w.writeControlCheckpoint(result.sha256,{phase:'published',owner:null,control:{publication:{...p,versionReference:'DIFFERENT'}}}),/control/);
  await assert.rejects(w.writeControlCheckpoint(result.sha256,{phase:'published',owner:null,control:{publication:{...p,stage:'built'}}}),/control_reconciliation/);
  const status=await readRunWorkspace({...f.input,mode:'resume'});assert.equal(status.checkpoint.sha256,result.sha256);assert.ok(!JSON.stringify(status).includes('OLD SEALED'));
  const objects=await readdir(join(w.directory,'objects'));assert.equal(objects.length,1); // No replacement expired body.
  const stored=JSON.parse(await readFile(join(w.directory,'objects',objects[0]),'utf8'));assert.equal(stored.value.state.private,'OLD SEALED STATE');assert.equal(stored.observedAt,NOW);
});

test('purge removes expired classified bodies and checkpoints, retains activation control/budgets and is restart-idempotent',async t=>{
  const f=await fixture(t),w=await f.open(),r=observation();
  const receipt=await w.saveReceipt({sha256:sha256(canonicalJson(r)),receipt:r});
  const blob=await w.putBlob(Buffer.alloc(WORKSPACE_BLOB_LIMITS.chunkBytes+1,0x31),{kind:'publication',observedAt:NOW});
  const first=await w.writeCheckpoint(null,{...cp({secret:'DELETE EXPIRED TEST CONTENT'}),phase:'publishing',pins:{receipt,blob},control:{publication:publication()}});
  await w.reserveBudget(reservation('uncertain',0));
  await writeFile(join(w.directory,'objects','unrelated.txt'),'private imported history',{mode:0o600});
  await writeFile(join(w.directory,'objects','.pending-unknown'),'partial private history',{mode:0o600});
  const checkpointBytes=await readFile(join(w.directory,'objects',`${first.sha256}.json`));f.setNow(LATER);
  const purged=await w.purgeExpired();assert.equal(purged.length,5);
  assert.deepEqual((await readdir(join(w.directory,'objects'))).sort(),['.pending-unknown','unrelated.txt']);
  await assert.rejects(w.readReceipt(receipt),/expired/);await assert.rejects(w.readCheckpoint(),/expired/);
  assert.equal((await w.readCheckpoint({controlOnly:true})).checkpoint.control.publication.stage,'activating');
  assert.equal((await w.budget()).unconfirmedRequests,1);assert.deepEqual(await w.purgeExpired(),[]);
  // Crash after a durable purge record but before unlink: exact body readback
  // completes deletion without a second tombstone or any provider replay.
  await writeFile(join(w.directory,'objects',`${first.sha256}.json`),checkpointBytes,{mode:0o600});
  await w.close();const resumed=await f.open({mode:'resume'});const events=await readdir(join(w.directory,'events'));
  assert.equal((await resumed.purgeExpired()).length,1);assert.deepEqual(await readdir(join(w.directory,'events')),events);
  const view=await resumed.readCheckpoint({controlOnly:true});
  await resumed.writeControlCheckpoint(view.sha256,{phase:'published',owner:null,control:{publication:{...publication(),stage:'published',deploymentId:'test-result'}}});
  const status=await readRunWorkspace({...f.input,mode:'resume'});assert.equal(status.checkpoint.checkpoint.phase,'published');
  assert.equal(status.expired.length,5);assert.ok(!JSON.stringify(status).includes('DELETE EXPIRED'));
  f.setNow(NOW);await assert.rejects(resumed.putArtifact({renew:true},{kind:'phase',observedAt:NOW}),/expired/);
});

test('purge prevalidates corruption, symlink and hardlink boundaries without touching outside/private history',async t=>{
  for(const corruption of ['hash','symlink','hardlink'])await t.test(corruption,async sub=>{
    const f=await fixture(sub),w=await f.open();
    const first=await w.putArtifact({fixture:'first'},{kind:'phase',observedAt:NOW});
    const last=await w.putArtifact({fixture:'last'},{kind:'phase',observedAt:NOW});
    const file=join(w.directory,last.reference),outside=join(f.parent,'imported.json');
    if(corruption==='hash'){const body=JSON.parse(await readFile(file));body.value.fixture='changed';await tamper(file,body);}
    else if(corruption==='symlink'){await writeFile(outside,'KEEP PRIVATE HISTORY',{mode:0o600});await unlink(file);await symlink(outside,file);}
    else await link(file,outside);
    f.setNow(LATER);await assert.rejects(w.purgeExpired(),/artifact_hash|permissions/);
    assert.ok((await readFile(join(w.directory,first.reference))).length);
    if(corruption==='symlink')assert.equal(await readFile(outside,'utf8'),'KEEP PRIVATE HISTORY');
  });
});

test('purge covers complete interrupted object temp envelopes and unregistered bodies, never guesses partial retention',async t=>{
  const f=await fixture(t),w=await f.open();const ref=await w.putArtifact({fixture:'complete temp'},{kind:'phase',observedAt:NOW});
  const temp=join(w.directory,'objects','.pending-00000000-0000-4000-8000-000000000001');
  await writeFile(temp,await readFile(join(w.directory,ref.reference)),{mode:0o600});
  f.setNow(LATER);assert.equal((await w.purgeExpired()).length,2);assert.deepEqual(await readdir(join(w.directory,'objects')),[]);
  await w.close();const resumed=await f.open({mode:'resume'});assert.deepEqual(await resumed.purgeExpired(),[]);
});

test('lost reserve/checkpoint/grant head commits recover the durable trailing record, never refund or replay',async t=>{
  for(const kind of ['reserve','checkpoint','grant'])await t.test(kind,async sub=>{
    const f=await fixture(sub),w=await f.open();
    if(kind==='reserve')await w.reserveBudget(reservation('lost-ack',0));
    else if(kind==='checkpoint')await w.writeCheckpoint(null,cp({fixture:'durable checkpoint'}));
    else await w.grantActivationRecoveryBudget(recoveryGrant(await w.writeCheckpoint(null,recoveryCheckpoint())));
    await w.close();const eventNames=(await readdir(join(w.directory,'events'))).sort(),last=JSON.parse(await readFile(join(w.directory,'events',eventNames.at(-1))));
    const previous={sequence:last.sequence-1,sha256:last.parent};await tamper(join(w.directory,'head.json'),previous);
    const status=await readRunWorkspace({...f.input,mode:'resume'});
    assert.deepEqual(JSON.parse(await readFile(join(w.directory,'head.json'))),previous); // status never repairs
    const resumed=await f.open({mode:'resume'});
    if(kind==='reserve'){assert.equal(status.budget.unconfirmedRequests,1);await resumed.reserveBudget(reservation('lost-ack',0));assert.equal((await resumed.budget()).httpRequests,1);}
    else if(kind==='checkpoint'){const checkpoint=await resumed.readCheckpoint();assert.equal(checkpoint.checkpoint.state.fixture,'durable checkpoint');assert.equal((await resumed.writeCheckpoint(null,cp({fixture:'durable checkpoint'}))).sha256,checkpoint.sha256);}
    else {assert.deepEqual(await resumed.budgetCeiling(),{httpRequests:2,sqlStatements:3});await resumed.grantActivationRecoveryBudget(recoveryGrant(await resumed.readCheckpoint()));}
    assert.deepEqual(await readdir(join(w.directory,'events')),eventNames);
    assert.equal(JSON.parse(await readFile(join(w.directory,'head.json'))).sequence,last.sequence);
  });
});

async function publicationFixture(t){
  const f=await fixture(t);f.input.repository=join(f.parent,'source');
  await mkdir(join(f.input.repository,'static-site'),{recursive:true,mode:0o700});
  await mkdir(join(f.input.repository,'build'),{mode:0o700});
  const outputPaths=['build/stupid-gifts','static-site/out','static-site/.next'].map(name=>join(f.input.repository,name));
  async function outputs(w,releaseId){
    for(const path of [...outputPaths,join(w.directory,'packages',releaseId)]){
      await mkdir(join(path,'nested'),{recursive:true,mode:0o700});await writeFile(join(path,'nested','merchant.json'),'TEST ONLY EXPIRED MERCHANT COPY',{mode:0o600});
    }
  }
  return{...f,outputPaths,outputs};
}

test('combined publication cleanup has its own100k entry cap, independent of20k journal/upload limits',()=>{
  for(const count of [0,20_000,7+17_680+27_993,100_000])assert.doesNotThrow(()=>assertPublicationCleanupEntryCount(count));
  for(const count of [-1,1.5,NaN,Infinity,100_001])assert.throws(()=>assertPublicationCleanupEntryCount(count),/run_workspace_publication_tree/);
});

test('publication ownership covers interrupted/expired package+Next copies without deleting preexisting manual outputs',async t=>{
  const f=await publicationFixture(t),w=await f.open();
  await mkdir(f.outputPaths[0],{mode:0o700});await writeFile(join(f.outputPaths[0],'history'),'KEEP MANUAL HISTORY',{mode:0o600});
  await assert.rejects(w.preparePublicationDirectories('release-1',NOW,null),/publication_path_exists/);
  f.setNow(LATER);assert.deepEqual(await w.purgeExpired(),[]);assert.equal(await readFile(join(f.outputPaths[0],'history'),'utf8'),'KEEP MANUAL HISTORY');
  f.setNow(NOW);await rm(f.outputPaths[0],{recursive:true});
  await w.preparePublicationDirectories('release-1',NOW,'2026-10-20T12:20:00.000Z');await f.outputs(w,'release-1');
  await w.close();f.setNow('2026-10-20T12:10:00.000Z');const resumed=await f.open({mode:'resume'});
  await resumed.preparePublicationDirectories('release-1',NOW,'2026-10-20T12:20:00.000Z');
  assert.deepEqual(await resumed.purgeExpired(),[]);f.setNow('2026-10-20T12:20:00.000Z');
  assert.equal((await resumed.purgeExpired())[0].reference,'packages/release-1');
  for(const path of [...f.outputPaths,join(w.directory,'packages/release-1')])await assert.rejects(lstat(path),{code:'ENOENT'});
  assert.deepEqual(await resumed.purgeExpired(),[]);await resumed.close();const expired=await f.open({mode:'resume'});
  await assert.rejects(expired.preparePublicationDirectories('renew',LATER,null),/expired/);
  assert.equal((await readRunWorkspace({...f.input,mode:'resume'})).expired.length,1);
});

test('verified package cleanup frees the same checkout for a second run; old expiry never deletes the next run outputs',async t=>{
  const f=await publicationFixture(t),first=await f.open();await first.preparePublicationDirectories('release-1',NOW,null);await f.outputs(first,'release-1');
  await first.cleanPublicationBuild('release-1');await first.cleanPublicationBuild('release-1');await first.close();
  const second=await f.open({runId:'second-run'});await second.preparePublicationDirectories('release-2',NOW,null);await f.outputs(second,'release-2');await second.close();
  f.setNow(LATER);const old=await f.open({mode:'resume'});await old.purgeExpired();await old.close();
  for(const path of f.outputPaths)assert.equal(await readFile(join(path,'nested/merchant.json'),'utf8'),'TEST ONLY EXPIRED MERCHANT COPY');
  const pending=await f.open({mode:'resume',runId:'second-run'});await pending.purgeExpired();
  for(const path of f.outputPaths)await assert.rejects(lstat(path),{code:'ENOENT'});
});

test('registered publication cleanup rejects symlinks/hardlinks and retains unrelated source paths',async t=>{
  for(const kind of ['symlink','hardlink'])await t.test(kind,async sub=>{
    const f=await publicationFixture(sub),w=await f.open();await w.preparePublicationDirectories('release',NOW,null);await f.outputs(w,'release');
    const outside=join(f.input.repository,'unrelated.json');await writeFile(outside,'KEEP IMPORTED HISTORY',{mode:0o600});
    const target=join(w.directory,'packages/release/escape');if(kind==='symlink')await symlink(outside,target);else await link(outside,target);
    f.setNow(LATER);await assert.rejects(w.purgeExpired(),/publication_tree/);
    assert.equal(await readFile(outside,'utf8'),'KEEP IMPORTED HISTORY');
    assert.equal(await readFile(join(f.outputPaths[0],'nested/merchant.json'),'utf8'),'TEST ONLY EXPIRED MERCHANT COPY');
  });
});

test('expired lost activation-CAS recovery can only pin the exact same-owner activation permit',async t=>{
  const f=await fixture(t),w=await f.open();
  const owner={environment:scope.environment,indexName:scope.indexName,token:'test-owner-token',generation:1,epoch:7,phase:'freezing',
    ownerReference:'test/run',operationKey:HASH,capturedAt:new Date(NOW).toISOString()};
  const p={...publication(),permit:null};const first=await w.writeCheckpoint(null,{...cp(),phase:'publishing',owner,control:{publication:p}});
  f.setNow(LATER);const activated={...owner,phase:'activating'},permit={...publication().permit,mutationOwner:activated};
  await assert.rejects(w.writeControlCheckpoint(first.sha256,{phase:'attention',owner:activated,control:{publication:{...p,permit:{...permit,versionReference:'wrong-version'}}}}),/control/);
  const recovered=await w.writeControlCheckpoint(first.sha256,{phase:'attention',owner:activated,control:{publication:{...p,permit}}});
  assert.equal(recovered.checkpoint.owner.phase,'activating');assert.equal(recovered.checkpoint.control.publication.permit.versionReference,p.versionReference);
  const settled=await w.writeControlCheckpoint(recovered.sha256,{phase:'published',owner:null,control:{publication:{...p,permit,stage:'published',deploymentId:'test-result'}}});
  assert.equal(settled.checkpoint.owner,null);await assert.rejects(w.readCheckpoint(),/expired/);
});

test('control-only reconciliation cannot adopt a different owner or release an unsettled activation',async t=>{
  const f=await fixture(t),w=await f.open();
  const owner={environment:scope.environment,indexName:scope.indexName,token:'test-owner',generation:2,epoch:9,phase:'activating',
    ownerReference:'test/run',operationKey:HASH,capturedAt:new Date(NOW).toISOString()};
  const p={...publication(),permit:{...publication().permit,mutationOwner:owner}};
  const first=await w.writeCheckpoint(null,{...cp(),phase:'publishing',owner,control:{publication:p}});f.setNow(LATER);
  for(const changed of [{...owner,token:'other-owner'},{...owner,generation:3},{...owner,epoch:10},null])
    await assert.rejects(w.writeControlCheckpoint(first.sha256,{phase:'attention',owner:changed,control:{publication:p}}),/control_owner/);
  const attention=await w.writeControlCheckpoint(first.sha256,{phase:'attention',owner,control:{publication:p}});
  assert.deepEqual(attention.checkpoint.owner,owner);
  const published=await w.writeControlCheckpoint(attention.sha256,{phase:'published',owner:null,control:{publication:{...p,stage:'published'}}});
  assert.equal(published.checkpoint.owner,null);
});

test('absolute reviewed deadline caps original observation age and cannot be extended by a later replay',async t=>{
  const reviewed=policy();reviewed.rules['amazon-observation'].notAfter='2026-10-20T12:10:00.000Z';
  const f=await fixture(t,{retention:reviewed}),w=await f.open(),r=observation();const ref=await w.saveReceipt({sha256:sha256(canonicalJson(r)),receipt:r});
  const sealed=JSON.parse(await readFile(join(w.directory,ref.reference),'utf8'));assert.equal(sealed.expiresAt,'2026-10-20T12:10:00.000Z');
  f.setNow('2026-10-20T12:10:00.000Z');await assert.rejects(w.readReceipt(ref),/expired/);
  const later={...r,observedAt:'2026-10-20T12:09:00.000Z'};await assert.rejects(w.saveReceipt({sha256:sha256(canonicalJson(later)),receipt:later}),/expired/);
  assert.equal((await readdir(join(w.directory,'objects'))).length,1);
});

test('shared database and Worker locks exclude different runs and do not auto-takeover',async t=>{
  const f=await fixture(t),w=await f.open();
  await assert.rejects(f.open({runId:'second-run'}),/locked/);
  await assert.rejects(f.open({runId:'second-run',scope:{...scope,databaseId:'other-db'}}),/locked/);
  await assert.rejects(f.open({runId:'second-run',scope:{...scope,workerName:'other-worker'}}),/locked/);
  assert.equal((await readdir(join(f.input.directory,'locks'))).length,3);
  await w.close();const second=await f.open({runId:'second-run'});await second.assertHeld();
  const locks=await readdir(join(f.input.directory,'locks'));const path=join(f.input.directory,'locks',locks[0]);
  await tamper(path,{schemaVersion:1,token:'not-ours'});await assert.rejects(second.assertHeld(),/lock_lost/);
  await assert.rejects(second.close(),/lock_lost/);await assert.rejects(f.open({mode:'resume',runId:'second-run'}),/locked/);
});

test('killed process leaves an explicit blocking resource lock; readonly status does not claim it',async t=>{
  const f=await fixture(t);const clean={...f.input};delete clean.now;
  const code=`import {openRunWorkspace} from ${JSON.stringify(new URL('../scripts/catalog/run-workspace.ts',import.meta.url).href)};await openRunWorkspace({...${JSON.stringify(clean)},now:()=>${JSON.stringify(NOW)}});process.stdout.write('held');setInterval(()=>{},1000);`;
  const child=spawn(process.execPath,['--experimental-strip-types','--input-type=module','-e',code],{stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,NODE_ENV:'test'}});
  let err='';child.stderr.on('data',data=>{err+=data;});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(new Error(`fixture child failed: ${err}`)));});
  child.kill('SIGKILL');await new Promise(resolve=>child.once('exit',resolve));
  await assert.rejects(f.open({mode:'resume'}),/locked/);const status=await readRunWorkspace({...f.input,mode:'resume'});assert.equal(status.manifest.runId,'test-run');
});

test('reopen rejects changed policy/config/code/scope and accepts only exact manifest hash',async t=>{
  const f=await fixture(t),w=await f.open();await w.close();
  for(const change of [{configSha256:'c'.repeat(64)},{codeSha:'d'.repeat(40)},{scope:{...scope,indexName:'different'}},
    {retention:{...policy(),reviewReference:'different-review'}},{expectedManifestSha256:'e'.repeat(64)}])await assert.rejects(f.open({mode:'resume',...change}),/manifest_mismatch/);
  await f.open({mode:'resume',expectedManifestSha256:w.manifestSha256});
});

test('traversal, Git destinations, symlink parents/intermediates and insecure modes are rejected',async t=>{
  const f=await fixture(t);await assert.rejects(f.open({directory:join(f.parent,'x','..','workspace')+'/../other'}),/path/);
  await assert.rejects(f.open({runId:'..'}),/configuration/);
  await assert.rejects(f.open({directory:join(f.input.repository,'private-workspace')}),/repository|Git|private/);
  await mkdir(join(f.parent,'real'),{mode:0o700});await symlink(join(f.parent,'real'),join(f.parent,'linked'));
  await assert.rejects(f.open({directory:join(f.parent,'linked','workspace')}),/symlink/);
  const w=await f.open();await w.close();await chmod(join(w.directory,'objects'),0o755);
  await assert.rejects(f.open({mode:'resume'}),/permissions/);await chmod(join(w.directory,'objects'),0o700);
  await rm(join(w.directory,'objects'),{recursive:true});await symlink(join(f.parent,'real'),join(w.directory,'objects'));
  await assert.rejects(f.open({mode:'resume'}),/permissions/);
});

test('hardlinks, changed file modes and mismatched hash cannot be loaded as evidence',async t=>{
  const f=await fixture(t),w=await f.open();const ref=await w.putArtifact({fixture:'owned'},{kind:'phase',observedAt:NOW}),path=join(w.directory,ref.reference);
  await link(path,join(f.parent,'hardlink'));await assert.rejects(w.readArtifact(ref),/permissions/);await unlink(join(f.parent,'hardlink'));
  await chmod(path,0o644);await assert.rejects(w.readArtifact(ref),/permissions/);await chmod(path,0o600);
  const data=JSON.parse(await readFile(path,'utf8'));data.value.fixture='tampered';await tamper(path,data);
  await assert.rejects(w.readArtifact(ref),/artifact_hash/);await w.close();await assert.rejects(f.open({mode:'resume'}),/artifact_hash/);
});

test('checkpoint hardlinks and oversized on-disk JSON are rejected before body use',async t=>{
  const f=await fixture(t),w=await f.open();const result=await w.writeCheckpoint(null,cp());
  const path=join(w.directory,'objects',`${result.sha256}.json`);await link(path,join(f.parent,'checkpoint-link'));
  await assert.rejects(w.readCheckpoint(),/permissions/);await unlink(join(f.parent,'checkpoint-link'));
  await writeFile(path,'x'.repeat(1024*1024+1),{mode:0o600});await assert.rejects(w.readCheckpoint(),/bytes/);
});

test('journal gaps/truncation and partial JSON fail closed instead of refunding a paid reservation',async t=>{
  const f=await fixture(t),w=await f.open();await w.reserveBudget(reservation());await w.close();
  const eventDir=join(w.directory,'events'),files=await readdir(eventDir);assert.equal(files.length,1);await unlink(join(eventDir,files[0]));
  await assert.rejects(f.open({mode:'resume'}),/journal_head/);
  await writeFile(join(eventDir,files[0]),'{partial',{mode:0o600});await assert.rejects(f.open({mode:'resume'}),/json/);
});

test('interrupted private temporary file is never interpreted as a committed artifact/event',async t=>{
  const f=await fixture(t),w=await f.open();await w.reserveBudget(reservation());await w.close();
  await writeFile(join(w.directory,'events','.pending-interrupted'),'{partial',{mode:0o600});
  await writeFile(join(w.directory,'objects','.pending-interrupted'),'{partial',{mode:0o600});
  const resumed=await f.open({mode:'resume'});assert.equal((await resumed.budget()).unconfirmedRequests,1);
  assert.equal((await readdir(join(w.directory,'objects'))).length,1); // Not silently swept/deleted.
});

test('unreviewed policy, malformed/unknown receipts, oversized bytes and forged references are refused',async t=>{
  const f=await fixture(t);await assert.rejects(f.open({retention:undefined}),/retention_policy/);
  const w=await f.open(),r=observation();
  await assert.rejects(w.saveReceipt({sha256:HASH,receipt:r}),/receipt_hash/);
  const headers={...r,headers:{authorization:'TEST ONLY NOT A SECRET'}};
  await assert.rejects(w.saveReceipt({sha256:sha256(canonicalJson(headers)),receipt:headers}),/receipt/);
  await assert.rejects(w.putArtifact({body:'x'.repeat(512*1024)},{kind:'phase',observedAt:NOW}),/bytes/);
  await assert.rejects(w.readArtifact({sha256:HASH,reference:'../outside.json'}),/unregistered_artifact|reference/);
  await assert.rejects(w.writeCheckpoint(null,{...cp(),control:{unknown:{rawBody:'private'}}}),/control/);
});

test('3383 native-vector blobs preserve exact ordered bytes, private chunk bounds, checkpoint/reopen and original expiry',async t=>{
  const f=await fixture(t),w=await f.open();const values=Array(1536).fill(Math.fround(.1));values[0]=-0;values[1]=Math.fround(1e-45);
  const nativeBase64=encodePgvectorSendBase64(values),vectorBytesSha256=sha256(Buffer.from(nativeBase64,'base64'));
  const rows=Object.fromEntries(Array.from({length:3383},(_,i)=>[`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,{nativeBase64,vectorBytesSha256}]));
  const bytes=Buffer.from(` {\n${JSON.stringify(rows).slice(1,-1)}\n}\n`);assert.ok(bytes.length>28_000_000&&bytes.length<WORKSPACE_BLOB_LIMITS.bytes);
  const ref=await w.putBlob(bytes,{kind:'phase',observedAt:NOW}),descriptor=await w.readArtifact(ref);
  assert.equal(descriptor.type,'run-workspace-blob');assert.equal(descriptor.sha256,sha256(bytes));assert.equal(descriptor.byteLength,bytes.length);
  assert.notEqual(ref.sha256,descriptor.sha256);assert.equal(descriptor.parts.length,Math.ceil(bytes.length/WORKSPACE_BLOB_LIMITS.chunkBytes));
  assert.deepEqual(await w.readBlob(ref),bytes);
  const original=await readFile(join(w.directory,ref.reference));
  const envelopes=await Promise.all((await readdir(join(w.directory,'objects'))).map(async name=>{
    const file=join(w.directory,'objects',name);assert.ok((await lstat(file)).size<=512*1024);assert.equal((await lstat(file)).mode&0o777,0o600);
    const v=JSON.parse(await readFile(file,'utf8'));assert.equal(v.observedAt,NOW);assert.equal(v.expiresAt,'2026-10-20T13:00:00.000Z');return v;
  }));assert.equal(envelopes.length,descriptor.parts.length+1);
  const small=await w.putArtifact({legacy:'small format unchanged'},{kind:'phase',observedAt:NOW});
  await w.reserveBudget(reservation('pending-before-close',0));
  await w.writeCheckpoint(null,{...cp({vectorCount:3383}),phase:'phases_complete',pins:{originalVectors:ref,small},phaseComplete:ref});
  await w.close();f.setNow('2026-10-20T12:30:00.000Z');const resumed=await f.open({mode:'resume'});
  assert.deepEqual((await resumed.readCheckpoint()).checkpoint.pins.originalVectors,ref);
  assert.deepEqual(await resumed.readArtifact(small),{legacy:'small format unchanged'});
  assert.equal((await resumed.budget()).unconfirmedRequests,1);
  const restored=await resumed.readBlob(ref);assert.deepEqual(restored,bytes);
  const decoded=decodePgvectorSendBase64(JSON.parse(Buffer.from(restored).toString('utf8'))[Object.keys(rows)[0]].nativeBase64);
  assert.ok(Object.is(decoded[0],-0));assert.equal(decoded[1],Math.fround(1e-45));assert.equal(encodePgvectorSendBase64(decoded),nativeBase64);
  assert.deepEqual(await resumed.putBlob(bytes,{kind:'phase',observedAt:'2026-10-20T12:30:00.000Z'}),ref);
  assert.deepEqual(await readFile(join(w.directory,ref.reference)),original);
  f.setNow('2026-10-20T13:00:00.000Z');await assert.rejects(resumed.readBlob(ref),/expired/);
  await assert.rejects(resumed.putBlob(bytes,{kind:'phase',observedAt:LATER}),/expired/);
  assert.equal((await resumed.readCheckpoint({controlOnly:true})).checkpoint.phase,'phases_complete');
  await resumed.close();const expired=await f.open({mode:'resume'});await assert.rejects(expired.readBlob(ref),/expired/);
});

test('partial blob retry recovers original chunk retention without renewal or overwriting committed bytes',async t=>{
  const source=await fixture(t),writer=await source.open(),bytes=Buffer.alloc(WORKSPACE_BLOB_LIMITS.chunkBytes+17,0x31);
  const ref=await writer.putBlob(bytes,{kind:'publication',observedAt:NOW}),descriptor=await writer.readArtifact(ref);
  const first=await readFile(join(writer.directory,'objects',`${descriptor.parts[0]}.json`));
  const partial=await fixture(t),w=await partial.open();
  // Exact crash boundary: first durable chunk exists, its journal registration
  // and later chunks/manifest were not acknowledged. No automatic lock takeover.
  await writeFile(join(w.directory,'objects',`${descriptor.parts[0]}.json`),first,{mode:0o600,flag:'wx'});
  partial.setNow('2026-10-20T12:30:00.000Z');
  assert.deepEqual(await w.putBlob(bytes,{kind:'publication',observedAt:'2026-10-20T12:30:00.000Z'}),ref);
  assert.deepEqual(await readFile(join(w.directory,'objects',`${descriptor.parts[0]}.json`)),first);
  for(const name of await readdir(join(w.directory,'objects'))){const v=JSON.parse(await readFile(join(w.directory,'objects',name),'utf8'));
    assert.equal(v.observedAt,NOW);assert.equal(v.expiresAt,'2026-10-20T13:00:00.000Z');}
  assert.deepEqual(await w.readBlob(ref),bytes);await assert.rejects(w.putBlob(bytes,{kind:'phase',observedAt:NOW}),/kind/);
});

test('blob manifests and chunks reject missing, duplicated, reordered, tampered, truncated and mixed evidence',async t=>{
  const cases={
    missing:async({first})=>unlink(first),
    truncated:async({first})=>writeFile(first,'{"partial":',{mode:0o600}),
    tampered:async({first,part})=>tamper(first,{...part,value:{...part.value,base64:'A'.repeat(part.value.base64.length)}}),
    hardlinked:async({first,w})=>link(first,join(w.directory,'alias')),
    kind:async({first,part})=>tamper(first,{...part,kind:'publication'}),
    observation:async({first,part})=>tamper(first,{...part,observedAt:'2026-10-20T12:01:00.000000Z',expiresAt:'2026-10-20T13:01:00.000Z'}),
    deadline:async({first,part})=>tamper(first,{...part,expiresAt:'2026-10-20T13:01:00.000Z'}),
    policy:async({first,part})=>tamper(first,{...part,policySha256:'e'.repeat(64)}),
    duplicate:async({descriptor})=>({...descriptor,parts:[descriptor.parts[0],descriptor.parts[0]]}),
    paths:async({descriptor})=>({...descriptor,parts:['../untrusted',descriptor.parts[1]]}),
    reordered:async({descriptor})=>({...descriptor,parts:[...descriptor.parts].reverse()}),
    length:async({descriptor})=>({...descriptor,byteLength:descriptor.byteLength-1}),
    excess:async({descriptor})=>({...descriptor,path:'../not-permitted'}),
    version:async({descriptor})=>({...descriptor,schemaVersion:2}),
    bound:async({descriptor})=>({...descriptor,byteLength:WORKSPACE_BLOB_LIMITS.bytes+1}),
    ordinal:async({w,descriptor,part})=>{const changed=await w.putArtifact({...part.value,index:1},{kind:'phase',observedAt:NOW});
      return{...descriptor,parts:[changed.sha256,descriptor.parts[1]]};},
    chunkExcess:async({w,descriptor,part})=>{const changed=await w.putArtifact({...part.value,path:'untrusted'},{kind:'phase',observedAt:NOW});
      return{...descriptor,parts:[changed.sha256,descriptor.parts[1]]};},
    blobIdentity:async({w,descriptor,part})=>{const changed=await w.putArtifact({...part.value,blobSha256:'f'.repeat(64)},{kind:'phase',observedAt:NOW});
      return{...descriptor,parts:[changed.sha256,descriptor.parts[1]]};},
    base64:async({w,descriptor,part})=>{const changed=await w.putArtifact({...part.value,base64:'!'.repeat(part.value.base64.length)},{kind:'phase',observedAt:NOW});
      return{...descriptor,parts:[changed.sha256,descriptor.parts[1]]};},
  };
  for(const [name,corrupt]of Object.entries(cases))await t.test(name,async sub=>{
    const f=await fixture(sub),w=await f.open(),bytes=Buffer.alloc(WORKSPACE_BLOB_LIMITS.chunkBytes+17,0x32);
    let ref=await w.putBlob(bytes,{kind:'phase',observedAt:NOW});const descriptor=await w.readArtifact(ref);
    const first=join(w.directory,'objects',`${descriptor.parts[0]}.json`),part=JSON.parse(await readFile(first,'utf8'));
    const changed=await corrupt({w,descriptor,first,part});if(changed)ref=await w.putArtifact(changed,{kind:'phase',observedAt:NOW});
    f.setNow('2026-10-20T12:30:00.000Z');
    await assert.rejects(w.readBlob(ref));await assert.rejects(w.writeCheckpoint(null,{...cp(),pins:{broken:ref}}));
    if(name==='missing')await assert.rejects(w.putBlob(bytes,{kind:'phase',observedAt:NOW}),/blob_missing/);
  });
});

test('blob inputs are copied before queued writes; zero/exact-chunk bounds and existing small codecs stay strict',async t=>{
  const f=await fixture(t),w=await f.open(),bytes=Buffer.alloc(WORKSPACE_BLOB_LIMITS.chunkBytes,0x41);
  const saved=w.putBlob(bytes,{kind:'phase',observedAt:NOW});bytes.fill(0x42);
  const ref=await saved;assert.deepEqual(await w.readBlob(ref),Buffer.alloc(bytes.length,0x41));
  assert.equal((await w.readArtifact(ref)).parts.length,1);
  const empty=await w.putBlob(Buffer.alloc(0),{kind:'phase',observedAt:NOW});assert.equal((await w.readBlob(empty)).length,0);
  await assert.rejects(w.putBlob(new Uint8Array(WORKSPACE_BLOB_LIMITS.bytes+1),{kind:'phase',observedAt:NOW}),/blob_bytes/);
  await assert.rejects(w.putBlob(Buffer.from('x'),{kind:'phase',observedAt:NOW,expiresAt:LATER}),/kind/);
  const legacy=await w.putArtifact('ordered JSON bytes',{kind:'phase',observedAt:NOW});await assert.rejects(w.readBlob(legacy),/blob_manifest/);
});
