import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

let driver;
async function defaultQuery(...args) {
  const { sql } = await (driver ??= import('@vercel/postgres'));
  return sql.query(...args);
}

/** Existing telemetry semantics, with a driver selected only on the first query.
 * An owned alternative store can close over its run/fence; no environment-based
 * backend selection or scheduling is introduced here.
 */
export function createPostgresCatalogTelemetryStore({ query = defaultQuery } = {}) {
  if (typeof query !== 'function') throw new TypeError('Telemetry query must be a function');
  return Object.freeze({
    startCatalogRun: (options) => startPostgresCatalogRun(query, options),
    finishCatalogRun: (runId, options) => finishPostgresCatalogRun(query, runId, options),
    insertCatalogRunItems: (runId, items) => insertPostgresCatalogRunItems(query, runId, items),
    loadCatalogRun: (runId) => loadPostgresCatalogRun(query, runId),
    loadRecentCatalogRuns: (limit) => loadRecentPostgresCatalogRuns(query, limit),
  });
}

/** @typedef {ReturnType<typeof createPostgresCatalogTelemetryStore>} CatalogTelemetryStore */
let defaultStore;
function defaultTelemetryStore() {
  return defaultStore ??= createPostgresCatalogTelemetryStore();
}

export async function startCatalogRun(options = {}, store = defaultTelemetryStore()) {
  return store.startCatalogRun(options);
}

export async function finishCatalogRun(runId, options = {}, store = defaultTelemetryStore()) {
  return store.finishCatalogRun(runId, options);
}

export async function insertCatalogRunItems(runId, items, store = defaultTelemetryStore()) {
  return store.insertCatalogRunItems(runId, items);
}

export async function loadCatalogRun(runId, store = defaultTelemetryStore()) {
  return store.loadCatalogRun(runId);
}

export async function loadRecentCatalogRuns(limit = 10, store = defaultTelemetryStore()) {
  return store.loadRecentCatalogRuns(limit);
}

export const CATALOG_TELEMETRY_VERSION = 'catalog-telemetry-v2';
export const OPENAI_PRICING_VERSION = 'openai-public-2026-11-02';

// Standard short-context API prices per 1M tokens on 2026-11-02. Unknown or overridden
// models remain visible in usage reports but deliberately receive no estimate.
const OPENAI_PRICING = {
  'gpt-6-luna': { input: 0.10, cachedInput: 0.01, cacheWrite: 0.125, output: 0.50 },
  'gpt-4o-mini': { input: 0.15, cachedInput: 0.075, output: 0.60 },
  'gpt-4o-mini-2024-07-18': { input: 0.15, cachedInput: 0.075, output: 0.60 },
  'text-embedding-3-small': { input: 0.02, cachedInput: 0.02, output: 0 },
};

export const TERMINAL_ITEM_DECISIONS = new Set([
  'ready',
  'needs_review',
  'blocked',
  'duplicate',
  'unavailable',
  'deactivated',
  'refreshed',
  'persisted',
  'rejected',
  'deferred',
  'failed',
  'not_persisted',
]);

