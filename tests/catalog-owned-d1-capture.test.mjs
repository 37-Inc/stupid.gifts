import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {captureOwnedD1} from '../scripts/catalog/capture-owned-d1.ts';
import {D1_RECOVERY_TABLES} from '../scripts/catalog/d1-logical-tables.ts';
import {claimMutationOwnership,releaseMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {appendSearchDiagnostic} from '../lib/catalog/storage/d1.ts';
import {reserveSemanticSearch} from '../workers/site/semantic-budget.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';
import {applyOwnedOperationalImport,prepareOwnedOperationalImport,readOwnedLogicalRows} from '../scripts/catalog/owned-operational-import.ts';

const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('Network forbidden in capture tests');};test.after(()=>{globalThis.fetch=originalFetch;});
const AT='2026-10-22T12:00:00.000Z',scope={environment:'production',indexName:'capture-fixture'};
const writers=[{id:'catalog-job',kind:'application',codePaths:['scripts/catalog/run-cloudflare-weekly.ts'],reference:'fixture stopped job inventory',stoppedAt:AT},
  {id:'operator',kind:'operator',codePaths:[],reference:'fixture operator session paused',stoppedAt:AT}];
const event=id=>({id,queryHash:'a'.repeat(64),queryLength:5,resultCount:1,topSimilarity:null,matchType:'keyword',outcome:'ok'});
const budget={environment:'production',index:'capture-fixture'};
const env={ENVIRONMENT:'production',SEMANTIC_SEARCH_ENABLED:'true',SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'100',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'100000'};
async function fixture(t,{products=2,longRows=false}={}){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  // This historical24-table recovery contract ends before0017 telemetry.
  for(const name of(await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)&&n<'0017').sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  sql.function('strftime',(format,instant)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return AT;});
  let before;const metrics={http:0,sql:0,maxRows:0,scanPages:0};
  const db={prepare(query){let params=[];return{bind(...v){params=v;assert.ok(v.length<=100);return this;},
    async all(){await before?.(query);metrics.http++;metrics.sql++;const results=sql.prepare(query).all(...params).map(r=>({...r}));
      if(query.startsWith('WITH bounded')){metrics.scanPages++;assert.ok(results.length<=40);metrics.maxRows=Math.max(metrics.maxRows,results.length);}
      return{results};},async run(){await before?.(query);metrics.http++;metrics.sql++;const result=sql.prepare(query).run(...params);return{success:true,meta:{changes:result.changes}};},
    execute(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};}};},
    async batch(statements){await before?.('BATCH');metrics.http++;metrics.sql+=statements.length;assert.ok(statements.length<=50);
      sql.exec('BEGIN');try{const results=statements.map(s=>s.execute());sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  const insert=sql.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,quality_score,is_active,editorial_status,catalog_revision,rights_json,source_record_json,updated_at)
    VALUES(?,?,?,'amazon','','USD',.8,1,'pending','fixture','{}',?,?)`);
  sql.exec('BEGIN');for(let i=1;i<=products;i++)insert.run(`fixture-${i}`,`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,`fixture-${i}`,
    JSON.stringify({id:`fixture-${i}`,private:longRows?'"\\🦆'.repeat(1000):'unchanged original'}),AT);sql.exec('COMMIT');
  const native=encodePgvectorSendBase64([-0,...Array(1535).fill(Math.fround(.1))]);
  sql.prepare('INSERT INTO catalog_maintenance_products VALUES(?,1,?,1,?,?)').run('fixture-1','{"fixture":true}',native,'{"fixture":"original provenance"}');
  sql.prepare('INSERT INTO catalog_runs VALUES(?,?,?,?,?,?,?)').run('run','completed','daily',0,AT,AT,'{"fixture":"history"}');
  sql.prepare(`INSERT INTO catalog_run_items(sequence,id,run_id,product_id,external_id,decision,requires_manual_review,created_at,source_record_json)
    VALUES(41,'item','run','fixture-1','fixture-1','held',0,?,'{"sequence":"41"}')`).run(AT);
  await appendSearchDiagnostic(db,event('diagnostic'),new Date(AT));assert.equal(await reserveSemanticSearch(db,budget,env,20),true);
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const claim=()=>claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'fixture-capture',operationKey:'a'.repeat(64)});
  const owner=await claim(),options={db,owner,reference:'synthetic local consistent-capture fixture',stoppedWriters:writers};
  const state=()=>Object.fromEntries(D1_RECOVERY_TABLES.map(table=>[table,sql.prepare(`SELECT * FROM ${table}`).all().map(r=>({...r}))]));
  return{sql,db,owner,options,state,metrics,native,claim,setBefore(fn){before=fn;}};
}

