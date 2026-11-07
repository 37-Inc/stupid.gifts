import path from 'node:path';
import {createHash} from 'node:crypto';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {validatePublicationConfig} from './publish-release.ts';
import {publishHostedInputs} from './hosted-inputs.ts';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {canonicalJson} from './migration.ts';
import {verifySemanticCatalogIdentities} from '../../lib/catalog/semantic-profile.ts';

export const HOSTED_CATALOG_BASE='/home/runner/.codex/private/goose-gifts-migration';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
const fail=()=>{throw Error('catalog_hosted_bootstrap_invalid');};

/** Environment handoff only, not a catalog/run migration. Historical seal,
 * observations, package paths and source bindings remain byte-for-byte intact.
 * A NEW hosted pointer references the same accepted seal at a new private path.
 * No credentials or visitor/search records are included in these input files.
 */
export async function prepareHostedBootstrap({state,base,policy={schemaVersion:1,enabled:false,discovery:false,homepage:false}}){
  const read=async(file,expected)=>{const bytes=await state.bytes(file);if(expected&&hash(bytes)!==expected)fail();return bytes;};
  const optional=async file=>{try{return await read(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const care=path.join(base,'daily-catalog-care'),original=JSON.parse(await read(path.join(care,'last-success.json'))),
    sealBytes=await read(original.control.path,original.control.sha256),seal=JSON.parse(sealBytes);
  catalogSuccessorBytes(seal);
  const publication=validatePublicationConfig(JSON.parse(await read(path.join(path.dirname(original.control.path),'config.json'))).publication);
  if(publication.accountId!==CATALOG_SCOPE.accountId||publication.database.id!==CATALOG_SCOPE.databaseId
    ||publication.workerName!==CATALOG_SCOPE.workerName||publication.indexName!==CATALOG_SCOPE.indexName
    ||publication.environment!=='production'||publication.identityOrigin!=='https://stupid.gifts')fail();
  const semanticBytes=await optional(path.join(care,'semantic-search.json')),semantic=semanticBytes?JSON.parse(semanticBytes):{enabled:false};
  let derivedBytes=null;
  if(semantic.enabled){if(!semantic.derivedCatalog?.path?.startsWith(base+'/')||! /^[a-f0-9]{64}$/.test(semantic.derivedCatalog.sha256))fail();
    derivedBytes=await read(semantic.derivedCatalog.path);
    const catalog=await verifySemanticCatalogIdentities(JSON.parse(derivedBytes));
    if(catalog.indexName!==semantic.derivedCatalog.indexName||hash(Buffer.from(canonicalJson(catalog)))!==semantic.derivedCatalog.sha256)fail();}
  const seed=hash(Buffer.concat([sealBytes,derivedBytes??Buffer.alloc(0)])),root='bootstrap/'+seed;
  const adjusted=semantic.enabled?{enabled:true,derivedCatalog:{...semantic.derivedCatalog,path:HOSTED_CATALOG_BASE+'/'+root+'/derived-search-catalog.json'}}:{enabled:false};
  const initialPointer={...original,control:{path:HOSTED_CATALOG_BASE+'/'+root+'/catalog-control.json',sha256:original.control.sha256}};
  const files=[{relative:root+'/catalog-control.json',bytes:sealBytes},
    {relative:root+'/config.json',bytes:encode({publication:{...publication,semanticSearch:adjusted}})},
    {relative:'daily-catalog-care/automation-policy.json',bytes:encode(policy)}];
  if(derivedBytes)files.push({relative:root+'/derived-search-catalog.json',bytes:derivedBytes});
  if(semantic.enabled)files.push({relative:'daily-catalog-care/semantic-search.json',bytes:encode(adjusted)});
  const edition=publication.homepage??JSON.parse(await read(path.join(path.dirname(original.control.path),'homepage-edition.json')));
  files.push({relative:root+'/homepage-edition.json',bytes:encode(edition)});
  for(const name of ['website-feed','product-reviews','research-leads']){
    const bytes=await optional(path.join(care,'campaigns',name+'.json'));
    if(bytes)files.push({relative:'daily-catalog-care/campaigns/'+name+'.json',bytes});
  }
  return{files,initialPointer,acceptedCatalog:{releaseId:seal.publication.releaseId,snapshotSha256:seal.snapshotSha256,receiptSha256:seal.publication.receiptSha256}};
}

/** Caller supplies the freshly verified CURRENT live/D1 acceptance and an
 * explicitly authorized bucket credential. Never overwrites a hosted successor.
 */
export async function publishHostedBootstrap(store,prepared,expectedInputsPointer,accepted){
  if(JSON.stringify(prepared.acceptedCatalog)!==JSON.stringify(accepted))fail();
  const prior=await store.get('pointers/last-success.json');
  if(prior){const value=JSON.parse(Buffer.from(prior.bytes));
    if(value.control?.sha256!==prepared.initialPointer.control.sha256||value.versionReference!==prepared.initialPointer.versionReference
      ||value.manifestSha256!==prepared.initialPointer.manifestSha256)throw Error('catalog_hosted_successor_exists');}
  const inputsRef=await publishHostedInputs(store,prepared.files,expectedInputsPointer);
  if(!prior)await store.compareAndSwap('pointers/last-success.json',null,encode(prepared.initialPointer));
  return{inputsRef,acceptedCatalog:prepared.acceptedCatalog,localHistoricalRunsMigrated:false};
}
