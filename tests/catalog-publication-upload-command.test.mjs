import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { accountedPublicationUploadCommand, isAccountedPublicationUploadCommand, PublicationUploadCommandError } from '../scripts/catalog/publication-upload-command.ts';
import { publicationUploadIsolation } from '../scripts/catalog/publication-upload-isolation.ts';

const mac={skip:process.platform!=='darwin'},scope={accountId:'a'.repeat(32),workerName:'owned-upload-fixture'};
const linuxUpload=process.platform==='linux'&&process.env.CATALOG_LINUX_SANDBOX_TESTS==='1';
const actualUpload={skip:process.platform!=='darwin'&&!linuxUpload};
const route=`/accounts/${scope.accountId}/workers/scripts/${scope.workerName}`;
const wrangler=fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js',import.meta.url));
const nativeFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{assert.equal(new URL(input).hostname,'127.0.0.1','Only the local bridge may receive fixture HTTP');return nativeFetch(input,init);};
test.after(()=>{globalThis.fetch=nativeFetch;});
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const response=(result,status=200,headers={})=>Response.json({success:status===200,result,...(status===200?{}:{errors:[{code:10000,message:'Owned transient fixture'}]})},{status,headers});
function ledger(){const events=[];return{events,async assertHeld(){},async reserveBudget(value){events.push({reserve:value});},async settleBudget(id,value){events.push({id,...value});}};}
const command={file:process.execPath,args:[wrangler,'versions','upload'],cwd:os.tmpdir(),env:{},timeoutMs:30_000};
const fixtureIsolation={...publicationUploadIsolation('darwin'),async available(){}};
function factory(ws,send,run){return accountedPublicationUploadCommand({workspace:ws,scope,send,command:run,isolation:fixtureIsolation});}
const endpoint=wrapped=>wrapped.env.CLOUDFLARE_API_BASE_URL;
const settled=ws=>ws.events.filter(event=>event.status);

test('only genuine factories carry the lifetime brand, including factories for another workspace',()=>{
  const first=factory(ledger(),async()=>assert.fail('No send'),async()=>{});
  const foreign=factory(ledger(),async()=>assert.fail('No send'),async()=>{});
  const arbitrary=Object.assign(async()=>{},{protected:true});
  assert.equal(isAccountedPublicationUploadCommand(first),true);
  assert.equal(isAccountedPublicationUploadCommand(foreign),true);
  assert.equal(isAccountedPublicationUploadCommand(arbitrary),false);
  assert.equal(isAccountedPublicationUploadCommand(null),false);
});

test('non-upload build/verify commands pass through without opening a bridge or charging',async()=>{
  const ws=ledger(),value={...command,args:['--import','tsx','scripts/staging/build.mts']};let actual;
  await factory(ws,async()=>assert.fail('No remote send'),async input=>{actual=input;})(value);
  assert.equal(actual,value);assert.deepEqual(ws.events,[]);
});

test('exact routes preserve JWT/multipart/status/retry headers and charge each remote attempt',async()=>{
  const ws=ledger(),calls=[];const bytes=Buffer.alloc(1024*1024,65);
  await factory(ws,async(url,init)=>{calls.push({url,init});return response({},calls.length===1?503:200,{'Retry-After':'0'});},async wrapped=>{
    assert.equal(wrapped.file,'/usr/bin/sandbox-exec');assert.match(wrapped.args[1],/deny network-outbound/);
    assert.equal(wrapped.env.WRANGLER_LOG_SANITIZE,'true');assert.equal(wrapped.env.WRANGLER_HIDE_BANNER,'true');
    assert.equal(wrapped.env.WRANGLER_SEND_METRICS,'false');assert.equal(wrapped.env.WRANGLER_SEND_ERROR_REPORTS,'false');
    assert.equal(wrapped.args.at(-1),'--experimental-provision=false');
    for(const suffix of [`/accounts/${scope.accountId}/workers/assets/upload?base64=true`,`/accounts/${scope.accountId}/workers/assets/upload/${'b'.repeat(32)}`]){
      const result=await fetch(`${endpoint(wrapped)}${suffix}`,{method:'POST',headers:{Authorization:'Bearer OWNED_SESSION_JWT','Content-Type':'multipart/form-data; boundary=owned'},body:bytes});
      assert.equal(result.status,calls.length===1?503:200);assert.equal(result.headers.get('retry-after'),'0');
      assert.equal(result.headers.get('connection'),'close');await result.arrayBuffer();
    }
  })(command);
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.url.startsWith('https://api.cloudflare.com/client/v4/')));
  assert.ok(calls.every(call=>call.init.headers.authorization==='Bearer OWNED_SESSION_JWT'&&call.init.headers['content-type']==='multipart/form-data; boundary=owned'));
  assert.ok(calls.every(call=>Buffer.from(call.init.body).equals(bytes)&&!call.init.headers.host&&call.init.redirect==='error'));
  assert.equal(ws.events.filter(event=>event.reserve).length,2);assert.deepEqual(settled(ws).map(event=>event.status),['known','known']);
});

