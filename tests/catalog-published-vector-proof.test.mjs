import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { claimMutationOwnership, releaseMutationOwnership } from '../lib/catalog/mutation-fence.ts';
import { enqueueBuildRequest, claimBuildRequest } from '../lib/catalog/build-requests.ts';
import { completeActivatedPublication } from '../lib/catalog/publication.ts';
import { canonicalJson, sha256 } from '../scripts/catalog/migration.ts';
import { executePublication } from '../scripts/catalog/publish-release.ts';
import { openRunWorkspace } from '../scripts/catalog/run-workspace.ts';
import { createCatalogD1Rest } from '../scripts/catalog/d1-write-rest.ts';
import { accountedPublicationFetch, accountedPublicationReadFetch } from '../scripts/catalog/publication-read-fetch.ts';
import { accountedPublicationUploadCommand } from '../scripts/catalog/publication-upload-command.ts';
import { createVectorizeRestAdapters } from '../scripts/catalog/vectorize-rest.ts';
import { createReleaseIdentity } from '../scripts/staging/release-identity.mts';
import { siteIdentityBytes } from '../scripts/staging/build.mts';
import { assembleReleaseAssets } from '../scripts/staging/retention.mts';
import { createStaticFeedPlan } from '../workers/site/feed.ts';
import { createBrowseRelease } from '../static-site/lib/browse.ts';
import { createOgRelease } from '../static-site/lib/og.ts';
import { siteIdentityFor } from '../static-site/lib/site-identity.ts';
import { guides } from '../static-site/lib/guides.ts';
import { encodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';
import safeCatalogPayload from '../static-site/public/safe/catalog.json' with {type:'json'};
import { publishedCatalogOperationKey, readPublishedCatalogVectors, readActivatedCatalogVectors } from '../scripts/catalog/owned-vector-delivery.ts';

import {setup,at,scope,uuid} from './helpers/published-vector-fixture.mjs';
test('owned published native proof excludes slow durable I/O from its outer observation clock',async t=>{
  const accountId='a'.repeat(32),f=await setup(t,{providerIdentity:`cloudflare:${accountId}:${scope.indexName}`}),events=[];
  const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
  const send=accountedPublicationReadFetch({async reserveBudget(){events.push('reserve');await pause();},
    async settleBudget(_id,value){events.push(value.status);await pause();}},async(_url,init)=>{
    const found=JSON.parse(init.body).ids.flatMap(id=>{const v=f.index.get(id);return v?[`{"id":${JSON.stringify(id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':n).join(',')}],"metadata":${JSON.stringify(v.metadata)}}`]:[];});
    return new Response(`{"success":true,"result":[${found.join(',')}]}`);
  },{accountId,databaseId:uuid(70),workerName:'fixture',indexName:scope.indexName,identityOrigin:'https://fixture.invalid'});
  const adapters=createVectorizeRestAdapters({...scope,accountId,token:'TEST_ONLY',fetch:send});
  const timer=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===3000?10:ms,...args));
  assert.equal((await f.readonly(()=>readPublishedCatalogVectors({...f.options,adapters}))).settled,true);
  assert.ok(events.length>0);assert.ok(!events.includes('unknown'));
});
test('published eight+two proof is read-only, preserves signed zero and settles a new normal code-only build exactly once',async t=>{
  const f=await setup(t),before=f.sql.prepare('SELECT * FROM products ORDER BY id').all(),dispatches=f.dispatches();
  assert.equal(f.revision.snapshot.products.length,8);assert.equal(f.revision.snapshot.heldProducts.length,2);
  const journals=f.sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY delivery_id').all();
  const read=()=>f.readonly(()=>readPublishedCatalogVectors(f.options));
  try{assert.equal((await read()).settled,true);}catch(error){t.diagnostic(JSON.stringify(f.metrics));throw error;}assert.deepEqual(await read(),await read());
  assert.ok(Object.is(f.index.get(uuid(1)).values[0],-0));
  const queued=await enqueueBuildRequest(f.db,f.published.request),build=await claimBuildRequest(f.db,queued.requestId,'fixture:new-build',f.now());
  const active=await f.activate(build,f.owner,'new-code-release',f.original.intent);
  const observed=()=>f.readonly(()=>readActivatedCatalogVectors(f.db,active.permit,f.control,f.adapters,{published:f.published}));
  await assert.rejects(readActivatedCatalogVectors(f.db,active.permit,f.control,f.adapters)); // No implicit historical fallback.
  await f.finish(active,observed);
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='new-code-release'").get().n,1);
  assert.deepEqual(f.sql.prepare('SELECT * FROM products ORDER BY id').all(),before);assert.deepEqual(f.sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY delivery_id').all(),journals);
  assert.equal(f.dispatches(),dispatches);assert.ok(f.metrics.maxRequest<512*1024);assert.ok(f.metrics.maxResponse<512*1024);
});
test('same-owner final CAS refuses source, held, projection, prior, native, expiry and ABA drift',async t=>{
  for(const fault of ['source','held','held_full_row','held_native','projection','prior','native','metadata','expiry','aba','captured_time']){
    const f=await setup(t),before=f.dispatches();let once=false;
    const adapters={...f.adapters,async readback(id,signal){const value=fault==='held_native'&&id===uuid(9)?structuredClone(f.index.get(uuid(1))):await f.adapters.readback(id,signal);
      if(id===uuid(1)&&fault==='native')value.values[0]=0;
      if(id===uuid(1)&&fault==='metadata')value.metadata.catalogRevision='other';
      if(!once){once=true;if(fault==='source')f.sql.prepare("UPDATE products SET rights_json='{}' WHERE public_id=?").run(uuid(1));
        if(fault==='held')f.sql.prepare("UPDATE products SET source_facts_hash=? WHERE public_id=?").run('0'.repeat(64),uuid(10));
        if(fault==='held_full_row')f.sql.prepare("UPDATE products SET source_query='changed held private column' WHERE public_id=?").run(uuid(10));
        if(fault==='projection')f.sql.prepare('DELETE FROM catalog_public_products WHERE catalog_revision=? AND public_id=?').run('maintained',uuid(1));
        if(fault==='prior')f.sql.prepare("UPDATE publication_receipts SET completed_at=? WHERE release_id='original-release'").run(at(5));
        if(fault==='expiry')f.advance(24*3600000);
        if(fault==='captured_time')f.sql.prepare('UPDATE catalog_mutation_scopes SET captured_at=?').run(at(20));
        if(fault==='aba'){await releaseMutationOwnership(f.db,f.owner);await claimMutationOwnership(f.db,scope,
          {phase:'freezing',ownerReference:f.owner.ownerReference,operationKey:f.owner.operationKey});}}
      return value;}};
    await assert.rejects(readPublishedCatalogVectors({...f.options,adapters}),undefined,fault);assert.equal(f.dispatches(),before,fault);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='new-code-release'").get().n,0);
  }
});
test('altered historical inputs/approval and new permit cannot substitute for original proof',async t=>{
  const f=await setup(t);for(const fault of ['receipt','journal','approval','snapshot','request','code']){
    const changed=structuredClone(f.published);
    if(fault==='receipt')changed.source.receiptSha256='0'.repeat(64);if(fault==='journal')changed.source.deliverySha256='0'.repeat(64);
    if(fault==='approval')changed.revision.request.approval.runId='invented';if(fault==='snapshot')changed.revision.snapshot.heldProducts.pop();
    if(fault==='request')changed.request.sourceRevision='other';if(fault==='code')changed.request.codeSha=f.original.intent.codeSha;
    await assert.rejects(readPublishedCatalogVectors({...f.options,published:changed}),undefined,fault);
  }
  const queued=await enqueueBuildRequest(f.db,f.published.request),build=await claimBuildRequest(f.db,queued.requestId,'fixture:new-build',f.now());
  const active=await f.activate(build,f.owner,'new-code-release',f.original.intent);
  for(const field of ['token','runReference','versionReference','releaseId','requestId'])await assert.rejects(readActivatedCatalogVectors(f.db,
    {...active.permit,[field]:'wrong'},f.control,f.adapters,{published:f.published}),undefined,field);
});
test('abort and failed native siblings drain before return, retain ownership and permit exact retry',async t=>{
  const f=await setup(t),controller=new AbortController();controller.abort();let calls=0,cleaned=0;
  await assert.rejects(readPublishedCatalogVectors({...f.options,signal:controller.signal}));
  const adapters={...f.adapters,async readback(id,signal){calls++;if(id===uuid(1))return null;
    await new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{cleaned++;resolve();},20),{once:true}));signal.throwIfAborted();}};
  await assert.rejects(readPublishedCatalogVectors({...f.options,adapters}),/vector_not_visible/);
  assert.equal(calls,10);assert.equal(cleaned,9);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,10);assert.equal(cleaned,9);
  assert.equal((await f.readonly(()=>readPublishedCatalogVectors(f.options))).settled,true);
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'freezing');
});
test('matching claim cannot authorize unchanged code or a repinned false historical receipt',async t=>{
  for(const fault of ['same_code','false_receipt']){
    const f=await setup(t),published=structuredClone(f.published);
    if(fault==='same_code')published.request.codeSha=f.original.intent.codeSha;else published.source.receiptSha256='0'.repeat(64);
    await releaseMutationOwnership(f.db,f.owner);const owner=await claimMutationOwnership(f.db,scope,
      {phase:'freezing',ownerReference:'exact-rejected-input',operationKey:publishedCatalogOperationKey(published)});
    await assert.rejects(f.readonly(()=>readPublishedCatalogVectors({...f.options,owner,published})),
      fault==='same_code'?/vector_published_code_unchanged/:/vector_published_receipt_changed/);
  }
});

