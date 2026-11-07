import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {codeOnlyInvocation,codeOnlyPublication,createCodeOnlyStore} from '../scripts/catalog/code-only-operator.mjs';
import {sha256} from '../scripts/catalog/migration.ts';

test('code-only route requires an explicit stable label and has no supplier/recovery arguments',()=>{
  assert.deepEqual(codeOnlyInvocation(['--run','homepage-fix']),{command:'start',runKey:'homepage-fix'});
  assert.deepEqual(codeOnlyInvocation(['resume','--run','homepage-fix']),{command:'resume',runKey:'homepage-fix'});
  for(const command of ['prepare','start','resume','status'])assert.equal(codeOnlyInvocation(['--run','release',command]).command,command);
  for(const args of [[],['start'],['start','--run'],['--run','../escape'],['--run','x','--run','y'],['--run','x','--admit-asins','B000000001'],
    ['--run','x','recover'],['--run','x','publish'],['--run','x','start','extra']])assert.throws(()=>codeOnlyInvocation(args),/code_only_arguments/);
});
test('code-only preparation observes usage estimates rather than restoring an internal publication quota',async()=>{
  const source=await fs.readFile(new URL('../scripts/catalog/code-only-operator.mjs',import.meta.url),'utf8');
  assert.match(source,/createCatalogD1ReadOnlyRest\(\{[^}]*requestLimit:'observe'/s);
});
test('actual daily CLI reaches code-only argument validation without a top-level import deadlock',()=>{
  const root=path.resolve(import.meta.dirname,'..');
  const result=spawnSync(process.execPath,['--import','tsx','scripts/catalog/daily-operator.mjs','code-only','status'],
    {cwd:root,env:{HOME:os.tmpdir(),PATH:process.env.PATH},encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);assert.match(result.stderr,/^code_only_arguments\s*$/);
  assert.doesNotMatch(result.stderr,/unsettled top-level await/);assert.equal(result.stdout,'');
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