test('asset transfer timeout returns retryable503 without killing Wrangler or refunding usage',async t=>{
  const ws=ledger(),timer=globalThis.setTimeout;let calls=0;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===180_000?20:ms,...args));
  await factory(ws,async(_url,init)=>{
    if(++calls===1)return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('fixture timeout')),{once:true}));
    return response({jwt:'OWNED_COMPLETION'});
  },async(wrapped,signal)=>{
    const url=endpoint(wrapped)+`/accounts/${scope.accountId}/workers/assets/upload?base64=true`;
    const first=await fetch(url,{method:'POST',body:'same immutable asset'});
    assert.equal(first.status,503);assert.equal(first.headers.get('retry-after'),'1');await first.arrayBuffer();
    assert.equal(signal.aborted,false);
    const second=await fetch(url,{method:'POST',body:'same immutable asset'});assert.equal(second.status,200);await second.arrayBuffer();
  })(command);
  assert.equal(calls,2);assert.deepEqual(settled(ws).map(e=>e.status),['unknown','known']);
  assert.equal(ws.events.filter(e=>e.reserve).length,2);
});

test('uncertain version write remains fenced and records a body-free reason',async()=>{
  const ws=ledger();
  await assert.rejects(factory(ws,async()=>{throw new Error('private transport detail');},async wrapped=>{
    await fetch(endpoint(wrapped)+route+'/versions?bindings_inherit=strict',{method:'POST',body:'version fixture'});
  })(command),error=>error.code==='publication_upload_unknown'&&error.detail.versionDispatched===true&&error.detail.reason==='transport');
  assert.deepEqual(settled(ws).map(e=>e.status),['unknown']);
});

test('caller provisioning flags cannot override the forced no-provision command',async()=>{
  for(const flags of [['--experimental-provision'],['--experimental-provision=true'],['--experimentalProvision=true'],['--x-provision=true'],
    ['--experimental-provision=false','--experimental-provision=true']]){
    const ws=ledger();await assert.rejects(factory(ws,async()=>assert.fail('No send'),async()=>assert.fail('No child'))({...command,args:[...command.args,...flags]}),
      error=>error.code==='publication_upload_scope_invalid');assert.deepEqual(ws.events,[]);
  }
});

test('an incomplete incoming body is actively closed at the deadline before any reservation',async t=>{
  const ws=ledger(),timer=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===180_000?20:ms,...args));
  await assert.rejects(factory(ws,async()=>assert.fail('No remote request'),async wrapped=>{
    await new Promise(resolve=>{const req=httpRequest(`${endpoint(wrapped)}${route}/assets-upload-session`,{method:'POST',headers:{'Content-Length':'100'}});
      req.on('error',()=>resolve());req.write('partial');});
  })(command),PublicationUploadCommandError);assert.deepEqual(ws.events,[]);
});

test('unexpected writes and resource/query drift fail before any remote dispatch',async()=>{
  for(const [method,suffix]of [['POST',`${route}/deployments`],['PATCH',`${route}/script-settings`],['GET',`${route}/secrets?extra=1`],
    ['POST',`${route}/versions?bindings_inherit=strict&extra=1`],['POST',`/accounts/${'b'.repeat(32)}/workers/assets/upload?base64=true`],
    ['POST',`/accounts/${scope.accountId}/workers/scripts/foreign/assets-upload-session`]]){
    const ws=ledger();await assert.rejects(factory(ws,async()=>assert.fail('Forbidden remote send'),async wrapped=>{
      const result=await fetch(`${endpoint(wrapped)}${suffix}`,{method});assert.equal(result.status,400);await result.arrayBuffer();
    })(command),error=>error instanceof PublicationUploadCommandError&&error.code==='publication_upload_scope_invalid');
    assert.deepEqual(ws.events,[]);
  }
});

