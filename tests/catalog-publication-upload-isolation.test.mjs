import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { publicationUploadIsolation } from '../scripts/catalog/publication-upload-isolation.ts';
import { accountedPublicationUploadCommand } from '../scripts/catalog/publication-upload-command.ts';
import { uploadRelay } from '../scripts/catalog/publication-upload-relay.mjs';

const prefix=`/${'a'.repeat(48)}/client/v4`;

test('Unix relay preserves the existing scoped/accounted bridge across platforms',async()=>{
  const scope={accountId:'a'.repeat(32),workerName:'owned-relay-fixture'},events=[];
  const workspace={async assertHeld(){},async reserveBudget(v){events.push({reserve:v});},async settleBudget(id,v){events.push({id,...v});}};
  const isolation={transport:'unix',async available(){},async wrap(command,endpoint){
    return{...command,env:{...command.env,OWNED_SOCKET:endpoint.socketPath,OWNED_PREFIX:endpoint.prefix}};
  }};
  await accountedPublicationUploadCommand({workspace,scope,isolation,send:async(url,init)=>{
    assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${scope.accountId}/workers/assets/upload?base64=true`);
    assert.equal(init.headers.authorization,'Bearer OWNED_FIXTURE');assert.equal(Buffer.from(init.body).toString(),'owned bytes');
    return Response.json({success:true,result:{fixture:'only'}});
  },command:async wrapped=>{
    const relay=uploadRelay(wrapped.env.OWNED_SOCKET);
    await new Promise(resolve=>relay.server.listen(0,'127.0.0.1',resolve));
    try{const response=await fetch(`http://127.0.0.1:${relay.server.address().port}${wrapped.env.OWNED_PREFIX}/accounts/${scope.accountId}/workers/assets/upload?base64=true`,
      {method:'POST',headers:{authorization:'Bearer OWNED_FIXTURE'},body:'owned bytes'});
      assert.equal(response.status,200);assert.deepEqual(await response.json(),{success:true,result:{fixture:'only'}});
    }finally{relay.close();}
  }})({file:process.execPath,args:['node_modules/wrangler/bin/wrangler.js','versions','upload'],cwd:'/owned',env:{},timeoutMs:1000});
  assert.equal(events.filter(e=>e.reserve).length,1);assert.deepEqual(events.filter(e=>e.status).map(e=>e.status),['known']);
});

async function fixture(t){
  const dir=await realpath(await mkdtemp('/tmp/sg-launch-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  for(const name of ['source','package','runtime','runtime/tmp'])await mkdir(path.join(dir,name),{mode:0o700});
  const config=path.join(dir,'package','wrangler.json');await writeFile(config,'{}',{mode:0o600});
  const command={file:process.execPath,cwd:path.join(dir,'source'),timeoutMs:1000,
    args:['node_modules/wrangler/bin/wrangler.js','versions','upload','--config',config,'--outdir',path.join(dir,'runtime','out')],
    env:{HOME:'/never-mounted-owner-home',TMPDIR:path.join(dir,'runtime','tmp'),
      WRANGLER_LOG_PATH:path.join(dir,'runtime','logs'),WRANGLER_OUTPUT_FILE_PATH:path.join(dir,'runtime','upload.ndjson')}};
  return{dir,command,socketPath:path.join(dir,'bridge.sock')};
}

test('macOS launcher preserves the existing exact-port Seatbelt policy and arguments',async()=>{
  const command={file:'/usr/bin/node',args:['owned'],cwd:'/owned',env:{A:'B'},timeoutMs:1};
  const actual=await publicationUploadIsolation('darwin').wrap(command,{port:12345,prefix});
  assert.equal(actual.file,'/usr/bin/sandbox-exec');
  assert.deepEqual(actual.args,['-p','(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote tcp4 "localhost:12345"))','/usr/bin/node','owned']);
  assert.equal(actual.env.CLOUDFLARE_API_BASE_URL,`http://127.0.0.1:12345${prefix}`);
  assert.equal(command.env.CLOUDFLARE_API_BASE_URL,undefined);
});

test('Linux plan has mandatory isolated namespaces, no capabilities and only explicit mounts',async t=>{
  const {command,socketPath}=await fixture(t);await writeFile(socketPath,'owned socket-path fixture',{mode:0o600});
  const actual=await publicationUploadIsolation('linux').wrap(command,{socketPath,prefix});
  assert.equal(actual.file,'/usr/bin/bwrap');
  for(const flag of ['--unshare-user','--unshare-net','--unshare-pid','--unshare-ipc','--disable-userns','--die-with-parent','--new-session'])
    assert.ok(actual.args.includes(flag),flag);
  assert.equal(actual.args[actual.args.indexOf('--cap-drop')+1],'ALL');
  assert.equal(actual.args.includes('--share-net'),false);
  for(let i=0;i<actual.args.length;i++)if(['--bind','--ro-bind'].includes(actual.args[i]))
    assert.equal(['/','/run','/var/run','/never-mounted-owner-home'].includes(actual.args[i+1]),false);
  assert.ok(actual.args.includes(socketPath));
  assert.ok(actual.args.some(arg=>arg.endsWith('/publication-upload-relay.mjs')));
  assert.equal(actual.env.HOME,path.join(command.env.TMPDIR,'home'));
  assert.equal(await readFile(command.env.WRANGLER_OUTPUT_FILE_PATH,'utf8'),'');
});

test('Linux launcher rejects missing paths, unsafe roots, duplicate flags and symlink outputs',async t=>{
  const {command,socketPath}=await fixture(t);await writeFile(socketPath,'fixture',{mode:0o600});
  const launch=value=>publicationUploadIsolation('linux').wrap(value,{socketPath,prefix});
  for(const value of [{...command,cwd:'/'},{...command,args:[]},
    {...command,args:[...command.args,'--config',command.args[4]]},
    {...command,env:{...command.env,TMPDIR:undefined}},
    {...command,env:{...command.env,WRANGLER_LOG_PATH:command.cwd}},
    {...command,env:{...command.env,HOME:command.env.TMPDIR}}])await assert.rejects(launch(value));
  await symlink(path.join(command.cwd,'foreign'),command.env.WRANGLER_OUTPUT_FILE_PATH);
  await assert.rejects(launch(command));
  assert.throws(()=>publicationUploadIsolation('win32'),/sandbox_unavailable/);
});
