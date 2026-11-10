import { readHomepageEdition } from '../../lib/catalog/homepage-edition.ts';
import type { HomepageEdition } from '../../lib/catalog/homepage-edition.ts';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalTime, validateCatalogSnapshot } from '../../lib/catalog/snapshot.ts';
import type { CatalogSnapshot, SiteAssetManifest } from '../../lib/catalog/types.ts';
import { createStaticFeedPlan } from '../../workers/site/feed.ts';
import { createReleaseIdentity } from './release-identity.mts';
import { resolveSiteSourceMode, siteIdentityFor, siteIdentityRecordFor } from '../../static-site/lib/site-identity.ts';
import { assembleReleaseAssets, readPriorRelease } from './retention.mts';
import { earliestDisplayExpiry } from '../../lib/catalog/display.ts';
import { createStaticRoutes } from '../../static-site/lib/asset-routes.ts';
import { documentAssets } from '../../static-site/lib/document-output.ts';
import { canonicalJson } from '../../lib/catalog/canonical-json.ts';
import { verifySemanticCatalogIdentities } from '../../lib/catalog/semantic-profile.ts';
import { readMerchandising } from '../../lib/catalog/merchandising.ts';
import type { Merchandising } from '../../lib/catalog/merchandising.ts';

export type ReleaseBuildContext = Pick<SiteAssetManifest, 'schemaVersion' | 'releaseId' | 'codeSha' | 'catalogRevision'
  | 'catalogSnapshotSha256' | 'generatedAt' | 'vectorSyncWatermark' | 'priorReleaseId' | 'sourceMode'> & { retainedManifestSha256: string | null; homepage?: HomepageEdition; merchandising?: Merchandising };
/** Explicit reviewed context; zero/null are valid only when actually supplied.
 * Build retries must reuse the sealed package, not overwrite an existing release ID.
 */
export function validateBuildContext(value: unknown, snapshot: CatalogSnapshot, codeSha: string, snapshotDigest: string, now = new Date()): ReleaseBuildContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Explicit release build context is required');
  const input = value as ReleaseBuildContext;
  if (Object.keys(input).sort().join(',') !== `catalogRevision,catalogSnapshotSha256,codeSha,generatedAt,${Object.hasOwn(input, 'homepage') ? 'homepage,' : ''}${Object.hasOwn(input,'merchandising')?'merchandising,':''}priorReleaseId,releaseId,retainedManifestSha256,schemaVersion,sourceMode,vectorSyncWatermark`
    || input.schemaVersion !== 1 || typeof input.releaseId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(input.releaseId)
    || !/^[a-f0-9]{40}$/.test(input.codeSha) || input.codeSha !== codeSha || input.catalogRevision !== snapshot.catalogRevision
    || !/^[a-f0-9]{64}$/.test(input.catalogSnapshotSha256) || input.catalogSnapshotSha256 !== snapshotDigest
    || !Number.isSafeInteger(input.vectorSyncWatermark) || input.vectorSyncWatermark < 0
    || input.priorReleaseId !== null && (typeof input.priorReleaseId !== 'string' || !/^[a-zA-Z0-9._-]{1,200}$/.test(input.priorReleaseId))
    || input.priorReleaseId === input.releaseId
    || input.retainedManifestSha256 !== null && (typeof input.retainedManifestSha256 !== 'string'
      || !/^[a-f0-9]{64}$/.test(input.retainedManifestSha256) || input.priorReleaseId === null)) throw new Error('Release build context is malformed or incompatible');
  if (Object.hasOwn(input, 'homepage') && !readHomepageEdition(input.homepage)) throw new Error('Invalid homepage edition');
  if (Object.hasOwn(input,'merchandising') && !readMerchandising(input.merchandising)) throw new Error('Invalid merchandising signals');
  const generated = Date.parse(canonicalTime(input.generatedAt));
  resolveSiteSourceMode(input.sourceMode);
  if (!Number.isFinite(now.getTime()) || generated < Date.parse(snapshot.generatedAt) || generated > now.getTime()) throw new Error('Release build context has an invalid capture time');
  return { schemaVersion: 1, sourceMode: input.sourceMode, releaseId: input.releaseId, codeSha: input.codeSha, catalogRevision: input.catalogRevision,
    catalogSnapshotSha256: input.catalogSnapshotSha256, generatedAt: input.generatedAt,
    vectorSyncWatermark: input.vectorSyncWatermark, priorReleaseId: input.priorReleaseId,
    retainedManifestSha256: input.retainedManifestSha256,
    ...(input.homepage ? { homepage: readHomepageEdition(input.homepage)! } : {}),
    ...(input.merchandising ? {merchandising:readMerchandising(input.merchandising)!} : {}) };
}

