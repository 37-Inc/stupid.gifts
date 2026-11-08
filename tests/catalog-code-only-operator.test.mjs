import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {codeOnlyInvocation,codeOnlyPublication,createCodeOnlyStore,codeOnlyTerminal,codeOnlyExecution,codeOnlyFetchScope} from '../scripts/catalog/code-only-operator.mjs';
import {validatePublicationConfig} from '../scripts/catalog/publish-release.ts';
import {accountedPublicationFetch,accountedPublicationReadFetch} from '../scripts/catalog/publication-read-fetch.ts';
import {sha256} from '../scripts/catalog/migration.ts';

test('code-only route requires an explicit stable label and never accepts supplier/new-authority arguments',()=>{
  assert.deepEqual(codeOnlyInvocation(['--run','homepage-fix']),{command:'start',runKey:'homepage-fix'});
  assert.deepEqual(codeOnlyInvocation(['resume','--run','homepage-fix']),{command:'resume',runKey:'homepage-fix'});
  for(const command of ['prepare','start','resume','recover','status'])assert.equal(codeOnlyInvocation(['--run','release',command]).command,command);
  for(const args of [[],['start'],['start','--run'],['--run','../escape'],['--run','x','--run','y'],['--run','x','--admit-asins','B000000001'],
    ['--run','x','recover','new-source'],['--run','x','publish'],['--run','x','start','extra']])assert.throws(()=>codeOnlyInvocation(args),/code_only_arguments/);
});
test('code-only preparation observes usage estimates rather than restoring an internal publication quota',async()=>{
  const source=await fs.readFile(new URL('../scripts/catalog/code-only-operator.mjs',import.meta.url),'utf8');
  assert.match(source,/createCatalogD1ReadOnlyRest\(\{[^}]*requestLimit:'observe'/s);
});
test('actual daily CLI reaches code-only argument validation without a top-level import deadlock',()=>{
  const root=path.resolve(import.meta.dirname,'..');
  for(const command of ['status','recover']){
    const result=spawnSync(process.execPath,['--import','tsx','scripts/catalog/daily-operator.mjs','code-only',command],
      {cwd:root,env:{HOME:os.tmpdir(),PATH:process.env.PATH},encoding:'utf8',timeout:10000});
    assert.equal(result.status,1);assert.deepEqual(result.stderr.trim().split(/\r?\n/),[
      JSON.stringify({state:'operator_error',errorCode:'code_only_arguments'}),'code_only_arguments']);
    assert.doesNotMatch(result.stderr,/unsettled top-level await/);assert.equal(result.stdout,'');}
});

test('validated code-only network scope includes exactly its configured derived serving index',async()=>{
  const config=validatePublicationConfig({schemaVersion:1,environment:'production',accountId:'a'.repeat(32),workerName:'fixture-worker',
    database:{id:'00000000-0000-4000-8000-000000000001',name:'fixture-db'},indexName:'fixture-native',codeSha:'b'.repeat(40),
    sourceMode:'stupid-production',sourceRoot:'/fixture',releaseId:'fixture-code',identityOrigin:'https://stupid.gifts',compatibilityDate:'2026-11-01',prior:null,
    semanticSearch:{enabled:true,derivedCatalog:{indexName:'fixture-derived',path:'/private/semantic.json',sha256:'c'.repeat(64)}}}),
    scope=codeOnlyFetchScope(config),url=`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/vectorize/v2/indexes/fixture-derived`;
  assert.equal(scope.derivedIndexName,'fixture-derived');
  for(const factory of [accountedPublicationFetch,accountedPublicationReadFetch]){
    let dispatched=0;const ws={async reserveBudget(){},async settleBudget(){}},send=factory(ws,async()=>{dispatched++;return Response.json({success:true,result:{}});},scope);
    await send(url,{method:'GET',redirect:'error'});assert.equal(dispatched,1);
    await assert.rejects(send(url.replace('fixture-derived','foreign'),{method:'GET',redirect:'error'}),/publication_read_scope_invalid/);
    await assert.rejects(send(url+'/delete_by_ids',{method:'POST',redirect:'error',body:JSON.stringify({ids:['d'.repeat(64)]})}),/publication_read_scope_invalid/);
    assert.equal(dispatched,1);
  }
  assert.equal(Object.hasOwn(codeOnlyFetchScope({...config,semanticSearch:{enabled:false}}),'derivedIndexName'),false);
});

test('recovery uses only a clean exact frozen source with a clean descendant controller and never rewrites inputs',async t=>{
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'code-only-recovery-'))),root=directory+'/controller',old=directory+'/original';
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));await fs.mkdir(root);
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,HOME:directory,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim(),helper='scripts/catalog/code-only-operator.mjs';
  git('init','-q');await fs.mkdir(root+'/scripts/catalog',{recursive:true});await fs.writeFile(root+'/'+helper,'// exact original fixture\n');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Original');const source=git('rev-parse','HEAD');
  git('worktree','add','--detach',old,source);const originalHelper=await fs.readFile(old+'/'+helper),record={source,helperSha256:sha256(originalHelper),
    config:{value:{sourceRoot:old,codeSha:source}},authority:{value:{request:{codeSha:source}}}};
  await fs.writeFile(root+'/'+helper,'// reviewed descendant controller\n');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Recovery');
  const operatorSource=git('rev-parse','HEAD'),helperSha256=sha256(await fs.readFile(root+'/'+helper)),before=JSON.stringify(record),
    args={record,operatorRoot:root,operatorSource,helperSha256};
  assert.deepEqual(await codeOnlyExecution({...args,command:'recover'}),{repository:old,codeSha:source,recoveryOperator:{source:operatorSource,helperSha256}});
  for(const command of ['start','resume'])await assert.rejects(codeOnlyExecution({...args,command}),/source_changed/);
  await assert.rejects(codeOnlyExecution({...args,record:null,command:'recover'}),/not_prepared/);
  await assert.rejects(codeOnlyExecution({...args,record:{...record,helperSha256:'f'.repeat(64)},command:'recover'}),/original_source/);
  await fs.writeFile(old+'/'+helper,'// dirty original\n');await assert.rejects(codeOnlyExecution({...args,command:'recover'}),/original_source/);
  await fs.writeFile(old+'/'+helper,originalHelper);
  await fs.writeFile(root+'/untracked','dirty');await assert.rejects(codeOnlyExecution({...args,command:'recover'}),/original_source/);await fs.unlink(root+'/untracked');
  assert.equal(JSON.stringify(record),before);assert.deepEqual(await fs.readFile(old+'/'+helper),originalHelper);
  git('checkout','--orphan','unrelated');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Unrelated');
  await assert.rejects(codeOnlyExecution({...args,operatorSource:git('rev-parse','HEAD'),command:'recover'}),/original_source/);
});

