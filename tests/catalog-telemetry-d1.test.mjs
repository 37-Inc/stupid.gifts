import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile,readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import amazonCreators from '../lib/amazon-creators.js';
import { createD1CatalogTelemetryStore } from '../scripts/catalog/telemetry-d1.ts';
import { createD1CatalogMaintenanceStore } from '../scripts/catalog/maintenance-d1.ts';
import { claimMutationOwnership,releaseMutationOwnership } from '../lib/catalog/mutation-fence.ts';
import { catalogRunItem,recordOpenAIUsage } from '../scripts/ops/catalog-telemetry.mjs';
import { parseArgs,runCatalogWithBackend } from '../scripts/ops/prefetch-catalog.mjs';
import { runWeeklyCatalogWithBackend } from '../scripts/ops/catalog-weekly.mjs';

const NOW='2026-10-20T12:00:00.123Z';const RUN='test-only-run';
const published={status:'published',releaseId:'test-only-release',receiptSha256:'a'.repeat(64)};
const product={id:'B000000001',title:'TEST ONLY crab button',price:0,currency:'USD',source:'amazon',imageUrl:'https://example.invalid/test.jpg',
  affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=fixture-20',isActive:true,humorTags:['fixture'],qualityScore:.8,
  remotelyVerified:false,editorialStatus:'pending',sourceFacts:{fixture:true}};
async function fixture({applyTelemetry=true}={}){
  const sqlite=new DatabaseSync(':memory:');
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name=>/^00\d\d_.*\.sql$/.test(name)&&(applyTelemetry||!name.startsWith('0012_'))).sort())
    sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  let clock=NOW;sqlite.function('strftime',{varargs:true},()=>clock);
  let before;let after;let writes=0;
  const db={prepare(sql){let values=[];return{sql,get values(){return values;},bind(...params){values=params;return this;},
    async all(){return{results:sqlite.prepare(sql).all(...values).map(row=>({...row}))};},async run(){return sqlite.prepare(sql).run(...values);}};},
    async batch(statements){assert.ok(statements.length<=50);assert.ok(Buffer.byteLength(JSON.stringify(statements))<512*1024);
      before?.(statements);sqlite.exec('BEGIN');try{for(const statement of statements){assert.ok(statement.values.length<=100);sqlite.prepare(statement.sql).all(...statement.values);}sqlite.exec('COMMIT');writes++;}catch(error){sqlite.exec('ROLLBACK');throw error;}after?.(statements);}};
  sqlite.prepare("INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES('staging','test-only')").run();
  const scope={environment:'staging',indexName:'test-only'};
  const owner=await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'test-only/weekly',operationKey:'c'.repeat(64)});
  const cursor={current:owner};const options={db,owner,ownerCursor:cursor,runId:RUN,catalogRevision:'test-only-revision'};
  const telemetry=createD1CatalogTelemetryStore(options);const maintenance=createD1CatalogMaintenanceStore(options);
  const finalize=async(id,input)=>{await telemetry.finishCatalogRun(id,input);return telemetry.loadCatalogRun(id);};
  const backend={runId:RUN,maintenanceStore:maintenance,telemetryStore:telemetry,publish:async()=>published,finalizeRun:finalize};
  return{sqlite,db,scope,owner,cursor,options,telemetry,maintenance,backend,finalize,close:()=>sqlite.close(),
    clock(value){clock=value;},before(fn){before=fn;},after(fn){after=fn;},writes:()=>writes,
    raw:()=>({...sqlite.prepare('SELECT * FROM catalog_runs WHERE id=?').get(RUN)})};
}

