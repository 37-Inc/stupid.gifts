import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:net';
import { mkdtemp, realpath, mkdir, writeFile, rm, readlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountedPublicationUploadCommand } from '../scripts/catalog/publication-upload-command.ts';

// Opt-in is a real proof gate: when requested, missing bwrap/userns support
// fails, rather than reporting skipped tests as Linux deployment readiness.
const linux={skip:process.platform!=='linux'||process.env.CATALOG_LINUX_SANDBOX_TESTS!=='1'};
test('actual Linux bubblewrap permits only the accounted bridge and denies outside IPv4/IPv6/descendants',linux,async t=>{
  const dir=await realpath(await mkdtemp('/tmp/sg-linux-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const name of ['source','package','runtime','runtime/tmp'])await mkdir(path.join(dir,name),{mode:0o700});
  const config=path.join(dir,'package','wrangler.json');await writeFile(config,'{}',{mode:0o600});
  const scope={accountId:'a'.repeat(32),workerName:'owned-linux-upload'};
  let escaped=0;
  const ipv4=createServer(socket=>{escaped++;socket.destroy();}),ipv6=createServer(socket=>{escaped++;socket.destroy();});
  t.after(()=>{ipv4.close();ipv6.close();});
  await new Promise(resolve=>ipv4.listen(0,'127.0.0.1',resolve));
  await new Promise(resolve=>ipv6.listen({port:0,host:'::1',ipv6Only:true},resolve));
  const p4=ipv4.address().port,p6=ipv6.address().port,outerNet=await readlink('/proc/self/ns/net');
  const relay=fileURLToPath(new URL('../scripts/catalog/publication-upload-relay.mjs',import.meta.url));
  const entry=path.join(dir,'source','entry.mjs');
  await writeFile(entry,`import{runUploadRelay}from ${JSON.stringify(relay)};
    const[socket,prefix,file,...args]=process.argv.slice(2);await runUploadRelay(socket,prefix,file,args,{port:${p6}});`,{mode:0o600});
  const probe=`const net=require('node:net'),fs=require('node:fs'),cp=require('node:child_process');
    const probe=(host,port)=>new Promise(resolve=>{const s=net.connect({host,port});s.on('connect',()=>{s.destroy();resolve('CONNECTED')});s.on('error',e=>resolve(e.code));s.setTimeout(1500,()=>{s.destroy();resolve('TIMEOUT')})});
    (async()=>{const r=await fetch(process.env.CLOUDFLARE_API_BASE_URL+${JSON.stringify(`/accounts/${scope.accountId}/workers/services/${scope.workerName}`)});await r.text();
      const nested=cp.spawnSync(process.execPath,['-e',${JSON.stringify(`const net=require('node:net');const s=net.connect({host:'127.0.0.1',port:${p4}});s.on('connect',()=>{s.destroy();console.log('CONNECTED')});s.on('error',e=>console.log(e.code));`)}],{encoding:'utf8'});
      console.log(JSON.stringify({allowed:r.status,v4:await probe('127.0.0.1',${p4}),v6:await probe('::1',${p6}),
        descendant:nested.stdout.trim(),net:fs.readlinkSync('/proc/self/ns/net'),status:fs.readFileSync('/proc/self/status','utf8')}));})().catch(()=>process.exit(1));`;
  const events=[],ws={async assertHeld(){},async reserveBudget(v){events.push({reserve:v});},async settleBudget(id,v){events.push({id,...v});}};
  let proof;
  await accountedPublicationUploadCommand({workspace:ws,scope,send:async(url)=>{
    assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${scope.accountId}/workers/services/${scope.workerName}`);
    return Response.json({success:true,result:{}});
  },command:async wrapped=>{
    // The relay also occurs in the read-only mount list. Replace only the
    // executable entry after bubblewrap's '--', never a mount argument.
    const at=wrapped.args.lastIndexOf(relay);assert.ok(at>wrapped.args.lastIndexOf('--'));
    const args=[...wrapped.args];args[at]=entry;args.splice(at+3,args.length-at-3,process.execPath,'-e',probe);
    try{const result=await promisify(execFile)(wrapped.file,args,{env:wrapped.env,timeout:15_000,maxBuffer:64*1024});
      proof=JSON.parse(result.stdout);
    }catch(error){t.diagnostic(`Owned Linux fixture launcher: ${String(error.stderr||error.code)}`);throw error;}
  }})({file:process.execPath,cwd:path.join(dir,'source'),timeoutMs:20_000,
    args:['node_modules/wrangler/bin/wrangler.js','versions','upload','--config',config,'--outdir',path.join(dir,'runtime','out')],
    env:{PATH:process.env.PATH,TMPDIR:path.join(dir,'runtime','tmp'),WRANGLER_LOG_PATH:path.join(dir,'runtime','logs'),
      WRANGLER_OUTPUT_FILE_PATH:path.join(dir,'runtime','upload.ndjson')}});
  assert.equal(proof.allowed,200);assert.notEqual(proof.net,outerNet);
  for(const key of ['v4','v6','descendant'])assert.ok(['EPERM','EACCES','ECONNREFUSED','ENETUNREACH'].includes(proof[key]),`${key}:${proof[key]}`);
  for(const capability of ['CapEff','CapPrm','CapBnd','CapAmb'])assert.match(proof.status,new RegExp(`^${capability}:\\s+0+$`,'m'));
  assert.match(proof.status,/^NoNewPrivs:\s+1$/m);assert.equal(escaped,0);
  assert.equal(events.filter(e=>e.reserve).length,1);assert.deepEqual(events.filter(e=>e.status).map(e=>e.status),['known']);
});
