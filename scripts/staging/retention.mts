import fs from 'node:fs/promises';
import path from 'node:path';
import type { CatalogSnapshot, SiteAssetManifest } from '../../lib/catalog/types.ts';
import { createStaticRoutes } from '../../static-site/lib/asset-routes.ts';
import { assetSha256, assertOwnedCodeSafe, retainStaticAssets, retentionAssetPaths } from '../../static-site/lib/retention.ts';
import type { RetentionInput } from '../../static-site/lib/retention.ts';
import { siteIdentityFor } from '../../static-site/lib/site-identity.ts';
import { compactRscAssets, expandRscAssets } from '../../static-site/lib/asset-compaction.ts';

type Context = Pick<SiteAssetManifest, 'priorReleaseId' | 'generatedAt' | 'sourceMode' | 'homepage' | 'merchandising'> & { retainedManifestSha256: string | null };
type Files = ReadonlyMap<string, Uint8Array>;
export const CLOUDFLARE_ASSET_LIMIT = 100000;
export function assertStaticAssetCapacity(assets: Files) {
  if (assets.size > CLOUDFLARE_ASSET_LIMIT) throw new Error('Static export exceeds Cloudflare Workers Paid asset limit');
}
function fail(): never { throw new Error('Retained release input is missing or incompatible'); }
function assertPublicIdentitySafe(files: Files) {
  for (const [name, bytes] of files) {
    if (/\.(?:html|txt|json|js|mjs|css|svg|xml)$/.test(name)
      && /\b(?:cameron|ehrlich|cameronehrlich)\b|\b(?:cam|cameron)@37\.technology\b/i.test(new TextDecoder().decode(bytes)))
      throw new Error('Public assets must not contain personal owner identity');
  }
}
function safePath(name: string) {
  return name.startsWith('/') && !name.includes('//') && !/[\\%?#\0]/.test(name)
    && !name.split('/').some((part) => part === '.' || part === '..');
}
async function boundedFile(file: string, maximum: number) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.size > maximum) fail();
  const bytes = await fs.readFile(file);
  if (bytes.byteLength > maximum) fail();
  return bytes;
}
/** Trust comes from reviewed context, not a discoverable local sidecar. Only
 * allowlisted retained candidates are read; no source path enters the manifest.
 */
export async function readPriorRelease(context: Context, directory?: string): Promise<RetentionInput['prior'] | null> {
  if (context.retainedManifestSha256 === null) {
    if (directory !== undefined) fail();
    return null;
  }
  if (!directory || !context.priorReleaseId || !/^[a-f0-9]{64}$/.test(context.retainedManifestSha256)) fail();
  try {
    const manifestBytes = await boundedFile(path.join(directory, 'asset-manifest.json'), 32 * 1024 * 1024);
    if (assetSha256(manifestBytes) !== context.retainedManifestSha256) fail();
    const manifest: SiteAssetManifest = JSON.parse(manifestBytes.toString('utf8'));
    if (manifest.releaseId !== context.priorReleaseId) fail();
    const snapshotBytes = await boundedFile(path.join(directory, 'catalog.snapshot.json'), 32 * 1024 * 1024);
    if (assetSha256(snapshotBytes) !== manifest.catalogSnapshotSha256) fail();
    const base = await fs.realpath(path.join(directory, 'assets'));
    if (!(await fs.stat(base)).isDirectory()) fail();
    const assets = new Map<string, Uint8Array>();
    let total = 0;
    for (const name of retentionAssetPaths(manifest)) {
      if (!manifest.checksums[name]) continue; // held aliases deliberately have no old body
      const file = path.join(base, name.slice(1));
      if (!(await fs.realpath(file)).startsWith(`${base}${path.sep}`)) fail();
      const bytes = await boundedFile(file, 2 * 1024 * 1024);
      total += bytes.byteLength;
      if (total > 64 * 1024 * 1024 || assetSha256(bytes) !== manifest.checksums[name]) fail();
      assets.set(name, bytes);
    }
    return { releaseId: manifest.releaseId, manifestSha256: context.retainedManifestSha256, manifestBytes, snapshotBytes, assets };
  } catch { fail(); }
}

