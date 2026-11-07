import { createHash } from 'node:crypto';
import { createRunItemCollector, createUsageLedger, finalizeUsageLedger, recordOpenAIUsage } from '../ops/catalog-telemetry.mjs';
import { encodePgvectorSendBase64, decodePgvectorSendBase64 } from './pgvector-binary.ts';
import { productPresentation } from '../../lib/catalog/presentation.ts';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().filter(key => item[key] !== undefined).map(key => [key, item[key]])) : item);
const copy = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const sameOwner = (a, b) => a && b && canonical({ ...a, epoch: 0 }) === canonical({ ...b, epoch: 0 });
const validRef = ref => ref && /^[a-f0-9]{64}$/.test(ref.sha256) && typeof ref.reference === 'string';

/** One RunWorkspace artifact index, not a new database/ownership protocol. The
 * caller saves and mirrors each new head BEFORE returning to an external stage.
 * Original receipt order matters: a later omitted GetItems response revokes its
 * earlier observation. Neither restoring nor reading renews its original time.
 */
export function createReviewedPhaseJournal({ initial, read, put, save, readReceipt = read }) {
  let state = initial ? copy(initial) : { schemaVersion: 1, entries: {}, receipts: [], mutations: {} };
  if (state.schemaVersion !== 1 || Object.keys(state).sort().join(',') !== 'entries,mutations,receipts,schemaVersion'
    || !state.entries || !state.mutations || !Array.isArray(state.receipts)
    || Object.values(state.entries).some(ref => !validRef(ref)) || state.receipts.some(ref => !validRef(ref)))
    throw Error('reviewed_journal_invalid');
  const commit = async next => { await save(copy(next)); state = next; };
  return {
    snapshot: () => copy(state),
    async read(key) { return state.entries[key] ? read(state.entries[key]) : undefined; },
    async put(key, value) {
      if (!/^[a-zA-Z0-9_-]{1,180}$/.test(key)) throw Error('reviewed_journal_key');
      if (state.entries[key]) {
        if (canonical(await read(state.entries[key])) !== canonical(value)) throw Error('reviewed_journal_conflict');
        return;
      }
      const ref = await put(value);
      if (!validRef(ref)) throw Error('reviewed_journal_invalid');
      await commit({ ...state, entries: { ...state.entries, [key]: ref } });
    },
    async receipt(ref) {
      if (!validRef(ref)) throw Error('reviewed_journal_invalid');
      await commit({ ...state, receipts: [...state.receipts, copy(ref)] });
    },
    async restore(evidence) { for (const ref of state.receipts) await evidence.restoreReceipt(ref); },
    async embeddingResponse(request, response) {
      // JSON stage artifacts cannot preserve negative zero. The original
      // protected native receipt is authoritative, not a rounded JS replay.
      for (const ref of [...state.receipts].reverse()) {
        const receipt = await readReceipt(ref);
        if (receipt.kind !== 'embedding-response' || receipt.model !== request.model
          || canonical(receipt.products.map(p => p.text)) !== canonical(request.input)) continue;
        if (receipt.model !== response.model || !Array.isArray(response.data) || response.data.length !== receipt.products.length)
          throw Error('reviewed_embedding_unconfirmed');
        const data = response.data.map((item, index) => {
          const binding = receipt.products[index], values = decodePgvectorSendBase64(binding.nativeBase64);
          if (item.index !== index || !Array.isArray(item.embedding) || item.embedding.length !== values.length
            || item.embedding.some((value, i) => typeof value !== 'number' || !Number.isFinite(value) || Math.fround(value) !== values[i])
            || createHash('sha256').update(Buffer.from(binding.nativeBase64, 'base64')).digest('hex') !== binding.vectorBytesSha256)
            throw Error('reviewed_embedding_unconfirmed');
          return { ...item, embedding: values };
        });
        return { ...response, data };
      }
      throw Error('reviewed_embedding_unconfirmed');
    },
    async beforeMutation(input) {
      if (!/^[a-f0-9]{64}$/.test(input.operationId) || !/^[a-f0-9]{64}$/.test(input.inputSha256)
        || !Number.isSafeInteger(input.owner?.epoch) || input.owner.phase !== 'writing') throw Error('reviewed_mutation_invalid');
      const prior = state.mutations[input.operationId];
      if (prior) {
        if (prior.inputSha256 !== input.inputSha256 || !sameOwner(prior.owner, input.owner) || prior.owner.epoch > input.owner.epoch)
          throw Error('reviewed_mutation_conflict');
        return;
      }
      await commit({ ...state, mutations: { ...state.mutations, [input.operationId]: copy(input) } });
    },
    async usage() {
      const ledger = createUsageLedger(), unknown = [];
      for (const key of Object.keys(state.entries)) {
        if (!key.endsWith('-result') && !key.endsWith('-dispatch')) continue;
        const item = await read(state.entries[key]);
        const model = ['copy-draft', 'copy-review', 'embedding', 'discovery-review', 'homepage-selection'].includes(item.stage);
        const supplier = ['refresh-collect', 'discovery-collect'].includes(item.stage);
        if (!model && !supplier) continue;
        if (key.endsWith('-dispatch')) {
          if (!state.entries[key.replace(/-dispatch$/, '-result')]) unknown.push({ provider: supplier ? 'amazon' : 'openai', stage: item.stage, inputSha256: item.inputSha256 });
          continue;
        }
        if (!model) continue;
        const response = item.value;
        recordOpenAIUsage(ledger, { model: response.model || (item.stage === 'embedding' ? 'text-embedding-3-small' : 'gpt-6-luna'),
          operation: item.stage, usage: response.usage });
      }
      const reported = finalizeUsageLedger(ledger);
      return { ...reported, ...(unknown.some(item => item.provider === 'openai')
        ? { knownEstimatedCostUsd: reported.estimatedCostUsd, estimatedCostUsd: null } : {}), unknownDispatches: unknown };
    },
  };
}

