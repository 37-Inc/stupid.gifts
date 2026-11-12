#!/usr/bin/env node

// One existing scheduled owner, not a scheduler. Each explicit run has its own
// reservation; retries never refund or repeat that run's provider phases.
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { executeCatalog, parseArgs, runCatalogWithBackend } from './prefetch-catalog.mjs';
import { createPostgresCatalogMaintenanceStore } from './catalog-maintenance-postgres.mjs';
import { createPostgresCatalogTelemetryStore, createRunItemCollector, createUsageLedger, finalizeUsageLedger, getGitRevision } from './catalog-telemetry.mjs';
import { invalidateCatalogCaches } from './catalog-cache-invalidation.mjs';
import {searchDemandTopic} from '../../lib/search-demand.ts';

export const CATALOG_CADENCE_ROOT = join(homedir(), '.codex/private/goose-gifts-migration/weekly-runs');
const ASIN = /^[A-Z0-9]{10}$/;
const clock = () => new Date().toISOString();

export function pacificCatalogCalendar(now = clock()) {
  const instant = new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new Error('cadence_clock_invalid');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).formatToParts(instant).map(p => [p.type, p.value]));
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (weekday + 6) % 7);
  return { day, week: monday.toISOString().slice(0, 10), monday: weekday === 1 };
}

async function privateDirectory(directory, repository, create) {
  if (!isAbsolute(directory)) throw new Error('cadence_private_directory');
  // Refuse symlinked parents and repository-local evidence, including a root
  // that does not exist yet. Do not silently chmod an existing unsafe folder.
  let current = '/';
  for (const part of resolve(directory).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(current, { mode: 0o700 }); stat = await lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('cadence_private_directory');
  }
  const actual = await realpath(directory), repo = await realpath(repository);
  const inside = relative(repo, actual), stat = await lstat(actual);
  if (inside === '' || !inside.startsWith('..') && !isAbsolute(inside) || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('cadence_private_directory');
  return true;
}

export function validCatalogRunKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value);
}

export async function withCatalogCadence({ workspace, repository, now = clock, dryRun = false, runKey }, action) {
  if (runKey !== undefined && !validCatalogRunKey(runKey)) throw new Error('cadence_run_key_invalid');
  const calendar = pacificCatalogCalendar(now());
  if (dryRun) return action({ calendar, runKey, plan: async () => ({ daily: true, discovery: calendar.monday }), dryRun: true });
  await privateDirectory(workspace, repository, true);
  const directory = join(workspace, 'cadence');
  await privateDirectory(directory, repository, true);
  const lockPath = join(directory, 'owner.lock');
  const lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    .catch(error => { if (error.code === 'EEXIST') throw new Error('cadence_owner_busy_requires_review'); throw error; });
  const lockIdentity = await lock.stat();
  const assertDay = () => { if (pacificCatalogCalendar(now()).day !== calendar.day) throw new Error('cadence_day_changed'); };
  // Old sealed configurations retain their original day/week reservations.
  // New configurations bind reservations to the run, not a global daily quota.
  const key = kind => runKey ?? (kind === 'daily' ? calendar.day : calendar.week);
  const filename = kind => join(directory, `${kind}-${runKey ? 'run-' : ''}${key(kind)}.json`);
  async function reserved(kind) {
    let handle;
    try { handle = await open(filename(kind), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > 2048) throw new Error('cadence_reservation_invalid');
      const value = JSON.parse(await handle.readFile('utf8'));
      if (value.schemaVersion !== 1 || value.kind !== kind || value.key !== key(kind)
        || !/^[A-Za-z0-9._:/-]{1,200}$/.test(value.runId) || runKey && value.runId !== runKey
        || pacificCatalogCalendar(value.reservedAt).day !== (runKey || kind === 'daily' ? calendar.day : calendar.week)
        || value.maximumExisting !== (kind === 'daily' ? 10 : 0)) throw new Error('cadence_reservation_invalid');
      return true;
    } finally { await handle.close(); }
  }
  const cadence = { calendar, runKey, assertDay, async plan() {
    assertDay(); return { daily: !await reserved('daily'), discovery: calendar.monday && !await reserved('discovery') };
  }, async reserve(kind, runId) {
    assertDay();
    if (!['daily', 'discovery'].includes(kind) || kind === 'discovery' && !calendar.monday
      || !/^[A-Za-z0-9._:/-]{1,200}$/.test(runId) || runKey && runId !== runKey) throw new Error('cadence_reservation_invalid');
    const handle = await open(filename(kind), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(`${JSON.stringify({ schemaVersion: 1, kind, key: key(kind),
      runId, reservedAt: now(), maximumExisting: kind === 'daily' ? 10 : 0 })}\n`); await handle.sync(); }
    finally { await handle.close(); }
    const parent = await open(directory, constants.O_RDONLY); try { await parent.sync(); } finally { await parent.close(); }
  } };
  try { return await action(cadence); }
  finally {
    await lock.close();
    const current = await lstat(lockPath);
    if (current.ino !== lockIdentity.ino || current.dev !== lockIdentity.dev) throw new Error('cadence_owner_changed_requires_review');
    await unlink(lockPath);
  }
}