/** Builder and verifier independently derive the same policy from sealed inputs. */
export function assembleReleaseAssets(snapshot: CatalogSnapshot, current: Files, context: Context,
  prior: RetentionInput['prior'] | null, compact = true) {
  const finish = (assets: Files, routes: SiteAssetManifest['routes']) => compact
    ? compactRscAssets(assets, routes) : { assets: new Map(assets), routes, assetAliases: {} };
  const currentAssetPaths = [...current.keys()].sort();
  if (currentAssetPaths.length > 100000 || currentAssetPaths.some((name) => !safePath(name))) fail();
  assertPublicIdentitySafe(current);
  for (const [name, bytes] of current) if (/^\/_next\/static\/.*\.(?:js|css)$/.test(name)) assertOwnedCodeSafe(bytes, [snapshot]);
  const currentRoutes = createStaticRoutes(snapshot, currentAssetPaths, undefined, siteIdentityFor(context.sourceMode), context.generatedAt, context.homepage,context.merchandising);
  if (context.retainedManifestSha256 === null) {
    if (prior !== null) fail();
    const compacted = finish(current, currentRoutes);
    assertStaticAssetCapacity(compacted.assets);
    return { ...compacted, retention: null };
  }
  if (!prior || prior.releaseId !== context.priorReleaseId || prior.manifestSha256 !== context.retainedManifestSha256) fail();
  const retained = retainStaticAssets({ prior, current: { snapshot, assets: current, routes: currentRoutes }, capturedAt: context.generatedAt });
  // Old page chunks are public too. If one contains retired attribution, the
  // operator must use an explicit no-retention release, not carry it forward.
  assertPublicIdentitySafe(retained.files);
  const assets = new Map([...retained.files, ...current]);
  const compacted = finish(assets, { ...retained.routes, ...currentRoutes });
  assertStaticAssetCapacity(compacted.assets);
  return { ...compacted,
    retention: { priorManifestSha256: context.retainedManifestSha256, currentAssetPaths } };
}

export function verifyRetainedAssets(snapshot: CatalogSnapshot, actual: Files, manifest: SiteAssetManifest,
  context: Context, prior: RetentionInput['prior'] | null) {
  const policy = manifest.retention;
  const logical = expandRscAssets(actual, manifest.assetAliases);
  let current: Files = logical;
  if (context.retainedManifestSha256 !== null) {
    if (!policy || Object.keys(policy).sort().join(',') !== 'currentAssetPaths,priorManifestSha256'
      || policy.priorManifestSha256 !== context.retainedManifestSha256 || !Array.isArray(policy.currentAssetPaths)
      || policy.currentAssetPaths.some((name) => typeof name !== 'string' || !safePath(name) || !logical.has(name))
      || JSON.stringify(policy.currentAssetPaths) !== JSON.stringify([...new Set(policy.currentAssetPaths)].sort())) fail();
    current = new Map(policy.currentAssetPaths.map((name) => [name, logical.get(name)!]));
  } else if (policy !== null) fail();
  // Historical packages have no alias field and must verify byte-for-byte as
  // originally sealed. New builders always use compaction, without a switch.
  const expected = assembleReleaseAssets(snapshot, current, context, prior, manifest.assetAliases !== undefined);
  if (JSON.stringify([...actual.keys()].sort()) !== JSON.stringify([...expected.assets.keys()].sort())
    || [...actual].some(([name, bytes]) => assetSha256(bytes) !== assetSha256(expected.assets.get(name)!))
    || JSON.stringify(manifest.assetAliases ?? {}) !== JSON.stringify(expected.assetAliases)
    || JSON.stringify(manifest.retention) !== JSON.stringify(expected.retention)
    || JSON.stringify(manifest.routes) !== JSON.stringify(expected.routes)) fail();
}
