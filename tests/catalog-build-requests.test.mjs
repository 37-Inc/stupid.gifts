import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { enqueueBuildRequest, encodeBuildRequest, claimBuildRequest, failBuildRequest, beginBuildActivation, reconcileObservedServingActivation, resolveBuildActivation } from '../lib/catalog/build-requests.ts';
import { createProjectionPacket, importPublicProjection } from '../lib/catalog/d1.ts';
import { enqueuePublication, claimPublication, recordPublicationDispatch, completePublication } from '../lib/catalog/publication.ts';
import { createFreshnessCheck } from '../workers/site/freshness.ts';
import { claimMutationOwnership, readMutationOwner, releaseMutationOwnership } from '../lib/catalog/mutation-fence.ts';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const SOURCE = 'b'.repeat(64); const FACTS = 'f'.repeat(64);
async function setup() {
  const sqlite = new DatabaseSync(':memory:');
  for (const migration of ['0001_catalog.sql', '0002_public_projections.sql', '0003_publication_outbox.sql', '0004_vector_outbox_leases.sql',
    '0005_historical_timestamps.sql', '0006_semantic_search_budget.sql', '0007_catalog_build_requests.sql', '0010_catalog_maintenance.sql'])
    sqlite.exec(await readFile(new URL(`../migrations/d1/${migration}`, import.meta.url), 'utf8'));
  let clock = NOW; let beforeRun; let unknownActivationReceipt = false; const calls = [];
  sqlite.function('strftime', (format, instant) => {
    assert.equal(format, '%Y-%m-%dT%H:%M:%fZ'); assert.equal(instant, 'now'); return new Date(clock).toISOString();
  });
  const db = { prepare(sql) { let values = []; return { sql,
    bind(...input) { values = input; return this; },
    async all() { calls.push(sql); return { results: sqlite.prepare(sql).all(...values).map(row => ({ ...row })) }; },
    execute() { beforeRun?.(sql, values); calls.push(sql); const result = sqlite.prepare(sql).run(...values);
      return unknownActivationReceipt && sql.includes("SET state='activating'") ? { success: true } : { success: true, meta: { changes: result.changes } }; },
    async run() { return this.execute(); },
  }; }, async batch(statements) { sqlite.exec('BEGIN'); try { for (const statement of statements) statement.execute(); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; } } };
  const product = { id: 'B000000001', publicId: '00000000-0000-4000-8000-000000000001', slug: 'funny-button',
    title: 'Funny Red Sound Button', description: 'A funny button.', imageUrl: 'https://m.media-amazon.com/images/I/button.jpg',
    affiliateUrl: 'https://www.amazon.com/dp/B000000001?tag=test-20', source: 'amazon', currency: 'USD', price: 0,
    editorialWriteup: 'Controlled test-only editorial.',
    isActive: true, qualityScore: .8, eligibleUntil: new Date(NOW + 26 * 3600000).toISOString() };
  const rights = Object.fromEntries(['title','description','imageUrl','affiliateUrl','editorialWriteup'].map(field => [field,
    { basis: 'licensed', reference: 'Controlled test-only permission', value: product[field] }]));
  sqlite.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,quality_score,is_active,editorial_status,
    availability_status,availability_checked_at,source_facts_hash,editorial_source_hash,catalog_revision,eligible_until,public_display_json,rights_json,source_record_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(product.id, product.publicId, product.slug, product.source, product.title, product.currency,
      .8, 1, 'generated_ready', 'IN_STOCK', new Date(NOW).toISOString(), FACTS, FACTS, 'source-r1', product.eligibleUntil, JSON.stringify(product), JSON.stringify(rights), '{}', new Date(NOW).toISOString());
  const source = { schemaVersion: 1, dataKind: 'catalog', catalogRevision: 'source-r1', generatedAt: new Date(NOW).toISOString(), products: [product], heldProducts: [], slugHistory: [] };
  const snapshot = { ...source, catalogRevision: 'target-r2' };
  const packets = [];
  for (const value of [source, snapshot]) {
    sqlite.prepare('INSERT INTO catalog_revisions VALUES(?,?,?,?)').run(value.catalogRevision, value.generatedAt, SOURCE, 'reconciled');
    const packet = await createProjectionPacket(value, { [product.publicId]: FACTS }, SOURCE, new Date(clock));
    await importPublicProjection(db, packet); packets.push(packet);
  }
  const prior = { releaseId: 'prior-release', codeSha: 'a'.repeat(40), catalogRevision: source.catalogRevision,
    catalogSnapshotSha256: packets[0].receipt.snapshot_sha256, manifestSha256: 'd'.repeat(64), vectorSyncWatermark: 0,
    priorReleaseId: null, nextExpiry: product.eligibleUntil };
  sqlite.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(prior.releaseId, prior.catalogRevision, prior.codeSha, source.generatedAt, JSON.stringify(prior));
  const intent = { ...prior, releaseId: 'next-release', codeSha: 'c'.repeat(40), catalogRevision: snapshot.catalogRevision,
    catalogSnapshotSha256: packets[1].receipt.snapshot_sha256, manifestSha256: 'e'.repeat(64), priorReleaseId: prior.releaseId };
  const request = { schemaVersion: 1, environment: 'staging', sourceRevision: source.catalogRevision,
    sourceDigest: packets[0].receipt.snapshot_sha256, codeSha: intent.codeSha, priorReleaseId: prior.releaseId,
    capturedAt: source.generatedAt, cutoff: new Date(NOW + 25 * 3600000).toISOString() };
  const identity = (value, versionReference) => ({ releaseId: value.releaseId, codeSha: value.codeSha, catalogRevision: value.catalogRevision,
    catalogSnapshotSha256: value.catalogSnapshotSha256, manifestSha256: value.manifestSha256, versionReference });
  const before = { environment: 'staging', settled: true, active: identity(prior, 'prior-version') };
  const after = { environment: 'staging', settled: true, active: identity(intent, 'uploaded-version') };
  return { sqlite, db, source, snapshot, request, intent, before, after, calls,
    now: () => new Date(clock), advance(ms) { clock += ms; }, setBeforeRun(fn) { beforeRun = fn; }, setUnknownActivationReceipt() { unknownActivationReceipt = true; },
    row: () => ({ ...sqlite.prepare('SELECT * FROM catalog_build_requests').get() }), close: () => sqlite.close(),
    async build(run = 'workflow-run-1', leaseMs) { const queued = await enqueueBuildRequest(db, request); return claimBuildRequest(db, queued.requestId, run, new Date(clock), leaseMs); },
    async publication() {
      await enqueuePublication(db, snapshot, intent, new Date(clock));
      const claim = await claimPublication(db, snapshot, intent.releaseId, new Date(clock));
      await recordPublicationDispatch(db, snapshot, claim, 'workflow-run-1', new Date(clock)); return claim;
    },
    async activate(claim, publication, observer = async () => before) { return beginBuildActivation(db, claim, snapshot, publication, 'uploaded-version', observer, new Date(clock)); },
  };
}