test('D1 telemetry preserves full run/items, immutable raw history, sequence, exact retry and shared maintenance cursor',async()=>{
  const f=await fixture();try{
    const start={id:RUN,mode:'weekly',trigger:'test-only',config:{maxNew:20},gitSha:'d'.repeat(40)};
    await f.telemetry.startCatalogRun(start);const raw=f.raw().source_record_json;
    await f.maintenance.upsertProduct(product,null);
    const item=catalogRunItem(product,{phase:'discovery',stage:'test-only',decision:'pending',details:{inputTokens:12,secret:'DO_NOT_KEEP'}});
    await f.telemetry.insertCatalogRunItems(RUN,[item]);
    await f.maintenance.updateAmazonAffiliateUrl(product.id,product.affiliateUrl+'&test=1');
    const before=f.writes();f.clock('2026-10-21T12:00:00.000Z');
    await f.telemetry.startCatalogRun(start);await f.telemetry.insertCatalogRunItems(RUN,[item]);assert.equal(f.writes(),before);
    await assert.rejects(f.telemetry.insertCatalogRunItems(RUN,[{...item,decision:'tampered'}]),/conflict/);
    const finish={status:'completed',counts:{inserted:1},usage:{estimatedCostUsd:.001,models:{test:{inputTokens:123}}},warnings:[{phase:'test-only'}]};
    await f.telemetry.finishCatalogRun(RUN,finish);await f.telemetry.finishCatalogRun(RUN,finish);
    const result=await f.telemetry.loadCatalogRun(RUN);
    assert.equal(result.run.status,'completed');assert.equal(result.run.config.maxNew,20);assert.equal(result.run.git_sha,start.gitSha);
    assert.equal(result.run.counts.inserted,1);assert.equal(result.run.usage.models.test.inputTokens,123);assert.equal(result.run.estimated_cost_usd,.001);
    assert.equal(result.items.length,1);assert.equal(result.items[0].id,item.id);assert.equal(result.items[0].sequence,1);
    assert.equal(result.items[0].stage,'test-only');assert.equal(result.items[0].details.inputTokens,12);assert.equal(result.items[0].details.secret,'[REDACTED]');
    assert.equal(f.raw().source_record_json,raw);assert.equal(result.run.completed_at,'2026-10-21T12:00:00.000Z');
    assert.equal((await f.telemetry.loadRecentCatalogRuns(1))[0].id,RUN);
    await assert.rejects(f.telemetry.finishCatalogRun(RUN,{status:'failed'}),/finalized/);
    await assert.rejects(f.telemetry.insertCatalogRunItems(RUN,[catalogRunItem(product,{decision:'late'})]),/conflict/);
    assert.throws(()=>f.sqlite.prepare('DELETE FROM catalog_run_items').run(),/retained/);
    assert.throws(()=>f.sqlite.prepare("UPDATE catalog_runs SET source_record_json='{}'").run(),/immutable/);
    assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('lost start/append/finish responses recover immutable IDs/time and stale independent owners fail closed',async()=>{
  const f=await fixture();try{
    const stale=createD1CatalogMaintenanceStore({...f.options,ownerCursor:undefined});
    let lose=3;f.after(()=>{if(lose-->0)throw new Error('lost response');});
    await f.telemetry.startCatalogRun({id:RUN});
    const item=catalogRunItem(product,{decision:'failed'});await f.telemetry.insertCatalogRunItems(RUN,[item]);
    await f.telemetry.finishCatalogRun(RUN,{status:'failed'});
    assert.equal((await f.telemetry.loadCatalogRun(RUN)).items.length,1);
    assert.equal(f.raw().started_at,NOW);assert.equal(f.raw().completed_at,NOW);assert.equal(f.cursor.current.epoch,3);
    await assert.rejects(stale.upsertProduct(product,null),/fenced/);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM products').get().n,0);
  }finally{f.close();}
});

test('completion reads only its run summary when retained item history exceeds the REST response bound',async()=>{
  const f=await fixture();try{
    await f.telemetry.startCatalogRun({id:RUN});
    const insert=f.sqlite.prepare('INSERT INTO catalog_run_items(id,run_id,external_id,decision,requires_manual_review,created_at,source_record_json) VALUES(?,?,?,?,0,?,?)');
    for(let index=0;index<711;index++){
      const id=randomUUID();insert.run(id,RUN,product.id,'persisted',NOW,JSON.stringify({id,details:{note:'x'.repeat(900)}}));
    }
    const retained=()=>f.sqlite.prepare('SELECT count(*) n,sum(length(source_record_json)) bytes FROM catalog_run_items WHERE run_id=?').get(RUN);
    assert.ok(retained().bytes>512*1024);
    await f.telemetry.finishCatalogRun(RUN,{status:'completed',counts:{refreshed:291,admitted:17}});
    const original=f.db.prepare.bind(f.db);let itemReads=0;
    f.db.prepare=sql=>{
      if(/FROM catalog_run_items/.test(sql)){itemReads++;return{bind(){return this;},async all(){throw Error('synthetic_response_bound');}};}
      return original(sql);
    };
    const before=f.writes(),summary=await f.telemetry.loadCatalogRun(RUN,{items:false});
    assert.equal(summary.run.status,'completed');assert.deepEqual(summary.run.counts,{refreshed:291,admitted:17});
    assert.deepEqual(summary.items,[]);assert.equal(itemReads,0);assert.equal(f.writes(),before);
    assert.equal(retained().n,711,'all immutable per-item history is retained');
    await assert.rejects(f.telemetry.loadCatalogRun(RUN),/synthetic_response_bound/);
  }finally{f.close();}
});

test('receipt replay cannot refresh a stale cursor over unrelated same-owner mutations',async()=>{
  const f=await fixture();try{
    await f.telemetry.startCatalogRun({id:RUN});await f.maintenance.upsertProduct(product,null);
    const staleOptions={...f.options,owner:f.cursor.current,ownerCursor:undefined};
    const staleTelemetry=createD1CatalogTelemetryStore(staleOptions);const staleMaintenance=createD1CatalogMaintenanceStore(staleOptions);
    const item=catalogRunItem(product,{decision:'persisted'});await f.telemetry.insertCatalogRunItems(RUN,[item]);
    await f.maintenance.updateAmazonAffiliateUrl(product.id,product.affiliateUrl+'&test=1');
    await assert.rejects(staleTelemetry.insertCatalogRunItems(RUN,[item]),/fenced/);
    await assert.rejects(staleMaintenance.upsertProduct(product,null),/fenced/);
    const epoch=f.cursor.current.epoch;await f.telemetry.insertCatalogRunItems(RUN,[item]);await f.maintenance.upsertProduct(product,null);
    assert.equal(f.cursor.current.epoch,epoch);
  }finally{f.close();}
});

test('a concurrent fence change rolls back append, receipt and epoch advancement together',async()=>{
  const f=await fixture();try{
    await f.telemetry.startCatalogRun({id:RUN});const epoch=f.cursor.current.epoch;
    f.before(()=>{f.before(undefined);f.sqlite.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1');});
    await assert.rejects(f.telemetry.insertCatalogRunItems(RUN,[catalogRunItem(product)]),/conflict/);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_run_items').get().n,0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,1);
    assert.equal(f.sqlite.prepare('SELECT mutation_epoch epoch FROM catalog_mutation_scopes').get().epoch,epoch+1);
    assert.equal(f.cursor.current.epoch,epoch);
  }finally{f.close();}
});

test('explicit weekly phases keep50/40-10 policy inputs, six themes/max20/backfill25 and finalize after actual ownership handoff',async()=>{
  const f=await fixture();try{
    const phases=[];let finalStore;let publicationFinished=false;
    const output=await runWeeklyCatalogWithBackend({...f.backend,
      execute:async(options,_seeds,telemetry,store)=>{
        assert.equal(store,f.maintenance);phases.push(options);
        await store.upsertProduct({...product,price:phases.length},null);
        telemetry.items.record(product,{phase:options.revalidate?'revalidation':'discovery',decision:'persisted'});
        recordOpenAIUsage(telemetry.usage,{model:'text-embedding-3-small',operation:'test-only',usage:{prompt_tokens:10,total_tokens:10}});
        return options.revalidate?{selected:50,refreshed:1}:{inserted:1,themes:['test-only'],backfill:{selected:25}};
      },
      publish:async()=>{
        assert.equal(f.raw().status,'running');
        await releaseMutationOwnership(f.db,f.cursor.current);
        const frozen=await claimMutationOwnership(f.db,f.scope,{phase:'freezing',ownerReference:'test-only/freeze',operationKey:'e'.repeat(64)});
        assert.ok(frozen);await releaseMutationOwnership(f.db,frozen);
        const finalOwner=await claimMutationOwnership(f.db,f.scope,{phase:'writing',ownerReference:'test-only/finalize',operationKey:'f'.repeat(64)});
        finalStore=createD1CatalogTelemetryStore({...f.options,owner:finalOwner,ownerCursor:{current:finalOwner}});
        publicationFinished=true;return published;
      },
      finalizeRun:async(id,input)=>{assert.ok(publicationFinished);await finalStore.finishCatalogRun(id,input);return finalStore.loadCatalogRun(id);},
    });
    assert.equal(phases.length,2);assert.equal(phases[0].revalidateLimit,50);assert.equal(phases[0].staleDays,30);assert.equal(phases[0].deactivateAfterDays,90);
    assert.equal(phases[1].themeLimit,6);assert.equal(phases[1].perTheme,10);assert.equal(phases[1].maxNew,20);assert.equal(phases[1].backfillLimit,25);
    assert.equal(output.publication.status,'published');const result=await finalStore.loadCatalogRun(RUN);
    assert.equal(result.run.status,'completed');assert.equal(result.items.length,2);assert.equal(result.run.config.maxNew,20);
    assert.equal(result.run.usage.models['text-embedding-3-small'].inputTokens,20);
    assert.equal(result.run.counts.revalidation.selected,50);assert.equal(result.run.counts.discovery.backfill.selected,25);
    await assert.rejects(f.maintenance.updateAmazonAffiliateUrl(product.id,product.affiliateUrl),/fenced/);
  }finally{f.close();}
});

test('real executeCatalog injection needs no POSTGRES_URL, loads no PG driver and never invokes Vercel invalidation',async t=>{
  const previous=process.env.POSTGRES_URL;const tag=process.env.AMAZON_ASSOCIATE_TAG;delete process.env.POSTGRES_URL;process.env.AMAZON_ASSOCIATE_TAG='fixture-20';
  t.after(()=>{if(previous===undefined)delete process.env.POSTGRES_URL;else process.env.POSTGRES_URL=previous;if(tag===undefined)delete process.env.AMAZON_ASSOCIATE_TAG;else process.env.AMAZON_ASSOCIATE_TAG=tag;});
  const f=await fixture();const originalFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('network forbidden');};
  try{
    execFileSync(process.execPath,['--input-type=module','-e',`import fs from 'node:fs';
      const original=fs.existsSync;fs.existsSync=(path)=>{if(path==='/TEST-ONLY-NO-CREDENTIAL-BOOTSTRAP')throw new Error('credential bootstrap');return original(path);};
      await import('./scripts/ops/catalog-weekly.mjs');await import('./scripts/ops/prefetch-catalog.mjs');`],
    {env:{...process.env,AMAZON_CREATORS_CREDENTIALS_FILE:'/TEST-ONLY-NO-CREDENTIAL-BOOTSTRAP',AMAZON_CREATORS_CREDENTIAL_ID:'',AMAZON_CREATORS_CREDENTIAL_SECRET:'',AMAZON_CREATORS_CREDENTIAL_VERSION:''},stdio:'pipe'});
    const result=await runCatalogWithBackend([parseArgs(['--repair-affiliate-urls-only']),parseArgs(['--enrich-only','--backfill-limit','0'])],f.backend);
    assert.equal(result.results[0].affiliateAudit.repaired,0);assert.equal(f.raw().status,'completed');assert.equal(calls,0);
    assert.equal(Object.keys(createRequire(import.meta.url).cache).some(path=>path.includes('/@vercel/postgres/')),false);
    await assert.rejects(runCatalogWithBackend(parseArgs(['--enrich-only','--backfill-limit','0']),f.backend),/already exists/);
  }finally{globalThis.fetch=originalFetch;f.close();}
});

test('dry-run explicit catalog enrichment and discovery dedup need no PG env and perform no writes',async t=>{
  const previous=process.env.POSTGRES_URL;delete process.env.POSTGRES_URL;t.after(()=>{if(previous!==undefined)process.env.POSTGRES_URL=previous;});
  const f=await fixture();try{
    const existing={...product,title:'Ridiculous chicken desk toy',qualityScore:.95,editorialStatus:'manual_locked'};
    await f.maintenance.upsertProduct(existing,null);const before=f.writes();
    const output=await runCatalogWithBackend(parseArgs(['--dry-run','--enrich-only','--backfill-limit','25']),
      {...f.backend,publish:async()=>{throw new Error('dry publication');},finalizeRun:async()=>{throw new Error('dry finalization');}});
    assert.equal(output.results[0].backfill.selected,1);assert.equal(f.writes(),before);assert.equal(f.raw().id,undefined);assert.equal(output.publication,null);
    const search=amazonCreators.searchItems;amazonCreators.searchItems=async()=>[{...existing,id:'B000000002',availabilityStatus:'IN_STOCK',remotelyVerified:true}];
    try{
      const discovery=await runCatalogWithBackend(parseArgs(['--dry-run','--theme-limit','1','--per-theme','1','--max-new','1','--min-quality-score','0.1','--backfill-limit','0']),f.backend);
      assert.equal(discovery.results[0].catalogDuplicates,1);assert.equal(f.writes(),before);
    }finally{amazonCreators.searchItems=search;}
  }finally{f.close();}
});

test('provider/phase failures preserve usage/items and cannot mark completed; accepted dispatch is not publication',async()=>{
  for(const invalidPublication of [false,true]){
    const f=await fixture();try{
      const execute=async(_options,_seeds,telemetry)=>{
        telemetry.items.record(product,{phase:'test-only',decision:'failed'});
        recordOpenAIUsage(telemetry.usage,{model:'gpt-4o-mini',operation:'test-only',usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}});
        if(!invalidPublication)throw new Error('secret=DO_NOT_KEEP');return {inserted:1};
      };
      await assert.rejects(runCatalogWithBackend(parseArgs(['--enrich-only']),{...f.backend,execute,publish:async()=>({status:'dispatched'})}));
      const saved=await f.telemetry.loadCatalogRun(RUN);assert.equal(saved.run.status,invalidPublication?'partial':'failed');
      assert.equal(saved.items.length,1);assert.equal(saved.run.usage.models['gpt-4o-mini'].totalTokens,15);
      assert.doesNotMatch(JSON.stringify(saved),/DO_NOT_KEEP/);
    }finally{f.close();}
  }
});

test('item accounting failure and uncertain ownership/finalizer failure stay visible, not false completion',async()=>{
  const f=await fixture();try{
    const attempted=[];const store={...f.telemetry,insertCatalogRunItems:async(_id,items)=>{attempted.push(items);throw new Error('test-only item failure');}};
    let publishedCalls=0;let failure;
    await assert.rejects(runCatalogWithBackend(parseArgs(['--enrich-only']),{...f.backend,telemetryStore:store,
      execute:async(_options,_seeds,telemetry)=>{telemetry.items.record({...product,title:'TEST ONLY secret=DO_NOT_KEEP'},{decision:'persisted',details:{secret:'DO_NOT_KEEP'}});return {inserted:1};},
      publish:async()=>{publishedCalls++;return published;}}),error=>{failure=error;return /accounting/.test(error.message);});
    assert.equal(publishedCalls,0);assert.equal(f.raw().status,'partial');
    const warnings=(await f.telemetry.loadCatalogRun(RUN)).run.warnings;
    assert.equal(warnings[0].reasonCode,'run_item_insert_failed');assert.equal(warnings.at(-1).pendingCount,1);
    assert.deepEqual(failure.catalogRunRecovery,{runId:RUN,pendingItems:attempted.at(-1)});
    assert.equal(Object.keys(failure).includes('catalogRunRecovery'),false);assert.doesNotMatch(JSON.stringify(failure.catalogRunRecovery),/DO_NOT_KEEP/);
    const pending=failure.catalogRunRecovery.pendingItems;assert.match(pending[0].id,/^[a-f0-9-]{36}$/i);
    await f.telemetry.insertCatalogRunItems(RUN,pending);await f.telemetry.insertCatalogRunItems(RUN,pending);
    assert.equal((await f.telemetry.loadCatalogRun(RUN)).items[0].id,pending[0].id);assert.equal(f.raw().status,'partial');
  }finally{f.close();}
  const g=await fixture();try{
    await assert.rejects(runCatalogWithBackend(parseArgs(['--enrich-only']),{...g.backend,execute:async()=>({inserted:0}),
      publish:async()=>{await releaseMutationOwnership(g.db,g.cursor.current);return published;},
      finalizeRun:async(id,input)=>{await g.telemetry.finishCatalogRun(id,input);return g.telemetry.loadCatalogRun(id);}}),AggregateError);
    assert.equal(g.raw().status,'running');
  }finally{g.close();}
});

test('imported history is read losslessly and cannot be silently finalized; append cannot overwrite IDs or cross runs',async()=>{
  const f=await fixture({applyTelemetry:false});try{
    const raw='{"id":"history","status":"completed","mode":"old","dry_run":false,"started_at":"2025-01-01 00:00:00+00","config":"{}"}';
    f.sqlite.prepare("INSERT INTO catalog_runs(id,status,mode,dry_run,started_at,completed_at,source_record_json) VALUES('history','completed','old',0,?,NULL,?)").run('2025-01-01T00:00:00.000000Z',raw);
    const before=f.sqlite.prepare('SELECT rowid,* FROM catalog_runs').all();
    f.sqlite.exec(await readFile(new URL('../migrations/d1/0012_catalog_run_telemetry.sql',import.meta.url),'utf8'));
    assert.deepEqual(f.sqlite.prepare('SELECT rowid,* FROM catalog_runs').all(),before);
    assert.equal((await f.telemetry.loadCatalogRun('history')).run.config instanceof Object,true);
    const historical=createD1CatalogTelemetryStore({...f.options,runId:'history'});
    await assert.rejects(historical.finishCatalogRun('history',{status:'failed'}),/finalized/);
    assert.equal(f.sqlite.prepare("SELECT source_record_json FROM catalog_runs WHERE id='history'").get().source_record_json,raw);
    await f.telemetry.startCatalogRun({id:RUN});
    await assert.rejects(f.telemetry.insertCatalogRunItems('different',[]),/bound/);
    await assert.rejects(f.telemetry.insertCatalogRunItems(RUN,[{id:'not-an-immutable-uuid'}]),/identity/);
    const items=Array.from({length:51},(_,index)=>catalogRunItem({...product,id:`test-${index}`},{decision:'persisted'}));
    const batches=f.writes();await f.telemetry.insertCatalogRunItems(RUN,items);assert.equal(f.writes()-batches,3);
    assert.equal((await f.telemetry.loadCatalogRun(RUN)).items.length,51);
    assert.equal(f.sqlite.prepare('SELECT max(sequence) maximum FROM catalog_run_items').get().maximum,51);
    assert.match(items[0].id,/^[a-f0-9-]{36}$/i);
    await assert.rejects(f.telemetry.insertCatalogRunItems(RUN,[{...catalogRunItem(product),title:'x'.repeat(100*1024)}]),/bounds/);
  }finally{f.close();}
});