test('source captures reuse unchanged rows, invalidate writes and never expose mutable cached objects',async t=>{
  const f=await fixture(t,{products:83});
  f.sql.exec(await readFile(new URL('../migrations/d1/0020_catalog_source_version.sql',import.meta.url),'utf8'));
  await releaseMutationOwnership(f.db,f.owner);
  const owner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'cache-test',operationKey:'c'.repeat(64)});
  const read=()=>readOwnedLogicalRows(f.db,owner,{phase:'freezing',tables:['products','catalog_maintenance_products','catalog_maintenance_operations']});
  const before=f.metrics.http,first=await read(),pages=f.metrics.scanPages,cold=f.metrics.http-before;
  assert.ok(pages>0);first.products[0].title='caller mutation';
  const warmStart=f.metrics.http,second=await read();assert.equal(f.metrics.scanPages,pages);assert.equal(second.products[0].title,'');
  t.diagnostic(JSON.stringify({scope:'local 83-product capture fixture',coldRequests:cold,warmRequests:f.metrics.http-warmStart,repeatedDataPages:0}));
  f.sql.exec("UPDATE products SET title='real change' WHERE id='fixture-1'");
  assert.equal((await read()).products[0].title,'real change');assert.ok(f.metrics.scanPages>pages);
  const refreshed=f.metrics.scanPages;
  f.sql.exec("UPDATE catalog_maintenance_products SET embedding_provenance_json='{}' WHERE product_id='fixture-1'");
  await read();assert.ok(f.metrics.scanPages>refreshed);
  // Even a cache hit observes the real owner, not an old in-memory authority.
  await releaseMutationOwnership(f.db,owner);await assert.rejects(read(),/malformed JSON/);
});

test('missing source-version migration never caches, and changes during capture refuse the result',async t=>{
  const f=await fixture(t);await releaseMutationOwnership(f.db,f.owner);
  const owner=await claimMutationOwnership(f.db,scope,{phase:'freezing',ownerReference:'cache-test',operationKey:'c'.repeat(64)});
  const read=()=>readOwnedLogicalRows(f.db,owner,{phase:'freezing',tables:['products','catalog_maintenance_products','catalog_maintenance_operations']});
  await read();const pages=f.metrics.scanPages;await read();assert.ok(f.metrics.scanPages>pages);
  f.sql.exec(await readFile(new URL('../migrations/d1/0020_catalog_source_version.sql',import.meta.url),'utf8'));
  let once=false;f.setBefore(query=>{if(!once&&query.startsWith('WITH bounded')){once=true;f.sql.exec("UPDATE products SET title='racing write' WHERE id='fixture-1'");}});
  await assert.rejects(read(),/owned_import_source_changed/);f.setBefore(null);
  assert.equal((await read()).products[0].title,'racing write');
});

