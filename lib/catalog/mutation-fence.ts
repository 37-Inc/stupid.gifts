import type { CatalogD1, D1Statement } from './storage/d1.ts';
import { canonicalTime } from './snapshot.ts';
import {canonicalJson} from './canonical-json.ts';

export interface MutationScope { environment: 'staging' | 'production'; indexName: string }
export interface MutationOwner extends MutationScope {
  token: string; generation: number; epoch: number; phase: 'writing' | 'freezing' | 'activating';
  ownerReference: string; operationKey: string; capturedAt: string;
}
export interface MutationQuery { sql: string; params: unknown[] }
type ScopeRow = { environment: string; index_name: string; owner_token: string; generation: number; mutation_epoch: number;
  phase: MutationOwner['phase'] | 'idle'; owner_reference: string; operation_key: string; captured_at: string; external_pending: number };
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const KEY = /^[a-zA-Z0-9._:/-]{1,200}$/;
const HASH = /^[a-f0-9]{64}$/;

function scope(value: MutationScope): void {
  if (!value || !['staging','production'].includes(value.environment) || typeof value.indexName !== 'string'
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(value.indexName)) throw new Error('invalid_mutation_scope');
}
function owner(value: MutationOwner): void {
  scope(value);
  if (typeof value.token !== 'string' || !KEY.test(value.token) || typeof value.ownerReference !== 'string' || !KEY.test(value.ownerReference)
    || !HASH.test(value.operationKey) || !['writing','freezing','activating'].includes(value.phase)
    || !Number.isSafeInteger(value.generation) || value.generation < 1
    || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || value.epoch >= Number.MAX_SAFE_INTEGER)
    throw new Error('invalid_mutation_owner');
  canonicalTime(value.capturedAt);
}
function decoded(row: ScopeRow): MutationOwner {
  const value: MutationOwner = { environment: row.environment as MutationScope['environment'], indexName: row.index_name,
    token: row.owner_token, generation: row.generation, epoch: row.mutation_epoch, phase: row.phase as MutationOwner['phase'],
    ownerReference: row.owner_reference, operationKey: row.operation_key, capturedAt: row.captured_at };
  owner(value); return value;
}
export async function readMutationOwner(db: CatalogD1, value: MutationScope): Promise<MutationOwner | null> {
  scope(value);
  const row = (await db.prepare('SELECT * FROM catalog_mutation_scopes WHERE environment=? AND index_name=?')
    .bind(value.environment, value.indexName).all<ScopeRow>()).results[0];
  return row && row.phase !== 'idle' ? decoded(row) : null;
}
/** Claim only explicitly enabled idle ownership. No lease/timer takeover: a lost
 * response is recovered by the same immutable operation key and run reference.
 * Provider uncertainty must be settled before release, never guessed from age.
 */
export async function claimMutationOwnership(db: CatalogD1, value: MutationScope, request: {
  phase: 'writing' | 'freezing'; ownerReference: string; operationKey: string;
}): Promise<MutationOwner | null> {
  scope(value);
  if (!request || !['writing','freezing'].includes(request.phase) || typeof request.ownerReference !== 'string'
    || !KEY.test(request.ownerReference) || !HASH.test(request.operationKey))
    throw new Error('invalid_mutation_claim');
  const token = crypto.randomUUID();
  try {
    await db.prepare(`UPDATE catalog_mutation_scopes SET phase=?,owner_token=?,owner_reference=?,operation_key=?,
      captured_at=${NOW},generation=generation+1 WHERE environment=? AND index_name=? AND phase='idle'
      AND generation<9007199254740990 AND NOT EXISTS(SELECT 1 FROM catalog_build_requests WHERE environment=? AND state='activating')`)
      .bind(request.phase, token, request.ownerReference, request.operationKey, value.environment, value.indexName, value.environment).run();
  } catch { /* Read exact persisted identity after an uncertain D1 response. */ }
  const actual = await readMutationOwner(db, value);
  return actual?.ownerReference === request.ownerReference && actual.operationKey === request.operationKey
    && actual.phase === request.phase ? actual : null;
}
export function mutationFenceQuery(value: MutationOwner, phases: MutationOwner['phase'][] = ['writing']): MutationQuery {
  owner(value);
  if (!phases.includes(value.phase)) throw new Error('mutation_phase_mismatch');
  return { sql: `EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND owner_token=?
      AND generation=? AND mutation_epoch=? AND phase=? AND owner_reference=? AND operation_key=? AND external_pending=?)`,
    params: [value.environment, value.indexName, value.token, value.generation, value.epoch, value.phase, value.ownerReference, value.operationKey,
      value.phase === 'activating' ? 1 : 0] };
}
/** Read-only hydration may observe its ONE genuinely journaled pending vector.
 * Never use this predicate for writes, a new claim or publication acceptance. */
