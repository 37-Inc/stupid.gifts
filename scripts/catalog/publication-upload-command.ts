import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdtemp, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RunWorkspace } from './run-workspace.ts';
import type { PublicationCommand } from './publish-release.ts';
import { publicationUploadIsolation } from './publication-upload-isolation.ts';
import type { UploadIsolation } from './publication-upload-isolation.ts';

const API='https://api.cloudflare.com/client/v4';
// Upload chunks have an independent per-request/concurrent-aggregate wire bound,
// including base64/multipart overhead; this is not the sealed package total bound.
const REQUEST_BYTES=2*128*1024*1024+1024*1024,RESPONSE_BYTES=512*1024,REQUEST_MS=180_000;
// A 20k-entry metadata session can exceed512KiB (measured551929B). Asset
// contents/version responses retain the old bound; this is not a package cap.
const responseLimit=(url:string)=>/^\/client\/v4\/accounts\/[a-f0-9]{32}\/workers\/scripts\/[a-zA-Z0-9_-]{1,100}\/assets-upload-session$/.test(new URL(url).pathname)?2*1024*1024:RESPONSE_BYTES;
const HOP=new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade','host','content-length']);
type Scope={accountId:string;workerName:string};
type Workspace=Pick<RunWorkspace,'assertHeld'|'reserveBudget'|'settleBudget'>;
type UploadCommand=(command:PublicationCommand)=>Promise<void>;
const protectedCommands=new WeakSet<UploadCommand>();
/** Lifetime-only capability: every genuine factory is protected, regardless of
 * which workspace created it. Properties on arbitrary runners cannot opt in. */
export function isAccountedPublicationUploadCommand(value:unknown):value is UploadCommand {
  return typeof value==='function'&&protectedCommands.has(value as UploadCommand);
}
export class PublicationUploadCommandError extends Error {
  constructor(readonly code:'publication_upload_scope_invalid'|'publication_upload_budget_failed'|'publication_upload_unknown'|'publication_upload_command_failed'|'publication_upload_sandbox_unavailable',
    readonly detail?:{versionDispatched:boolean;reason:string}){
    super(code);this.name='PublicationUploadCommandError';
  }
}
function allowed(url:URL,method:string,scope:Scope):boolean {
  const account=`/accounts/${scope.accountId}`,script=`${account}/workers/scripts/${scope.workerName}`;
  if(url.username||url.password||url.hash)return false;
  if(method==='GET')return !url.search&&[`${account}/workers/services/${scope.workerName}`,`${script}/secrets`,`${account}/workers/workers/${scope.workerName}`].includes(url.pathname);
  if(method!=='POST')return false;
  return !url.search&&url.pathname===`${script}/assets-upload-session`
    ||url.pathname===`${script}/versions`&&url.search==='?bindings_inherit=strict'
    ||url.pathname===`${account}/workers/assets/upload`&&url.search==='?base64=true'
    ||!url.search&&url.pathname.startsWith(`${account}/workers/assets/upload/`)
      &&/^[a-f0-9]{32}$/.test(url.pathname.slice(`${account}/workers/assets/upload/`.length));
}
function cleanHeaders(input:IncomingMessage['headers']):Record<string,string>{
  const blocked=new Set([...HOP,...String(input.connection??'').split(',').map(value=>value.trim().toLowerCase())]);
  const value:Record<string,string>={};
  for(const [key,item]of Object.entries(input))if(!blocked.has(key)&&typeof item==='string')value[key]=item;
  return value;
}
/** One native HTTPS request, no redirects or transport-level automatic retries. */
function remote(url:string,init:RequestInit):Promise<Response>{
  return new Promise((resolve,reject)=>{
    const limit=responseLimit(url);
    let body:Buffer|undefined,error:Error|undefined,status=0,responseHeaders:Record<string,string>={};
    const req=httpsRequest(url,{method:init.method,headers:init.headers as Record<string,string>,signal:init.signal??undefined},res=>{
      status=res.statusCode??0;const chunks:Buffer[]=[];let size=0;
      responseHeaders=cleanHeaders(res.headers);
      res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>limit){req.destroy(new Error());return;}chunks.push(chunk);});
      res.on('end',()=>{body=Buffer.concat(chunks);});res.on('error',()=>{error=new Error();req.destroy();});
    });
    req.on('error',()=>{error=new Error();});
    req.on('close',()=>{if(error||!body||status<200||status>599)reject(new Error());
      else {try{resolve(new Response([204,205,304].includes(status)?null:new Uint8Array(body),{status,headers:responseHeaders}));}catch{reject(new Error());}}});
    req.end(init.body as Buffer);
  });
}
async function captured(command:PublicationCommand,signal?:AbortSignal):Promise<void>{
  try{await promisify(execFile)('/bin/sh',['-c','umask 077; exec "$@"','publication',command.file,...command.args],
    {cwd:command.cwd,env:command.env,timeout:command.timeoutMs,maxBuffer:1024*1024,signal});}
  catch{throw new PublicationUploadCommandError('publication_upload_command_failed');}
}