test('capture binds all24 complete tables, allocator/native bytes, actual schema and cooperative writer inventory',async t=>{
  const f=await fixture(t),before=f.state();const result=await captureOwnedD1(f.options);
  assert.deepEqual(result.capture.tables,before);assert.deepEqual(f.state(),before);
  assert.equal(result.capture.inventory.length,24);assert.equal(result.capture.provenance.kind,'unverified-capture');assert.equal(result.capture.provenance.barrierEvidence,null);
  assert.equal(result.captureSha256,sha256(canonicalJson(result.capture)));assert.equal(result.receiptSha256,sha256(canonicalJson(result.receipt)));
  assert.deepEqual(result.receipt.inventory,result.capture.inventory);assert.deepEqual(result.receipt.ownerBefore,result.receipt.ownerAfter);
  assert.equal(result.capture.tables.catalog_maintenance_products[0].embedding_native_base64,f.native);
  assert.equal(result.capture.tables.sqlite_sequence.find(r=>r.name==='catalog_run_items').seq,41);
  assert.equal(result.receipt.schemas.filter(s=>s.type==='trigger'&&s.name.includes('_capture_')).length,6);
  assert.match(result.receipt.limitations.join(' '),/not provider-enforced|out-of-band/);
  assert.deepEqual(result.receipt.stoppedWriters,writers);assert.equal(result.receipt.startedAt,AT);
  // A genuine read receipt does not silently widen the existing importer gate.
  const packet={batches:[],preservedRows:[],summary:{sourceManifestSha256:'b'.repeat(64),importedAt:AT,batchCount:0,importedRows:0,sourceIdentityCount:0}};
  const plan=prepareOwnedOperationalImport({packet,capture:result.capture,captureSha256:result.captureSha256,owner:f.owner});
  await assert.rejects(applyOwnedOperationalImport({db:f.db,plan:plan.plan,planSha256:plan.sha256,ownerCursor:{current:f.owner}}),/capture_unverified/);
});

test('historical24-table capture does not silently adopt later search-demand schema',async t=>{
  const f=await fixture(t);f.sql.exec(await readFile(new URL('../migrations/d1/0017_search_demand.sql',import.meta.url),'utf8'));
  await assert.rejects(captureOwnedD1(f.options),/^Error: catalog_capture_schema$/);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='search_demand' AND type='table'").get().n,1);
});

