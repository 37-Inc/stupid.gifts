import type { CatalogD1, D1Statement, D1ReadOptions } from '../../lib/catalog/storage/d1.ts';
import { createHash, randomUUID } from 'node:crypto';
import { drainDeploymentObservation } from '../../lib/catalog/build-requests.ts';
import { assertOneTimeMigrationBudget, validMigrationLedger } from './one-time-migration-budget.ts';
import type { OneTimeMigrationBudget } from './one-time-migration-budget.ts';
import { assertPublicationRecoveryBudget } from './publication-recovery-budget.ts';
import type { PublicationRecoveryBudget } from './publication-recovery-budget.ts';
import { canonicalJson } from './migration.ts';
import {MAINTENANCE_SLUG_TRIGGER} from './maintenance-state.ts';
const ownedClients=new WeakSet<CatalogD1>();
export function isCatalogD1Rest(db:CatalogD1):boolean{return ownedClients.has(db);}

/** Protected Node wiring only; no credentials/bootstrap, schema, lock or runner.
 * REST wire: https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/
 * Batch contract: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 * Mocks do NOT prove this REST transport's atomicity; exercise the exact adapter
 * against a disposable database before selecting it for a real writer.
 */
export const CATALOG_D1_REST_LIMITS = Object.freeze({ requests:600,statements:1200,batchStatements:50,parameters:100,
  requestBytes:512*1024,responseBytes:512*1024,timeoutMs:10_000,reportedRowsRead:1_000_000,reportedRowsWritten:10_000 });
// Explicit whole-client allowance only; defaults never grow automatically.
// Defaults stay conservative. An explicit immutable operator config may select
// a larger finite workload; these ceilings never represent shared-account headroom.
// The 3M read ceiling accommodates explicit once-only post-activation settlement;
// the 1M default and ordinary weekly-config 2M maximum remain unchanged.
const HARD_LIMITS=Object.freeze({...CATALOG_D1_REST_LIMITS,requests:10_000,statements:25_000,
  reportedRowsRead:3_000_000,reportedRowsWritten:50_000});
type Limits = { [K in keyof typeof CATALOG_D1_REST_LIMITS]:number };
type Param = string | number | null;
type Query = { sql:string;params:readonly Param[] };
type Result<T = Record<string,unknown>> = { success:true;results:T[];meta:Record<string,number|boolean> };
type FailureDetail = { stage:'preflight'|'request'|'response';reason:string;dispatched:boolean;
  statementCount:number;requestBytes:number;requestSha256:string;httpStatus?:number;providerCodes?:number[];responseBytes?:number;responseLimit?:number;
  phase?:string;method?:string;productIds?:string[] };