test('budget denial sends nothing, has no refund/settlement, and fails the command held',async()=>{
  const ws=ledger();ws.reserveBudget=async()=>{throw new Error('Owned cap exhausted');};
  await assert.rejects(factory(ws,async()=>assert.fail('No send after denied reservation'),async wrapped=>{
    await(await fetch(`${endpoint(wrapped)}${route}/assets-upload-session`,{method:'POST',body:'{}'})).arrayBuffer();
  })(command),error=>error.code==='publication_upload_budget_failed');assert.deepEqual(ws.events,[]);
});

test('actual child deadline joins an aborted remote attempt and delayed unknown ledger settlement',mac,async()=>{
  let started,releaseSettle,returned=false,request;const sending=new Promise(resolve=>{started=resolve;}),ws=ledger();
  ws.settleBudget=async(id,value)=>{ws.events.push({id,...value});await new Promise(resolve=>{releaseSettle=resolve;});};
  const pending=factory(ws,async(_url,init)=>{started();return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new Error()),{once:true}));},async wrapped=>{
    const script=`fetch(process.env.CLOUDFLARE_API_BASE_URL+${JSON.stringify(`${route}/assets-upload-session`)},{method:'POST',body:'{}'}).catch(()=>{});`;
    request=promisify(execFile)(wrapped.file,[...wrapped.args.slice(0,2),process.execPath,'-e',script],{env:wrapped.env,timeout:10_000,maxBuffer:4096});
    await Promise.race([sending,request]);
    const deadline=setTimeout(()=>request.child.kill('SIGTERM'),20);
    try{await request;}finally{clearTimeout(deadline);}
  })(command).finally(()=>{returned=true;});const rejected=assert.rejects(pending,PublicationUploadCommandError);
  await Promise.race([sending,pending]);for(let n=0;n<2000&&!releaseSettle;n++)await pause(1);
  assert.equal(typeof releaseSettle,'function');assert.equal(returned,false);assert.deepEqual(settled(ws).map(event=>event.status),['unknown']);
  releaseSettle();await rejected;await request.catch(()=>{});const count=ws.events.length;await pause(10);assert.equal(ws.events.length,count);
});

test('oversized replies retain one unknown charge, never a false successful completion',async()=>{
  const ws=ledger();await assert.rejects(factory(ws,async()=>new Response(new Uint8Array(2*1024*1024+1)),async wrapped=>{
    await(await fetch(`${endpoint(wrapped)}${route}/assets-upload-session`,{method:'POST',body:'{}'})).arrayBuffer();
  })(command),PublicationUploadCommandError);
  assert.equal(ws.events.filter(event=>event.reserve).length,1);assert.deepEqual(settled(ws).map(event=>event.status),['unknown']);
});

test('only session metadata accepts measured551929B and exact2MiB; content/version replies keep512KiB',async()=>{
  for(const [suffix,size,ok]of [[`${route}/assets-upload-session`,551929,true],[`${route}/assets-upload-session`,2*1024*1024,true],
    [`${route}/assets-upload-session`,2*1024*1024+1,false],[`${route}/versions?bindings_inherit=strict`,512*1024,true],
    [`${route}/versions?bindings_inherit=strict`,512*1024+1,false],[`/accounts/${scope.accountId}/workers/assets/upload?base64=true`,512*1024+1,false]]){
    const ws=ledger();let cancelled=false;
    const run=factory(ws,async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(size));},cancel(){cancelled=true;}})),async wrapped=>{
      const response=await fetch(`${endpoint(wrapped)}${suffix}`,{method:'POST',body:'{}'});await response.arrayBuffer();
    });
    // Accepted streams must end; rejected streams prove cancellation instead.
    if(ok){await factory(ws,async()=>new Response(new Uint8Array(size)),async wrapped=>{
      const r=await fetch(`${endpoint(wrapped)}${suffix}`,{method:'POST',body:'{}'});assert.equal((await r.arrayBuffer()).byteLength,size);
    })(command);}else{await assert.rejects(run(command),error=>error.code==='publication_upload_unknown');assert.equal(cancelled,true);}
    assert.equal(ws.events.filter(e=>e.reserve).length,1);assert.deepEqual(settled(ws).map(e=>e.status),[ok?'known':'unknown']);
  }
});
test('a service whose name is assets-upload-session does not receive the metadata response allowance',async()=>{
  const ws=ledger(),named={...scope,workerName:'assets-upload-session'};
  await assert.rejects(accountedPublicationUploadCommand({workspace:ws,scope:named,isolation:fixtureIsolation,send:async()=>new Response(new Uint8Array(512*1024+1)),
    command:async wrapped=>{await(await fetch(`${endpoint(wrapped)}/accounts/${scope.accountId}/workers/services/assets-upload-session`)).arrayBuffer();}})(command),
  error=>error.code==='publication_upload_unknown');assert.deepEqual(settled(ws).map(e=>e.status),['unknown']);
});

