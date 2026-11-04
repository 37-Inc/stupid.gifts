import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { executePublication, validatePublicationConfig } from '../scripts/catalog/publish-release.ts';
import { accountedPublicationUploadCommand, PublicationUploadCommandError } from '../scripts/catalog/publication-upload-command.ts';
import { createProjectionPacket, importPublicProjection } from '../lib/catalog/d1.ts';
import { enqueueBuildRequest, claimBuildRequest, beginBuildActivation } from '../lib/catalog/build-requests.ts';
import { readUnstartedBuildRecovery,encodeReviewedUploadActivationApproval } from '../lib/catalog/build-requests.ts';
import { enqueuePublication, claimPublication, recordPublicationDispatch, completePublication, completeActivatedPublication } from '../lib/catalog/publication.ts';
import { claimMutationOwnership, readMutationOwner } from '../lib/catalog/mutation-fence.ts';
import { prunedVectorPlan } from '../lib/catalog/prune-existing-revision.ts';
import { canonicalJson } from '../scripts/catalog/migration.ts';
import { createReleaseIdentity } from '../scripts/staging/release-identity.mts';
import { siteIdentityBytes } from '../scripts/staging/build.mts';
import { assembleReleaseAssets, readPriorRelease } from '../scripts/staging/retention.mts';
import { createStaticFeedPlan } from '../workers/site/feed.ts';
import { encodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';
import { readActivatedCatalogVectors } from '../scripts/catalog/owned-vector-delivery.ts';
import { createBrowseRelease } from '../static-site/lib/browse.ts';
import { createOgRelease } from '../static-site/lib/og.ts';
import { siteIdentityFor } from '../static-site/lib/site-identity.ts';
import { guides } from '../static-site/lib/guides.ts';
import { nativeHash } from '../scripts/catalog/vector-outbox.ts';
import { openRunWorkspace } from '../scripts/catalog/run-workspace.ts';
import { createCatalogD1Rest } from '../scripts/catalog/d1-write-rest.ts';
import { accountedPublicationFetch, accountedPublicationReadFetch } from '../scripts/catalog/publication-read-fetch.ts';
import {readOnlyUploadEvidence,readOnlyTransportEvidence} from '../scripts/catalog/upload-preflight-proof.ts';
import { readOwnedLogicalRows } from '../scripts/catalog/owned-operational-import.ts';
import safeCatalogPayload from '../static-site/public/safe/catalog.json' with {type:'json'};

const AT=Date.parse('2026-10-19T12:00:00.000Z');
const sha=value=>createHash('sha256').update(value).digest('hex');
const bytes=value=>Buffer.from(typeof value==='string'?value:JSON.stringify(value));
const id='00000000-0000-4000-8000-000000000001',version='00000000-0000-4000-8000-000000000002',deployment='00000000-0000-4000-8000-000000000003';
const priorVersion='00000000-0000-4000-8000-000000000004',priorDeployment='00000000-0000-4000-8000-000000000005';
const scope={environment:'staging',indexName:'fixture-index'};
async function put(file,value){await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,value,{mode:0o600});}
function fixtureRelease(snapshot,context,prior=null){
  const pages=['/','/random-gift','/gift-guides','/howie','/preview/presentation',...guides.map(g=>`/gift-guides/${g.slug}`),
    ...snapshot.products.map(p=>`/gifts/${p.slug}`)];
  const assets=new Map(pages.map(p=>[p==='/'?'/index.html':`${p}.html`,bytes('Owned fixture HTML')]));
  for(const name of ['/safe/catalog.html','/safe/product.html','/safe/howie.html','/safe/presentation.html','/safe/asset.txt'])assets.set(name,bytes('Owned unavailable'));
  assets.set('/safe/catalog.json',bytes(safeCatalogPayload));
  for(const suffix of ['.txt','/__next._full.txt','/__next._tree.txt','/__next.safe.product.__PAGE__.txt'])assets.set(`/safe/product${suffix}`,bytes('Owned safe RSC'));
  for(const shard of createBrowseRelease(snapshot).shards)assets.set(shard.path,bytes(shard.payload));
  for(const name of createOgRelease(snapshot,siteIdentityFor(context.sourceMode)).byPath.keys())assets.set(name,bytes('owned PNG fixture'));
  const assembled=assembleReleaseAssets(snapshot,assets,context,prior);const rest={...context};delete rest.retainedManifestSha256;
  const manifest={...rest,dataKind:'catalog',siteIdentitySha256:sha(siteIdentityBytes(context.sourceMode)),nextExpiry:snapshot.products[0]?.eligibleUntil??null,
    productCount:snapshot.products.length,slugCount:snapshot.products.length,checksums:Object.fromEntries([...assembled.assets].map(([p,b])=>[p,sha(b)])),
    routes:assembled.routes,retention:assembled.retention};
  const manifestBytes=bytes(`${JSON.stringify(manifest,null,2)}\n`);
  const outputs={'asset-manifest.json':manifestBytes,'catalog.snapshot.json':bytes(`${JSON.stringify(snapshot)}\n`),'release-context.json':bytes(`${JSON.stringify(context)}\n`),
    'release-identity.json':bytes(createReleaseIdentity(manifestBytes)),'site-identity.json':bytes(siteIdentityBytes(context.sourceMode)),
    'feed-plan.json':bytes(createStaticFeedPlan(snapshot,context.catalogSnapshotSha256))};
  const intent={releaseId:manifest.releaseId,codeSha:manifest.codeSha,catalogRevision:manifest.catalogRevision,catalogSnapshotSha256:manifest.catalogSnapshotSha256,
    manifestSha256:sha(manifestBytes),vectorSyncWatermark:manifest.vectorSyncWatermark,priorReleaseId:manifest.priorReleaseId,nextExpiry:manifest.nextExpiry};
  return{...assembled,manifest,manifestBytes,outputs,intent};
}
async function setup(t,{real=false,prior=true,identityOnlyPrior=false,environment='staging',semanticSearch,publicAnalytics,priorExpiryMs=26*3600000,retentionMs=5*60000,cutoffMs=25*3600000}={}){
  const scope={environment,indexName:'fixture-index'},sourceMode=environment==='staging'?'preview':'goose-production';
  let actualWorkspace;
  const directory=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'goose-publish-')));t.after(async()=>{
    await actualWorkspace?.close();await fs.rm(directory,{recursive:true,force:true});});
  const sourceRoot=path.join(directory,'source');await fs.mkdir(sourceRoot);
  const git=(...args)=>execFileSync('git',args,{cwd:sourceRoot,encoding:'utf8'}).trim();
  git('init','-q');await put(path.join(sourceRoot,'.gitignore'),'build/\nstatic-site/out/\n');git('add','.gitignore');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Owned fixture');const codeSha=git('rev-parse','HEAD');
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of (await fs.readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())sql.exec(await fs.readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  let clock=AT;sql.function('strftime',(format,instant)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return new Date(clock).toISOString();});
  let afterBatch;const db={providerIdentity:`cloudflare:${'a'.repeat(32)}:${id}`,prepare(query){let params=[];return{query,bind(...values){params=values;return this;},
    async all(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},async run(){const r=sql.prepare(query).run(...params);return{success:true,meta:{changes:r.changes}};},
    execute(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};}};},async batch(statements){let results;sql.exec('BEGIN');try{results=statements.map(s=>s.execute());sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}afterBatch?.(statements);return results;}};
  const product={id:'B000000001',publicId:id,slug:'owned-clockwork-spoon',title:'Owned clockwork spoon',description:'Controlled owned fixture.',
    imageUrl:'https://example.invalid/owned.svg',affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=fixture-20',source:'amazon',currency:'USD',price:0,
    editorialWriteup:'Controlled owned editorial.',isActive:true,qualityScore:.8,eligibleUntil:new Date(AT+26*3600000).toISOString()};
  const rights=Object.fromEntries(['title','description','imageUrl','affiliateUrl','editorialWriteup'].map(field=>[field,{basis:'owned',reference:'test-only-owned',value:product[field]}]));
  sql.prepare(`INSERT INTO products(id,public_id,slug,source,title,currency,quality_score,is_active,editorial_status,availability_status,
    availability_checked_at,source_facts_hash,editorial_source_hash,catalog_revision,eligible_until,public_display_json,rights_json,source_record_json,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(product.id,id,product.slug,product.source,product.title,product.currency,.8,1,'generated_ready','IN_STOCK',
      new Date(AT).toISOString(),'f'.repeat(64),'f'.repeat(64),'fixture-revision',product.eligibleUntil,JSON.stringify(product),JSON.stringify(rights),'{}',new Date(AT).toISOString());
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:'fixture-revision',generatedAt:new Date(AT).toISOString(),products:[product],heldProducts:[],slugHistory:[]};
  let priorConfig=null,priorRelease;
  if(prior){
    const priorSnapshot={...snapshot,catalogRevision:'fixture-prior',products:snapshot.products.map(p=>({...p,eligibleUntil:new Date(AT+priorExpiryMs).toISOString()}))};
    sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run(priorSnapshot.catalogRevision,snapshot.generatedAt,'c'.repeat(64),'reconciled');
    const priorPacket=await createProjectionPacket(priorSnapshot,{[id]:'f'.repeat(64)},'c'.repeat(64),new Date(AT));await importPublicProjection(db,priorPacket);
    priorRelease=fixtureRelease(priorSnapshot,{schemaVersion:1,sourceMode,releaseId:'fixture-prior-release',codeSha,catalogRevision:priorSnapshot.catalogRevision,
      catalogSnapshotSha256:priorPacket.receipt.snapshot_sha256,generatedAt:snapshot.generatedAt,vectorSyncWatermark:0,priorReleaseId:null,retainedManifestSha256:null});
    const priorDirectory=path.join(directory,'prior');
    for(const [name,b]of Object.entries(priorRelease.outputs))await put(path.join(priorDirectory,name),b);
    for(const [name,b]of priorRelease.assets)await put(path.join(priorDirectory,'assets',name.slice(1)),b);
    await enqueuePublication(db,priorSnapshot,priorRelease.intent,new Date(AT));const claim=await claimPublication(db,priorSnapshot,priorRelease.intent.releaseId,new Date(AT));
    await recordPublicationDispatch(db,priorSnapshot,claim,`version:${priorVersion}`,new Date(AT));
    await completePublication(db,priorSnapshot,priorRelease.intent.releaseId,claim.token,async()=>priorRelease.intent,()=>new Date(AT));
    priorConfig={directory:identityOnlyPrior?null:priorDirectory,manifestSha256:sha(priorRelease.manifestBytes),releaseId:priorRelease.intent.releaseId,versionReference:priorVersion};
  }
  sql.prepare('INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,?)').run(snapshot.catalogRevision,snapshot.generatedAt,'b'.repeat(64),'reconciled');
  const packet=await createProjectionPacket(snapshot,{[id]:'f'.repeat(64)},'b'.repeat(64),new Date(AT));await importPublicProjection(db,packet);
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const owner=await claimMutationOwnership(db,scope,{phase:'freezing',ownerReference:'fixture-run',operationKey:'d'.repeat(64)});
  const current={...sql.prepare('SELECT * FROM products WHERE public_id=?').get(id)};
  const sourceRow={...current,approved_product_json:canonicalJson(current),...Object.fromEntries(['id','public_id','source','availability_checked_at','last_verified_at']
    .map(key=>[`archived_${key}`,JSON.parse(current.source_record_json)[key]??null]))};
  const revision={request:{previous:snapshot,scope},snapshot,packet,sourceRows:[sourceRow],
    sourceDigest:'b'.repeat(64),operationKey:owner.operationKey,vectorSyncWatermark:0,globalVectorWatermark:0};const plan=prunedVectorPlan(revision);
  const vector={id,values:Array(1536).fill(Math.fround(.1)),metadata:{catalogRevision:snapshot.catalogRevision,sourceFactsHash:'f'.repeat(64)}};vector.values[0]=-0;
  vector.metadata.vectorBytesSha256=nativeHash(vector.values);
  sql.prepare(`INSERT INTO catalog_vector_deliveries(delivery_id,environment,index_name,generation,prior_epoch,owner_json,request_json,product_json,
    status,disposition,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run('a'.repeat(64),scope.environment,scope.indexName,owner.generation,0,JSON.stringify(owner),
      canonicalJson({kind:'prune',publicId:id,catalogRevision:snapshot.catalogRevision,projectionReceipt:packet.receipt,planSha256:sha(canonicalJson(plan)),providerIdentity:`cloudflare:${'a'.repeat(32)}:${scope.indexName}`,
        vector:{id,metadata:vector.metadata,nativeBase64:encodePgvectorSendBase64(vector.values)}}),'{}','complete','verified',snapshot.generatedAt);
  const request={schemaVersion:1,environment,sourceRevision:snapshot.catalogRevision,sourceDigest:packet.receipt.snapshot_sha256,codeSha,priorReleaseId:priorConfig?.releaseId??null,
    capturedAt:snapshot.generatedAt,cutoff:new Date(AT+cutoffMs).toISOString()};let {requestId}=await enqueueBuildRequest(db,request);
  const config={schemaVersion:1,environment,accountId:'a'.repeat(32),workerName:'fixture-worker',database:{id,name:'fixture-db'},indexName:scope.indexName,codeSha,
    sourceMode,sourceRoot,releaseId:'fixture-release',identityOrigin:environment==='staging'?'https://fixture-worker.example.invalid':siteIdentityFor(sourceMode).origin,
    compatibilityDate:'2026-10-19',prior:priorConfig,...(semanticSearch===undefined?{}:{semanticSearch}),...(publicAnalytics===undefined?{}:{publicAnalytics})};
  let checkpoint={sha256:'0'.repeat(64),phase:'freezing',owner,state:{driverState:'preserved'},pins:{phase:'b'.repeat(64)},phaseComplete:null,control:{}};
  let workspace={directory:path.join(directory,'workspace'),repository:await fs.realpath(sourceRoot),manifest:{codeSha},async assertHeld(){
    if(checkpoint.control.publication?.stage==='published'&&mode.resolveDelayMs){const ms=mode.resolveDelayMs;delete mode.resolveDelayMs;await new Promise(resolve=>setTimeout(resolve,ms));}
  },assertScope(s){assert.deepEqual(s,{accountId:config.accountId,environment,databaseId:id,
    databaseName:'fixture-db',workerName:'fixture-worker',indexName:scope.indexName});},async readCheckpoint(options){const copy=structuredClone(checkpoint);if(options?.controlOnly)delete copy.state;
      const {sha256,...value}=copy;return{sha256,checkpoint:value};},
    async writeCheckpoint(expected,value){assert.equal(expected,checkpoint.sha256);checkpoint={...structuredClone(value),sha256:sha(canonicalJson(value))};},
    async writeControlCheckpoint(expected,value){assert.equal(expected,checkpoint.sha256);checkpoint={...checkpoint,...structuredClone(value)};checkpoint.sha256=sha(canonicalJson(checkpoint));},
    async putArtifact(value){return{sha256:sha(canonicalJson(value)),reference:'publication/fixture'};},
    async preparePublicationDirectories(){},async cleanPublicationBuild(){}};
  let workspaceOptions;
  const wrapActual=()=>({...actualWorkspace,async writeCheckpoint(expected,value){const result=await actualWorkspace.writeCheckpoint(expected,value);checkpoint={...result.checkpoint,sha256:result.sha256};return result;},
    async writeControlCheckpoint(expected,value){const result=await actualWorkspace.writeControlCheckpoint(expected,value);checkpoint={...checkpoint,...result.checkpoint,sha256:result.sha256};return result;}});
  if(real){
    workspaceOptions={directory:path.join(directory,'protected'),repository:sourceRoot,mode:'create',runId:'fixture-run',configSha256:'f'.repeat(64),codeSha,
      scope:{...scope,accountId:config.accountId,databaseId:id,databaseName:'fixture-db',workerName:'fixture-worker'},
      retention:{reviewReference:'test-only/retention',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
        .map(kind=>[kind,{maxAgeMs:retentionMs,notAfter:new Date(AT+48*3600000).toISOString()}]))},
      budgetCaps:{httpRequests:100,sqlStatements:200},now:()=>new Date(clock).toISOString()};
    actualWorkspace=await openRunWorkspace(workspaceOptions);
    const initial={...checkpoint};delete initial.sha256;
    const created=await actualWorkspace.writeCheckpoint(null,{...initial,pins:{}});checkpoint={...created.checkpoint,sha256:created.sha256};
    workspace=wrapActual();
  }
  let uploaded=false,active=false;let uploadCalls=0,activateCalls=0,buildCalls=0,identityCalls=0,versionReads=0,httpCalls=0;let mode={};let manifest;
  let targetVersion=version,activePriorVersion=priorVersion;const uploadedConfigs=[],commandEnvironments=[];
  const command=async command=>{
    commandEnvironments.push({args:[...command.args],env:{...command.env}});
    if(command.args.includes('scripts/staging/build.mts')){
      buildCalls++;const context=JSON.parse(await fs.readFile(command.env.CATALOG_RELEASE_CONTEXT_PATH));
      const assembled=fixtureRelease(snapshot,context,await readPriorRelease(context,command.env.CATALOG_PRIOR_RELEASE_PATH));manifest=assembled.manifest;
      for(const [name,b]of Object.entries(assembled.outputs))await put(path.join(sourceRoot,'build/stupid-gifts',name),b);
      for(const [name,b]of assembled.assets)await put(path.join(sourceRoot,'static-site/out',name.slice(1)),b);
      if(mode.sourceDrift)await put(path.join(sourceRoot,'.gitignore'),'changed');
      if(mode.buildLost){delete mode.buildLost;throw new Error('PRIVATE build interrupted after output');}
    }else if(command.args.includes('upload')){
      uploadCalls++;const cfg=JSON.parse(await fs.readFile(command.args[command.args.indexOf('--config')+1]));assert.equal(cfg.name,config.workerName);
      const base=path.join(workspace.directory,'publication-runtime',config.releaseId);
      const sub=['read-only-retry','read-only-transport'].find(s=>command.env.WRANGLER_LOG_PATH===path.join(base,s,'logs'));
      const runtime=sub?path.join(base,sub):base;
      assert.equal(command.args[command.args.indexOf('--outdir')+1],path.join(runtime,'bundle'));
      assert.equal(command.env.TMPDIR,path.join(runtime,'tmp'));assert.equal(command.env.WRANGLER_LOG_PATH,path.join(runtime,'logs'));
      uploadedConfigs.push(cfg);assert.equal(command.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED,'false');
      assert.equal(command.env.NEXT_PUBLIC_POSTHOG_KEY,undefined);assert.equal(command.env.NEXT_PUBLIC_POSTHOG_HOST,undefined);
      assert.equal(cfg.routes,undefined);assert.equal(cfg.triggers,undefined);uploaded=true;
      if(mode.uploadLost)throw new Error('PRIVATE upload secret');
    }
  };
  const response=result=>Response.json({success:true,result});
  const fetch=async(url,init={})=>{
    httpCalls++;const u=new URL(url);if(u.origin===config.identityOrigin){identityCalls++;if(mode.identityFailure&&active)return new Response('',{status:401});
      assert.equal(init.headers.Authorization,'Basic PRIVATE');return Response.json(active?createReleaseIdentity(bytes(`${JSON.stringify(manifest,null,2)}\n`))
        :mode.servingIdentity??createReleaseIdentity(priorRelease.manifestBytes));}
    if(u.pathname.endsWith(`/d1/database/${id}`))return response({uuid:id,name:'fixture-db',read_replication:{mode:'disabled'}});
    if(u.pathname.endsWith(`/indexes/${scope.indexName}`))return response({name:scope.indexName,config:{dimensions:1536,metric:'cosine'}});
    const c=checkpoint.control.publication;
    if(u.pathname.endsWith('/versions'))return response({items:uploaded&&!mode.versionInvisible?[{id:targetVersion}]:[]});
    if(u.pathname.endsWith(`/versions/${targetVersion}`)){if(++versionReads===3&&mode.stopBeforeActivation)throw new Error('PRIVATE preactivation read interrupted');
      return response({id:targetVersion,annotations:{'workers/tag':c.uploadMarker,'workers/message':`package:${c.packageSha256}`},
      resources:{script_runtime:{compatibility_date:'2026-10-19'},bindings:[{name:'DB',type:'d1',id:mode.wrongVersionDatabase?'wrong':id},
        {name:'VECTORIZE',type:'vectorize',index_name:scope.indexName},{name:'ASSETS',type:'assets'},
        {name:'ENVIRONMENT',type:'plain_text',text:environment},
        ...Object.entries(uploadedConfigs.at(-1)?.vars??{}).filter(([name])=>name.startsWith('SEMANTIC_SEARCH_')&&name!==mode.missingSearchBinding)
          .map(([name,text])=>({name,type:'plain_text',text:mode.searchBinding?.name===name?mode.searchBinding.text:text})),
        ...(!mode.missingGuard?[{name:'STAGING_AUTH_SECRET',type:'secret_text'}]:[])]}});}
    if(u.pathname.endsWith('/get_by_ids')){if(mode.vectorAbortCleanup){return new Promise((_,reject)=>init.signal.addEventListener('abort',()=>setTimeout(()=>{
      mode.vectorCleaned=true;reject(new Error('PRIVATE accounted abort cleanup'));},40),{once:true}));}
      if(mode.vectorFailure)return response([]);const expected=structuredClone(vector);
      // Preserve signed-zero native bytes across the mock REST boundary.
      return new Response(`{"success":true,"result":[{"id":"${id}","values":[${expected.values.map(n=>Object.is(n,-0)?'-0':n).join(',')}],"metadata":${JSON.stringify(expected.metadata)}}]}`,{headers:{'Content-Type':'application/json'}});}
    if(u.pathname.endsWith('/deployments')){
      if(init.method==='POST'){activateCalls++;assert.equal(checkpoint.control.publication.permit.mutationOwner.phase,'activating');
        assert.equal(sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'activating');
        assert.deepEqual(JSON.parse(init.body),{strategy:'percentage',versions:[{version_id:targetVersion,percentage:100}],annotations:{'workers/message':c.deploymentMarker}});
        if(mode.activationNotSent)throw new Error('PRIVATE uncertain not submitted');active=true;
        if(mode.activationLost)throw new Error('PRIVATE activation secret');return response({id:deployment});}
      if(mode.readbackFailure&&active)throw new Error('PRIVATE readback secret');
      return response({deployments:active?[{id:deployment,versions:[{version_id:targetVersion,percentage:100}],annotations:{'workers/message':c.deploymentMarker}}]:
        prior?[{id:priorDeployment,versions:[{version_id:mode.servingVersion??activePriorVersion,percentage:100}],annotations:{'workers/message':'owned fixture prior'}}]:[]});
    }throw new Error(`Unexpected fixture HTTP ${url}`);
  };
  const execute=(database=db,dependencies={},buildRecovery,reviewedUploadRetry,finishAuthorization)=>executePublication({db:database,owner:checkpoint.owner,revision:mode.noRevision?null:revision,requestId,runReference:'fixture-run',workspace,config,
    credentials:{cloudflareToken:'PRIVATE_TOKEN',identityAuthorization:'Basic PRIVATE'},dependencies:{fetch,command,now:()=>new Date(clock),...dependencies},buildRecovery,reviewedUploadRetry,finishAuthorization});
  return{db,sql,owner,revision,fetch,command,get workspace(){return workspace;},config,execute,mode,uploadedConfigs,commandEnvironments,checkpoint:()=>checkpoint,now:()=>new Date(clock),advance(ms){clock+=ms;},after(fn){afterBatch=fn;},
    setServingPrior(){
      const original=priorRelease.intent;
      const s={releaseId:'fixture-code-only',codeSha:'f'.repeat(40),catalogRevision:original.catalogRevision,
        catalogSnapshotSha256:original.catalogSnapshotSha256,manifestSha256:'e'.repeat(64),versionReference:version};
      config.servingPrior=s;mode.servingVersion=s.versionReference;
      mode.servingIdentity={release_id:s.releaseId,code_sha:s.codeSha,catalog_revision:s.catalogRevision,
        catalog_snapshot_sha256:s.catalogSnapshotSha256,manifest_sha256:s.manifestSha256};
    },
    async nextRelease(){
      assert.equal((await readMutationOwner(db,scope)),null);
      const packageDirectory=path.join(workspace.directory,'packages',config.releaseId);
      priorRelease={manifestBytes:await fs.readFile(path.join(packageDirectory,'asset-manifest.json'))};
      config.prior={directory:packageDirectory,manifestSha256:sha(priorRelease.manifestBytes),releaseId:config.releaseId,versionReference:targetVersion};
      activePriorVersion=targetVersion;targetVersion='00000000-0000-4000-8000-000000000006';config.releaseId='fixture-next-release';
      ({requestId}=await enqueueBuildRequest(db,{...request,priorReleaseId:config.prior.releaseId}));
      const nextOwner=await claimMutationOwnership(db,scope,{phase:'freezing',ownerReference:'fixture-next-run',operationKey:'e'.repeat(64)});
      const original=sql.prepare('SELECT * FROM catalog_vector_deliveries').get();
      const delivery={...original,delivery_id:'b'.repeat(64),generation:nextOwner.generation,owner_json:JSON.stringify(nextOwner)};
      const columns=Object.keys(delivery);sql.prepare(`INSERT INTO catalog_vector_deliveries(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`)
        .run(...columns.map(name=>delivery[name]));
      checkpoint={...checkpoint,sha256:'0'.repeat(64),phase:'freezing',owner:nextOwner,state:{driverState:'preserved'},control:{}};
      if(real){
        await actualWorkspace.close();workspaceOptions={...workspaceOptions,runId:'fixture-next-run'};
        actualWorkspace=await openRunWorkspace(workspaceOptions);
        const {sha256:unused,...initial}=checkpoint;void unused;
        const saved=await actualWorkspace.writeCheckpoint(null,{...initial,pins:{}});checkpoint={...saved.checkpoint,sha256:saved.sha256};
        workspace=wrapActual();
      }
      uploaded=false;active=false;versionReads=0;
    },
    async historicalAccepted({lostPermit=false}={}){
      // A pre-guard first deployment, established through the real publication
      // and activation transactions. No new executor work is used to seed it.
      assert.equal(config.prior,null);
      const build=await claimBuildRequest(db,requestId,'fixture-run',new Date(AT));
      const release=fixtureRelease(snapshot,{schemaVersion:1,sourceMode:'preview',releaseId:config.releaseId,codeSha,catalogRevision:snapshot.catalogRevision,
        catalogSnapshotSha256:packet.receipt.snapshot_sha256,generatedAt:snapshot.generatedAt,vectorSyncWatermark:0,priorReleaseId:null,retainedManifestSha256:null});
      manifest=release.manifest;await enqueuePublication(db,snapshot,release.intent,new Date(AT));
      const publication=await claimPublication(db,snapshot,config.releaseId,new Date(AT));
      await recordPublicationDispatch(db,snapshot,publication,`version:${version}`,new Date(AT));
      const permit=await beginBuildActivation(db,build,snapshot,publication,version,async()=>({environment:'staging',settled:true,active:null}),new Date(AT),owner);
      const c={schemaVersion:1,configSha256:sha(canonicalJson(config)),requestId,runReference:'fixture-run',stage:'activating',build,publication,intent:release.intent,
        permit:lostPermit?null:permit,vectorPlan:{catalogRevision:plan.catalogRevision,planSha256:sha(canonicalJson(plan)),ids:[id]},packageSha256:'e'.repeat(64),
        uploadMarker:'historical-upload',versionReference:version,deploymentMarker:'historical-deployment',deploymentId:null};
      checkpoint={...checkpoint,owner:lostPermit?owner:permit.mutationOwner,control:{publication:c},state:{...checkpoint.state,publication:c}};
      active=true;
      await completePublication(db,snapshot,config.releaseId,publication.token,async()=>release.intent,()=>new Date(AT),permit.mutationOwner);
    },
    async reopen({controlOnly=false}={}){const expectedManifestSha256=actualWorkspace.manifestSha256;await actualWorkspace.close();
      actualWorkspace=await openRunWorkspace({...workspaceOptions,mode:'resume',expectedManifestSha256});workspace=wrapActual();
      const saved=await actualWorkspace.readCheckpoint({controlOnly});checkpoint={...saved.checkpoint,sha256:saved.sha256};},
    counts:()=>({uploadCalls,activateCalls,buildCalls,identityCalls,httpCalls}),vector};
}

