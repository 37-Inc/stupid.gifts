import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import amazonCreators from '../lib/amazon-creators.js';
import { deduplicateAgainstCatalog } from '../scripts/ops/prefetch-catalog.mjs';
import { dailyCatalogExecutor, dailyCatalogPhases, pacificCatalogCalendar, runDailyCatalogWithBackend, runNeonDailyCatalog, withCatalogCadence } from '../scripts/ops/catalog-daily.mjs';
import { createPostgresCatalogMaintenanceStore } from '../scripts/ops/catalog-maintenance-postgres.mjs';

const NOW = '2026-10-21T18:00:00.000Z', MONDAY = '2026-10-19T18:00:00.000Z';
const id = n => `B${String(n).padStart(9, '0')}`;
async function fixture(t, now = () => NOW) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'goose-daily-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { workspace: join(directory, 'private'), repository: process.cwd(), now };
}
function telemetry() {
  let saved;
  return { async loadCatalogRun() { return saved ? { run: saved } : null; }, async startCatalogRun(run) { saved = run; },
    async finishCatalogRun(id, run) { saved = { id, ...run }; }, async insertCatalogRunItems() {}, async loadRecentCatalogRuns() { return []; } };
}

test('Pacific calendar handles UTC-Monday, DST transitions and week/year boundaries', () => {
  assert.deepEqual(pacificCatalogCalendar('2026-10-19T06:59:59Z'), { day: '2026-10-18', week: '2026-10-12', monday: false });
  assert.deepEqual(pacificCatalogCalendar('2026-10-19T07:00:00Z'), { day: '2026-10-19', week: '2026-10-19', monday: true });
  for (const instant of ['2026-11-01T08:30:00Z', '2026-11-01T09:30:00Z']) assert.equal(pacificCatalogCalendar(instant).day, '2026-11-01');
  for (const instant of ['2026-03-08T09:59:59Z', '2026-03-08T10:00:00Z']) assert.equal(pacificCatalogCalendar(instant).day, '2026-03-08');
  assert.deepEqual(pacificCatalogCalendar('2027-01-01T12:00:00Z'), { day: '2027-01-01', week: '2026-12-28', monday: false });
});

test('legacy day reservations remain immutable after provider failure', async t => {
  for (const message of ['provider_failed', 'unknown_response']) {
    const options = await fixture(t);
    await withCatalogCadence(options, async cadence => {
      assert.equal((await cadence.plan()).daily, true);
      const execute = dailyCatalogExecutor(cadence, async () => { throw new Error(message); });
      await assert.rejects(execute((await dailyCatalogPhases(cadence))[0], undefined, { runId: 'first-run' }, {}), new RegExp(message));
    });
    await withCatalogCadence(options, async cadence => assert.deepEqual(await dailyCatalogPhases(cadence), []));
    const receipt = JSON.parse(await readFile(join(options.workspace, 'cadence/daily-2026-10-21.json'), 'utf8'));
    assert.equal(receipt.maximumExisting, 10); assert.equal(receipt.runId, 'first-run');
  }
});

