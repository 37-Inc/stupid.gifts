import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {captureOwnedD1} from '../scripts/catalog/capture-owned-d1.ts';
import {D1_RECOVERY_TABLES} from '../scripts/catalog/d1-logical-tables.ts';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';
import {prepareOwnedOperationalImport,applyOwnedOperationalImport} from '../scripts/catalog/owned-operational-import.ts';
import {permanentBaselineCurrent,preparePermanentDisplayPlan,applyPermanentDisplayPlan,expectedPermanentDisplayRows} from '../scripts/catalog/permanent-display-d1.ts';
import {assemblePermanentBaseline} from '../scripts/catalog/permanent-baseline.ts';
import {mapAuthoredCopyEvidence} from '../scripts/catalog/authored-copy-evidence.ts';
import {canonicalJson,sha256,convertSourceRow} from '../scripts/catalog/migration.ts';
import {claimMutationOwnership,releaseMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {maintenanceState} from '../scripts/catalog/maintenance-state.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {appendSearchDiagnostic} from '../lib/catalog/storage/d1.ts';
import {reserveSemanticSearch} from '../workers/site/semantic-budget.ts';

const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>{throw new Error('No external network in permanent display tests');};
test.after(()=>{globalThis.fetch=originalFetch;});
const AT='2026-10-22T12:00:00.000Z',LATER='2026-10-22T12:10:00.000Z',END='2026-10-23T12:00:00.000Z';
const scope={environment:'production',indexName:'permanent-fixture'},manifest='a'.repeat(64);
const svg='<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10"/></svg>';
const asset='/images/gift-placeholder.svg';
const fields=['public_display_json','rights_json','title','description','tags'];
const same=(a,b)=>assert.equal(canonicalJson(a),canonicalJson(b));
const inventory=tables=>D1_RECOVERY_TABLES.map(table=>({table,rows:tables[table].length,sha256:sha256(canonicalJson(tables[table]))}));
const sourceRow=(i,long=false)=>({id:`B0${String(i).padStart(8,'0')}`,public_id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,
  slug:`catalog-gift-${i}`,source:'amazon',title:`Original supplier ${i}`,price:'12.34',currency:'USD',image_url:`https://supplier.invalid/${i}.jpg`,
  affiliate_url:`https://www.amazon.com/dp/B0${String(i).padStart(8,'0')}?tag=fixture-20`,source_query:'original query',
  humor_tags:'{}',punny_title:null,witty_description:null,quality_score:'0.80',rating:null,review_count:null,is_active:true,
  editorial_writeup:null,source_facts:null,source_facts_hash:null,editorial_source_hash:null,availability_status:'IN_STOCK',
  editorial_status:'pending',editorial_quality_score:null,editorial_model:null,editorial_prompt_version:null,editorial_generated_at:null,
  editorial_block_reason:null,duplicate_of_product_id:null,content_updated_at:null,availability_checked_at:null,last_verified_at:null,
  created_at:AT,updated_at:AT,embedding:null,...(long?{private_escaped:'"\\🦆'.repeat(2500)}:{})});
const grant=value=>({basis:'owned',value,reference:'ROOT synthetic fixture exact-value approval, not real product rights'});
const writers=at=>[{id:'daily',kind:'application',codePaths:['scripts/catalog/run-cloudflare-weekly.ts'],reference:'Fixture stopped known job',stoppedAt:at},
  {id:'operator',kind:'operator',codePaths:[],reference:'Fixture sole operator',stoppedAt:at}];

async function fixture(t,{count=43,initialCount=2,long=false,fresh=false,runtimeHistory=false,controlMigration=false}={}){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  // Historical display restoration binds the exact24-table capture, not0017 telemetry.
  for(const name of(await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)&&n<'0017').sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  if(controlMigration){sql.exec('CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)');
    for(let i=1;i<=14;i++)sql.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run(`historical-${i}.sql`);}
  let at=AT,beforeSend,beforeStatement,lose=false,sends=0,maxRequest=0,maxResponse=0,writeBatches=0;const reservations=new Set(),settlements=new Set();
  sql.function('strftime',(format,value)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(value,'now');return at;});
  sql.function('date',{varargs:true},(...args)=>new Date(Date.parse(at)+(args[1]==='-30 days'?-30*86400000:0)).toISOString().slice(0,10));
  const source=Array.from({length:count},(_,i)=>sourceRow(i,long)),converted=source.map(r=>convertSourceRow('products',r,{catalogRevision:'archive-fixture',archiveId:manifest,timestamps:{}}));
  const columns=Object.keys(converted[0]),insert=sql.prepare(`INSERT INTO products(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`);
  for(const row of converted.slice(0,initialCount))insert.run(...columns.map(c=>row[c]));
  const native=encodePgvectorSendBase64([-0,...Array(1535).fill(Math.fround(.1))]);
  if(initialCount){const row=sql.prepare('SELECT * FROM products WHERE id=?').get(source[0].id),semantic=maintenanceState(row);
    sql.prepare('INSERT INTO catalog_maintenance_products VALUES(?,1,?,1,?,?)').run(row.id,canonicalJson(semantic),native,'{"input":"original-unverified-native"}');}
  // Installation removes the public supplier body but preserves its private grants/typed deadline.
  for(const row of converted.slice(0,Math.min(2,initialCount))){const original=source.find(s=>s.id===row.id),display={id:row.id,publicId:row.public_id,slug:row.slug,
    source:'amazon',currency:'USD',title:original.title,description:'Original supplier description',imageUrl:original.image_url,
    affiliateUrl:original.affiliate_url,price:0,isActive:true,qualityScore:.8,eligibleUntil:END};
    const rights=Object.fromEntries(['title','description','imageUrl','affiliateUrl'].map(field=>[field,{basis:'merchant',value:display[field],reference:'Original supplier receipt',observedAt:AT,expiresAt:END}]));
    sql.prepare('UPDATE products SET title=?,description=?,public_display_json=?,rights_json=?,eligible_until=? WHERE id=?')
      .run(display.title,display.description,canonicalJson(display),canonicalJson(rights),END,row.id);}
  if(runtimeHistory){
    const diagnostic=sql.prepare("INSERT INTO search_diagnostics VALUES(?, ?, 4, 0, NULL, 'keyword','empty',?,?)");
    diagnostic.run('expired-runtime','b'.repeat(64),'2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z');
    diagnostic.run('retained-runtime','c'.repeat(64),'2026-10-21T00:00:00.000Z','2026-11-20T00:00:00.000Z');
    const budget=sql.prepare('INSERT INTO semantic_search_budgets VALUES(?,?,?,1,22,100,100000)');
    budget.run('production',scope.indexName,'2026-09-01');budget.run('production',scope.indexName,'2026-10-22');
  }
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const accountId='a'.repeat(32),databaseId='00000000-0000-4000-8000-000000000901',databaseName='permanent-fixture';
  const makeDb=async(id=databaseId)=>createCatalogD1Rest({accountId,databaseId:id,databaseName,token:'FIXTURE_ONLY',
    // TEST ONLY: repeated negative/replay fixtures share one injected client. Production defaults unchanged.
    limits:{requests:10000,statements:25000},accounting:{scope:{accountId,databaseId:id,databaseName},initial:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},
      async reserve(r){reservations.add(r.id);},async settle(id){assert.ok(!settlements.has(id));settlements.add(id);}},
    fetch:async(url,init)=>{sends++;assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${id}${init.method==='POST'?'/query':''}`);
      assert.equal(init.redirect,'error');let response;
      if(init.method==='GET')response={success:true,result:{uuid:id,name:databaseName,read_replication:{mode:'disabled'}}};
      else{const body=JSON.parse(init.body);maxRequest=Math.max(maxRequest,Buffer.byteLength(init.body));assert.ok(maxRequest<=512*1024);assert.ok(body.batch.length<=50);
        await beforeSend?.(body.batch);sql.exec('BEGIN');let results;
        try{results=[];for(const q of body.batch){assert.ok(q.params.length<=100);await beforeStatement?.(q);
          const before=sql.prepare('SELECT total_changes() n').get().n,data=sql.prepare(q.sql).all(...q.params).map(r=>({...r}));
          if(q.sql.startsWith('WITH bounded'))assert.ok(data.length<=40);
          results.push({success:true,results:data,meta:{served_by_primary:true,changes:sql.prepare('SELECT changes() n').get().n,
            rows_read:data.length,rows_written:sql.prepare('SELECT total_changes() n').get().n-before}});}
          sql.exec('COMMIT');}catch{sql.exec('ROLLBACK');return Response.json({success:false},{status:400});}
        if(body.batch.some(q=>q.sql.startsWith('WITH changes'))){writeBatches++;if(lose){lose=false;throw new Error('Post-commit ACK lost');}}
        response={success:true,result:results};}
      const bytes=JSON.stringify(response);maxResponse=Math.max(maxResponse,Buffer.byteLength(bytes));assert.ok(maxResponse<=512*1024);return new Response(bytes);}});
  const db=await makeDb(),claim=key=>claimMutationOwnership(db,scope,{phase:'writing',ownerReference:`fixture/${key}`,operationKey:sha256(key)});
  let owner=await claim('union');const initial=await captureOwnedD1({db,owner,reference:'Fixture initial union capture',stoppedWriters:writers(at)});
  const incoming=converted.slice(initialCount),batches=[];for(let i=0;i<incoming.length;i+=40)batches.push({table:'products',rows:incoming.slice(i,i+40),exportSha256:manifest});
  const packet={batches,preservedRows:initial.capture.tables.products,summary:{sourceManifestSha256:manifest,importedAt:at,batchCount:batches.length,importedRows:incoming.length,sourceIdentityCount:count}};
  const union=prepareOwnedOperationalImport({packet,capture:initial.capture,captureSha256:initial.captureSha256,owner}),cursor={current:owner};
  await applyOwnedOperationalImport({db,plan:union.plan,planSha256:union.sha256,ownerCursor:cursor,cooperativeCapture:{receipt:initial.receipt,sha256:initial.receiptSha256}});owner=cursor.current;
  if(fresh){await releaseMutationOwnership(db,owner);at=LATER;
    await appendSearchDiagnostic(db,{id:'new-runtime',queryHash:'b'.repeat(64),queryLength:7,resultCount:0,topSimilarity:null,matchType:'keyword',outcome:'empty'},new Date(at));
    assert.equal(await reserveSemanticSearch(db,{environment:'production',index:scope.indexName},{ENVIRONMENT:'production',SEMANTIC_SEARCH_ENABLED:'true',SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'100',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'100000'},22),true);
    owner=await claim('installer');}
  if(controlMigration)sql.prepare('INSERT INTO d1_migrations(name) VALUES(?)').run('0015_persistent_projection_facts.sql');
  const captured=await captureOwnedD1({db,owner,reference:'Fixture post-union installer capture',stoppedWriters:writers(at)});
  const raw=source.map(r=>JSON.stringify(r)).join('\n')+'\n',events='';
  const tables=[{raw,rows:source,definition:{schema:'public',name:'products',sha256:sha256(raw),rowCount:source.length,columns:Object.keys(source[0]).map(name=>({name}))}},
    {raw:events,rows:[],definition:{schema:'public',name:'catalog_editorial_events',sha256:sha256(events),rowCount:0,columns:[]}}];
  const evidence=mapAuthoredCopyEvidence({tables,summary:{manifestSha256:manifest,tables:tables.map(t=>({schema:'public',name:t.definition.name,sourceSha256:t.definition.sha256,rowCount:t.rows.length}))}},
    {expectedManifestSha256:manifest,archiveReference:'private:synthetic-source',canonicalAffiliateTag:'fixture-20',seeds:[]});
  const assembler={expectedEvidenceSha256:sha256(canonicalJson(evidence)),approvedRightsById:Object.fromEntries(evidence.products.map(p=>[p.id,
    {title:grant(p.fields.title.value),description:grant(p.fields.title.value),imageUrl:grant(asset),affiliateUrl:grant(p.fields.retailerUrl.value)}])),
    placeholder:{path:asset,bytes:Buffer.from(svg),expectedSha256:sha256(svg)},now:new Date(at)};
  const proposal=assemblePermanentBaseline(evidence,permanentBaselineCurrent(captured.capture),assembler);
  const input={capture:captured.capture,captureSha256:captured.captureSha256,owner,union:{plan:union.plan,sha256:union.sha256},evidence,assembler,
    ...(controlMigration?{controlMigration:{name:'0015_persistent_projection_facts.sql',
      sourceSha256:'ba52088cf45175f5a4107793a848d084ac6d48935aaa1b2efd4e7950a14a0df0',receiptSha256:'e'.repeat(64)}}:{}),
    approvedProposal:{value:proposal,sha256:sha256(canonicalJson(proposal)),reference:'ROOT reviewed exact synthetic plan; not product rights inference'}};
  const prepared=preparePermanentDisplayPlan(input),state=()=>Object.fromEntries(D1_RECOVERY_TABLES.map(table=>[table,sql.prepare(`SELECT * FROM ${table}`).all().map(r=>({...r}))]));
  const apply=(opts={})=>applyPermanentDisplayPlan({db,plan:prepared.plan,planSha256:prepared.sha256,ownerCursor:{current:owner},cooperativeCapture:{receipt:captured.receipt,sha256:captured.receiptSha256},...opts});
  return{sql,db,source,owner,native,union,captured,input,prepared,apply,state,makeDb,metrics:()=>({sends,maxRequest,maxResponse,writeBatches,...db.metrics()}),
    hooks({send,statement}={}){beforeSend=send;beforeStatement=statement;},loseAck(){lose=true;},reservations,settlements};
}

test('follow-up owner-authorized restoration binds a fresh capture and latest publication, without replaying import',async t=>{
  const f=await fixture(t,{count:4,initialCount:2});
  const publication={release_id:'existing-release',catalog_revision:'existing-revision',code_sha:'a'.repeat(40),completed_at:AT,manifest_json:'{}'};
  f.sql.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,'reconciled')")
    .run(publication.catalog_revision,AT,'c'.repeat(64));
  f.sql.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(...Object.values(publication));
  const captured=await captureOwnedD1({db:f.db,owner:f.owner,reference:'Fresh restoration fixture capture',stoppedWriters:writers(AT)});
  const assembler=structuredClone(f.input.assembler),current=permanentBaselineCurrent(captured.capture);
  assembler.existingDisplayReference='owner-confirmed-existing-dataset:fixture';
  for(const p of current){
    const rights=assembler.approvedRightsById[p.id];
    for(const[field,value]of Object.entries({title:p.title,description:p.description||p.wittyDescription||p.title,imageUrl:p.imageUrl,
      punnyTitle:p.punnyTitle,wittyDescription:p.wittyDescription,editorialWriteup:p.editorialWriteup,
      ...(p.humorTags?.length?{humorTags:JSON.stringify(p.humorTags)}:{})}))
      if(typeof value==='string'&&value.trim())rights[field]={basis:'licensed',value,reference:assembler.existingDisplayReference};
  }
  const proposal=assemblePermanentBaseline(f.input.evidence,current,assembler);
  const base={...f.input};delete base.union;
  const input={...base,capture:captured.capture,captureSha256:captured.captureSha256,assembler,
    priorPublication:{releaseId:publication.release_id,receiptSha256:sha256(canonicalJson(publication))},
    approvedProposal:{value:proposal,sha256:sha256(canonicalJson(proposal)),reference:assembler.existingDisplayReference}};
  const prepared=preparePermanentDisplayPlan(input),before=f.state();
  assert.throws(()=>preparePermanentDisplayPlan({...input,priorPublication:{...input.priorPublication,receiptSha256:'f'.repeat(64)}}),/prior_publication/);
  assert.throws(()=>preparePermanentDisplayPlan({...input,union:f.input.union}),/prior_publication/);
  const result=await applyPermanentDisplayPlan({db:f.db,plan:prepared.plan,planSha256:prepared.sha256,ownerCursor:{current:f.owner},
    cooperativeCapture:{receipt:captured.receipt,sha256:captured.receiptSha256}});
  assert.equal(result.state,'reconciled');assert.equal(result.changedProducts,4);
  for(const row of f.state().products){const original=before.products.find(p=>p.id===row.id),display=JSON.parse(row.public_display_json);
    assert.equal(display.imageUrl,JSON.parse(original.source_record_json).image_url);
    assert.equal(display.eligibleUntil,null);assert.equal(row.source_record_json,original.source_record_json);
    const{persistent,...rootRights}=JSON.parse(row.rights_json);
    same(rootRights,JSON.parse(original.rights_json));assert.equal(persistent.imageUrl.basis,'licensed');}
  same(f.state().catalog_maintenance_products,before.catalog_maintenance_products);
  same(f.state().publication_receipts,before.publication_receipts);
});

test('real SQLite/REST display-only batches preserve all24/native/rowids/merchant rights and clocks; replay does not write',async t=>{
  const f=await fixture(t),before=f.state(),rowids=f.sql.prepare('SELECT id,rowid FROM products ORDER BY id').all(),cursor={current:f.owner},start=f.metrics();
  const result=await f.apply({ownerCursor:cursor});assert.equal(result.state,'reconciled');assert.equal(result.changedProducts,43);assert.equal(result.vectorWorkEmitted,0);assert.equal(result.publicationEmitted,false);
  const applied=f.metrics();
  const after=f.state();for(const table of D1_RECOVERY_TABLES)if(!['products','migration_imports','catalog_mutation_scopes'].includes(table))same(after[table],before[table]);
  same(after,expectedPermanentDisplayRows(f.prepared.plan,f.prepared.sha256));
  assert.deepEqual(permanentBaselineCurrent({...f.captured.capture,tables:after}),permanentBaselineCurrent(f.captured.capture));
  const forged=structuredClone(f.prepared.plan);forged.batches[0][0].fields.title='forged';
  assert.throws(()=>expectedPermanentDisplayRows(forged,sha256(canonicalJson(forged))),/permanent_display_plan/);
  for(const row of after.products){const old=before.products.find(p=>p.id===row.id);for(const field of Object.keys(row))if(!fields.includes(field))assert.equal(row[field],old[field]);
    const base=JSON.parse(row.public_display_json);assert.equal(base.eligibleUntil,null);assert.equal(base.indexable,false);assert.equal(base.imageUrl,asset);
    assert.equal(base.persistent,undefined);assert.doesNotMatch(row.public_display_json,/supplier\.invalid|Original supplier/);
    const {persistent:rights,...originalRights}=JSON.parse(row.rights_json);same(originalRights,JSON.parse(old.rights_json));assert.equal(rights.title.value,base.title);}
  same(f.sql.prepare('SELECT id,rowid FROM products ORDER BY id').all(),rowids);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM products_fts WHERE products_fts MATCH 'catalog'").get().n,43);
  const writes=f.metrics().writeBatches;assert.equal((await f.apply({ownerCursor:cursor})).state,'reconciled');assert.equal(f.metrics().writeBatches,writes);
  assert.equal(f.metrics().sends,f.reservations.size);assert.equal(f.settlements.size,f.reservations.size);
  console.log(JSON.stringify({fixture:'local-SQLite-REST-display-only-not-provider-capacity',apply:{requests:applied.requests-start.requests,
    statements:applied.statements-start.statements,sqliteReportedWrites:applied.reportedRowsWritten-start.reportedRowsWritten},metrics:f.metrics()}));
});
test('fresh owner after release accepts only genuine runtime append/reservation while all catalog/native/history remain exact',async t=>{
  const f=await fixture(t,{fresh:true,count:4,runtimeHistory:true});assert.equal(f.owner.generation,f.union.plan.owner.generation+1);
  assert.notEqual(f.owner.token,f.union.plan.owner.token);assert.equal(f.owner.epoch,f.union.plan.owner.epoch+f.union.plan.batches.length);
  const before=f.state();await f.apply();const after=f.state();same(after.search_diagnostics,before.search_diagnostics);same(after.semantic_search_budgets,before.semantic_search_budgets);
  same(after.catalog_maintenance_products,before.catalog_maintenance_products);
  assert.equal(after.search_diagnostics.some(r=>r.id==='expired-runtime'),false);
  assert.equal(after.search_diagnostics.some(r=>r.id==='retained-runtime'),true);
  assert.equal(after.semantic_search_budgets.length,1);assert.equal(after.semantic_search_budgets[0].requests_reserved,2);
});
test('only explicit reviewed0015 control allocator14-to15 is portable; no other table or sequence normalization',async t=>{
  const f=await fixture(t,{count:4,fresh:true,controlMigration:true});
  const plain=structuredClone(f.input);delete plain.controlMigration;
  assert.throws(()=>preparePermanentDisplayPlan(plain),/union_drift_sqlite_sequence/);
  for(const change of [i=>i.controlMigration.sourceSha256='f'.repeat(64),i=>i.controlMigration.receiptSha256='not-a-hash',
    i=>i.controlMigration.name='0016_other.sql',i=>i.capture.tables.sqlite_sequence.find(r=>r.name==='d1_migrations').seq=16,
    i=>i.capture.tables.sqlite_sequence.push({name:'unapproved',seq:1}),i=>i.capture.tables.products[0].description='drift']){
    const input=structuredClone(f.input);change(input);input.capture.inventory=inventory(input.capture.tables);
    input.captureSha256=sha256(canonicalJson(input.capture));assert.throws(()=>preparePermanentDisplayPlan(input),/control_migration|union_drift/);
  }
  f.sql.prepare('UPDATE d1_migrations SET name=? WHERE id=15').run('foreign.sql');
  await assert.rejects(f.apply(),/control_migration/);assert.equal(f.metrics().writeBatches,0);
  f.sql.prepare('UPDATE d1_migrations SET name=? WHERE id=15').run('0015_persistent_projection_facts.sql');
  assert.equal((await f.apply()).state,'reconciled');same(f.state().sqlite_sequence,f.captured.capture.tables.sqlite_sequence);
});
test('portable union proof refuses nonruntime changes and unsupported diagnostic/budget drift even when capture is rehashed',async t=>{
  const f=await fixture(t,{count:4,fresh:true,runtimeHistory:true});
  for(const mutate of [c=>c.tables.products[0].description='different catalog state',c=>c.tables.catalog_maintenance_products[0].version++,
    c=>c.tables.migration_imports[0].batch_sha256='f'.repeat(64),c=>c.tables.sqlite_sequence.push({name:'unapproved',seq:1}),
    c=>c.tables.search_diagnostics.find(r=>r.id==='retained-runtime').outcome='ok',
    c=>{c.tables.search_diagnostics=c.tables.search_diagnostics.filter(r=>r.id!=='retained-runtime');},
    c=>c.tables.search_diagnostics.find(r=>r.id==='new-runtime').expires_at=END,
    c=>c.tables.semantic_search_budgets[0].request_cap++,c=>c.tables.semantic_search_budgets[0].requests_reserved=1,
    c=>c.tables.semantic_search_budgets[0].tokens_reserved=10000,c=>{c.tables.semantic_search_budgets=[];}]){
    const input=structuredClone(f.input);mutate(input.capture);input.capture.inventory=inventory(input.capture.tables);
    input.captureSha256=sha256(canonicalJson(input.capture));assert.throws(()=>preparePermanentDisplayPlan(input),/union_drift|runtime_drift/);
  }
  const before=f.state();await f.apply();assert.equal(f.metrics().writeBatches,1);same(f.state().catalog_maintenance_products,before.catalog_maintenance_products);
});
test('committed ACK loss and checkpoint loss resume exact receipts without duplicate product updates',async t=>{
  const f=await fixture(t);f.loseAck();let checkpoints=0;const cursor={current:f.owner};
  await assert.rejects(f.apply({ownerCursor:cursor,checkpoint:async()=>{if(++checkpoints===1)throw new Error('Checkpoint lost');}}),/Checkpoint lost/);
  assert.equal(f.metrics().unconfirmedRequests,1);assert.equal(f.metrics().writeBatches,1);
  const original=f.owner;cursor.current=original;await f.apply({ownerCursor:cursor});assert.equal(f.metrics().writeBatches,f.prepared.plan.batches.length);
  const saved=f.metrics().writeBatches;await f.apply({ownerCursor:cursor});assert.equal(f.metrics().writeBatches,saved);
});
test('receipt/resource/plan/grants/proposal/source and fullrow or sidecar drift refuse without installer effects',async t=>{
  const f=await fixture(t,{count:4}),before=f.state();
  for(const change of [i=>i.approvedProposal.value.proposed[0].input.product.title='forged',i=>i.assembler.approvedRightsById[i.evidence.products[0].id].title.basis='merchant',
    i=>i.evidence.manifestSha256='f'.repeat(64),i=>i.union.sha256='f'.repeat(64),i=>i.owner.generation++,i=>i.owner.epoch++]){
    const input=structuredClone(f.input);change(input);assert.throws(()=>preparePermanentDisplayPlan(input));same(f.state(),before);}
  for(const db of [{...f.db,providerIdentity:f.db.providerIdentity},await f.makeDb('00000000-0000-4000-8000-000000000902')]){
    await assert.rejects(f.apply({db}),/catalog_capture_receipt/);same(f.state(),before);}
  const proof=structuredClone({receipt:f.captured.receipt,sha256:f.captured.receiptSha256});proof.receipt.schemas[0].sha256='f'.repeat(64);proof.sha256=sha256(canonicalJson(proof.receipt));
  await assert.rejects(f.apply({cooperativeCapture:proof}),/catalog_capture_receipt_schema/);same(f.state(),before);
  f.sql.prepare('UPDATE products SET quality_score=.7 WHERE id=?').run(f.source[2].id);await assert.rejects(f.apply(),/drift_products/);
  f.sql.prepare('UPDATE products SET quality_score=.8 WHERE id=?').run(f.source[2].id);
  f.sql.prepare("UPDATE catalog_maintenance_products SET embedding_provenance_json='{}'").run();await assert.rejects(f.apply(),/drift_catalog_maintenance_products/);
  assert.equal(f.metrics().writeBatches,0);
});
test('late product/private/owner mutation inside the actual REST batch rolls back update, receipt and epoch',async t=>{
  for(const fault of ["UPDATE products SET description='late'",'UPDATE catalog_maintenance_products SET version=version+1',"UPDATE catalog_mutation_scopes SET owner_reference='foreign'"]){
    const f=await fixture(t,{count:4}),before=f.state();let once=false;
    f.hooks({statement:q=>{if(!once&&q.sql.startsWith('INSERT INTO migration_imports')){once=true;f.sql.exec(fault);}}});
    await assert.rejects(f.apply(),/batch_unconfirmed/);same(f.state(),before);assert.equal(f.metrics().unconfirmedRequests,1);}
});
test('before-dispatch fullrow drift, ABA and missing guards cannot be mistaken for completed installation',async t=>{
  for(const mutate of [f=>f.sql.exec("UPDATE catalog_mutation_scopes SET generation=generation+1"),
    f=>f.sql.exec('DROP TRIGGER search_diagnostics_capture_update'),f=>f.sql.exec("UPDATE products SET editorial_status='blocked'")]){
    const f=await fixture(t,{count:4});mutate(f);await assert.rejects(f.apply());assert.equal(f.metrics().writeBatches,0);}
});
test('all3383 plans retain every identity; escaped long rows byte-page instead of truncation',async t=>{
  const f=await fixture(t,{count:3383,initialCount:3382}),ids=f.prepared.plan.batches.flat().map(p=>p.id);
  assert.equal(ids.length,3383);assert.equal(new Set(ids).size,3383);assert.ok(f.prepared.plan.batches.every(b=>b.length<=40));
  assert.equal(f.metrics().writeBatches,0);console.log(JSON.stringify({fixture:'3383-planner-only-not-full-apply-capacity',batches:f.prepared.plan.batches.length,identities:ids.length}));
  const long=await fixture(t,{count:5,long:true});await long.apply();assert.ok(long.metrics().maxRequest<=512*1024);assert.ok(long.metrics().maxResponse<=512*1024);
});
