import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {automationRuntime,CATALOG_SCOPE as SCOPE} from './automation-runtime.mjs';
import {coordinateHostedCatalog,hostedInvocationDay} from './hosted-coordinator.mjs';
import {currentHostedInputs,restoreHostedInputs} from './hosted-inputs.ts';
import {createCatalogD1Rest} from './d1-write-rest.ts';
import {codeOnlyAuthority} from './code-only-operator.mjs';
import {readAcceptedCodeOnlyCatalog,acceptedCodeOnlyOperationKey} from './accepted-code-only.ts';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {claimMutationOwnership,readMutationOwner,mutationAssertion,releaseMutationOwnership} from '../../lib/catalog/mutation-fence.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {exportRuntimeCatalog} from './export-runtime-catalog.ts';
import {runtimeAssetKey} from '../../lib/catalog/runtime-catalog.ts';
import {readRuntimeCatalogData} from '../../lib/catalog/runtime-catalog.ts';
import {deployRuntimeApp} from './deploy-runtime-app.mjs';
import {createContentRequestStore} from '../../lib/catalog/content-admin.ts';
import {applyRuntimeCollection} from '../../lib/catalog/runtime-collections.ts';
import {SHOW_PRESETS,ACTIVE_SHOW_PRESET,selectShowPicks} from '../../static-site/lib/show-rehearsal.ts';