test('additive build recovery column preserves original rowids/constraints and stays inside exact24-table capture',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of(await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)&&n<'0016').sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  sql.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES('audit-source',?,'fixture','reconciled')").run(AT);
  sql.prepare(`INSERT INTO catalog_build_requests(request_id,environment,source_revision,request_json,state,attempts)
    VALUES('audit-build','production','audit-source','{}','failed',3)`).run();
  const before=sql.prepare('SELECT rowid,* FROM catalog_build_requests').all(),indexes=sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name='catalog_build_requests' ORDER BY name").all();
  sql.exec(await readFile(new URL('../migrations/d1/0016_build_operator_recovery.sql',import.meta.url),'utf8'));
  const after=sql.prepare('SELECT rowid,* FROM catalog_build_requests').all();assert.equal(after[0].operator_recovery_json,null);
  assert.deepEqual(after.map(({operator_recovery_json,...row})=>{void operator_recovery_json;return row;}),before.map(row=>({...row})));
  assert.deepEqual(sql.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name='catalog_build_requests' ORDER BY name").all(),indexes);
  assert.deepEqual(sql.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.throws(()=>sql.exec('UPDATE catalog_build_requests SET attempts=4'),/CHECK/);
  assert.throws(()=>sql.exec("UPDATE catalog_build_requests SET request_json='{\"altered\":true}'"),/immutable/);
  assert.throws(()=>sql.exec("UPDATE catalog_build_requests SET operator_recovery_json='not JSON'"),/CHECK/);
  sql.exec(`UPDATE catalog_build_requests SET operator_recovery_json='{"fixture":"opaque technical receipt"}'`);
  for(const update of ['NULL',`'{"replacement":true}'`])assert.throws(()=>sql.exec(`UPDATE catalog_build_requests SET operator_recovery_json=${update}`),/immutable/);
  assert.throws(()=>sql.exec('DELETE FROM catalog_build_requests'),/immutable/);
  const f=await fixture(t);
  f.sql.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES('audit-source',?,'fixture','reconciled')").run(AT);
  f.sql.prepare(`INSERT INTO catalog_build_requests(request_id,environment,source_revision,request_json,state,attempts,operator_recovery_json)
    VALUES('audit-build','production','audit-source','{}','failed',3,?)`).run('{"fixture":"opaque technical receipt"}');
  const capture=await captureOwnedD1(f.options);
  assert.equal(capture.capture.inventory.length,24);assert.deepEqual(capture.capture.tables.catalog_build_requests,
    f.sql.prepare('SELECT * FROM catalog_build_requests').all().map(row=>({...row})));
  assert.equal(capture.receipt.schemas.filter(row=>row.name.startsWith('catalog_build_operator_recovery_')).length,2);
  const packet={batches:[],preservedRows:[],summary:{sourceManifestSha256:'b'.repeat(64),importedAt:AT,batchCount:0,importedRows:0,sourceIdentityCount:0}};
  const planned=prepareOwnedOperationalImport({packet,capture:capture.capture,captureSha256:capture.captureSha256,owner:f.owner});
  assert.equal(planned.plan.baseline.catalog_build_requests[0].operator_recovery_json,'{"fixture":"opaque technical receipt"}');
});
async function cooperativePlan(f){
  const captured=await captureOwnedD1(f.options),row={...captured.capture.tables.products[0],id:'new-held-product',
    public_id:'00000000-0000-4000-8000-000000009999',slug:'new-held-product',source_record_json:'{"id":"new-held-product"}'};
  const source='b'.repeat(64),packet={batches:[{table:'products',rows:[row],exportSha256:source}],preservedRows:[],
    summary:{sourceManifestSha256:source,importedAt:AT,batchCount:1,importedRows:1,sourceIdentityCount:1}};
  const prepared=prepareOwnedOperationalImport({packet,capture:captured.capture,captureSha256:captured.captureSha256,owner:f.owner});
  return{plan:prepared.plan,planSha256:prepared.sha256,proof:{receipt:captured.receipt,sha256:captured.receiptSha256}};
}
test('optional cooperative receipt permits exact held union/lostACK resume, never changes default capture refusal',async t=>{
  const f=await fixture(t),transport=await restAdapter(f),db=transport.db,{plan,planSha256,proof}=await cooperativePlan({...f,options:{...f.options,db}}),cursor={current:f.owner};
  await assert.rejects(applyOwnedOperationalImport({db,plan,planSha256,ownerCursor:cursor}),/capture_unverified/);
  const before=f.state();transport.loseAck();
  const apply=()=>applyOwnedOperationalImport({db,plan,planSha256,ownerCursor:cursor,cooperativeCapture:proof});
  const result=await apply();assert.equal(result.state,'reconciled');assert.equal(result.barrierVerified,false);
  assert.equal(result.cooperativeReceiptSha256,proof.sha256);assert.equal(f.sql.prepare('SELECT count(*) n FROM migration_imports').get().n,1);
  assert.equal(f.sql.prepare("SELECT public_display_json FROM products WHERE id='new-held-product'").get().public_display_json,null);
  assert.deepEqual(f.state().catalog_maintenance_products,before.catalog_maintenance_products);
  cursor.current=f.owner;assert.equal((await apply()).state,'reconciled');assert.equal(cursor.current.epoch,f.owner.epoch+1);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM migration_imports').get().n,1);
  assert.deepEqual(f.state().sqlite_sequence,before.sqlite_sequence);
  assert.equal(db.metrics().unconfirmedRequests,1);assert.equal(transport.sends(),transport.reservations.size);assert.equal(transport.settled.size,transport.reservations.size);
});
test('receipt validation independently rejects rehashed false owner/inventory/schema/control evidence before imports',async t=>{
  const f=await fixture(t),{db}=await restAdapter(f),{plan,planSha256,proof}=await cooperativePlan({...f,options:{...f.options,db}}),before=f.state();
  for(const mutate of [r=>{r.captureSha256='f'.repeat(64);},r=>{r.inventory[0].sha256='f'.repeat(64);},
    r=>{r.ownerAfter.generation++;},r=>{r.schemaSha256='f'.repeat(64);},r=>{r.schemas[0].sha256='f'.repeat(64);},
    r=>{r.scopeRowSha256='f'.repeat(64);},r=>{r.stoppedWriters[0].reference='';},r=>{r.outsideApplicationTables=['_cf_*'];}]){
    const forged=structuredClone(proof);mutate(forged.receipt);forged.sha256=sha256(canonicalJson(forged.receipt));
    await assert.rejects(applyOwnedOperationalImport({db,plan,planSha256,ownerCursor:{current:f.owner},cooperativeCapture:forged}));
    assert.deepEqual(f.state(),before);
  }
  f.sql.exec('DROP TRIGGER search_diagnostics_capture_insert');
  await assert.rejects(applyOwnedOperationalImport({db,plan,planSha256,ownerCursor:{current:f.owner},cooperativeCapture:proof}),/catalog_capture_barrier_schema/);
  assert.deepEqual(f.state(),before);
});
test('matching logical clone or copied client identity cannot reuse another registered resource receipt',async t=>{
  const f=await fixture(t),{db}=await restAdapter(f),{plan,planSha256,proof}=await cooperativePlan({...f,options:{...f.options,db}}),before=f.state();
  assert.equal(typeof proof.receipt.providerIdentity,'string');
  const clone=await restAdapter(f,{databaseId:'00000000-0000-4000-8000-000000000902'});
  for(const candidate of [f.db,clone.db,{...db,providerIdentity:db.providerIdentity}]){
    await assert.rejects(applyOwnedOperationalImport({db:candidate,plan,planSha256,ownerCursor:{current:f.owner},cooperativeCapture:proof}),/catalog_capture_receipt/);
    assert.deepEqual(f.state(),before);
  }
  assert.equal((await captureOwnedD1(f.options)).receipt.providerIdentity,null);
});
test('real-shaped exact provider/control tables are outside application scope, not allocator metadata',async t=>{
  const f=await fixture(t);
  f.sql.exec("CREATE TABLE _cf_KV(key TEXT PRIMARY KEY,value BLOB); INSERT INTO _cf_KV VALUES('fixture',X'00FF')");
  f.sql.exec("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL); INSERT INTO d1_migrations(id,name) VALUES(7,'0014_runtime_capture_barrier.sql')");
  const before=f.state(),result=await captureOwnedD1(f.options);
  assert.deepEqual(result.capture.tables,before);assert.equal(result.capture.inventory.length,24);
  assert.equal(result.capture.tables.sqlite_sequence.find(r=>r.name==='d1_migrations').seq,7);
  assert.deepEqual(result.receipt.outsideApplicationTables,['_cf_KV','d1_migrations']);
  assert.ok(!result.receipt.schemas.some(s=>['_cf_KV','d1_migrations'].includes(s.table)));
  for(const name of ['_cf_forged','d1_other']){
    f.sql.exec(`CREATE TABLE ${name}(value TEXT)`);await assert.rejects(captureOwnedD1(f.options),/catalog_capture_schema/);f.sql.exec(`DROP TABLE ${name}`);
  }
});

