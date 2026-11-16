import type {ProjectionReceipt} from '../../lib/catalog/d1.ts';
import type {CatalogBuildRequest} from '../../lib/catalog/build-requests.ts';
import {encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import {canonicalJson} from './migration.ts';

/** Flat body-free public-data successor, NOT a legacy native-promotion seal. */
export interface RuntimeDeltaSeal {
  schemaVersion:1;kind:'runtime-delta-seal';envelopeJson:string;snapshotSha256:string;
  publication:{releaseId:string;receiptSha256:string};dataSha256:string;publicSnapshotSha256:string;
  projectionReceipt:ProjectionReceipt;nativeHistorySha256:string;indexDelivery:'asynchronous';
  previousPublication:{releaseId:string;receiptSha256:string};
  generation:number;scope:{environment:'production'|'staging';indexName:string};request:CatalogBuildRequest;
}
export function runtimeDeltaSealBytes(value:RuntimeDeltaSeal){
  const exact=(v:unknown,keys:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
  const hash=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
  const id=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s);
  const label=(s:unknown)=>typeof s==='string'&&/^[a-zA-Z0-9._-]{1,200}$/.test(s);
  const slug=(s:unknown)=>typeof s==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s)&&s.length<=200;
  const fail=():never=>{throw Error('runtime_delta_seal_invalid');};
  if(!exact(value,['schemaVersion','kind','envelopeJson','snapshotSha256','publication','dataSha256','publicSnapshotSha256',
    'projectionReceipt','nativeHistorySha256','indexDelivery','previousPublication','generation','scope','request'])||value.schemaVersion!==1||value.kind!=='runtime-delta-seal'
    ||value.indexDelivery!=='asynchronous'||![value.snapshotSha256,value.dataSha256,value.publicSnapshotSha256,value.nativeHistorySha256].every(hash)
    ||!Number.isSafeInteger(value.generation)||value.generation<1||!exact(value.scope,['environment','indexName'])
    ||!['staging','production'].includes(value.scope.environment)||! /^[a-zA-Z0-9_-]{1,100}$/.test(value.scope.indexName)
    ||!exact(value.publication,['releaseId','receiptSha256'])||!label(value.publication.releaseId)||!hash(value.publication.receiptSha256)
    ||!exact(value.previousPublication,['releaseId','receiptSha256'])||!label(value.previousPublication.releaseId)||!hash(value.previousPublication.receiptSha256)
    ||typeof value.envelopeJson!=='string')fail();
  const e=JSON.parse(value.envelopeJson),r=value.projectionReceipt;
  if(!exact(e,['schemaVersion','dataKind','catalogRevision','generatedAt','products','heldProducts','slugHistory'])
    ||e.schemaVersion!==1||e.dataKind!=='catalog'||!label(e.catalogRevision)||!Array.isArray(e.products)||!e.products.every(id)
    ||!Array.isArray(e.heldProducts)||e.products.length+e.heldProducts.length>10000||!Array.isArray(e.slugHistory)||e.slugHistory.length>20000)fail();
  for(const h of e.heldProducts){if(!exact(h,['id','publicId','slug','path','title','description','reason',...(h.affiliateUrl===undefined?[]:['affiliateUrl'])])
    ||!label(h.id)||!id(h.publicId)||!slug(h.slug)||h.path!==`/gifts/${h.slug}`||h.title!=='Gift currently unavailable'
    ||h.description!=='This gift is not currently available in the curated catalog. Browse other gifts instead.'||!label(h.reason)
    ||h.affiliateUrl!==undefined&&(typeof h.affiliateUrl!=='string'||!/^https:\/\/[^\s]{1,2000}$/.test(h.affiliateUrl)))fail();}
  const ids=[...e.products,...e.heldProducts.map((h:{publicId:string})=>h.publicId)];if(new Set(ids).size!==ids.length)fail();
  if(e.slugHistory.some((s:{slug:string;canonicalSlug:string;publicId:string})=>!exact(s,['slug','canonicalSlug','publicId'])
    ||!slug(s.slug)||!slug(s.canonicalSlug)||!id(s.publicId))
    ||!exact(r,['catalog_revision','snapshot_sha256','projection_sha256','source_export_sha256','product_count','created_at'])
    ||r.catalog_revision!==e.catalogRevision||r.snapshot_sha256!==value.snapshotSha256||![r.projection_sha256,r.source_export_sha256].every(hash)
    ||r.product_count!==e.products.length||r.created_at!==e.generatedAt)fail();
  encodeBuildRequest(value.request);
  if(value.request.environment!==value.scope.environment||value.request.sourceRevision!==e.catalogRevision
    ||value.request.priorReleaseId!==value.previousPublication.releaseId
    ||value.request.sourceDigest!==value.snapshotSha256||new Date(e.generatedAt).toISOString()!==e.generatedAt)fail();
  const bytes=Buffer.from(canonicalJson(value));if(bytes.length>8*1024*1024)fail();return bytes;
}