/** Numeric/request-identity evidence only. Never include SQL, values, tokens or provider messages. */
export function catalogD1FailureDetail(value:unknown):FailureDetail|undefined {
  // Domain wrappers keep a safe public code; retain only this allowlisted
  // diagnostic from their bounded cause chain, never raw SQL/provider errors.
  for(let depth=0;value instanceof Error&&depth<8;depth++){
    const error=value as Error&{catalogDiagnostic?:unknown};
    if(error.catalogDiagnostic!==undefined){value=error.catalogDiagnostic;break;}
    value=error.cause;
  }
  const v=(value instanceof Error?(value as Error&{catalogDiagnostic?:unknown}).catalogDiagnostic:value) as FailureDetail;
  if(!v||!['preflight','request','response'].includes(v.stage)
    ||!['batch_statements','request_bytes','response_bytes','accounting_reservation','http_error','provider_error','invalid_response','timeout','cancelled','transport_error'].includes(v.reason)
    ||typeof v.dispatched!=='boolean'||![v.statementCount,v.requestBytes].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||!/^[a-f0-9]{64}$/.test(v.requestSha256))return;
  const detail:FailureDetail={stage:v.stage,reason:v.reason,dispatched:v.dispatched,statementCount:v.statementCount,requestBytes:v.requestBytes,requestSha256:v.requestSha256};
  if(Number.isInteger(v.httpStatus)&&(v.httpStatus??0)>=100&&(v.httpStatus??0)<=599)detail.httpStatus=v.httpStatus;
  for(const key of ['responseBytes','responseLimit'] as const)if(Number.isSafeInteger(v[key])&&Number(v[key])>=0)detail[key]=v[key];
  if(Array.isArray(v.providerCodes)&&v.providerCodes.length<=8&&v.providerCodes.every(n=>Number.isSafeInteger(n)&&n>=0))detail.providerCodes=[...v.providerCodes];
  if(typeof v.phase==='string'&&/^phase-\d+$/.test(v.phase))detail.phase=v.phase;
  if(['upsertProduct','recordEditorialEvent','markConfirmedMissingUnavailable'].includes(v.method??''))detail.method=v.method;
  if(Array.isArray(v.productIds)&&v.productIds.length<=50&&v.productIds.every(id=>/^[A-Z0-9]{10}$/.test(id)))detail.productIds=[...v.productIds];
  return detail;
}
class CatalogD1RequestError extends Error {
  readonly catalogDiagnostic:FailureDetail;
  constructor(code:string,catalogDiagnostic:FailureDetail){super(code);this.catalogDiagnostic=catalogDiagnostic;}
}
export interface D1AccountingState {
  httpRequests:number;sqlStatements:number;knownRowsRead:number;knownRowsWritten:number;unconfirmedRequests:number;
}
/** Trusted private durable ledger, bound to the same exact resources/run caps.
 * Reservation MUST atomically enforce aggregate caps (including other clients)
 * before acknowledging. Pending/unknown reservations never refund on restart.
 * The ledger sees only request digests/units, never SQL, values or credentials.
 */
export interface D1Accounting {
  scope:{accountId:string;databaseId:string;databaseName:string};initial:D1AccountingState;
  reserve(input:{id:string;requestSha256:string;units:{httpRequests:1;sqlStatements:number}}):Promise<void>;
  settle(id:string,result:{status:'known';usage:{rowsRead:number;rowsWritten:number}}|{status:'unknown';usage:null}):Promise<void>;
}
const integer = (value:unknown):value is number => Number.isSafeInteger(value) && Number(value)>=0;
const object = (value:unknown):value is Record<string,unknown> => Boolean(value && typeof value==='object' && !Array.isArray(value));

// One statement per batch member. Ignore delimiters in SQL strings/comments;
// Schema scripts are not this API. One exact, single-statement trigger restore
// is allowed for the atomic unpublished-URL repair; arbitrary bodies are not.
function sqlText(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||value.includes('\0')||Buffer.byteLength(value)>64*1024)throw new Error('catalog_d1_statement_invalid');
  if(value===MAINTENANCE_SLUG_TRIGGER)return value;
  let token=false,ended=false;
  for(let i=0;i<value.length;i++){
    const c=value[i];if(/\s/.test(c))continue;
    if(value.startsWith('--',i)){const end=value.indexOf('\n',i+2);i=end<0?value.length:end;continue;}
    if(value.startsWith('/*',i)){const end=value.indexOf('*/',i+2);if(end<0)throw new Error('catalog_d1_statement_invalid');i=end+1;continue;}
    if(ended)throw new Error('catalog_d1_statement_invalid');
    if(c===';'){ended=true;continue;}token=true;
    if("'\"`[".includes(c)){
      const close=c==='['?']':c;let closed=false;
      for(i++;i<value.length;i++)if(value[i]===close){if(close!==']'&&value[i+1]===close){i++;continue;}closed=true;break;}
      if(!closed)throw new Error('catalog_d1_statement_invalid');
    }
  }
  if(!token)throw new Error('catalog_d1_statement_invalid');return value;
}

type RestOptions={
  accountId:string;databaseId:string;databaseName:string;token:string;fetch?:typeof fetch;limits?:Partial<Limits>;accounting?:D1Accounting;
  requestLimit?:'enforce'|'observe';
};
type RestClient=CatalogD1 & { providerIdentity:string;metrics:()=>{
  requests:number;statements:number;reportedRowsRead:number|null;reportedRowsWritten:number|null;unconfirmedRequests:number;
} };
export function createCatalogD1Rest(options:RestOptions):Promise<RestClient>{return createRest(options);}

