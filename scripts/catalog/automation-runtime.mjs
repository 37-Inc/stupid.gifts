import path from 'node:path';
import {homedir} from 'node:os';
import {createOperatorStateStore} from './operator-state-store.ts';
import {createCatalogR2Store} from './r2-object-store.ts';
import {CATALOG_ENVIRONMENT_CREDENTIALS} from './credential-reference.ts';
import {resolveCloudflareCredential} from './check-cloudflare-runner.ts';

export const CATALOG_SCOPE=Object.freeze({environment:'production',accountId:'7f05a1dcb6e16f9c239564a0293bbe74',
  databaseId:'77b30f85-c57c-4acb-a0df-53368806c2a6',databaseName:'stupid-gifts-production',
  workerName:'stupid-gifts-production',indexName:'stupid-gifts-production'});

/** Explicit trusted main-branch workflow only. Local execution remains on the
 * reviewed Keychain/OAuth references; it never discovers hosted secrets. */
export function automationRuntime(environment=process.env){
  const hosted=environment.STUPID_GIFTS_OPERATOR_MODE==='hosted';
  if(environment.STUPID_GIFTS_OPERATOR_MODE!==undefined&&!hosted)throw Error('catalog_operator_mode');
  if(hosted&&(environment.GITHUB_ACTIONS!=='true'||environment.GITHUB_REPOSITORY!=='37-Inc/stupid.gifts'
    ||environment.GITHUB_REF!=='refs/heads/main'))throw Error('catalog_hosted_source');
  const base=path.join(homedir(),'.codex/private/goose-gifts-migration');
  const credentials=hosted?Object.fromEntries(Object.entries(CATALOG_ENVIRONMENT_CREDENTIALS)
    .map(([role,name])=>[role,{type:'environment',name}])):{cloudflare:{type:'wrangler_oauth'},
    ...Object.fromEntries(['amazonId','amazonSecret','openai'].map(role=>[role,{service:'goose.gifts.'+
      ({amazonId:'AMAZON_CREATORS_CREDENTIAL_ID',amazonSecret:'AMAZON_CREATORS_CREDENTIAL_SECRET',openai:'OPENAI_API_KEY'})[role],account:'goose.gifts'}]))};
  let durable;
  if(hosted){
    const value=name=>{const result=environment[name];if(!result||result.length>4096||/[^\x21-\x7e]/.test(result))throw Error('catalog_hosted_storage_credentials');return result;};
    durable=createCatalogR2Store({accountId:CATALOG_SCOPE.accountId,bucket:'stupid-gifts-catalog-private',prefix:'catalog-v1',
      accessKeyId:value('STUPID_GIFTS_R2_ACCESS_KEY_ID'),secretAccessKey:value('STUPID_GIFTS_R2_SECRET_ACCESS_KEY')});
  }
  return{hosted,base,care:path.join(base,'daily-catalog-care'),workspace:path.join(base,'weekly-runs'),credentials,durable,
    state:createOperatorStateStore(base,durable),token:()=>resolveCloudflareCredential(credentials.cloudflare)};
}