test('six triggers fence old prepared INSERT/UPDATE/DELETE and conflict-upsert while idle behavior is unchanged',async t=>{
  const f=await fixture(t);await releaseMutationOwnership(f.db,f.owner);
  const old=[f.sql.prepare("INSERT INTO search_diagnostics SELECT 'late',query_hash,query_length,result_count,top_similarity,match_type,outcome,created_at,expires_at FROM search_diagnostics LIMIT 1"),
    f.sql.prepare("UPDATE search_diagnostics SET outcome='empty'"),f.sql.prepare('DELETE FROM search_diagnostics'),
    f.sql.prepare("INSERT INTO semantic_search_budgets SELECT environment,'new-index',utc_day,requests_reserved,tokens_reserved,request_cap,token_cap FROM semantic_search_budgets LIMIT 1"),
    f.sql.prepare('UPDATE semantic_search_budgets SET requests_reserved=requests_reserved+1'),f.sql.prepare('DELETE FROM semantic_search_budgets'),
    f.sql.prepare("INSERT INTO semantic_search_budgets SELECT * FROM semantic_search_budgets WHERE true ON CONFLICT(environment,index_scope,utc_day) DO UPDATE SET requests_reserved=requests_reserved+1")];
  const owner=await f.claim();
  f.sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run('blocked-build-source',AT,'c'.repeat(64),'reconciled');
  f.sql.exec("INSERT INTO catalog_build_requests(request_id,environment,source_revision,request_json) VALUES('blocked-build','production','blocked-build-source','{}')");
  for(const phase of ['writing','freezing','activating']){
    f.sql.prepare('UPDATE catalog_mutation_scopes SET phase=?,external_pending=?,activation_request_id=?').run(phase,phase==='activating'?1:0,phase==='activating'?'blocked-build':null);const before=f.state();
    for(const q of old)assert.throws(()=>q.run(),/catalog_runtime_owned/);assert.deepEqual(f.state(),before);}
  f.sql.exec("UPDATE catalog_mutation_scopes SET phase='writing',external_pending=0,activation_request_id=NULL");await releaseMutationOwnership(f.db,owner);
  assert.equal(await reserveSemanticSearch(f.db,budget,env,20),true);await appendSearchDiagnostic(f.db,event('idle'),new Date(AT));
  old[1].run();old[4].run();assert.equal(f.sql.prepare('SELECT count(*) n FROM search_diagnostics').get().n,2);
});
test('0014 is additive/data-preserving and an interrupted trigger installation rolls back atomically',async t=>{
  const f=await fixture(t),before=f.state();
  for(const row of f.sql.prepare("SELECT name FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_capture_%'").all())f.sql.exec(`DROP TRIGGER ${row.name}`);
  const migration=await readFile(new URL('../migrations/d1/0014_runtime_capture_barrier.sql',import.meta.url),'utf8');
  f.sql.exec('BEGIN');assert.throws(()=>f.sql.exec(migration.replace('CREATE TRIGGER search_diagnostics_capture_update','SELECT missing FROM missing_table; CREATE TRIGGER search_diagnostics_capture_update')));
  f.sql.exec('ROLLBACK');assert.equal(f.sql.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_capture_%'").get().n,0);
  assert.deepEqual(f.state(),before);f.sql.exec('BEGIN');f.sql.exec(migration);f.sql.exec('COMMIT');
  assert.equal(f.sql.prepare("SELECT count(*) n FROM sqlite_schema WHERE type='trigger' AND name LIKE '%_capture_%'").get().n,6);
  assert.deepEqual(f.state(),before);assert.deepEqual(f.sql.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('old runtime batch and old reservation begun before claim cannot commit after the barrier',async t=>{
  const f=await fixture(t);await releaseMutationOwnership(f.db,f.owner);
  let resolve,entered;const pause=new Promise(r=>{resolve=r;}),started=new Promise(r=>{entered=r;});
  f.setBefore(async query=>{if(query.startsWith('INSERT INTO semantic_search_budgets')){entered();await pause;}});
  const pending=reserveSemanticSearch(f.db,budget,env,20);await started;await f.claim();const before=f.state();resolve();
  assert.equal(await pending,false);assert.deepEqual(f.state(),before);f.setBefore(undefined);
  // Current code may refuse in its strict SQL assertion before a DB trigger;
  // the direct old prepared SQL above still requires the named trigger error.
  await assert.rejects(appendSearchDiagnostic(f.db,event('late'),new Date(AT)),/catalog_runtime_owned|malformed JSON/);assert.deepEqual(f.state(),before);
  assert.throws(()=>f.sql.exec("BEGIN; UPDATE products SET title='must roll back'; DELETE FROM search_diagnostics;"),/catalog_runtime_owned/);
  f.sql.exec('ROLLBACK');assert.deepEqual(f.state(),before);
});

test('capture refuses missing/modified/extra barriers, unknown tables, absent writer evidence and changed exact owner',async t=>{
  for(const alter of ["DROP TRIGGER search_diagnostics_capture_update",
    "DROP TRIGGER semantic_search_budgets_capture_delete; CREATE TRIGGER semantic_search_budgets_capture_delete BEFORE DELETE ON semantic_search_budgets BEGIN SELECT 1; END",
    "CREATE TRIGGER extra_runtime BEFORE INSERT ON search_diagnostics BEGIN SELECT 1; END",'CREATE TABLE sqliteXhidden(value TEXT)']){
    const f=await fixture(t);f.sql.exec(alter);await assert.rejects(captureOwnedD1(f.options),/catalog_capture_(?:barrier_schema|schema)/);
  }
  for(const stoppedWriters of [[],writers.slice(0,1),[{...writers[0],reference:''},writers[1]],[{...writers[0],stoppedAt:'2099-01-01T00:00:00.000Z'},writers[1]]]){
    const f=await fixture(t);await assert.rejects(captureOwnedD1({...f.options,stoppedWriters}),/writer_inventory/);
  }
  for(const field of ['owner_token','generation','mutation_epoch','captured_at','external_pending']){
    const f=await fixture(t);let altered=false;f.setBefore(query=>{if(!altered&&query.startsWith('WITH bounded AS (SELECT rowid _cursor,id,')){
      altered=true;f.sql.prepare(`UPDATE catalog_mutation_scopes SET ${field}=?`).run(field==='captured_at'?'2026-10-22T12:00:01.000Z':field==='owner_token'?'foreign':field==='generation'?2:1);}});
    await assert.rejects(captureOwnedD1(f.options));assert.equal(altered,true);
  }
  const f=await fixture(t);let readProducts=false;
  f.setBefore(query=>{if(query.includes('FROM products\n'))readProducts=true;
    if(readProducts&&query.includes('FROM sqlite_schema')){readProducts=false;f.sql.exec('DROP TRIGGER search_diagnostics_capture_update');}});
  await assert.rejects(captureOwnedD1(f.options),/catalog_capture_schema_changed/);
});

async function restAdapter(f,{databaseId='00000000-0000-4000-8000-000000000901'}={}){
  const accountId='a'.repeat(32);let sends=0,maxResponse=0,lose=false;const reservations=new Set(),settled=new Set();
  const db=await createCatalogD1Rest({accountId,databaseId,databaseName:'capture-fixture',token:'FIXTURE_ONLY',
    accounting:{scope:{accountId,databaseId,databaseName:'capture-fixture'},initial:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},
      async reserve(r){reservations.add(r.id);},async settle(id){assert.equal(settled.has(id),false);settled.add(id);}},
    fetch:async(url,init)=>{sends++;assert.equal(init.redirect,'error');let response;
      assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}${init.method==='POST'?'/query':''}`);
      if(init.method==='GET')response={success:true,result:{uuid:databaseId,name:'capture-fixture',read_replication:{mode:'disabled'}}};
      else{const body=JSON.parse(init.body);assert.ok(Buffer.byteLength(init.body)<=512*1024);assert.ok(body.batch.length<=50);
        f.sql.exec('BEGIN');let results;
        try{results=body.batch.map(q=>{assert.ok(q.params.length<=100);const before=f.sql.prepare('SELECT total_changes() n').get().n;
          const results=f.sql.prepare(q.sql).all(...q.params).map(r=>({...r}));if(q.sql.startsWith('WITH bounded'))assert.ok(results.length<=40);
          return{success:true,results,meta:{served_by_primary:true,rows_read:results.length,rows_written:f.sql.prepare('SELECT total_changes() n').get().n-before}};});f.sql.exec('COMMIT');}
        catch{f.sql.exec('ROLLBACK');return Response.json({success:false},{status:400});}
        if(lose&&body.batch.some(q=>q.sql.startsWith('INSERT INTO migration_imports'))){lose=false;throw new Error('fixture post-commit ACK loss');}
        response={success:true,result:results};}
      const bytes=JSON.stringify(response);maxResponse=Math.max(maxResponse,Buffer.byteLength(bytes));assert.ok(maxResponse<=512*1024);return new Response(bytes);}});
  return{db,reservations,settled,sends:()=>sends,maxResponse:()=>maxResponse,loseAck(){lose=true;}};
}
test('actual REST-shaped full3383 capture is paged/byte-bounded and accounts every injected request',async t=>{
  const f=await fixture(t,{products:3383,longRows:true}),transport=await restAdapter(f),{db,reservations,settled}=transport;
  const result=await captureOwnedD1({...f.options,db});assert.equal(result.capture.tables.products.length,3383);
  assert.deepEqual(result.capture.tables.products,f.state().products);assert.equal(transport.sends(),reservations.size);assert.equal(settled.size,reservations.size);
  assert.equal(db.metrics().requests,transport.sends());assert.equal(db.metrics().unconfirmedRequests,0);
  console.log(JSON.stringify({fixture:'local-REST-capture-not-provider',metrics:db.metrics(),maxResponse:transport.maxResponse()}));
});