export async function dailyCatalogPhases(cadence, featuredIds = [], photosOnly = false, admitAsins) {
  if (!Array.isArray(featuredIds) || featuredIds.length > 100 || new Set(featuredIds).size !== featuredIds.length || featuredIds.some(id => !ASIN.test(id)))
    throw new Error('daily_featured_ids_invalid');
  const plan = await cadence.plan(), phases = [];
  // Explicit owner-picked admissions reuse the normal new-only review/delivery
  // pipeline, without unrelated searches or an existing-product refresh batch.
  if (admitAsins !== undefined) {
    if (photosOnly || !Array.isArray(admitAsins) || !admitAsins.length || admitAsins.length > 10
      || new Set(admitAsins).size !== admitAsins.length || admitAsins.some(id => !ASIN.test(id))) throw new Error('admission_asins_invalid');
    return plan.daily ? [exactProductAdmissionPhase(admitAsins)] : [];
  }
  if (plan.daily) phases.push({ ...parseArgs(['--revalidate', '--revalidate-limit', '10', '--backfill-limit', '0', '--skip-enrichment']),
    dailyRefresh: true, ...(photosOnly ? { photosOnly: true } : {}), enrichSelectedExisting: !photosOnly && cadence.calendar.monday,
    discoveryNewOnly: false, featuredIds, assertRefreshDay: cadence.assertDay });
  if (plan.discovery && !photosOnly) phases.push({ ...parseArgs(['--theme-limit', '6', '--per-theme', '10', '--max-new', '20', '--min-quality-score', '0.65', '--backfill-limit', '0']),
    discoveryNewOnly: true, enrichSelectedExisting: false, discoveryRunKey: cadence.runKey });
  return phases;
}

/** Staff additions and daily discovery use the same short-copy preparation.
 * A durable run/request identity owns retry protection, not a daily allowance. */
export function exactProductAdmissionPhase(asins) {
  if (!Array.isArray(asins) || !asins.length || asins.length > 10 || new Set(asins).size !== asins.length
    || asins.some(id => !ASIN.test(id))) throw Error('admission_asins_invalid');
  return { ...parseArgs(['--max-new', String(asins.length), '--backfill-limit', '0']),
    admitAsins: [...asins], discoveryNewOnly: true, enrichSelectedExisting: false, deactivateMissing: false };
}

/** Explicit successor policy only. The immutable run pins its finite work set;
 * legacy day/week reservations and their ten/twenty-item policy stay unchanged.
 * 10,000 is the existing captured-catalog transport bound, not an admission quota.
 */
export function validateCatalogAutomation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== `discovery,${Object.hasOwn(value,'leadAsins')?'leadAsins,':''}refreshIds,schemaVersion${Object.hasOwn(value,'searchTopics')?',searchTopics':''}`
    || value.schemaVersion !== 1 || typeof value.discovery !== 'boolean'
    || !Array.isArray(value.refreshIds) || value.refreshIds.length > 10000
    || new Set(value.refreshIds).size !== value.refreshIds.length || value.refreshIds.some(id => typeof id !== 'string' || !ASIN.test(id)))
    throw new Error('catalog_automation_invalid');
  if(value.leadAsins!==undefined&&(!Array.isArray(value.leadAsins)||value.leadAsins.length>10
    ||new Set(value.leadAsins).size!==value.leadAsins.length||value.leadAsins.some(id=>typeof id!=='string'||!ASIN.test(id)))
    ||value.searchTopics!==undefined&&(!Array.isArray(value.searchTopics)||value.searchTopics.length>2
      ||new Set(value.searchTopics).size!==value.searchTopics.length||value.searchTopics.some(topic=>searchDemandTopic(topic)!==topic))
    ||!value.discovery&&(value.leadAsins?.length||value.searchTopics?.length))throw new Error('catalog_automation_invalid');
  return structuredClone(value);
}