test('explicit whole-catalog build lease fits build and cleanup but remains bounded by source cutoff',async()=>{
  const f=await setup();try{
    const claim=await f.build('whole-catalog-build',2*3600000);
    assert.equal(claim.leaseUntil,new Date(f.now().getTime()+3600000).toISOString());
    assert.ok(claim.leaseUntil<=claim.request.cutoff);assert.equal(f.row().attempts,1);
  }finally{f.close();}
});

test('canonical immutable requests are idempotent and cannot invent unknown source digests', async () => {
  const f = await setup();
  try {
    const first = await enqueueBuildRequest(f.db, f.request);
    const second = await enqueueBuildRequest(f.db, Object.fromEntries(Object.entries(f.request).reverse()));
    assert.deepEqual(second, { requestId: first.requestId, created: false }); assert.equal(first.created, true); assert.match(first.requestId, /^[a-f0-9]{64}$/);
    assert.equal(f.row().attempts, 0); assert.equal(f.row().lease_token, null); assert.equal(f.row().state, 'pending');
    assert.throws(() => f.sqlite.exec("UPDATE catalog_build_requests SET request_json='{}'"), /immutable/);
    await assert.rejects(enqueueBuildRequest(f.db, { ...f.request, sourceDigest: '0'.repeat(64) }), /source_unavailable/);
    for (const changed of [{ private: 'not permitted' }, { schemaVersion: 2 }, { cutoff: f.request.capturedAt }, { cutoff: new Date(NOW + 27 * 3600000).toISOString() }])
      assert.throws(() => encodeBuildRequest({ ...f.request, ...changed }));
  } finally { f.close(); }
});
test('activation accepts only the exact authenticated same-catalog storefront prior', async () => {
  const f = await setup();
  try {
    const claim = await f.build();
    const publication = await f.publication();
    const serving = { ...f.before.active, releaseId: 'code-only-release', codeSha: 'f'.repeat(40),
      manifestSha256: '9'.repeat(64), versionReference: 'code-only-version' };
    const observe = active => async () => ({ environment: 'staging', settled: true, active });
    for (const changed of [
      { ...serving, versionReference: 'other-version' },
      { ...serving, manifestSha256: '8'.repeat(64) },
      { ...serving, catalogRevision: 'other-revision' },
      { ...serving, catalogSnapshotSha256: '8'.repeat(64) },
    ]) await assert.rejects(beginBuildActivation(f.db, claim, f.snapshot, publication, 'uploaded-version',
      observe(changed), f.now(), undefined, serving), /build_prior_deployment_changed/);
    await assert.rejects(beginBuildActivation(f.db, claim, f.snapshot, publication, 'uploaded-version',
      observe(serving), f.now()), /build_prior_deployment_changed/);
    const wrongCatalog = { ...serving, catalogSnapshotSha256: '8'.repeat(64) };
    await assert.rejects(beginBuildActivation(f.db, claim, f.snapshot, publication, 'uploaded-version',
      observe(wrongCatalog), f.now(), undefined, wrongCatalog), /build_prior_deployment_changed/);
    const permit = await beginBuildActivation(f.db, claim, f.snapshot, publication, 'uploaded-version',
      observe(serving), f.now(), undefined, serving);
    assert.equal(permit.versionReference, 'uploaded-version');
  } finally { f.close(); }
});
test('resolve-only observation timeout is explicit, bounded, aborts and leaves exact activation retryable',async()=>{
  const f=await setup();
  try{
    const claim=await f.build(),publication=await f.publication(),permit=await f.activate(claim,publication);
    let observedSignal;const before=f.calls.length;
    for(const value of [0,9,30_001,1.5,NaN,Infinity])await assert.rejects(resolveBuildActivation(f.db,permit,async()=>f.after,{observationTimeoutMs:value}),/invalid_observation_timeout/);
    assert.equal(f.calls.length,before);
    await assert.rejects(resolveBuildActivation(f.db,permit,async signal=>{observedSignal=signal;return new Promise(()=>{});},{observationTimeoutMs:10}),{message:'deployment_observation_failed_timeout'});
    assert.equal(observedSignal.aborted,true);assert.equal(f.row().state,'activating');
    for(const code of ['serving_observation_mismatch','publication_activation_pending','publication_identity_mismatch',
      'publication_provider_unavailable','publication_read_scope_invalid','publication_read_unavailable','publication_read_aborted']){
      await assert.rejects(resolveBuildActivation(f.db,permit,async()=>{throw Error(code);}),{message:code});
      assert.equal(f.row().state,'activating');
    }
    for(const code of ['PRIVATE','publication_provider_unavailable PRIVATE','serving_observation_private'])
      await assert.rejects(resolveBuildActivation(f.db,permit,async()=>{throw Error(code);}),{message:'deployment_observation_failed'});
    assert.equal(await resolveBuildActivation(f.db,permit,async()=>f.after),'awaiting_receipt');
    const scheduled=[],timer=globalThis.setTimeout;
    // An unchanged generic caller still receives the original three-second bound.
    const original=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>{scheduled.push(ms);return timer(fn,ms,...args);};
    try{assert.equal(await resolveBuildActivation(f.db,permit,async()=>f.after),'awaiting_receipt');}finally{globalThis.setTimeout=original;}
    assert.deepEqual(scheduled,[3000]);
  }finally{f.close();}
});

