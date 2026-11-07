import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm,lstat,readdir,symlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getTableConfig} from 'drizzle-orm/pg-core';
import {DatabaseSync} from 'node:sqlite';
import {products,catalogRuns,catalogRunItems,productSlugHistory,catalogEditorialEvents,searchQueries} from '../lib/db/schema.ts';
import {canonicalJson,convertSourceRow,sha256} from '../scripts/catalog/migration.ts';
import {validateRecoveryArchive} from '../scripts/catalog/recovery-archive.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {maintenanceState} from '../scripts/catalog/maintenance-state.ts';
import {D1_RECOVERY_TABLES,prepareRollbackPacket,writeRollbackPacket,readRollbackFixture,readCooperativeRollback} from '../scripts/catalog/recovery-delta.ts';
import {runNativeRecovery} from '../scripts/catalog/recovery-native.ts';
import {createD1CatalogTelemetryStore} from '../scripts/catalog/telemetry-d1.ts';
import {createD1CatalogMaintenanceStore} from '../scripts/catalog/maintenance-d1.ts';
import {claimMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {prepareOperationalPacket} from '../scripts/catalog/prepare-operational.ts';
import {prepareOwnedOperationalImport,applyOwnedOperationalImport} from '../scripts/catalog/owned-operational-import.ts';
import {captureOwnedD1} from '../scripts/catalog/capture-owned-d1.ts';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';

const AT='2026-10-21T12:00:00.123456Z';const LATER='2026-10-21T12:01:00.654321Z';
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const native=encodePgvectorSendBase64([-0,Math.fround(1.401298464324817e-45),Math.fround(-.1),...Array(1533).fill(1)]);
const replacement=encodePgvectorSendBase64([Math.fround(.123),...Array(1535).fill(-2)]);
const seq={schemaname:'public',sequencename:'catalog_run_items_sequence_seq',data_type:'bigint',increment_by:'1',min_value:'1',
  max_value:'9223372036854775807',start_value:'1',cache_size:'1',cycle:false,last_value:'3'};
function definition(table,index){
  const config=getTableConfig(table);const key=config.name==='product_slug_history'?'slug':'id';
  const columns=config.columns.map(c=>({name:c.name,nullable:!c.notNull,
    type:c.getSQLType().replace(/^varchar/,'character varying').replace(/^timestamp$/,'timestamp without time zone').replace(/^bigserial$/,'bigint').replace(/, /g,','),
    default:config.name==='catalog_run_items'&&c.name==='sequence'?"nextval('catalog_run_items_sequence_seq'::regclass)":typeof c.default==='number'?String(c.default):null}));
  return {schema:'public',name:config.name,file:`${String(index).padStart(3,'0')}.ndjson`,rowCount:0,sha256:'',columns,
    columnEncodings:Object.fromEntries(columns.map(c=>[c.name,c.type==='vector(1536)'?'pgvector-send-base64-v1':c.type==='boolean'?'json-boolean':'postgres-text'])),
    constraints:[{name:`${config.name}_pkey`,definition:`PRIMARY KEY (${key})`}],
    indexes:[{name:`${config.name}_pkey`,definition:`CREATE UNIQUE INDEX ${config.name}_pkey ON public.${config.name} USING btree (${key})`}]};
}
function empty(def){return Object.fromEntries(def.columns.map(c=>[c.name,c.nullable?null:c.type==='boolean'?false:c.type==='jsonb'?'{}':c.type.startsWith('timestamp')?'2026-10-20 10:00:00'+(c.type.endsWith('with time zone')?'+00':''):'TEST']));}
function inventory(input){input.inventory=D1_RECOVERY_TABLES.map(table=>({table,rows:input.tables[table].length,sha256:sha256(canonicalJson(input.tables[table]))}));return input;}
async function fixture({searches=0,ownedImport=false,cooperative=false,heldControls=false}={}){
  const parent=await mkdtemp(join(process.env.CATALOG_RECOVERY_TEST_EVIDENCE_PARENT||tmpdir(),'sg-delta-fixture-'));
  const directory=join(parent,'baseline');await mkdir(directory,{mode:0o700});
  const tables=[products,catalogRuns,catalogRunItems,productSlugHistory,catalogEditorialEvents,searchQueries].map(definition);
  for(let i=tables.length;i<13;i++)tables.push({schema:'public',name:`retired_fixture_${i}`,file:`${String(i).padStart(3,'0')}.ndjson`,
    columns:[{name:'id',type:'text',nullable:false,default:null},{name:'detail',type:'text',nullable:true,default:null}],
    columnEncodings:{id:'postgres-text',detail:'postgres-text'},constraints:[{name:`retired_fixture_${i}_pkey`,definition:'PRIMARY KEY (id)'}],
    indexes:[{name:`retired_fixture_${i}_pkey`,definition:`CREATE UNIQUE INDEX retired_fixture_${i}_pkey ON public.retired_fixture_${i} USING btree (id)`}]});
  const p=n=>({...empty(tables[0]),id:`TEST-${n}`,public_id:uuid(n),slug:`fixture-${n}`,title:`HISTORICAL TEST TITLE ${n}`,price:'19.99',currency:'USD',source:'amazon',
    affiliate_url:'https://example.test/fixture',quality_score:'0.8000',is_active:true,editorial_status:'pending',embedding:native,click_count:'7',impression_count:'11'});
  const run={...empty(tables[1]),id:uuid(20),telemetry_version:'test-v1',mode:'daily',trigger:'fixture',status:'completed',dry_run:false,config:'{}',counts:'{}',timings_ms:'{}',usage:'{}',warnings:'[]'};
  const item={...empty(tables[2]),id:uuid(30),sequence:'3',run_id:run.id,phase:'refresh',stage:'selection',decision:'selected',external_id:'TEST-1',requires_manual_review:false,details:'{}'};
  const data=[[p(1),p(2)],[run],[item],[],[],Array.from({length:searches},(_,i)=>({...empty(tables[5]),id:uuid(40+i),query:`TEST SEARCH ${i}`,result_count:'1',clicked:'0'})),
    ...tables.slice(6).map((_,i)=>[{id:`OLD-${i}`,detail:'SYNTHETIC PRIVATE RETIRED HISTORY'}])];
  let totalBytes=0;
  for(const [i,t]of tables.entries()){const raw=data[i].map(JSON.stringify).join('\n')+(data[i].length?'\n':'');t.rowCount=data[i].length;t.sha256=sha256(raw);totalBytes+=Buffer.byteLength(raw);await writeFile(join(directory,t.file),raw,{mode:0o600});}
  const functions=['assign_product_public_identity','preserve_product_slug_history'].map(proname=>({schema_name:'public',proname,arguments:'',
    definition:`CREATE OR REPLACE FUNCTION public.${proname}()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$\nBEGIN\n RETURN NEW;\nEND;\n$function$\n`}));
  const triggers=[{schema_name:'public',relname:'products',tgname:'products_assign_public_identity',definition:'CREATE TRIGGER products_assign_public_identity BEFORE INSERT OR UPDATE OF slug ON public.products FOR EACH ROW EXECUTE FUNCTION assign_product_public_identity()'},
    {schema_name:'public',relname:'products',tgname:'products_preserve_slug_history',definition:'CREATE TRIGGER products_preserve_slug_history BEFORE UPDATE OF slug ON public.products FOR EACH ROW EXECUTE FUNCTION preserve_product_slug_history()'}];
  const settings={database:'test-only',snapshot:'fixture-only',observedAt:'2026-10-21T11:00:00Z',serverVersion:'17.11 (fixture)',serverVersionNum:'170011',isolation:'repeatable read',readOnly:'on'};
  const metadata={schemaVersion:1,binding:{kind:'same-transaction',archiveManifestSha256:null,archiveSnapshot:settings.snapshot,archiveObservedAt:settings.observedAt},source:settings,
    sequences:[{schema:'public',name:seq.sequencename,lastValue:'3',isCalled:true,configuration:Object.fromEntries(Object.entries(seq).filter(([k])=>!['schemaname','sequencename','last_value'].includes(k))),ownedBy:[{schema:'public',table:'catalog_run_items',column:'sequence',dependency:'a'}]}],
    triggers:triggers.map(t=>({schema:'public',table:'products',name:t.tgname,definition:t.definition,enabled:'O'})),
    aclEvidence:{database:{acl:null},schemas:[],relations:[],columns:[],functions:[],defaultPrivileges:[]},settingsEvidence:{session:{TimeZone:'GMT'},databaseRole:[]},sequenceConsistency:'nontransactional-observations-not-a-write-barrier'};
  const manifest={schemaVersion:1,mode:'https-repeatable-read-single-transaction',settings,totalBytes,tables,sequences:[seq],recoveryMetadata:metadata};
  const text=JSON.stringify(manifest)+'\n',baselineSha256=sha256(text);
  await writeFile(join(directory,'manifest.json'),text,{mode:0o600});await writeFile(join(directory,'manifest.sha256'),baselineSha256+'  manifest.json\n',{mode:0o600});
  const audit={readOnly:true,isolation:'repeatable read',policies:[],tables:tables.map(t=>({schema_name:t.schema,relname:t.name,relkind:'r',can_select:true,active_rls_for_export_role:false,
    relrowsecurity:false,relforcerowsecurity:false,relispartition:false,relhassubclass:false,inherits_from_parent:false})),functions,triggers,
    extensions:[{extname:'vector',extversion:'0.8.0',schema_name:'public'},{extname:'plpgsql',extversion:'1.0',schema_name:'pg_catalog'}]};
  const auditText=JSON.stringify(audit)+'\n',auditPath=join(parent,'audit.json');await writeFile(auditPath,auditText,{mode:0o600});
  const archive=await validateRecoveryArchive(directory,{expectedManifestSha256:baselineSha256});
  const input={schemaVersion:1,scope:'application-logical-tables-through-0012',provenance:{kind:'synthetic-fixture',reference:'controlled fixture only',barrierEvidence:null},tables:Object.fromEntries(D1_RECOVERY_TABLES.map(t=>[t,[]])),inventory:[]};
  for(const [i,table]of tables.slice(0,6).entries()){
    const timestamps=Object.fromEntries(table.columns.filter(c=>c.type==='timestamp without time zone').map(c=>[`${table.name}.${c.name}`,{timezone:'unresolved',evidence:'fixture historical timezone unknown'}]));
    input.tables[table.name==='search_queries'?'search_history':table.name]=data[i].map(r=>convertSourceRow(table.name,r,{catalogRevision:'fixture-base',archiveId:baselineSha256,timestamps}));
  }
  function maintain(row,old,newId){
    const semantic=maintenanceState(row);if(newId){semantic.id=newId;semantic.publicId=uuid(3);semantic.slug='fixture-3';semantic.createdAt=AT;}
    semantic.title='CURRENT D1 TITLE, NOT HISTORICAL JSON';semantic.price='23.45';semantic.updatedAt=LATER;
    const current={...row,id:semantic.id,public_id:semantic.publicId,slug:semantic.slug,price_minor:2345,created_at:semantic.createdAt,updated_at:semantic.updatedAt};
    if(!old)current.source_record_json=canonicalJson({kind:'maintenance_creation',id:semantic.id,public_id:semantic.publicId,slug:semantic.slug});
    current.timestamp_provenance_json=canonicalJson({fields:{created_at:{state:newId?'evidenced':'unresolved'},updated_at:{state:'evidenced'}}});
    const m={product_id:semantic.id,version:1,semantic_json:canonicalJson(semantic),embedding_present:1,embedding_native_base64:old?replacement:native,embedding_provenance_json:'{}'};
    input.tables.catalog_maintenance_products.push(m);return current;
  }
  input.tables.products[0]=maintain(input.tables.products[0],true);
  input.tables.products.push(maintain(input.tables.products[1],false,'TEST-3'));
  if(heldControls)Object.assign(input.tables.products[1],{is_active:0,source_facts_hash:'d'.repeat(64),editorial_source_hash:'d'.repeat(64),
    availability_checked_at:AT,last_verified_at:AT}); // Provenance still describes old raw naive source, not these current UTC instants.
  // The owned-union variant begins before the original legacy items have been
  // imported, so native allocations genuinely occupy their source sequences.
  if(ownedImport){
    input.tables.catalog_run_items=[];
    // Match the existing history importer: it retains the exact NDJSON line,
    // not a freshly canonicalized equivalent source_record_json string.
    const sourceRuns=archive.tables.find(t=>t.definition.name==='catalog_runs');
    for(const line of sourceRuns.raw.trimEnd().split('\n'))input.tables.catalog_runs.find(r=>r.id===JSON.parse(line).id).source_record_json=line;
  }
  // Exercise the actual writer's raw/start/finish JSON, casing, defaults,
  // sequence allocation and typed overrides rather than hand-authoring them.
  const sqlite=new DatabaseSync(':memory:');let owned,proof;
  try{
    // Preserve this historical24-table rollback scope;0017 telemetry is separate.
    for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^00\d\d_.*\.sql$/.test(n)&&n<'0017').sort())
      sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
    let clock='2026-10-21T12:00:00.123Z';sqlite.function('strftime',{varargs:true},()=>clock);
    const db={prepare(sql){let params=[];return{sql,get params(){return params;},bind(...p){params=p;return this;},
      async all(){return{results:sqlite.prepare(sql).all(...params).map(r=>({...r}))};},async run(){return sqlite.prepare(sql).run(...params);}};},
      async batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(s=>({success:true,results:sqlite.prepare(s.sql).all(...s.params).map(r=>({...r}))}));sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e;}}};
    for(const name of ['products','catalog_runs','catalog_run_items','catalog_maintenance_products'])for(const row of input.tables[name]){
      const keys=Object.keys(row);sqlite.prepare(`INSERT INTO ${name}(${keys.join(',')}) VALUES(${keys.map(()=>'?')})`).run(...keys.map(k=>row[k]));
    }
    sqlite.exec("INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES('staging','fixture-index')");
    const owner=await claimMutationOwnership(db,{environment:'staging',indexName:'fixture-index'},{phase:'writing',ownerReference:'test/rollback',operationKey:'c'.repeat(64)});
    const options={db,owner,ownerCursor:{current:owner},runId:uuid(21),catalogRevision:'fixture-current'};
    const store=createD1CatalogTelemetryStore(options);const maintenance=createD1CatalogMaintenanceStore(options);
    await store.startCatalogRun({id:uuid(21),mode:'daily',trigger:'fixture',config:{},gitSha:null});
    await store.insertCatalogRunItems(uuid(21),Array.from({length:ownedImport?3:1},(_,i)=>({id:uuid(31+i),phase:'refresh',stage:'selection',decision:'selected',productId:'TEST-3',externalId:'TEST-1',requiresManualReview:false,details:{fixture:true}})));
    await maintenance.recordEditorialEvent({runId:uuid(21),productId:'TEST-3',eventType:'draft_reviewed',status:'generated_ready',details:{fixture:true}});
    clock='2026-10-21T12:01:00.654Z';await store.finishCatalogRun(uuid(21),{status:'completed',counts:{refreshed:1},usage:{inputTokens:2,estimatedCostUsd:.000001}});
    for(const name of ['catalog_runs','catalog_run_items','catalog_editorial_events','catalog_run_telemetry','catalog_mutation_scopes','catalog_maintenance_operations','sqlite_sequence'])
      input.tables[name]=sqlite.prepare(`SELECT * FROM ${name}`).all().map(r=>({...r}));
    if(ownedImport){
      let actual=db,before;
      if(cooperative){
        const config={accountId:'a'.repeat(32),databaseId:uuid(901),databaseName:'cooperative-local-fixture',token:'LOCAL_FIXTURE_ONLY'};
        const base=`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}`;
        actual=await createCatalogD1Rest({...config,fetch:async(url,init)=>{
          if(url===base)return Response.json({success:true,result:{uuid:config.databaseId,name:config.databaseName,read_replication:{mode:'disabled'}}});
          assert.equal(url,base+'/query');const {batch}=JSON.parse(init.body);sqlite.exec('BEGIN');
          try{const result=batch.map(q=>({success:true,results:sqlite.prepare(q.sql).all(...q.params).map(r=>({...r})),meta:{served_by_primary:true,rows_read:1,rows_written:0}}));
            sqlite.exec('COMMIT');return Response.json({success:true,result});}catch{sqlite.exec('ROLLBACK');return Response.json({success:false,errors:[{message:'LOCAL_FIXTURE_SQL_REFUSED'}]},{status:400});}
        }});
        before=await captureOwnedD1({db:actual,owner:options.ownerCursor.current,reference:'local-only/cooperative-before',stoppedWriters:[
          {id:'application-fixture',kind:'application',codePaths:['workers/site/index.ts'],reference:'Synthetic local store, no actual provider/writer-stop claim',stoppedAt:AT.slice(0,23)+'Z'},
          {id:'operator-fixture',kind:'operator',codePaths:[],reference:'Synthetic local operator',stoppedAt:AT.slice(0,23)+'Z'}]});
      }
      const captured=before?.capture??inventory({...input,tables:Object.fromEntries(D1_RECOVERY_TABLES.map(name=>[name,sqlite.prepare(`SELECT * FROM ${name}`).all().map(r=>({...r}))]))});
      const preserved=captured.tables.products.filter(p=>p.id!=='TEST-3');
      const packet=prepareOperationalPacket(archive,{importedAt:'2026-10-21T12:02:00.000Z',unresolvedEvidence:'Controlled unresolved historical wall times',
        preserve:{rows:preserved,rowsFileSha256:sha256(canonicalJson(preserved)),evidenceSha256:sha256(canonicalJson(captured)),evidenceReference:'synthetic/actual-store-capture'}});
      const prepared=prepareOwnedOperationalImport({packet,capture:captured,captureSha256:sha256(canonicalJson(captured)),owner:options.ownerCursor.current});
      owned={plan:prepared.plan,sha256:prepared.sha256};
      const result=await applyOwnedOperationalImport({db:actual,plan:owned.plan,planSha256:owned.sha256,ownerCursor:options.ownerCursor,
        ...(before?{cooperativeCapture:{receipt:before.receipt,sha256:before.receiptSha256}}:{})});
      for(const name of D1_RECOVERY_TABLES)input.tables[name]=sqlite.prepare(`SELECT * FROM ${name}`).all().map(r=>({...r}));
      if(before){const after=await captureOwnedD1({db:actual,owner:options.ownerCursor.current,reference:'local-only/cooperative-after',stoppedWriters:before.receipt.stoppedWriters});
        Object.assign(input,after.capture);proof={kind:'local-cooperative-owned-union-drill',inputSha256:after.captureSha256,ownedImport:owned,
          before:{receipt:before.receipt,sha256:before.receiptSha256},after:{receipt:after.receipt,sha256:after.receiptSha256},completion:{result,sha256:sha256(canonicalJson(result))}};}
    }
  }finally{sqlite.close();}
  if(!cooperative)input.tables.search_diagnostics.push({id:uuid(99),query_hash:'a'.repeat(64),query_length:2,result_count:1,top_similarity:null,
    match_type:'keyword',outcome:'ok',created_at:AT,expires_at:'2026-11-20T12:00:00.123456Z'});
  inventory(input);
  return{parent,directory,archive,manifest,input,baselineSha256,auditPath,auditSha256:sha256(auditText),owned,proof,
    plan(data=input){inventory(data);return prepareRollbackPacket(archive,manifest,data,sha256(canonicalJson(data)),owned);},
    async packet(){const bytes=canonicalJson(input)+(cooperative?'':'\n'),path=join(parent,'input.json');await writeFile(path,bytes,{mode:0o600});return writeRollbackPacket({archive:directory,baselineSha256,input:path,inputSha256:sha256(bytes),output:join(parent,'packet'),ownedImport:owned});}};
}

