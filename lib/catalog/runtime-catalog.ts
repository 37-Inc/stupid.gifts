import type {CatalogSnapshot,SiteAssetManifest} from './types.ts';
import {validateCatalogSnapshot} from './snapshot.ts';
import {readHomepageEdition} from './homepage-edition.ts';
import {readMerchandising} from './merchandising.ts';
import type {SemanticCatalog} from './semantic-profile.ts';

export const RUNTIME_CATALOG_CONTRACT=1;
export const RUNTIME_CATALOG_PREFIX='catalog-v1/public-catalog/';
export interface RuntimeCatalogAsset {sha256:string;contentType:string;eligibleUntil:string|null}
/** Public data only. Original snapshot ordering, copy, rights deadlines and
 * native search descriptors are preserved; no operational rows or secrets. */
export interface RuntimeCatalogData {
  schemaVersion:1;releaseId:string;sourceCodeSha:string;snapshot:CatalogSnapshot;
  homepage?:SiteAssetManifest['homepage'];merchandising?:SiteAssetManifest['merchandising'];semanticCatalog?:SemanticCatalog;
  assets:Record<string,RuntimeCatalogAsset>;
  /** Identities/order only; expired supplier bodies never enter the base blob. */
  productOrder:string[];overlays:Array<{sha256:string;expiresAt:string}>;
  disclosures?:Record<string,string>;
  repairedSemanticIds?:string[];
  /** Hashes of exact original permanent input fields, not alternate public copy. */
  legacySemanticFieldsSha256?:Record<string,string>;
}
export interface RuntimeCatalogHead {releaseId:string;catalogRevision:string;dataSha256:string;snapshotSha256:string;version:number}
const HASH=/^[a-f0-9]{64}$/,KEY=/^[a-zA-Z0-9._-]{1,200}$/;
export async function runtimeDigest(bytes:Uint8Array|string){
  const data=typeof bytes==='string'?new TextEncoder().encode(bytes):new Uint8Array(bytes);
  const digest=await crypto.subtle.digest('SHA-256',data);
  return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export function readRuntimeCatalogData(value:unknown):RuntimeCatalogData{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('runtime_catalog_invalid');
  const data=value as RuntimeCatalogData;
  if(Object.keys(data).some(key=>!['schemaVersion','releaseId','sourceCodeSha','snapshot','homepage','merchandising','semanticCatalog','assets','productOrder','overlays','disclosures','repairedSemanticIds','legacySemanticFieldsSha256'].includes(key))
    ||data.schemaVersion!==1||!KEY.test(data.releaseId)||!/^[a-f0-9]{40}$/.test(data.sourceCodeSha)||!data.assets
    ||typeof data.assets!=='object'||Array.isArray(data.assets)||!Array.isArray(data.productOrder)||new Set(data.productOrder).size!==data.productOrder.length
    ||data.productOrder.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))||!Array.isArray(data.overlays)
    ||data.overlays.some(ref=>!ref||Object.keys(ref).sort().join(',')!=='expiresAt,sha256'||!HASH.test(ref.sha256)
      ||!Number.isFinite(Date.parse(ref.expiresAt))||new Date(ref.expiresAt).toISOString()!==ref.expiresAt))throw Error('runtime_catalog_invalid');
  const snapshot=validateCatalogSnapshot(data.snapshot,new Date(data.snapshot?.generatedAt));
  if(snapshot.dataKind!=='catalog')throw Error('runtime_catalog_fixture_forbidden');
  if(snapshot.products.some(p=>p.eligibleUntil!==null||p.persistent))throw Error('runtime_catalog_base_has_finite_content');
  if(data.repairedSemanticIds!==undefined&&(!Array.isArray(data.repairedSemanticIds)||new Set(data.repairedSemanticIds).size!==data.repairedSemanticIds.length
    ||data.repairedSemanticIds.some(id=>!data.productOrder.includes(id))))throw Error('runtime_catalog_metadata_invalid');
  if(data.legacySemanticFieldsSha256!==undefined&&(!data.legacySemanticFieldsSha256||typeof data.legacySemanticFieldsSha256!=='object'||Array.isArray(data.legacySemanticFieldsSha256)
    ||Object.entries(data.legacySemanticFieldsSha256).some(([id,value])=>!data.productOrder.includes(id)||!HASH.test(value))))throw Error('runtime_catalog_metadata_invalid');
  if(data.disclosures!==undefined&&(!data.disclosures||typeof data.disclosures!=='object'||Array.isArray(data.disclosures)
    ||Object.values(data.disclosures).some(value=>typeof value!=='string'||value.length>2000)))throw Error('runtime_catalog_metadata_invalid');
  if(data.homepage!==undefined&&!readHomepageEdition(data.homepage)||data.merchandising!==undefined&&!readMerchandising(data.merchandising))throw Error('runtime_catalog_metadata_invalid');
  for(const [path,asset]of Object.entries(data.assets)){
    if(!/^\/(?:images|og|brand|illustrations)\/[a-zA-Z0-9_./-]+$/.test(path)||path.split('/').some(p=>p==='.'||p==='..')
      ||!asset||Object.keys(asset).sort().join(',')!=='contentType,eligibleUntil,sha256'||!HASH.test(asset.sha256)
      ||! /^(?:image\/(?:svg\+xml|png|jpeg|webp|gif|avif))$/.test(asset.contentType)
      ||asset.eligibleUntil!==null&&(!Number.isFinite(Date.parse(asset.eligibleUntil))||new Date(asset.eligibleUntil).toISOString()!==asset.eligibleUntil))
      throw Error('runtime_catalog_asset_invalid');
  }
  return{...data,snapshot};
}
export function runtimeDataBytes(data:RuntimeCatalogData){return new TextEncoder().encode(JSON.stringify(readRuntimeCatalogData(data))+'\n');}
export function runtimeAssetKey(asset:RuntimeCatalogAsset){
  return 'catalog-v1/'+(asset.eligibleUntil===null?'public-assets/':`public-finite-assets/${Date.parse(asset.eligibleUntil)}/`)+asset.sha256;
}
export const runtimeOverlayKey=(ref:{sha256:string;expiresAt:string})=>`catalog-v1/public-overlays/${Date.parse(ref.expiresAt)}/${ref.sha256}.json`;
