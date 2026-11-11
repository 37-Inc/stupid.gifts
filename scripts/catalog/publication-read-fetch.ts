import { createHash, randomUUID } from 'node:crypto';
import type { RunWorkspace } from './run-workspace.ts';
import {semanticEntryFromMetadata,DERIVED_SEARCH_PROFILE} from '../../lib/catalog/semantic-profile.ts';

export interface PublicationFetchScope {
  accountId:string;workerName:string;indexName:string;databaseId:string;identityOrigin:string;
  /** Explicit serving projection: content-addressed reads/upserts, never deletes. */
  derivedIndexName?:string;
}
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const owned=new WeakSet<typeof fetch>();
const ownedGeneral=new WeakSet<typeof fetch>();
export function isAccountedPublicationReadFetch(send:typeof fetch|undefined):boolean { return !!send&&owned.has(send); }
export function isAccountedPublicationFetch(send:typeof fetch|undefined):boolean { return !!send&&(owned.has(send)||ownedGeneral.has(send)); }

function ids(body:unknown):boolean {
  const value=body as {ids?:unknown};
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).join(',')==='ids'
    &&Array.isArray(value.ids)&&value.ids.length>0&&value.ids.length<=10
    &&value.ids.every(id=>typeof id==='string'&&UUID.test(id))&&new Set(value.ids).size===value.ids.length;
}
function derivedIds(body:unknown):boolean {
  const value=body as {ids?:unknown};
  return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).join(',')==='ids'
    &&Array.isArray(value.ids)&&value.ids.length>0&&value.ids.length<=20
    &&value.ids.every(id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id))&&new Set(value.ids).size===value.ids.length;
}
function derivedVector(body:unknown):boolean {
  const value=body as {id:string;values:number[];metadata:unknown};
  return !!value&&Object.keys(value).sort().join(',')==='id,metadata,values'
    &&!!semanticEntryFromMetadata(value.id,value.metadata,'metadata-validation')&&Array.isArray(value.values)
    &&value.values.length===DERIVED_SEARCH_PROFILE.dimensions&&value.values.every(n=>typeof n==='number'&&Number.isFinite(n))
    &&Math.abs(Math.hypot(...value.values)-1)<1e-6;
}
function mutationBody(body:unknown,kind:'upsert'|'deploy'):boolean {
  if(!body||typeof body!=='object'||Array.isArray(body))return false;
  const value=body as Record<string,unknown>;
  if(kind==='upsert')return Object.keys(value).sort().join(',')==='id,metadata,values'
    &&typeof value.id==='string'&&UUID.test(value.id)&&Array.isArray(value.values)&&value.values.length===1536
    &&value.values.every(n=>typeof n==='number'&&Number.isFinite(n)&&Number.isFinite(Math.fround(n)))
    &&!!value.metadata&&typeof value.metadata==='object'&&!Array.isArray(value.metadata)&&Buffer.byteLength(JSON.stringify(value.metadata))<=4096;
  const versions=value.versions as {version_id?:unknown;percentage?:unknown}[];
  const annotations=value.annotations as Record<string,unknown>;
  return Object.keys(value).sort().join(',')==='annotations,strategy,versions'&&value.strategy==='percentage'
    &&Array.isArray(versions)&&versions.length===1&&!!versions[0]
    &&Object.keys(versions[0]).sort().join(',')==='percentage,version_id'&&versions[0].percentage===100
    &&typeof versions[0].version_id==='string'&&UUID.test(versions[0].version_id)
    &&!!annotations&&typeof annotations==='object'&&!Array.isArray(annotations)&&Object.keys(annotations).join(',')==='workers/message'
    &&typeof annotations['workers/message']==='string'&&/^[a-zA-Z0-9._:/-]{1,200}$/.test(annotations['workers/message']);
}

/** READ-only companion wiring. The raw sender never receives ledger callbacks:
 * late responses cannot settle twice or write after this promise has finished.
 * Network time is bounded; our own durable reservation/settlement is awaited.
 */
export function accountedPublicationReadFetch(ws:Pick<RunWorkspace,'reserveBudget'|'settleBudget'>,send:typeof fetch,scope:PublicationFetchScope):typeof fetch {
  return accountedFetch(ws,send,scope,true);
}
/** General first-party REST companion, not a D1 query or Wrangler upload client.
 * D1 retains its own accounting; every allowed injected REST attempt shares
 * this workspace. Never wrap an already-accounted sender from another run.
 */
