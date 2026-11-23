/** Host-local preparation only. No provider requests, credential rotation,
 * scheduler changes or replacement of the current Vercel bootstrap.
 */
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdtemp, chmod, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { parse } from 'dotenv';
import { parseCsvRows, isUsableCredentialValue } from './amazon-creators-env.mjs';
import { resolveReadToken } from '../catalog/check-cloudflare-runner.ts';

export const CATALOG_KEYCHAIN_ACCOUNT = 'goose.gifts';
export const CATALOG_KEYCHAIN_SERVICES = Object.freeze([
  'goose.gifts.AMAZON_CREATORS_CREDENTIAL_ID',
  'goose.gifts.AMAZON_CREATORS_CREDENTIAL_SECRET',
  'goose.gifts.OPENAI_API_KEY',
  'goose.gifts.STAGING_AUTH_SECRET',
]);
const run = promisify(execFile);
const helperSource = fileURLToPath(new URL('./catalog-keychain-add.swift', import.meta.url));
const childEnv = () => ({ HOME: homedir(), PATH: '/usr/bin:/bin' });
const fail = code => { throw new Error(`catalog_keychain_${code}`); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys;
const usable = value => isUsableCredentialValue(value) && /^[\x21-\x7e]{1,4096}$/.test(value);
const same = (a, b) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function readProtectedSource(path, maxBytes = 32768) {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.uid !== process.getuid?.()
      || before.mode & 0o077 || before.size < 1 || before.size > maxBytes || await realpath(path) !== resolve(path)) fail('source_protection');
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev) fail('source_changed');
    const bytes = Buffer.alloc(maxBytes + 1);
    let bytesRead = 0;
    for (;;) {
      const part = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!part.bytesRead) break;
      bytesRead += part.bytesRead;
      if (bytesRead > maxBytes) fail('source_changed');
    }
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) fail('source_changed');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
  } catch (error) {
    if (error instanceof Error && /^catalog_keychain_source_/.test(error.message)) throw error;
    fail('source_unavailable');
  } finally { await handle?.close(); }
}

/** Read selected values without evaluating shell content or using process.env.
 * Reuse the existing dotenv/CSV parsers. Reject shell quote-concatenation rather
 * than accidentally seeding its literal encoding as a password.
 */
export async function loadCatalogKeychainSources(read = readProtectedSource, home = homedir()) {
  const sourceRoot = join(home, '.codex/worktrees/goose-migration-integration/goose.gifts');
  const raw = await read(join(sourceRoot, '.env.local'));
  const env = parse(raw);
  for (const name of ['AMAZON_ASSOCIATE_TAG', 'OPENAI_API_KEY', 'AMAZON_CREATORS_CREDENTIAL_ID',
    'AMAZON_CREATORS_CREDENTIAL_SECRET', 'AMAZON_CREATORS_CREDENTIAL_VERSION']) {
    if (raw.split(/\r?\n/).some(line => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line) && line.includes("'\\''"))) fail('source_encoding');
  }
  if (typeof env.AMAZON_ASSOCIATE_TAG !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(env.AMAZON_ASSOCIATE_TAG)) fail('associate_tag');
  if (env.AMAZON_MARKETPLACE && env.AMAZON_MARKETPLACE !== 'www.amazon.com') fail('marketplace');
  const amazonKeys = ['AMAZON_CREATORS_CREDENTIAL_ID', 'AMAZON_CREATORS_CREDENTIAL_SECRET', 'AMAZON_CREATORS_CREDENTIAL_VERSION'];
  if (!amazonKeys.every(key => usable(env[key]))) {
    const rows = parseCsvRows(await read(join(home, '.codex/secrets/goose.gifts/amazon-creators-api-credentials.csv'), 16384));
    if (rows.length !== 2 || rows[0].length !== rows[1].length || new Set(rows[0].map(key => key.trim())).size !== rows[0].length) fail('amazon_csv');
    const record = Object.fromEntries(rows[0].map((key, index) => [key.trim(), rows[1][index]?.trim()]));
    const fallback = [record['Credential Id'], record.Secret, record.Version];
    for (const [index, key] of amazonKeys.entries()) {
      if (usable(env[key]) && env[key] !== fallback[index]) fail('amazon_source_conflict');
      if (!usable(env[key])) env[key] = fallback[index];
    }
  }
  if (!['2.1', '2.2', '2.3', '3.1', '3.2', '3.3'].includes(env.AMAZON_CREATORS_CREDENTIAL_VERSION)) fail('amazon_version');
  let staging;
  try { staging = JSON.parse(await read(join(home, '.codex/private/goose-gifts-migration/staging-secrets.json'))); }
  catch { fail('staging_source'); }
  if (!exact(staging, 'STAGING_AUTH_SECRET')) fail('staging_source');
  const values = [env.AMAZON_CREATORS_CREDENTIAL_ID, env.AMAZON_CREATORS_CREDENTIAL_SECRET, env.OPENAI_API_KEY, staging.STAGING_AUTH_SECRET];
  if (!values.every(usable)) fail('source_value');
  return {
    catalog: { associateTag: env.AMAZON_ASSOCIATE_TAG, marketplace: 'www.amazon.com' },
    amazonVersion: env.AMAZON_CREATORS_CREDENTIAL_VERSION,
    entries: CATALOG_KEYCHAIN_SERVICES.map((service, index) => ({ service, value: values[index] })),
  };
}