function normalizedTelemetryKey(key) {
  return String(key || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

const SENSITIVE_KEYS = new Set([
  'access_token',
  'api_key',
  'authorization',
  'cookie',
  'credential',
  'database_url',
  'password',
  'postgres_url',
  'private_key',
  'refresh_token',
  'secret',
  'session_token',
  'token',
]);

function isSensitiveTelemetryKey(key) {
  const normalized = normalizedTelemetryKey(key);
  return SENSITIVE_KEYS.has(normalized)
    || normalized.endsWith('_api_key')
    || normalized.endsWith('_password')
    || normalized.endsWith('_private_key')
    || normalized.endsWith('_secret')
    || normalized.endsWith('_access_token')
    || normalized.endsWith('_refresh_token')
    || normalized.endsWith('_session_token');
}

export function redactTelemetryText(value) {
  return String(value || '')
    .replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, '[REDACTED_OPENAI_KEY]')
    .replace(/\bAKIA[A-Z0-9]{12,}\b/g, '[REDACTED_AWS_KEY]')
    .replace(/((?:api[_-]?key|authorization|credential|password|secret|token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .slice(0, 2_000);
}

export function sanitizeTelemetryValue(value, key = '') {
  if (isSensitiveTelemetryKey(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeTelemetryValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .slice(0, 100)
      .map(([childKey, childValue]) => [childKey, sanitizeTelemetryValue(childValue, childKey)]));
  }
  if (typeof value === 'string') return redactTelemetryText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  return value === undefined ? null : String(value).slice(0, 500);
}

export function safeCatalogConfig(options = {}) {
  const allowed = [
    'backfillLimit',
    'deactivateAfterDays',
    'deactivateMissing',
    'dryRun',
    'enrichOnly',
    'enrichmentBatchSize',
    'maxNew',
    'maxPrice',
    'minPrice',
    'minQualityScore',
    'perTheme',
    'revalidate',
    'revalidateLimit',
    'skipEnrichment',
    'staleDays',
    'themeLimit',
    'themes',
  ];
  return sanitizeTelemetryValue(Object.fromEntries(allowed
    .filter((key) => options[key] !== undefined)
    .map((key) => [key, options[key]])));
}

export function getGitRevision(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function createUsageLedger() {
  return { models: {} };
}

function usageNumbers(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
  const cachedInputTokens = Number(
    usage.prompt_tokens_details?.cached_tokens
      ?? usage.input_tokens_details?.cached_tokens
      ?? 0
  ) || 0;
  const cacheWriteInputTokens = Number(
    usage.prompt_tokens_details?.cache_write_tokens
      ?? usage.input_tokens_details?.cache_write_tokens
      ?? 0
  ) || 0;
  return {
    inputTokens,
    cachedInputTokens: Math.min(inputTokens, cachedInputTokens),
    cacheWriteInputTokens: Math.min(Math.max(0, inputTokens - cachedInputTokens), Math.max(0, cacheWriteInputTokens)),
    outputTokens,
    totalTokens: Number(usage.total_tokens ?? inputTokens + outputTokens) || 0,
  };
}

export function recordOpenAIUsage(ledger, { model, operation, usage }) {
  if (!ledger || !model || !usage) return;
  const tokens = usageNumbers(usage);
  const current = ledger.models[model] || {
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    operations: {},
  };
  current.requests += 1;
  current.inputTokens += tokens.inputTokens;
  current.cachedInputTokens += tokens.cachedInputTokens;
  if (tokens.cacheWriteInputTokens) current.cacheWriteInputTokens = (current.cacheWriteInputTokens || 0) + tokens.cacheWriteInputTokens;
  current.outputTokens += tokens.outputTokens;
  current.totalTokens += tokens.totalTokens;
  const operationKey = operation || 'unspecified';
  current.operations[operationKey] = (current.operations[operationKey] || 0) + 1;
  ledger.models[model] = current;
}

function modelCost(model, usage) {
  const pricing = OPENAI_PRICING[model];
  if (!pricing) return null;
  const cacheWriteInput = usage.cacheWriteInputTokens || 0;
  if (cacheWriteInput && pricing.cacheWrite === undefined) return null;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens - cacheWriteInput);
  return Number(((
    (uncachedInput * pricing.input)
      + (usage.cachedInputTokens * pricing.cachedInput)
      + (cacheWriteInput * (pricing.cacheWrite || 0))
      + (usage.outputTokens * pricing.output)
  ) / 1_000_000).toFixed(6));
}

export function finalizeUsageLedger(ledger = createUsageLedger()) {
  let estimatedCostUsd = 0;
  const unpricedModels = [];
  const models = Object.fromEntries(Object.entries(ledger.models || {}).map(([model, usage]) => {
    const estimatedModelCostUsd = modelCost(model, usage);
    if (estimatedModelCostUsd === null) unpricedModels.push(model);
    else estimatedCostUsd += estimatedModelCostUsd;
    return [model, { ...usage, estimatedCostUsd: estimatedModelCostUsd }];
  }));
  return {
    provider: 'openai',
    pricingVersion: OPENAI_PRICING_VERSION,
    models,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
    estimateComplete: unpricedModels.length === 0,
    unpricedModels,
  };
}

export function mergeUsageReports(reports = []) {
  const ledger = createUsageLedger();
  for (const report of reports.filter(Boolean)) {
    for (const [model, usage] of Object.entries(report.models || {})) {
      const current = ledger.models[model] || {
        requests: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        operations: {},
      };
      for (const field of ['requests', 'inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens']) {
        current[field] += Number(usage[field] || 0);
      }
      if (usage.cacheWriteInputTokens) current.cacheWriteInputTokens = (current.cacheWriteInputTokens || 0) + usage.cacheWriteInputTokens;
      for (const [operation, count] of Object.entries(usage.operations || {})) {
        current.operations[operation] = (current.operations[operation] || 0) + Number(count || 0);
      }
      ledger.models[model] = current;
    }
  }
  return finalizeUsageLedger(ledger);
}

export function addTiming(timings, phase, elapsedMs) {
  if (!timings || !phase) return;
  timings[phase] = Math.max(0, Math.round(Number(timings[phase] || 0) + Number(elapsedMs || 0)));
}

export function catalogRunItem(product = {}, fields = {}) {
  const reasonCode = String(fields.reasonCode || product.editorialBlockReason || '')
    .split(',')[0]
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || null;
  const slug = fields.slug || product.slug || null;
  return {
    id: randomUUID(),
    phase: fields.phase || 'catalog',
    stage: fields.stage || 'decision',
    decision: fields.decision || product.editorialStatus || 'observed',
    reasonCode,
    productId: fields.productId ?? product.id ?? null,
    externalId: String(fields.externalId ?? product.id ?? 'run').slice(0, 255),
    source: fields.source || product.source || 'amazon',
    sourceQuery: fields.sourceQuery ?? product.sourceQuery ?? null,
    title: fields.title ?? product.title ?? null,
    imageUrl: fields.imageUrl ?? product.imageUrl ?? null,
    affiliateUrl: fields.affiliateUrl ?? product.affiliateUrl ?? null,
    canonicalPath: fields.canonicalPath || (slug ? `/gifts/${encodeURIComponent(slug)}` : null),
    winnerProductId: fields.winnerProductId ?? product.duplicateOfProductId ?? null,
    sourceFactsHash: fields.sourceFactsHash ?? product.sourceFactsHash ?? null,
    editorialSourceHash: fields.editorialSourceHash ?? product.editorialSourceHash ?? null,
    requiresManualReview: fields.requiresManualReview === true,
    nextAction: fields.nextAction || null,
    details: sanitizeTelemetryValue(fields.details || {}),
  };
}

export function createRunItemCollector({
  runId,
  enabled = true,
  warnings = [],
  writeItems = insertCatalogRunItems,
} = {}) {
  const pending = [];
  return {
    record(product, fields) {
      pending.push(catalogRunItem(product, fields));
    },
    get size() {
      return pending.length;
    },
    async flush() {
      if (!enabled || !runId || pending.length === 0) {
        pending.length = 0;
        return;
      }
      const items = pending.slice();
      try {
        await writeItems(runId, items);
        pending.splice(0, items.length);
      } catch (error) {
        warnings.push({
          phase: 'telemetry',
          reasonCode: 'run_item_insert_failed',
          message: redactTelemetryText(error instanceof Error ? error.message : error),
        });
      }
    },
  };
}

async function startPostgresCatalogRun(query, {
  id = randomUUID(),
  mode,
  trigger = 'manual',
  dryRun = false,
  config = {},
  gitSha = getGitRevision(),
} = {}) {
  await query(
    `INSERT INTO catalog_runs (
       id, telemetry_version, mode, trigger, status, dry_run, git_sha, config, started_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'running', $5, $6, $7::jsonb, NOW(), NOW())
     `,
    [id, CATALOG_TELEMETRY_VERSION, mode || 'catalog', trigger, dryRun, gitSha, JSON.stringify(safeCatalogConfig(config))]
  );
  return id;
}

async function finishPostgresCatalogRun(query, runId, {
  status,
  counts = {},
  timingsMs = {},
  usage = {},
  warnings = [],
  error,
} = {}) {
  const safeError = error ? redactTelemetryText(error instanceof Error ? error.message : error) : null;
  const result = await query(
    `UPDATE catalog_runs
     SET status = $2,
         completed_at = NOW(),
         counts = $3::jsonb,
         timings_ms = $4::jsonb,
         usage = $5::jsonb,
         estimated_cost_usd = $6,
         warnings = $7::jsonb,
         error_summary = $8,
         updated_at = NOW()
     WHERE id = $1`,
    [
      runId,
      status || 'completed',
      JSON.stringify(sanitizeTelemetryValue(counts)),
      JSON.stringify(sanitizeTelemetryValue(timingsMs)),
      JSON.stringify(sanitizeTelemetryValue(usage)),
      Number.isFinite(usage?.estimatedCostUsd) ? usage.estimatedCostUsd : null,
      JSON.stringify(sanitizeTelemetryValue(warnings)),
      safeError,
    ]
  );
  if (result.rowCount !== 1) throw new Error(`Catalog run finalization updated ${result.rowCount || 0} rows.`);
}

async function insertPostgresCatalogRunItems(query, runId, items) {
  for (let offset = 0; offset < items.length; offset += 50) {
    const batch = items.slice(offset, offset + 50);
    const values = [];
    const rows = batch.map((item, index) => {
      const start = index * 20;
      values.push(
        item.id || randomUUID(), runId, item.phase, item.stage, item.decision,
        item.reasonCode, item.productId, item.externalId, item.source, item.sourceQuery,
        item.title, item.imageUrl, item.affiliateUrl, item.canonicalPath, item.winnerProductId,
        item.sourceFactsHash, item.editorialSourceHash, item.requiresManualReview,
        item.nextAction, JSON.stringify(sanitizeTelemetryValue(item.details || {}))
      );
      const placeholders = Array.from({ length: 20 }, (_, itemIndex) => `$${start + itemIndex + 1}`);
      placeholders[19] = `${placeholders[19]}::jsonb`;
      return `(${placeholders.join(', ')})`;
    });
    await query(
      `INSERT INTO catalog_run_items (
         id, run_id, phase, stage, decision, reason_code, product_id, external_id, source,
         source_query, title, image_url, affiliate_url, canonical_path, winner_product_id,
         source_facts_hash, editorial_source_hash, requires_manual_review, next_action, details
       ) VALUES ${rows.join(', ')}
       ON CONFLICT (id) DO NOTHING`,
      values
    );
  }
}

export function latestRunItemStates(items = []) {
  const latest = new Map();
  const sorted = [...items].sort((left, right) => (
    Number(left.sequence || 0) - Number(right.sequence || 0)
      || new Date(left.created_at || left.createdAt || 0).getTime()
      - new Date(right.created_at || right.createdAt || 0).getTime()
      || String(left.id || '').localeCompare(String(right.id || ''))
  ));
  for (const item of sorted) {
    latest.set(`${item.phase}:${item.external_id || item.externalId}`, item);
  }
  return [...latest.values()];
}

export function manualInterventionItems(run, items = []) {
  return latestRunItemStates(items).flatMap((item) => {
    const decision = item.decision;
    const requiresManualReview = item.requires_manual_review ?? item.requiresManualReview;
    const interrupted = ['failed', 'partial'].includes(run.status)
      && !TERMINAL_ITEM_DECISIONS.has(decision);
    if (!requiresManualReview && !interrupted && decision !== 'needs_review' && decision !== 'failed') return [];
    return [{
      ...item,
      effectiveDecision: interrupted ? 'interrupted' : decision,
      effectiveNextAction: item.next_action || item.nextAction || (interrupted
        ? 'Inspect the run error, then safely resume or rerun this candidate.'
        : 'Review the factual evidence and draft before approving or revising it.'),
    }];
  });
}

function compactJson(value) {
  return JSON.stringify(value || {});
}

export function formatEstimatedCatalogRunCost(run = {}) {
  const usage = run.usage || {};
  const rawEstimate = run.estimated_cost_usd ?? run.estimatedCostUsd ?? usage.estimatedCostUsd;
  if (rawEstimate === null || rawEstimate === undefined || !Number.isFinite(Number(rawEstimate))) {
    return 'unpriced';
  }
  const partial = usage.estimateComplete === false;
  const unpriced = Array.isArray(usage.unpricedModels) && usage.unpricedModels.length > 0
    ? `; unpriced: ${usage.unpricedModels.join(', ')}`
    : '';
  return `$${Number(rawEstimate).toFixed(6)}${partial ? ` (partial${unpriced})` : ''}`;
}

function manualItemLines(item) {
  const lines = [`- ${item.title || item.external_id || item.externalId}`];
  lines.push(`  phase/decision: ${item.phase}/${item.effectiveDecision}`);
  lines.push(`  reason: ${item.reason_code || item.reasonCode || 'unspecified'}`);
  if (item.canonical_path || item.canonicalPath) lines.push(`  page: https://www.goose.gifts${item.canonical_path || item.canonicalPath}`);
  if (item.image_url || item.imageUrl) lines.push(`  image: ${item.image_url || item.imageUrl}`);
  if (item.affiliate_url || item.affiliateUrl) lines.push(`  retailer: ${item.affiliate_url || item.affiliateUrl}`);
  lines.push(`  next: ${item.effectiveNextAction}`);
  return lines;
}

export function formatManualReviewQueue(run, items = []) {
  const manual = manualInterventionItems(run, items);
  const lines = [`Catalog run ${run.id}`, `Manual intervention: ${manual.length}`];
  if (manual.length === 0) return [...lines, 'No owner action is required.'].join('\n');
  for (const item of manual) lines.push('', ...manualItemLines(item));
  return lines.join('\n');
}

export function formatCatalogRunReport(run, items = []) {
  const latestItems = latestRunItemStates(items);
  const manual = manualInterventionItems(run, items);
  const usage = run.usage || {};
  const outcomeTotals = {};
  const reasonTotals = {};
  for (const item of latestItems) {
    outcomeTotals[item.decision] = (outcomeTotals[item.decision] || 0) + 1;
    const reason = item.reason_code || item.reasonCode;
    if (reason) reasonTotals[reason] = (reasonTotals[reason] || 0) + 1;
  }
  const lines = [
    `Catalog run ${run.id}`,
    `Status: ${run.status} | mode: ${run.mode} | trigger: ${run.trigger} | dry run: ${Boolean(run.dry_run ?? run.dryRun)}`,
    `Started: ${new Date(run.started_at || run.startedAt).toISOString()}${run.completed_at || run.completedAt ? ` | completed: ${new Date(run.completed_at || run.completedAt).toISOString()}` : ''}`,
    `Git: ${run.git_sha || run.gitSha || 'unknown'}`,
    `Counts: ${compactJson(run.counts)}`,
    `Latest item outcomes: ${compactJson(outcomeTotals)}`,
    `Latest reason codes: ${compactJson(reasonTotals)}`,
    `Timings (ms): ${compactJson(run.timings_ms || run.timingsMs)}`,
    `OpenAI usage: ${compactJson(usage.models || {})}`,
    `Pricing basis: ${usage.pricingVersion || 'unavailable'}`,
    `Estimated API cost: ${formatEstimatedCatalogRunCost(run)}`,
    `Manual intervention: ${manual.length}`,
  ];
  if (run.error_summary || run.errorSummary) lines.push(`Error: ${redactTelemetryText(run.error_summary || run.errorSummary)}`);
  for (const item of manual) lines.push('', ...manualItemLines(item));
  return lines.join('\n');
}

async function loadPostgresCatalogRun(query, runId) {
  const runResult = await query('SELECT * FROM catalog_runs WHERE id = $1', [runId]);
  if (!runResult.rows[0]) return null;
  const itemsResult = await query(
    'SELECT * FROM catalog_run_items WHERE run_id = $1 ORDER BY sequence',
    [runId]
  );
  return { run: runResult.rows[0], items: itemsResult.rows };
}

async function loadRecentPostgresCatalogRuns(query, limit = 10) {
  const result = await query(
    'SELECT * FROM catalog_runs ORDER BY started_at DESC LIMIT $1',
    [Math.max(1, Math.min(100, Number(limit) || 10))]
  );
  return result.rows;
}