/** Do not adopt an arbitrary current epoch. Every advancement from the last
 * checkpoint must be an exact immutable receipt journalled before its dispatch.
 * No takeover, lease expiry, second mutation or new operation is performed here.
 */
export async function reconcileReviewedPhaseOwner({ db, owner, actual, journal, runId, catalogRevision }) {
  if (!sameOwner(owner, actual) || actual.phase !== 'writing' || actual.epoch < owner.epoch || actual.epoch - owner.epoch > 10000)
    throw Error('reviewed_owner_unconfirmed');
  const intents = journal.snapshot().mutations;
  for (let epoch = owner.epoch; epoch < actual.epoch; epoch++) {
    const rows = (await db.prepare(`SELECT operation_id,input_sha256,run_id,catalog_revision,generation,prior_epoch,next_epoch
      FROM catalog_maintenance_operations WHERE environment=? AND index_name=? AND generation=? AND prior_epoch=?`)
      .bind(owner.environment, owner.indexName, owner.generation, epoch).all()).results;
    const receipt = rows[0], pending = receipt && intents[receipt.operation_id];
    if (rows.length !== 1 || !pending || pending.inputSha256 !== receipt.input_sha256 || pending.owner.epoch !== epoch
      || !sameOwner(pending.owner, owner) || receipt.run_id !== runId || receipt.catalog_revision !== catalogRevision
      || receipt.next_epoch !== epoch + 1) throw Error('reviewed_owner_unconfirmed');
  }
  return actual;
}

/** Prepare against read-only current catalog capabilities. Save the exact calls,
 * evidence intents and telemetry UUIDs before the FIRST product mutation. On a
 * restart, provider/model results can be reused while uncommitted preparation is
 * rebuilt; a saved preparation is applied verbatim through existing D1 receipts.
 */