/** @param {unknown} value
 * @param {{runId?:string,photosOnly?:boolean}} [options] */
export function automatedCatalogPhases(value, options = {}) {
  const { runId, photosOnly = false } = options;
  const policy = validateCatalogAutomation(value);
  if (!validCatalogRunKey(runId) || photosOnly && policy.discovery) throw new Error('catalog_automation_invalid');
  const phases = [];
  for (let offset = 0; offset < policy.refreshIds.length; offset += 10) {
    const selectedIds = policy.refreshIds.slice(offset, offset + 10);
    phases.push({ ...parseArgs(['--revalidate', '--revalidate-limit', String(selectedIds.length), '--backfill-limit', '0', '--skip-enrichment']),
      dailyRefresh: true, selectedIds, deactivateMissing: false, enrichSelectedExisting: false,
      ...(photosOnly ? { photosOnly: true } : {}), discoveryNewOnly: false });
  }
  if (policy.discovery) phases.push({ ...parseArgs(['--theme-limit', '6', '--per-theme', '10', '--max-new', '60', '--backfill-limit', '0']),
    discoveryNewOnly: true, enrichSelectedExisting: false, discoveryRunKey: runId, deactivateMissing: false,
    ...(policy.leadAsins?.length?{discoveryLeadAsins:policy.leadAsins}:{}),...(policy.searchTopics?.length?{discoverySearchTopics:policy.searchTopics}:{}) });
  return phases;
}

/** A finite exact-ID firewall, not a second reservation or a taste filter. */
export function automatedCatalogExecutor(execute = executeCatalog) {
  return async (options, seed, telemetry, store, evidence) => {
    const daily = options.dailyRefresh === true, selected = new Set(options.selectedIds || []);
    if (options.enrichSelectedExisting || options.backfillLimit !== 0 || options.deactivateMissing !== false
      || daily && (!selected.size || selected.size > 10 || selected.size !== options.revalidateLimit))
      throw new Error('catalog_automation_phase_invalid');
    const existing = daily ? null : new Set((await store.getActiveCatalogIdentities({ includeInactive: true })).map(p => p.id));
    const allowed = ids => { if (!daily || ids.some(id => !selected.has(id))) throw new Error('automation_unpinned_mutation'); };
    const bounded = { ...store,
      async getProductsForRevalidation(selection) {
        if (!daily) throw new Error('automation_unpinned_mutation');
        const rows = await store.getProductsForRevalidation({ ...selection, selectedIds: [...selected] });
        if (rows.length !== selected.size || new Set(rows.map(p => p.id)).size !== rows.length || rows.some(p => !selected.has(p.id)))
          throw new Error('daily_selection_changed');
        return rows;
      },
      async upsertProduct(product, hash) {
        if (daily) allowed([product.id]);
        else if (!ASIN.test(product.id) || existing.has(product.id)
          || options.admitAsins && !options.admitAsins.includes(product.id)) throw new Error('discovery_existing_mutation_forbidden');
        const result = await store.upsertProduct(product, hash);
        if (!daily) { if (!result.inserted) throw new Error('discovery_insert_not_new'); existing.add(product.id); }
        return result;
      },
      async markConfirmedMissingUnavailable(ids) { allowed(ids); return store.markConfirmedMissingUnavailable(ids); },
      async deactivateConfirmedMissing() { throw new Error('automation_catalog_deletion_forbidden'); },
      async updateAmazonAffiliateUrl() { throw new Error('daily_global_affiliate_repair_forbidden'); },
      async markCatalogDuplicate() { throw new Error('discovery_existing_mutation_forbidden'); },
      async getProductsNeedingEnrichment() { throw new Error('daily_existing_enrichment_forbidden'); },
    };
    return execute(options, seed, telemetry, bounded, evidence);
  };
}

/** Shared by Neon and the pinned D1 driver. The store firewall is intentional:
 * discovery cannot update inactive/same-ASIN rows or supersede old families.
 * Evidence is the existing optional callback; it sees the SAME response only.
 */