test('actual build/upload/activate/identity/native-proof/receipt/idle composition with preserved driver state',async t=>{
  const f=await setup(t);const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(result.owner,null);assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().buildCalls,1);
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'resolved');assert.equal(await readMutationOwner(f.db,scope),null);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
  assert.equal(f.checkpoint().state.driverState,'preserved');assert.doesNotMatch(JSON.stringify(f.checkpoint()),/PRIVATE|example.invalid|clockwork spoon/);
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().activateCalls,1);
});

test('code-only serving prior retains the real catalog receipt through publication',async t=>{
  const f=await setup(t,{identityOnlyPrior:true});f.setServingPrior();
  const result=await f.execute();
  assert.equal(result.state,'published',JSON.stringify(result));
  const receipt=f.sql.prepare('SELECT manifest_json FROM publication_receipts WHERE release_id=?').get(f.config.releaseId);
  assert.equal(JSON.parse(receipt.manifest_json).priorReleaseId,f.config.prior.releaseId);
  assert.equal(f.counts().activateCalls,1);
});

test('code-only serving prior has a strict immutable deployment identity',async t=>{
  const f=await setup(t,{identityOnlyPrior:true});f.setServingPrior();
  assert.deepEqual(validatePublicationConfig(f.config).servingPrior,f.config.servingPrior);
  for(const change of [{extra:true},{releaseId:''},{codeSha:'bad'},{manifestSha256:'bad'},
    {catalogSnapshotSha256:'bad'},{versionReference:'not-a-uuid'}])
    assert.throws(()=>validatePublicationConfig({...f.config,servingPrior:{...f.config.servingPrior,...change}}),/publication_configuration_invalid/);
  assert.throws(()=>validatePublicationConfig({...f.config,prior:null}),/publication_configuration_invalid/);
});

test('changed code-only storefront fails before build or upload',async t=>{
  const f=await setup(t,{identityOnlyPrior:true});f.setServingPrior();
  f.mode.servingIdentity={...f.mode.servingIdentity,manifest_sha256:'8'.repeat(64)};
  const result=await f.execute();
  assert.equal(result.state,'pending');
  assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
});

async function stoppedClaim(t,{real=true}={}){
  const f=await setup(t,{real,retentionMs:3600000});
  assert.equal((await f.execute(f.db,{command:async()=>{throw new Error('Local build stopped before output');}})).state,'pending');
  assert.equal(f.checkpoint().control.publication.stage,'claimed');
  assert.deepEqual(f.counts(),{uploadCalls:0,activateCalls:0,buildCalls:0,identityCalls:0,httpCalls:2});
  return{f,old:structuredClone(f.checkpoint().control.publication.build)};
}
async function stoppedBuilt(t,{real=true,retentionMs=3600000,cutoffMs}={}){
  const f=await setup(t,{real,retentionMs,cutoffMs}),clean=f.workspace.cleanPublicationBuild;
  f.workspace.cleanPublicationBuild=async()=>{throw new Error('Local cleanup stopped before upload');};
  assert.equal((await f.execute()).state,'pending');f.workspace.cleanPublicationBuild=clean;
  const control=f.checkpoint().control.publication;assert.equal(control.stage,'built');assert.match(control.packageSha256,/^[a-f0-9]{64}$/);
  assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
  return{f,old:structuredClone(control.build),packageSha256:control.packageSha256,
    packageDirectory:path.join(f.workspace.directory,'packages',f.config.releaseId)};
}
test('sealed built package resumes with only exact expired lease reclaimed, without rebuilding or changing package',async t=>{
  for(const expired of [false,true])await t.test(expired?'expired':'unexpired',async t=>{
    const {f,old,packageSha256}=await stoppedBuilt(t),products=canonicalJson(f.sql.prepare('SELECT * FROM products').all());
    if(expired)f.advance(11*60000);await f.reopen();
    const result=await f.execute(f.db,{command:async command=>{
      const saved=f.checkpoint().control.publication,row=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
      assert.equal(row.lease_token,saved.build.token);assert.equal(saved.packageSha256,packageSha256);
      assert.equal(row.attempts,expired?2:1);assert.equal(saved.build.token===old.token,!expired);
      assert.deepEqual(saved.build.request,old.request);if(expired)assert.equal(Date.parse(saved.build.leaseUntil),AT+26*60000);
      await f.command(command);
    }});
    assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.counts().buildCalls,1);
    assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);assert.equal(await readMutationOwner(f.db,scope),null);
    assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM products').all()),products);
  });
});
test('cleanup that consumes the build lease reclaims before the sole upload',async t=>{
  const f=await setup(t,{real:true,retentionMs:3600000}),clean=f.workspace.cleanPublicationBuild;
  let cleaned=false;f.workspace.cleanPublicationBuild=async(...args)=>{await clean(...args);if(!cleaned){cleaned=true;f.advance(11*60000);}};
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,2);
  assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.equal(await readMutationOwner(f.db,scope),null);
});
test('expired built reclaim validates package and rejects owner, dispatch, external pins and receipt drift before claim',async t=>{
  const faults={
    package:async({packageDirectory})=>fs.appendFile(path.join(packageDirectory,'assets/index.html'),'unsealed bytes'),
    'package hash':({f})=>{f.checkpoint().control.publication.packageSha256='0'.repeat(64);},
    revision:({f})=>{f.revision.snapshot.products[0].title='Unapproved replacement';},
    watermark:({f})=>{f.revision.vectorSyncWatermark++;},
    owner:({f})=>f.sql.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run(),
    token:({f})=>f.sql.prepare('UPDATE catalog_build_requests SET lease_token=?').run(version),
    dispatch:({f})=>f.sql.prepare("UPDATE catalog_build_requests SET dispatch_reference='unknown-dispatch'").run(),
    exhausted:({f})=>f.sql.prepare('UPDATE catalog_build_requests SET attempts=3').run(),
    'control version':({f})=>{f.checkpoint().control.publication.versionReference=version;},
    'control receipt':({f})=>{f.checkpoint().control.publication.receiptSha256='0'.repeat(64);},
    ...Object.fromEntries(['publicationUploadPending','publicationUploadAcknowledged','publicationUploadReview'].map(pin=>[pin,({f})=>{
      f.checkpoint().pins[pin]={sha256:'0'.repeat(64),reference:'objects/test-only.json'};
    }])),
    outbox:({f})=>f.sql.prepare(`INSERT INTO publication_outbox SELECT ?,?,catalog_revision,intent_json,state,lease_token,lease_until,
      attempts,dispatch_reference,completed_token,error_code,created_at,updated_at FROM publication_outbox LIMIT 1`)
      .run('e'.repeat(64),f.config.releaseId),
    receipt:({f})=>f.sql.prepare(`INSERT INTO publication_receipts SELECT ?,catalog_revision,code_sha,completed_at,manifest_json
      FROM publication_receipts LIMIT 1`).run(f.config.releaseId)
  };
  for(const [name,mutate]of Object.entries(faults))await t.test(name,async t=>{
    const context=await stoppedBuilt(t,{real:false}),{f}=context;f.advance(11*60000);await mutate(context);
    const before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},result=await f.execute();
    assert.equal(result.state,'pending');assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
    assert.deepEqual({...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},before);
  });
});
test('built replacement checkpoint ACK loss reopens exact same package without another claim or upload',async t=>{
  const {f,old,packageSha256}=await stoppedBuilt(t);f.advance(11*60000);await f.reopen();
  let lost=false;const write=f.workspace.writeCheckpoint;f.workspace.writeCheckpoint=async(expected,value)=>{
    const result=await write(expected,value);
    if(!lost&&value.control?.publication?.stage==='built'&&value.control.publication.build.token!==old.token){lost=true;throw new Error('Local committed checkpoint ACK lost');}
    return result;
  };
  assert.equal((await f.execute()).state,'pending');assert.equal(lost,true);assert.equal(f.counts().uploadCalls,0);
  await f.reopen();assert.equal(f.checkpoint().control.publication.packageSha256,packageSha256);
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,2);
  assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});