test('observed serving timeout rejects invalid bounds before reading claims or calling adapters',async()=>{
  const unused=()=>assert.fail('Invalid timeout must not reach original claims or adapters');
  for(const observationTimeoutMs of [0,9,120_001,1.5,NaN,Infinity])
    await assert.rejects(reconcileObservedServingActivation(null,null,null,null,null,null,null,null,unused,unused,new Date(),{observationTimeoutMs}),/invalid_observation_timeout/);
});
test('preactivation keeps its three-second bound and aborts failed observers before any activation CAS',async t=>{
  const f=await setup();
  try{
    const claim=await f.build(),publication=await f.publication();let signal,deliver;
    const timer=globalThis.setTimeout,deadlines=[];
    t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{deadlines.push(ms);return timer(fn,ms===3000?10:ms,...args);});
    await assert.rejects(f.activate(claim,publication,async value=>{signal=value;return new Promise(resolve=>{deliver=resolve;});}),/observation_failed/);
    assert.deepEqual(deadlines,[3000]);assert.equal(signal.aborted,true);assert.equal(f.row().state,'building');
    const calls=f.calls.length;deliver(f.before);await Promise.resolve();await Promise.resolve();assert.equal(f.calls.length,calls);assert.equal(f.row().state,'building');
    await assert.rejects(f.activate(claim,publication,async value=>{signal=value;throw new Error('read failure');}),/observation_failed/);
    assert.equal(signal.aborted,true);assert.equal(f.row().state,'building');
  }finally{f.close();}
});

