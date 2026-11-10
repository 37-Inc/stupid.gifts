import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {loadSavedAdmission,savedAdmissionEvidence,savedAdmissionRun} from '../scripts/catalog/saved-admission.mjs';
import {hostedRunKey,hostedRunRecord} from '../scripts/catalog/hosted-run-record.mjs';
import {operatorInvocation,routineHostedPreparation} from '../scripts/catalog/daily-operator.mjs';
import {CATALOG_SCOPE} from '../scripts/catalog/automation-runtime.mjs';
import {canonicalJson} from '../lib/catalog/canonical-json.ts';
import {editorialSourceHash} from '../scripts/ops/catalog-editorial-core.mjs';
import {createCatalogProviderEvidence} from '../scripts/catalog/provider-evidence.ts';

const SHA='a'.repeat(40),HASH='b'.repeat(64),ASIN='B0FMXQJW2V',FROM='admit-2026-11-10-b9dd9a62e621',DAY='2026-11-10';
const hash=b=>createHash('sha256').update(b).digest('hex'),bytes=v=>Buffer.from(JSON.stringify(v)+'\n');
function fixture(){
  const base='/home/runner/.codex/private/goose-gifts-migration',care=base+'/daily-catalog-care';
  const config={codeSha:SHA,runId:'original-admission',cadence:{admitAsins:[ASIN]},publication:{sourceRoot:'/home/runner/stupid-gifts/operators/'+SHA},
    environment:CATALOG_SCOPE.environment,accountId:CATALOG_SCOPE.accountId,database:{id:CATALOG_SCOPE.databaseId},vectorIndex:{name:CATALOG_SCOPE.indexName},
    retention:{rules:{}},limits:{requests:6000,statements:12000}};
  const record={schemaVersion:1,runKey:FROM,source:SHA,day:DAY,kind:'admit',admitAsins:[ASIN],inputsRef:{schemaVersion:1,key:'inputs/'+HASH+'.json',sha256:HASH}};
  // This fixture's run key must be a genuinely normal admission key.
  record.runKey=hostedRunKey('admit',DAY,SHA,undefined,[ASIN]);
  const dir=care+'/runs/'+record.runKey,files=new Map([
    [dir+'/hosted-run.json',bytes(record)],[dir+'/operator.json',bytes({source:SHA,runId:config.runId,configPath:dir+'/config.json',configSha256:hash(bytes(config))})],
    [dir+'/config.json',bytes(config)],[dir+'/success.json',bytes({source:SHA,result:{state:'finalized'}})],
  ]);
  const snapshot={title:'Solar peeing dog statue',imageUrl:'https://example.invalid/dog.jpg',sourceFacts:{shape:'dog',illumination:'solar light'}},
    receipt={schemaVersion:1,kind:'amazon-observation',operation:'getItems',observedAt:'2026-11-10T09:26:00.000Z',requestedIds:[ASIN],returnedIds:[ASIN],
      products:[{id:ASIN,availabilityStatus:'IN_STOCK',snapshot,sourceFactsHash:editorialSourceHash(snapshot)}]};
  const digest=hash(canonicalJson(receipt)),observation={ref:{reference:'objects/'+digest+'.json',sha256:digest},receipt,expiresAt:'2026-11-11T09:21:00.000Z',manifestSha256:HASH};
  return{runtime:{care,workspace:base+'/weekly-runs',state:{bytes:async p=>{assert(files.has(p));return files.get(p);}}},files,record,config,observation};
}
test('saved exact admission pins its source into the existing shared intent and actual CLI handoff',()=>{
  const runKey=hostedRunKey('admit',DAY,SHA,undefined,[ASIN],FROM),record=hostedRunRecord({schemaVersion:1,runKey,source:SHA,day:DAY,kind:'admit',
    admitAsins:[ASIN],admitSavedRun:FROM,inputsRef:{schemaVersion:1,key:'inputs/'+HASH+'.json',sha256:HASH}});
  assert.notEqual(runKey,hostedRunKey('admit',DAY,SHA,undefined,[ASIN]));
  const args=operatorInvocation(['prepare','--admit-asins',ASIN,'--admit-saved-run',FROM,'--run',runKey],{day:DAY});
  routineHostedPreparation(record,args);
  assert.throws(()=>routineHostedPreparation(record,{...args,admitSavedRun:undefined}),/hosted_pending/);
  assert.throws(()=>operatorInvocation(['prepare','--admit-saved-run',FROM,'--run',runKey],{day:DAY}),/routine_command/);
  for(const value of ['../escape','scheduled-2026-11-10',FROM+'/config.json'])assert.throws(()=>savedAdmissionRun(value));
});
test('accepted saved evidence is read through its original immutable source/config and retention',async()=>{
  const f=fixture();let reads=0;
  const result=await loadSavedAdmission(f.runtime,f.record.runKey,[ASIN],{readObservation:async(o,ids)=>{
    reads++;assert.equal(o.repository,f.config.publication.sourceRoot);assert.equal(o.runId,f.config.runId);assert.deepEqual(ids,[ASIN]);return f.observation;
  }});
  assert.equal(reads,1);assert.equal(result.pin.expiresAt,f.observation.expiresAt);assert.equal(result.pin.receiptSha256,f.observation.ref.sha256);
  await assert.rejects(loadSavedAdmission(f.runtime,f.record.runKey,['B000000001'],{readObservation:async()=>{throw Error('must not read');}}),/saved_admission_invalid/);
  f.files.set(f.runtime.care+'/runs/'+f.record.runKey+'/success.json',bytes({source:SHA,result:{state:'pending'}}));
  await assert.rejects(loadSavedAdmission(f.runtime,f.record.runKey,[ASIN],{readObservation:async()=>{throw Error('must not read');}}),/saved_admission_invalid/);
});
test('saved supplier adapter never calls its network callback and keeps facts/clock for new copy review',async()=>{
  const f=fixture(),receipts=new Map([[f.observation.ref.reference,f.observation.receipt]]),
    evidence=createCatalogProviderEvidence({associateTag:'goose-gifts-37-20',now:()=> '2026-11-10T17:00:00.000Z',
      saveReceipt:async()=>{throw Error('must not create a new observation');},readReceipt:async ref=>receipts.get(ref.reference),
      saveReviewedShort:async()=>({reference:'fixture/copy-review'})});
  await evidence.restoreReceipt(f.observation.ref);
  const adapter=savedAdmissionEvidence(evidence,f.observation,[ASIN],'goose-gifts-37-20');
  const products=await adapter.amazon('getItems',()=>{throw Error('must not fetch');},p=>p,[ASIN]);
  assert.equal(products[0].price,undefined);assert.equal(editorialSourceHash(products[0]),f.observation.receipt.products[0].sourceFactsHash);
  assert.equal(products[0].currency,'USD');
  const p={...products[0],punnyTitle:'Solar peeing dog statue',wittyDescription:'A little dog statue with a solar-lit pretend stream. Put the dog outdoors and give the garden a very questionable new decoration.',editorialSourceHash:editorialSourceHash(products[0]),editorialStatus:'short_ready',editorialQualityScore:.9};
  assert.equal(await evidence.reviewedShort(p,{approved:true,qualityScore:.9}),true);
  const rights=evidence.intent('upsertProduct',[p,editorialSourceHash(p)]).rightsById[ASIN];
  assert.equal(rights.imageUrl.observedAt,f.observation.receipt.observedAt);
  await assert.rejects(adapter.amazon('getItems',()=>{},p=>p,['B000000001']),/saved_admission_invalid/);
  await assert.rejects(adapter.amazon('searchItems',()=>{}),/saved_admission_invalid/);
});
