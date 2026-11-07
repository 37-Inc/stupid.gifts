import assert from 'node:assert/strict';
import test from 'node:test';
import {automationRuntime,CATALOG_SCOPE} from '../scripts/catalog/automation-runtime.mjs';
test('local runtime uses only reviewed local credential references',()=>{
  const r=automationRuntime({});assert.equal(r.hosted,false);assert.equal(r.durable,undefined);
  assert.deepEqual(r.credentials.cloudflare,{type:'wrangler_oauth'});
  assert.equal(r.credentials.openai.service,'goose.gifts.OPENAI_API_KEY');
});
test('hosted mode refuses PR/foreign refs and missing explicit storage credentials',()=>{
  assert.throws(()=>automationRuntime({STUPID_GIFTS_OPERATOR_MODE:'hosted'}),/hosted_source/);
  const common={STUPID_GIFTS_OPERATOR_MODE:'hosted',GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'37-Inc/stupid.gifts',GITHUB_REF:'refs/heads/main'};
  assert.throws(()=>automationRuntime(common),/storage_credentials/);
  const r=automationRuntime({...common,STUPID_GIFTS_R2_ACCESS_KEY_ID:'owned-test-key',STUPID_GIFTS_R2_SECRET_ACCESS_KEY:'owned-test-secret'});
  assert.deepEqual(r.credentials.cloudflare,{type:'environment',name:'STUPID_GIFTS_CLOUDFLARE_API_TOKEN'});
  assert.equal(CATALOG_SCOPE.workerName,'stupid-gifts-production');assert.ok(r.durable);
});