test('unchanged check does no D1 work; duplicate due checks dispatch one request but never publish', async () => {
  const f = await setup(); let dispatched = 0;
  try {
    const options = { db: f.db, environment: 'staging', sourceRevision: f.request.sourceRevision, sourceDigest: f.request.sourceDigest,
      codeSha: f.request.codeSha, priorReleaseId: f.request.priorReleaseId, nextExpiry: f.intent.nextExpiry,
      async dispatch(id) { assert.match(id, /^[a-f0-9]{64}$/); dispatched++; return { reference: 'accepted-workflow-run' }; } };
    f.calls.length = 0;
    assert.deepEqual(await createFreshnessCheck(options)(f.now()), { state: 'unchanged' }); assert.equal(f.calls.length, 0);
    const check = createFreshnessCheck({ ...options, horizonMs: 26 * 3600000 });
    const result = await Promise.all([check(f.now()), check(f.now())]);
    assert.deepEqual(result.map(item => item.state).sort(), ['dispatched', 'existing']); assert.equal(dispatched, 1);
    assert.equal(f.row().dispatch_reference, 'accepted-workflow-run'); assert.equal(f.row().lease_token, null);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM publication_outbox').get().n, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM publication_receipts').get().n, 1);
  } finally { f.close(); }
});

test('unconfirmed dispatch is sanitized and not blindly repeated by a duplicate check', async () => {
  const f = await setup(); let calls = 0;
  try {
    const check = createFreshnessCheck({ db: f.db, ...f.request, nextExpiry: f.intent.nextExpiry, horizonMs: 26 * 3600000,
      async dispatch() { calls++; throw new Error('PRIVATE_PROVIDER_CREDENTIAL'); } });
    assert.equal((await check(f.now())).state, 'dispatch_unconfirmed');
    assert.equal((await check(f.now())).state, 'existing'); assert.equal(calls, 1);
    assert.equal(f.row().error_code, 'dispatch_unconfirmed'); assert.doesNotMatch(JSON.stringify(f.row()), /PRIVATE/);
  } finally { f.close(); }
});

