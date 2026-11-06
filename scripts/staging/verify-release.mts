import { readHomepageEdition } from '../../lib/catalog/homepage-edition.ts';
import { createHash } from 'node:crypto';
import { verifySemanticCatalogIdentities } from '../../lib/catalog/semantic-profile.ts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateCatalogSnapshot } from '../../lib/catalog/snapshot.ts';
import type { CatalogSnapshot, SiteAssetManifest } from '../../lib/catalog/types.ts';
import { createStaticFeedPlan } from '../../workers/site/feed.ts';
import { verifyReleaseIdentity } from './release-identity.mts';
import { releaseBuildEnvironment, siteIdentityBytes, validateBuildContext } from './build.mts';
import { siteIdentityFor } from '../../static-site/lib/site-identity.ts';
import { readPriorRelease, verifyRetainedAssets } from './retention.mts';

export function verifySnapshotDigest(bytes: Uint8Array, expected: string): void {
  if (createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Catalog snapshot changed after the release was built');
}

export function verifyFeedPlan(snapshot: CatalogSnapshot, digest: string, plan: unknown): void {
  if (JSON.stringify(plan) !== JSON.stringify(createStaticFeedPlan(snapshot, digest)))
    throw new Error('Prepared feed changed after the release was built');
}

export function verifyReleaseContext(value: unknown, manifest: SiteAssetManifest, snapshot: CatalogSnapshot, codeSha: string, now = new Date()) {
  const context = validateBuildContext(value, snapshot, codeSha, manifest.catalogSnapshotSha256, now);
  if (Object.entries(context).some(([key, field]) => key === 'retainedManifestSha256'
    ? (manifest.retention?.priorManifestSha256 ?? null) !== field : key === 'homepage' ? JSON.stringify(readHomepageEdition(manifest.homepage)) !== JSON.stringify(field)
      : key === 'merchandising' ? JSON.stringify(manifest.merchandising) !== JSON.stringify(field)
      : manifest[key as keyof SiteAssetManifest] !== field))
    throw new Error('Release context changed after the release was built');
  return context;
}

export function verifySiteIdentity(bytes: Uint8Array, manifest: Pick<SiteAssetManifest, 'sourceMode' | 'siteIdentitySha256'>): void {
  if (Buffer.from(bytes).toString('utf8') !== siteIdentityBytes(manifest.sourceMode)
    || createHash('sha256').update(bytes).digest('hex') !== manifest.siteIdentitySha256)
    throw new Error('Site identity changed or disagrees with the reviewed source mode');
}
/** Inspect only URL-bearing metadata, not merchant links or embedded product copy.
 * Next emits quoted attributes. Malformed/relative identity URLs fail closed.
 */
export function verifySiteOutputOrigins(html: string, sourceMode: SiteAssetManifest['sourceMode'], noindex = sourceMode === 'preview') {
  const origin = siteIdentityFor(sourceMode).origin;
  let canonical = 0, openGraph = 0, robots = 0;
  for (const match of html.matchAll(/<(link|meta)\b[^>]*>/gi)) {
    const attrs = Object.fromEntries([...match[0].matchAll(/\s([a-zA-Z:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
      .map((attr) => [attr[1].toLowerCase(), attr[2] ?? attr[3]]));
    const isCanonical = match[1].toLowerCase() === 'link' && attrs.rel?.split(/\s+/).includes('canonical');
    const property = attrs.property?.toLowerCase();
    const isOg = ['og:url', 'og:image', 'og:image:url'].includes(property);
    if (isCanonical || isOg || attrs.name?.toLowerCase() === 'twitter:image') {
      let url: URL;
      try { url = new URL(String(isCanonical ? attrs.href : attrs.content).replaceAll('&amp;', '&')); }
      catch { throw new Error('Invalid canonical/share identity URL'); }
      if (url.origin !== origin || url.username || url.password) throw new Error('Canonical/share origin disagrees with reviewed source mode');
      if (isCanonical) canonical++;
      if (property === 'og:url') openGraph++;
    }
    if (attrs.name?.toLowerCase() === 'robots') {
      robots++;
      if (noindex && !attrs.content?.toLowerCase().split(/[\s,]+/).includes('noindex')) throw new Error('Preview/fixture metadata must remain noindex');
    }
  }
  if (noindex && !robots) throw new Error('Preview/fixture metadata must remain noindex');
  return { canonical, openGraph };
}

/** Verify the actual runtime root, even when this verifier comes from a newer pinned toolchain. */
export async function verifyStaticRelease(root: string) {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('Commit the reviewed source before deploying a staging release');
  const manifestBytes = await fs.readFile(path.join(root, 'build/stupid-gifts/asset-manifest.json'));
  const manifest: SiteAssetManifest = JSON.parse(manifestBytes.toString('utf8'));
  verifyReleaseIdentity(manifestBytes, JSON.parse(await fs.readFile(path.join(root, 'build/stupid-gifts/release-identity.json'), 'utf8')));
  if (Object.hasOwn(manifest, 'semanticCatalog')) await verifySemanticCatalogIdentities(manifest.semanticCatalog);
  const snapshotBytes = await fs.readFile(path.join(root, 'build/stupid-gifts/catalog.snapshot.json'));
  const snapshot = validateCatalogSnapshot(JSON.parse(snapshotBytes.toString('utf8')));
  verifySnapshotDigest(snapshotBytes, manifest.catalogSnapshotSha256);
  const context = verifyReleaseContext(JSON.parse(await fs.readFile(path.join(root, 'build/stupid-gifts/release-context.json'), 'utf8')),
    manifest, snapshot, git('rev-parse', 'HEAD'));
  const priorPackage = await readPriorRelease(context, process.env.CATALOG_PRIOR_RELEASE_PATH);
  releaseBuildEnvironment(manifest, process.env);
  verifySiteIdentity(await fs.readFile(path.join(root, 'build/stupid-gifts/site-identity.json')), manifest);
  const feedPlan = JSON.parse(await fs.readFile(path.join(root, 'build/stupid-gifts/feed-plan.json'), 'utf8'));
  verifyFeedPlan(snapshot, manifest.catalogSnapshotSha256, feedPlan);
  if (manifest.codeSha !== git('rev-parse', 'HEAD') || manifest.catalogRevision !== snapshot.catalogRevision)
    throw new Error('Rebuild the current committed source and snapshot before deployment');
  const output = path.join(root, 'static-site/out');
  const entries = (await fs.readdir(output, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name));
  const actualPaths = entries.map((file) => `/${path.relative(output, file).split(path.sep).join('/')}`).sort();
  if (JSON.stringify(actualPaths) !== JSON.stringify(Object.keys(manifest.checksums).sort()))
    throw new Error('Asset inventory changed after the release was built');
  const assets = new Map<string, Uint8Array>();
  for (const file of entries) {
    const name = `/${path.relative(output, file).split(path.sep).join('/')}`;
    const bytes = await fs.readFile(file);
    assets.set(name, bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.checksums[name])
      throw new Error(`Asset checksum changed: ${name}`);
    if (name.endsWith('.html')) {
      const tags = verifySiteOutputOrigins(bytes.toString('utf8'), manifest.sourceMode, manifest.sourceMode === 'preview' || snapshot.dataKind === 'synthetic_fixture');
      if (name === '/index.html' && (!tags.canonical || !tags.openGraph)) throw new Error('Home must declare its canonical/share identity');
    }
  }
  verifyRetainedAssets(snapshot, assets, manifest, context, priorPackage);
  console.log(JSON.stringify({ verified: true, releaseId: manifest.releaseId, assets: entries.length, nextExpiry: manifest.nextExpiry }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await verifyStaticRelease(path.resolve(import.meta.dirname, '../..'));