async function itemExists(service) {
  try {
    await run('/usr/bin/security', ['find-generic-password', '-s', service, '-a', CATALOG_KEYCHAIN_ACCOUNT],
      { env: childEnv(), timeout: 3000, maxBuffer: 8192 });
    return true;
  } catch (error) {
    if (error.code === 44 && !error.signal && !error.killed) return false; // errSecItemNotFound, not an unreadable item.
    fail('lookup_unavailable');
  }
}
const readItem = ref => resolveReadToken(ref, (command, args, options) => run(command, args, { ...options, env: childEnv() }));

/** Compile before any credential is passed to the child; the ephemeral helper
 * trusts only /usr/bin/security, not itself. Its only input is a bounded pipe.
 */
export async function addAbsentItems(entries) {
  const directory = await mkdtemp(join(tmpdir(), 'goose-catalog-keychain-'));
  await chmod(directory, 0o700);
  try {
    const binary = join(directory, 'catalog-keychain-add');
    try { await run('/usr/bin/xcrun', ['swiftc', helperSource, '-o', binary], { env: childEnv(), timeout: 60000, maxBuffer: 65536 }); }
    catch { fail('helper_compile'); }
    const body = JSON.stringify({ schemaVersion: 1, entries });
    if (Buffer.byteLength(body) > 32768) fail('helper_input');
    return await new Promise((resolveResult, reject) => {
      const child = spawn(binary, [], { env: childEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '', settled = false;
      const timer = setTimeout(() => { child.kill(); finish(); }, 10000);
      const finish = code => {
        if (settled) return; settled = true; clearTimeout(timer);
        try {
          const result = JSON.parse(output);
          if (!exact(result, 'created,errorCode,status') || !['created', 'requires_review'].includes(result.status)
            || !Array.isArray(result.created) || result.created.some(service => !entries.some(entry => entry.service === service))
            || new Set(result.created).size !== result.created.length || !/^(none|keychain_[a-z_]+)$/.test(result.errorCode)
            || result.status === 'created' && (code !== 0 || result.errorCode !== 'none' || result.created.length !== entries.length)) fail('helper_result');
          resolveResult(result);
        } catch { reject(new Error('catalog_keychain_helper_uncertain')); }
      };
      child.on('error', () => finish());
      child.stdout.on('data', bytes => { output += bytes.toString('utf8'); if (output.length > 4096) { child.kill(); finish(); } });
      child.stdin.on('error', () => {});
      child.on('close', code => finish(code));
      child.stdin.end(body);
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export async function catalogKeychainBootstrap(mode = 'plan', dependencies = {}) {
  if (!['plan', 'seed', 'verify'].includes(mode)) fail('arguments');
  if ((dependencies.platform ?? process.platform) !== 'darwin') fail('macos_required');
  const source = await (dependencies.loadSources ?? loadCatalogKeychainSources)();
  const exists = dependencies.itemExists ?? itemExists, read = dependencies.readItem ?? readItem;
  const items = [];
  // Inspect and compare the complete set before any creation. A present but
  // inaccessible item is never treated as absent or repaired by changing ACLs.
  for (const entry of source.entries) {
    const ref = { service: entry.service, account: CATALOG_KEYCHAIN_ACCOUNT };
    const present = await exists(entry.service);
    if (present) {
      let actual;
      try { actual = await read(ref); } catch { fail('existing_unreadable'); }
      if (!same(actual, entry.value)) fail('existing_mismatch');
    }
    items.push({ ...ref, status: present ? 'matches_source' : 'absent' });
  }
  const report = { schemaVersion: 1, mode, catalog: source.catalog, amazonVersion: source.amazonVersion, items,
    cloudflareCredential: 'not_seeded_choose_reviewed_keychain_or_wrangler_oauth_reference',
    operatorConfiguration: 'not_created_requires_reviewed_resource_bindings',
    currentBootstrapChanged: false, providerCalls: 0 };
  const missing = source.entries.filter(entry => items.find(item => item.service === entry.service)?.status === 'absent');
  if (mode === 'plan') return { ...report, status: 'planned_no_writes' };
  if (mode === 'verify' && missing.length) return { ...report, status: 'missing_items' };
  if (mode === 'seed' && missing.length) {
    const result = await (dependencies.addAbsentItems ?? addAbsentItems)(missing);
    if (result.status !== 'created') return { ...report, status: 'requires_review', created: result.created, errorCode: result.errorCode };
  }
  for (const entry of source.entries) {
    let actual;
    try { actual = await read({ service: entry.service, account: CATALOG_KEYCHAIN_ACCOUNT }); } catch { fail('verification_unavailable'); }
    if (!same(actual, entry.value)) fail('verification_mismatch');
  }
  return { ...report, status: 'local_items_verified', items: items.map(item => ({ ...item, status: 'matches_source' })) };
}

async function main() {
  if (process.argv.length > 3) fail('arguments');
  const report = await catalogKeychainBootstrap(process.argv[2] ?? 'plan');
  console.log(JSON.stringify(report));
  if (['missing_items', 'requires_review'].includes(report.status)) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = error instanceof Error && /^catalog_keychain_[a-z_]+$/.test(error.message) ? error.message : 'catalog_keychain_failed';
    console.error(JSON.stringify({ status: 'requires_review', errorCode: code })); process.exitCode = 1;
  });
}