test('queue delay consumes no lease and the workflow claims at its actual start', async () => {
  const f = await setup();
  try {
    const { requestId } = await enqueueBuildRequest(f.db, f.request);
    f.advance(2 * 3600000); assert.equal(f.row().lease_until, null);
    const claim = await claimBuildRequest(f.db, requestId, 'delayed-run', f.now(), 600000);
    assert.equal(claim.leaseUntil, new Date(f.now().getTime() + 600000).toISOString()); assert.equal(f.row().attempts, 1);
    assert.equal(await claimBuildRequest(f.db, requestId, 'overlapping-run', f.now()), null);
  } finally { f.close(); }
});

test('expired build leases retry with a new token; old owners cannot fail or activate the replacement', async () => {
  const f = await setup();
  try {
    const old = await f.build('old-run', 1000); f.advance(1000);
    const current = await f.build('replacement-run'); assert.notEqual(current.token, old.token);
    await failBuildRequest(f.db, old); assert.equal(f.row().lease_token, current.token);
    await assert.rejects(f.activate(old, await f.publication()), /build_fenced/);
    await failBuildRequest(f.db, current); const last = await f.build('last-run'); await failBuildRequest(f.db, last);
    assert.equal(await f.build('exhausted-run'), null); assert.equal(f.row().attempts, 3);
  } finally { f.close(); }
});

test('changed prior deployment, wrong environment and unsettled observations refuse activation', async () => {
  for (const change of [before => { before.active.releaseId = 'newer-release'; }, before => { before.environment = 'production'; },
    before => { before.settled = false; }, before => { before.active.manifestSha256 = '0'.repeat(64); }]) {
    const f = await setup();
    try {
      const claim = await f.build(); const publication = await f.publication(); const before = structuredClone(f.before); change(before);
      await assert.rejects(f.activate(claim, publication, async () => before), /prior_deployment_changed/); assert.equal(f.row().state, 'building');
    } finally { f.close(); }
  }
});

test('activation SQL rechecks current holds, source/target receipts, vector watermark and writer barrier after readback', async () => {
  for (const change of [
    "UPDATE products SET public_display_json=NULL", "UPDATE products SET source_facts_hash='changed'",
    "UPDATE products SET rights_json='{}'",
    "UPDATE products SET rights_json=json_set(rights_json,'$.title.expiresAt','2026-10-20T12:01:00.000Z')",
    "UPDATE products SET public_display_json=json_set(public_display_json,'$.description','Changed current approved copy')",
    "DELETE FROM catalog_projection_receipts WHERE catalog_revision='source-r1'",
    "UPDATE catalog_revisions SET source_export_sha256='changed' WHERE revision='target-r2'",
    "INSERT INTO catalog_revisions VALUES('writer-in-progress','2026-10-20T12:00:00.000Z','source','importing')",
    "INSERT INTO publication_receipts SELECT 'parallel-release',catalog_revision,code_sha,completed_at,manifest_json FROM publication_receipts WHERE release_id='prior-release'",
    "INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at) VALUES('id','target-r2','hash','upsert','now')",
  ]) {
    const f = await setup();
    try {
      const claim = await f.build(); const publication = await f.publication();
      f.setBeforeRun(sql => { if (sql.includes("SET state='activating'")) f.sqlite.exec(change); });
      await assert.rejects(f.activate(claim, publication), /fenced_or_preflight_changed/); assert.equal(f.row().state, 'building');
    } finally { f.close(); }
  }
});

test('database-clock lease/cutoff deadlines and products at the pruning horizon fail closed', async () => {
  for (const advance of [600000, 25 * 3600000]) {
    const f = await setup();
    try {
      const claim = await f.build(); const publication = await f.publication();
      await assert.rejects(f.activate(claim, publication, async () => { f.advance(advance); return f.before; }), /fenced_or_preflight_changed/);
      assert.equal(f.row().state, 'building');
    } finally { f.close(); }
  }
  const f = await setup();
  try {
    f.request.cutoff = f.snapshot.products[0].eligibleUntil;
    const claim = await f.build(); const publication = await f.publication();
    await assert.rejects(f.activate(claim, publication), /publication_unready/);
    f.advance(26 * 3600000); assert.equal(await f.build('too-late'), null);
  } finally { f.close(); }
});

