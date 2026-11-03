import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createCatalogD1Rest, createCatalogD1ReadOnlyRest, CATALOG_D1_REST_LIMITS } from '../scripts/catalog/d1-write-rest.ts';
import { claimMutationOwnership, readMutationOwner, releaseMutationOwnership } from '../lib/catalog/mutation-fence.ts';
import { createD1CatalogTelemetryStore } from '../scripts/catalog/telemetry-d1.ts';
import {MAINTENANCE_SLUG_TRIGGER} from '../scripts/catalog/maintenance-state.ts';

const config={accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000001',databaseName:'test-only-write-db',token:'TEST_ONLY_TOKEN'};
const base=`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
const identity={uuid:config.databaseId,name:config.databaseName,read_replication:{mode:'disabled'}};
const ok=result=>new Response(JSON.stringify({success:true,result}));
const result=(results=[],meta={})=>({success:true,results,meta:{served_by_primary:true,rows_read:results.length,rows_written:0,changes:0,...meta}});
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Live network is forbidden in this test');};
test.after(()=>{globalThis.fetch=originalFetch;});
test('diagnostic SQL is checked before reservation, including WITH and table metadata reads',async()=>{
  const events=[],calls=[];
  const fetch=async(url,init)=>{calls.push(url);if(url===base)return ok(identity);
    const body=JSON.parse(init.body);return ok(body.batch.map(()=>result([{catalog_d1_primary:1}])));};
  const initial={httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0};
  const db=await createCatalogD1ReadOnlyRest({...config,fetch,accounting:{scope:{accountId:config.accountId,databaseId:config.databaseId,databaseName:config.databaseName},initial,
    async reserve(value){events.push(['reserve',value.units.sqlStatements]);},async settle(id,value){events.push(['settle',value.status]);}}});
  await db.prepare('WITH x AS (SELECT 1 n) SELECT * FROM x').all();
  await db.prepare('PRAGMA table_info(products)').all();
  const beforeEvents=events.length,beforeCalls=calls.length,beforeMetrics=db.metrics();
  await assert.rejects(db.prepare('DELETE FROM products').run(),/catalog_d1_diagnostic_read_only/);
  await assert.rejects(db.prepare('PRAGMA writable_schema=ON').run(),/catalog_d1_diagnostic_read_only/);
  await assert.rejects(db.batch([db.prepare('SELECT 1'),db.prepare('WITH x AS (SELECT 1) DELETE FROM products')]),/catalog_d1_diagnostic_read_only/);
  assert.equal(events.length,beforeEvents);assert.equal(calls.length,beforeCalls);assert.deepEqual(db.metrics(),beforeMetrics);
});
async function fixture(t,limits,accounting) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('CREATE TABLE items(id TEXT PRIMARY KEY,value TEXT)');
  const calls=[];let change;
  const fetch=async(url,init)=>{
    calls.push({url,init});assert.equal(init.headers.Authorization,`Bearer ${config.token}`);assert.equal(init.redirect,'error');
    if(url===base){assert.equal(init.method,'GET');assert.equal(init.body,undefined);return ok(identity);}
    assert.equal(url,`${base}/query`);assert.equal(init.method,'POST');assert.equal(init.headers['Content-Type'],'application/json');
    const body=JSON.parse(init.body);assert.deepEqual(Object.keys(body),['batch']);
    const changed=change?.(body,init);if(changed)return changed;
    const rows=[];sql.exec('BEGIN');
    try{
      for(const query of body.batch){
        assert.deepEqual(Object.keys(query),['sql','params']);assert.ok(query.params.length<=100);
        const before=sql.prepare('SELECT total_changes() n').get().n;
        const results=sql.prepare(query.sql).all(...query.params).map(row=>({...row}));
        const count=sql.prepare('SELECT total_changes() n').get().n-before;
        rows.push(result(results,{changes:count,rows_written:count}));
      }sql.exec('COMMIT');return ok(rows);
    }catch{sql.exec('ROLLBACK');return new Response(JSON.stringify({success:false,errors:[{message:'PRIVATE SQL/value/token'}]}),{status:400});}
  };
  const db=await createCatalogD1Rest({...config,fetch,limits,accounting:accounting&&{...accounting,
    scope:{accountId:config.accountId,databaseId:config.databaseId,databaseName:config.databaseName},
    initial:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0}}});
  return{db,sql,calls,fetch,change(fn){change=fn;}};
}
test('explicit identity/disabled replication and primary probe precede standard immutable all/run/batch operations',async t=>{
  const f=await fixture(t);assert.equal(f.calls.length,2);
  assert.equal(f.db.providerIdentity,`cloudflare:${config.accountId}:${config.databaseId}`);
  assert.deepEqual(JSON.parse(f.calls[1].init.body),{batch:[{sql:'SELECT 1 AS catalog_d1_primary',params:[]}]});
  const template=f.db.prepare('INSERT INTO items VALUES(?,?)');
  const values=['a','owned fixture'];const first=template.bind(...values);values[1]='changed after bind';
  const second=template.bind('b','second');assert.notEqual(first,template);assert.notEqual(first,second);
  const batch=[first,second];const pending=f.db.batch(batch);batch[0]=template.bind('wrong','mutation after dispatch');
  const results=await pending;assert.equal(results.length,2);assert.equal(results[0].success,true);assert.equal(results[0].meta.changes,1);
  assert.deepEqual((await f.db.prepare('SELECT * FROM items ORDER BY id').all()).results,[{id:'a',value:'owned fixture'},{id:'b',value:'second'}]);
  assert.equal((await f.db.prepare('UPDATE items SET value=? WHERE id=?').bind('updated','b').run()).meta.changes,1);
  assert.equal((await template.bind('c','third').run()).success,true);
  assert.equal(f.db.metrics().reportedRowsWritten,4);assert.equal(f.db.metrics().unconfirmedRequests,0);
  assert.ok(Object.isFrozen(f.db));assert.ok(Object.isFrozen(first));
  assert.doesNotMatch(JSON.stringify(f.db.metrics()),/TEST_ONLY_TOKEN|owned fixture|SELECT|INSERT/);
});
test('wrong/missing database identity, replication and primary evidence refuse before use',async()=>{
  for(const changed of [{...identity,uuid:'wrong'},{...identity,name:'other'}, {...identity,read_replication:{mode:'auto'}},
    {...identity,read_replication:undefined}]){
    let count=0;await assert.rejects(createCatalogD1Rest({...config,fetch:async()=>{count++;return ok(changed);}}),/^Error: catalog_d1_identity_mismatch$/);
    assert.equal(count,1);
  }
  for(const meta of [{served_by_primary:false},{served_by_primary:undefined},{rows_read:undefined}]){
    let count=0;await assert.rejects(createCatalogD1Rest({...config,fetch:async()=>++count===1?ok(identity):ok([result([{catalog_d1_primary:1}],meta)])}),/result_unknown/);
    assert.equal(count,2);
  }
  await assert.rejects(createCatalogD1Rest({...config,fetch:async(url)=>url===base?ok(identity):ok([result([{catalog_d1_primary:0}])])}),/primary_unproven/);
});
test('only the exact single slug-guard restore permits an internal SQL delimiter',async t=>{
  const f=await fixture(t);
  f.sql.exec('CREATE TABLE products(id TEXT PRIMARY KEY,slug TEXT)');
  f.sql.exec(MAINTENANCE_SLUG_TRIGGER);
  f.sql.prepare("INSERT INTO products VALUES('test','old')").run();
  await f.db.batch([f.db.prepare('DROP TRIGGER products_maintenance_slug_immutable'),
    f.db.prepare("UPDATE products SET slug='corrected' WHERE id='test'"),f.db.prepare(MAINTENANCE_SLUG_TRIGGER)]);
  assert.equal(f.sql.prepare('SELECT slug FROM products').get().slug,'corrected');
  assert.throws(()=>f.sql.prepare("UPDATE products SET slug='unapproved'").run(),/preserves existing slugs/);
  for(const value of [MAINTENANCE_SLUG_TRIGGER+'; DROP TABLE products',MAINTENANCE_SLUG_TRIGGER.replace('preserves existing slugs','changed'),
    "SELECT 1; DELETE FROM products"])
    assert.throws(()=>f.db.prepare(value),/catalog_d1_statement_invalid/);
  await assert.rejects(f.db.batch([f.db.prepare('DROP TRIGGER products_maintenance_slug_immutable'),f.db.prepare("SELECT json('invalid')"),
    f.db.prepare(MAINTENANCE_SLUG_TRIGGER)]),/catalog_d1_result_unknown/);
  assert.throws(()=>f.sql.prepare("UPDATE products SET slug='still-unapproved'").run(),/preserves existing slugs/);
});
test('invalid configuration has no ambient credential/env fallback or provider calls; defaults are finite',async()=>{
  for(const changed of [{accountId:'../evil'},{databaseId:'bad'},{databaseName:'../other'},{databaseName:undefined},{token:undefined},
    {token:'bad\r\nheader'},{limits:{timeoutMs:0}},{limits:{requests:10001}},{limits:{statements:25001}},
    {limits:{unknown:1}},{limits:{statements:NaN}},{limits:{reportedRowsRead:3_000_001}},{limits:{reportedRowsWritten:50_001}}]){
    let count=0;await assert.rejects(createCatalogD1Rest({...config,...changed,fetch:async()=>{count++;throw new Error('must not call');}}),/configuration_invalid/);assert.equal(count,0);
  }
  assert.deepEqual(CATALOG_D1_REST_LIMITS,{requests:600,statements:1200,batchStatements:50,parameters:100,
    requestBytes:524288,responseBytes:524288,timeoutMs:10000,reportedRowsRead:1000000,reportedRowsWritten:10000});
  for(const [key,value] of Object.entries(CATALOG_D1_REST_LIMITS).filter(([key])=>!['requests','statements','reportedRowsRead','reportedRowsWritten'].includes(key))){
    let count=0;await assert.rejects(createCatalogD1Rest({...config,limits:{[key]:value+1},fetch:async()=>{count++;throw new Error('must not call');}}),/configuration_invalid/);
    assert.equal(count,0);
  }
});
test('only explicit finite workload ceilings can exceed defaults; counters span one client without reset',async t=>{
  const maximum=await fixture(t,{requests:10000,statements:25000,reportedRowsRead:3_000_000,reportedRowsWritten:50_000});assert.equal(maximum.db.metrics().requests,2);
  const requests=await fixture(t,{requests:601});
  for(let i=0;i<599;i++)await requests.db.prepare('SELECT 1').all();
  assert.equal(requests.db.metrics().requests,601);const before=requests.calls.length;
  await assert.rejects(requests.db.prepare('SELECT 1').all(),/budget_exhausted/);assert.equal(requests.calls.length,before);
  const statements=await fixture(t,{statements:1201});
  for(let i=0;i<24;i++)await statements.db.batch(Array(50).fill(statements.db.prepare('SELECT 1')));
  assert.equal(statements.db.metrics().statements,1201);const sent=statements.calls.length;
  await assert.rejects(statements.db.prepare('SELECT 1').all(),/budget_exhausted/);assert.equal(statements.calls.length,sent);
  const limits={requests:3};const fixed=await fixture(t,limits);limits.requests=10000;
  await fixed.db.prepare('SELECT 1').all();await assert.rejects(fixed.db.prepare('SELECT 1').all(),/budget_exhausted/);
  assert.equal(fixed.db.metrics().requests,3);
});
test('batch failure stays rejected/uncertain with no partial result or automatic retry; mock SQLite rolls back',async t=>{
  const f=await fixture(t);const start=f.calls.length;
  await assert.rejects(f.db.batch([f.db.prepare("INSERT INTO items VALUES('a','must rollback')"),
    f.db.prepare("SELECT json('invalid_json')")]),/^Error: catalog_d1_result_unknown$/);
  assert.equal(f.calls.length,start+1);assert.equal(f.sql.prepare('SELECT count(*) n FROM items').get().n,0);
  assert.equal(f.db.metrics().reportedRowsWritten,null);assert.equal(f.db.metrics().unconfirmedRequests,1);
  // This proves error handling against this mock, NOT Cloudflare REST atomicity.
});
test('lost committed response remains unknown and caller can read its journal without transport replay',async t=>{
  const f=await fixture(t);let once=true;
  f.change(body=>{if(once&&body.batch[0].sql.startsWith('INSERT')){once=false;f.sql.prepare(body.batch[0].sql).run(...body.batch[0].params);throw new Error('PRIVATE transport failure');}});
  const start=f.calls.length;await assert.rejects(f.db.prepare('INSERT INTO items VALUES(?,?)').bind('journal','committed').run(),/^Error: catalog_d1_result_unknown$/);
  assert.equal(f.calls.length,start+1);assert.equal(f.sql.prepare('SELECT count(*) n FROM items').get().n,1);
  assert.deepEqual((await f.db.prepare('SELECT * FROM items WHERE id=?').bind('journal').all()).results,[{id:'journal',value:'committed'}]);
  assert.equal(f.calls.length,start+2);assert.equal(f.db.metrics().reportedRowsRead,null);
});
test('existing ownership and telemetry journals use unchanged CatalogD1 shapes; adapter invents no lock',async t=>{
  const f=await fixture(t);
  for(const file of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name=>/^\d{4}.*\.sql$/.test(name)).sort())
    f.sql.exec(await readFile(new URL(`../migrations/d1/${file}`,import.meta.url),'utf8'));
  const scope={environment:'staging',indexName:'test-only-owned-index'};
  f.sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const owner=await claimMutationOwnership(f.db,scope,{phase:'writing',ownerReference:'test/transport',operationKey:'b'.repeat(64)});
  assert.ok(owner);const cursor={current:owner};
  const telemetry=createD1CatalogTelemetryStore({db:f.db,owner,ownerCursor:cursor,runId:'transport-run',catalogRevision:'transport-revision'});
  await telemetry.startCatalogRun({id:'transport-run'});const after=cursor.current;
  assert.equal(after.epoch,owner.epoch+1);
  await telemetry.startCatalogRun({id:'transport-run'});assert.deepEqual(cursor.current,after);
  await telemetry.finishCatalogRun('transport-run',{status:'completed'});
  assert.equal((await telemetry.loadCatalogRun('transport-run')).run.status,'completed');
  await releaseMutationOwnership(f.db,cursor.current);assert.equal(await readMutationOwner(f.db,scope),null);
});
test('invalid/foreign statements, multi-statement SQL, parameters and request bounds fail before HTTP',async t=>{
  const f=await fixture(t,{requestBytes:400});const other=await fixture(t);const start=f.calls.length;
  for(const value of ['',null,'-- comment only','SELECT 1; SELECT 2','SELECT 1;;',"SELECT 'unclosed",'SELECT 1 /*unclosed', 'x'.repeat(65537)])
    assert.throws(()=>f.db.prepare(value),/statement_invalid/);
  assert.deepEqual((await f.db.prepare("SELECT ';' AS value /* ; */; -- final ;").all()).results,[{value:';'}]);
  for(const params of [[undefined],[{}],[true],[NaN],[Infinity],[1n],[Number.MAX_SAFE_INTEGER+1],Array(101).fill(null)])
    assert.throws(()=>f.db.prepare('SELECT ?').bind(...params),/parameters_invalid/);
  for(const batch of [[],Array(1),Array(51).fill(f.db.prepare('SELECT 1')),[other.db.prepare('SELECT 1')],[{all(){throw new Error('forged');}}]])
    await assert.rejects(f.db.batch(batch),/batch_invalid/);
  await assert.rejects(f.db.prepare('SELECT ?').bind('x'.repeat(400)).all(),/request_bound/);
  assert.equal(f.calls.length,start+1);
});
test('primary drift or malformed/missing success/results/usage metadata is unknown, sanitized and never retried',async t=>{
  const f=await fixture(t);
  const variants=[()=>new Response('PRIVATE malformed'),()=>ok([]),()=>ok([result(),result()]),()=>ok([{success:false,results:[]}]),
    ()=>ok([result([null])]),()=>ok([result([],{served_by_primary:false})]),()=>ok([result([],{rows_written:undefined})]),
    ()=>ok([result([],{rows_read:-1})]),()=>ok([result([],{changes:'PRIVATE'})]),()=>new Response('PRIVATE denied',{status:403})];
  for(const response of variants){const start=f.calls.length;f.change(()=>response());
    await assert.rejects(f.db.prepare('SELECT 1').all(),/^Error: catalog_d1_result_unknown$/);assert.equal(f.calls.length,start+1);}
  assert.equal(f.db.metrics().unconfirmedRequests,variants.length);assert.doesNotMatch(JSON.stringify(f.db.metrics()),/PRIVATE/);
});
test('request/statement and reported usage budgets stop later calls; cost caps are post-execution, never prepaid guarantees',async t=>{
  for(const limits of [{requests:2},{statements:1}]){
    const f=await fixture(t,limits);const start=f.calls.length;
    await assert.rejects(f.db.prepare('SELECT 1').all(),/budget_exhausted/);assert.equal(f.calls.length,start);
  }
  const f=await fixture(t,{reportedRowsWritten:1});f.change(()=>ok([result([],{rows_written:2})]));
  await assert.rejects(f.db.prepare('UPDATE items SET value=?').bind('x').run(),/reported_usage_exceeded/);
  assert.equal(f.db.metrics().reportedRowsWritten,2);const start=f.calls.length;
  await assert.rejects(f.db.prepare('SELECT 1').all(),/budget_exhausted/);assert.equal(f.calls.length,start);
});
test('timeout covers fetch and body, oversize body cancels; all outcomes remain unknown without retry',async t=>{
  for(const body of [false,true]){
    const f=await fixture(t,{timeoutMs:10});let aborted=false,cancelled=false;
    f.change((_batch,init)=>{init.signal.addEventListener('abort',()=>{aborted=true;});
      return body?new Response(new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;}})):new Promise(()=>{});});
    const start=f.calls.length;await assert.rejects(f.db.prepare('SELECT 1').all(),/result_unknown/);
    assert.equal(f.calls.length,start+1);assert.equal(aborted,true);if(body)assert.equal(cancelled,true);
  }
  const f=await fixture(t);let cancelled=false;
  f.change(()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array(256*1024));},cancel(){cancelled=true;}})));
  await assert.rejects(f.db.prepare('SELECT 1').all(),/result_unknown/);assert.equal(cancelled,true);
  cancelled=false;f.change(()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:403}));
  await assert.rejects(f.db.prepare('SELECT 1').all(),/result_unknown/);assert.equal(cancelled,true);
});
test('observation abort drains transport and unknown accounting; no later dispatch or cancellable mutation',async t=>{
  const events=[];let holdReserve=false,releaseReserve;
  const f=await fixture(t,undefined,{async reserve(){events.push('reserve');if(holdReserve)await new Promise(resolve=>{releaseReserve=resolve;});},
    async settle(_id,value){await new Promise(resolve=>setTimeout(resolve,15));events.push(value.status);}});
  events.length=0;const aborter=new AbortController();let cleaned=false;
  f.change((_batch,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>setTimeout(()=>{cleaned=true;reject(new Error('aborted'));},25),{once:true})));
  const pending=f.db.prepare('SELECT 1').all({signal:aborter.signal});
  await new Promise(resolve=>setTimeout(resolve,5));aborter.abort();await assert.rejects(pending,/result_unknown/);
  assert.equal(cleaned,true);assert.deepEqual(events,['reserve','unknown']);assert.equal(f.db.metrics().unconfirmedRequests,1);
  const count=f.calls.length;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(f.calls.length,count);assert.deepEqual(events,['reserve','unknown']);
  await assert.rejects(f.db.prepare('SELECT 1').all({signal:aborter.signal}),/abort/i);assert.equal(f.calls.length,count);
  for(const statements of [[f.db.prepare("INSERT INTO items VALUES('bad','bad')")],[f.db.prepare('SELECT 1'),f.db.prepare('DELETE FROM items')]])
    await assert.rejects(f.db.batch(statements,{signal:new AbortController().signal}),/read_signal_invalid/);
  assert.equal(f.calls.length,count);assert.equal(f.sql.prepare('SELECT count(*) n FROM items').get().n,0);
  // Abort during async reservation cannot dispatch afterward or refund its reservation.
  holdReserve=true;const second=new AbortController();const reserved=f.db.prepare('SELECT 1').all({signal:second.signal});
  while(!releaseReserve)await new Promise(resolve=>setTimeout(resolve,1));second.abort();releaseReserve();
  await assert.rejects(reserved,/result_unknown/);assert.equal(f.calls.length,count);assert.deepEqual(events,['reserve','unknown','reserve','unknown']);
});
