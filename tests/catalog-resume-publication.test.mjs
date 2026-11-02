import test from 'node:test';
import assert from 'node:assert/strict';
import {validateResumeCheckpoint} from '../scripts/catalog/resume-publication.mjs';
test('only the same acknowledged permanent preactivation version may resume without fetching or uploading',()=>{
  const good={checkpoint:{owner:{phase:'freezing'},pins:{publicationUploadAcknowledged:{}},control:{publication:{
    stage:'activating',permit:null,deploymentId:null,versionReference:'same-upload',intent:{nextExpiry:null}}}}};
  assert.equal(validateResumeCheckpoint(good).versionReference,'same-upload');
  for(const mutation of [v=>v.checkpoint.owner.phase='writing',v=>delete v.checkpoint.pins.publicationUploadAcknowledged,
    v=>v.checkpoint.pins.publicationUploadReview={},v=>v.checkpoint.control.publication.permit={},
    v=>v.checkpoint.control.publication.deploymentId='deployed',v=>v.checkpoint.control.publication.versionReference=null,
    v=>v.checkpoint.control.publication.intent.nextExpiry='2026-10-31T00:00:00.000Z',v=>v.checkpoint.control.publication.stage='built']){
    const bad=structuredClone(good);mutation(bad);assert.throws(()=>validateResumeCheckpoint(bad),/acknowledged_permanent_upload_required/);
  }
});