test('uncertain activating state never expires or reclaims; visible target without publication receipt is insufficient', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const permit = await f.activate(claim, publication);
    assert.equal(f.row().state, 'activating'); assert.equal(f.row().lease_until, null);
    assert.equal(await resolveBuildActivation(f.db, permit, async () => f.after), 'awaiting_receipt');
    f.advance(2 * 86400000); assert.equal(await f.build('cannot-takeover'), null); await failBuildRequest(f.db, claim);
    await assert.rejects(resolveBuildActivation(f.db, permit, async () => ({ ...f.after, settled: false })), /still_uncertain/);
    await assert.rejects(resolveBuildActivation(f.db, permit, async () => { throw new Error('PRIVATE'); }), /observation_failed/);
    assert.equal(f.row().state, 'activating'); assert.equal(f.row().lease_token, claim.token);
  } finally { f.close(); }
});

test('concurrent activation calls issue one permit and neither replay nor unknown write receipt grants another', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication();
    const results = await Promise.allSettled([f.activate(claim, publication), f.activate(claim, publication)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(f.row().state, 'activating');
    await assert.rejects(f.activate(claim, publication), /build_fenced/);
  } finally { f.close(); }
  const unknown = await setup();
  try {
    const claim = await unknown.build(); const publication = await unknown.publication(); unknown.setUnknownActivationReceipt();
    await assert.rejects(unknown.activate(claim, publication), /fenced_or_preflight_changed/);
    assert.equal(unknown.row().state, 'activating');
    await assert.rejects(unknown.activate(claim, publication), /build_fenced/);
  } finally { unknown.close(); }
});

test('settled exact deployment plus the existing verified publication receipt resolves the activation', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const permit = await f.activate(claim, publication);
    await completePublication(f.db, f.snapshot, f.intent.releaseId, publication.token, async () => f.intent, f.now);
    assert.equal(await resolveBuildActivation(f.db, permit, async () => f.after), 'resolved'); assert.equal(f.row().state, 'resolved');
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM publication_receipts').get().n, 2);
    await assert.rejects(resolveBuildActivation(f.db, permit, async () => f.after), /build_fenced/);
  } finally { f.close(); }
});

test('only settled observed non-activation releases the fence; unknown deployments and old tokens cannot resolve it', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const permit = await f.activate(claim, publication);
    await assert.rejects(resolveBuildActivation(f.db, { ...permit, token: 'old' }, async () => f.before), /build_fenced/);
    await assert.rejects(resolveBuildActivation(f.db, permit, async () => ({ ...f.after, active: { ...f.after.active, versionReference: 'unknown-version' } })), /resolution_mismatch/);
    assert.equal(f.row().state, 'activating');
    assert.equal(await resolveBuildActivation(f.db, permit, async () => f.before), 'not_activated'); assert.equal(f.row().state, 'failed');
    const retry = await f.build('recovery-run'); assert.notEqual(retry.token, permit.token);
    await assert.rejects(resolveBuildActivation(f.db, permit, async () => f.before), /build_fenced/);
  } finally { f.close(); }
});