export function pendingVectorReadFence(value:MutationOwner):MutationQuery{
  const base=mutationFenceQuery(value,[value.phase]);
  const pending={...base,params:[...base.params.slice(0,-1),1]};
  return{sql:`(${base.sql} OR (${pending.sql} AND (SELECT count(*) FROM catalog_vector_deliveries
    WHERE environment=? AND index_name=? AND generation=? AND prior_epoch=? AND owner_json=?
      AND status='pending' AND dispatch_token IS NOT NULL AND json_extract(request_json,'$.kind') IN('prune','outbox'))=1))`,
    params:[...base.params,...pending.params,value.environment,value.indexName,value.generation,value.epoch-1,
      canonicalJson({...value,epoch:value.epoch-1})]};
}
/** JSON's strict parse is a SQLite/D1 batch assertion: false aborts the entire
 * transaction, including earlier writes. The caller reports only a safe code.
 */
export function mutationAssertion(db: CatalogD1, value: MutationOwner, phases: MutationOwner['phase'][] = ['writing']): D1Statement {
  const gate = mutationFenceQuery(value, phases);
  return db.prepare(`SELECT json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'mutation_fenced' END)`).bind(...gate.params);
}
/** Append exact immutable operation-receipt predicate, then assert the next owner
 * epoch in the SAME batch. A missing receipt must not silently advance ownership.
 */
export function mutationAdvance(db: CatalogD1, value: MutationOwner, receipt: MutationQuery): D1Statement {
  const gate = mutationFenceQuery(value, [value.phase]);
  return db.prepare(`UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1
    WHERE environment=? AND index_name=? AND ${gate.sql} AND EXISTS(${receipt.sql})`)
    .bind(value.environment, value.indexName, ...gate.params, ...receipt.params);
}
export async function releaseMutationOwnership(db: CatalogD1, value: MutationOwner): Promise<void> {
  if (value.phase === 'activating') throw new Error('activation_requires_resolution');
  const gate = mutationFenceQuery(value, ['writing','freezing']);
  await db.batch([mutationAssertion(db, value, [value.phase]),
    db.prepare(`UPDATE catalog_mutation_scopes SET phase='idle',owner_token=NULL,owner_reference=NULL,operation_key=NULL,
      captured_at=NULL WHERE environment=? AND index_name=? AND external_pending=0 AND ${gate.sql}`)
      .bind(value.environment, value.indexName, ...gate.params),
    db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=?
      AND phase='idle' AND generation=? AND mutation_epoch=?) THEN 'true' ELSE 'mutation_fenced' END)`)
      .bind(value.environment, value.indexName, value.generation, value.epoch),
  ]);
}
/** Pre0009 schemas remain compatible only until the explicit migration barrier.
 * Installing/enabling ownership requires stopping old code/manual SQL first.
 * Once the table exists, the no-owner predicate executes inside every batch.
 */
export async function legacyMutationGuard(db: CatalogD1): Promise<MutationQuery> {
  const present = (await db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='catalog_mutation_scopes'").all()).results.length;
  return { sql: present ? 'NOT EXISTS(SELECT 1 FROM catalog_mutation_scopes)' : '1', params: [] };
}
export async function legacyMutationBatch(db: CatalogD1, statements: D1Statement[]): Promise<void> {
  const gate = await legacyMutationGuard(db);
  await db.batch([db.prepare(`SELECT json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'mutation_fenced' END)`), ...statements]);
}
export async function assertLegacyMutationAllowed(db: CatalogD1): Promise<void> {
  const gate = await legacyMutationGuard(db);
  if (!(await db.prepare(`SELECT 1 WHERE ${gate.sql}`).all()).results.length) throw new Error('mutation_ownership_required');
}
/** Schema-compatible importing barrier. Only retained, terminal expiry evidence
 * for THIS revision/environment may exclude an explicitly abandoned importer.
 * No 0011 column/table is referenced on the old unowned schema. Installation
 * still requires the stopped-writers migration barrier, not this capability read.
 */
export async function unabandonedImportsQuery(db:CatalogD1,environment:MutationScope['environment'],exceptRevision?:string):Promise<MutationQuery> {
  const supported=(await db.prepare('PRAGMA table_info(catalog_revisions)').all<{name:string}>()).results
    .some(column=>column.name==='abandonment_delivery_id');
  return{sql:`NOT EXISTS(SELECT 1 FROM catalog_revisions c WHERE c.status='importing'
    ${exceptRevision ? 'AND c.revision!=?' : ''} ${supported ? `AND NOT EXISTS(SELECT 1 FROM catalog_vector_deliveries d
      WHERE d.delivery_id=c.abandonment_delivery_id AND d.environment=? AND d.status='complete'
      AND c.abandonment_epoch IS NOT NULL
      AND d.disposition IN('expired','expired_unsubmitted') AND (json_extract(d.request_json,'$.kind')='prune'
        OR (json_extract(d.request_json,'$.kind')='catalog-withdrawal'
          AND json_extract(d.request_json,'$.cutoff')<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND d.attempts=0 AND d.dispatch_token IS NULL AND d.mutation_reference IS NULL))
      AND json_extract(d.request_json,'$.catalogRevision')=c.revision
      AND json_extract(d.request_json,'$.projectionReceipt.source_export_sha256')=c.source_export_sha256)` : ''})`,
  params:[...(exceptRevision?[exceptRevision]:[]),...(supported?[environment]:[])]};
}
