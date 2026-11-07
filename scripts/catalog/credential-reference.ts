/** Names are explicit nonsecret configuration. No ambient alias/fallback or
 * copied Keychain/OAuth session is accepted for hosted credentials. */
export const CATALOG_ENVIRONMENT_CREDENTIALS=Object.freeze({
  cloudflare:'STUPID_GIFTS_CLOUDFLARE_API_TOKEN',
  amazonId:'STUPID_GIFTS_AMAZON_CREDENTIAL_ID',
  amazonSecret:'STUPID_GIFTS_AMAZON_CREDENTIAL_SECRET',
  openai:'STUPID_GIFTS_OPENAI_API_KEY',
  stagingAuthSecret:'STUPID_GIFTS_STAGING_AUTH_SECRET',
} as const);
export type CatalogCredentialRole=keyof typeof CATALOG_ENVIRONMENT_CREDENTIALS;
export interface KeychainCredentialReference {service:string;account:string}
export interface EnvironmentCredentialReference {
  type:'environment';name:typeof CATALOG_ENVIRONMENT_CREDENTIALS[CatalogCredentialRole];
}
export type CatalogCredentialReference=KeychainCredentialReference|EnvironmentCredentialReference;
const exact=(value:unknown,keys:string)=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===keys);
export function isEnvironmentCredentialReference(value:unknown,role?:CatalogCredentialRole):value is EnvironmentCredentialReference {
  const ref=value as EnvironmentCredentialReference;
  return exact(ref,'name,type')&&ref.type==='environment'
    &&(role?ref.name===CATALOG_ENVIRONMENT_CREDENTIALS[role]
      :Object.values(CATALOG_ENVIRONMENT_CREDENTIALS).some(name=>name===ref.name));
}
export function isCatalogCredentialReference(value:unknown,role?:CatalogCredentialRole):value is CatalogCredentialReference {
  const ref=value as KeychainCredentialReference;
  return isEnvironmentCredentialReference(value,role)||exact(ref,'account,service')
    &&typeof ref.service==='string'&&/^goose\.gifts\.[a-zA-Z0-9._:/-]{1,150}$/.test(ref.service)
    &&typeof ref.account==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._@:/-]{0,199}$/.test(ref.account);
}
export function readCatalogEnvironmentCredential(ref:EnvironmentCredentialReference,environment:NodeJS.ProcessEnv=process.env):string {
  if(!isEnvironmentCredentialReference(ref))throw Error('catalog_credential_reference');
  const value=environment[ref.name];
  if(!value||value.length>4096||/[^\x21-\x7e]/.test(value))throw Error('catalog_environment_credential_unavailable');
  return value;
}