test('new serving config preserves accepted presentation but separates catalog authority from current serving code',()=>{
  const hash='a'.repeat(64),version='01234567-89ab-cdef-0123-456789abcdef',source='b'.repeat(40),scope={environment:'production',
    accountId:'7f05a1dcb6e16f9c239564a0293bbe74',workerName:'stupid-gifts-production',database:{id:'77b30f85-c57c-4acb-a0df-53368806c2a6',name:'stupid-gifts-production'},indexName:'stupid-gifts-production'};
  const saved={schemaVersion:1,...scope,codeSha:'c'.repeat(40),sourceMode:'stupid-production',sourceRoot:'/original/retained',releaseId:'catalog',identityOrigin:'https://stupid.gifts',
    compatibilityDate:'2026-10-19',prior:null,semanticSearch:{enabled:false},publicAnalytics:{enabled:false,posthogHost:'https://us.i.posthog.com',posthogKey:'phc_fixture'}};
  const prior={manifestSha256:hash,versionReference:version},seal={publication:{releaseId:'catalog',receiptSha256:hash}},
    authority={sealSha256:hash},servingPrior={releaseId:'newer-code',codeSha:'d'.repeat(40),catalogRevision:'catalog',catalogSnapshotSha256:hash,manifestSha256:'e'.repeat(64),versionReference:version};
  const before=structuredClone(saved),result=codeOnlyPublication({saved,sourceRoot:'/new/reviewed',codeSha:source,releaseId:'code-one',prior,seal,authority,servingPrior,semanticSearch:{enabled:false}});
  assert.equal(result.prior.releaseId,'catalog');assert.equal(result.prior.directory,null);assert.equal(result.servingPrior.releaseId,'newer-code');
  assert.equal(result.acceptedCatalog.receiptSha256,hash);assert.equal(result.codeSha,source);assert.deepEqual(result.publicAnalytics,saved.publicAnalytics);assert.deepEqual(saved,before);
  for(const drift of [{workerName:'other'},{accountId:'f'.repeat(32)},{sourceMode:'preview'},{identityOrigin:'https://other.invalid'},{database:{...scope.database,name:'other'}}])
    assert.throws(()=>codeOnlyPublication({saved:{...saved,...drift},sourceRoot:'/new/reviewed',codeSha:source,releaseId:'code-one',prior,seal,authority,servingPrior,semanticSearch:{enabled:false}}));
});