test('actual sandbox allows only the exact IPv4 bridge port and descendants inherit denial',mac,async t=>{
  let forbiddenConnections=0;const ipv4=netServer(socket=>{forbiddenConnections++;socket.destroy();}),ipv6=netServer(socket=>{forbiddenConnections++;socket.destroy();});
  await new Promise(resolve=>ipv4.listen(0,'127.0.0.1',resolve));
  t.after(()=>{ipv4.close();ipv6.close();});const p4=ipv4.address().port,ws=ledger();let proof;
  await factory(ws,async()=>response({}),async wrapped=>{
    const p6=Number(new URL(endpoint(wrapped)).port);
    await new Promise(resolve=>ipv6.listen({port:p6,host:'::1',ipv6Only:true},resolve));
    const script=`const net=require('node:net'),cp=require('node:child_process');
      const probe=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});s.on('connect',()=>{s.destroy();resolve('CONNECTED')});s.on('error',e=>resolve(e.code));s.setTimeout(1500,()=>{s.destroy();resolve('TIMEOUT')})});
      (async()=>{const allowed=await fetch(process.env.CLOUDFLARE_API_BASE_URL+${JSON.stringify(`/accounts/${scope.accountId}/workers/services/${scope.workerName}`)});await allowed.text();
      const child=cp.execFileSync(process.execPath,['-e',${JSON.stringify(`const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:${p4}});s.on('connect',()=>{s.destroy();process.stdout.write('CONNECTED')});s.on('error',e=>process.stdout.write(e.code));s.setTimeout(1500,()=>{s.destroy();process.stdout.write('TIMEOUT')});`)}],{encoding:'utf8'});
      console.log(JSON.stringify({allowed:allowed.status,v4:await probe('127.0.0.1',${p4}),v6:await probe('::1',${p6}),child}));})().catch(()=>process.exit(1));`;
    const result=await promisify(execFile)(wrapped.file,[...wrapped.args.slice(0,2),process.execPath,'-e',script],
      {env:wrapped.env,timeout:10_000,maxBuffer:4096});proof=JSON.parse(result.stdout);
  })(command);
  assert.equal(proof.allowed,200);for(const key of ['v4','v6','child'])assert.ok(['EPERM','EACCES'].includes(proof[key]),`${key} was not denied by the sandbox`);
  assert.equal(forbiddenConnections,0);assert.equal(settled(ws).length,1);
});