const ROOT=path.resolve(fileURLToPath(new URL('../..',import.meta.url))),hash=b=>createHash('sha256').update(b).digest('hex'),json=b=>JSON.parse(Buffer.from(b).toString('utf8'));
const fail=code=>{throw Error('runtime_bootstrap_'+code);};
export async function bootstrapRuntimeCatalog({runtime,source,root=ROOT,send=fetch,command=promisify(execFile)}){
  if(!runtime.hosted||!runtime.durable)fail('hosted_required');
  const pending=await runtime.durable.get('pointers/pending-run.json');
  if(pending&&json(pending.bytes).pending){
    const ref=json(pending.bytes).pending,bytes=await runtime.state.bytes(ref.path);
    if(hash(bytes)!==ref.sha256)fail('pending_identity_changed');
    const saved=json(bytes);if(saved.kind!=='code')fail('original_catalog_pending');
    const result=await coordinateHostedCatalog({mode:'code',source,day:hostedInvocationDay('code'),runtime});
    if(result.state!=='accepted')fail('original_code_reconciliation_pending');
  }
  await restoreHostedInputs(runtime.durable,runtime.base,await currentHostedInputs(runtime.durable));
  const pointerBytes=await runtime.state.readPointer('last-success',runtime.care+'/last-success.json'),pointer=json(pointerBytes),sealBytes=await runtime.state.bytes(pointer.control.path);
  if(hash(sealBytes)!==pointer.control.sha256)fail('accepted_control_changed');const seal=json(sealBytes);catalogSuccessorBytes(seal);
  const token=await runtime.token(),db=await createCatalogD1Rest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token,requestLimit:'observe',
    limits:{requests:600,statements:1500,reportedRowsRead:3000000,reportedRowsWritten:40000}});
  const planKey='runtime-bootstrap/'+source+'/plan.json',savedPlanObject=await runtime.durable.get(planKey),savedPlan=savedPlanObject?json(savedPlanObject.bytes):null;
  if(savedPlan&&(savedPlan.source!==source||savedPlan.pointerSha256!==hash(pointerBytes)||savedPlan.sealSha256!==hash(sealBytes)))fail('saved_plan_changed');
  const scope=(await db.prepare('SELECT phase,external_pending FROM catalog_mutation_scopes WHERE environment=? AND index_name=?').bind(SCOPE.environment,SCOPE.indexName).all()).results[0];
  const originalOwner=await readMutationOwner(db,SCOPE);
  const sameOwner=savedPlan&&originalOwner?.phase==='freezing'&&originalOwner.ownerReference===savedPlan.runId&&originalOwner.operationKey===acceptedCodeOnlyOperationKey(savedPlan.authority);
  if(scope?.external_pending!==0||scope.phase!=='idle'&&!sameOwner)fail('original_owner_not_idle');
  // One additive schema migration, while the original publisher queue is held.
  // Readback precedes any retry; CREATE failures are never blindly replayed.
  for(const [name,table]of [['0018_content_admin_requests.sql','content_admin_requests'],['0019_runtime_catalog.sql','catalog_runtime_publications']]){
    if(!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(table).all()).results.length){
      if(scope.phase!=='idle')fail('schema_requires_idle_owner');
      const args=['node_modules/wrangler/bin/wrangler.js','d1','execute',SCOPE.databaseName,'--remote','--file',path.join(root,'migrations/d1',name),'--yes'];
      try{await command(process.execPath,args,{cwd:root,timeout:120000,maxBuffer:2*1024*1024,env:{HOME:process.env.HOME,PATH:process.env.PATH,CI:'true',CLOUDFLARE_API_TOKEN:token,
        WRANGLER_SEND_METRICS:'false',WRANGLER_SEND_ERROR_REPORTS:'false',WRANGLER_LOG_SANITIZE:'true',WRANGLER_LOG:'error'}});}catch{/* Exact schema readback below, never another dispatch. */}
      if(!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").bind(table).all()).results.length)fail('schema_not_applied');
    }
    const sql=(await readFile(path.join(root,'migrations/d1',name),'utf8')).replace(/--[^\n]*/g,''),parts=sql.split(/(?=CREATE (?:TABLE|TRIGGER) )/).filter(s=>s.trim()),normalize=s=>s.replace(/\s+/g,' ').trim().replace(/;$/,'');
    for(const definition of parts){const name=definition.match(/CREATE (?:TABLE|TRIGGER) ([a-z_]+)/)?.[1];if(!name)fail('schema_definition');
      const actual=(await db.prepare('SELECT sql FROM sqlite_master WHERE name=?').bind(name).all()).results;
      if(actual.length!==1||normalize(actual[0].sql)!==normalize(definition))fail('schema_not_verified');}
  }
  let head=(await db.prepare('SELECT h.*,p.data_sha256 FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id WHERE h.singleton=1').all()).results[0];
  if(!head){
    const barrier=await db.batch([db.prepare('SELECT coalesce(max(sequence),0) n FROM vector_sync_outbox'),db.prepare('SELECT coalesce(max(rowid),0) n FROM publication_receipts')]);
    const authority=savedPlan?.authority??codeOnlyAuthority({seal,codeSha:source,observedAt:new Date().toISOString(),cutoff:new Date(Date.now()+2*3600000).toISOString(),
      globalVectorWatermark:barrier[0].results[0].n,publicationReceiptWatermark:barrier[1].results[0].n}),runId='runtime-bootstrap-'+source.slice(0,16);
    const plan={schemaVersion:1,source,runId,authority,pointerSha256:hash(pointerBytes),sealSha256:hash(sealBytes)};
    await runtime.durable.putImmutable(planKey,Buffer.from(JSON.stringify(plan)+'\n'));
    const
      owner=await claimMutationOwnership(db,SCOPE,{phase:'freezing',ownerReference:runId,operationKey:acceptedCodeOnlyOperationKey(authority)});
    if(!owner)fail('owner_not_acquired');
    try{
      const input=await readAcceptedCodeOnlyCatalog({db,owner,seal,authority,runReference:runId}),snapshot=input.revision.snapshot;
      let previous=json(await runtime.state.bytes(path.dirname(pointer.control.path)+'/config.json')).publication;
      // A newer serving-only release may carry accepted copy/ranking/analytics
      // metadata without changing the genuine catalog successor.
      let servingPointer;
      try{servingPointer=json(await runtime.state.readPointer('code-only-serving',runtime.care+'/code-only/last-serving.json'));}catch(error){if(error.code!=='ENOENT')throw error;}
      if(servingPointer){const recordBytes=await runtime.state.bytes(servingPointer.operator.path);
        if(hash(recordBytes)!==servingPointer.operator.sha256)fail('serving_control_changed');
        const record=json(recordBytes),live=await send('https://stupid.gifts/.well-known/catalog-release.json',{redirect:'error',signal:AbortSignal.timeout(15000)}),identity=await live.json();
        if(live.ok&&identity.release_id===servingPointer.releaseId&&record.config?.value?.acceptedCatalog?.releaseId===seal.publication.releaseId)previous=record.config.value;
      }
      let semanticCatalog;
      if(previous.semanticSearch?.derivedCatalog){const ref=previous.semanticSearch.derivedCatalog,bytes=await runtime.state.bytes(ref.path);
        if(hash(bytes)!==ref.sha256)fail('semantic_descriptor_changed');semanticCatalog=json(bytes);}
      const assets={};
      const registerFinite=ref=>db.batch([mutationAssertion(db,owner,['freezing']),db.prepare('INSERT INTO catalog_runtime_retention(object_key,sha256,not_after,release_id) VALUES(?,?,?,?) ON CONFLICT(object_key) DO NOTHING')
        .bind(ref.key,ref.sha256,ref.notAfter,seal.publication.releaseId)]);
      for(const product of snapshot.products)for(const p of [product,...(product.persistent?[product.persistent]:[])]){
        const url=new URL(p.imageUrl,'https://stupid.gifts');if(url.origin!=='https://stupid.gifts')continue;
        if(url.search||! /^\/(?:images|og|brand|illustrations)\/[a-zA-Z0-9_./-]+$/.test(url.pathname)||url.pathname.split('/').some(p=>p==='..'))fail('local_asset_path');
        const current=assets[url.pathname];if(current?.eligibleUntil===null||current&&p.eligibleUntil!==null&&current.eligibleUntil>=p.eligibleUntil)continue;
        if(p.eligibleUntil!==null&&Date.parse(p.eligibleUntil)<=Date.now())continue;
        const response=await send(url,{redirect:'error',signal:AbortSignal.timeout(15000)});
        if(!response.ok)fail('licensed_asset_missing');const bytes=new Uint8Array(await response.arrayBuffer());if(bytes.length>10*1024*1024)fail('asset_size');
        const asset={sha256:hash(bytes),contentType:(response.headers.get('Content-Type')??'').split(';')[0],eligibleUntil:p.eligibleUntil},key=runtimeAssetKey(asset).slice('catalog-v1/'.length);
        if(asset.eligibleUntil!==null)await registerFinite({key,sha256:asset.sha256,notAfter:asset.eligibleUntil});
        await runtime.durable.putImmutable(key,bytes);assets[url.pathname]=asset;
      }
      const exported=await exportRuntimeCatalog({snapshot,releaseId:seal.publication.releaseId,sourceCodeSha:source,homepage:previous.homepage,
        merchandising:previous.merchandising,semanticCatalog,assets,store:runtime.durable,registerFinite});
      if(exported.sourceSnapshotSha256!==seal.snapshotSha256)fail('snapshot_changed');
      const receipt=(await db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(seal.publication.releaseId).all()).results[0];
      if(hash(canonicalJson(receipt))!==seal.publication.receiptSha256)fail('receipt_changed');
      const at=new Date().toISOString();
      try{await db.batch([mutationAssertion(db,owner,['freezing']),
        db.prepare(`SELECT json(CASE WHEN NOT EXISTS(SELECT 1 FROM catalog_runtime_head) AND (SELECT release_id FROM publication_receipts ORDER BY rowid DESC LIMIT 1)=?
          AND NOT EXISTS(SELECT 1 FROM vector_sync_outbox WHERE status!='complete') THEN 'true' ELSE 'runtime_bootstrap_fenced' END)`).bind(seal.publication.releaseId),
        db.prepare('INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,public_snapshot_sha256,request_id,owner_json,previous_release_id,created_at) VALUES(?,?,?,?,?,NULL,?,NULL,?)')
          .bind(seal.publication.releaseId,snapshot.catalogRevision,exported.dataSha256,seal.snapshotSha256,exported.publicSnapshotSha256,canonicalJson(owner),at),
        db.prepare('INSERT INTO catalog_runtime_head(singleton,release_id,version,enabled) VALUES(1,?,1,0)').bind(seal.publication.releaseId),
      ]);}catch(error){const actual=(await db.prepare('SELECT release_id,data_sha256 FROM catalog_runtime_publications WHERE release_id=?').bind(seal.publication.releaseId).all()).results[0];
        if(actual?.release_id!==seal.publication.releaseId||actual.data_sha256!==exported.dataSha256)throw error;}
      await runtime.durable.putImmutable('runtime-bootstrap/'+source+'.json',Buffer.from(JSON.stringify({schemaVersion:1,source,releaseId:seal.publication.releaseId,
        receiptSha256:seal.publication.receiptSha256,sourceSnapshotSha256:seal.snapshotSha256,dataSha256:exported.dataSha256,publicProducts:snapshot.products.length,
        allIdentities:snapshot.products.length+snapshot.heldProducts.length,assets:Object.keys(assets).length,metrics:db.metrics(),supplierCalls:0,modelCalls:0})+'\n'));
    }finally{const actual=await readMutationOwner(db,SCOPE);if(actual&&canonicalJson(actual)===canonicalJson(owner))await releaseMutationOwnership(db,owner);}
    head=(await db.prepare('SELECT h.*,p.data_sha256 FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id WHERE h.singleton=1').all()).results[0];
  }
  if(sameOwner){const remaining=await readMutationOwner(db,SCOPE);
    if(remaining&&remaining.ownerReference===savedPlan.runId&&remaining.operationKey===acceptedCodeOnlyOperationKey(savedPlan.authority))await releaseMutationOwnership(db,remaining);}
  if(!head||head.release_id!==seal.publication.releaseId)fail('runtime_catalog_changed');
  const deployed=await deployRuntimeApp({runtime,source,root,send,command,bootstrap:true});
  if(deployed.catalogReleaseId!==head.release_id||deployed.catalogDataSha256!==head.data_sha256)fail('live_catalog_changed');
  await db.prepare('UPDATE catalog_runtime_head SET enabled=1 WHERE singleton=1 AND release_id=?').bind(head.release_id).run();
  const enabled=(await db.prepare('SELECT enabled FROM catalog_runtime_head WHERE singleton=1').all()).results[0];if(enabled?.enabled!==1)fail('enablement_unconfirmed');
  // Seed existing ID-only lineups through the SAME collection application
  // service, not code literals in a second publisher. Existing edits always win.
  const dataObject=await runtime.durable.get('public-catalog/'+head.data_sha256+'.json');
  if(!dataObject||hash(dataObject.bytes)!==head.data_sha256)fail('public_data_changed');
  const data=readRuntimeCatalogData(json(dataObject.bytes)),requests=createContentRequestStore(db);
  const seeds=Object.entries(SHOW_PRESETS).map(([name])=>({resource:'/collections/'+name,payload:{ids:selectShowPicks(data.snapshot,name).map(p=>p.publicId)}}));
  seeds.push({resource:'/active-show',payload:{name:ACTIVE_SHOW_PRESET}});
  if(data.homepage)seeds.push({resource:'/collections/homepage',payload:{edition:data.homepage}});
  for(const seed of seeds){if(await requests.get(seed.resource)||'ids' in seed.payload&&!seed.payload.ids.length)continue;
    const saved=await requests.save({requestId:'runtime-bootstrap-'+hash(seed.resource).slice(0,24),resource:seed.resource,
      action:seed.resource==='/active-show'?'active-show':'collection',actor:'runtime-cutover',reason:'Preserve accepted existing ID-only edition',
      baseCatalogRevision:data.snapshot.catalogRevision,expectedRevision:0,payload:seed.payload},new Date().toISOString());
    await applyRuntimeCollection(db,saved.request);
  }
  return{state:'accepted',transport:'runtime-data',...deployed,catalogPublisher:'existing-github-coordinator',metrics:db.metrics()};
}
async function main(){
  process.umask(0o077);const git=(...args)=>execFileSync('git',args,{cwd:ROOT,encoding:'utf8'}).trim();
  if(git('status','--porcelain','--untracked-files=all')||process.versions.node.split('.')[0]!=='22'||process.env.GITHUB_SHA!==git('rev-parse','HEAD')
    ||git('rev-parse','origin/main')!==git('rev-parse','HEAD'))fail('source_not_clean_or_current_main');
  console.log(JSON.stringify(await bootstrapRuntimeCatalog({runtime:automationRuntime(),source:process.env.GITHUB_SHA})));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{
  console.error(JSON.stringify({state:'attention',errorCode:/^[a-z][a-z0-9_]{0,149}$/.test(error.message)?error.message:'runtime_bootstrap_failed'}));process.exitCode=1;
});