test('claimed build reclaims only expired lease, persists replacement before commands, and keeps unexpired claim unchanged',async t=>{
  for(const expired of [false,true])await t.test(expired?'expired':'unexpired',async t=>{
    const {f,old}=await stoppedClaim(t),products=canonicalJson(f.sql.prepare('SELECT * FROM products').all());
    if(expired)f.advance(11*60000);await f.reopen();
    const result=await f.execute(f.db,{command:async command=>{
      const saved=f.checkpoint().control.publication.build,row=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
      assert.equal(row.lease_token,saved.token);assert.equal(canonicalJson(JSON.parse(row.request_json)),canonicalJson(old.request));
      assert.equal(row.attempts,expired?2:1);assert.equal(saved.token===old.token,!expired);
      if(expired)assert.equal(Date.parse(saved.leaseUntil),AT+26*60000);
      await f.command(command);
    }});
    assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
    assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'resolved');
    assert.equal(await readMutationOwner(f.db,scope),null);assert.equal(canonicalJson(f.sql.prepare('SELECT * FROM products').all()),products);
  });
});
test('claimed build recovers exact claim ACK loss and durable checkpoint ACK loss without another attempt',async t=>{
  for(const fault of ['claim','checkpoint'])await t.test(fault,async t=>{
    const {f,old}=await stoppedClaim(t);f.advance(11*60000);await f.reopen();let lost=false;
    if(fault==='claim')f.after(statements=>{
      if(!lost&&statements.some(s=>s.query.includes("SET state='building',lease_token="))){lost=true;throw new Error('Local committed claim ACK lost');}
    });
    else{const write=f.workspace.writeCheckpoint;f.workspace.writeCheckpoint=async(expected,value)=>{
      const result=await write(expected,value);
      if(!lost&&value.control?.publication?.stage==='claimed'&&value.control.publication.build.token!==old.token){lost=true;throw new Error('Local committed checkpoint ACK lost');}
      return result;
    };}
    let result=await f.execute();assert.equal(lost,true);
    if(fault==='checkpoint'){
      assert.equal(result.state,'pending');assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);
      assert.notEqual(f.checkpoint().control.publication.build.token,old.token);await f.reopen();result=await f.execute();
    }
    assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,2);
    assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  });
});
test('claimed replacement cannot build/upload before durable checkpoint; pre-write failure stays fenced on reopen',async t=>{
  const {f,old}=await stoppedClaim(t);f.advance(11*60000);await f.reopen();
  const write=f.workspace.writeCheckpoint;f.workspace.writeCheckpoint=async(expected,value)=>{
    if(value.control?.publication?.build.token!==old.token)throw new Error('Local checkpoint not persisted');
    return write(expected,value);
  };
  assert.equal((await f.execute()).state,'pending');assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);
  assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,2);
  await f.reopen();const result=await f.execute();assert.equal(result.errorCode,'publication_build_reclaim_fenced');
  assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,2);assert.equal(f.counts().buildCalls,0);
});
test('claimed lease reclaim refuses owner/build/control/dispatch drift, exhausted attempts and later stages',async t=>{
  const faults={
    owner:f=>f.sql.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run(),
    token:f=>f.sql.prepare('UPDATE catalog_build_requests SET lease_token=?').run(version),
    run:f=>f.sql.prepare("UPDATE catalog_build_requests SET run_reference='another-run'").run(),
    lease:f=>f.sql.prepare('UPDATE catalog_build_requests SET lease_until=?').run(new Date(AT+10*60000+1).toISOString()),
    request:f=>{f.checkpoint().control.publication.build.request.sourceDigest='0'.repeat(64);},
    exhausted:f=>f.sql.prepare('UPDATE catalog_build_requests SET attempts=3').run(),
    dispatch:f=>f.sql.prepare("UPDATE catalog_build_requests SET dispatch_reference='unknown-dispatch'").run(),
    package:f=>{f.checkpoint().control.publication.packageSha256='0'.repeat(64);},
    version:f=>{f.checkpoint().control.publication.versionReference=version;},
    intent:f=>{f.checkpoint().control.publication.intent={};},
    receipt:f=>{f.checkpoint().control.publication.receiptSha256='0'.repeat(64);},
    ...Object.fromEntries(['built','uploading','uploaded','activating'].map(stage=>[stage,f=>{f.checkpoint().control.publication.stage=stage;}]))
  };
  for(const [name,mutate]of Object.entries(faults))await t.test(name,async t=>{
    const {f}=await stoppedClaim(t,{real:false});f.advance(11*60000);mutate(f);
    const before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},result=await f.execute();
    assert.equal(result.state,'pending');assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
    assert.deepEqual({...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},before);
  });
});
test('claimed reclaim refuses a foreign replacement or owner drift during the bounded claim',async t=>{
  for(const fault of ['token','owner'])await t.test(fault,async t=>{
    const {f}=await stoppedClaim(t);f.advance(11*60000);let changed=false;
    f.after(statements=>{if(!changed&&statements.some(s=>s.query.includes("SET state='building',lease_token="))){changed=true;
      if(fault==='token')f.sql.prepare('UPDATE catalog_build_requests SET lease_token=?').run(version);
      else f.sql.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run();
    }});
    const result=await f.execute();assert.equal(changed,true);assert.equal(result.state,'pending');
    assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
  });
});
test('durable claimed/built checkpoint exception refuses other control/owner/pin/lease changes and control-only reconciliation',async t=>{
  for(const stage of ['claimed','built'])for(const fault of ['phase','owner','pin','request','stage','version','package','same-token','cutoff','control-only'])await t.test(`${stage}/${fault}`,async t=>{
    const {f}=await(stage==='claimed'?stoppedClaim(t):stoppedBuilt(t)),view=await f.workspace.readCheckpoint(),next=structuredClone(view.checkpoint),c=next.control.publication;
    c.build.token=version;c.build.leaseUntil=new Date(AT+25*60000).toISOString();
    if(fault==='phase')next.phase='attention';
    if(fault==='owner')next.owner.epoch++;
    if(fault==='pin')next.pins.extra=await f.workspace.putArtifact({fixture:'only technical control'},{kind:'phase',observedAt:new Date(AT).toISOString()});
    if(fault==='request')c.build.request.cutoff=new Date(AT+24*3600000).toISOString();
    if(fault==='stage')c.stage=stage==='claimed'?'built':'uploading';
    if(fault==='version')c.versionReference=version;
    if(fault==='package')c.packageSha256='0'.repeat(64);
    if(fault==='same-token')c.build.token=view.checkpoint.control.publication.build.token;
    if(fault==='cutoff')c.build.leaseUntil=new Date(AT+26*3600000).toISOString();
    if(fault==='control-only')await assert.rejects(f.workspace.writeControlCheckpoint(view.sha256,{phase:'attention',owner:next.owner,control:next.control}),/run_workspace_/);
    else await assert.rejects(f.workspace.writeCheckpoint(view.sha256,next),/run_workspace_/);
    assert.equal((await f.workspace.readCheckpoint()).sha256,view.sha256);assert.equal(f.counts().uploadCalls,0);
  });
});

test('protected upload refusal persists a body-free review gate that resume cannot bypass',async t=>{
  const f=await setup(t,{real:true});
  const result=await f.execute(f.db,{command:async command=>{
    await f.command(command);
    // Even an already-visible immutable version cannot waive the protected
    // uploader's scope/accounting rejection or create activation permission.
    if(command.args.includes('upload'))throw new PublicationUploadCommandError('publication_upload_scope_invalid');
  }});
  assert.equal(result.state,'pending');assert.equal(result.errorCode,'publication_upload_scope_invalid');
  assert.equal(f.checkpoint().phase,'attention');assert.ok(f.checkpoint().pins.publicationUploadReview);
  assert.equal(f.checkpoint().control.publication.stage,'uploading');
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
  const before=f.counts();await f.reopen();
  const retry=await f.execute();assert.equal(retry.state,'pending');assert.equal(retry.errorCode,'publication_upload_review_required');
  assert.deepEqual(f.counts(),before);assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'building');
  assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'freezing');
});

const protectedCommand=(f,run=f.command)=>accountedPublicationUploadCommand({workspace:f.workspace,
  scope:{accountId:f.config.accountId,workerName:f.config.workerName},send:async()=>assert.fail('No remote upload in synthetic command fixture'),command:run});
const protectedMac={skip:process.platform!=='darwin'};

function readOnlyFailureCommand(f){
  return accountedPublicationUploadCommand({workspace:f.workspace,scope:{accountId:f.config.accountId,workerName:f.config.workerName},
    send:async()=>Response.json({success:true,result:{}}),command:async wrapped=>{
      if(!wrapped.args.includes('upload'))return f.command(wrapped);
      for(const suffix of [`/services/${f.config.workerName}`,`/scripts/${f.config.workerName}/secrets`])
        await(await fetch(`${wrapped.env.CLOUDFLARE_API_BASE_URL}/accounts/${f.config.accountId}/workers${suffix}`)).arrayBuffer();
      const log=path.join(wrapped.env.WRANGLER_LOG_PATH,'wrangler-2026-10-19_12-00-00_000.log');
      await fs.mkdir(path.dirname(log),{recursive:true,mode:0o700});await fs.writeFile(log,'Retained original preflight\n',{mode:0o600});
      await fs.writeFile(wrapped.env.WRANGLER_OUTPUT_FILE_PATH,
        JSON.stringify({type:'wrangler-session',log_file_path:log,command_line_args:wrapped.args})+'\n'+
        JSON.stringify({type:'command-failed',message:'fetch failed'})+'\n',{mode:0o600});
      throw Error('Synthetic child exited before POST');
    }});
}
async function readOnlyRetryFixture(t,options={}){
  const f=await setup(t,{real:true,retentionMs:3600000,...options});f.config.releaseId='fixture-run';
  assert.equal((await f.execute(f.db,{command:readOnlyFailureCommand(f)})).errorCode,'publication_upload_command_failed');
  const cp=await f.workspace.readCheckpoint(),proof=await readOnlyUploadEvidence(f.workspace,cp.checkpoint.pins.publicationUploadPending,cp.checkpoint.pins.publicationUploadReview);
  const evidence=await f.workspace.putArtifact(proof,{kind:'publication',observedAt:f.now().toISOString()});
  const c=cp.checkpoint.control.publication,approval={schemaVersion:4,requestId:c.requestId,packageSha256:c.packageSha256,
    configSha256:c.configSha256,checkpointSha256:cp.sha256,reviewPinSha256:cp.checkpoint.pins.publicationUploadReview.sha256,
    evidenceSha256:evidence.sha256,reviewReference:'fixture/exact-two-known-preflight-gets',reviewedAt:f.now().toISOString(),authorizationSha256:sha('direct owner authorization')};
  f.advance(16*60000);const retry={approval,evidence};
  return{f,retry,proof,run:(dependencies={})=>f.execute(f.db,{command:protectedCommand(f),...dependencies},undefined,retry)};
}
test('reviewed v4 real read-only journal proof preserves normal claims, original logs and one upload across replay',protectedMac,async t=>{
  const {f,run}=await readOnlyRetryFixture(t),before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},budget=await f.workspace.budget();
  const log=path.join(f.workspace.directory,'publication-runtime','fixture-run','upload.ndjson'),original=await fs.readFile(log);
  assert.equal(before.attempts,1);assert.equal(before.operator_recovery_json,null);
  const result=await run();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  const after=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
  for(const key of ['request_json','lease_token','run_reference','attempts','operator_recovery_json'])assert.equal(after[key],before[key]);
  assert.deepEqual(await fs.readFile(log),original);assert.deepEqual(await f.workspace.budget(),budget);
  assert.equal(await readMutationOwner(f.db,scope),null);
  await f.reopen();assert.equal((await run()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});

async function transportRetryFixture(t,options={}){
  const {f,run,retry:first}=await readOnlyRetryFixture(t,options);
  assert.equal((await run({command:readOnlyFailureCommand(f)})).errorCode,'publication_upload_command_failed');
  const cp=await f.workspace.readCheckpoint(),previous=cp.checkpoint.pins.publicationUploadRetryPending;
  assert.equal(cp.checkpoint.pins.publicationUploadRetryAcknowledged,undefined);
  const proof=await readOnlyTransportEvidence(f.workspace,previous);
  const evidence=await f.workspace.putArtifact(proof,{kind:'publication',observedAt:f.now().toISOString()});f.advance(1);
  const retry={approval:{...first.approval,checkpointSha256:cp.sha256,evidenceSha256:evidence.sha256,reviewedAt:f.now().toISOString()},evidence,transport:{previous}};
  return{f,retry,proof,previous,run:(dependencies={})=>f.execute(f.db,{command:protectedCommand(f),...dependencies},undefined,retry)};
}
test('transport correction proves both read-only failures, preserves failed markers/claims/logs and publishes exactly once',protectedMac,async t=>{
  const {f,run,previous}=await transportRetryFixture(t),before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()};
  const old=path.join(f.workspace.directory,'publication-runtime','fixture-run','read-only-retry','upload.ndjson'),raw=await fs.readFile(old);
  const result=await run();assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.deepEqual(f.checkpoint().pins.publicationUploadRetryPending,previous);assert.equal(f.checkpoint().pins.publicationUploadRetryAcknowledged,undefined);
  assert.ok(f.checkpoint().pins.publicationUploadTransportAcknowledged);assert.deepEqual(await fs.readFile(old),raw);
  const after=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
  for(const key of ['request_json','lease_token','run_reference','attempts','operator_recovery_json'])assert.equal(after[key],before[key]);
  assert.equal(await readMutationOwner(f.db,scope),null);await f.reopen();assert.equal((await run()).state,'published');assert.equal(f.counts().uploadCalls,1);
});
test('transport genuine ACK can resume without upload; missing ACK, changed evidence and recursive grants stay held',protectedMac,async t=>{
  for(const fault of ['source-proof','unknown-command','evidence','recursive'])await t.test(fault,async t=>{
    const {f,retry,run}=await transportRetryFixture(t);
    if(fault==='evidence')await fs.appendFile(path.join(f.workspace.directory,'publication-runtime','fixture-run','read-only-retry','upload.ndjson'),'\n');
    if(fault==='recursive')retry.transport.previous=f.checkpoint().pins.publicationUploadPending;
    const command=protectedCommand(f,async c=>{await f.command(c);if(c.args.includes('upload')){
      if(fault==='source-proof')f.mode.vectorFailure=true;
      if(fault==='unknown-command')throw Error('Synthetic transport command lost');
    }});
    assert.equal((await run({command})).state,'pending');assert.equal(f.counts().activateCalls,0);
    f.mode.vectorFailure=false;const counts=f.counts();await f.reopen();
    const next=await run();assert.equal(next.state,fault==='source-proof'?'published':'pending',JSON.stringify(next));
    assert.equal(f.counts().uploadCalls,counts.uploadCalls);assert.equal(f.counts().activateCalls,fault==='source-proof'?1:0);
  });
});

test('transport proof refuses any POST, SQL, unknown/unsettled request, third pair or substituted upload ACK',protectedMac,async t=>{
  for(const fault of ['post','sql','unknown','unsettled','third-pair','log-ack'])await t.test(fault,async t=>{
    const {f,previous}=await transportRetryFixture(t),base=`https://api.cloudflare.com/client/v4/accounts/${f.config.accountId}/workers`;
    if(fault==='log-ack')await fs.appendFile(path.join(f.workspace.directory,'publication-runtime','fixture-run','read-only-retry','upload.ndjson'),JSON.stringify({type:'version-upload'})+'\n');
    else for(let i=0;i<(fault==='third-pair'?4:2);i++){
      const requestSha256=sha(i%2?`GET${base}/scripts/${f.config.workerName}/secrets`:fault==='post'?`POST${base}/scripts/${f.config.workerName}/assets-upload-session{}`:`GET${base}/services/${f.config.workerName}`);
      await f.workspace.reserveBudget({id:'injected-'+i,requestSha256,units:{httpRequests:1,sqlStatements:fault==='sql'?1:0}});
      if(fault!=='unsettled')await f.workspace.settleBudget('injected-'+i,fault==='unknown'?{status:'unknown',usage:null}:{status:'known',usage:{rowsRead:0,rowsWritten:0}});
    }
    await assert.rejects(readOnlyTransportEvidence(f.workspace,previous),/publication_preflight_proof_invalid/);
    assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
  });
});