for(const [single,stall]of [[false,false],[true,false],[false,true]])test(`pinned Wrangler actual ${single?'single':'bulk'} asset/version upload retries share this ledger without activation${stall?' after8s synchronous hashing':''}`,actualUpload,async t=>{
  assert.equal(createHash('sha256').update(await readFile(new URL('../node_modules/wrangler/wrangler-dist/cli.js',import.meta.url))).digest('hex'),
    'fdc72018f9cdd5cecff191ec00876825ac90620113996c9bf7d343914fbc842d');
  const dir=await mkdtemp(path.join(os.tmpdir(),'owned-wrangler-upload-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const runtime=linuxUpload?path.join(dir,'runtime'):dir;
  if(linuxUpload)await mkdir(runtime,{mode:0o700});
  await mkdir(path.join(dir,'assets'));await mkdir(path.join(runtime,'home'),{mode:0o700});await mkdir(path.join(runtime,'tmp'),{mode:0o700});
  await writeFile(path.join(dir,'worker.mjs'),'export default {fetch(){return new Response("Owned fixture")}}');
  await writeFile(path.join(dir,'assets','index.html'),'Owned static fixture');
  const preload=path.join(dir,'stall.mjs');
  if(stall)await writeFile(preload,`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';
    const read=fs.readFileSync;let blocked=false;fs.readFileSync=function(file,...args){const value=read.call(this,file,...args);
      if(!blocked&&String(file)===${JSON.stringify(path.join(dir,'assets','index.html'))}){blocked=true;
        fs.writeFileSync(${JSON.stringify(path.join(runtime,'tmp','stall-ran'))},'8000',{mode:0o600});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,8000);}return value;};syncBuiltinESMExports();`,{mode:0o600});
  const config={name:scope.workerName,account_id:scope.accountId,main:path.join(dir,'worker.mjs'),compatibility_date:'2026-10-19',workers_dev:false,preview_urls:false,
    upload_source_maps:false,vars:{ENVIRONMENT:'production'},assets:{directory:path.join(dir,'assets'),binding:'ASSETS',run_worker_first:true},
    d1_databases:[{binding:'DB',database_name:'owned-db',database_id:'00000000-0000-4000-8000-000000000002'}],vectorize:[{binding:'VECTORIZE',index_name:'owned-index'}]};
  const cfg=path.join(dir,'wrangler.json');await writeFile(cfg,JSON.stringify(config));
  const jwt=value=>`${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,...value})).toString('base64url')}.OWNED`;
  const assetJwt=jwt({wrangler_single_asset_uploads:single,edge_kv_upload_concurrency:1}),completeJwt=jwt({complete:true}),ws=ledger(),calls=[];let assetAttempts=0,versionAttempts=0;
  const send=async(url,init)=>{const u=new URL(url),body=Buffer.from(init.body??'');calls.push({method:init.method,path:u.pathname,search:u.search});
    if(u.pathname.endsWith(`/workers/services/${scope.workerName}`))return response({default_environment:{script:{tag:'owned',tags:[],last_deployed_from:'wrangler'}}});
    if(u.pathname.endsWith('/secrets'))return response([]);
    if(u.pathname.endsWith('/assets-upload-session'))return response({jwt:assetJwt,buckets:[Object.values(JSON.parse(body).manifest).map(value=>value.hash)]});
    if(u.pathname.includes('/workers/assets/upload')){
      assert.equal(init.headers.authorization,`Bearer ${assetJwt}`);assert.equal(u.search,single?'':'?base64=true');
      if(++assetAttempts===1)return response(null,503,{'Retry-After':'0'});return response({jwt:completeJwt});
    }
    if(u.pathname.endsWith('/versions')){assert.equal(u.search,'?bindings_inherit=strict');assert.ok(body.includes(Buffer.from(completeJwt)));
      if(++versionAttempts===1)return response(null,503,{'Retry-After':'0'});
      return response({id:'00000000-0000-4000-8000-000000000001',startup_time_ms:1,metadata:{has_preview:false}});}
    assert.fail('Unexpected fixture API route');
  };
  const attempted=[];const observed=({request})=>{attempted.push({method:request.method,path:request.url.split('/client/v4')[1]?.split('?')[0]??'not-api'});};
  const requests=channel('http.server.request.start');requests.subscribe(observed);t.after(()=>requests.unsubscribe(observed));
  const execute=async wrapped=>{
    try{await promisify(execFile)(wrapped.file,wrapped.args,{cwd:wrapped.cwd,env:wrapped.env,timeout:wrapped.timeoutMs,maxBuffer:1024*1024});}
    catch(error){t.diagnostic(`Owned fake-credential Wrangler fixture: ${String(error.stderr??error.code)}`);throw error;}
  };
  await accountedPublicationUploadCommand({workspace:ws,scope,send,command:execute})({...command,cwd:linuxUpload?fileURLToPath(new URL('..',import.meta.url)):dir,args:[wrangler,'versions','upload','--config',cfg,'--outdir',path.join(runtime,'out'),'--tag','owned-fixture'],
    env:{PATH:process.env.PATH,HOME:path.join(runtime,'home'),TMPDIR:path.join(runtime,'tmp'),CI:'true',CLOUDFLARE_API_TOKEN:'OWNED_FAKE_TOKEN',CLOUDFLARE_ACCOUNT_ID:scope.accountId,
      WRANGLER_LOG_PATH:path.join(runtime,'logs'),...(linuxUpload?{WRANGLER_OUTPUT_FILE_PATH:path.join(runtime,'output.ndjson')}:{ }),...(stall?{NODE_OPTIONS:`--import ${new URL('file://'+preload).href}`}:{})},timeoutMs:30_000}).catch(error=>assert.fail(`${error.code}: ${JSON.stringify(attempted)}`));
  assert.equal(assetAttempts,2);assert.equal(versionAttempts,2);assert.equal(calls.length,7);assert.equal(calls.filter(call=>call.path.endsWith('/versions')).length,2);
  if(stall)assert.equal(await readFile(path.join(runtime,'tmp','stall-ran'),'utf8'),'8000');
  assert.ok(calls.every(call=>!call.path.includes('/deployments')));assert.equal(ws.events.filter(event=>event.reserve).length,calls.length);
  assert.ok(ws.events.filter(event=>event.reserve).every(event=>event.reserve.units.httpRequests===1&&event.reserve.units.sqlStatements===0));
  assert.ok(settled(ws).every(event=>event.status==='known'));
});