test('protected code-only records are immutable, hash-bound and cannot follow links or escape the private base',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'code-only-store-')));await fs.chmod(base,0o700);t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const store=createCodeOnlyStore(base),file=path.join(base,'runs/example/authority.json'),value={kind:'body-free',receiptSha256:'a'.repeat(64)};
  const digest=await store.put(file,value);assert.equal(digest,sha256(JSON.stringify(value)+'\n'));assert.deepEqual(await store.json(file,digest),value);
  assert.equal(await store.put(file,value),digest);await assert.rejects(store.put(file,{...value,kind:'changed'}),/immutable_changed/);
  await assert.rejects(store.json(file,'b'.repeat(64)),/private_digest/);await assert.rejects(store.put(path.join(base,'../escape.json'),{}),/private_path/);
  const linked=path.join(base,'linked.json');await fs.symlink(file,linked);await assert.rejects(store.json(linked),/private_path/);
  const hard=path.join(base,'hard.json');await fs.link(file,hard);await assert.rejects(store.json(hard),/private_file/);await fs.unlink(hard);
  await fs.chmod(file,0o644);await assert.rejects(store.json(file),/private_file/);await fs.chmod(file,0o600);
  assert.equal(await store.optional(path.join(base,'missing.json')),null);
});

test('released unused code-only attempts stay terminal across future command sources without any provider call',async t=>{
  const base=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'code-only-abandoned-')));await fs.chmod(base,0o700);
  t.after(()=>fs.rm(base,{recursive:true,force:true}));const store=createCodeOnlyStore(base),directory=base+'/old',
    record={runId:'old-attempt',source:'a'.repeat(40)},operatorSha256=await store.put(directory+'/operator.json',record),
    abandoned={schemaVersion:1,state:'abandoned_prebuild',...record,operatorSha256,builds:0,uploads:0,activations:0,idle:{phase:'idle',external_pending:0}};
  assert.equal(await codeOnlyTerminal(store,directory,record),null);
  await store.put(directory+'/abandoned.json',abandoned);
  assert.deepEqual(await codeOnlyTerminal(store,directory,record),{state:'abandoned_prebuild',...record,historicalAcceptance:false,supplierCalls:0,modelCalls:0});
  for(const changed of [{runId:'other'},{source:'b'.repeat(40)}])await assert.rejects(codeOnlyTerminal(store,directory,{...record,...changed}),/abandonment_changed/);
  await assert.rejects(codeOnlyTerminal(store,directory,null),/abandonment_changed/);
  await store.put(directory+'/success.json',{});await assert.rejects(codeOnlyTerminal(store,directory,record),/abandonment_changed/);
  const source=await fs.readFile(new URL('../scripts/catalog/code-only-operator.mjs',import.meta.url),'utf8');
  assert.ok(source.indexOf('const terminal=await codeOnlyTerminal')<source.indexOf('const execution=record?await codeOnlyExecution'));
});