export function dailyCatalogExecutor(cadence, execute = executeCatalog) {
  return async (options, seed, telemetry, store, evidence) => {
    const daily = options.dailyRefresh === true;
    if (options.enrichSelectedExisting && (!daily || !cadence.calendar.monday)) throw new Error('daily_enrichment_monday_only');
    await cadence.reserve(daily || options.admitAsins ? 'daily' : 'discovery', telemetry.runId);
    cadence.assertDay();
    const selected = new Set(), existing = daily ? null : new Set((await store.getActiveCatalogIdentities({ includeInactive: true })).map(p => p.id));
    let inserts = 0;
    const allowed = ids => { cadence.assertDay(); if (ids.some(id => !selected.has(id))) throw new Error('daily_unreserved_existing_mutation'); };
    const bounded = { ...store,
      async getProductsForRevalidation(selection) {
        const rows = await store.getProductsForRevalidation(selection);
        if (!daily || rows.length > 10 || new Set(rows.map(p => p.id)).size !== rows.length || rows.some(p => !ASIN.test(p.id))) throw new Error('daily_selection_invalid');
        rows.forEach(p => selected.add(p.id)); return rows;
      },
      async upsertProduct(product, hash) {
        if (daily) allowed([product.id]);
        else if (existing.has(product.id) || inserts >= (options.admitAsins?.length ?? 20)
          || options.admitAsins && !options.admitAsins.includes(product.id)) throw new Error('discovery_existing_mutation_forbidden');
        const result = await store.upsertProduct(product, hash);
        if (!daily) { existing.add(product.id); inserts++; if (!result.inserted) throw new Error('discovery_insert_not_new'); }
        return result;
      },
      async markConfirmedMissingUnavailable(ids) { if (!daily) throw new Error('discovery_existing_mutation_forbidden'); allowed(ids); return store.markConfirmedMissingUnavailable(ids); },
      async deactivateConfirmedMissing(ids, days) { if (!daily) throw new Error('discovery_existing_mutation_forbidden'); allowed(ids); return store.deactivateConfirmedMissing(ids, days); },
      async updateAmazonAffiliateUrl() { throw new Error('daily_global_affiliate_repair_forbidden'); },
      async markCatalogDuplicate() { throw new Error('discovery_existing_mutation_forbidden'); },
      async getProductsNeedingEnrichment() { throw new Error('daily_existing_enrichment_forbidden'); },
    };
    return execute(options, seed, telemetry, bounded, evidence);
  };
}

export async function runDailyCatalogWithBackend({ cadence, featuredIds = /** @type {string[]} */ ([]), execute = executeCatalog,
  preservePermanentListings = false, photosOnly = false, admitAsins, ...backend }) {
  const phases = (await dailyCatalogPhases(cadence, featuredIds, photosOnly, admitAsins)).map(phase => preservePermanentListings
    ? { ...phase,deactivateMissing:false } : phase);
  if (!phases.length) return { state: 'skipped', reason: 'cadence_already_reserved' };
  return runCatalogWithBackend(phases, { ...backend, mode: 'daily', trigger: 'scheduled', execute: dailyCatalogExecutor(cadence, execute) });
}

function numericCounts(value) {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v === null || typeof v === 'number' || typeof v === 'boolean'
    || v && typeof v === 'object' && !Array.isArray(v)).map(([k, v]) => [k, numericCounts(v)]));
}

/** Pre-cutover Neon maintenance receipt. Cache acceptance is NOT independently
 * verified publication; the returned state never claims that it is. */