test('fresh bounded finish authority activates an acknowledged version after the old cutoff without upload or claim renewal',protectedMac,async t=>{
  const {f,retry,run}=await transportRetryFixture(t,{retentionMs:27*3600000});
  const command=protectedCommand(f,async c=>{await f.command(c);if(c.args.includes('upload'))f.mode.vectorFailure=true;});
  assert.equal((await run({command})).state,'pending');f.mode.vectorFailure=false;
  const before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},counts=f.counts();
  f.advance(25*3600000);
  const finish={authorizationSha256:'a'.repeat(64),reviewedAt:f.now().toISOString(),
    activationDeadline:new Date(f.now().getTime()+15*60000).toISOString(),versionReference:f.checkpoint().control.publication.versionReference};
  const result=await f.execute(f.db,{command:protectedCommand(f)},undefined,retry,finish);
  assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.counts().uploadCalls,counts.uploadCalls);
  assert.equal(f.counts().activateCalls,1);const after=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
  for(const key of ['request_json','lease_token','run_reference','attempts','operator_recovery_json'])assert.equal(after[key],before[key]);
});

test('slow same-owner native proof stays outside the short reviewed deployment observation',protectedMac,async t=>{
  const {f,run}=await transportRetryFixture(t),timer=globalThis.setTimeout;let shortened=false,proved=0;
  t.mock.method(globalThis,'setTimeout',(callback,ms,...args)=>{
    if(ms===30000&&!shortened){shortened=true;return timer(callback,200,...args);}
    return timer(callback,ms,...args);
  });
  const fetch=async(url,init)=>{
    if(new URL(url).pathname.endsWith('/get_by_ids')&&!f.checkpoint().control.publication.permit){proved++;await new Promise(resolve=>timer(resolve,700));}
    return f.fetch(url,init);
  };
  const result=await run({fetch});assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(shortened,true);assert.ok(proved>0);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});
test('reviewed v4 refuses stale live prior, changed evidence and lost command acknowledgement without a second upload',protectedMac,async t=>{
  for(const fault of ['prior','evidence','ack'])await t.test(fault,async t=>{
    const {f,run}=await readOnlyRetryFixture(t);
    if(fault==='evidence')await fs.appendFile(path.join(f.workspace.directory,'publication-runtime','fixture-run','upload.ndjson'),'\n');
    const fetch=async(url,init)=>fault==='prior'&&new URL(url).pathname.endsWith('/deployments')
      ?Response.json({success:true,result:{deployments:[]}}):f.fetch(url,init);
    const command=protectedCommand(f,async c=>{await f.command(c);if(c.args.includes('upload'))throw Error('Synthetic retry ACK lost');});
    const result=await run(fault==='ack'?{command}:{fetch});assert.equal(result.state,'pending');assert.equal(f.counts().activateCalls,0);
    assert.equal(f.counts().uploadCalls,fault==='ack'?1:0);
    const before=f.counts();await f.reopen();assert.equal((await run(fault==='prior'?{fetch}:{})).state,'pending');
    for(const key of ['buildCalls','uploadCalls','activateCalls'])assert.equal(f.counts()[key],before[key]);
  });
});

