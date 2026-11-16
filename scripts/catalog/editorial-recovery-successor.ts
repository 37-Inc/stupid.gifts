import { constants } from 'node:fs';
import { lstat, open, realpath, rename } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import { encodeBuildRequest } from '../../lib/catalog/build-requests.ts';
import { encodePublicationIntent } from '../../lib/catalog/publication.ts';
import { mutationFenceQuery } from '../../lib/catalog/mutation-fence.ts';
import { canonicalTime } from '../../lib/catalog/snapshot.ts';
import { catalogSuccessorBytes } from './approved-catalog-seal.ts';
import type { ApprovedCatalogSeal } from './approved-catalog-seal.ts';
import type { BudgetTotals, RunWorkspace, WorkspaceScope } from './run-workspace.ts';
import { canonicalJson, sha256 } from './migration.ts';
import { isAccountedPublicationFetch } from './publication-read-fetch.ts';

type Row = Record<string, unknown>;
export interface EditorialSuccessorPointer {
  control: { path: string; sha256: string }; versionReference: string; manifestSha256: string;
}
export interface EditorialSuccessorBinding {
  runId: string; originalConfigSha256: string; originalCodeSha: string;
  publicationConfigSha256: string; executionCodeSha: string; scope: WorkspaceScope;
  publicProducts: number; heldProducts: number; previous: EditorialSuccessorPointer;
  previousPublication: { releaseId: string; receiptSha256: string };
}
export interface EditorialSuccessorObservation {
  observedAt: string; receipt: Row; build: Row; scope: Row; publicIdentity: Row;
}
export interface EditorialSuccessorStore {
  readPointer(): Promise<EditorialSuccessorPointer>;
  putControl(seal: ApprovedCatalogSeal): Promise<{ path: string; sha256: string }>;
  putObservation(value: Row): Promise<void>;
  putSuccess(value: Row): Promise<void>;
  compareAndSwapPointer(previous: EditorialSuccessorPointer, next: EditorialSuccessorPointer): Promise<void>;
}
type Workspace = Pick<RunWorkspace, 'manifest' | 'assertHeld' | 'readCheckpoint' | 'catalogSuccessor' | 'budget'>;
const HASH = /^[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
function fail(code: string): never { throw new Error(`editorial_successor_${code}`); }
function pointer(value: EditorialSuccessorPointer): void {
  if (!value || !same(Object.keys(value).sort(), ['control', 'manifestSha256', 'versionReference'])
    || !value.control || !same(Object.keys(value.control).sort(), ['path', 'sha256'])
    || !isAbsolute(value.control.path) || normalize(value.control.path) !== value.control.path
    || !HASH.test(value.control.sha256) || !HASH.test(value.manifestSha256)
    || typeof value.versionReference !== 'string' || !/^[a-zA-Z0-9._:-]{1,200}$/.test(value.versionReference)) fail('pointer');
}
function budget(value: BudgetTotals): void {
  if (!value || !same(Object.keys(value).sort(), ['httpRequests', 'knownRowsRead', 'knownRowsWritten', 'sqlStatements', 'unconfirmedRequests'])
    || Object.values(value).some(n => !Number.isSafeInteger(n) || n < 0)) fail('accounting');
}

/** Trusted adapter seam, NOT a JSON assertion of provider success. The live CLI
 * must construct it from its accounted SAME-run DB/public clients. Tests may
 * inject a local observer. No credentials, environment or network defaults. */
export function createEditorialSuccessorObserver(options: {
  db: CatalogD1; send: typeof fetch; scope: WorkspaceScope; identityOrigin: string; now?: () => string;
}) {
  if ((options.db as CatalogD1 & { providerIdentity?: string }).providerIdentity !== `cloudflare:${options.scope.accountId}:${options.scope.databaseId}`
    || !isAccountedPublicationFetch(options.send) || !options.identityOrigin.startsWith('https://')
    || new URL(options.identityOrigin).origin !== options.identityOrigin) fail('observer_configuration');
  return async (expected: { releaseId: string; requestId: string }): Promise<EditorialSuccessorObservation> => {
    const rows = await options.db.batch([
      options.db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(expected.releaseId),
      options.db.prepare(`SELECT request_id,environment,source_revision,request_json,state,lease_token,lease_until,
        run_reference,release_id,version_reference,error_code FROM catalog_build_requests WHERE request_id=?`).bind(expected.requestId),
      options.db.prepare(`SELECT environment,index_name,generation,mutation_epoch,phase,owner_token,owner_reference,
        operation_key,captured_at,external_pending,activation_request_id,strftime('%Y-%m-%dT%H:%M:%fZ','now') observed_at
        FROM catalog_mutation_scopes WHERE environment=? AND index_name=?`).bind(options.scope.environment, options.scope.indexName),
    ]) as Array<{ results: Row[] }>;
    if (rows.length !== 3 || rows.some(result => result.results.length !== 1)) fail('observation_missing');
    const response = await options.send(options.identityOrigin + '/.well-known/catalog-release.json',
      { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(3000) });
    if (response.status !== 200) fail('public_identity');
    const body = await response.text(); if (Buffer.byteLength(body) > 32 * 1024) fail('public_identity');
    return { observedAt: (options.now || (() => new Date().toISOString()))(), receipt: rows[0].results[0],
      build: rows[1].results[0], scope: rows[2].results[0], publicIdentity: JSON.parse(body) };
  };
}

/** Finalized reconciliation reads body-free controls only, so old supplier/body
 * expiry is not extended or used as a reason to replay publication. This must
 * run while the original workspace lock is held, never from saved JSON alone. */
export async function reconcileEditorialRecoverySuccessor(options: {
  workspace: Workspace; binding: EditorialSuccessorBinding; store: EditorialSuccessorStore;
  observe: (expected: { releaseId: string; requestId: string }) => Promise<EditorialSuccessorObservation>;
  now?: () => string;
}) {
  const { workspace: w, binding: b, store } = options;
  pointer(b.previous); await w.assertHeld();
  if (w.manifest.runId !== b.runId || w.manifest.codeSha !== b.originalCodeSha || w.manifest.configSha256 !== b.originalConfigSha256
    || !HASH.test(b.publicationConfigSha256) || !/^[a-f0-9]{40}$/.test(b.executionCodeSha)
    || !same(w.manifest.scope, b.scope) || !b.previousPublication || !HASH.test(b.previousPublication.receiptSha256)
    || !Number.isSafeInteger(b.publicProducts) || b.publicProducts < 0
    || !Number.isSafeInteger(b.heldProducts) || b.heldProducts < 0) fail('binding');
  const cp = await w.readCheckpoint({ controlOnly: true }), c = cp?.checkpoint.control?.publication;
  if (!cp || !HASH.test(cp.sha256) || cp.checkpoint.phase !== 'finalized' || cp.checkpoint.owner !== null
    || !c || c.stage !== 'published' || c.configSha256 !== b.publicationConfigSha256 || c.runReference !== b.runId
    || !c.intent || !c.publication || !c.permit?.mutationOwner || !HASH.test(c.packageSha256 || '') || !c.versionReference || !c.deploymentId
    || c.intent.releaseId !== b.runId || c.intent.catalogRevision !== b.runId || c.intent.codeSha !== b.executionCodeSha
    || c.intent.priorReleaseId !== b.previousPublication.releaseId || !HASH.test(c.receiptSha256 || '')
    || c.build.requestId !== c.requestId || sha256(encodeBuildRequest(c.build.request)) !== c.requestId
    || c.build.request.environment !== b.scope.environment || c.build.request.sourceRevision !== b.runId
    || c.build.request.codeSha !== b.executionCodeSha || c.build.request.sourceDigest !== c.intent.catalogSnapshotSha256
    || c.build.runReference !== c.runReference || c.permit.runReference !== c.build.runReference || c.permit.token !== c.build.token
    || encodePublicationIntent(c.publication.intent) !== encodePublicationIntent(c.intent)
    || c.permit.requestId !== c.requestId || c.permit.releaseId !== b.runId || c.permit.versionReference !== c.versionReference
    || c.permit.mutationOwner.environment !== b.scope.environment || c.permit.mutationOwner.indexName !== b.scope.indexName) fail('checkpoint');
  mutationFenceQuery(c.permit.mutationOwner, ['activating']);
  const seal = await w.catalogSuccessor(); if (!seal || seal.kind!=='approved-catalog-seal') fail('seal');
  try { catalogSuccessorBytes(seal); } catch { fail('seal'); }
  const envelope = JSON.parse(seal.envelopeJson);
  if (seal.publication.releaseId !== b.runId || seal.snapshotSha256 !== c.intent.catalogSnapshotSha256
    || !seal.persistent || seal.persistent.request.codeSha !== b.executionCodeSha || seal.persistent.request.environment !== b.scope.environment
    || seal.persistent.request.sourceRevision !== b.runId || seal.persistent.request.sourceDigest !== seal.snapshotSha256
    || seal.persistent.request.priorReleaseId !== b.previousPublication.releaseId
    || seal.persistent.generation !== c.permit.mutationOwner.generation
    || seal.persistent.priorRow.release_id !== b.previousPublication.releaseId
    || sha256(canonicalJson(seal.persistent.priorRow)) !== b.previousPublication.receiptSha256
    || JSON.parse(String(seal.persistent.priorRow.manifest_json)).manifestSha256 !== b.previous.manifestSha256
    || seal.projectionReceipt.catalog_revision !== b.runId || envelope.products.length !== b.publicProducts
    || envelope.heldProducts.length !== b.heldProducts) fail('seal');
  const before = await w.budget(); budget(before);
  const observed = await options.observe({ releaseId: b.runId, requestId: c.requestId });
  const after = await w.budget(); budget(after);
  if (Object.keys(before).some(key => after[key as keyof BudgetTotals] < before[key as keyof BudgetTotals])
    || after.knownRowsWritten !== before.knownRowsWritten || after.httpRequests < before.httpRequests + 2
    || after.sqlStatements < before.sqlStatements + 3) fail('accounting');
  if (after.unconfirmedRequests !== before.unconfirmedRequests) fail('observation_unknown');
  const at = canonicalTime((options.now || (() => new Date().toISOString()))()), age = Date.parse(at) - Date.parse(canonicalTime(observed.observedAt));
  if (age < 0 || age > 30_000) fail('observation_stale');
  const { receipt: r, build, scope: s, publicIdentity: identity } = observed;
  if (!r || sha256(canonicalJson(r)) !== seal.publication.receiptSha256 || r.release_id !== b.runId
    || r.catalog_revision !== b.runId || r.code_sha !== b.executionCodeSha || r.manifest_json !== encodePublicationIntent(c.intent)
    || Date.parse(canonicalTime(r.completed_at)) > Date.parse(observed.observedAt)
    || Date.parse(canonicalTime(r.completed_at)) < Date.parse(c.build.request.capturedAt)) fail('receipt');
  const privateReceipt = { schemaVersion: 1, environment: b.scope.environment, accountId: b.scope.accountId,
    workerName: b.scope.workerName, releaseId: b.runId, versionReference: c.versionReference, requestId: c.requestId, intent: c.intent };
  if (sha256(canonicalJson(privateReceipt)) !== c.receiptSha256 || !build || build.request_id !== c.requestId
    || build.environment !== b.scope.environment || build.source_revision !== b.runId || build.state !== 'resolved'
    || build.request_json !== encodeBuildRequest(c.build.request) || build.lease_token !== c.permit.token || build.lease_until !== null
    || build.run_reference !== c.permit.runReference || build.release_id !== b.runId
    || build.version_reference !== c.versionReference || build.error_code !== null) fail('resolved_build');
  const activationOwner = c.permit.mutationOwner;
  // Normal finalization claims the next generation and appends exactly one
  // telemetry-finish operation. An unrelated later owner is not this handoff.
  if (!s || s.environment !== b.scope.environment || s.index_name !== b.scope.indexName || s.phase !== 'idle'
    || s.external_pending !== 0 || s.generation !== activationOwner.generation + 1 || s.mutation_epoch !== activationOwner.epoch + 1
    || ['owner_token', 'owner_reference', 'operation_key', 'captured_at', 'activation_request_id'].some(key => s[key] !== null)
    || Date.parse(at) - Date.parse(canonicalTime(s.observed_at)) < 0
    || Date.parse(at) - Date.parse(canonicalTime(s.observed_at)) > 30_000) fail('idle_scope');
  if (!identity || !same(identity, { release_id: b.runId, code_sha: b.executionCodeSha, catalog_revision: b.runId,
    catalog_snapshot_sha256: seal.snapshotSha256, manifest_sha256: c.intent.manifestSha256 })) fail('public_identity');
  if (!same(await w.readCheckpoint({ controlOnly: true }), cp) || !same(await w.catalogSuccessor(), seal)) fail('checkpoint_drift');
  const pointerBefore = await store.readPointer(); pointer(pointerBefore);
  await w.assertHeld();
  const control = await store.putControl(seal), next = { control, versionReference: c.versionReference, manifestSha256: c.intent.manifestSha256 };
  pointer(next);
  if (!same(pointerBefore, b.previous) && !same(pointerBefore, next)) fail('pointer_conflict');
  const success = { schemaVersion: 1, kind: 'editorial-recovery-successor', runId: b.runId,
    originalConfigSha256: b.originalConfigSha256, originalCodeSha: b.originalCodeSha,
    publicationConfigSha256: b.publicationConfigSha256, executionCodeSha: b.executionCodeSha,
    checkpointSha256: cp.sha256, receiptSha256: seal.publication.receiptSha256,
    originalPrevious: b.previous, next };
  await store.putObservation({ schemaVersion: 1, kind: 'accounted-editorial-successor-observation', successSha256: sha256(canonicalJson(success)),
    observedAt: observed.observedAt, before, after, observationSha256: sha256(canonicalJson(observed)) });
  await store.putSuccess(success);
  await w.assertHeld();
  if (Date.parse((options.now || (() => new Date().toISOString()))()) - Date.parse(observed.observedAt) > 30_000) fail('observation_stale');
  await store.compareAndSwapPointer(b.previous, next);
  if (!same(await store.readPointer(), next)) fail('pointer_readback');
  return { state: 'reconciled' as const, next, receiptSha256: seal.publication.receiptSha256, budget: after };
}

/** Private filesystem implementation. The caller holds the original workspace
 * lock across this whole operation; the pointer CAS checks its complete tuple.
 * Immutable files and post-rename readback make lost local ACKs idempotent. */
export async function createEditorialSuccessorFiles(careDirectory: string, dailyDirectory: string): Promise<EditorialSuccessorStore> {
  if (dirname(dailyDirectory) !== careDirectory) fail('private_path');
  async function directory(path: string) {
    if (!isAbsolute(path) || normalize(path) !== path || await realpath(path) !== path) fail('private_path');
    const s = await lstat(path); if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o777) !== 0o700) fail('private_path');
  }
  await directory(careDirectory); await directory(dailyDirectory);
  async function read(path: string): Promise<Buffer> {
    const s = await lstat(path); if (!s.isFile() || s.isSymbolicLink() || s.uid !== process.getuid?.() || s.nlink !== 1
      || (s.mode & 0o777) !== 0o600 || s.size > 10 * 1024 * 1024) fail('private_file');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const actual = await file.stat(); if (actual.ino !== s.ino || actual.dev !== s.dev || actual.nlink !== 1) fail('private_file');
      return await file.readFile(); } finally { await file.close(); }
  }
  const bytes = (value: unknown) => Buffer.from(canonicalJson(value) + '\n');
  async function immutable(path: string, value: unknown) {
    await directory(dailyDirectory); const body = bytes(value); let file;
    try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await read(path)).equals(body)) fail('immutable_changed'); return; }
    try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
    const dir = await open(dailyDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await dir.sync(); } finally { await dir.close(); }
    if (!(await read(path)).equals(body)) fail('immutable_readback');
  }
  const pointerPath = join(careDirectory, 'last-success.json'), controlPath = join(dailyDirectory, 'catalog-control.json');
  const readPointer = async () => { await directory(careDirectory); const p = JSON.parse((await read(pointerPath)).toString()) as EditorialSuccessorPointer; pointer(p); return p; };
  return {
    readPointer,
    async putControl(seal) { await immutable(controlPath, seal); return { path: controlPath, sha256: sha256(bytes(seal).toString('utf8')) }; },
    async putObservation(value) { await immutable(join(dailyDirectory, 'successor-observation-' + sha256(canonicalJson(value)) + '.json'), value); },
    async putSuccess(value) { await immutable(join(dailyDirectory, 'editorial-recovery-success.json'), value); },
    async compareAndSwapPointer(previous, next) {
      const current = await readPointer(); if (same(current, next)) return; if (!same(current, previous)) fail('pointer_conflict');
      const temporary = join(dailyDirectory, 'successor-pointer-' + sha256(canonicalJson(next)) + '.json'); await immutable(temporary, next);
      if (!same(await readPointer(), previous)) fail('pointer_conflict');
      await rename(temporary, pointerPath);
      const dir = await open(careDirectory, constants.O_RDONLY | constants.O_DIRECTORY); try { await dir.sync(); } finally { await dir.close(); }
      if (!same(await readPointer(), next)) fail('pointer_readback');
    },
  };
}
