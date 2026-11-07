import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, mkdtemp, chmod, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertProtectedDestination } from './export-postgres.ts';
import { createCloudflareReadClient, RUNNER_COLUMNS } from './d1-rest.ts';
import type { ReadRow } from './d1-rest.ts';
import {isCatalogCredentialReference,isEnvironmentCredentialReference,readCatalogEnvironmentCredential} from './credential-reference.ts';
import type {CatalogCredentialReference,EnvironmentCredentialReference} from './credential-reference.ts';

interface KeychainReference { service:string; account:string }
export type CloudflareCredentialReference = CatalogCredentialReference | {type:'wrangler_oauth'};
export interface RunnerCheckConfig {
  schemaVersion:1; environment:'staging'|'production'; accountId:string;
  database:{id:string;name:string}; vectorIndex:{name:string;dimensions:1536;metric:'cosine'};
  catalog:{associateTag:string;marketplace:'www.amazon.com'};
  cloudflareReadToken:CloudflareCredentialReference;
}
const digest=(value:string|Uint8Array) => createHash('sha256').update(value).digest('hex');
const keys=(value:unknown,expected:string) => Boolean(value && typeof value==='object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',')===expected);
const text=(value:unknown,pattern:RegExp) => typeof value==='string' && pattern.test(value);
const keychainReference=(ref:unknown):ref is KeychainReference => keys(ref,'account,service')
  && text((ref as KeychainReference).service,/^goose\.gifts\.[a-zA-Z0-9._:/-]{1,150}$/)
  && text((ref as KeychainReference).account,/^[a-zA-Z0-9][a-zA-Z0-9._@:/-]{0,199}$/);
const oauthReference=(ref:unknown):ref is {type:'wrangler_oauth'} => keys(ref,'type')
  && (ref as {type:string}).type==='wrangler_oauth';
export function validateRunnerCheckConfig(input:unknown):RunnerCheckConfig {
  const c=input as RunnerCheckConfig;
  if (!keys(c,'accountId,catalog,cloudflareReadToken,database,environment,schemaVersion,vectorIndex') || c.schemaVersion!==1
    || !['staging','production'].includes(c.environment) || !text(c.accountId,/^[a-f0-9]{32}$/)
    || !keys(c.database,'id,name') || !text(c.database.id,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/)
    || !text(c.database.name,/^[a-zA-Z0-9_-]{1,100}$/) || !keys(c.vectorIndex,'dimensions,metric,name')
    || !text(c.vectorIndex.name,/^[a-zA-Z0-9_-]{1,100}$/) || c.vectorIndex.dimensions!==1536
    || c.vectorIndex.metric!=='cosine' || !keys(c.catalog,'associateTag,marketplace')
    || typeof c.catalog.associateTag!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(c.catalog.associateTag)
    || c.catalog.marketplace!=='www.amazon.com'
    || !isCatalogCredentialReference(c.cloudflareReadToken,'cloudflare')&&!oauthReference(c.cloudflareReadToken)) throw new Error('runner_check_config_invalid');
  return JSON.parse(JSON.stringify(c));
}
/** Explicit existing item only: never searches other services, env, files or Vercel.
 * No Keychain writes, shell interpolation, credential output or ambient fallback.
 */
export async function resolveReadToken(ref:KeychainReference, run=promisify(execFile)):Promise<string> {
  if (!/^goose\.gifts\.[a-zA-Z0-9._:/-]{1,150}$/.test(ref.service)
    || !/^[a-zA-Z0-9][a-zA-Z0-9._@:/-]{0,199}$/.test(ref.account)) throw new Error('runner_check_keychain_reference');
  try {
    const result=await run('/usr/bin/security',['find-generic-password','-s',ref.service,'-a',ref.account,'-w'],
      {encoding:'utf8',timeout:3000,maxBuffer:8192});
    const token=String(result.stdout).trim();
    if (!token || token.length>4096 || /[^\x21-\x7e]/.test(token)) throw new Error();
    return token;
  } catch { throw new Error('runner_check_keychain_unavailable'); }
}

/** Explicit existing Wrangler OAuth only. Its documented `auth token --json`
 * refreshes through Wrangler's own cache; no copied refresh-token logic, login,
 * fallback, npx download or token persistence is introduced here.
 * https://developers.cloudflare.com/workers/wrangler/commands/general/#auth-token
 */
export async function resolveWranglerOAuth(run=promisify(execFile)):Promise<string> {
  let directory:string|undefined;
  try {
    const root=new URL('../../',import.meta.url);
    const manifest=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
    const installed=JSON.parse(await readFile(new URL('node_modules/wrangler/package.json',root),'utf8'));
    if(!/^\d+\.\d+\.\d+$/.test(manifest.devDependencies?.wrangler)||installed.version!==manifest.devDependencies.wrangler)throw new Error();
    directory=await mkdtemp(join(tmpdir(),'goose-catalog-oauth-'));await chmod(directory,0o700);
    const result=await run(process.execPath,[fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js',root)),'auth','token','--json'],{
      cwd:directory,encoding:'utf8',timeout:10000,maxBuffer:8192,
      env:{HOME:homedir(),PATH:'/usr/bin:/bin',NODE_ENV:'production',CI:'true',BROWSER:'false',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',
        WRANGLER_WRITE_LOGS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG:'log'},
    });
    const stdout=String(result.stdout);
    if(Buffer.byteLength(stdout)>8192||String(result.stderr).trim())throw new Error();
    const value=JSON.parse(stdout);
    if(!keys(value,'token,type')||value.type!=='oauth'||typeof value.token!=='string'
      ||!value.token||value.token.length>4096||/[^\x21-\x7e]/.test(value.token))throw new Error();
    return value.token;
  } catch { throw new Error('runner_check_oauth_unavailable'); }
  finally { if(directory)await rm(directory,{recursive:true,force:true}); }
}
export async function resolveCatalogCredential(ref:CatalogCredentialReference,readKeychain=resolveReadToken,
  readEnvironment:(ref:EnvironmentCredentialReference)=>string=readCatalogEnvironmentCredential):Promise<string> {
  if(keychainReference(ref))return readKeychain(ref);
  if(isEnvironmentCredentialReference(ref))return readEnvironment(ref);
  throw new Error('runner_check_credential_reference');
}
export async function resolveCloudflareCredential(ref:CloudflareCredentialReference,
  readKeychain=resolveReadToken,readOAuth=resolveWranglerOAuth,
  readEnvironment:(ref:EnvironmentCredentialReference)=>string=readCatalogEnvironmentCredential):Promise<string> {
  if(keychainReference(ref))return readKeychain(ref);
  if(oauthReference(ref))return readOAuth();
  if(isEnvironmentCredentialReference(ref,'cloudflare'))return readEnvironment(ref);
  throw new Error('runner_check_cloudflare_reference');
}

const NOT_ACCEPTED = [
  'Weekly execution is unavailable; no owner was claimed or writer selected.',
  'Structural schema inspection is not migration, rollback or REST write-atomicity acceptance.',
  'No Amazon/OpenAI credentials or calls, product rights, vector contents, candidate approval or deployment were verified.',
  'Token permission scope was not audited; only fixed read requests were sent.',
  'No scheduler, daily merchant-refresh policy, final Neon delta or production cutover was changed.',
];
export async function checkCloudflareRunner(input:unknown, options:{
  resolveToken?:(reference:KeychainReference)=>Promise<string>; resolveWranglerOAuth?:()=>Promise<string>;fetch?:typeof fetch; timeoutMs?:number;
}={}) {
  const config=validateRunnerCheckConfig(input);
  const token=await resolveCloudflareCredential(config.cloudflareReadToken,options.resolveToken,options.resolveWranglerOAuth);
  const client=createCloudflareReadClient({accountId:config.accountId,databaseId:config.database.id,indexName:config.vectorIndex.name,
    token,fetch:options.fetch,timeoutMs:options.timeoutMs});
  const issues:string[]=[];
  const database=await client.database() as ReadRow;
  if (!database || database.uuid!==config.database.id || database.name!==config.database.name) throw new Error('runner_check_database_mismatch');
  const index=await client.vectorIndex() as {name?:unknown;config?:{dimensions?:unknown;metric?:unknown}};
  if (!index || index.name!==config.vectorIndex.name || index.config?.dimensions!==1536 || index.config?.metric!==config.vectorIndex.metric)
    throw new Error('runner_check_index_mismatch');
  const [capabilities,schema]=await client.read(['capabilities','schema']);
  if (capabilities.results[0]?.valid_json!==1 || capabilities.results[0]?.normalized_date!=='2024-03-01T00:00:00.000Z')
    issues.push('sqlite_capabilities');
  if (schema.results.length>=201) throw new Error('runner_check_schema_bound');
  const objects=new Map(schema.results.map(row => [String(row.name),String(row.type)]));
  const expected=new Map(Object.keys(RUNNER_COLUMNS).map(name => [name,'table']));
  // Check current ownership/evidence objects without installing any schema.
  for (const file of ['0009_catalog_mutation_fence.sql','0010_catalog_maintenance.sql','0011_owned_vector_delivery.sql','0012_catalog_run_telemetry.sql']) {
    const source=await readFile(new URL(`../../migrations/d1/${file}`,import.meta.url),'utf8');
    for (const match of source.matchAll(/^CREATE (?:UNIQUE )?(TABLE|TRIGGER|INDEX) ([a-z_]+)/gm)) expected.set(match[2],match[1].toLowerCase());
  }
  for (const [name,type] of expected) if (objects.get(name)!==type) issues.push(`missing_${type}:${name}`);
  const tables=Object.keys(RUNNER_COLUMNS).filter(name => objects.get(name)==='table');
  const columns=tables.length ? await client.read(tables.map(name => `columns:${name}`)) : [];
  for (const [i,table] of tables.entries()) {
    const names=new Set(columns[i].results.map(row => String(row.name)));
    for (const column of RUNNER_COLUMNS[table]) if (!names.has(column)) issues.push(`missing_column:${table}.${column}`);
  }
  let ownership:ReadRow|null=null,pending:ReadRow|null=null;
  if (!issues.length) {
    const [scopes,work]=await client.read(['ownership','pending']);
    ownership=scopes.results.length===1 ? Object.fromEntries(['environment','index_name','phase','generation','mutation_epoch','external_pending']
      .map(key => [key,scopes.results[0][key]])) : null;
    if (!ownership || ownership.environment!==config.environment || ownership.index_name!==config.vectorIndex.name) issues.push('ownership_scope_not_enabled_or_mismatched');
    else if (ownership.phase!=='idle' || ownership.external_pending!==0) issues.push('ownership_busy');
    pending=work.results[0] ? Object.fromEntries(['vector_work','vector_deliveries','builds','runs'].map(key => [key,work.results[0][key]])) : null;
    if (!pending || Object.values(pending).some(value => value!==0)) issues.push('pending_work_requires_reconciliation');
  }
  return {schemaVersion:1,kind:'cloudflare-runner-readiness',checkedAt:new Date().toISOString(),
    status:issues.length?'blocked':'checks_passed_execution_unavailable',executionAvailable:false,
    environment:config.environment,resources:{accountId:config.accountId,databaseId:config.database.id,databaseName:config.database.name,indexName:config.vectorIndex.name},
    affiliateConfiguration:'provided by reviewed configuration; not independently merchant-verified',
    schemaSha256:digest(JSON.stringify(schema.results)),issues,ownership,pending,metrics:client.metrics(),limitations:NOT_ACCEPTED};
}

export async function writeRunnerCheck(options:{configPath:string;configSha256:string;output:string;repository:string},
  dependencies:Parameters<typeof checkCloudflareRunner>[1]={}) {
  if (!/^[a-f0-9]{64}$/.test(options.configSha256)) throw new Error('runner_check_config_digest');
  const info=await lstat(options.configPath);
  if (!info.isFile() || info.mode&0o077 || info.size>32768 || info.uid!==process.getuid?.()) throw new Error('runner_check_config_protection');
  const bytes=await readFile(options.configPath);
  if (bytes.length>32768 || digest(bytes)!==options.configSha256) throw new Error('runner_check_config_digest');
  const config=validateRunnerCheckConfig(JSON.parse(bytes.toString('utf8')));
  const output=await assertProtectedDestination(options.output,options.repository);
  await mkdir(output,{mode:0o700}); // No overwrite, including after a failed check.
  let result;
  try { result=await checkCloudflareRunner(config,dependencies); }
  catch (error) {
    const codes=['runner_check_keychain_unavailable','runner_check_oauth_unavailable','runner_check_database_mismatch','runner_check_index_mismatch','runner_check_schema_bound',
      'cloudflare_read_unavailable','cloudflare_read_result_invalid','cloudflare_read_configuration'];
    result={schemaVersion:1,kind:'cloudflare-runner-readiness',status:'failed',executionAvailable:false,
      checkedAt:new Date().toISOString(),errorCode:error instanceof Error && codes.includes(error.message)?error.message:'runner_check_failed',limitations:NOT_ACCEPTED};
  }
  const git=(...args:string[]) => execFileSync('git',args,{cwd:options.repository,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
  const receipt={...result,reviewedConfigSha256:options.configSha256,source:{codeSha:git('rev-parse','HEAD'),dirty:Boolean(git('status','--porcelain'))}};
  const body=`${JSON.stringify(receipt,null,2)}\n`;
  await writeFile(join(output,'receipt.json'),body,{mode:0o600,flag:'wx'});
  return {status:receipt.status,executionAvailable:false,receiptSha256:digest(body),output};
}
async function main() {
  const args=process.argv.slice(2);
  if (args.includes('--execute')) throw new Error('runner_check_execution_unavailable');
  if (args.length===1 && args[0]==='--help') {
    console.log('Read-only readiness only: --config /private/reviewed.json --config-sha256 SHA256 --output /private/new-check\nConfig: schemaVersion, environment, accountId, database:{id,name}, vectorIndex:{name,dimensions:1536,metric}, catalog:{associateTag,marketplace}, cloudflareReadToken:{service,account} OR {type:"wrangler_oauth"}. Explicit existing auth only; no fallback, execution or provisioning.');return;
  }
  if (args.length!==6 || args[0]!=='--config' || args[2]!=='--config-sha256' || args[4]!=='--output') throw new Error('runner_check_arguments');
  const repository=resolve(fileURLToPath(new URL('../..',import.meta.url)));
  const result=await writeRunnerCheck({configPath:resolve(args[1]),configSha256:args[3],output:args[5],repository});
  console.log(JSON.stringify(result)); if (result.status!=='checks_passed_execution_unavailable') process.exitCode=1;
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {console.error('Runner readiness check failed; execution is unavailable. No provider error details are logged.');process.exitCode=1;});
}
