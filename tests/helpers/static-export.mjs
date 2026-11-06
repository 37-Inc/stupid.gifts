import fs from 'node:fs';
import {createStaticRoutes} from '../../static-site/lib/asset-routes.ts';
import {expandRscAssets} from '../../static-site/lib/asset-compaction.ts';
import {siteIdentity,siteIdentityFor,siteSourceMode} from '../../static-site/lib/site-identity.ts';

// Existing export tests must follow their sealed build, not the ambient test
// process's default preview identity or only the compacted physical filenames.
const manifestPath=new URL('../../build/stupid-gifts/asset-manifest.json',import.meta.url);
const manifest=fs.existsSync(manifestPath)?JSON.parse(fs.readFileSync(manifestPath,'utf8')):null;
export const exportSourceMode=manifest?.sourceMode??siteSourceMode;
export const exportIdentity=manifest?siteIdentityFor(exportSourceMode):siteIdentity;
export const exportGeneratedAt=manifest?.generatedAt;
export const exportHomepage=manifest?.homepage;
export function exportedRoutes(snapshot,inventory){
  // Validate one-hop target/path membership without loading every PNG body.
  const empty=new Uint8Array();
  const logical=[...expandRscAssets(new Map(inventory.map(name=>[name,empty])),manifest?.assetAliases).keys()].sort();
  return createStaticRoutes(snapshot,logical,undefined,exportIdentity,exportGeneratedAt??snapshot.generatedAt,exportHomepage);
}