export function siteIdentityBytes(sourceMode: ReleaseBuildContext['sourceMode']): string {
  return `${JSON.stringify(siteIdentityRecordFor(sourceMode))}\n`;
}
/** A caller cannot relabel the package independently of its reviewed context. */
export function releaseBuildEnvironment(context: Pick<ReleaseBuildContext, 'sourceMode'>, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of ['CATALOG_SITE_MODE', 'NEXT_PUBLIC_STATIC_SITE_MODE']) {
    if (env[key] !== undefined && env[key] !== context.sourceMode) throw new Error('Caller site source mode conflicts with reviewed release context');
  }
  return { ...env, CATALOG_SITE_MODE: context.sourceMode, NEXT_PUBLIC_STATIC_SITE_MODE: context.sourceMode };
}

/** Match release verification: nonignored untracked files count as source changes. */
export function assertBuildSource(root: string, expectedSha?: string): string {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const codeSha = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw new Error('Commit the reviewed source before building a staging release');
  if (expectedSha !== undefined && codeSha !== expectedSha) throw new Error('Source HEAD changed during the staging build');
  return codeSha;
}

/** Toolchain may be pinned separately; all runtime source/output and code guards use this root. */
export async function buildStaticRelease(root: string) {
  const output = path.join(root, 'static-site/out');
  const generated = path.join(root, 'build/stupid-gifts');
  const source = path.resolve(process.env.CATALOG_SNAPSHOT_PATH || path.join(root, 'static-site/fixtures/catalog.snapshot.json'));
  const snapshot = validateCatalogSnapshot(JSON.parse(await fs.readFile(source, 'utf8')));
  const snapshotBytes = `${JSON.stringify(snapshot)}\n`;
  const catalogSnapshotSha256 = createHash('sha256').update(snapshotBytes).digest('hex');
  const contextPath = process.env.CATALOG_RELEASE_CONTEXT_PATH;
  if (!contextPath) throw new Error('CATALOG_RELEASE_CONTEXT_PATH must identify explicit reviewed release context');
  const codeSha = assertBuildSource(root);
  const context = validateBuildContext(JSON.parse(await fs.readFile(path.resolve(contextPath), 'utf8')), snapshot, codeSha, catalogSnapshotSha256);
  const buildEnv = releaseBuildEnvironment(context, process.env);
  const priorPackage = await readPriorRelease(context, process.env.CATALOG_PRIOR_RELEASE_PATH);
  const identityBytes = siteIdentityBytes(context.sourceMode);
  const searchPath = process.env.CATALOG_SEMANTIC_CATALOG_PATH, searchDigest = process.env.CATALOG_SEMANTIC_CATALOG_SHA256;
  let semanticCatalog;
  if (searchPath || searchDigest) {
    if (!searchPath || !path.isAbsolute(searchPath) || !/^[a-f0-9]{64}$/.test(searchDigest ?? ''))
      throw new Error('semantic_catalog_build_input_invalid');
    const bytes = await fs.readFile(searchPath);
    if (bytes.length > 8 * 1024 * 1024) throw new Error('semantic_catalog_build_input_oversize');
    semanticCatalog = await verifySemanticCatalogIdentities(JSON.parse(bytes.toString('utf8')));
    if (createHash('sha256').update(canonicalJson(semanticCatalog)).digest('hex') !== searchDigest)
      throw new Error('semantic_catalog_build_input_changed');
  }
  try {
    const prior = JSON.parse(await fs.readFile(path.join(generated, 'asset-manifest.json'), 'utf8'));
    if (prior.releaseId === context.releaseId) throw new Error('Release ID already built; verify and reuse the sealed package instead');
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await fs.mkdir(generated, { recursive: true });
  // Build and Worker consume exactly the same immutable public allowlist.
  const input = path.join(generated, 'catalog.snapshot.json');
  await fs.writeFile(input, snapshotBytes);
  await fs.writeFile(path.join(generated, 'release-context.json'), `${JSON.stringify(context)}\n`);
  await fs.writeFile(path.join(generated, 'site-identity.json'), identityBytes);
  await fs.writeFile(path.join(generated, 'feed-plan.json'), `${JSON.stringify(createStaticFeedPlan(snapshot, catalogSnapshotSha256))}\n`);
  execFileSync(process.execPath, ['node_modules/next/dist/bin/next', 'build', 'static-site', '--webpack'], {
    cwd: root, env: { ...buildEnv, CATALOG_SNAPSHOT_PATH: input,
      CATALOG_RELEASE_CONTEXT_PATH: path.join(generated, 'release-context.json') }, stdio: 'inherit',
  });
  assertBuildSource(root, codeSha);
  const files = (await fs.readdir(output, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name)).sort();
  const currentAssets = new Map<string, Uint8Array>();
  for (const file of files) {
    currentAssets.set(`/${path.relative(output, file).split(path.sep).join('/')}`, await fs.readFile(file));
  }
  // Validate Next's complete export before selecting this native-anchor site's
  // document output. HTML includes its own hydration payload; standalone Flight
  // navigation files are deliberately not published. Safe/legal text remains.
  const navigationRoutes = createStaticRoutes(snapshot, [...currentAssets.keys()], undefined, siteIdentityFor(context.sourceMode), context.generatedAt, context.homepage,context.merchandising);
  const assembled = assembleReleaseAssets(snapshot, documentAssets(currentAssets, navigationRoutes), context, priorPackage);
  // Only generated outputs in this build are removed, never historical packages.
  for (const name of currentAssets.keys()) if (!assembled.assets.has(name))
    await fs.unlink(path.join(output, name.slice(1)));
  const checksums: Record<string, string> = {};
  for (const [name, bytes] of [...assembled.assets].sort(([a], [b]) => a.localeCompare(b))) {
    if (!currentAssets.has(name)) {
      const file = path.join(output, name.slice(1));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, bytes);
    }
    checksums[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const { retainedManifestSha256, ...manifestContext } = context;
  const manifest: SiteAssetManifest = { ...manifestContext,
    retention: retainedManifestSha256 === null ? null : assembled.retention,
    siteIdentitySha256: createHash('sha256').update(identityBytes).digest('hex'), dataKind: snapshot.dataKind,
    nextExpiry: earliestDisplayExpiry(snapshot.products),
    productCount: snapshot.products.length,
    slugCount: snapshot.products.length + snapshot.heldProducts.length + snapshot.slugHistory.length,
    checksums, routes: assembled.routes,
    ...(semanticCatalog ? { semanticCatalog } : {}),
    ...(Object.keys(assembled.assetAliases).length ? { assetAliases: assembled.assetAliases } : {}) };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  // Asset inventory/retention can take time; do not seal if source drifted meanwhile.
  assertBuildSource(root, codeSha);
  await fs.writeFile(path.join(generated, 'asset-manifest.json'), manifestBytes);
  await fs.writeFile(path.join(generated, 'release-identity.json'), `${JSON.stringify(createReleaseIdentity(manifestBytes))}\n`);
  console.log(JSON.stringify({ releaseId: manifest.releaseId, dataKind: snapshot.dataKind,
    productCount: manifest.productCount, assets: assembled.assets.size, guardedRoutes: Object.keys(assembled.routes).length,
    exportedAssets: currentAssets.size,
    exportedBytes: [...currentAssets.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
    assetBytes: [...assembled.assets.values()].reduce((total, bytes) => total + bytes.byteLength, 0),
    nextExpiry: manifest.nextExpiry }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await buildStaticRelease(path.resolve(import.meta.dirname, '../..'));