/** Diagnostics reject unsupported SQL before a reservation or dispatch.
 * Read-only preparation may observe aggregate estimates without a write ledger;
 * writable transports still require durable accounting for observation mode. */
export function createCatalogD1ReadOnlyRest(options:RestOptions):Promise<RestClient>{
  return createRest(options,undefined,batch=>{
    for(const {sql} of batch){
      const text=sql.trim();
      if (/^PRAGMA\s+table_info\([a-z_][a-z0-9_]*\)$/i.test(text)) continue;
      if (!/^(?:SELECT|WITH)\b/i.test(text)
        || /\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|PRAGMA|ATTACH|DETACH|VACUUM)\b/i.test(text))
        throw new Error('catalog_d1_diagnostic_read_only');
    }
  },true);
}

/** Explicit one-time operator only. Bind this profile to a NEW workspace's
 * config/manifest, and pass the SAME retained ledger on every resume. Ordinary
 * factory/defaults and weekly configuration cannot opt into this allowance. */
export function createCatalogD1MigrationRest(options:Omit<RestOptions,'limits'|'accounting'>&{
  budget:{profile:OneTimeMigrationBudget;sha256:string};ledger:D1AccountingState;accounting:D1Accounting;now?:()=>Date;
}):Promise<RestClient>{
  try{
    if(Object.hasOwn(options,'limits')||!options.accounting||!object(options.budget)
      ||Object.keys(options.budget).sort().join(',')!=='profile,sha256'||!validMigrationLedger(options.ledger)
      ||canonicalJson(options.ledger)!==canonicalJson(options.accounting.initial))throw new Error();
    const budget=structuredClone(options.budget),ledger=structuredClone(options.ledger),accounting=options.accounting;
    const anchor=budget.profile.input.ledgerAtObservation,reserve=accounting.reserve,settle=accounting.settle,now=options.now??(()=>new Date());
    if(Object.keys(anchor).some(k=>options.ledger[k as keyof D1AccountingState]<anchor[k as keyof D1AccountingState]))throw new Error();
    const assert=()=>{
      assertOneTimeMigrationBudget(budget.profile,budget.sha256,now());
      const scope=budget.profile.input.scope;
      if(canonicalJson(accounting.scope)!==canonicalJson(scope)||canonicalJson(accounting.initial)!==canonicalJson(ledger)
        ||scope.accountId!==options.accountId||scope.databaseId!==options.databaseId||scope.databaseName!==options.databaseName
        ||typeof reserve!=='function'||typeof settle!=='function'||accounting.reserve!==reserve||accounting.settle!==settle)throw new Error('migration_budget_refused');
    };
    assert();return createRest({...options,accounting,limits:budget.profile.limits},assert);
  }catch{return Promise.reject(new Error('migration_budget_refused'));}
}

export interface PublicationRecoveryReservationBound {
  id:string;requestSha256:string;sqlStatements:number;statementSha256s:string[];rowsReadBound:number;rowsWrittenBound:number;
}
export interface PublicationRecoverySettlement {
  id:string;requestSha256:string;sqlStatements:number;rowsRead:number;rowsWritten:number;
  bound?:PublicationRecoveryReservationBound;
}

/** Separate, exclusive-workspace recovery client. Old charges/unknowns stay in
 * the same ledger. Reserve the reviewed maximum NEXT BATCH before dispatch;
 * concurrent batches and any new unknown/bound violation stop this client.
 * The caller must independently prove the exact SQL/inventory batch bound. */
