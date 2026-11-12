import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createReviewedPhaseJournal, prepareReviewedPhase, applyReviewedPhase, reconcileReviewedPhaseOwner } from '../scripts/catalog/reviewed-provider-phases.mjs';
import { automatedCatalogPhases, automatedCatalogExecutor, exactProductAdmissionPhase, validateCatalogAutomation } from '../scripts/ops/catalog-daily.mjs';
import { createEditorialStages } from '../scripts/catalog/catalog-editorial.mjs';
import { createCatalogProviderEvidence } from '../scripts/catalog/provider-evidence.ts';
import { createD1CatalogMaintenanceStore, createD1CatalogPreparationStore } from '../scripts/catalog/maintenance-d1.ts';
import { createD1CatalogTelemetryStore } from '../scripts/catalog/telemetry-d1.ts';
import { claimMutationOwnership, readMutationOwner } from '../lib/catalog/mutation-fence.ts';
import { maintenanceDigest } from '../scripts/catalog/maintenance-state.ts';
import { maintenanceEmbeddingText } from '../scripts/catalog/maintenance-state.ts';
import { canonicalJson, sha256 } from '../scripts/catalog/migration.ts';
import { editorialSourceHash } from '../scripts/ops/catalog-editorial-core.mjs';
import { decodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';
import { executeCatalog,parseArgs } from '../scripts/ops/prefetch-catalog.mjs';
import {prepareCatalogProducts} from '../scripts/catalog/prepare-products.mjs';

const NOW = '2026-11-06T20:00:00.000Z', LATER = '2026-11-06T21:00:00.000Z';
const id = n => `B${String(n).padStart(9, '0')}`;
const product = { id: id(1), title: 'TEST ONLY brass lobster bell', source: 'amazon', sourceFacts: { shape: 'lobster', material: 'brass' },
  price: 20, currency: 'USD', humorTags: ['lobster'],
  wittyDescription: 'A small brass lobster bell for a desktop.', imageUrl: 'https://example.invalid/bell.jpg',
  affiliateUrl: `https://www.amazon.com/dp/${id(1)}?tag=fixture-20`, availabilityStatus: 'IN_STOCK', isActive: true,
  editorialStatus: 'short_ready', editorialQualityScore: .95, remotelyVerified: true, qualityScore: .8 };

test('one-off admission is one shared short-copy phase, never unrelated discovery or refresh', async () => {
  const options = exactProductAdmissionPhase([id(1), id(2)]);
  assert.equal(options.longEditorial, false);
  assert.equal(options.backfillLimit, 0);
  assert.deepEqual(options.admitAsins, [id(1), id(2)]);
  const calls = [];
  await automatedCatalogExecutor(async (_o, _s, _t, store) => {
    await store.upsertProduct({ id: id(1) });
    await assert.rejects(store.upsertProduct({ id: id(3) }), /existing_mutation_forbidden/);
    await assert.rejects(store.upsertProduct({ id: id(2) }), /existing_mutation_forbidden/);
  })(options, null, {}, { async getActiveCatalogIdentities() { return [{ id: id(2), isActive: false }]; },
    async upsertProduct(p) { calls.push(p.id); return { inserted: true }; } });
  assert.deepEqual(calls, [id(1)]);
});
function memory() {
  const objects = new Map(); let head, failure;
  const put = async value => { const ref = { sha256: sha256(canonicalJson(value)), reference: `fixture/${sha256(canonicalJson(value))}` }; objects.set(ref.reference, structuredClone(value)); return ref; };
  const read = async ref => structuredClone(objects.get(ref.reference));
  const journal = () => createReviewedPhaseJournal({ initial: head, read, put, save: async next => { head = structuredClone(next); if (failure) { failure = false; throw Error('test_only_runner_terminated'); } } });
  return { objects, journal, put, read, failOnce() { failure = true; }, get head() { return structuredClone(head); } };
}

test('shared preparation restores evidence before use and saved exact additions never repeat providers or models', async () => {
  const saved=memory(),phases=[exactProductAdmissionPhase([id(1)])],events=[];
  let executions=0,modelCalls=0;
  const run=journal=>prepareCatalogProducts({phases,runId:'staff-exact',journal,
    evidence:{async restoreReceipt(){events.push('restore');},intent(){return {};},async amazon(){throw Error('test_only_unexpected_supplier');}},
    store:{async getActiveCatalogIdentities(){return [];},async getProductSourceVersions(){return {}; }},
    execute:async(options,_seed,_telemetry,store)=>{executions++;assert.equal(options.discoveryEditor,undefined);
      assert.equal(options.longEditorial,false);assert.equal(events.at(-1),'restore');
      await store.upsertProduct({...product},editorialSourceHash(product));return {inserted:1};},
    complete:async()=>{modelCalls++;throw Error('test_only_unexpected_admission_model');},now:()=>NOW,
    progress:value=>{assert.equal(value.totalPhases,1);assert.ok(Number.isSafeInteger(value.elapsedMs));}});
  const journal=saved.journal();await journal.receipt(await saved.put({fixture:'original-observation'}));
  const first=await run(journal),second=await run(saved.journal());
  assert.deepEqual(second,first);assert.equal(executions,1);assert.equal(modelCalls,0);
  assert.deepEqual(events,['restore','restore']);
  assert.deepEqual(first[0].mutations[0].intent.expectedSourceById,{[id(1)]:null});
});
async function sqliteFixture(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  for (const name of (await readdir(new URL('../migrations/d1/', import.meta.url))).filter(n => /^\d{4}.*\.sql$/.test(n)).sort())
    sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`, import.meta.url), 'utf8'));
  sqlite.function('strftime', { varargs: true }, () => NOW);
  const db = { prepare(sql) { let params = []; return { bind(...values) { params = values; return this; }, async all() { return { results: sqlite.prepare(sql).all(...params).map(row => ({ ...row })) }; }, async run() { return sqlite.prepare(sql).run(...params); } }; },
    async batch(statements) { sqlite.exec('BEGIN'); try { for (const s of statements) await s.all(); sqlite.exec('COMMIT'); } catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  const scope = { environment: 'staging', indexName: 'fixture' };
  sqlite.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment, scope.indexName);
  const owner = await claimMutationOwnership(db, scope, { phase: 'writing', ownerReference: 'fixture', operationKey: 'a'.repeat(64) });
  return { sqlite, db, scope, owner };
}

test('only the explicit successor pin creates exact refresh chunks and daily reviewed discovery', async () => {
  const ids = Array.from({ length: 100 }, (_, n) => id(n + 1)), policy = { schemaVersion: 1, refreshIds: ids, discovery: true };
  const phases = automatedCatalogPhases(policy, { runId: 'captured-run' });
  assert.equal(phases.length, 11); assert.deepEqual(phases.slice(0, 10).flatMap(p => p.selectedIds), ids);
  assert.ok(phases.slice(0, 10).every(p => p.revalidateLimit === 10 && p.skipEnrichment && !p.enrichSelectedExisting && !p.deactivateMissing));
  assert.equal(phases[10].discoveryRunKey, 'captured-run'); assert.equal(phases[10].themeLimit, 6); assert.equal(phases[10].perTheme, 10);
  for (const value of [{ ...policy, extra: true }, { ...policy, refreshIds: [id(1), id(1)] }, { ...policy, discovery: 1 },
    { ...policy, refreshIds: [1234567890] }, { ...policy, refreshIds: Array(10001).fill(id(1)) }]) assert.throws(() => validateCatalogAutomation(value), /automation_invalid/);
  assert.throws(() => automatedCatalogPhases(policy, { runId: 'captured-run', photosOnly: true }), /automation_invalid/);
});

test('successor firewall neither substitutes exact refresh IDs nor imposes the old twentieth-admission cutoff', async () => {
  const options = automatedCatalogPhases({ schemaVersion: 1, refreshIds: [id(1), id(2)], discovery: false }, { runId: 'fixture' })[0];
  let selected;
  const store = { async getProductsForRevalidation(selection) { selected = selection; return selection.selectedIds.map(id => ({ id })); },
    async getActiveCatalogIdentities() { return [{ id: id(99) }]; }, async upsertProduct() { return { inserted: true }; } };
  await automatedCatalogExecutor(async (_options, _seed, _telemetry, bounded) => { assert.equal((await bounded.getProductsForRevalidation({ daily: true, limit: 2 })).length, 2);
    await bounded.upsertProduct({ id: id(2) }); await assert.rejects(bounded.upsertProduct({ id: id(3) }), /unpinned/); })(options, null, {}, store);
  assert.deepEqual(selected.selectedIds, [id(1), id(2)]);
  await assert.rejects(automatedCatalogExecutor(async (_o, _s, _t, bounded) => bounded.getProductsForRevalidation({}))(options, null, {},
    { ...store, async getProductsForRevalidation() { return [{ id: id(1) }]; } }), /selection_changed/);
  const discovery = automatedCatalogPhases({ schemaVersion: 1, refreshIds: [], discovery: true }, { runId: 'fixture' })[0];
  await automatedCatalogExecutor(async (_o, _s, _t, bounded) => {
    for (let n = 1; n <= 31; n++) await bounded.upsertProduct({ id: id(n) });
    await assert.rejects(bounded.upsertProduct({ id: id(99) }), /existing_mutation/);
    await assert.rejects(bounded.deactivateConfirmedMissing([]), /deletion_forbidden/);
  })(discovery, null, {}, store);
});

test('saved provider/model stages hydrate original evidence and aggregate actual usage once across restarts', async () => {
  const saved = memory(); let journal = saved.journal(), calls = 0;
  const receipts = new Map();
  const evidence = createCatalogProviderEvidence({ now: () => NOW,
    saveReceipt: async input => { const ref = await saved.put(input.receipt); receipts.set(ref.reference, input.receipt); await journal.receipt(ref); return ref; } });
  let stages = createEditorialStages({ read: key => journal.read(key), put: (key, value) => journal.put(key, value), now: () => NOW });
  const collect = () => stages.run('refresh-collect', { ids: [product.id], call: 0 }, () => evidence.amazon('getItems', async () => { calls++; return [product]; }, undefined, [product.id]));
  await collect();
  await stages.run('copy-draft', { fixture: true }, async () => { calls++; return { model: 'gpt-6-luna', usage: { prompt_tokens: 12, completion_tokens: 3 } }; });
  journal = saved.journal();
  const restored = createCatalogProviderEvidence({ now: () => LATER, readReceipt: saved.read, saveReceipt: async () => { throw Error('renewal_forbidden'); } });
  await journal.restore(restored);
  stages = createEditorialStages({ read: key => journal.read(key), put: (key, value) => journal.put(key, value), now: () => LATER });
  await stages.run('refresh-collect', { ids: [product.id], call: 0 }, () => { throw Error('must_not_fetch'); });
  await stages.run('copy-draft', { fixture: true }, () => { throw Error('must_not_generate'); });
  const intent = restored.intent('upsertProduct', [product, editorialSourceHash(product)]);
  assert.equal(Date.parse(intent.verificationById[product.id].observedAt), Date.parse(NOW)); assert.equal(calls, 2);
  assert.equal((await journal.usage()).models['gpt-6-luna'].requests, 1);
  assert.equal((await journal.usage()).models['gpt-6-luna'].totalTokens, 15);
  await assert.rejects(stages.run('embedding', { fixture: true }, async () => { throw Error('lost_provider_ack'); }), /dispatch_uncertain/);
  journal = saved.journal(); stages = createEditorialStages({ read: key => journal.read(key), put: (key, value) => journal.put(key, value) });
  await assert.rejects(stages.run('embedding', { fixture: true }, () => { throw Error('must_not_repeat'); }), /dispatch_uncertain/);
  assert.equal((await journal.usage()).unknownDispatches[0].stage, 'embedding');
  assert.equal((await journal.usage()).estimatedCostUsd,null);assert.ok((await journal.usage()).knownEstimatedCostUsd>0);
  await assert.rejects(stages.run('discovery-collect', { fixture: true }, async () => { throw Error('lost_supplier_response'); }), /dispatch_uncertain/);
  assert.deepEqual((await journal.usage()).unknownDispatches.map(p => p.provider), ['openai', 'amazon']);
});

test('failed application durably records sanitized transaction context before returning the original error',async()=>{
  const saved=memory(),journal=saved.journal(),diagnostic={stage:'preflight',reason:'batch_statements',dispatched:false,
    statementCount:53,requestBytes:192780,requestSha256:'a'.repeat(64)},error=Object.assign(Error('catalog_d1_batch_invalid'),{catalogDiagnostic:diagnostic});
  const prepared={mutations:[{method:'markConfirmedMissingUnavailable',args:[[product.id,'PRIVATE invalid value']],intent:{}}],items:[]};
  await assert.rejects(applyReviewedPhase({key:'phase-11',journal,prepared,store:{async markConfirmedMissingUnavailable(){throw error;}},
    telemetryStore:{},runId:'fixture',withIntent:(_i,action)=>action(),checkpoint:()=>{throw Error('must not checkpoint failure as success');}}),e=>e===error);
  const key=Object.keys(saved.head.entries).find(k=>k.startsWith('failure-'));
  assert.ok(key);const failure=await journal.read(key);
  assert.equal(failure.diagnostic.statementCount,53);assert.equal(failure.diagnostic.phase,'phase-11');
  assert.deepEqual(failure.productIds,[product.id]);assert.doesNotMatch(JSON.stringify(failure),/PRIVATE/);
  assert.equal(saved.head.entries['phase-11-applied'],undefined);
});

test('different initial and confirmation calls keep separate saved omissions, even for identical IDs', async () => {
  const saved = memory(), journal = saved.journal(), stages = createEditorialStages({ read: key => journal.read(key), put: (key, value) => journal.put(key, value) }); let calls = 0;
  for (let call = 0; call < 2; call++) await stages.run('refresh-collect', { phase: 0, ids: [product.id], call }, async () => { calls++; return []; });
  assert.equal(calls, 2);
});

test('cached embedding JSON rehydrates signed zero from the exact saved native receipt, not a new model response', async () => {
  const saved = memory(), journal = saved.journal(), vector = Array(1536).fill(Math.fround(.1)); vector[0] = -0;
  const input = { model: 'text-embedding-3-small', input: [maintenanceEmbeddingText(product)] };
  const response = { model: input.model, data: [{ index: 0, embedding: vector }] };
  const evidence = createCatalogProviderEvidence({ now: () => NOW, saveReceipt: async input => { const ref = await saved.put(input.receipt); await journal.receipt(ref); return ref; } });
  await evidence.embeddings({ products: [product], model: input.model, inputs: input.input, response });
  const cached = JSON.parse(JSON.stringify(response)); assert.equal(Object.is(cached.data[0].embedding[0], -0), false);
  const restored = await journal.embeddingResponse(input, cached); assert.equal(Object.is(restored.data[0].embedding[0], -0), true);
  await assert.rejects(journal.embeddingResponse({ ...input, input: ['wrong'] }, cached), /embedding_unconfirmed/);
  cached.data[0].embedding[1] = 2; await assert.rejects(journal.embeddingResponse(input, cached), /embedding_unconfirmed/);
});

test('preparation persists exact calls/native bytes/final-copy appeal before any D1 write and applies them once', async t => {
  const f = await sqliteFixture(t), saved = memory(), journal = saved.journal(); let executions = 0, currentIntent;
  const cursor = { current: f.owner }, runId = 'fixture-run', revision = 'fixture-revision';
  const evidence = { intent() { return {}; } };
  const store = createD1CatalogMaintenanceStore({ db: f.db, owner: f.owner, ownerCursor: cursor, runId, catalogRevision: revision, preservePermanentListings: true,
    intent: async (method, args) => { const inputSha256 = maintenanceDigest({ method, args, intent: currentIntent, runId, catalogRevision: revision,
      environment: f.owner.environment, indexName: f.owner.indexName, listingPolicy: 'permanent-base-v1' });
      await journal.beforeMutation({ operationId: sha256(`${runId}:${inputSha256}`), inputSha256, owner: cursor.current }); return currentIntent; } });
  const telemetry = createD1CatalogTelemetryStore({ db: f.db, owner: f.owner, ownerCursor: cursor, runId, catalogRevision: revision, beforeMutation: input => journal.beforeMutation(input) });
  await telemetry.startCatalogRun({ id: runId });
  const vector = Array(1536).fill(.1); vector[0] = -0;
  const prepare = () => prepareReviewedPhase({ key: 'phase-0', journal, options: { discoveryNewOnly: true }, store, evidence, runId,
    execute: async (_o, _s, t, recording) => { executions++;
      t.items.record(product, { phase: 'discovery', stage: 'editorial_admission', decision: 'admit', details: { appeal: 'standout' } });
      await recording.upsertProduct({ ...product, embedding: vector }, editorialSourceHash(product));
      await recording.recordEditorialEvent({ runId, productId: product.id, eventType: 'discovered', status: 'short_ready', details: {} });
      return { inserted: 1 }; } });
  const prepared = await prepare(); assert.equal(f.sqlite.prepare('SELECT count(*) n FROM products').get().n, 0);
  assert.equal(Object.is(decodePgvectorSendBase64(prepared.mutations[0].nativeBase64)[0], -0), true);
  assert.equal(prepared.merchandising[product.id].sourceDescription, product.wittyDescription); assert.equal(prepared.merchandising[product.id].appeal, 'standout');
  await prepare(); assert.equal(executions, 1);
  const apply = () => applyReviewedPhase({ key: 'phase-0', journal, prepared, store, telemetryStore: telemetry, runId, checkpoint: async () => {},
    withIntent: async (intent, action) => { currentIntent = intent; return action(); } });
  const checkpointOwner = { ...cursor.current };
  await assert.rejects(applyReviewedPhase({ key: 'phase-0', journal, prepared, store, telemetryStore: telemetry, runId,
    checkpoint: async () => { throw Error('test_only_runner_terminated_after_commit'); },
    withIntent: async (intent, action) => { currentIntent = intent; return action(); } }), /runner_terminated/);
  const actual = await readMutationOwner(f.db, f.scope);
  await reconcileReviewedPhaseOwner({ db: f.db, owner: checkpointOwner, actual, journal, runId, catalogRevision: revision });
  const originalVersion = f.sqlite.prepare('SELECT version FROM catalog_maintenance_products WHERE product_id=?').get(product.id).version;
  await apply(); assert.equal(f.sqlite.prepare('SELECT version FROM catalog_maintenance_products WHERE product_id=?').get(product.id).version, originalVersion);
  const epoch = cursor.current.epoch; await apply(); assert.equal(cursor.current.epoch, epoch);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM products').get().n, 1);
  assert.equal((await telemetry.loadCatalogRun(runId)).items.length, 1);
});

test('the shared preparation reader needs no writer and cannot mutate the catalog', async t => {
  const f = await sqliteFixture(t), before = await readMutationOwner(f.db, f.scope);
  const queries=[];
  const db={...f.db,prepare(sql){queries.push(sql);return f.db.prepare(sql);}};
  const reader = createD1CatalogPreparationStore({ db, runId: 'read-only', catalogRevision: 'read-only', preservePermanentListings: true });
  assert.deepEqual(await reader.getActiveCatalogIdentities({ includeInactive: true }), []);
  assert.deepEqual(await reader.getProductSourceVersions([product.id]), { [product.id]: null });
  assert.deepEqual(await reader.getProductSourceVersions([product.id]), { [product.id]: null });
  assert.equal(queries.filter(sql=>sql.includes('WHERE p.id=?')).length,1,'One captured read, not repeated/native-vector downloads');
  assert.equal(queries.filter(sql=>sql.includes('catalog_mutation_scopes')).length,0);
  for (const method of ['upsertProduct', 'recordEditorialEvent', 'deactivateConfirmedMissing', 'markConfirmedMissingUnavailable'])
    assert.equal(reader[method], undefined);
  assert.deepEqual(await readMutationOwner(f.db, f.scope), before);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n, 0);
  assert.throws(() => createD1CatalogMaintenanceStore({ db: f.db, runId: 'invalid', catalogRevision: 'invalid' }), /configuration/);
});

test('a prepared admission cannot overwrite an identity admitted while providers were working', async t => {
  const f = await sqliteFixture(t), saved = memory(), journal = saved.journal(), cursor = { current: f.owner };
  const reader = createD1CatalogPreparationStore({ db: f.db, runId: 'prepare', catalogRevision: 'prepare', preservePermanentListings: true });
  const prepared = await prepareReviewedPhase({ key: 'phase-0', journal, options: { discoveryNewOnly: true },
    store: reader, evidence: { intent: () => ({}) }, runId: 'prepare', execute: async (_o, _s, _t, recording) => {
      await recording.upsertProduct(product, editorialSourceHash(product)); return { inserted: 1 };
    } });
  assert.deepEqual(prepared.mutations[0].intent.expectedSourceById, { [product.id]: null });
  // Another independently reviewed operation wins. Never overwrite its identity
  // or restart provider work just because the prepared result is now stale.
  const other = createD1CatalogMaintenanceStore({ db: f.db, owner: f.owner, ownerCursor: cursor, runId: 'other', catalogRevision: 'other' });
  await other.upsertProduct({ ...product, title: 'Another reviewed title' }, editorialSourceHash(product));
  const writer = createD1CatalogMaintenanceStore({ db: f.db, owner: cursor.current, ownerCursor: cursor, runId: 'prepare', catalogRevision: 'prepare',
    intent: () => prepared.mutations[0].intent });
  await assert.rejects(writer.upsertProduct(...prepared.mutations[0].args), /maintenance_prepared_source_changed/);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM products').get().n, 1);
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations WHERE run_id=?').get('prepare').n, 0);
});

test('a prepared refresh cannot overwrite a newer private product version', async t => {
  const f=await sqliteFixture(t),cursor={current:f.owner},writer=createD1CatalogMaintenanceStore({db:f.db,owner:f.owner,
    ownerCursor:cursor,runId:'other',catalogRevision:'other'});
  await writer.upsertProduct(product,editorialSourceHash(product));
  const reader=createD1CatalogPreparationStore({db:f.db,runId:'prepare',catalogRevision:'prepare'}),journal=memory().journal();
  const prepared=await prepareReviewedPhase({key:'phase-0',journal,options:{dailyRefresh:true,selectedIds:[product.id]},
    store:reader,evidence:{intent:()=>({})},runId:'prepare',execute:async(_o,_s,_t,recording)=>{
      await recording.upsertProduct(product,editorialSourceHash(product));return{refreshed:1};
    }});
  await writer.upsertProduct({...product,wittyDescription:'Newer independently reviewed short copy.'},editorialSourceHash(product));
  const commit=createD1CatalogMaintenanceStore({db:f.db,owner:cursor.current,ownerCursor:cursor,runId:'prepare',catalogRevision:'prepare',
    intent:()=>prepared.mutations[0].intent});
  await assert.rejects(commit.upsertProduct(...prepared.mutations[0].args),/maintenance_prepared_source_changed/);
  assert.equal(JSON.parse(f.sqlite.prepare('SELECT semantic_json FROM catalog_maintenance_products WHERE product_id=?').get(product.id).semantic_json)
    .wittyDescription,'Newer independently reviewed short copy.');
});

test('lost committed telemetry ACK reconciles only the exact journalled receipt, never an unexplained current epoch', async t => {
  const f = await sqliteFixture(t), saved = memory(), journal = saved.journal(), runId = 'fixture-run', catalogRevision = 'fixture-revision';
  const cursor = { current: f.owner };
  const telemetry = createD1CatalogTelemetryStore({ db: f.db, owner: f.owner, ownerCursor: cursor, runId, catalogRevision, beforeMutation: input => journal.beforeMutation(input) });
  await telemetry.startCatalogRun({ id: runId });
  const actual = await readMutationOwner(f.db, f.scope);
  assert.equal((await reconcileReviewedPhaseOwner({ db: f.db, owner: f.owner, actual, journal, runId, catalogRevision })).epoch, 1);
  for (const changed of [
    { ...saved.head, mutations: {} },
    { ...saved.head, mutations: Object.fromEntries(Object.entries(saved.head.mutations).map(([key, value]) => [key, { ...value, owner: { ...value.owner, epoch: 1 } }])) },
  ]) await assert.rejects(reconcileReviewedPhaseOwner({ db: f.db, owner: f.owner, actual,
    journal: { snapshot: () => changed }, runId, catalogRevision }), /owner_unconfirmed/);
  const resumed = createD1CatalogTelemetryStore({ db: f.db, owner: actual, runId, catalogRevision, beforeMutation: input => journal.beforeMutation(input) });
  await resumed.startCatalogRun({ id: runId }); assert.equal((await readMutationOwner(f.db, f.scope)).epoch, 1);
});

test('journal storage uncertainty halts preparation, while a supplier/model-only unknown defers no product writes', async () => {
  const saved = memory(); let journal = saved.journal();
  const input = { key: 'phase-0', options: { dailyRefresh: true, selectedIds: [product.id] }, runId: 'fixture', store: {}, evidence: {},
    execute: async (_o, _s, telemetry) => { telemetry.items.record(product, { phase: 'discovery', stage: 'selection', decision: 'selected' });
      throw Error('editorial_dispatch_uncertain'); } };
  const result = await prepareReviewedPhase({ ...input, journal }); assert.equal(result.result.deferred, true); assert.deepEqual(result.mutations, []);
  assert.equal(result.result.knownDeferredCandidates,1);
  assert.equal(result.items.at(-1).decision,'deferred');assert.equal(result.items.at(-1).productId,product.id);
  journal = memory().journal();
  await assert.rejects(prepareReviewedPhase({ ...input, journal, execute: async () => { throw Error('editorial_storage_unconfirmed'); } }), /storage_unconfirmed/);
  await assert.rejects(prepareReviewedPhase({ ...input, journal, execute: async () => { throw Error('maintenance_fenced'); } }), /maintenance_fenced/);
});

test('missing confirmation holds on storage/evidence failure but preserves valid first-response updates for a response-only unknown',async()=>{
  for(const errorCode of ['editorial_storage_unconfirmed','provider_evidence_products','editorial_dispatch_uncertain']){
    const writes=[],items=[],telemetry={runId:'fixture',usage:{models:{}},warnings:[],timingsMs:{},
      items:{record(_product,fields){items.push(fields);},async flush(){}}};let requests=0;
    const options={...parseArgs(['--revalidate','--revalidate-limit','2','--backfill-limit','0','--skip-enrichment']),dailyRefresh:true,deactivateMissing:false};
    const store={async getProductsForRevalidation(){return[1,2].map(n=>({id:id(n),slug:`fixture-${n}`,title:product.title,
      price:20,currency:'USD',image_url:product.imageUrl,source_facts:{},humor_tags:[],last_verified_at:null}));},
      async upsertProduct(p){writes.push(p.id);return{inserted:false,slug:'fixture-1'};},
      async markConfirmedMissingUnavailable(){assert.fail('An unconfirmed omission is not confirmed unavailable');}};
    const evidence={async amazon(){requests++;if(requests===1)return[product];throw Error(errorCode);},async embeddings(){assert.fail('No model work');}};
    const action=()=>executeCatalog(options,undefined,telemetry,store,evidence);
    if(errorCode!=='editorial_dispatch_uncertain'){
      await assert.rejects(action(),new RegExp(errorCode));assert.deepEqual(writes,[]);
    }else{
      const result=await action();assert.equal(result.refreshed,1);assert.deepEqual(writes,[product.id]);
      assert.ok(items.some(item=>item.decision==='deferred'&&item.reasonCode==='missing_confirmation_failed'));
    }
    assert.equal(requests,2);
  }
});