test('legacy configurations retain their original daily and weekly reservation policy', async t => {
  let time = MONDAY;
  const options = await fixture(t, () => time);
  await withCatalogCadence(options, async cadence => {
    const phases = await dailyCatalogPhases(cadence, [id(7)]);
    assert.equal(phases.length, 2);
    assert.deepEqual(phases.map(p => p.backfillLimit), [0, 0]);
    assert.equal(phases[0].revalidateLimit, 10); assert.equal(phases[0].skipEnrichment, true);
    assert.equal(phases[0].enrichSelectedExisting, true);
    assert.equal(phases[1].discoveryNewOnly, true);
    assert.equal(phases[1].themeLimit, 6); assert.equal(phases[1].perTheme, 10); assert.equal(phases[1].maxNew, 20); assert.equal(phases[1].minQualityScore, .65);
    await cadence.reserve('daily', 'monday'); await cadence.reserve('discovery', 'monday');
    assert.deepEqual(await dailyCatalogPhases(cadence), []);
  });
  time = '2026-10-20T06:59:59Z'; // still Monday, not UTC Tuesday
  await withCatalogCadence(options, async cadence => assert.deepEqual(await dailyCatalogPhases(cadence), []));
  time = '2026-10-20T07:00:00Z';
  await withCatalogCadence(options, async cadence => assert.deepEqual((await dailyCatalogPhases(cadence)).map(p => p.dailyRefresh), [true]));
  time = '2026-10-26T18:00:00Z';
  await withCatalogCadence(options, async cadence => assert.equal((await dailyCatalogPhases(cadence)).length, 2));
});
test('new run reservations allow multiple same-day batches without repeating a failed run', async t => {
  const options = await fixture(t, () => MONDAY);
  await withCatalogCadence(options, async cadence => {
    await cadence.reserve('daily', 'historical');
    await cadence.reserve('discovery', 'historical');
  });
  for (const runKey of ['first-run', 'second-run']) {
    const invocation = { ...options, runKey };
    await withCatalogCadence(invocation, async cadence => {
      const phases = await dailyCatalogPhases(cadence);
      assert.equal(phases.length, 2);
      assert.equal(phases[0].revalidateLimit, 10);
      assert.equal(phases[1].maxNew, 20);
      assert.equal(phases[1].discoveryRunKey, runKey);
      const execute = dailyCatalogExecutor(cadence, async () => { throw new Error('unknown_response'); });
      await assert.rejects(execute(phases[0], undefined, { runId: runKey }, {}), /unknown_response/);
      await cadence.reserve('discovery', runKey);
    });
    await withCatalogCadence(invocation, async cadence => assert.deepEqual(await dailyCatalogPhases(cadence), []));
    const receipt = JSON.parse(await readFile(join(options.workspace, `cadence/daily-run-${runKey}.json`), 'utf8'));
    assert.equal(receipt.key, runKey);
    assert.equal(receipt.runId, runKey);
  }
  const original = JSON.parse(await readFile(join(options.workspace, 'cadence/daily-2026-10-19.json'), 'utf8'));
  assert.equal(original.runId, 'historical');
});

test('photo-only Monday care refreshes photos without discovery or text/embedding generation',async t=>{
  const options=await fixture(t,()=>MONDAY);
  await withCatalogCadence({...options,runKey:'evening-photos'},async cadence=>{
    const phases=await dailyCatalogPhases(cadence,[id(7)],true);
    assert.equal(phases.length,1);
    assert.equal(phases[0].photosOnly,true);
    assert.equal(phases[0].skipEnrichment,true);
    assert.equal(phases[0].enrichSelectedExisting,false);
    assert.equal(phases[0].revalidateLimit,10);
    await cadence.reserve('daily','evening-photos');
    assert.deepEqual(await dailyCatalogPhases(cadence,[],true),[]);
  });
});

test('per-run reservation identity rejects path traversal, wrong IDs and overlapping owners', async t => {
  const options = await fixture(t, () => MONDAY);
  for (const runKey of ['', '../escape', 'with/slash', 'a'.repeat(97)])
    await assert.rejects(withCatalogCadence({ ...options, runKey }, () => {}), /cadence_run_key_invalid/);
  await withCatalogCadence({ ...options, runKey: 'one' }, async cadence => {
    await assert.rejects(cadence.reserve('daily', 'two'), /cadence_reservation_invalid/);
    await assert.rejects(withCatalogCadence({ ...options, runKey: 'two' }, () => {}), /cadence_owner_busy_requires_review/);
  });
});