async function enableOwnership(f) {
  f.sqlite.exec(await readFile(new URL('../migrations/d1/0009_catalog_mutation_fence.sql', import.meta.url), 'utf8'));
  const scope = { environment: 'staging', indexName: 'stupid-gifts-staging' };
  f.sqlite.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const owner = await claimMutationOwnership(f.db,scope,{ phase: 'freezing', ownerReference: 'protected-workflow', operationKey: 'f'.repeat(64) });
  return { scope, owner };
}
test('enabled ownership and existing activation change atomically; uncertainty never releases either barrier', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const { scope, owner } = await enableOwnership(f);
    await assert.rejects(f.activate(claim,publication),/fenced/);
    assert.equal(f.row().state,'building');
    const permit = await beginBuildActivation(f.db,claim,f.snapshot,publication,'uploaded-version',async () => f.before,f.now(),owner);
    assert.equal(permit.mutationOwner.phase,'activating'); assert.equal(f.row().state,'activating');
    assert.equal(f.sqlite.prepare('SELECT external_pending FROM catalog_mutation_scopes').get().external_pending,1);
    await assert.rejects(releaseMutationOwnership(f.db,permit.mutationOwner),/requires_resolution/);
    assert.equal(await claimMutationOwnership(f.db,scope,{ phase: 'writing', ownerReference: 'weekly-run', operationKey: 'e'.repeat(64) }),null);
    await assert.rejects(resolveBuildActivation(f.db,permit,async () => ({ ...f.after,settled:false })),/uncertain/);
    assert.equal(await resolveBuildActivation(f.db,permit,async () => f.after),'awaiting_receipt');
    assert.equal(f.sqlite.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'activating');
    assert.equal(await resolveBuildActivation(f.db,permit,async () => f.before),'not_activated');
    assert.equal(f.sqlite.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
    assert.equal(f.row().state,'failed');
  } finally { f.close(); }
});
test('owned publication requires matching activating build, and verified completion resolves shared ownership', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const { owner } = await enableOwnership(f);
    await assert.rejects(completePublication(f.db,f.snapshot,f.intent.releaseId,publication.token,async () => f.intent,f.now),/malformed JSON/);
    const permit = await beginBuildActivation(f.db,claim,f.snapshot,publication,'uploaded-version',async () => f.before,f.now(),owner);
    await completePublication(f.db,f.snapshot,f.intent.releaseId,publication.token,async () => f.intent,f.now,permit.mutationOwner);
    assert.equal(await resolveBuildActivation(f.db,permit,async () => f.after),'resolved');
    const row = f.sqlite.prepare('SELECT * FROM catalog_mutation_scopes').get();
    assert.equal(row.phase,'idle'); assert.equal(row.external_pending,0); assert.equal(row.activation_request_id,null);
    assert.equal(f.sqlite.prepare('SELECT catalog_revision FROM products').get().catalog_revision,'source-r1');
  } finally { f.close(); }
});
test('ownership epoch drift during readback cannot partially enter activation', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const { owner } = await enableOwnership(f);
    await assert.rejects(beginBuildActivation(f.db,claim,f.snapshot,publication,'uploaded-version',async () => {
      f.sqlite.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1'); return f.before;
    },f.now(),owner));
    assert.equal(f.row().state,'building');
    assert.equal(f.sqlite.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'freezing');
  } finally { f.close(); }
});
test('lost owned activation response is recovered from exact stored identity, never by expiry or a second permit', async () => {
  const f = await setup();
  try {
    const claim = await f.build(); const publication = await f.publication(); const { scope, owner } = await enableOwnership(f);
    const uncertainDb = { ...f.db, async batch(statements) { await f.db.batch(statements); throw new Error('unknown D1 response'); } };
    await assert.rejects(beginBuildActivation(uncertainDb,claim,f.snapshot,publication,'uploaded-version',async () => f.before,f.now(),owner),/unknown D1/);
    assert.equal(f.row().state,'activating');
    await assert.rejects(beginBuildActivation(f.db,claim,f.snapshot,publication,'uploaded-version',async () => f.before,f.now(),owner),/fenced/);
    const permit = { requestId:claim.requestId,token:claim.token,runReference:claim.runReference,
      releaseId:f.intent.releaseId,versionReference:'uploaded-version',mutationOwner:await readMutationOwner(f.db,scope) };
    await assert.rejects(resolveBuildActivation(f.db,permit,async () => ({ ...f.before,settled:false })),/uncertain/);
    assert.equal(await resolveBuildActivation(f.db,permit,async () => f.before),'not_activated');
    assert.equal(f.sqlite.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
  } finally { f.close(); }
});