test('owned baseline held controls without maintenance semantics preserve exact inactive/hash controls and archived facts/native/time',async()=>{
  const f=await fixture({ownedImport:true,cooperative:true,heldControls:true});try{
    const packet=f.plan(),held=packet.changes.find(c=>c.key==='TEST-2'),old=f.archive.tables[0].rows[1];
    assert.equal(held.after.is_active,false);assert.equal(held.after.source_facts_hash,'d'.repeat(64));assert.equal(held.after.editorial_source_hash,'d'.repeat(64));
    for(const field of Object.keys(old).filter(k=>!['is_active','source_facts_hash','editorial_source_hash','availability_checked_at','last_verified_at'].includes(k)))assert.deepEqual(held.after[field],old[field]);
    assert.equal(held.after.availability_checked_at,'2026-10-21 12:00:00.123456');assert.equal(held.after.last_verified_at,'2026-10-21 12:00:00.123456');
    assert.equal(held.after.embedding,native);assert.ok(packet.transformations.some(t=>t.startsWith('1 exact owned-import baseline held')));
    const written=await f.packet();await readCooperativeRollback(written.directory,written.packetSha256,f.archive,f.manifest,f.proof);
    // Same current-looking controls without the exact baseline proof still
    // refuse; arbitrary mutable fields, reactivation or grant/display cannot
    // be smuggled through this narrow hold mapping.
    for(const change of [i=>{i.tables.products[1].source_facts_hash='e'.repeat(64);},i=>{i.tables.products[1].is_active=1;},
      i=>{i.tables.products[1].price_minor++;},i=>{i.tables.products[1].title='UNAPPROVED';},
      i=>{i.tables.products[1].rights_json='{"new":true}';},i=>{i.tables.products[1].updated_at=LATER;}]){
      const input=structuredClone(f.input);change(input);assert.throws(()=>f.plan(input));
    }
    assert.throws(()=>prepareRollbackPacket(f.archive,f.manifest,f.input,sha256(canonicalJson(f.input))));
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('unowned held controls and fresh-looking UTC verification cannot replace archived values without the owned baseline proof',async()=>{
  const f=await fixture({heldControls:true});try{
    assert.throws(()=>f.plan(),/incomplete, drifted or unsupported/);
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('cooperative LOCAL rollback opt-in binds both actual-store captures, complete24-table union, receipts and inverse/native bytes',async()=>{
  const f=await fixture({ownedImport:true,cooperative:true});try{
    const written=await f.packet(),read=()=>readCooperativeRollback(written.directory,written.packetSha256,f.archive,f.manifest,f.proof);
    const packet=await read();assert.equal(packet.provenance.kind,'unverified-capture');assert.equal(packet.barrierVerified,false);
    assert.equal(packet.changes.find(c=>c.key==='TEST-1').after.embedding,replacement);
    assert.equal(packet.changes.find(c=>c.key==='TEST-3').after.embedding,native);
    assert.equal(packet.ownedImportSequences.nativeSequences.length,1);assert.equal(f.proof.completion.result.tables.length,24);
    await assert.rejects(readRollbackFixture(written.directory,written.packetSha256,f.archive,f.manifest,f.owned));
    for(const change of [p=>{p.inputSha256='a'.repeat(64);},p=>{p.ownedImport.sha256='b'.repeat(64);},
      p=>{p.before.receipt.ownerBefore.epoch++;p.before.sha256=sha256(canonicalJson(p.before.receipt));},
      p=>{p.after.receipt.providerIdentity='cloudflare:'+'b'.repeat(32)+':'+uuid(901);p.after.sha256=sha256(canonicalJson(p.after.receipt));},
      p=>{p.completion.result.tables[0].rows++;p.completion.sha256=sha256(canonicalJson(p.completion.result));},
      p=>{p.completion.result.barrierVerified=true;p.completion.sha256=sha256(canonicalJson(p.completion.result));}]){
      const proof=structuredClone(f.proof);change(proof);
      await assert.rejects(readCooperativeRollback(written.directory,written.packetSha256,f.archive,f.manifest,proof));
    }
    // Even a freshly checksum-bound D1-only native/control change cannot hide
    // behind matching runtime product rows or an alleged completed import.
    const bytes=canonicalJson({...f.input,tables:{...f.input.tables,search_diagnostics:[{id:'unapproved'}]}});
    const drift=JSON.parse(bytes);inventory(drift);const inputPath=join(f.parent,'drift.json');await writeFile(inputPath,canonicalJson(drift),{mode:0o600});
    const altered=await writeRollbackPacket({archive:f.directory,baselineSha256:f.baselineSha256,input:inputPath,inputSha256:sha256(canonicalJson(drift)),output:join(f.parent,'drift-packet'),ownedImport:f.owned});
    const proof=structuredClone(f.proof);proof.inputSha256=altered.packet.inputSha256;
    await assert.rejects(readCooperativeRollback(altered.directory,altered.packetSha256,f.archive,f.manifest,proof),/incomplete, drifted or unsupported/);
    await assert.rejects(runNativeRecovery({rollbackFixture:{},cooperativeRollback:{}}),/Choose one/);
    const invalid=structuredClone(f.proof);invalid.ownedImport.sha256='b'.repeat(64);
    // Complete validation occurs BEFORE mkdtemp/Docker endpoint/image/commands.
    // No container exists or Docker daemon needs to be available for refusal.
    await assert.rejects(runNativeRecovery({archive:f.directory,expectedManifestSha256:f.baselineSha256,audit:f.auditPath,
      expectedAuditSha256:f.auditSha256,workParent:f.parent,cooperativeRollback:{directory:written.directory,expectedPacketSha256:written.packetSha256,proof:invalid}}));
    assert.equal((await readdir(f.parent)).some(n=>n.startsWith('recovery-native-pg17-')),false);
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('optional cooperative local drill uses the same fresh network-none native restore, atomic failure/replay/allocator and owned cleanup',
  {skip:process.env.CATALOG_RECOVERY_TEST_NATIVE!=='1'},async()=>{
    const f=await fixture({ownedImport:true,cooperative:true});let passed=false;
    try{const written=await f.packet();const result=await runNativeRecovery({archive:f.directory,expectedManifestSha256:f.baselineSha256,
      audit:f.auditPath,expectedAuditSha256:f.auditSha256,workParent:f.parent,
      cooperativeRollback:{directory:written.directory,expectedPacketSha256:written.packetSha256,proof:f.proof}});
      assert.equal(result.receipt.status,'passed');assert.equal(result.receipt.resourcesRemoved,true);
      assert.equal(result.receipt.vectorCount,2);assert.match(result.receipt.resourceLabel,/^goose\.catalog\.recovery=[a-f0-9-]{36}$/);
      assert.equal(result.receipt.cooperativeRollbackProofSha256,sha256(canonicalJson(f.proof)));
      assert.equal(result.receipt.rollbackFixture.packetSha256,written.packetSha256);
      assert.equal(result.receipt.rollbackFixture.provenance.kind,'unverified-capture');assert.equal(result.receipt.rollbackFixture.barrierVerified,false);
      for(const k of ['lateFailureAtomic','identicalReplay','nextSequenceVerified'])assert.equal(result.receipt.rollbackFixture[k],true);
      assert.ok(result.receipt.limitations.some(s=>s.includes('not a universal provider/ACL barrier')));passed=true;
    }finally{if(passed&&process.env.CATALOG_RECOVERY_TEST_KEEP!=='1')await rm(f.parent,{recursive:true,force:true});}
  });

test('owned union rollback restores legacy sequences and explicitly reallocates colliding actual native telemetry',async()=>{
  const f=await fixture({ownedImport:true});try{
    const before=canonicalJson(f.input),packet=f.plan();assert.equal(canonicalJson(f.input),before);
    assert.equal(f.input.tables.catalog_run_items.find(r=>r.id===uuid(30)).sequence,4);
    assert.equal(f.input.tables.catalog_run_items.find(r=>r.id===uuid(33)).sequence,3);
    assert.deepEqual(packet.ownedImportSequences.importedSequences,[{id:uuid(30),sourceSequence:3,targetSequence:4}]);
    assert.deepEqual(packet.ownedImportSequences.nativeSequences,[{id:uuid(33),from:3,to:4}]);
    assert.equal(packet.changes.some(c=>c.key===uuid(30)),false);
    assert.equal(packet.changes.find(c=>c.key===uuid(33)).after.sequence,'4');
    assert.equal(packet.changes.find(c=>c.key==='TEST-1').after.embedding,replacement);
    assert.equal(packet.changes.find(c=>c.key==='TEST-3').after.embedding,native);
    assert.equal(packet.sequence.nextValue,'5');
    assert.throws(()=>prepareRollbackPacket(f.archive,f.manifest,f.input,sha256(before)));
    const written=await f.packet();
    assert.equal(await readFile(join(written.directory,'d1-sidecar.json'),'utf8'),canonicalJson(f.input)+'\n');
    await readRollbackFixture(written.directory,written.packetSha256,f.archive,f.manifest,f.owned);
    await assert.rejects(readRollbackFixture(written.directory,written.packetSha256,f.archive,f.manifest));
    const changed=structuredClone(f.owned);changed.plan.sequenceMapping[0].sourceSequence=2;
    assert.throws(()=>prepareRollbackPacket(f.archive,f.manifest,f.input,sha256(before),changed));
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('offline packet restores current product state and finalized telemetry, retaining untouched baseline and native vectors',async()=>{
  const f=await fixture();try{const packet=f.plan();assert.equal(packet.changes.length,5);
    const changed=packet.changes.find(c=>c.table==='products'&&c.key==='TEST-1');assert.equal(changed.after.title,'CURRENT D1 TITLE, NOT HISTORICAL JSON');
    assert.equal(changed.before.title,'HISTORICAL TEST TITLE 1');assert.equal(changed.after.embedding,replacement);assert.equal(changed.after.price,'23.45');
    assert.equal(changed.after.created_at,changed.before.created_at);assert.equal(changed.after.click_count,'7');
    assert.equal(packet.changes.some(c=>c.key==='TEST-2'),false);assert.equal(packet.expectedTables.find(t=>t.table==='products').rows,3);
    const added=packet.changes.find(c=>c.key==='TEST-3');assert.equal(added.after.embedding,native);assert.equal(added.after.click_count,'0');
    const run=packet.changes.find(c=>c.table==='catalog_runs');assert.equal(run.after.status,'completed');assert.deepEqual(JSON.parse(run.after.counts),{refreshed:1});
    const event=packet.changes.find(c=>c.table==='catalog_editorial_events');assert.equal(event.after.event_type,'draft_reviewed');assert.deepEqual(JSON.parse(event.after.details),{fixture:true});
    assert.equal(packet.sequence.nextValue,'5');assert.equal(packet.barrierVerified,false);
    const real=structuredClone(f.input);real.provenance.kind='unverified-capture';assert.equal(f.plan(real).provenance.kind,'unverified-capture');
    // Actual naive PG source syntax may have a documented UTC writer. Reuse its
    // per-field evidence, while retaining raw wall time rather than rewriting it.
    const proven=structuredClone(f.input);const original=f.archive.tables[0].rows[1];const row=proven.tables.products[1];
    const times=JSON.parse(row.timestamp_provenance_json);
    for(const key of ['created_at','updated_at']){row[key]=original[key].replace(' ','T')+'.000000Z';times.fields[key]={state:'evidenced',basis:'documented_utc_writer',evidence:'Controlled fixture UTC writer'};}
    row.timestamp_provenance_json=canonicalJson(times);assert.equal(f.plan(proven).changes.some(c=>c.key==='TEST-2'),false);
    times.fields.created_at={state:'unresolved',evidence:'No UTC writer proof'};row.timestamp_provenance_json=canonicalJson(times);assert.throws(()=>f.plan(proven));
    const written=await f.packet();assert.equal((await lstat(join(written.directory,'rollback.json'))).mode&0o077,0);
    assert.equal(sha256(await readFile(join(written.directory,'d1-sidecar.json'),'utf8')),written.packet.inputSha256);
    assert.equal(JSON.parse(await readFile(join(written.directory,'d1-sidecar.json'),'utf8')).tables.search_diagnostics.length,1);
    await readRollbackFixture(written.directory,written.packetSha256,f.archive,f.manifest);
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('incomplete input, stale typed drift, unknown vectors, unproven time, unsupported history and provider barrier claims refuse',async()=>{
  const f=await fixture();try{
    for(const change of [
      i=>{delete i.tables.search_diagnostics;},i=>{i.tables.products.pop();},
      i=>{i.tables.products[1].editorial_status='stale';},i=>{i.tables.products[1].price_minor=999;},
      i=>{i.tables.catalog_runs[0].completed_at=AT;},i=>{i.tables.catalog_maintenance_products[0].embedding_present=null;},
      i=>{i.tables.catalog_maintenance_products[0].embedding_native_base64='not-vector';},
      i=>{const m=i.tables.catalog_maintenance_products[0],p=JSON.parse(m.semantic_json);p.updatedAt='2026-10-21 12:00:00';m.semantic_json=canonicalJson(p);i.tables.products[0].updated_at=p.updatedAt;},
      i=>{i.tables.catalog_run_telemetry[0].finish_json=null;},i=>{i.tables.catalog_run_items[1].decision='different';},
      i=>{i.tables.catalog_editorial_events[0].status='tampered';},
      i=>{i.tables.product_slug_history.push({slug:'new-slug',product_id:'TEST-1',source_record_json:'{}'});},
      i=>{i.provenance.kind='provider-barrier-capture';},i=>{i.provenance.barrierEvidence='unverified assertion';},
    ]){const input=structuredClone(f.input);change(input);assert.throws(()=>f.plan(input));}
    const input=structuredClone(f.input);input.inventory[0].rows++;assert.throws(()=>prepareRollbackPacket(f.archive,f.manifest,input,'a'.repeat(64)));
    const written=await f.packet();const bytes=await readFile(join(written.directory,'rollback.json'),'utf8');
    const source=join(f.parent,'input.json'),linked=join(f.parent,'linked.json');await symlink(source,linked);
    await assert.rejects(writeRollbackPacket({archive:f.directory,baselineSha256:f.baselineSha256,input:linked,inputSha256:written.packet.inputSha256,output:join(f.parent,'refused-symlink')}));
    const invalid=Buffer.from([0x7b,0x22,0xff,0x22,0x3a,0x31,0x7d]);const invalidPath=join(f.parent,'invalid-utf8.json');await writeFile(invalidPath,invalid,{mode:0o600});
    await assert.rejects(writeRollbackPacket({archive:f.directory,baselineSha256:f.baselineSha256,input:invalidPath,inputSha256:createHash('sha256').update(invalid).digest('hex'),output:join(f.parent,'refused-utf8')}));
    await writeFile(join(written.directory,'rollback.json'),bytes+' ',{mode:0o600});
    await assert.rejects(readRollbackFixture(written.directory,written.packetSha256,f.archive,f.manifest));
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('unchanged search history requires every baseline identity exactly once even with a correctly rebuilt inventory',async()=>{
  const f=await fixture({searches:2});try{
    const expected=f.plan();
    const reordered=structuredClone(f.input);reordered.tables.search_history.reverse();
    assert.deepEqual(f.plan(reordered).expectedTables,expected.expectedTables);
    const duplicate=structuredClone(f.input);duplicate.tables.search_history[1]=structuredClone(duplicate.tables.search_history[0]);
    assert.throws(()=>f.plan(duplicate),/incomplete, drifted or unsupported/);
    const missing=structuredClone(f.input);missing.tables.search_history.pop();
    assert.throws(()=>f.plan(missing),/incomplete, drifted or unsupported/);
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('new editorial timestamps must match the same recorded operation clock',async()=>{
  const f=await fixture();try{
    assert.ok(f.plan().changes.some(c=>c.table==='catalog_editorial_events'));
    for(const change of [
      (event,raw)=>{event.created_at=raw.created_at='2026-10-21T20:00:00Z';event.source_record_json=canonicalJson(raw);},
      (_event,_raw,operation)=>{delete operation.database_time;},
      (_event,_raw,operation)=>{operation.database_time='not-a-timestamp';},
    ]){
      const input=structuredClone(f.input),event=input.tables.catalog_editorial_events[0],raw=JSON.parse(event.source_record_json);
      const operation=input.tables.catalog_maintenance_operations.find(o=>o.operation_id===raw._maintenance.operationId);
      change(event,raw,operation);assert.throws(()=>f.plan(input));
    }
  }finally{await rm(f.parent,{recursive:true,force:true});}
});

test('owned network-none PG17 fixture applies new D1 writes, rolls back late failure/allocator and identically replays',
  {skip:process.env.CATALOG_RECOVERY_TEST_NATIVE!=='1'},async()=>{
    const f=await fixture();let passed=false;try{const written=await f.packet();
      const result=await runNativeRecovery({archive:f.directory,expectedManifestSha256:f.baselineSha256,audit:f.auditPath,expectedAuditSha256:f.auditSha256,workParent:f.parent,
        rollbackFixture:{directory:written.directory,expectedPacketSha256:written.packetSha256}});
      assert.equal(result.receipt.status,'passed');assert.equal(result.receipt.resourcesRemoved,true);
      assert.equal(result.receipt.recoveryMetadata.binding.kind,'same-transaction');
      assert.equal(result.receipt.rollbackFixture.fullFieldTables.length,13);assert.equal(result.receipt.rollbackFixture.changes,5);
      assert.equal(result.receipt.rollbackFixture.lateFailureAtomic,true);assert.equal(result.receipt.rollbackFixture.identicalReplay,true);
      assert.equal(result.receipt.rollbackFixture.nextSequenceVerified,true);assert.equal(result.receipt.rollbackFixture.barrierVerified,false);
      assert.doesNotMatch(JSON.stringify(result.receipt),/CURRENT D1 TITLE|HISTORICAL TEST TITLE|SYNTHETIC PRIVATE/);
      passed=true;if(process.env.CATALOG_RECOVERY_TEST_KEEP==='1')console.log(JSON.stringify({deltaFixtureEvidence:f.parent,receipt:result.receiptPath}));
    }finally{if(passed&&process.env.CATALOG_RECOVERY_TEST_KEEP!=='1')await rm(f.parent,{recursive:true,force:true});}
  });