test('only the D1 permanent-listing backend disables legacy missing-age deactivation',async t=>{
  const options=await fixture(t);
  await withCatalogCadence(options,async cadence=>{
    assert.equal((await dailyCatalogPhases(cadence))[0].deactivateMissing,true);
    await assert.rejects(runDailyCatalogWithBackend({cadence,preservePermanentListings:true,runId:'d1-only',gitSha:'fixture',
      maintenanceStore:{},telemetryStore:telemetry(),async publish(){assert.fail('unexpected publication');},
      async finalizeRun(id,input){return{run:{id,status:input.status}};},
      async execute(phase){assert.equal(phase.deactivateMissing,false);throw new Error('test_stopped_before_provider');}}),/test_stopped_before_provider/);
  });
});

test('overlapping owners, damaged reservations and clock-crossed requests fail closed', async t => {
  let time = NOW;
  const options = await fixture(t, () => time);
  await withCatalogCadence(options, async cadence => {
    await assert.rejects(withCatalogCadence(options, async () => {}), /cadence_owner_busy_requires_review/);
    time = '2026-10-22T07:00:00Z';
    assert.throws(() => cadence.assertDay(), /cadence_day_changed/);
    await assert.rejects(cadence.reserve('daily', 'late'), /cadence_day_changed/);
  });
  time = NOW;
  await writeFile(join(options.workspace, 'cadence/daily-2026-10-21.json'), '{damaged', { mode: 0o600 });
  await assert.rejects(withCatalogCadence(options, cadence => cadence.plan()));
});