export async function prepareReviewedPhase({ key, journal, execute, options, store, evidence, runId }) {
  const saved = await journal.read(`${key}-prepared`);
  if (saved) return saved;
  const mutations = [], items = [], warnings = [], timingsMs = {}, usage = createUsageLedger();
  let identities;
  const catalog = async () => identities ??= await store.getActiveCatalogIdentities({ includeInactive: true });
  const existing = new Set(options.dailyRefresh ? options.selectedIds : (await catalog()).map(p => p.id));
  const record = async (method, args) => {
    const intent = await evidence.intent(method, args);
    const nativeBase64 = method === 'upsertProduct' && Array.isArray(args[0].embedding) ? encodePgvectorSendBase64(args[0].embedding.map(Math.fround)) : null;
    mutations.push({ method, args: copy(args), intent: copy(intent), ...(nativeBase64 ? { nativeBase64 } : {}) });
  };
  const recording = { ...store,
    async getActiveCatalogIdentities() { return copy(await catalog()); },
    async upsertProduct(product, sourceHash) {
      await record('upsertProduct', [product, sourceHash]);
      const inserted = !existing.has(product.id); existing.add(product.id);
      return { inserted, slug: product.slug || null };
    },
    async recordEditorialEvent(event) { await record('recordEditorialEvent', [event]); },
    async markConfirmedMissingUnavailable(ids) { await record('markConfirmedMissingUnavailable', [ids]); return [...ids]; },
    async deactivateConfirmedMissing() { throw Error('automation_catalog_deletion_forbidden'); },
    async markCatalogDuplicate() { throw Error('discovery_existing_mutation_forbidden'); },
    async updateAmazonAffiliateUrl() { throw Error('daily_global_affiliate_repair_forbidden'); },
  };
  const telemetry = { runId, warnings, timingsMs, usage, items: createRunItemCollector({ runId, warnings,
    writeItems: async (_id, batch) => { items.push(...copy(batch)); } }) };
  let result;
  try { result = await execute(options, undefined, telemetry, recording, evidence); }
  catch (error) {
    if (error.message !== 'editorial_dispatch_uncertain') throw error;
    // Preparation has made no product write. Retain precise unknown dispatches
    // in the journal, defer this chunk, and keep unrelated good work usable.
    await telemetry.items.flush();
    const selected = new Map(items.filter(item => item.decision === 'selected' || item.stage === 'editorial_admission' && item.decision === 'admit')
      .map(item => [item.productId || item.externalId, item]));
    for (const [id, item] of selected) telemetry.items.record({ id, source: item.source, title: item.title, imageUrl: item.imageUrl }, {
      phase: item.phase, stage: 'provider_preparation', decision: 'deferred', reasonCode: 'unconfirmed_provider_dispatch',
      nextAction: 'Keep this listing unchanged; retain unknown usage and do not repeat supplier or model work in this run.',
    });
    result = { deferred: true, knownDeferredCandidates: selected.size };
    mutations.length = 0;
    warnings.push({ phase: 'provider_preparation', reasonCode: /^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'provider_stage_failed' });
  }
  await telemetry.items.flush();
  const appeal = new Map(items.filter(item => item.stage === 'editorial_admission' && item.decision === 'admit')
    .map(item => [item.productId || item.externalId, item.details.appeal]));
  const merchandising = {};
  for (const mutation of mutations) {
    if (mutation.method !== 'upsertProduct') continue;
    const product = mutation.args[0];
    if (!appeal.has(product.id) || !['short_ready', 'ready', 'approved', 'manual_locked'].includes(product.editorialStatus)) continue;
    const view = productPresentation(product);
    merchandising[product.id] = { sourceTitle: view.title, sourceDescription: view.description, appeal: appeal.get(product.id) };
  }
  const prepared = { schemaVersion: 1, result, mutations, items, warnings, timingsMs, merchandising };
  await journal.put(`${key}-prepared`, prepared);
  return prepared;
}

export async function applyReviewedPhase({ key, journal, prepared, store, telemetryStore, runId, withIntent, checkpoint }) {
  if (await journal.read(`${key}-applied`)) return;
  for (const mutation of prepared.mutations) {
    const args = copy(mutation.args);
    if (mutation.nativeBase64) args[0].embedding = decodePgvectorSendBase64(mutation.nativeBase64);
    if (!['upsertProduct', 'recordEditorialEvent', 'markConfirmedMissingUnavailable'].includes(mutation.method)) throw Error('reviewed_preparation_invalid');
    await withIntent(mutation.intent, () => store[mutation.method](...args));
    await checkpoint();
  }
  for (let offset = 0; offset < prepared.items.length; offset += 20) {
    await telemetryStore.insertCatalogRunItems(runId, prepared.items.slice(offset, offset + 20));
    await checkpoint();
  }
  await journal.put(`${key}-applied`, { schemaVersion: 1, preparationSha256: hash(prepared) });
}