// This composition replaces only build/upload/HTTP with owned synthetic output.
// The actual executor, sealed package validation, normal D1 claims/permit/receipt,
// protected upload bridge and ALL durable transport accounting remain real.
async function composition(t){
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'published-catalog-release-')));
  let workspace;t.after(async()=>{await workspace?.close();await fs.rm(directory,{recursive:true,force:true});});
  const sourceRoot=path.join(directory,'source');await fs.mkdir(sourceRoot,{mode:0o700});
  const put=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,value,{mode:0o600});};
  const git=(...args)=>execFileSync('git',args,{cwd:sourceRoot,encoding:'utf8',env:{PATH:process.env.PATH,HOME:directory,
    GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
  git('init','-q');await put(path.join(sourceRoot,'.gitignore'),'build/\nstatic-site/out/\n');git('add','.gitignore');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Owned code-only fixture');const codeSha=git('rev-parse','HEAD');
  const accountId='a'.repeat(32),databaseId=uuid(70),version=uuid(71),priorVersion=uuid(72),deployment=uuid(73);
  const f=await setup(t,{codeSha,providerIdentity:`cloudflare:${accountId}:${scope.indexName}`,originalVersion:priorVersion});
  await releaseMutationOwnership(f.db,f.owner); // End fixture setup at the genuine prior idle state.
  const frozenProducts=canonicalJson(f.sql.prepare('SELECT * FROM products ORDER BY id').all());
  const frozenJournals=canonicalJson(f.sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY delivery_id').all());
  const native=()=>canonicalJson([...f.index].map(([id,v])=>({id,native:encodePgvectorSendBase64(v.values),metadata:v.metadata})));
  const frozenNative=native(),sourceDispatches=f.dispatches(),deadline=f.revision.snapshot.products[0].eligibleUntil;
  const config={schemaVersion:1,...scope,accountId,workerName:'published-fixture-worker',database:{id:databaseId,name:'published-fixture-db'},
    codeSha,sourceMode:'preview',sourceRoot,releaseId:'published-new-code',identityOrigin:'https://published-fixture.example.invalid',
    compatibilityDate:'2026-10-20',prior:{directory:null,manifestSha256:f.original.intent.manifestSha256,releaseId:f.original.intent.releaseId,versionReference:priorVersion}};
  const wsOptions={directory:path.join(directory,'private'),repository:sourceRoot,mode:'create',runId:'published-new-code',codeSha,
    configSha256:sha256(canonicalJson(config)),scope:{...scope,accountId,databaseId,databaseName:config.database.name,workerName:config.workerName},
    retention:{reviewReference:'test-only/original-window',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
      .map(kind=>[kind,{maxAgeMs:24*3600000,notAfter:deadline}]))},budgetCaps:{httpRequests:800,sqlStatements:1200},now:()=>f.now().toISOString()};
  workspace=await openRunWorkspace(wsOptions);
  const counts={http:0,sql:0,nativeReads:0,nativeWrites:0,uploads:0,activations:0,builds:0,uploadHttp:0},wire={request:0,response:0,params:0,statements:0};
  const mode={};let manifest,uploaded=false,active=false,uploadedConfig;
  const response=result=>Response.json({success:true,result});
  const checkpoint=async()=>(await workspace.readCheckpoint({controlOnly:true}))?.checkpoint;
  const base=`https://api.cloudflare.com/client/v4/accounts/${accountId}`,worker=`${base}/workers/scripts/${config.workerName}`;
  const raw=async(url,init={})=>{
    counts.http++;init.signal?.throwIfAborted();const u=new URL(url);
    if(url===`${base}/d1/database/${databaseId}`)return response({uuid:databaseId,name:config.database.name,read_replication:{mode:'disabled'}});
    if(url===`${base}/d1/database/${databaseId}/query`){
      const batch=JSON.parse(init.body).batch;wire.request=Math.max(wire.request,Buffer.byteLength(init.body));
      wire.statements=Math.max(wire.statements,batch.length);assert.ok(batch.length<=50);const result=[];f.sql.exec('BEGIN');
      try{for(const q of batch){counts.sql++;wire.params=Math.max(wire.params,q.params.length);assert.ok(q.params.length<=100);
        const before=f.sql.prepare('SELECT total_changes() n').get().n,rows=f.sql.prepare(q.sql).all(...q.params).map(r=>({...r}));
        // Readback corruption only: immutable source journals are NEVER edited.
        if(mode.journalDrift&&q.sql==='SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?'&&rows[0])rows[0].completed_at=at(20);
        if(mode.receiptDrift&&q.sql==='SELECT * FROM publication_receipts WHERE release_id=?'&&rows[0])rows[0].completed_at=at(20);
        const changes=f.sql.prepare('SELECT total_changes() n').get().n-before;
        result.push({success:true,results:rows,meta:{served_by_primary:true,rows_read:rows.length,rows_written:changes,changes}});
      }f.sql.exec('COMMIT');}catch(error){f.sql.exec('ROLLBACK');throw error;}
      const body=JSON.stringify({success:true,result});wire.response=Math.max(wire.response,Buffer.byteLength(body));
      assert.ok(wire.request<=512*1024);assert.ok(wire.response<=512*1024);return new Response(body);
    }
    if(u.origin===config.identityOrigin){
      if(active&&mode.identityFailure){delete mode.identityFailure;throw new Error('Synthetic lost read acknowledgement');}
      const intent=active?(await checkpoint()).control.publication.intent:f.original.intent;
      return Response.json({release_id:intent.releaseId,code_sha:intent.codeSha,catalog_revision:intent.catalogRevision,
        catalog_snapshot_sha256:intent.catalogSnapshotSha256,manifest_sha256:intent.manifestSha256});
    }
    if(url===`${base}/vectorize/v2/indexes/${scope.indexName}`)return response({name:scope.indexName,config:{dimensions:1536,metric:'cosine'}});
    if(u.pathname.endsWith('/get_by_ids')){counts.nativeReads++;const ids=JSON.parse(init.body).ids;
      const result=ids.flatMap(id=>{const v=f.index.get(id);return v?[`{"id":${JSON.stringify(id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':n).join(',')}],"metadata":${JSON.stringify(v.metadata)}}`]:[];});
      return new Response(`{"success":true,"result":[${result.join(',')}]}`);}
    if(u.pathname.includes('/vectorize/')){counts.nativeWrites++;assert.fail('Same-catalog publication must not mutate native state');}
    const c=(await checkpoint())?.control?.publication;
    if(url===`${worker}/assets-upload-session`||u.pathname===`/client/v4/accounts/${accountId}/workers/assets/upload`){counts.uploadHttp++;return response({jwt:'fixture-only',buckets:[]});}
    if(u.pathname.endsWith('/versions')&&init.method==='POST'){counts.uploadHttp++;uploaded=true;return response({id:version});}
    if(u.pathname.endsWith('/versions'))return response({items:uploaded?[{id:version}]:[]});
    if(url===`${worker}/versions/${version}`)return response({id:version,annotations:{'workers/tag':c.uploadMarker,'workers/message':`package:${c.packageSha256}`},
      resources:{script_runtime:{compatibility_date:config.compatibilityDate},bindings:[{name:'DB',type:'d1',id:databaseId},
        {name:'VECTORIZE',type:'vectorize',index_name:scope.indexName},{name:'ASSETS',type:'assets'},{name:'STAGING_AUTH_SECRET',type:'secret_text'},
        ...Object.entries(uploadedConfig.vars).map(([name,text])=>({name,type:'plain_text',text}))]}});
    if(url===`${worker}/deployments`){
      if(init.method==='POST'){counts.activations++;assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'activating');active=true;return response({id:deployment});}
      return response({deployments:[{id:active?deployment:uuid(74),versions:[{version_id:active?version:priorVersion,percentage:100}],
        annotations:{'workers/message':active?c.deploymentMarker:'fixture:original'}}]});
    }assert.fail('Unexpected local provider-mock route');
  };
  const fetchScope={accountId,workerName:config.workerName,indexName:scope.indexName,databaseId,identityOrigin:config.identityOrigin};
  const transports=async()=>{
    const db=await createCatalogD1Rest({accountId,databaseId,databaseName:config.database.name,token:'FIXTURE_ONLY',fetch:raw,
      limits:{requests:800,statements:1200},accounting:{scope:{accountId,databaseId,databaseName:config.database.name},
        initial:await workspace.budget(),reserve:input=>workspace.reserveBudget(input),settle:(id,value)=>workspace.settleBudget(id,value)}});
    return{db,fetch:accountedPublicationFetch(workspace,raw,fetchScope),observationFetch:accountedPublicationReadFetch(workspace,raw,fetchScope)};
  };
  let io=await transports();const owner=await claimMutationOwnership(io.db,scope,
    {phase:'freezing',ownerReference:'published-new-code',operationKey:publishedCatalogOperationKey(f.published)});
  const nativeAdapter=createVectorizeRestAdapters({...scope,accountId,token:'FIXTURE_ONLY',fetch:io.observationFetch});
  await readPublishedCatalogVectors({db:io.db,owner,published:f.published,adapters:nativeAdapter});
  const queued=await enqueueBuildRequest(io.db,f.published.request);
  await workspace.writeCheckpoint(null,{phase:'freezing',owner,state:{driverState:'preserved'},pins:{},phaseComplete:null,control:{}});
  const build=async command=>{
    if(command.args.includes('scripts/staging/build.mts')){
      counts.builds++;const snapshot=JSON.parse(await fs.readFile(command.env.CATALOG_SNAPSHOT_PATH));assert.deepEqual(snapshot,f.revision.snapshot);
      const context=JSON.parse(await fs.readFile(command.env.CATALOG_RELEASE_CONTEXT_PATH)),bytes=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value));
      const pages=['/','/random-gift','/gift-guides','/howie','/preview/presentation',...guides.map(g=>`/gift-guides/${g.slug}`),...snapshot.products.map(p=>`/gifts/${p.slug}`)];
      const assets=new Map(pages.map(p=>[p==='/'?'/index.html':`${p}.html`,bytes('Owned synthetic HTML')]));
      for(const n of ['/safe/catalog.html','/safe/product.html','/safe/howie.html','/safe/presentation.html','/safe/asset.txt'])assets.set(n,bytes('Owned unavailable'));
      assets.set('/safe/catalog.json',bytes(safeCatalogPayload));for(const s of ['.txt','/__next._full.txt','/__next._tree.txt','/__next.safe.product.__PAGE__.txt'])assets.set(`/safe/product${s}`,bytes('Owned safe RSC'));
      for(const shard of createBrowseRelease(snapshot).shards)assets.set(shard.path,bytes(shard.payload));
      for(const name of createOgRelease(snapshot,siteIdentityFor(context.sourceMode)).byPath.keys())assets.set(name,bytes('Owned PNG fixture'));
      const assembled=assembleReleaseAssets(snapshot,assets,context,null),rest={...context};delete rest.retainedManifestSha256;
      manifest={...rest,dataKind:'catalog',siteIdentitySha256:sha256(siteIdentityBytes(context.sourceMode)),nextExpiry:deadline,productCount:8,slugCount:8,
        checksums:Object.fromEntries([...assembled.assets].map(([p,b])=>[p,sha256(b)])),routes:assembled.routes,retention:assembled.retention};
      const manifestBytes=bytes(`${JSON.stringify(manifest,null,2)}\n`),outputs={'asset-manifest.json':manifestBytes,'catalog.snapshot.json':bytes(`${JSON.stringify(snapshot)}\n`),
        'release-context.json':bytes(`${JSON.stringify(context)}\n`),'release-identity.json':bytes(createReleaseIdentity(manifestBytes)),
        'site-identity.json':bytes(siteIdentityBytes(context.sourceMode)),'feed-plan.json':bytes(createStaticFeedPlan(snapshot,context.catalogSnapshotSha256))};
      for(const [n,b]of Object.entries(outputs))await put(path.join(sourceRoot,'build/stupid-gifts',n),b);
      for(const [n,b]of assembled.assets)await put(path.join(sourceRoot,'static-site/out',n.slice(1)),b);
    }else if(command.args.includes('upload')){
      counts.uploads++;assert.equal(command.file,'/usr/bin/sandbox-exec');uploadedConfig=JSON.parse(await fs.readFile(command.args[command.args.indexOf('--config')+1]));
      assert.equal(uploadedConfig.name,config.workerName);assert.equal(uploadedConfig.routes,undefined);assert.ok((await checkpoint()).pins.publicationUploadPending);
      const endpoint=command.env.CLOUDFLARE_API_BASE_URL;assert.equal(new URL(endpoint).hostname,'127.0.0.1');
      for(const route of [`/accounts/${accountId}/workers/scripts/${config.workerName}/assets-upload-session`,
        `/accounts/${accountId}/workers/assets/upload?base64=true`,`/accounts/${accountId}/workers/scripts/${config.workerName}/versions?bindings_inherit=strict`]){
        const reply=await fetch(`${endpoint}${route}`,{method:'POST',body:'{}'});assert.equal(reply.status,200);await reply.arrayBuffer();}
    }
  };
  const command=()=>accountedPublicationUploadCommand({workspace,scope:{accountId,workerName:config.workerName},send:raw,command:build});
  return{...f,counts,wire,mode,async execute(){const cp=await checkpoint();return executePublication({db:io.db,owner:cp.owner,revision:f.revision,published:f.published,
    requestId:queued.requestId,runReference:'published-new-code',workspace,config,credentials:{cloudflareToken:'FIXTURE_ONLY',identityAuthorization:'Basic FIXTURE_ONLY'},
    dependencies:{fetch:io.fetch,observationFetch:io.observationFetch,command:command(),now:f.now}});},
    async reopen(){const expectedManifestSha256=workspace.manifestSha256;await workspace.close();workspace=await openRunWorkspace({...wsOptions,mode:'resume',expectedManifestSha256});io=await transports();},
    async rejectCompletion(binding,revision=f.revision){const c=(await checkpoint()).control.publication;let reads=0;
      await assert.rejects(completeActivatedPublication(io.db,revision,c.publication,c.permit,async()=>{reads++;return c.intent;},f.now,binding),/publication_activation_fenced/);
      assert.equal(reads,0);assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='published-new-code'").get().n,0);},
    budget:()=>workspace.budget(),checkpoint,
    unchanged(){assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM products ORDER BY id').all()),frozenProducts);
      assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM catalog_vector_deliveries ORDER BY delivery_id').all()),frozenJournals);
      assert.equal(native(),frozenNative);assert.equal(f.dispatches(),sourceDispatches);assert.equal(counts.nativeWrites,0);}};
}
for(const fault of ['none','read','expired'])test(`actual accounted same-catalog publisher ${fault==='expired'?'resumes after expired publication lease':fault==='read'?'restarts after lost read ACK':'publishes'} without source/native writes`,{skip:process.platform!=='darwin'},async t=>{
  const f=await composition(t);if(fault!=='none')f.mode.identityFailure=true;
  const originalRevisionSha=sha256(canonicalJson(f.revision));
  let result=await f.execute();if(fault!=='none'){assert.equal(result.state,'pending');assert.equal(f.counts.activations,1);assert.equal(f.counts.uploads,1);
    f.unchanged();if(fault==='expired'){
      f.advance(16*60000);const c=(await f.checkpoint()).control.publication;
      assert.ok(c.publication.leaseUntil<f.now().toISOString());assert.ok(f.revision.snapshot.products.every(p=>p.eligibleUntil>f.now().toISOString()));
      assert.notEqual(f.revision.operationKey,c.permit.mutationOwner.operationKey);
    }
    const before={...f.counts};await f.reopen();assert.equal(f.counts.http,before.http+2);
    if(fault==='expired'){
      // Default completion still refuses the original/new ownership mismatch.
      await f.rejectCompletion(undefined);
      for(const change of [b=>{b.source.deliverySha256='0'.repeat(64);},b=>{b.request.cutoff=at(5*3600000);}]){
        const binding=structuredClone(f.published);change(binding);await f.rejectCompletion(binding);
      }
      for(const drift of ['journalDrift','receiptDrift']){f.mode[drift]=true;await f.rejectCompletion(f.published);delete f.mode[drift];}
      await f.rejectCompletion(f.published,{...f.revision,operationKey:(await f.checkpoint()).owner.operationKey});
    }
    result=await f.execute();}
  assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'idle');
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='published-new-code'").get().n,1);f.unchanged();
  const counts={...f.counts};assert.equal((await f.execute()).state,'published');assert.equal(f.counts.uploads,counts.uploads);assert.equal(f.counts.activations,counts.activations);
  assert.equal(sha256(canonicalJson(f.revision)),originalRevisionSha);
  const budget=await f.budget();assert.equal(budget.httpRequests,f.counts.http);assert.equal(budget.sqlStatements,f.counts.sql);assert.equal(budget.unconfirmedRequests,fault==='none'?0:1);
  assert.ok(budget.httpRequests<=800);assert.ok(budget.sqlStatements<=1200);assert.equal(f.counts.uploadHttp,3);assert.equal(f.counts.builds,1);
  t.diagnostic(JSON.stringify({scope:'LOCAL same-catalog actual executor/accounting/protected-upload MOCK only',...budget,wire:f.wire,...f.counts}));
});