test('dry-run has no cadence, DB, Amazon, model, cache or telemetry writes', async t => {
  const options = await fixture(t);
  const before = await readdir(new URL('..', import.meta.url));
  const result = await withCatalogCadence({ ...options, dryRun: true }, async cadence => ({ dryRun: cadence.dryRun, calendar: cadence.calendar }));
  assert.equal(result.dryRun, true);
  await assert.rejects(readFile(join(options.workspace, 'cadence/owner.lock')), { code: 'ENOENT' });
  const command = spawnSync(process.execPath, ['scripts/ops/catalog-daily.mjs', '--backend', 'neon', '--no-notify', '--dry-run'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(command.status, 0, command.stderr);
  const receipt = JSON.parse(command.stdout);
  assert.equal(receipt.state, 'dry_run'); assert.equal(receipt.providerCalls, 0); assert.equal(receipt.writes, 0);
  assert.deepEqual(await readdir(new URL('..', import.meta.url)), before);
});

test('actual daily execution uses one <=10 GetItems response and evidence hook, no discovery/models/global repairs', async t => {
  const options = await fixture(t), calls = [], writes = [], captured = [];
  const rows = Array.from({ length: 10 }, (_, n) => ({ id: id(n), slug: `fixture-${n}`, title: `TEST ONLY brass bell ${n}`, price: 12,
    currency: 'USD', image_url: 'https://example.invalid/image.jpg', source_facts: {}, humor_tags: [], last_verified_at: null }));
  t.mock.method(amazonCreators, 'getItems', async ids => { calls.push(ids); return ids.map(asin => ({ id: asin, title: 'TEST ONLY brass bell', price: 12,
    imageUrl: 'https://example.invalid/image.jpg', affiliateUrl: `https://www.amazon.com/dp/${asin}?tag=fixture-20`, availabilityStatus: 'IN_STOCK', remotelyVerified: true })); });
  t.mock.method(amazonCreators, 'searchItems', () => { throw new Error('Daily discovery forbidden'); });
  const store = { async getProductsForRevalidation(selection) { assert.equal(selection.daily, true); assert.equal(selection.limit, 10); return rows; },
    async upsertProduct(p) { writes.push(p.id); return { inserted: false, slug: 'same' }; },
    async markConfirmedMissingUnavailable(ids) { return ids; }, async deactivateConfirmedMissing(ids) { return ids; },
    async getAffiliateUrlMismatches() { throw new Error('Global repair forbidden'); } };
  const evidence = { async amazon(operation, load, normalize) { assert.equal(operation, 'getItems'); const response = await load(); captured.push(response); return response.map(normalize); },
    async embeddings() { assert.fail('No daily embeddings'); } };
  await withCatalogCadence(options, async cadence => {
    const result = await runNeonDailyCatalog({ cadence, maintenanceStore: store, telemetryStore: telemetry(), providerEvidence: evidence,
      invalidate: async () => ({ ok: true }) });
    assert.equal(result.state, 'maintenance_complete'); assert.equal(result.publication.status, 'unverified');
    assert.equal((await runNeonDailyCatalog({ cadence })).state, 'skipped');
  });
  assert.equal(calls.length, 1); assert.equal(captured.length, 1); assert.equal(writes.length, 10);
});

test('clock crossing after response prevents mutations and consumes reservation', async t => {
  let time = '2026-10-22T06:59:59Z';
  const options = await fixture(t, () => time);
  t.mock.method(amazonCreators, 'getItems', async () => { time = '2026-10-22T07:00:00Z'; return [{ id: id(1), title: 'TEST ONLY', imageUrl: 'https://example.invalid/a', availabilityStatus: 'IN_STOCK' }]; });
  let writes = 0;
  await assert.rejects(withCatalogCadence(options, cadence => runNeonDailyCatalog({ cadence, telemetryStore: telemetry(), maintenanceStore: {
    async getProductsForRevalidation() { return [{ id: id(1), title: 'TEST ONLY' }]; }, async upsertProduct() { writes++; },
  } })), /cadence_day_changed/);
  assert.equal(writes, 0);
  time = '2026-10-22T06:59:59Z';
  await withCatalogCadence(options, async cadence => assert.equal((await cadence.plan()).daily, false));
});

test('actual Amazon client checks the day after OAuth and before its internal 401 retry',async t=>{
  const previous={...process.env};
  for(const [key,value]of Object.entries({AMAZON_CREATORS_CREDENTIAL_ID:'TEST_ONLY_ID',AMAZON_CREATORS_CREDENTIAL_SECRET:'TEST_ONLY_SECRET',
    AMAZON_CREATORS_CREDENTIAL_VERSION:'2.1',AMAZON_ASSOCIATE_TAG:'fixture-20'}))process.env[key]=value;
  t.after(()=>{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);amazonCreators.clearToken();});
  for(const mode of ['oauth','retry']){
    amazonCreators.clearToken();let tokens=0,requests=0;
    t.mock.method(globalThis,'fetch',async url=>{
      if(String(url).endsWith('/getItems')){requests++;return new Response('',{status:401});}
      tokens++;return Response.json({access_token:'TEST_ONLY_TOKEN',expires_in:3600});
    });
    await assert.rejects(amazonCreators.getItems([id(1)],{beforeRequest(){
      if(mode==='oauth'||tokens===2)throw new Error('cadence_day_changed');
    }}),/cadence_day_changed/);
    assert.equal(requests,mode==='oauth'?0:1);assert.equal(tokens,mode==='oauth'?1:2);
    t.mock.restoreAll();
  }
});

test('discovery rejects same-ASIN and old families instead of refreshing or superseding existing products', () => {
  const old = [{ id: id(1), title: 'TEST ONLY funny brass lobster desk bell', qualityScore: .5 }, { id: id(2), title: 'unrelated title' }];
  const result = deduplicateAgainstCatalog([{ id: id(1), title: 'renamed same ASIN', qualityScore: 1 },
    { id: id(3), title: old[0].title, qualityScore: 1 }, { id: id(4), title: 'Synthetic entirely different spaghetti chandelier', qualityScore: 1 }], old, .8, true);
  assert.deepEqual(result.products.map(p => p.id), [id(4)]); assert.deepEqual(result.superseded, []);
});

test('inactive identities and unreserved IDs cannot be mutated through the discovery or daily store', async t => {
  const options = await fixture(t, () => MONDAY); let writes = 0;
  await withCatalogCadence(options, async cadence => {
    await cadence.reserve('daily', 'already');
    const phase = (await dailyCatalogPhases(cadence))[0];
    await assert.rejects(dailyCatalogExecutor(cadence, async (_o, _s, _t, store) => store.upsertProduct({ id: id(9) }))(
      phase, undefined, { runId: 'discovery' }, { async getActiveCatalogIdentities(options) { assert.equal(options.includeInactive, true); return [{ id: id(9) }]; },
        async upsertProduct() { writes++; } }), /discovery_existing_mutation_forbidden/);
    assert.deepEqual(await dailyCatalogPhases(cadence), []);
  });
  assert.equal(writes, 0);
});

test('oversized daily selection fails before the merchant request and discovery cannot insert a 21st product',async t=>{
  let requests=0,writes=0;
  t.mock.method(amazonCreators,'getItems',async()=>{requests++;return[];});
  const daily=await fixture(t);
  await assert.rejects(withCatalogCadence(daily,cadence=>runNeonDailyCatalog({cadence,telemetryStore:telemetry(),maintenanceStore:{
    async getProductsForRevalidation(){return Array.from({length:11},(_,n)=>({id:id(n)}));},
  }})),/daily_selection_invalid/);
  assert.equal(requests,0);
  const monday=await fixture(t,()=>MONDAY);
  await withCatalogCadence(monday,async cadence=>{
    await cadence.reserve('daily','already');
    const phase=(await dailyCatalogPhases(cadence))[0];
    const execute=dailyCatalogExecutor(cadence,async(_o,_s,_t,store)=>{
      for(let n=0;n<21;n++)await store.upsertProduct({id:id(n)});
    });
    await assert.rejects(execute(phase,undefined,{runId:'bounded-discovery'},{async getActiveCatalogIdentities(){return[];},
      async upsertProduct(){writes++;return{inserted:true};}}),/discovery_existing_mutation_forbidden/);
  });
  assert.equal(writes,20);
});

test('actual Monday discovery deduplicates inactive same-ASIN candidates before models or persistence',async t=>{
  const options=await fixture(t,()=>MONDAY);let searches=0,writes=0;
  const product={id:id(9),title:'TEST ONLY ridiculous brass lobster desk bell',price:20,currency:'USD',
    imageUrl:'https://example.invalid/lobster.jpg',affiliateUrl:`https://www.amazon.com/dp/${id(9)}?tag=fixture-20`,
    qualityScore:.99,isActive:true,source:'amazon',availabilityStatus:'IN_STOCK',sourceFacts:{material:'brass'},remotelyVerified:true};
  t.mock.method(amazonCreators,'searchItems',async()=>{searches++;return[product];});
  await withCatalogCadence(options,async cadence=>{
    await cadence.reserve('daily','already-refreshed');
    const result=await runNeonDailyCatalog({cadence,telemetryStore:telemetry(),invalidate:async()=>({ok:true}),maintenanceStore:{
      async getActiveCatalogIdentities(options){assert.equal(options.includeInactive,true);return[{id:product.id,title:product.title}];},
      async getExistingEditorialWriteups(){return[];},async upsertProduct(){writes++;throw new Error('Existing mutation forbidden');},
    }});
    assert.equal(result.state,'maintenance_complete');
    assert.deepEqual(await dailyCatalogPhases(cadence),[]);
  });
  assert.equal(searches,6);assert.equal(writes,0);
});

test('daily Postgres selection is bounded and prioritizes featured then published before old legacy rows', async () => {
  const calls = [];
  const store = createPostgresCatalogMaintenanceStore({ query: async (...args) => { calls.push(args); return { rows: [] }; } });
  await store.getProductsForRevalidation({ daily: true, limit: 10, featuredIds: [id(9)] });
  assert.deepEqual(calls[0][1], [10, [id(9)]]); assert.match(calls[0][0], /CASE WHEN id = ANY\(\$2::text\[\]\) THEN 0/);
  assert.match(calls[0][0], /THEN 1 ELSE 2 END/); assert.match(calls[0][0], /LIMIT \$1/);
  assert.match(calls[0][0], /\(embedding IS NOT NULL\) AS has_embedding/);
  await store.getActiveCatalogIdentities({ includeInactive: true }); assert.equal(calls[1][0], 'SELECT id, title FROM products');
});