export function createCatalogD1PublicationRecoveryRest(options:Omit<RestOptions,'limits'|'accounting'>&{
  budget:{profile:PublicationRecoveryBudget;sha256:string};ledger:D1AccountingState;accounting:D1Accounting;now?:()=>Date;
  /** Complete durable SAME-ledger reservations/known settlements after the
   * original approval anchor. Reconcile every unit; a prior bound violation
   * cannot be cleared by constructing another client. No SQL/body values. */
  settlements:PublicationRecoverySettlement[];
  /** Persist this exact body-free bound durably before acknowledging. On resume,
   * independently bind each saved bound to its actual reservation/settlement. */
  onReserveBound:(record:PublicationRecoveryReservationBound)=>Promise<void>;
}):Promise<RestClient>{
  try{
    if(Object.hasOwn(options,'limits')||!options.accounting||!object(options.budget)
      ||Object.keys(options.budget).sort().join(',')!=='profile,sha256'||!validMigrationLedger(options.ledger)
      ||canonicalJson(options.ledger)!==canonicalJson(options.accounting.initial))throw new Error();
    const budget=structuredClone(options.budget),initial=structuredClone(options.ledger),accounting=options.accounting;
    const {ledgerAtApproval:anchor,batchBound:bound}=budget.profile.input,scope=budget.profile.input.prior.profile.input.scope;
    const reserve=accounting.reserve,settle=accounting.settle,onReserveBound=options.onReserveBound,now=options.now??(()=>new Date());
    if(typeof onReserveBound!=='function')throw new Error();
    const reviewedStatements=new Map(bound.statements.map(s=>[s.sha256,s]));
    const cost=(hashes:string[])=>{
      let rowsReadBound=0,rowsWrittenBound=0;
      for(const hash of hashes){const value=reviewedStatements.get(hash);
        if(!value)throw new Error('publication_recovery_sql_unreviewed');
        rowsReadBound+=value.rowsRead;rowsWrittenBound+=value.rowsWritten;}
      if(rowsReadBound>bound.rowsRead||rowsWrittenBound>bound.rowsWritten)throw new Error('publication_recovery_batch_unreviewed');
      return{rowsReadBound,rowsWrittenBound};
    };
    const validBound=(value:PublicationRecoveryReservationBound,s:Pick<PublicationRecoverySettlement,'id'|'requestSha256'|'sqlStatements'>)=>{
      if(!object(value)||Object.keys(value).sort().join(',')!=='id,requestSha256,rowsReadBound,rowsWrittenBound,sqlStatements,statementSha256s'
        ||value.id!==s.id||value.requestSha256!==s.requestSha256||value.sqlStatements!==s.sqlStatements
        ||!Array.isArray(value.statementSha256s)||value.statementSha256s.length!==s.sqlStatements
        ||value.statementSha256s.some(hash=>typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)))return false;
      const expected=cost(value.statementSha256s);
      return value.rowsReadBound===expected.rowsReadBound&&value.rowsWrittenBound===expected.rowsWrittenBound;
    };
    if(Object.keys(anchor).some(k=>initial[k as keyof D1AccountingState]<anchor[k as keyof D1AccountingState])
      ||initial.unconfirmedRequests!==anchor.unconfirmedRequests)throw new Error();
    const history=structuredClone(options.settlements);
    if(!Array.isArray(history)||history.length!==initial.httpRequests-anchor.httpRequests
      ||new Set(history.map(s=>s.id)).size!==history.length
      ||history.some(s=>!object(s)||Object.keys(s).sort().join(',')!==(s.bound===undefined
        ?'id,requestSha256,rowsRead,rowsWritten,sqlStatements':'bound,id,requestSha256,rowsRead,rowsWritten,sqlStatements')
        ||typeof s.id!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(s.id)
        ||typeof s.requestSha256!=='string'||!/^[a-f0-9]{64}$/.test(s.requestSha256)
        ||![s.sqlStatements,s.rowsRead,s.rowsWritten].every(integer)||s.sqlStatements>50
        ||(s.bound===undefined?s.sqlStatements!==0:!validBound(s.bound,s))
        ||s.rowsRead>(s.bound?.rowsReadBound??0)||s.rowsWritten>(s.bound?.rowsWrittenBound??0))
      ||history.reduce((n,s)=>n+s.sqlStatements,anchor.sqlStatements)!==initial.sqlStatements
      ||history.reduce((n,s)=>n+s.rowsRead,anchor.knownRowsRead)!==initial.knownRowsRead
      ||history.reduce((n,s)=>n+s.rowsWritten,anchor.knownRowsWritten)!==initial.knownRowsWritten)throw new Error();
    let read=initial.knownRowsRead,written=initial.knownRowsWritten,stopped=false;
    let pending:PublicationRecoveryReservationBound|undefined;
    let next:Pick<PublicationRecoveryReservationBound,'statementSha256s'|'rowsReadBound'|'rowsWrittenBound'>|undefined;
    const assert=()=>{
      assertPublicationRecoveryBudget(budget.profile,budget.sha256,now());
      if(stopped||canonicalJson(accounting.scope)!==canonicalJson(scope)||canonicalJson(accounting.initial)!==canonicalJson(initial)
        ||scope.accountId!==options.accountId||scope.databaseId!==options.databaseId||scope.databaseName!==options.databaseName
        ||typeof reserve!=='function'||typeof settle!=='function'||accounting.reserve!==reserve||accounting.settle!==settle
        ||options.onReserveBound!==onReserveBound)
        throw new Error('publication_recovery_budget_refused');
    };
    const guarded:D1Accounting={scope:accounting.scope,initial,
      async reserve(input){
        assert();const selected=input.units.sqlStatements?next:{statementSha256s:[],rowsReadBound:0,rowsWrittenBound:0};
        if(pending||!selected||selected.statementSha256s.length!==input.units.sqlStatements
          ||read+selected.rowsReadBound>budget.profile.limits.reportedRowsRead
          ||written+selected.rowsWrittenBound>budget.profile.limits.reportedRowsWritten)throw new Error('publication_recovery_budget_refused');
        pending={id:input.id,requestSha256:input.requestSha256,sqlStatements:input.units.sqlStatements,...selected};next=undefined;
        try{await onReserveBound(structuredClone(pending));assert();await reserve.call(accounting,input);}
        catch{stopped=true;throw new Error('publication_recovery_budget_refused');}
      },
      async settle(id,result){
        if(pending?.id!==id){stopped=true;throw new Error('publication_recovery_budget_refused');}
        const expected=pending;
        try{await settle.call(accounting,id,result);}catch{stopped=true;throw new Error('publication_recovery_budget_refused');}
        pending=undefined;
        if(result.status==='unknown'){stopped=true;return;}
        read+=result.usage.rowsRead;written+=result.usage.rowsWritten;
        if(result.usage.rowsRead>expected.rowsReadBound||result.usage.rowsWritten>expected.rowsWrittenBound){
          stopped=true;throw new Error('publication_recovery_batch_bound_exceeded');
        }
      }};
    const beforeBatch=(batch:Query[])=>{
      assert();if(pending)throw new Error('publication_recovery_budget_refused');next=undefined;
      const statementSha256s=batch.map(q=>createHash('sha256').update(q.sql).digest('hex'));
      next={statementSha256s,...cost(statementSha256s)};
    };
    assert();return createRest({...options,accounting:guarded,limits:budget.profile.limits},assert,beforeBatch);
  }catch{return Promise.reject(new Error('publication_recovery_budget_refused'));}
}
async function createRest(options:RestOptions,migrationAssert?:()=>void,beforeBatch?:(batch:Query[])=>void,readOnly=false):Promise<RestClient>{
  const { accountId,databaseId,databaseName,token }=options;
  const limits={...CATALOG_D1_REST_LIMITS,...options.limits};
  if(typeof accountId!=='string'||!/^[a-f0-9]{32}$/.test(accountId)||typeof databaseId!=='string'
    ||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(databaseId)
    ||typeof databaseName!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(databaseName)
    ||typeof token!=='string'||!token||token.length>4096||/[^\x21-\x7e]/.test(token)
    ||Object.keys(limits).some(key=>!Object.hasOwn(CATALOG_D1_REST_LIMITS,key))
    ||Object.entries(limits).some(([key,value])=>!integer(value)||value<1||value>(migrationAssert&&key==='reportedRowsRead'?5_000_000
      :migrationAssert&&key==='reportedRowsWritten'?100_000:HARD_LIMITS[key as keyof Limits]))
    ||limits.timeoutMs<10||options.requestLimit!==undefined&&!['enforce','observe'].includes(options.requestLimit)
    ||options.requestLimit==='observe'&&(!options.accounting&&!readOnly||migrationAssert))throw new Error('catalog_d1_configuration_invalid');
  // Existing routine configs keep their original estimates and hashes. Observe
  // means all aggregate usage is advisory; wire/SQL/identity bounds stay strict.
  const enforceRequests=options.requestLimit!=='observe';
  const send=options.fetch??fetch;
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
  let requests=0,statements=0,rowsRead=0,rowsWritten=0,unconfirmedRequests=0;
  const accounting=options.accounting;
  if(accounting){
    const initial=accounting.initial;
    if(!object(accounting.scope)||accounting.scope.accountId!==accountId||accounting.scope.databaseId!==databaseId
      ||accounting.scope.databaseName!==databaseName||typeof accounting.reserve!=='function'||typeof accounting.settle!=='function'
      ||!object(initial)||Object.keys(initial).sort().join(',')!=='httpRequests,knownRowsRead,knownRowsWritten,sqlStatements,unconfirmedRequests'
      ||Object.values(initial).some(value=>!integer(value))||initial.unconfirmedRequests>initial.httpRequests
      ||enforceRequests&&(initial.httpRequests>limits.requests||initial.sqlStatements>limits.statements))throw new Error('catalog_d1_accounting_invalid');
    ({httpRequests:requests,sqlStatements:statements,knownRowsRead:rowsRead,knownRowsWritten:rowsWritten,unconfirmedRequests}=initial);
  }
  async function reserve(body:string|undefined,count:number){
    migrationAssert?.();
    if(!accounting)return undefined;
    const id=randomUUID();const requestSha256=createHash('sha256').update(JSON.stringify({accountId,databaseId,body:body??null})).digest('hex');
    try{await accounting.reserve({id,requestSha256,units:{httpRequests:1,sqlStatements:count}});return id;}
    catch(error){if(error instanceof Error&&(/^run_workspace_[a-z_]+$/.test(error.message)||error.message==='publication_recovery_budget_refused'))throw error;
      throw new Error('catalog_d1_accounting_reservation_failed');}
  }
  async function settle(id:string|undefined,usage:{rowsRead:number;rowsWritten:number}|null){
    if(!accounting||!id)return;
    try{await accounting.settle(id,usage?{status:'known',usage}:{status:'unknown',usage:null});}
    catch{throw new Error('catalog_d1_accounting_unknown');}
  }
  const bindings=new WeakMap<D1Statement,Query>();
  async function request(body?:string,signal?:AbortSignal,detail?:FailureDetail):Promise<unknown> {
    migrationAssert?.();
    if(enforceRequests&&requests>=limits.requests)throw new Error('catalog_d1_budget_exhausted');requests++;
    if(signal?.aborted)throw new Error('catalog_d1_result_unknown');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,pending:Promise<unknown>|undefined,cancellation:Promise<unknown>|undefined;
    let rejectAbort:(error:Error)=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const abort=()=>{controller.abort();cancellation??=reader?.cancel().catch(()=>{});rejectAbort(new Error('catalog_d1_result_unknown'));};
    signal?.addEventListener('abort',abort,{once:true});
    let httpStatus:number|undefined;
    try{
      pending=(async()=>{
        const response=await send(body===undefined?base:`${base}/query`,{method:body===undefined?'GET':'POST',redirect:'error',
          signal:controller.signal,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
          ...(body===undefined?{}:{body})});
        httpStatus=response.status;
        if(controller.signal.aborted||!response.body){void response.body?.cancel().catch(()=>{});throw new Error();}
        reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
        try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
          if(size>limits.responseBytes){await reader.cancel();
            if(detail)throw new CatalogD1RequestError('catalog_d1_result_unknown',{...detail,stage:'response',dispatched:true,
              reason:'response_bytes',httpStatus,responseBytes:size,responseLimit:limits.responseBytes});
            throw new Error();}chunks.push(part.value);}}
        finally{reader.releaseLock();}
        const envelope:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!response.ok||!object(envelope)||envelope.success!==true||!Object.hasOwn(envelope,'result')){
          const codes=object(envelope)&&Array.isArray(envelope.errors)?envelope.errors.slice(0,8).flatMap(e=>
            object(e)&&Number.isSafeInteger(e.code)&&Number(e.code)>=0?[Number(e.code)]:[]):[];
          if(detail)throw new CatalogD1RequestError('catalog_d1_result_unknown',{...detail,stage:'response',dispatched:true,
            reason:response.ok?'provider_error':'http_error',httpStatus,providerCodes:codes});
          throw new Error();
        }
        return envelope.result;
      })();return await Promise.race([pending,aborted,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{abort();reject(new Error());},limits.timeoutMs);})]);
    }catch(error){
      if(error instanceof CatalogD1RequestError)throw error;
      if(detail)throw new CatalogD1RequestError('catalog_d1_result_unknown',{...detail,stage:'request',dispatched:true,
        reason:signal?.aborted?'cancelled':controller.signal.aborted?'timeout':httpStatus?'invalid_response':'transport_error',...(httpStatus?{httpStatus}:{})});
      throw new Error(body===undefined?'catalog_d1_identity_unavailable':'catalog_d1_result_unknown');
    }
    finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(signal&&controller.signal.aborted&&pending)await drainDeploymentObservation(Promise.allSettled([pending,cancellation]));}
  }
  async function query(batch:Query[],signal?:AbortSignal):Promise<Result[]> {
    const body=JSON.stringify({batch}),detail:FailureDetail={stage:'preflight',reason:'batch_statements',dispatched:false,
      statementCount:batch.length,requestBytes:Buffer.byteLength(body),requestSha256:createHash('sha256').update(body).digest('hex')};
    // Routine atomic transactions are bounded by their encoded payload, not the
    // old 50-query allowance. Splitting a transaction would lose rollback/CAS.
    if(!batch.length||enforceRequests&&batch.length>limits.batchStatements)throw new CatalogD1RequestError('catalog_d1_batch_invalid',detail);
    // No cancellable mutation transaction: observation SQL is SELECT-only.
    if(signal&&batch.some(value=>!/^\s*SELECT\b/i.test(value.sql)))throw new Error('catalog_d1_read_signal_invalid');
    signal?.throwIfAborted();
    if(detail.requestBytes>limits.requestBytes)throw new CatalogD1RequestError('catalog_d1_request_bound',{...detail,reason:'request_bytes'});
    if(enforceRequests&&(statements+batch.length>limits.statements||requests>=limits.requests
      ||rowsRead>=limits.reportedRowsRead||rowsWritten>=limits.reportedRowsWritten))throw new Error('catalog_d1_budget_exhausted');
    beforeBatch?.(batch);
    let reservation:string|undefined;
    try{reservation=await reserve(body,batch.length);}
    catch(error){if(error instanceof Error)Object.assign(error,{catalogDiagnostic:{...detail,reason:'accounting_reservation'}});throw error;}
    if(enforceRequests&&(statements+batch.length>limits.statements||requests>=limits.requests
      ||rowsRead>=limits.reportedRowsRead||rowsWritten>=limits.reportedRowsWritten))throw new Error('catalog_d1_budget_exhausted');
    statements+=batch.length;
    let results:Result[];
    try{
      const raw=await request(body,signal,detail);
      if(!Array.isArray(raw)||raw.length!==batch.length)throw new Error();
      results=raw.map(value=>{
        if(!object(value)||value.success!==true||!Array.isArray(value.results)||value.results.some(row=>!object(row))
          ||!object(value.meta)||value.meta.served_by_primary!==true||!integer(value.meta.rows_read)||!integer(value.meta.rows_written))throw new Error();
        const meta:Record<string,number|boolean>={served_by_primary:true,rows_read:value.meta.rows_read,rows_written:value.meta.rows_written};
        for(const key of ['changes','last_row_id','duration'])if(value.meta[key]!==undefined){
          const n=value.meta[key];if(typeof n!=='number'||!Number.isFinite(n)||key!=='duration'&&!Number.isSafeInteger(n)
            ||key!=='last_row_id'&&n<0)throw new Error();meta[key]=n;
        }
        return {success:true as const,results:value.results,meta};
      });
    }catch(error){unconfirmedRequests++;await settle(reservation,null);
      if(error instanceof CatalogD1RequestError)throw error;
      throw new CatalogD1RequestError('catalog_d1_result_unknown',{...detail,stage:'response',dispatched:true,reason:'invalid_response'});}
    const read=results.reduce((sum,result)=>sum+Number(result.meta.rows_read),rowsRead);
    const written=results.reduce((sum,result)=>sum+Number(result.meta.rows_written),rowsWritten);
    if(!Number.isSafeInteger(read)||!Number.isSafeInteger(written)){
      unconfirmedRequests++;await settle(reservation,null);throw new Error('catalog_d1_result_unknown');
    }
    try{await settle(reservation,{rowsRead:read-rowsRead,rowsWritten:written-rowsWritten});}
    catch(error){unconfirmedRequests++;throw error;}
    rowsRead=read;rowsWritten=written;
    // Reported costs are checked AFTER execution, never a guarantee that an
    // arbitrary SQL query cannot exceed its allowance. Lost metadata stays
    // unknown; bounded requests still permit the caller's journal readback.
    if(enforceRequests&&(rowsRead>limits.reportedRowsRead
      ||rowsWritten>limits.reportedRowsWritten))throw new Error('catalog_d1_reported_usage_exceeded');
    return results;
  }
  if(accounting&&enforceRequests&&(requests>=limits.requests||statements>=limits.statements||rowsRead>=limits.reportedRowsRead
    ||rowsWritten>=limits.reportedRowsWritten))throw new Error('catalog_d1_budget_exhausted');
  const reservation=await reserve(undefined,0);
  let identity:unknown;
  try{identity=await request();}
  catch(error){await settle(reservation,null);throw error;}
  await settle(reservation,{rowsRead:0,rowsWritten:0});
  if(!object(identity)||identity.uuid!==databaseId||identity.name!==databaseName||!object(identity.read_replication)
    ||identity.read_replication.mode!=='disabled')throw new Error('catalog_d1_identity_mismatch');
  // Disabled replication alone is insufficient during its documented drain
  // window. Require this read AND every subsequent response to prove primary.
  const probe=(await query([{sql:'SELECT 1 AS catalog_d1_primary',params:[]}]))[0];
  if(probe.results.length!==1||probe.results[0].catalog_d1_primary!==1||probe.meta.rows_written!==0)
    throw new Error('catalog_d1_primary_unproven');
  function statement(sql:string,params:readonly Param[]=[]):D1Statement {
    const value:D1Statement=Object.freeze({
      bind(...values:unknown[]){
        if(values.length>limits.parameters||values.some(v=>v!==null&&typeof v!=='string'
          &&(typeof v!=='number'||!Number.isFinite(v)||Number.isInteger(v)&&!Number.isSafeInteger(v))))
          throw new Error('catalog_d1_parameters_invalid');
        return statement(sql,Object.freeze(values.slice() as Param[]));
      },
      async all<T>(options?:D1ReadOptions){return (await query([bindings.get(value)!],options?.signal))[0] as Result<T>;},
      async run(){return (await query([bindings.get(value)!]))[0];},
    });bindings.set(value,{sql,params});return value;
  }
  const client=Object.freeze({providerIdentity:`cloudflare:${accountId}:${databaseId}`,
    metrics:()=>({requests,statements,reportedRowsRead:unconfirmedRequests?null:rowsRead,
      reportedRowsWritten:unconfirmedRequests?null:rowsWritten,unconfirmedRequests}),
    prepare:(sql:string)=>statement(sqlText(sql)),
    batch(values:D1Statement[],options?:D1ReadOptions){
      if(!Array.isArray(values)||Array.from(values).some(value=>!bindings.has(value)))return Promise.reject(new Error('catalog_d1_batch_invalid'));
      return query(Array.from(values,value=>bindings.get(value)!),options?.signal);
    },
  });ownedClients.add(client);return client;
}