export async function runNeonDailyCatalog({ cadence, featuredIds = [], runId = randomUUID(), providerEvidence,
  maintenanceStore = createPostgresCatalogMaintenanceStore(), telemetryStore = createPostgresCatalogTelemetryStore(),
  execute, invalidate = invalidateCatalogCaches } = {}) {
  const phases = await dailyCatalogPhases(cadence, featuredIds);
  if (!phases.length) return { state: 'skipped', reason: 'cadence_already_reserved' };
  const warnings = [], results = [], usage = createUsageLedger();
  const telemetry = { runId, usage, warnings, timingsMs: {}, items: createRunItemCollector({ runId, enabled: true, warnings,
    writeItems: (id, items) => telemetryStore.insertCatalogRunItems(id, items) }) };
  if (await telemetryStore.loadCatalogRun(runId)) throw new Error('daily_run_exists_requires_review');
  await telemetryStore.startCatalogRun({ id: runId, mode: 'daily', trigger: 'scheduled', dryRun: false, gitSha: getGitRevision(),
    config: { timezone: 'America/Los_Angeles', day: cadence.calendar.day, existingProductCap: 10, discovery: phases.some(p => p.discoveryNewOnly), backfillLimit: 0 } });
  const finish = async (status, error) => {
    await telemetry.items.flush();
    if (telemetry.items.size) throw new Error('daily_items_unpersisted');
    await telemetryStore.finishCatalogRun(runId, { status, counts: { phases: results.map(numericCounts), publication: { status: 'unverified' } }, warnings,
      usage: finalizeUsageLedger(usage), timingsMs: telemetry.timingsMs, error });
    const actual = await telemetryStore.loadCatalogRun(runId);
    if (actual?.run.id !== runId || actual.run.status !== status) throw new Error('daily_finalization_unverified');
  };
  try {
    const bounded = dailyCatalogExecutor(cadence, execute);
    for (const options of phases) results.push(await bounded(options, undefined, telemetry, maintenanceStore, providerEvidence));
    const invalidation = await invalidate().catch(() => ({ ok: false, reason: 'cache_revalidation_failed' }));
    warnings.push({ phase: 'publication', reasonCode: invalidation.ok ? 'cache_accepted_publication_unverified' : invalidation.reason });
    await finish('completed');
    return { state: 'maintenance_complete', runId, publication: { status: 'unverified' }, cacheInvalidation: invalidation, warnings };
  } catch (error) { await finish(results.length ? 'partial' : 'failed', error); throw error; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Daily catalog: [--backend neon] [--featured-ids ASIN,ASIN] --no-notify [--dry-run]\nD1: --backend d1 --command start|resume|status|preflight --config /private/config.json --config-sha256 SHA [--approval /private/approval.json --approval-sha256 SHA]\nUses the existing canonical private weekly-runs root. D1 requires a pinned daily cadence configuration. No implicit backend fallback. Dry run makes no provider calls or writes.'); return;
  }
  const flags = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (flags.has(key) || !['--backend', '--featured-ids', '--no-notify', '--dry-run', '--command', '--config', '--config-sha256', '--approval', '--approval-sha256'].includes(key)) throw new Error('daily_arguments');
    const value = ['--no-notify', '--dry-run'].includes(key) ? true : args[++i];
    if (value === undefined || typeof value === 'string' && value.startsWith('--')) throw new Error('daily_arguments');
    flags.set(key, value);
  }
  const backend = flags.get('--backend') || 'neon';
  if (!['neon', 'd1'].includes(backend)) throw new Error('daily_backend_invalid');
  if (flags.has('--dry-run')) {
    console.log(JSON.stringify({ state: 'dry_run', backend, calendar: pacificCatalogCalendar(), maximumExisting: 10,
      discovery: pacificCatalogCalendar().monday, backfillLimit: 0, providerCalls: 0, writes: 0 })); return;
  }
  if (backend === 'd1') {
    if (flags.has('--featured-ids') || !flags.has('--config') || !flags.has('--config-sha256')) throw new Error('daily_d1_arguments');
    const { runCloudflareWeekly, weeklyCommandSummary } = await import('../catalog/run-cloudflare-weekly.ts');
    const result = await runCloudflareWeekly({ command: flags.get('--command') || 'start', configPath: flags.get('--config'),
      configSha256: flags.get('--config-sha256'), workspace: CATALOG_CADENCE_ROOT, cadenceOnly: true,
      ...(flags.has('--approval') ? { approval: { path: flags.get('--approval'), sha256: flags.get('--approval-sha256') } } : {}) });
    console.log(JSON.stringify(weeklyCommandSummary(result))); return;
  }
  if ([...flags.keys()].some(key => ['--command', '--config', '--config-sha256', '--approval', '--approval-sha256'].includes(key))) throw new Error('daily_neon_arguments');
  const { default: dotenv } = await import('dotenv'); dotenv.config({ path: '.env.local', quiet: true }); dotenv.config({ quiet: true });
  const { hydrateLocalAmazonCreatorsEnv } = await import('./amazon-creators-env.mjs'); hydrateLocalAmazonCreatorsEnv();
  for (const key of ['POSTGRES_URL', 'AMAZON_ASSOCIATE_TAG', 'AMAZON_CREATORS_CREDENTIAL_ID', 'AMAZON_CREATORS_CREDENTIAL_SECRET', 'AMAZON_CREATORS_CREDENTIAL_VERSION'])
    if (!process.env[key]) throw new Error('daily_neon_credentials_missing');
  const result = await withCatalogCadence({ workspace: CATALOG_CADENCE_ROOT, repository: process.cwd() }, async cadence => {
    const phases = await dailyCatalogPhases(cadence);
    if (phases.some(p => p.discoveryNewOnly || p.enrichSelectedExisting) && !process.env.OPENAI_API_KEY) throw new Error('daily_model_credentials_missing');
    return runNeonDailyCatalog({ cadence, featuredIds: flags.get('--featured-ids')?.split(',') || [] });
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  console.error(/^[a-z][a-z0-9_]{1,100}$/.test(error.message) ? error.message : 'daily_requires_review'); process.exitCode = 1;
});