async function legacyPreflightPending(t,{bindingPatch={},exhausted=false,fixtureOptions}={}){
  const context=await stoppedBuilt(t,fixtureOptions),{f}=context;
  if(exhausted){const clean=f.workspace.cleanPublicationBuild;f.workspace.cleanPublicationBuild=async()=>{throw new Error('Local cleanup still interrupted');};
    for(const ms of [11*60000,16*60000]){f.advance(ms);assert.equal((await f.execute()).state,'pending');}
    f.workspace.cleanPublicationBuild=clean;assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,3);
  }
  const c=f.checkpoint().control.publication;context.old=structuredClone(c.build);
  // Exact retained old-code boundary: built package, no publication yet; the
  // old executor pinned this binding before its read-only enqueue preflight.
  const binding={schemaVersion:1,releaseId:f.config.releaseId,requestId:c.requestId,configSha256:sha(canonicalJson(f.config)),
    packageSha256:c.packageSha256,uploadMarker:c.uploadMarker,...bindingPatch};
  const pending=await f.workspace.putArtifact(binding,{kind:'publication',observedAt:f.now().toISOString()});
  const current=await f.workspace.readCheckpoint();
  await f.workspace.writeCheckpoint(current.sha256,{...current.checkpoint,pins:{...current.checkpoint.pins,publicationUploadPending:pending}});
  return{...context,pending,binding};
}
async function operatorRecoveryFixture(t,fixtureOptions){
  const context=await legacyPreflightPending(t,{exhausted:true,fixtureOptions}),{f}=context;f.advance(16*60000);
  const current=await f.workspace.readCheckpoint(),c=current.checkpoint.control.publication;
  const approval={schemaVersion:1,requestId:c.requestId,packageSha256:c.packageSha256,previousToken:c.build.token,
    checkpointSha256:current.sha256,reviewReference:'fixture/explicit-one-operator-attempt'};
  return{...context,approval};
}
async function reviewedRetryFixture(t,{expired=true,deadlineExtension=false}={}){
  const {f,approval:buildRecovery}=await operatorRecoveryFixture(t,deadlineExtension?{cutoffMs:90*60000,retentionMs:4*3600000}:undefined),base=`https://api.cloudflare.com/client/v4/accounts/${f.config.accountId}`;
  const kinds=['service','secrets','assets-upload-session'],paths=[`/workers/services/${f.config.workerName}`,`/workers/scripts/${f.config.workerName}/secrets`,
    `/workers/scripts/${f.config.workerName}/assets-upload-session`];
  const command=accountedPublicationUploadCommand({workspace:f.workspace,scope:{accountId:f.config.accountId,workerName:f.config.workerName},
    send:async url=>{if(url.endsWith('assets-upload-session'))throw new Error('Synthetic old session response interrupted');return Response.json({success:true,result:{}});},
    command:async wrapped=>{if(!wrapped.args.includes('upload'))return f.command(wrapped);
      for(let i=0;i<3;i++)await(await fetch(`${wrapped.env.CLOUDFLARE_API_BASE_URL}/accounts/${f.config.accountId}${paths[i]}`,
        {method:i===2?'POST':'GET',...(i===2?{body:'{}'}:{})})).arrayBuffer();}});
  const stopped=await f.execute(f.db,{command},buildRecovery);assert.equal(stopped.errorCode,'publication_upload_unknown');
  assert.equal(f.checkpoint().control.publication.stage,'uploading');assert.equal(f.counts().uploadCalls,0);if(expired)f.advance(16*60000);
  const evidenceValue={schemaVersion:1,kind:'metadata-only-session-failure',logSha256:sha('synthetic retained log'),
    requests:kinds.map((kind,i)=>({kind,requestSha256:sha(`${i===2?'POST':'GET'}${base}${paths[i]}${i===2?'{}':''}`),settlement:i===2?'unknown':'known'})),
    assetContentRequests:0,versionPosts:0,diagnostic:{intentSha256:sha('synthetic diagnostic intent'),resultSha256:sha('synthetic diagnostic metadata'),
      bodySha256:sha('new canonical manifest'),requestSha256:sha('new canonical request'),status:200,totalBytes:551929,buckets:13,hashes:12524,maxJwtLength:549,errorClass:null}};
  const evidence=await f.workspace.putArtifact(evidenceValue,{kind:'publication',observedAt:f.now().toISOString()}),cp=await f.workspace.readCheckpoint(),c=cp.checkpoint.control.publication;
  const approval={schemaVersion:1,requestId:c.requestId,packageSha256:c.packageSha256,configSha256:c.configSha256,checkpointSha256:cp.sha256,
    reviewPinSha256:cp.checkpoint.pins.publicationUploadReview.sha256,evidenceSha256:evidence.sha256,reviewReference:'fixture/one-reviewed-pre-version-retry'};
  const retry={approval,evidence};return{f,retry,evidenceValue,run:(database=f.db,dependencies={})=>f.execute(database,{command:protectedCommand(f),...dependencies},undefined,retry)};
}
function extendReviewedDeadline(retry,cutoff){
  const priorApproval=structuredClone(retry.approval);retry.priorApproval=priorApproval;
  retry.approval={...priorApproval,schemaVersion:2,reviewReference:'fixture/explicit-deadline-v2',
    priorApprovalSha256:sha(encodeReviewedUploadActivationApproval(priorApproval)),activationDeadline:new Date(Date.parse(cutoff)+90*60000).toISOString()};
}
test('reviewed v2 uses a separate later dispatch deadline, preserves original bytes and resolves after its deadline without another POST',protectedMac,async t=>{
  const {f,retry,run}=await reviewedRetryFixture(t,{deadlineExtension:true}),before=f.sql.prepare('SELECT * FROM catalog_build_requests').get(),
    cutoff=f.checkpoint().control.publication.build.request.cutoff;
  extendReviewedDeadline(retry,cutoff);f.advance(Date.parse(cutoff)-f.now().getTime()+1);f.mode.readbackFailure=true;
  assert.equal((await run()).state,'pending');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.ok(f.checkpoint().control.publication.permit);const after=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
  for(const key of ['request_json','lease_token','run_reference','attempts','operator_recovery_json'])assert.equal(after[key],before[key]);
  const marker=await f.workspace.readArtifact(f.checkpoint().pins.publicationUploadRetryPending);
  assert.deepEqual(marker.approval,retry.approval);assert.deepEqual(marker.priorApproval,retry.priorApproval);
  f.advance(Date.parse(retry.approval.activationDeadline)-f.now().getTime()+1);f.mode.readbackFailure=false;
  await f.reopen();assert.equal((await run()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});
test('reviewed v2 rejects wrong prior, package, checkpoint, expired grant and marked v1 without adopting or retrying',protectedMac,async t=>{
  for(const fault of ['prior','package','checkpoint','expired','marked-v1'])await t.test(fault,async t=>{
    const {f,retry,run}=await reviewedRetryFixture(t,{deadlineExtension:true}),cutoff=f.checkpoint().control.publication.build.request.cutoff;
    if(fault==='marked-v1'){
      const command=protectedCommand(f,async c=>{await f.command(c);if(c.args.includes('upload'))f.mode.vectorFailure=true;});
      assert.equal((await run(f.db,{command})).state,'pending');
      assert.ok(f.checkpoint().pins.publicationUploadRetryAcknowledged);f.mode.vectorFailure=false;
    }
    const counts=f.counts();extendReviewedDeadline(retry,cutoff);
    if(fault==='prior')retry.approval.priorApprovalSha256='0'.repeat(64);
    if(fault==='package')retry.approval.packageSha256='0'.repeat(64);
    if(fault==='checkpoint')retry.approval.checkpointSha256='0'.repeat(64);
    if(fault==='expired')f.advance(Date.parse(retry.approval.activationDeadline)-f.now().getTime());
    assert.equal((await run()).state,'pending');assert.deepEqual(f.counts(),counts);
    if(fault!=='marked-v1')assert.equal(f.checkpoint().pins.publicationUploadRetryPending,undefined);
  });
});
test('reviewed v2 deadline crossing after CAS never authorizes its first POST or resets on reopen',protectedMac,async t=>{
  const {f,retry,run}=await reviewedRetryFixture(t,{deadlineExtension:true}),cutoff=f.checkpoint().control.publication.build.request.cutoff;
  extendReviewedDeadline(retry,cutoff);let applied=false;
  f.after(statements=>{if(!applied&&statements.some(s=>s.query.startsWith("UPDATE publication_outbox SET state='dispatched',dispatch_reference=?"))){
    applied=true;f.advance(Date.parse(retry.approval.activationDeadline)-f.now().getTime());throw new Error('Synthetic ACK lost at v2 deadline');}});
  assert.equal((await run()).state,'pending');assert.equal(applied,true);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
  assert.equal(f.checkpoint().control.publication.stage,'uploaded');await f.reopen({controlOnly:true});
  assert.equal((await run()).state,'pending');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
});
test('reviewed v3 fresh owner authority preserves old grant and reopens marked activation without another POST',protectedMac,async t=>{
  const {f,retry,run}=await reviewedRetryFixture(t,{deadlineExtension:true}),before=f.sql.prepare('SELECT * FROM catalog_build_requests').get(),
    cutoff=f.checkpoint().control.publication.build.request.cutoff,priorApproval=structuredClone(retry.approval),
    reviewedAt=new Date(Date.parse(cutoff)+2*3600000+1).toISOString();
  retry.priorApproval=priorApproval;retry.approval={...priorApproval,schemaVersion:3,reviewReference:'fixture/fresh-authority-v3',
    priorApprovalSha256:sha(encodeReviewedUploadActivationApproval(priorApproval)),reviewedAt,authorizationSha256:sha('synthetic current owner authority'),
    activationDeadline:new Date(Date.parse(reviewedAt)+20*60000).toISOString()};
  f.advance(Date.parse(reviewedAt)-f.now().getTime());f.mode.readbackFailure=true;
  assert.equal((await run()).state,'pending');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  const marker=await f.workspace.readArtifact(f.checkpoint().pins.publicationUploadRetryPending);
  assert.deepEqual(marker.approval,retry.approval);assert.deepEqual(marker.priorApproval,priorApproval);
  const after=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
  for(const key of ['request_json','lease_token','run_reference','attempts','operator_recovery_json'])assert.equal(after[key],before[key]);
  f.advance(Date.parse(retry.approval.activationDeadline)-f.now().getTime()+1);f.mode.readbackFailure=false;
  await f.reopen();assert.equal((await run()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});
test('reviewed metadata-only failure retries once, keeps all original claims/charges, publishes and replays',protectedMac,async t=>{
  const {f,run}=await reviewedRetryFixture(t),before=f.sql.prepare('SELECT * FROM catalog_build_requests').get(),outbox=f.sql.prepare('SELECT * FROM publication_outbox WHERE release_id=?').get(f.config.releaseId);
  const pins=structuredClone(f.checkpoint().pins),budget=await f.workspace.budget();
  let checked=false;f.after(statements=>{if(statements.some(s=>s.query.startsWith("UPDATE publication_outbox SET state='dispatched',dispatch_reference=?"))){checked=true;
    const u=f.sql.prepare('SELECT * FROM publication_outbox WHERE release_id=?').get(f.config.releaseId);
    assert.equal(u.lease_until,outbox.lease_until);assert.equal(u.lease_token,outbox.lease_token);assert.equal(u.attempts,outbox.attempts);}});
  const result=await run();assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  const after=f.sql.prepare('SELECT * FROM catalog_build_requests').get(),u=f.sql.prepare('SELECT * FROM publication_outbox WHERE release_id=?').get(f.config.releaseId);
  assert.equal(after.attempts,3);assert.equal(after.operator_recovery_json,before.operator_recovery_json);assert.equal(after.lease_token,before.lease_token);
  assert.equal(checked,true);assert.equal(u.completed_token,outbox.lease_token);assert.equal(u.attempts,outbox.attempts);
  assert.deepEqual(f.checkpoint().pins.publicationUploadReview,pins.publicationUploadReview);assert.deepEqual(f.checkpoint().pins.publicationUploadPending,pins.publicationUploadPending);
  assert.ok(f.checkpoint().pins.publicationUploadRetryAcknowledged);assert.ok(f.checkpoint().pins.reviewedUploadActivationPending);assert.deepEqual(await f.workspace.budget(),budget);
  await f.reopen();assert.equal((await run()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});
test('reviewed retry unknown command or ACK loss never resends even when version is visible',protectedMac,async t=>{
  for(const fault of ['command','ack'])await t.test(fault,async t=>{
    const {f,run}=await reviewedRetryFixture(t);if(fault==='ack'){const write=f.workspace.writeCheckpoint;
      f.workspace.writeCheckpoint=async(expected,value)=>{if(value.pins.publicationUploadRetryAcknowledged)throw new Error('Synthetic ACK prewrite failure');return write(expected,value);};}
    const command=protectedCommand(f,async c=>{await f.command(c);if(fault==='command'&&c.args.includes('upload'))throw new Error('Synthetic command result lost');});
    assert.equal((await run(f.db,{command})).state,'pending');assert.ok(f.checkpoint().pins.publicationUploadRetryPending);
    assert.equal(f.checkpoint().pins.publicationUploadRetryAcknowledged,undefined);const counts=f.counts(),budget=await f.workspace.budget();
    await f.reopen();assert.equal((await run()).state,'pending');assert.deepEqual(f.counts(),counts);assert.deepEqual(await f.workspace.budget(),budget);
  });
});
test('reviewed activation marker distinguishes first POST from unknown CAS and normal activating reconciliation',protectedMac,async t=>{
  for(const fault of ['cas-not-applied','cas-ack-lost','permit-prewrite','permit-ack-lost','read-failure'])await t.test(fault,async t=>{
    const {f,run}=await reviewedRetryFixture(t);let cas=0,stopped=false;
    const database={...f.db,async batch(statements){if(!statements.some(s=>s.query.startsWith("UPDATE publication_outbox SET state='dispatched',dispatch_reference=?")))return f.db.batch(statements);
      cas++;if(fault==='cas-not-applied')throw new Error('Synthetic CAS not applied');const r=await f.db.batch(statements);
      if(fault==='cas-ack-lost')throw new Error('Synthetic CAS ACK lost');return r;}};
    if(fault.startsWith('permit')){const write=f.workspace.writeCheckpoint;f.workspace.writeCheckpoint=async(expected,value)=>{
      if(!stopped&&value.control.publication.permit){stopped=true;if(fault==='permit-ack-lost')await write(expected,value);throw new Error('Synthetic permit checkpoint lost');}
      return write(expected,value);};}
    const command=protectedCommand(f,async c=>{await f.command(c);if(fault==='read-failure'&&c.args.includes('upload'))f.mode.vectorFailure=true;});
    const first=await run(database,{command});
    if(fault==='cas-ack-lost'){assert.equal(first.state,'published');assert.equal(cas,1);assert.equal(f.counts().activateCalls,1);return;}
    assert.equal(first.state,'pending');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
    if(fault==='read-failure'){assert.equal(f.checkpoint().pins.reviewedUploadActivationPending,undefined);f.mode.vectorFailure=false;}
    else assert.ok(f.checkpoint().pins.reviewedUploadActivationPending);
    const budget=await f.workspace.budget();await f.reopen();const result=await run(database);
    assert.equal(result.state,['permit-prewrite','read-failure'].includes(fault)?'published':'pending');
    assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,['permit-prewrite','read-failure'].includes(fault)?1:0);
    assert.equal(cas,1);assert.deepEqual(await f.workspace.budget(),budget);
  });
});
test('reviewed retry rejects altered approval/evidence, foreign3+1 proof, current/native drift and prior visible version before retry upload',protectedMac,async t=>{
  for(const fault of ['checkpoint','review','evidence','attempts','missing-operator','foreign-operator','lease','source','native','version'])await t.test(fault,async t=>{
    const {f,retry,run}=await reviewedRetryFixture(t,{expired:fault!=='lease'});
    if(fault==='checkpoint')retry.approval.checkpointSha256='0'.repeat(64);
    if(fault==='review')retry.approval.reviewPinSha256='0'.repeat(64);
    if(fault==='evidence')retry.approval.evidenceSha256='0'.repeat(64);
    if(fault==='attempts')f.sql.exec('UPDATE catalog_build_requests SET attempts=2');
    if(fault.includes('operator')){f.sql.exec('DROP TRIGGER catalog_build_operator_recovery_immutable');
      f.sql.exec(fault==='missing-operator'?'UPDATE catalog_build_requests SET operator_recovery_json=NULL':
        `UPDATE catalog_build_requests SET operator_recovery_json=json_set(operator_recovery_json,'$.owner.token','foreign')`);}
    if(fault==='source')f.sql.exec('UPDATE products SET is_active=0');if(fault==='native')f.mode.vectorFailure=true;
    const fetch=fault==='version'?async(url,init)=>{if(new URL(url).pathname.endsWith('/versions'))return Response.json({success:true,result:{items:[{id:version}]}});
      return f.fetch(url,init);}:f.fetch;
    assert.equal((await run(f.db,{fetch})).state,'pending');assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
    assert.equal(f.checkpoint().pins.publicationUploadRetryPending,undefined);
  });
});
test('reviewed retry never sends a first activation POST at or beyond original cutoff after exact CAS readback',protectedMac,async t=>{
  const {f,run}=await reviewedRetryFixture(t);let applied=false;
  f.after(statements=>{if(!applied&&statements.some(s=>s.query.startsWith("UPDATE publication_outbox SET state='dispatched',dispatch_reference=?"))){
    applied=true;f.advance(Date.parse(f.checkpoint().control.publication.build.request.cutoff)-f.now().getTime());throw new Error('Synthetic ACK lost at cutoff');}});
  assert.equal((await run()).state,'pending');assert.equal(applied,true);assert.equal(f.counts().activateCalls,0);
  assert.equal(f.checkpoint().control.publication.stage,'uploaded');await f.reopen({controlOnly:true});assert.equal((await run()).state,'pending');
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
});
test('explicit operator recovery records3 normal plus1 operator, preserves all24 tables and frozen approval across reopen',protectedMac,async t=>{
  const {f,old,pending,approval}=await operatorRecoveryFixture(t),before=await readOwnedLogicalRows(f.db,f.owner,{phase:'freezing'});
  for(let i=0;i<3;i++){await f.workspace.reserveBudget({id:`proven-read-${i}`,requestSha256:sha(`SELECT fixture${i}`),units:{httpRequests:1,sqlStatements:1}});
    await f.workspace.settleBudget(`proven-read-${i}`,{status:'unknown',usage:null});}
  const budget=await f.workspace.budget(),write=f.workspace.writeCheckpoint;let stopped=false;
  f.workspace.writeCheckpoint=async(expected,value)=>{const result=await write(expected,value);
    if(!stopped&&value.control?.publication?.build.token!==old.token){stopped=true;throw new Error('Local recovered checkpoint ACK lost');}return result;};
  const run=()=>f.execute(f.db,{command:protectedCommand(f)},approval);
  assert.equal((await run()).state,'pending');assert.equal(stopped,true);assert.equal(f.counts().uploadCalls,0);
  const after=await readOwnedLogicalRows(f.db,f.owner,{phase:'freezing'}),row=f.sql.prepare('SELECT * FROM catalog_build_requests').get();
  const receipt=JSON.parse(row.operator_recovery_json),target=before.catalog_build_requests.find(r=>r.request_id===approval.requestId);
  assert.equal(row.attempts,3);assert.equal(receipt.normalAttempts,3);assert.equal(receipt.operatorAttempts,1);assert.equal(receipt.totalAttempts,4);
  assert.deepEqual(receipt.approval,approval);assert.deepEqual(receipt.previous,target);assert.notEqual(row.lease_token,old.token);
  assert.equal(Date.parse(row.lease_until),f.now().getTime()+15*60000);assert.equal(receipt.token,row.lease_token);
  for(const table of Object.keys(before))if(table!=='catalog_build_requests')assert.deepEqual(after[table],before[table]);
  assert.deepEqual({...row,lease_token:target.lease_token,lease_until:target.lease_until,operator_recovery_json:null},target);
  assert.throws(()=>f.sql.prepare('UPDATE catalog_build_requests SET operator_recovery_json=NULL').run(),/immutable/);
  assert.throws(()=>f.sql.prepare('DELETE FROM catalog_build_requests WHERE request_id=?').run(approval.requestId),/immutable/);
  assert.throws(()=>f.sql.prepare('UPDATE catalog_build_requests SET attempts=4').run(),/CHECK/);
  await f.reopen();assert.notEqual((await f.workspace.readCheckpoint()).sha256,approval.checkpointSha256);
  assert.deepEqual(f.checkpoint().pins.publicationUploadPending,pending);assert.deepEqual(await f.workspace.budget(),budget);
  assert.equal((await run()).state,'published');assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.equal(f.sql.prepare('SELECT operator_recovery_json FROM catalog_build_requests').get().operator_recovery_json,row.operator_recovery_json);
  assert.equal((await run()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.deepEqual(await f.workspace.budget(),budget);
});
test('operator recovery resolves only exact immutable receipt after committed grant ACK loss; foreign token stays fenced',protectedMac,async t=>{
  for(const foreign of [false,true])await t.test(foreign?'foreign':'exact',async t=>{
    const {f,approval}=await operatorRecoveryFixture(t);let lost=false;
    f.after(statements=>{if(!lost&&statements.some(s=>s.query.includes('SET lease_token=?,lease_until=?,operator_recovery_json=?'))){lost=true;
      if(foreign)f.sql.prepare('UPDATE catalog_build_requests SET lease_token=?').run(version);throw new Error('Local committed recovery ACK lost');}});
    const result=await f.execute(f.db,{command:protectedCommand(f)},approval);assert.equal(lost,true);
    assert.equal(result.state,foreign?'pending':'published');assert.equal(f.counts().uploadCalls,foreign?0:1);assert.equal(f.counts().activateCalls,foreign?0:1);
    assert.equal(f.sql.prepare('SELECT attempts FROM catalog_build_requests').get().attempts,3);
  });
});
test('operator recovery dispatch marker survives reopen and never resends an unknown or undispatched grant',protectedMac,async t=>{
  for(const fault of ['grant-not-applied','grant-applied-ack-lost','marker-ack-lost'])await t.test(fault,async t=>{
    const {f,old,approval}=await operatorRecoveryFixture(t);let grantWrites=0,checkpointLost=false;
    const database={...f.db,async batch(statements){
      if(!statements.some(s=>s.query.includes('SET lease_token=?,lease_until=?,operator_recovery_json=?')))return f.db.batch(statements);
      grantWrites++;
      await f.workspace.reserveBudget({id:'unknown-operator-grant',requestSha256:sha('synthetic operator grant'),units:{httpRequests:1,sqlStatements:1}});
      await f.workspace.settleBudget('unknown-operator-grant',{status:'unknown',usage:null});
      if(fault==='grant-applied-ack-lost')await f.db.batch(statements);
      throw new Error('Local operator grant ACK lost');
    }};
    const write=f.workspace.writeCheckpoint;f.workspace.writeCheckpoint=async(expected,value)=>{
      const result=await write(expected,value);
      if(!checkpointLost&&(fault==='marker-ack-lost'&&value.pins.buildOperatorRecoveryPending
        ||fault==='grant-applied-ack-lost'&&value.control.publication.build.token!==old.token)){
        checkpointLost=true;throw new Error('Local recovery checkpoint ACK lost');
      }return result;
    };
    const run=()=>f.execute(database,{command:protectedCommand(f)},approval);
    assert.equal((await run()).state,'pending');assert.equal(f.counts().uploadCalls,0);
    const marker=f.checkpoint().pins.buildOperatorRecoveryPending,budget=await f.workspace.budget();assert.ok(marker);
    assert.equal(grantWrites,fault==='marker-ack-lost'?0:1);
    await f.reopen();
    if(fault==='grant-not-applied'){
      assert.equal((await f.execute(database,{command:protectedCommand(f)})).state,'pending');
      assert.equal((await f.execute(database,{command:protectedCommand(f)},{...approval,reviewReference:'fixture/changed-review'})).state,'pending');
      assert.equal(grantWrites,1);
    }
    const result=await run();assert.equal(result.state,fault==='grant-applied-ack-lost'?'published':'pending');
    assert.equal(grantWrites,fault==='marker-ack-lost'?0:1);assert.deepEqual(f.checkpoint().pins.buildOperatorRecoveryPending,marker);
    assert.deepEqual(await f.workspace.budget(),budget);assert.equal(f.counts().uploadCalls,fault==='grant-applied-ack-lost'?1:0);
    if(fault!=='grant-applied-ack-lost')assert.equal(f.sql.prepare('SELECT operator_recovery_json FROM catalog_build_requests').get().operator_recovery_json,null);
  });
});
test('operator recovery refuses missing approval, reanchoring, duplicate grant, elapsed lease and atomic owner drift',protectedMac,async t=>{
  for(const fault of ['missing','checkpoint','token','package','request','attempts','outbox','provider','atomic-owner','second'])await t.test(fault,async t=>{
    const {f,old,approval}=await operatorRecoveryFixture(t),grant={...approval};
    if(fault==='checkpoint')grant.checkpointSha256='0'.repeat(64);if(fault==='token')grant.previousToken=version;
    if(fault==='package')grant.packageSha256='0'.repeat(64);if(fault==='request')grant.requestId='0'.repeat(64);
    if(fault==='attempts')f.sql.prepare('UPDATE catalog_build_requests SET attempts=2').run();
    if(fault==='outbox')f.sql.prepare(`INSERT INTO publication_outbox SELECT ?,?,catalog_revision,intent_json,state,lease_token,lease_until,
      attempts,dispatch_reference,completed_token,error_code,created_at,updated_at FROM publication_outbox LIMIT 1`).run('e'.repeat(64),f.config.releaseId);
    if(fault==='atomic-owner')f.sql.exec(`CREATE TRIGGER fixture_operator_aba AFTER UPDATE OF operator_recovery_json ON catalog_build_requests
      WHEN NEW.operator_recovery_json IS NOT NULL BEGIN UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1; END;`);
    if(fault==='second'){
      const write=f.workspace.writeCheckpoint;f.workspace.writeCheckpoint=async(expected,value)=>{
        const result=await write(expected,value);if(value.control?.publication?.build.token!==old.token)throw new Error('Local stop after recovered checkpoint');return result;};
      assert.equal((await f.execute(f.db,{command:protectedCommand(f)},grant)).state,'pending');await f.reopen();f.advance(16*60000);
    }
    const fetch=fault==='provider'?async(url,init)=>new URL(url).pathname.endsWith('/versions')?Response.json({success:true,result:{items:'unknown'}}):f.fetch(url,init):f.fetch;
    const before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},result=await f.execute(f.db,{fetch,command:protectedCommand(f)},fault==='missing'?undefined:grant);
    assert.equal(result.state,'pending');assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
    assert.deepEqual({...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},before);
    if(fault==='atomic-owner')assert.deepEqual(await readMutationOwner(f.db,scope),f.owner);
    if(fault==='second')await assert.rejects(readUnstartedBuildRecovery(f.db,f.checkpoint().control.publication.build,f.owner,f.config.releaseId,grant));
  });
});
test('legacy built preflight pin recovers only an interrupted READ, keeps unknown usage and dispatches once',protectedMac,async t=>{
  const {f,pending}=await legacyPreflightPending(t);let lost=false;
  const database={...f.db,prepare(query){const statement=f.db.prepare(query);
    if(!query.startsWith('SELECT 1 WHERE EXISTS(SELECT 1 FROM catalog_revisions'))return statement;
    const all=statement.all;statement.all=async(...args)=>{
      const result=await all(...args);if(!lost){lost=true;
        await f.workspace.reserveBudget({id:'lost-preflight-read',requestSha256:sha(query),units:{httpRequests:1,sqlStatements:1}});
        await f.workspace.settleBudget('lost-preflight-read',{status:'unknown',usage:null});
        throw new Error('PRIVATE read ACK lost before enqueue');}
      return result;
    };return statement;
  }};
  assert.equal((await f.execute(database,{command:protectedCommand(f)})).state,'pending');assert.equal(lost,true);
  assert.equal(f.checkpoint().control.publication.stage,'built');assert.equal(f.counts().uploadCalls,0);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_outbox WHERE release_id=?').get(f.config.releaseId).n,0);
  const budget=await f.workspace.budget(),pinBytes=await fs.readFile(path.join(f.workspace.directory,pending.reference));
  assert.equal(budget.unconfirmedRequests,1);await f.reopen();
  const result=await f.execute(f.db,{command:protectedCommand(f)});assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.deepEqual(f.checkpoint().pins.publicationUploadPending,pending);assert.deepEqual(await f.workspace.budget(),budget);
  assert.deepEqual(await fs.readFile(path.join(f.workspace.directory,pending.reference)),pinBytes);
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().uploadCalls,1);
});
test('legacy preflight pin refuses ambiguity, expiry, changed package/owner and existing D1 publication before dispatch',protectedMac,async t=>{
  const faults=['pin','ack','review','uploading','expired','package','revision','owner','outbox','receipt','provider-hit','provider-error','provider-bound','owner-during-read','outbox-during-read'];
  for(const fault of faults)await t.test(fault,async t=>{
    const {f,pending,binding,packageDirectory}=await legacyPreflightPending(t,{bindingPatch:fault==='pin'?{releaseId:'wrong-release'}:{}});
    const addOutbox=()=>f.sql.prepare(`INSERT INTO publication_outbox SELECT ?,?,catalog_revision,intent_json,state,lease_token,lease_until,
      attempts,dispatch_reference,completed_token,error_code,created_at,updated_at FROM publication_outbox LIMIT 1`).run('e'.repeat(64),f.config.releaseId);
    if(['ack','review','uploading'].includes(fault)){
      const current=await f.workspace.readCheckpoint(),next=structuredClone(current.checkpoint);
      if(fault==='uploading')next.control.publication.stage='uploading';
      else{const value=fault==='ack'?{...binding,pending}:{schemaVersion:1,code:'publication_upload_unknown'};
        const ref=await f.workspace.putArtifact(value,{kind:'publication',observedAt:new Date(AT).toISOString()});
        next.pins[fault==='ack'?'publicationUploadAcknowledged':'publicationUploadReview']=ref;}
      await f.workspace.writeCheckpoint(current.sha256,next);
    }
    if(fault==='expired')f.advance(11*60000);
    if(fault==='package')await fs.appendFile(path.join(packageDirectory,'assets/index.html'),'unsealed bytes');
    if(fault==='revision')f.revision.snapshot.products[0].title='Unapproved replacement';
    if(fault==='owner')f.sql.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run();
    if(fault==='outbox')addOutbox();
    if(fault==='receipt')f.sql.prepare(`INSERT INTO publication_receipts SELECT ?,catalog_revision,code_sha,completed_at,manifest_json
      FROM publication_receipts LIMIT 1`).run(f.config.releaseId);
    let changed=false;
    const fetch=async(url,init)=>{const pathname=new URL(url).pathname;
      if(pathname.endsWith('/versions')){
        if(fault==='provider-error')throw new Error('PRIVATE lookup unavailable');
        if(fault==='provider-hit')return Response.json({success:true,result:{items:[{id:version}]}});
        if(fault==='provider-bound')return Response.json({success:true,result:{items:Array.from({length:10},()=>({id:version}))}});
        if(!changed&&fault.endsWith('-during-read')){changed=true;
          if(fault==='owner-during-read')f.sql.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run();else addOutbox();}
      }
      if(pathname.endsWith(`/versions/${version}`))return Response.json({success:true,result:{id:version,
        annotations:{'workers/tag':fault==='provider-hit'?f.checkpoint().control.publication.uploadMarker:'different-marker'}}});
      return f.fetch(url,init);
    };
    const before={...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},result=await f.execute(f.db,{fetch,command:protectedCommand(f)});
    assert.equal(result.state,'pending');assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
    assert.deepEqual({...f.sql.prepare('SELECT * FROM catalog_build_requests').get()},before);
    assert.deepEqual(f.checkpoint().pins.publicationUploadPending,pending);
  });
});
test('new preflight READ failure leaves no upload pin; retry can perform the first upload',protectedMac,async t=>{
  const {f}=await stoppedBuilt(t);let lost=false;
  const database={...f.db,prepare(query){const statement=f.db.prepare(query);
    if(!query.startsWith('SELECT 1 WHERE EXISTS(SELECT 1 FROM catalog_revisions'))return statement;
    const all=statement.all;statement.all=async(...args)=>{const result=await all(...args);if(!lost){lost=true;throw new Error('PRIVATE preflight read failed');}return result;};
    return statement;
  }};
  assert.equal((await f.execute(database,{command:protectedCommand(f)})).state,'pending');assert.equal(lost,true);
  assert.equal(f.checkpoint().control.publication.stage,'built');assert.equal(f.checkpoint().pins.publicationUploadPending,undefined);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_outbox WHERE release_id=?').get(f.config.releaseId).n,0);
  await f.reopen();assert.equal((await f.execute(f.db,{command:protectedCommand(f)})).state,'published');assert.equal(f.counts().uploadCalls,1);
});
test('protected upload cannot dispatch without an atomic uploading claim and pending checkpoint',protectedMac,async t=>{
  const f=await setup(t,{real:true}),write=f.workspace.writeCheckpoint;
  f.workspace.writeCheckpoint=async(expected,value)=>{
    if(value.pins.publicationUploadPending)throw new Error('Owned pending checkpoint write failed');
    return write(expected,value);
  };
  assert.equal((await f.execute(f.db,{command:protectedCommand(f)})).state,'pending');
  assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
  assert.equal(f.checkpoint().control.publication.stage,'built');assert.equal(f.checkpoint().pins.publicationUploadPending,undefined);
  assert.equal(f.sql.prepare('SELECT state FROM publication_outbox WHERE release_id=?').get(f.config.releaseId).state,'claimed');
  // The exact D1 no-outbox assertion fails closed; SQLite errors are sanitized.
  await f.reopen();assert.equal((await f.execute()).errorCode,'publication_pending');assert.equal(f.counts().uploadCalls,0);
});
test('lost atomic uploading checkpoint ACK never dispatches and resume never resends',protectedMac,async t=>{
  const {f}=await stoppedBuilt(t),write=f.workspace.writeCheckpoint;let lost=false;
  f.workspace.writeCheckpoint=async(expected,value)=>{
    if(value.pins.publicationUploadPending)assert.equal(value.control.publication.stage,'uploading');
    const result=await write(expected,value);
    if(!lost&&value.pins.publicationUploadPending){lost=true;throw new Error('PRIVATE atomic checkpoint ACK lost');}
    return result;
  };
  assert.equal((await f.execute(f.db,{command:protectedCommand(f)})).state,'pending');assert.equal(lost,true);assert.equal(f.counts().uploadCalls,0);
  assert.equal(f.checkpoint().control.publication.stage,'uploading');assert.ok(f.checkpoint().pins.publicationUploadPending);
  await f.reopen();assert.equal((await f.execute()).errorCode,'publication_upload_review_required');assert.equal(f.counts().uploadCalls,0);
});

test('protected failed upload plus lost review checkpoint remains held after actual workspace reopen',protectedMac,async t=>{
  const f=await setup(t,{real:true}),write=f.workspace.writeCheckpoint;let rejectedReview=false;
  f.workspace.writeCheckpoint=async(expected,value)=>{
    if(value.pins.publicationUploadReview){rejectedReview=true;throw new Error('Owned review checkpoint write failed');}
    return write(expected,value);
  };
  f.mode.uploadLost=true;
  const command=protectedCommand(f,async command=>{
    if(command.args.includes('upload'))assert.ok(f.checkpoint().pins.publicationUploadPending);
    await f.command(command);
  });
  assert.equal((await f.execute(f.db,{command})).state,'pending');assert.equal(rejectedReview,true);
  assert.ok(f.checkpoint().pins.publicationUploadPending);assert.equal(f.checkpoint().pins.publicationUploadAcknowledged,undefined);
  assert.equal(f.checkpoint().pins.publicationUploadReview,undefined);assert.equal(f.checkpoint().control.publication.stage,'uploading');
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
  const before=f.counts();await f.reopen();
  const retry=await f.execute({providerIdentity:f.db.providerIdentity,prepare(){assert.fail('Held resume must not read D1');},
    batch(){assert.fail('Held resume must not mutate D1');}});assert.equal(retry.errorCode,'publication_upload_review_required');
  assert.deepEqual(f.counts(),before);assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,'freezing');
});

test('protected successful upload with lost acknowledgement checkpoint cannot reconcile a visible version',protectedMac,async t=>{
  const f=await setup(t,{real:true}),write=f.workspace.writeCheckpoint;
  f.workspace.writeCheckpoint=async(expected,value)=>{
    if(value.pins.publicationUploadAcknowledged)throw new Error('Owned acknowledgement checkpoint write failed');
    return write(expected,value);
  };
  assert.equal((await f.execute(f.db,{command:protectedCommand(f)})).state,'pending');
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
  assert.ok(f.checkpoint().pins.publicationUploadPending);assert.equal(f.checkpoint().pins.publicationUploadAcknowledged,undefined);
  const before=f.counts();await f.reopen();
  assert.equal((await f.execute()).errorCode,'publication_upload_review_required');assert.deepEqual(f.counts(),before);
});

test('protected exact acknowledgement permits ordinary immutable-version reconciliation without another upload',protectedMac,async t=>{
  const f=await setup(t,{real:true});f.mode.versionInvisible=true;
  assert.equal((await f.execute(f.db,{command:protectedCommand(f)})).errorCode,'publication_upload_pending');
  assert.ok(f.checkpoint().pins.publicationUploadPending);assert.ok(f.checkpoint().pins.publicationUploadAcknowledged);
  await f.reopen();delete f.mode.versionInvisible;
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});

test('negative protected review always wins over an exact acknowledged upload',protectedMac,async t=>{
  const f=await setup(t,{real:true});f.mode.versionInvisible=true;
  await f.execute(f.db,{command:protectedCommand(f)});
  const current=await f.workspace.readCheckpoint();assert.ok(current.checkpoint.pins.publicationUploadAcknowledged);
  const review=await f.workspace.putArtifact({schemaVersion:1,code:'publication_upload_unknown',releaseId:f.config.releaseId},
    {kind:'publication',observedAt:new Date(AT).toISOString()});
  await f.workspace.writeCheckpoint(current.sha256,{...current.checkpoint,pins:{...current.checkpoint.pins,publicationUploadReview:review}});
  const before=f.counts();await f.reopen();
  assert.equal((await f.execute()).errorCode,'publication_upload_review_required');assert.deepEqual(f.counts(),before);
});

test('protected acknowledged upload resumes normally and settles accepted control after artifact expiry',protectedMac,async t=>{
  const f=await setup(t,{real:true});let lost=false;
  f.after(statements=>{if(!lost&&statements.some(s=>s.query.startsWith('INSERT INTO publication_receipts'))){lost=true;throw new Error('Owned lost receipt acknowledgement');}});
  assert.equal((await f.execute(f.db,{command:protectedCommand(f)})).state,'pending');assert.equal(lost,true);
  const pins=f.checkpoint().pins;assert.ok(pins.publicationUploadPending);assert.ok(pins.publicationUploadAcknowledged);
  assert.equal(pins.publicationUploadReview,undefined);
  f.advance(6*60000);f.mode.noRevision=true;
  await f.workspace.purgeExpired();await f.reopen({controlOnly:true});
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);assert.equal(await readMutationOwner(f.db,scope),null);
  assert.deepEqual(f.checkpoint().pins,pins);
  await f.reopen({controlOnly:true});assert.equal((await f.execute()).state,'published');
});

test('mismatched or stale protected acknowledgement refuses before provider IO',protectedMac,async t=>{
  for(const mismatch of ['pending','releaseId'])await t.test(mismatch,async sub=>{
    const f=await setup(sub,{real:true}),write=f.workspace.writeCheckpoint;
    f.workspace.writeCheckpoint=async(expected,value)=>{
      if(value.pins.publicationUploadAcknowledged)throw new Error('Owned acknowledgement checkpoint write failed');
      return write(expected,value);
    };
    await f.execute(f.db,{command:protectedCommand(f)});
    const current=await f.workspace.readCheckpoint(),c=current.checkpoint.control.publication;
    const body={schemaVersion:1,releaseId:f.config.releaseId,requestId:c.requestId,configSha256:sha(canonicalJson(f.config)),
      packageSha256:c.packageSha256,uploadMarker:c.uploadMarker,pending:current.checkpoint.pins.publicationUploadPending};
    if(mismatch==='pending')body.pending={...body.pending,sha256:'0'.repeat(64)};else body.releaseId='stale-release';
    const acknowledged=await f.workspace.putArtifact(body,{kind:'publication',observedAt:new Date(AT).toISOString()});
    await write(current.sha256,{...current.checkpoint,pins:{...current.checkpoint.pins,publicationUploadAcknowledged:acknowledged}});
    const before=f.counts();await f.reopen();
    assert.equal((await f.execute()).errorCode,'publication_upload_review_required');assert.deepEqual(f.counts(),before);
  });
});

test('identity-only prior permits a fresh publication after a missed day/purged prior, without old asset reuse',async t=>{
  const f=await setup(t,{priorExpiryMs:5*60000});
  const priorDirectory=f.config.prior.directory;await fs.rm(priorDirectory,{recursive:true});
  f.config.prior.directory=null;f.advance(6*60000);
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().buildCalls,1);
  const context=JSON.parse(await fs.readFile(path.join(f.workspace.directory,'packages',f.config.releaseId,'release-context.json')));
  assert.equal(context.priorReleaseId,f.config.prior.releaseId);assert.equal(context.retainedManifestSha256,null);
  const manifest=JSON.parse(await fs.readFile(path.join(f.workspace.directory,'packages',f.config.releaseId,'asset-manifest.json')));
  assert.equal(manifest.retention,null);await assert.rejects(fs.lstat(priorDirectory),{code:'ENOENT'});
});

test('identity-only prior cannot bypass exact stored manifest identity or historical published receipt',async t=>{
  for(const changed of ['manifest','receipt'])await t.test(changed,async sub=>{
    const f=await setup(sub);await fs.rm(f.config.prior.directory,{recursive:true});f.config.prior.directory=null;
    if(changed==='manifest')f.config.prior.manifestSha256='e'.repeat(64);
    else f.sql.prepare('DELETE FROM publication_receipts WHERE release_id=?').run(f.config.prior.releaseId);
    const result=await f.execute();assert.equal(result.state,'pending');assert.equal(f.counts().activateCalls,0);
    if(changed==='receipt')assert.equal(result.errorCode,'publication_build_not_claimed');
    else assert.match(result.errorCode,/^publication_(prior_changed|pending)$/); // activation adapter sanitizes failed prior observations
  });
});

test('optional prior asset reuse cannot renew an expired prior merchant package',async t=>{
  const f=await setup(t,{real:true,priorExpiryMs:60000});f.advance(2*60000);
  const result=await f.execute();assert.equal(result.state,'pending');
  assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
  await assert.rejects(fs.lstat(path.join(f.workspace.directory,'packages',f.config.releaseId)),{code:'ENOENT'});
});
test('missing prior is an explicit bootstrap gate before claims, checkpoints, files or HTTP',async t=>{
  const f=await setup(t,{prior:false});const checkpoint=structuredClone(f.checkpoint());
  const build=f.sql.prepare('SELECT * FROM catalog_build_requests').get();const fence=f.sql.prepare('SELECT * FROM catalog_mutation_scopes').get();
  assert.equal((await f.execute()).errorCode,'publication_bootstrap_required');
  assert.deepEqual(f.checkpoint(),checkpoint);assert.deepEqual(f.sql.prepare('SELECT * FROM catalog_build_requests').get(),build);
  assert.deepEqual(f.sql.prepare('SELECT * FROM catalog_mutation_scopes').get(),fence);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_outbox').get().n,0);
  assert.deepEqual(f.counts(),{uploadCalls:0,activateCalls:0,buildCalls:0,identityCalls:0,httpCalls:0});
  await assert.rejects(fs.stat(f.workspace.directory),{code:'ENOENT'});
});
test('historical null-prior accepted activation settles without new build, upload or activation, including lost permit',async t=>{
  for(const lostPermit of [false,true]){
    const f=await setup(t,{prior:false});await f.historicalAccepted({lostPermit});f.advance(2*86400000);f.mode.noRevision=true;
    const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));assert.equal(await readMutationOwner(f.db,scope),null);
    assert.equal(f.counts().buildCalls,0);assert.equal(f.counts().uploadCalls,0);assert.equal(f.counts().activateCalls,0);
    assert.equal((await f.execute()).state,'published');
  }
});
test('a local historical activation marker cannot bypass the no-prior gate while D1 is still building',async t=>{
  const f=await setup(t,{prior:false});await f.historicalAccepted();
  f.sql.prepare("UPDATE catalog_build_requests SET state='building',lease_until=?").run(new Date(AT+600000).toISOString());const checkpoint=structuredClone(f.checkpoint());
  assert.equal((await f.execute()).errorCode,'publication_bootstrap_required');assert.deepEqual(f.checkpoint(),checkpoint);
  assert.deepEqual(f.counts(),{uploadCalls:0,activateCalls:0,buildCalls:0,identityCalls:0,httpCalls:0});
});
test('lost upload and committed activation responses resume exact versions without another external mutation',async t=>{
  const f=await setup(t);f.mode.uploadLost=true;f.mode.activationLost=true;
  const first=await f.execute();assert.equal(first.state,'pending');assert.equal(first.owner.phase,'activating');assert.doesNotMatch(JSON.stringify(first),/PRIVATE/);
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().buildCalls,1);
});
test('unconfirmed immutable upload is read-only reconciled, never rebuilt or re-uploaded',async t=>{
  const f=await setup(t);f.mode.uploadLost=true;f.mode.versionInvisible=true;
  assert.equal((await f.execute()).errorCode,'publication_upload_pending');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,0);
  delete f.mode.versionInvisible;assert.equal((await f.execute()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().buildCalls,1);
});
test('prior-only after unknown activation remains fenced indefinitely and is never resent',async t=>{
  const f=await setup(t);f.mode.activationNotSent=true;assert.equal((await f.execute()).state,'pending');
  f.advance(2*86400000);f.mode.noRevision=true;const second=await f.execute();assert.equal(second.state,'pending');assert.equal(second.owner.phase,'activating');
  assert.equal(f.counts().activateCalls,1);assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'activating');
});
test('readback/auth/native mismatch cannot publish; exact readback recovery does not re-activate',async t=>{
  for(const key of ['readbackFailure','identityFailure','vectorFailure']){
    const f=await setup(t);f.mode[key]=true;assert.equal((await f.execute()).state,'pending',key);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);assert.equal(f.counts().activateCalls,1);
    delete f.mode[key];assert.equal((await f.execute()).state,'published',key);assert.equal(f.counts().activateCalls,1);
  }
});
test('expired original build/publication leases settle an independently active fresh package exactly once without renewing or redeploying',async t=>{
  const f=await setup(t);f.mode.activationLost=true;assert.equal((await f.execute()).state,'pending');f.advance(16*60000);
  const c=f.checkpoint().control.publication;assert.ok(c.build.leaseUntil<new Date(AT+16*60000).toISOString());
  assert.ok(c.publication.leaseUntil<new Date(AT+16*60000).toISOString());
  await assert.rejects(completePublication(f.db,f.revision.snapshot,f.config.releaseId,c.publication.token,async()=>c.intent,
    ()=>new Date(AT+16*60000),c.permit.mutationOwner),/publication_fenced/); // Ordinary completion keeps its original lease rule.
  f.mode.noRevision=true;assert.equal((await f.execute()).errorCode,'publication_fresh_evidence_required');delete f.mode.noRevision;
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(await readMutationOwner(f.db,scope),null);assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'resolved');
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
  assert.equal(f.sql.prepare("SELECT attempts FROM publication_outbox WHERE release_id='fixture-release'").get().attempts,1);
  assert.equal(f.checkpoint().control.publication.publication.leaseUntil,c.publication.leaseUntil);
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().buildCalls,1);
});
test('ten full source rows settle through actual bounded D1 REST plus existing executor/native/identity/idle checks under150HTTP300SQL',async t=>{
  const f=await setup(t);f.mode.activationLost=true;await f.execute();f.advance(16*60000);
  const original={...f.sql.prepare('SELECT * FROM products WHERE public_id=?').get(id)};
  // Nine unchanged held baseline rows are private CAS inputs, never promoted.
  for(let i=2;i<=10;i++){
    const row={...original,id:`B${String(i).padStart(9,'0')}`,public_id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,
      slug:`held-baseline-${i}`,is_active:0,public_display_json:null,source_record_json:JSON.stringify({fixtureOnly:'x'.repeat(4000)})};
    const columns=Object.keys(row);f.sql.prepare(`INSERT INTO products(${columns.join(',')}) VALUES(${columns.map(()=>'?')})`).run(...columns.map(key=>row[key]));
    f.revision.sourceRows.push({...row,approved_product_json:canonicalJson(row),...Object.fromEntries(['id','public_id','source','availability_checked_at','last_verified_at']
      .map(key=>[`archived_${key}`,JSON.parse(row.source_record_json)[key]??null]))});
  }
  const heldBefore=f.sql.prepare('SELECT * FROM products WHERE is_active=0 ORDER BY id').all(),before=f.counts();
  let maxRequest=0,maxResponse=0,maxParameters=0,maxStatements=0;
  const base=`https://api.cloudflare.com/client/v4/accounts/${f.config.accountId}/d1/database/${f.config.database.id}`;
  const transport=async(url,init)=>{
    assert.ok(url===base||url===`${base}/query`);let result;
    if(url===base)result={uuid:f.config.database.id,name:f.config.database.name,read_replication:{mode:'disabled'}};
    else{
      maxRequest=Math.max(maxRequest,Buffer.byteLength(init.body));const {batch}=JSON.parse(init.body);maxStatements=Math.max(maxStatements,batch.length);
      assert.ok(batch.length<=50);result=[];f.sql.exec('BEGIN');
      try{for(const query of batch){maxParameters=Math.max(maxParameters,query.params.length);assert.ok(query.params.length<=100);
        const written=f.sql.prepare('SELECT total_changes() n').get().n;
        const rows=f.sql.prepare(query.sql).all(...query.params).map(row=>({...row})),changes=f.sql.prepare('SELECT total_changes() n').get().n-written;
        result.push({success:true,results:rows,meta:{served_by_primary:true,rows_read:rows.length,rows_written:changes,changes}});
      }f.sql.exec('COMMIT');}catch(error){f.sql.exec('ROLLBACK');throw error;}
    }
    const response=JSON.stringify({success:true,result});maxResponse=Math.max(maxResponse,Buffer.byteLength(response));return new Response(response);
  };
  const db=await createCatalogD1Rest({accountId:f.config.accountId,databaseId:f.config.database.id,databaseName:f.config.database.name,
    token:'FIXTURE_ONLY',fetch:transport,limits:{requests:150,statements:300}});
  const result=await f.execute(db);assert.equal(result.state,'published',JSON.stringify(result));assert.equal(await readMutationOwner(db,scope),null);
  assert.equal((await f.execute(db)).state,'published');
  const metrics=db.metrics(),http=metrics.requests+f.counts().httpCalls-before.httpCalls;
  assert.ok(http<=150);assert.ok(metrics.statements<=300);assert.equal(metrics.unconfirmedRequests,0);
  assert.ok(maxRequest<=512*1024);assert.ok(maxResponse<=512*1024);
  assert.equal(f.counts().activateCalls,before.activateCalls);assert.equal(f.counts().uploadCalls,before.uploadCalls);
  assert.deepEqual(f.sql.prepare('SELECT * FROM products WHERE is_active=0 ORDER BY id').all(),heldBefore);
  t.diagnostic(JSON.stringify({http,sql:metrics.statements,maxRequest,maxResponse,maxParameters,maxStatements,unknown:metrics.unconfirmedRequests}));
});
test('expired content and source/rights drift never grant new publication',async t=>{
  const expired=await setup(t);expired.mode.activationLost=true;await expired.execute();expired.advance(27*3600000);
  assert.equal((await expired.execute()).state,'pending');assert.equal(expired.counts().activateCalls,1);
  assert.equal(expired.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);
  const changed=await setup(t);changed.mode.sourceDrift=true;assert.equal((await changed.execute()).state,'pending');assert.equal(changed.counts().activateCalls,0);
  const held=await setup(t);held.mode.activationLost=true;await held.execute();held.sql.prepare("UPDATE products SET rights_json='{}'").run();
  assert.equal((await held.execute()).state,'pending');assert.equal(held.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);
});
test('original-permit completion refuses every owner/build/publication identity substitution before independent readback',async t=>{
  const f=await setup(t);f.mode.activationLost=true;await f.execute();f.advance(16*60000);const c=f.checkpoint().control.publication;
  let calls=0;const read=async()=>{calls++;return c.intent;},now=()=>new Date(AT+16*60000);
  for(const patch of [{requestId:'0'.repeat(64)},{token:'foreign'},{runReference:'foreign'},{releaseId:'foreign'},{versionReference:priorVersion},
    ...[{token:'foreign'},{generation:c.permit.mutationOwner.generation+1},{epoch:c.permit.mutationOwner.epoch+1},{phase:'freezing'},
      {ownerReference:'foreign'},{operationKey:'e'.repeat(64)},{environment:'production'},{indexName:'foreign'},{capturedAt:new Date(AT+1000).toISOString()}]
      .map(patch=>({mutationOwner:{...c.permit.mutationOwner,...patch}}))])
    await assert.rejects(completeActivatedPublication(f.db,f.revision,c.publication,{...c.permit,...patch},read,now));
  for(const patch of [{token:'foreign'},{intentId:'0'.repeat(64)},{leaseUntil:new Date(AT+17*60000).toISOString()},
    {intent:{...c.intent,manifestSha256:'e'.repeat(64)}}])
    await assert.rejects(completeActivatedPublication(f.db,f.revision,{...c.publication,...patch},c.permit,read,now));
  assert.equal(calls,0);assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);
  await assert.rejects(completeActivatedPublication(f.db,f.revision,c.publication,c.permit,async()=>{throw new Error('PRIVATE');},now),/publication_readback_failed/);
  await assert.rejects(completeActivatedPublication(f.db,f.revision,c.publication,c.permit,async()=>({...c.intent,manifestSha256:'e'.repeat(64)}),now),/publication_readback_mismatch/);
});
test('late owner/build/outbox/current/projection/global-vector/server-time drift atomically refuses original-permit settlement',async t=>{
  const mutations=[
    f=>f.sql.exec("UPDATE catalog_mutation_scopes SET owner_token='foreign'"),
    f=>f.sql.exec('UPDATE catalog_mutation_scopes SET generation=generation+1'),
    f=>f.sql.exec('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1'),
    f=>f.sql.exec('UPDATE catalog_mutation_scopes SET external_pending=0'),
    f=>f.sql.exec(`INSERT INTO catalog_build_requests(request_id,environment,source_revision,request_json)
      SELECT '${'0'.repeat(64)}',environment,source_revision,request_json FROM catalog_build_requests WHERE state='activating';
      UPDATE catalog_mutation_scopes SET activation_request_id='${'0'.repeat(64)}'`),
    f=>f.sql.exec("UPDATE catalog_build_requests SET lease_token='foreign'"),
    // Deliberately bypass the fixture CHECK to exercise the settlement CAS,
    // rather than merely testing SQLite's activating lease=NULL constraint.
    f=>f.sql.exec("PRAGMA ignore_check_constraints=ON; UPDATE catalog_build_requests SET lease_until='2026-10-19T12:01:00.000Z'"),
    f=>f.sql.exec("UPDATE catalog_build_requests SET run_reference='foreign'"),
    f=>f.sql.exec(`UPDATE catalog_build_requests SET version_reference='${priorVersion}'`),
    f=>f.sql.exec("UPDATE catalog_build_requests SET state='resolved'"),
    f=>f.sql.exec("UPDATE publication_outbox SET lease_token='foreign' WHERE release_id='fixture-release'"),
    f=>f.sql.exec("UPDATE publication_outbox SET lease_until='2026-10-19T12:01:00.000Z' WHERE release_id='fixture-release'"),
    f=>f.sql.exec("UPDATE publication_outbox SET dispatch_reference='version:foreign' WHERE release_id='fixture-release'"),
    f=>f.sql.exec("DROP TRIGGER publication_intent_immutable; UPDATE publication_outbox SET intent_json=json_set(intent_json,'$.manifestSha256','foreign') WHERE release_id='fixture-release'"),
    f=>f.sql.exec("UPDATE products SET title='unpublished typed field drift'"),
    f=>f.sql.exec("UPDATE products SET rights_json='{}'"),
    f=>f.sql.exec("DELETE FROM catalog_public_products WHERE catalog_revision='fixture-revision'"),
    f=>f.sql.exec("DROP TRIGGER catalog_public_immutable; UPDATE catalog_public_products SET title='foreign indexed title' WHERE catalog_revision='fixture-revision'"),
    f=>f.sql.exec(`DROP TRIGGER catalog_projection_receipt_immutable; UPDATE catalog_projection_receipts SET projection_sha256='${'e'.repeat(64)}' WHERE catalog_revision='fixture-revision'`),
    ...['pending','complete'].map(status=>f=>f.sql.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,status,created_at)
      VALUES(?,?,?,?,?,?)`).run(id,'fixture-prior','f'.repeat(64),'upsert',status,new Date(AT).toISOString())),
    f=>f.advance(27*3600000),
  ];
  for(const [index,mutate]of mutations.entries())await t.test(String(index),async sub=>{
    const f=await setup(sub);f.mode.activationLost=true;await f.execute();f.advance(16*60000);const c=f.checkpoint().control.publication;
    await assert.rejects(completeActivatedPublication(f.db,f.revision,c.publication,c.permit,async()=>{mutate(f);return c.intent;},()=>new Date(AT+16*60000)));
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);
    assert.equal(f.sql.prepare("SELECT status FROM catalog_revisions WHERE revision='fixture-revision'").get().status,'reconciled');
    assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().uploadCalls,1);
  });
});
test('expired-lease completion acknowledgement loss resumes only its accepted receipt, even after original content expiry',async t=>{
  for(const point of ['publication','resolve'])await t.test(point,async sub=>{
    const f=await setup(sub);f.mode.activationLost=true;await f.execute();f.advance(16*60000);let lost=false;
    f.after(statements=>{if(!lost&&statements.some(s=>point==='publication'?s.query.startsWith('INSERT INTO publication_receipts'):s.query.includes("SET state='resolved'"))){
      lost=true;throw new Error('PRIVATE lost acknowledgement');}});
    assert.equal((await f.execute()).state,'pending');assert.equal(lost,true);
    f.advance(27*3600000);f.mode.noRevision=true;assert.equal((await f.execute()).state,'published');
    assert.equal(await readMutationOwner(f.db,scope),null);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
    assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().buildCalls,1);
  });
});
test('activation proof is read-only and bound to exact stored permit; no freezing/delivery phase coercion',async t=>{
  const f=await setup(t);f.mode.activationLost=true;await f.execute();const c=f.checkpoint().control.publication;
  const adapters={...scope,providerIdentity:`cloudflare:${f.config.accountId}:${scope.indexName}`,async readback(){return f.vector;}};
  for(const patch of [{token:'wrong'},{runReference:'wrong'},{versionReference:'wrong'},{requestId:'0'.repeat(64)}])
    await assert.rejects(readActivatedCatalogVectors(f.db,{...c.permit,...patch},c.vectorPlan,adapters));
  await assert.rejects(readActivatedCatalogVectors(f.db,{...c.permit,mutationOwner:f.owner},c.vectorPlan,adapters));
  for(const patch of [{ids:[]},{ids:[],planSha256:'a'.repeat(64)},{planSha256:'a'.repeat(64)}])
    await assert.rejects(readActivatedCatalogVectors(f.db,c.permit,{...c.vectorPlan,...patch},adapters));
  const before=f.sql.prepare('SELECT * FROM catalog_mutation_scopes').get();
  await readActivatedCatalogVectors(f.db,c.permit,c.vectorPlan,adapters);assert.deepEqual(f.sql.prepare('SELECT * FROM catalog_mutation_scopes').get(),before);
  const original=f.sql.prepare('SELECT * FROM catalog_vector_deliveries').get();const extra={...original,delivery_id:'e'.repeat(64),prior_epoch:1,
    request_json:canonicalJson({...JSON.parse(original.request_json),publicId:version,vector:null})};const columns=Object.keys(extra);
  f.sql.prepare(`INSERT INTO catalog_vector_deliveries(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>extra[k]));
  await assert.rejects(readActivatedCatalogVectors(f.db,c.permit,c.vectorPlan,adapters),/vector_plan_incomplete/); // subset omits an excluded UUID journal
});
test('real protected workspace preserves state/locks and permits exact expired-content control reconciliation',async t=>{
  const f=await setup(t,{real:true});const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.checkpoint().state.driverState,'preserved');assert.equal((await f.execute()).state,'published');
});
test('two complete real-workspace publications reuse one checkout without retaining source build intermediates',async t=>{
  const f=await setup(t,{real:true});assert.equal((await f.execute()).state,'published');
  const firstDirectory=f.workspace.directory;
  for(const name of ['build/stupid-gifts','static-site/out','static-site/.next'])await assert.rejects(fs.lstat(path.join(f.config.sourceRoot,name)),{code:'ENOENT'});
  await f.nextRelease();assert.notEqual(f.workspace.directory,firstDirectory);
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));
  assert.equal(f.counts().buildCalls,2);assert.equal(f.counts().uploadCalls,2);assert.equal(f.counts().activateCalls,2);
  for(const name of ['build/stupid-gifts','static-site/out','static-site/.next'])await assert.rejects(fs.lstat(path.join(f.config.sourceRoot,name)),{code:'ENOENT'});
});
test('uploaded preactivation resume survives canonical control reordering after actual workspace close/reopen',async t=>{
  const f=await setup(t,{real:true});f.mode.stopBeforeActivation=true;
  assert.equal((await f.execute()).state,'pending');assert.equal(f.checkpoint().control.publication.stage,'uploaded');assert.equal(f.counts().activateCalls,0);
  await f.reopen();delete f.mode.stopBeforeActivation;
  assert.deepEqual(Object.keys(f.checkpoint().control.publication.publication.intent),Object.keys(f.checkpoint().control.publication.publication.intent).sort());
  const result=await f.execute();assert.equal(result.state,'published',JSON.stringify(result));assert.equal(f.counts().buildCalls,1);
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
});
test('lost completion/resolve acknowledgements recover only historical receipt after artifact expiry',async t=>{
  for(const point of ['publication','resolve']){
    const f=await setup(t,{real:true});let lost=false;
    f.after(statements=>{if(!lost&&statements.some(s=>point==='publication'?s.query.startsWith('INSERT INTO publication_receipts'):s.query.includes("SET state='resolved'"))){
      lost=true;throw new Error('PRIVATE lost D1 acknowledgement');}});
    assert.equal((await f.execute()).state,'pending');assert.equal(lost,true);
    f.advance(6*60000);f.mode.noRevision=true;
    const purged=await f.workspace.purgeExpired();assert.ok(purged.some(p=>p.reference===`packages/${f.config.releaseId}`));
    await assert.rejects(fs.lstat(path.join(f.workspace.directory,'packages',f.config.releaseId)),{code:'ENOENT'});
    for(const name of ['build/stupid-gifts','static-site/out','static-site/.next'])
      await assert.rejects(fs.lstat(path.join(f.config.sourceRoot,name)),{code:'ENOENT'});
    const result=await f.execute();assert.equal(result.state,'published',`${point}: ${JSON.stringify(result)}`);
    assert.equal(f.counts().activateCalls,1);assert.equal(f.counts().buildCalls,1);assert.equal(await readMutationOwner(f.db,scope),null);
  }
});
test('interrupted complete build is reused before upload; changed sealed bytes and corrupt build are explicit gates',async t=>{
  const f=await setup(t);f.mode.buildLost=true;assert.equal((await f.execute()).state,'pending');
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().buildCalls,1);assert.equal(f.counts().uploadCalls,1);
  const changed=await setup(t);changed.mode.activationNotSent=true;await changed.execute();
  const p=path.join(changed.workspace.directory,'packages',changed.config.releaseId,'assets/index.html');await fs.writeFile(p,'tampered');
  // It is already activating: never load/rebuild/reactivate even when old
  // package bytes are damaged. New acceptance still requires intact package.
  assert.equal((await changed.execute()).state,'pending');assert.equal(changed.counts().activateCalls,1);
  const corrupt=await setup(t);await put(path.join(corrupt.config.sourceRoot,'build/stupid-gifts/asset-manifest.json'),'{');
  assert.equal((await corrupt.execute()).errorCode,'publication_build_requires_operator_review');assert.equal(corrupt.counts().uploadCalls,0);
});
test('configuration has no environment/production defaults or ambient backend/identity fallback',async t=>{
  const f=await setup(t);assert.deepEqual(validatePublicationConfig(f.config),f.config);
  assert.equal(validatePublicationConfig({...f.config,workerName:'a'.repeat(63)}).workerName.length,63);
  for(const workerName of ['a'.repeat(64),'-worker','worker-','worker_name'])
    assert.throws(()=>validatePublicationConfig({...f.config,workerName}),/publication_configuration_invalid/);
  for(const patch of [{environment:undefined},{accountId:''},{database:{id:'bad',name:'db'}},{sourceMode:undefined},{sourceMode:'goose-production'},
    {identityOrigin:'https://fixture-worker.example.invalid/path'},{extra:'unsafe'}])assert.throws(()=>validatePublicationConfig({...f.config,...patch}));
});
test('wrong uploaded bindings or missing inherited staging guard never activate',async t=>{
  for(const key of ['wrongVersionDatabase','missingGuard']){const f=await setup(t);f.mode[key]=true;
    assert.equal((await f.execute()).errorCode,'publication_version_scope_mismatch');assert.equal(f.counts().activateCalls,0);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);}
});
test('reviewed semantic policy rejects staging enablement, coercion, unsafe bounds and unknown fields',async t=>{
  const f=await setup(t);const policy={enabled:false,dailyRequestCap:50,dailyTokenCap:32768};
  const production={...f.config,environment:'production',sourceMode:'goose-production',identityOrigin:siteIdentityFor('goose-production').origin};
  const valid=validatePublicationConfig({...f.config,semanticSearch:policy});assert.deepEqual(valid.semanticSearch,policy);
  assert.equal(Object.isFrozen(valid.semanticSearch),true);
  const inherited=Object.assign(Object.create({semanticSearch:{...policy,enabled:true}}),f.config);
  assert.equal(Object.hasOwn(validatePublicationConfig(inherited),'semanticSearch'),false);
  assert.equal(canonicalJson(validatePublicationConfig(inherited)),canonicalJson(f.config));
  assert.throws(()=>validatePublicationConfig({...f.config,semanticSearch:{...policy,enabled:true}}),/publication_configuration_invalid/);
  assert.deepEqual(validatePublicationConfig({...production,semanticSearch:{enabled:true,dailyRequestCap:100000,dailyTokenCap:100000000}}).semanticSearch,
    {enabled:true,dailyRequestCap:100000,dailyTokenCap:100000000});
  assert.deepEqual(validatePublicationConfig({...production,semanticSearch:{enabled:true}}).semanticSearch,{enabled:true});
  for(const semanticSearch of [undefined,null,{},[],{...policy,extra:1},{...policy,enabled:'true'},
    ...[0,-0,-1,1.5,NaN,Infinity,'50',undefined,100001].map(dailyRequestCap=>({...policy,dailyRequestCap})),
    ...[0,-1,1.5,NaN,Infinity,'32768',undefined,100000001].map(dailyTokenCap=>({...policy,dailyTokenCap}))])
    assert.throws(()=>validatePublicationConfig({...production,semanticSearch}),/publication_configuration_invalid/);
  f.config.semanticSearch={...policy,enabled:true};const checkpoint=structuredClone(f.checkpoint());
  await assert.rejects(f.execute(),/publication_configuration_invalid/);assert.deepEqual(f.checkpoint(),checkpoint);
  assert.deepEqual(f.counts(),{uploadCalls:0,activateCalls:0,buildCalls:0,identityCalls:0,httpCalls:0});
});
test('omitted optional policies keep historical config hashes and exact off defaults across real checkpoint resume',async t=>{
  const f=await setup(t,{real:true});const before=canonicalJson(f.config);
  Object.setPrototypeOf(f.config,{semanticSearch:{enabled:true,dailyRequestCap:1000,dailyTokenCap:100000},
    publicAnalytics:{enabled:true,posthogKey:'phc_ignored_inherited_key',posthogHost:'https://ignored.example.invalid'}});
  assert.equal(Object.hasOwn(validatePublicationConfig(f.config),'semanticSearch'),false);
  assert.equal(Object.hasOwn(validatePublicationConfig(f.config),'publicAnalytics'),false);
  assert.equal(canonicalJson(validatePublicationConfig(f.config)),before);
  f.mode.stopBeforeActivation=true;assert.equal((await f.execute()).state,'pending');
  assert.equal(f.checkpoint().control.publication.configSha256,sha(before));
  await f.reopen();delete f.mode.stopBeforeActivation;
  assert.equal((await f.execute()).state,'published');assert.equal(canonicalJson(validatePublicationConfig(f.config)),before);
  assert.deepEqual(f.uploadedConfigs[0].vars,{ENVIRONMENT:'staging',SEMANTIC_SEARCH_ENABLED:'false',
    SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'50',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'32768'});
  for(const command of f.commandEnvironments){assert.equal(command.env.NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED,'false');
    assert.equal(command.env.NEXT_PUBLIC_POSTHOG_KEY,undefined);assert.equal(command.env.NEXT_PUBLIC_POSTHOG_HOST,undefined);}
});
test('public analytics validates exact public inputs and rejects staging enablement, credentials and unsafe origins',async t=>{
  const f=await setup(t);const policy={enabled:true,posthogKey:'phc_existing_public_project',posthogHost:'https://us.i.posthog.com'};
  const production={...f.config,environment:'production',sourceMode:'goose-production',identityOrigin:siteIdentityFor('goose-production').origin};
  const valid=validatePublicationConfig({...production,publicAnalytics:policy});assert.deepEqual(valid.publicAnalytics,policy);
  assert.equal(Object.isFrozen(valid.publicAnalytics),true);
  assert.deepEqual(validatePublicationConfig({...production,sourceMode:'stupid-production',identityOrigin:siteIdentityFor('stupid-production').origin,
    publicAnalytics:policy}).publicAnalytics,policy);
  assert.deepEqual(validatePublicationConfig({...f.config,publicAnalytics:{...policy,enabled:false}}).publicAnalytics,{...policy,enabled:false});
  assert.throws(()=>validatePublicationConfig({...f.config,publicAnalytics:policy}),/publication_configuration_invalid/);
  for(const publicAnalytics of [undefined,null,{},[],{...policy,extra:'secret'},{...policy,enabled:'true'},
    ...[undefined,null,'','phx_private_api_key','phc_','phc_bad key','phc_'+'a'.repeat(197)].map(posthogKey=>({...policy,posthogKey})),
    ...[undefined,null,'','http://us.i.posthog.com','https://user:password@us.i.posthog.com','https://us.i.posthog.com/',
      'https://us.i.posthog.com/path','https://us.i.posthog.com?secret=value','https://us.i.posthog.com#fragment',
      'https://us.i.posthog.com:8443',' https://us.i.posthog.com','https://'+'a'.repeat(256)].map(posthogHost=>({...policy,posthogHost}))])
    assert.throws(()=>validatePublicationConfig({...production,publicAnalytics}),/publication_configuration_invalid/);
  f.config.publicAnalytics=policy;const checkpoint=structuredClone(f.checkpoint());
  await assert.rejects(f.execute(),/publication_configuration_invalid/);assert.deepEqual(f.checkpoint(),checkpoint);
  assert.deepEqual(f.counts(),{uploadCalls:0,activateCalls:0,buildCalls:0,identityCalls:0,httpCalls:0});
});
test('consecutive production publications forward only pinned public analytics to build/verify and reject in-flight changes',async t=>{
  const policy={enabled:true,posthogKey:'phc_existing_public_project',posthogHost:'https://us.i.posthog.com'};
  const f=await setup(t,{real:true,environment:'production',publicAnalytics:policy,
    semanticSearch:{enabled:false,dailyRequestCap:50,dailyTokenCap:32768}});f.mode.versionInvisible=true;
  assert.equal((await f.execute()).errorCode,'publication_upload_pending');
  assert.equal(f.checkpoint().control.publication.configSha256,sha(canonicalJson(f.config)));
  const before=f.counts();
  for(const patch of [{enabled:false},{posthogKey:'phc_other_public_project'},{posthogHost:'https://eu.i.posthog.com'}]){
    f.config.publicAnalytics={...policy,...patch};assert.equal((await f.execute()).errorCode,'publication_checkpoint_mismatch');
    assert.deepEqual(f.counts(),before);
  }
  f.config.publicAnalytics=policy;await f.reopen();delete f.mode.versionInvisible;
  assert.equal((await f.execute()).state,'published');await f.nextRelease();assert.equal((await f.execute()).state,'published');
  const buildCommands=f.commandEnvironments.filter(command=>command.args.some(arg=>/^scripts\/staging\/(build|verify-release)\.mts$/.test(arg)));
  assert.equal(buildCommands.length,4);
  for(const command of buildCommands){
    assert.deepEqual(Object.fromEntries(Object.entries(command.env).filter(([key])=>key.startsWith('NEXT_PUBLIC_'))),{
      NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED:'true',NEXT_PUBLIC_POSTHOG_KEY:policy.posthogKey,NEXT_PUBLIC_POSTHOG_HOST:policy.posthogHost});
    for(const key of ['CLOUDFLARE_API_TOKEN','OPENAI_API_KEY','POSTGRES_URL','STAGING_AUTH_SECRET'])assert.equal(command.env[key],undefined);
    assert.ok(!JSON.stringify(command.env).includes('PRIVATE'));
  }
  assert.equal(f.counts().uploadCalls,2);assert.equal(f.counts().activateCalls,2);
  for(const uploaded of f.uploadedConfigs)assert.equal(Object.keys(uploaded.vars).some(key=>/ANALYTICS|POSTHOG/.test(key)),false);
});
test('omitted and disabled analytics never inherit ambient public values; staging always receives none',async t=>{
  const ambient={NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED:'true',NEXT_PUBLIC_POSTHOG_KEY:'phc_ambient_project',
    NEXT_PUBLIC_POSTHOG_HOST:'https://ambient.example.invalid',NEXT_PUBLIC_ANALYTICS_TEST_SECRET:'not-forwarded'};
  const previous=Object.fromEntries(Object.keys(ambient).map(key=>[key,process.env[key]]));Object.assign(process.env,ambient);
  t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const disabled={enabled:false,posthogKey:'phc_reviewed_public_project',posthogHost:'https://us.i.posthog.com'};
  for(const [environment,publicAnalytics]of [['production',undefined],['production',disabled],['staging',disabled]]){
    const f=await setup(t,{environment,publicAnalytics});assert.equal((await f.execute()).state,'published');
    for(const command of f.commandEnvironments)assert.deepEqual(
      Object.fromEntries(Object.entries(command.env).filter(([key])=>key.startsWith('NEXT_PUBLIC_'))),{NEXT_PUBLIC_STATIC_ANALYTICS_ENABLED:'false'});
  }
});
test('consecutive production publications preserve exact reviewed search policy and refuse in-flight policy changes',async t=>{
  const policy={enabled:true,dailyRequestCap:123,dailyTokenCap:45678};
  const f=await setup(t,{environment:'production',semanticSearch:policy});f.mode.versionInvisible=true;
  assert.equal((await f.execute()).errorCode,'publication_upload_pending');
  const before=f.counts();f.config.semanticSearch={...policy,dailyRequestCap:124};
  assert.equal((await f.execute()).errorCode,'publication_checkpoint_mismatch');assert.deepEqual(f.counts(),before);
  f.config.semanticSearch=policy;delete f.mode.versionInvisible;assert.equal((await f.execute()).state,'published');
  const firstHash=f.checkpoint().control.publication.configSha256;
  await f.nextRelease();assert.equal((await f.execute()).state,'published');
  assert.notEqual(f.checkpoint().control.publication.configSha256,firstHash);
  assert.equal(f.sql.prepare('SELECT count(*) n FROM publication_receipts').get().n,3);
  assert.equal(f.counts().activateCalls,2);assert.equal(f.counts().uploadCalls,2);
  assert.equal(f.uploadedConfigs[1].name,f.uploadedConfigs[0].name);
  for(const uploaded of f.uploadedConfigs){
    assert.equal(uploaded.workers_dev,false);
    assert.deepEqual(uploaded.vars,{ENVIRONMENT:'production',SEMANTIC_SEARCH_ENABLED:'true'});
  }
});
test('old production configs remain off and retired budget vars are never deployed',async t=>{
  const lower={enabled:false,dailyRequestCap:7,dailyTokenCap:256};
  for(const [environment,semanticSearch]of [['production',undefined],['production',lower],['staging',lower]]){
    const f=await setup(t,{environment,semanticSearch});assert.equal((await f.execute()).state,'published');
    assert.deepEqual(f.uploadedConfigs[0].vars,{ENVIRONMENT:environment,SEMANTIC_SEARCH_ENABLED:'false'});
  }
});
test('current cap-free semantic policy survives a complete production publication',async t=>{
  const f=await setup(t,{environment:'production',semanticSearch:{enabled:true}});
  assert.equal((await f.execute()).state,'published');
  assert.deepEqual(f.uploadedConfigs[0].vars,{ENVIRONMENT:'production',SEMANTIC_SEARCH_ENABLED:'true'});
});
test('independent uploaded semantic enablement mismatch or missing opt-in cannot activate',async t=>{
  for(const [name,text]of [['SEMANTIC_SEARCH_ENABLED','false'],['SEMANTIC_SEARCH_ENABLED',null]]){
    const f=await setup(t,{environment:'production',semanticSearch:{enabled:true,dailyRequestCap:123,dailyTokenCap:45678}});
    if(text===null)f.mode.missingSearchBinding=name;else f.mode.searchBinding={name,text};
    assert.equal((await f.execute()).errorCode,'publication_version_scope_mismatch',name);
    assert.equal(f.counts().activateCalls,0);assert.equal(f.checkpoint().owner.phase,'freezing');
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);
    delete f.mode.missingSearchBinding;delete f.mode.searchBinding;
    assert.equal((await f.execute()).state,'published');assert.equal(f.counts().uploadCalls,1);
  }
});
test('protected resolve accepts a healthy aggregate observation over the legacy three-second deadline',async t=>{
  const f=await setup(t);f.mode.resolveDelayMs=3200;
  const start=performance.now();assert.equal((await f.execute()).state,'published');assert.ok(performance.now()-start>=3200);
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
  const counts=f.counts();assert.equal((await f.execute()).state,'published');assert.deepEqual(f.counts(),{...counts,httpCalls:counts.httpCalls+2});
});
test('inner native timeout drains aborted read cleanup before pending, keeps permit, and exact retry settles once',async t=>{
  const f=await setup(t);f.mode.activationLost=true;assert.equal((await f.execute()).state,'pending');delete f.mode.activationLost;
  f.mode.vectorAbortCleanup=true;assert.equal((await f.execute()).state,'pending');assert.equal(f.mode.vectorCleaned,true);
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'activating');
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,0);
  const counts=f.counts();await new Promise(resolve=>setTimeout(resolve,75));assert.deepEqual(f.counts(),counts);
  delete f.mode.vectorAbortCleanup;assert.equal((await f.execute()).state,'published');
  assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
});
test('outer resolve deadline aborts the owned chain before further reads, preserves receipt and retries exactly',async t=>{
  const f=await setup(t),timer=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===30_000?10:ms,...args));
  f.mode.resolveDelayMs=75;assert.equal((await f.execute()).state,'pending');
  assert.equal(f.checkpoint().control.publication.stage,'published');
  assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,'activating');
  const counts=f.counts();await new Promise(resolve=>setTimeout(resolve,100));assert.deepEqual(f.counts(),counts);
  assert.equal((await f.execute()).state,'published');assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
  assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
});
test('preactivation and resolve timeouts drain the selected owned sender before exact once-only retry',async t=>{
  for(const [identityOnlyPrior,phase,general]of [[false,'preactivation'],[true,'preactivation'],[true,'resolve']]
    .flatMap(([prior,phase])=>[[prior,phase,false],[prior,phase,true]]))await t.test(`${phase}/${identityOnlyPrior?'receipt':'retained'}/${general?'general':'read'}`,async sub=>{
    const f=await setup(sub,{identityOnlyPrior}),base=`https://api.cloudflare.com/client/v4/accounts/${f.config.accountId}/d1/database/${id}`;
    const db=await createCatalogD1Rest({accountId:f.config.accountId,databaseId:id,databaseName:f.config.database.name,token:'FIXTURE_ONLY',fetch:async(url,init)=>{
      if(url===base)return Response.json({success:true,result:{uuid:id,name:f.config.database.name,read_replication:{mode:'disabled'}}});
      assert.equal(url,`${base}/query`);const result=[];f.sql.exec('BEGIN');
      try{for(const query of JSON.parse(init.body).batch){const before=f.sql.prepare('SELECT total_changes() n').get().n;
        const rows=f.sql.prepare(query.sql).all(...query.params).map(row=>({...row})),changes=f.sql.prepare('SELECT total_changes() n').get().n-before;
        result.push({success:true,results:rows,meta:{served_by_primary:true,rows_read:rows.length,rows_written:changes,changes}});
      }f.sql.exec('COMMIT');}catch(error){f.sql.exec('ROLLBACK');throw error;}return Response.json({success:true,result});
    }});
    let lateResponse,hold=true,readStarted;const events=[];let observed=0;
    const heldRead=new Promise(resolve=>{readStarted=resolve;});
    const observationFetch=(general?accountedPublicationFetch:accountedPublicationReadFetch)({async reserveBudget(){events.push('reserve');},async settleBudget(_id,value){
      if(value.status==='unknown')await new Promise(resolve=>setTimeout(resolve,200));events.push(value.status);
    }},async(url,init)=>{
      observed++;const response=await f.fetch(url,init);
      if(hold&&(phase==='preactivation'||f.checkpoint().control.publication.stage==='published')){
        hold=false;return new Promise(resolve=>{lateResponse=()=>resolve(response);readStarted();});}return response;
    },{accountId:f.config.accountId,databaseId:id,workerName:f.config.workerName,indexName:f.config.indexName,identityOrigin:f.config.identityOrigin});
    // Trigger the fault only after its read was dispatched. Restore real timers
    // before the healthy retry: filesystem contention is not a 40 ms SLA.
    const timer=globalThis.setTimeout;sub.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>[3000,30000].includes(ms)
      ?timer(()=>{void heldRead.then(()=>fn(...args));},40):timer(fn,ms===10000?80:ms,...args));
    const result=await f.execute(db,{observationFetch});assert.equal(result.state,'pending');assert.ok(observed>0);
    sub.mock.restoreAll();
    assert.equal(events.filter(s=>s==='unknown').length,1);assert.equal(f.counts().activateCalls,phase==='preactivation'?0:1);
    assert.equal(f.sql.prepare('SELECT state FROM catalog_build_requests').get().state,phase==='preactivation'?'building':'activating');
    assert.equal(f.sql.prepare('SELECT phase FROM catalog_mutation_scopes').get().phase,phase==='preactivation'?'freezing':'activating');
    assert.equal(f.checkpoint().control.publication.permit===null,phase==='preactivation');
    const changes=f.sql.prepare('SELECT total_changes() n').get().n,counts=f.counts(),checkpoint=f.checkpoint().sha256,
      priorEvents=[...events],priorObserved=observed;lateResponse();
    await new Promise(resolve=>setTimeout(resolve,30));assert.deepEqual(events,priorEvents);assert.equal(observed,priorObserved);
    assert.equal(f.sql.prepare('SELECT total_changes() n').get().n,changes);assert.deepEqual(f.counts(),counts);assert.equal(f.checkpoint().sha256,checkpoint);
    // The selected observation sender never sees normal activation traffic.
    const retry=await f.execute(db,{observationFetch:accountedPublicationReadFetch({async reserveBudget(){},async settleBudget(){}},f.fetch,
      {accountId:f.config.accountId,databaseId:id,workerName:f.config.workerName,indexName:f.config.indexName,identityOrigin:f.config.identityOrigin})});
    assert.equal(retry.state,'published',JSON.stringify(retry));assert.equal(f.counts().uploadCalls,1);assert.equal(f.counts().activateCalls,1);
    assert.equal(f.sql.prepare("SELECT count(*) n FROM publication_receipts WHERE release_id='fixture-release'").get().n,1);
  });
});
