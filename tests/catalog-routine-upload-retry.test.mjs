import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {assetUploadRetryEvidence,routineUploadRetry} from '../scripts/catalog/routine-upload-retry.ts';
import {encodeReviewedUploadActivationApproval,reviewedUploadActivationDeadline} from '../lib/catalog/build-requests.ts';
import {readOwnedPermanentCohortNative} from '../scripts/catalog/owned-vector-delivery.ts';

const AT='2026-11-04T18:00:00.000Z',hash='a'.repeat(64);
test('native-only routine proof cannot treat an uncleared finite listing as permanent',async()=>{
  const db={prepare(){throw Error('Unexpected database read');}};
  for(const persistent of [undefined,{}])await assert.rejects(readOwnedPermanentCohortNative(db,{},
    {persistent,snapshot:{products:[{eligibleUntil:'2026-11-05T18:00:00.000Z'}]}},{}),/vector_plan_invalid/);
});
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'stupid-asset-retry-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const artifacts=new Map([['c'.repeat(64),{code:'publication_upload_unknown'}]]);
  const c={stage:'uploading',packageSha256:hash,configSha256:hash,requestId:hash,uploadMarker:'owned-upload',permit:null,versionReference:null,
    intent:{nextExpiry:'2026-11-05T01:00:00.000Z'}};
  const cp={phase:'attention',owner:{phase:'freezing'},control:{publication:c},pins:{publicationUploadReview:{sha256:'c'.repeat(64)},publicationUploadPending:{sha256:'d'.repeat(64)}}};
  const w={directory:root,manifest:{runId:'owned-run',scope:{accountId:'b'.repeat(32),workerName:'owned-worker'},
    retention:{rules:{publication:{notAfter:'2026-11-05T18:00:00.000Z'}}}},async assertHeld(){},
    async readCheckpoint(){return{sha256:hash,checkpoint:structuredClone(cp)};},async readArtifact(ref){return artifacts.get(ref.sha256);},
    async putArtifact(v){const key=createHash('sha256').update(JSON.stringify(v)).digest('hex');artifacts.set(key,structuredClone(v));return{sha256:key,reference:'objects/'+key+'.json'};}};
  async function logs(attempt=1,{version=false,ack=false,foreign=false}={}){
    const dir=path.join(root,'publication-runtime','owned-run',...(attempt>1?[`routine-retry-${attempt-1}`]:[]));
    const log=path.join(dir,'logs','wrangler-2026-11-04_18-00-00_000.log');await fs.mkdir(path.dirname(log),{recursive:true,mode:0o700});
    const endpoint=`/client/v4/accounts/${foreign?'c'.repeat(32):'b'.repeat(32)}/workers`;
    await fs.writeFile(log,`-- START CF API REQUEST: POST http://127.0.0.1:1234/nonce${endpoint}/assets/upload?base64=true\n`+
      (version?`-- START CF API REQUEST: POST http://127.0.0.1:1234/nonce${endpoint}/scripts/owned-worker/versions?bindings_inherit=strict\n`:''),{mode:0o600});
    await fs.writeFile(path.join(dir,'upload.ndjson'),JSON.stringify({type:'wrangler-session',command_line_args:['versions','upload','--tag','owned-upload'],log_file_path:log})+'\n'+
      (ack?JSON.stringify({type:'version-upload'})+'\n':''),{mode:0o600});
  }
  await logs();return{w,cp,c,artifacts,logs};
}

test('same-package asset recovery uses original evidence and a fresh execution window, not renewed product rights',async t=>{
  const f=await fixture(t),before=JSON.stringify(f.c);const r=await routineUploadRetry(f.w,AT);
  assert.equal(r.approval.schemaVersion,5);assert.equal(r.approval.attempt,1);
  assert.doesNotThrow(()=>encodeReviewedUploadActivationApproval(r.approval));
  assert.equal(await reviewedUploadActivationDeadline(r.approval,'2026-11-04T17:00:00.000Z'),r.approval.activationDeadline);
  assert.equal(JSON.stringify(f.c),before);
  assert.ok(r.approval.activationDeadline<f.c.intent.nextExpiry);
  assert.equal(f.artifacts.get(r.evidence.sha256).versionPosts,0);
});

for(const fault of ['version','ack','foreign'])test(`unknown or foreign version dispatch cannot authorize an asset retry: ${fault}`,async t=>{
  const f=await fixture(t);await f.logs(1,{[fault]:true});
  await assert.rejects(routineUploadRetry(f.w,AT),/asset_retry_unproven/);
});

test('another asset-only interruption appends an attempt; completed acknowledgements resume without another upload',async t=>{
  const f=await fixture(t),first=await routineUploadRetry(f.w,AT);
  const record=await f.w.putArtifact({...first,original:{retained:true}});
  f.cp.pins.publicationUploadRoutine1Pending=record;await f.logs(2);
  const second=await routineUploadRetry(f.w,AT);assert.equal(second.approval.attempt,2);
  f.cp.pins.publicationUploadRoutine1Acknowledged={sha256:'ack'};
  assert.deepEqual(await routineUploadRetry(f.w,AT),first);
});

test('explicit unsafe-version detail, expired content and invalid retry bounds stop without supplier/provider calls',async t=>{
  const f=await fixture(t);f.artifacts.set('c'.repeat(64),{code:'publication_upload_unknown',detail:{versionDispatched:true}});
  await assert.rejects(routineUploadRetry(f.w,AT),/asset_retry_unproven/);
  f.artifacts.set('c'.repeat(64),{code:'publication_upload_unknown'});f.c.intent.nextExpiry=AT;
  await assert.rejects(routineUploadRetry(f.w,AT),/asset_retry_expired/);
  await assert.rejects(assetUploadRetryEvidence(f.w,f.c,hash,4),/asset_retry_unproven/);
});
