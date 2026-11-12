import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {dispatchAdmission,readAdmissionDispatch} from '../workers/site/content-admin-dispatch.ts';

const requestId='fixture-admission-request',now=()=> '2026-11-12T06:00:00.000Z';
async function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec('CREATE TABLE content_admin_requests(request_id TEXT PRIMARY KEY,action TEXT); CREATE TABLE content_admin_results(request_id TEXT PRIMARY KEY);');
  sql.exec(await readFile(new URL('../migrations/d1/0021_content_admin_dispatch.sql',import.meta.url),'utf8'));
  sql.prepare('INSERT INTO content_admin_requests VALUES(?,?)').run(requestId,'admit');
  let lostClaim=false,lostSettlement=false;
  const db={prepare(query){let params=[];return{bind(...values){params=values;return this;},
    async all(){return{results:sql.prepare(query).all(...params)};},async run(){
      const result=sql.prepare(query).run(...params);
      if(query.startsWith('INSERT')&&lostClaim){lostClaim=false;throw Error('lost claim ACK');}
      if(query.startsWith('UPDATE')&&lostSettlement){lostSettlement=false;throw Error('lost settlement ACK');}
      return result;}};}};
  return{db,sql,loseClaim(){lostClaim=true;},loseSettlement(){lostSettlement=true;}};
}
test('dispatch is pinned to one repository/workflow/main and stores no token or provider body',async t=>{
  const f=await fixture(t);let calls=0;
  const input={db:f.db,requestId,token:'TEST_ONLY_DISPATCH_TOKEN',now,send:async(url,init)=>{
    calls++;assert.equal(url,'https://api.github.com/repos/37-Inc/stupid.gifts/actions/workflows/catalog-manual.yml/dispatches');
    assert.equal(init.method,'POST');assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,'Bearer TEST_ONLY_DISPATCH_TOKEN');
    assert.equal(init.headers['X-GitHub-Api-Version'],'2026-03-10');
    assert.deepEqual(JSON.parse(init.body),{ref:'main',inputs:{mode:'admin'}});return new Response(null,{status:204});}};
  assert.equal((await dispatchAdmission(input)).state,'accepted');
  assert.equal((await dispatchAdmission(input)).state,'accepted');assert.equal(calls,1);
  assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM content_admin_dispatches').all()).includes('TOKEN'));
});
test('current GitHub response retains the exact run ID and drops response URLs and extra fields',async t=>{
  const f=await fixture(t);
  const result=await dispatchAdmission({db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>Response.json({
    workflow_run_id:123456789,html_url:'https://example.invalid/PRIVATE',run_url:'PRIVATE',extra:'PRIVATE'})});
  assert.equal(result.state,'accepted');assert.equal(result.workflowRunId,123456789);assert.equal(result.providerStatus,200);
  assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM content_admin_dispatches').all()).includes('PRIVATE'));
});
test('malformed 200 acknowledgement is unknown without redispatch',async t=>{
  const f=await fixture(t);let calls=0;
  const input={db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>{calls++;return Response.json({workflow_run_id:'not-a-run'});}};
  assert.equal((await dispatchAdmission(input)).state,'unknown');await dispatchAdmission(input);assert.equal(calls,1);
});
test('racing staff retries dispatch only once',async t=>{
  const f=await fixture(t);let calls=0;
  const input={db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>{calls++;return new Response(null,{status:204});}};
  await Promise.all([dispatchAdmission(input),dispatchAdmission(input)]);assert.equal(calls,1);
  assert.equal((await readAdmissionDispatch(f.db,requestId)).state,'accepted');
});
test('lost claim and settlement acknowledgements reuse exact durable identity',async t=>{
  const f=await fixture(t);f.loseClaim();f.loseSettlement();let calls=0;
  const input={db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>{calls++;return new Response(null,{status:204});}};
  assert.equal((await dispatchAdmission(input)).state,'accepted');
  assert.equal((await dispatchAdmission(input)).state,'accepted');assert.equal(calls,1);
});
for(const status of [401,403,422,429,500,502])test(`provider status ${status} is preserved without retry or publication claims`,async t=>{
  const f=await fixture(t);let calls=0;
  const input={db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>{calls++;return new Response('PRIVATE PROVIDER BODY',{status});}};
  const result=await dispatchAdmission(input);assert.equal(result.state,status<500?'rejected':'unknown');
  assert.equal(result.providerStatus,status);await dispatchAdmission(input);assert.equal(calls,1);
  assert.ok(!JSON.stringify(f.sql.prepare('SELECT * FROM content_admin_dispatches').all()).includes('PRIVATE'));
});
test('a lost POST response is unknown, never a second workflow dispatch',async t=>{
  const f=await fixture(t);let calls=0;
  const input={db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>{calls++;throw Error('unknown POST result');}};
  assert.equal((await dispatchAdmission(input)).state,'unknown');
  await dispatchAdmission(input);assert.equal(calls,1);
});
test('a saved claim from an interrupted request is observable, not permission to redispatch',async t=>{
  const f=await fixture(t);f.sql.prepare("INSERT INTO content_admin_dispatches VALUES(?,?,'claimed',NULL,NULL,?,?)").run(requestId,'original-claim',now(),now());
  const result=await dispatchAdmission({db:f.db,requestId,token:'TEST_ONLY',now,send:async()=>{throw Error('must not dispatch');}});
  assert.equal(result.state,'claimed');
});
test('unknown, non-admission and already-consumed requests cannot start work',async t=>{
  const f=await fixture(t),send=async()=>{assert.fail('must not dispatch');};
  await assert.rejects(dispatchAdmission({db:f.db,requestId:'fixture-missing-request',token:'TEST_ONLY',now,send}),/claim_unconfirmed/);
  f.sql.prepare("UPDATE content_admin_requests SET action='collection'").run();
  await assert.rejects(dispatchAdmission({db:f.db,requestId,token:'TEST_ONLY',now,send}),/claim_unconfirmed/);
  f.sql.prepare("UPDATE content_admin_requests SET action='admit'").run();
  f.sql.prepare('INSERT INTO content_admin_results VALUES(?)').run(requestId);
  await assert.rejects(dispatchAdmission({db:f.db,requestId,token:'TEST_ONLY',now,send}),/claim_unconfirmed/);
});