/** The parent owns the sole ledger/remote transport; Wrangler and descendants
 * reach the external network only through this ephemeral bridge.
 * No auth discovery, TLS interception, dependency patching or upload retry here.
 */
export function accountedPublicationUploadCommand(options:{workspace:Workspace;scope:Scope;send?:typeof fetch;
  command?:(command:PublicationCommand,signal?:AbortSignal)=>Promise<void>;
  /** Test dependency only, never hydrated from a run's JSON/configuration. */
  isolation?:UploadIsolation}):UploadCommand{
  const {workspace:ws,scope}=options,send=options.send??remote,run=options.command??captured;
  if(!/^[a-f0-9]{32}$/.test(scope.accountId)||!/^[a-zA-Z0-9_-]{1,100}$/.test(scope.workerName))
    throw new PublicationUploadCommandError('publication_upload_scope_invalid');
  const execute:UploadCommand=async command=>{
    const upload=command.args[0]?.replaceAll('\\','/').endsWith('node_modules/wrangler/bin/wrangler.js')
      &&command.args[1]==='versions'&&command.args[2]==='upload';
    if(!upload){await run(command);return;}
    const provision=command.args.filter(arg=>/^--?(?:no-)?(?:experimental-?provision|x-provision)(?:=|$)/i.test(arg));
    if(provision.length>1||provision.some(arg=>arg!=='--experimental-provision=false'))throw new PublicationUploadCommandError('publication_upload_scope_invalid');
    const uploadArgs=provision.length?command.args:[...command.args,'--experimental-provision=false'];
    let isolation:UploadIsolation;
    try{isolation=options.isolation??publicationUploadIsolation();await isolation.available();}
    catch{throw new PublicationUploadCommandError('publication_upload_sandbox_unavailable');}
    await ws.assertHeld();
    const nonce=randomBytes(24).toString('hex'),prefix=`/${nonce}/client/v4`,child=new AbortController();
    const pending=new Set<Promise<void>>(),controllers=new Set<AbortController>();
    let failure:PublicationUploadCommandError|undefined,buffered=0,stopping=false,versionDispatched=false;
    const fail=(code:PublicationUploadCommandError['code'],reason='transport')=>{
      if(!failure||failure.code==='publication_upload_command_failed')failure=new PublicationUploadCommandError(code,{versionDispatched,reason});child.abort();};
    async function handle(req:IncomingMessage,res:ServerResponse){
      let retained=0,assetContent=false,reason='transport';const controller=new AbortController();controllers.add(controller);
      const abort=()=>{controller.abort();if(!req.complete)req.destroy();};req.once('aborted',abort);res.once('close',()=>{if(!res.writableEnded)abort();});
      const timer=setTimeout(()=>{reason='timeout';abort();},REQUEST_MS);let reservation:string|undefined,settled=false;
      try{
        if(stopping||req.rawHeaders.length>128||!req.url?.startsWith(`${prefix}/`)||req.url.includes('\\')||/%(?:2f|5c|2e)/i.test(req.url))throw new Error('scope');
        const relative=req.url.slice(prefix.length),url=new URL(relative,'https://bridge.invalid');
        if(url.origin!=='https://bridge.invalid'||relative!==`${url.pathname}${url.search}`||!allowed(url,req.method??'',scope))throw new Error('scope');
        assetContent=req.method==='POST'&&url.pathname.startsWith(`/accounts/${scope.accountId}/workers/assets/upload`);
        const chunks:Buffer[]=[];for await(const value of req){const bytes=Buffer.from(value);retained+=bytes.length;buffered+=bytes.length;
          if(retained>REQUEST_BYTES||buffered>REQUEST_BYTES||controller.signal.aborted)throw new Error('scope');chunks.push(bytes);}
        const body=Buffer.concat(chunks);if(req.method==='GET'&&body.length)throw new Error('scope');
        controller.signal.throwIfAborted();await ws.assertHeld();controller.signal.throwIfAborted();
        const outgoing={...cleanHeaders(req.headers),'accept-encoding':'identity'},target=`${API}${url.pathname}${url.search}`;
        reservation=randomUUID();
        try{await ws.reserveBudget({id:reservation,requestSha256:createHash('sha256').update(req.method??'').update(target).update(body).digest('hex'),units:{httpRequests:1,sqlStatements:0}});}
        catch{reservation=undefined;fail('publication_upload_budget_failed');throw new Error();}
        controller.signal.throwIfAborted();
        let rejectAbort:(error:Error)=>void=()=>{};
        const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
        const onAbort=()=>rejectAbort(new Error());controller.signal.addEventListener('abort',onAbort,{once:true});
        let sent:Promise<Response>|undefined;
        try{
          if(req.method==='POST'&&url.pathname.endsWith('/versions'))versionDispatched=true;
          sent=send(target,{method:req.method,headers:outgoing,body:req.method==='POST'?new Uint8Array(body):undefined,redirect:'error',signal:controller.signal}).then(response=>{
            if(controller.signal.aborted){void response.body?.cancel().catch(()=>{});throw new Error();}return response;});
          const response=await Promise.race([sent,aborted]);
          if(response.status>=300&&response.status<400||response.headers.get('content-encoding')&&!['identity'].includes(response.headers.get('content-encoding')!)){reason='response_invalid';throw new Error();}
          const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0;
          try{if(reader)for(;;){const part=await Promise.race([reader.read(),aborted]);if(part.done)break;size+=part.value.byteLength;
            if(size>responseLimit(target)){reason='response_bound';void reader.cancel().catch(()=>{});throw new Error();}chunks.push(part.value);}}
          finally{if(controller.signal.aborted)void reader?.cancel().catch(()=>{});try{reader?.releaseLock();}catch{}}
          const payload=Buffer.concat(chunks);settled=true;await ws.settleBudget(reservation,{status:'known',usage:{rowsRead:0,rowsWritten:0}});
          controller.signal.throwIfAborted();const output=cleanHeaders(Object.fromEntries(response.headers));
          // Wrangler hashes assets synchronously between requests. Do not pool
          // a localhost socket whose idle close cannot reach that blocked child.
          res.writeHead(response.status,{...output,'content-length':String(payload.length),connection:'close'});res.end(payload);
        }finally{controller.signal.removeEventListener('abort',onAbort);
          // The native sender resolves only after its request closes. Arbitrary
          // test transports do not acquire this concrete lifetime guarantee.
          if(!options.send&&sent)await sent.catch(()=>{});}
      }catch(error){
        controller.abort();
        if(reservation&&!settled){settled=true;try{await ws.settleBudget(reservation,{status:'unknown',usage:null});}catch{}}
        // Content-addressed asset transfers may safely retry. Keep Wrangler
        // alive so its existing backoff/retry logic handles transient failures.
        // Version writes, scope violations and malformed replies remain fenced.
        const retryable=assetContent&&!versionDispatched&&['transport','timeout'].includes(reason)
          &&!(error instanceof Error&&error.message==='scope')&&!stopping;
        if(!retryable)fail(error instanceof Error&&error.message==='scope'?'publication_upload_scope_invalid':'publication_upload_unknown',reason);
        if(!res.destroyed){res.writeHead(retryable?503:400,{'Content-Type':'application/json',...(retryable?{'Retry-After':'1'}:{})});
          res.end('{"success":false,"errors":[{"code":10000,"message":"Upload transfer interrupted"}]}');}
      }finally{clearTimeout(timer);req.removeListener('aborted',abort);controllers.delete(controller);buffered-=retained;}
    }
    const server=createServer({maxHeaderSize:16*1024},(req,res)=>{const task=handle(req,res);pending.add(task);
      void task.then(()=>pending.delete(task),()=>{pending.delete(task);fail('publication_upload_unknown');});});
    server.headersTimeout=REQUEST_MS;server.requestTimeout=REQUEST_MS;server.maxHeadersCount=64;
    server.on('error',()=>fail('publication_upload_unknown'));
    server.on('connect',(_req,socket)=>{fail('publication_upload_scope_invalid');socket.destroy();});
    server.on('clientError',(_error,socket)=>{fail('publication_upload_scope_invalid');socket.destroy();});
    let socketDirectory:string|undefined;
    try{
      if(isolation.transport==='unix')socketDirectory=await mkdtemp(path.join(tmpdir(),'sg-upload-'));
      const socketPath=socketDirectory?path.join(socketDirectory,'bridge.sock'):undefined;
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);const listening=()=>{server.removeListener('error',reject);resolve();};
        if(socketPath)server.listen(socketPath,listening);else server.listen(0,'127.0.0.1',listening);});
      const address=server.address();if(!address)throw new Error();
      if(socketPath)await chmod(socketPath,0o600);
      const wrapped=await isolation.wrap({...command,args:uploadArgs,env:{...command.env,
        WRANGLER_HIDE_BANNER:'true',WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_SANITIZE:'true'}},
        {prefix,...(socketPath?{socketPath}:{port:typeof address==='string'?undefined:address.port})});
      await run(wrapped,child.signal);
    }catch{failure??=new PublicationUploadCommandError('publication_upload_command_failed',{versionDispatched,reason:'command_failed'});}
    finally{
      stopping=true;const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
      for(const controller of controllers)controller.abort();server.closeIdleConnections();
      while(pending.size)await Promise.allSettled([...pending]);server.closeAllConnections();await closed;
      if(socketDirectory)await rmdir(socketDirectory);
    }
    if(failure)throw failure;
  };
  protectedCommands.add(execute);return execute;
}