export function accountedPublicationFetch(ws:Pick<RunWorkspace,'reserveBudget'|'settleBudget'>,send:typeof fetch,scope:PublicationFetchScope):typeof fetch {
  return accountedFetch(ws,send,scope,false);
}
function accountedFetch(ws:Pick<RunWorkspace,'reserveBudget'|'settleBudget'>,send:typeof fetch,scope:PublicationFetchScope,readOnly:boolean):typeof fetch {
  if(isAccountedPublicationFetch(send))throw new Error('publication_fetch_already_accounted');
  if(!/^[a-f0-9]{32}$/.test(scope.accountId)||!UUID.test(scope.databaseId)
    ||![scope.workerName,scope.indexName].every(n=>/^[a-zA-Z0-9_-]{1,100}$/.test(n))
    ||scope.derivedIndexName!==undefined&&(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(scope.derivedIndexName)||scope.derivedIndexName===scope.indexName)
    ||new URL(scope.identityOrigin).origin!==scope.identityOrigin||!scope.identityOrigin.startsWith('https://'))throw new Error('publication_read_scope_invalid');
  const account=`/client/v4/accounts/${scope.accountId}`,worker=`${account}/workers/scripts/${scope.workerName}`,
    vector=`${account}/vectorize/v2/indexes/${scope.indexName}`;
  const derived=scope.derivedIndexName?`${account}/vectorize/v2/indexes/${scope.derivedIndexName}`:null;
  const read:typeof fetch=async(input,init)=>{
    if(typeof input!=='string'||init?.redirect!=='error')throw new Error('publication_read_scope_invalid');
    const url=new URL(input),method=init.method??'GET';
    const get=method==='GET'&&init.body===undefined&&(url.origin===scope.identityOrigin&&url.pathname==='/.well-known/catalog-release.json'
      ||url.origin==='https://api.cloudflare.com'&&[`${worker}/deployments`,vector,`${vector}/info`,`${account}/d1/database/${scope.databaseId}`,derived].includes(url.pathname)
      ||url.origin==='https://api.cloudflare.com'&&url.pathname.startsWith(`${worker}/versions/`)&&UUID.test(url.pathname.slice(`${worker}/versions/`.length)));
    const versions=!readOnly&&method==='GET'&&init.body===undefined&&url.origin==='https://api.cloudflare.com'
      &&url.pathname===`${worker}/versions`&&[...url.searchParams.keys()].sort().join(',')==='page,per_page'
      &&/^(?:[1-9]|10)$/.test(url.searchParams.get('page')??'')&&url.searchParams.get('per_page')==='10';
    let native=false,mutation=false;
    if(!readOnly&&method==='POST'&&url.origin==='https://api.cloudflare.com'&&url.pathname===`${vector}/upsert`
      &&typeof init.body==='string'&&Buffer.byteLength(init.body)<=384*1024){
      try{const rows=init.body.trim().split('\n').map(line=>JSON.parse(line));
        mutation=rows.length>0&&rows.length<=8&&rows.every(row=>mutationBody(row,'upsert'))&&new Set(rows.map(row=>row.id)).size===rows.length;
      }catch{}
    }
    if(method==='POST'&&url.origin==='https://api.cloudflare.com'&&typeof init.body==='string'&&Buffer.byteLength(init.body)<=128*1024){
      try{const body=JSON.parse(init.body);
        native=url.pathname===`${vector}/get_by_ids`&&Buffer.byteLength(init.body)<=4096&&ids(body);
        if(derived&&url.pathname===`${derived}/get_by_ids`&&Buffer.byteLength(init.body)<=4096&&derivedIds(body))native=true;
        mutation=mutation||!readOnly&&(url.pathname===`${vector}/delete_by_ids`&&ids(body)
          ||url.pathname===`${vector}/upsert`&&mutationBody(body,'upsert')
          ||!!derived&&url.pathname===`${derived}/upsert`&&derivedVector(body)
          ||url.pathname===`${worker}/deployments`&&mutationBody(body,'deploy'));
      }catch{}
    }
    if(!get&&!native&&!versions&&!mutation||url.username||url.password||url.search&&!versions||url.hash)throw new Error('publication_read_scope_invalid');
    init.signal?.throwIfAborted();const controller=new AbortController();
    let rejectAbort:(error:Error)=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const abort=()=>{controller.abort();rejectAbort(new Error('publication_read_aborted'));};
    init.signal?.addEventListener('abort',abort,{once:true});let timer:ReturnType<typeof setTimeout>|undefined;
    // Observe rejection even while an asynchronous durable reservation is pending.
    void aborted.catch(()=>{});
    try{
      const id=randomUUID();await ws.reserveBudget({id,requestSha256:createHash('sha256').update(JSON.stringify({url:input,method,body:init.body??null})).digest('hex'),
        units:{httpRequests:1,sqlStatements:0}});
      let response:Response;
      try{
        controller.signal.throwIfAborted();
        // Durable journal I/O has its own bounded transport. Start the provider
        // clock only after its reservation is saved, and stop before settlement.
        timer=setTimeout(abort,10_000);
        const pending=send(input,{...init,signal:controller.signal}).then(value=>{
          if(controller.signal.aborted){void value.body?.cancel().catch(()=>{});throw new Error('publication_read_aborted');}return value;});
        response=await Promise.race([pending,aborted]);
      }catch{
        clearTimeout(timer);
        await ws.settleBudget(id,{status:'unknown',usage:null});throw new Error('publication_read_unavailable');
      }finally{clearTimeout(timer);}
      // Settlement failure is not retried or relabelled as a second settlement.
      await ws.settleBudget(id,{status:'known',usage:{rowsRead:0,rowsWritten:0}});return response;
    }finally{clearTimeout(timer);init.signal?.removeEventListener('abort',abort);}
  };
  (readOnly?owned:ownedGeneral).add(read);return read;
}
