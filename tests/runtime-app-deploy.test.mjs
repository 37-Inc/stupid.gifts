import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {stop} from 'esbuild';
import {deployRuntimeApp} from '../scripts/catalog/deploy-runtime-app.mjs';
import {CATALOG_SCOPE as SCOPE} from '../scripts/catalog/automation-runtime.mjs';
import {bootstrapAttention,bootstrapAccounting} from '../scripts/catalog/bootstrap-runtime-catalog.mjs';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';
import {contentAdminSettings} from '../scripts/catalog/content-admin-settings.mjs';
after(stop);
test('bootstrap preserves the exact safe coordinator error instead of hiding it, without logging raw provider output',()=>{
  assert.deepEqual(bootstrapAttention({errorCode:'publication_activation_pending',phase:'publishing',failureAt:'retention_line_16',stderr:'SECRET'}),
    {state:'attention',step:'original_code_reconciliation',errorCode:'publication_activation_pending',phase:'publishing',failureAt:'retention_line_16'});
  assert.deepEqual(bootstrapAttention({errorCode:'SECRET token=private',phase:'SELECT private',failureAt:'/private/secret/key'}),
    {state:'attention',step:'original_code_reconciliation',errorCode:'runtime_bootstrap_original_code_reconciliation_pending'});
});
const source='a'.repeat(40),old='00000000-0000-4000-8000-000000000001',next='00000000-0000-4000-8000-000000000002',deployment='00000000-0000-4000-8000-000000000003';
test('bootstrap uses real advisory D1 accounting and retains unknown attempts across retries without logging SQL or credentials',async()=>{
  const objects=new Map(),runtime={hosted:true,durable:{async putImmutable(key,bytes){
    if(objects.has(key))assert.deepEqual(objects.get(key),bytes);else objects.set(key,bytes);}}};
  const attempt=await bootstrapAccounting(runtime,source);let unavailable=false,calls=0;
  const fetch=async(url,init)=>{calls++;assert.ok([...objects.keys()].some(k=>k.endsWith('/reserved.json')));
    if(unavailable)throw Error('synthetic unavailable');
    if(init.method==='GET')return Response.json({success:true,result:{uuid:SCOPE.databaseId,name:SCOPE.databaseName,read_replication:{mode:'disabled'}}});
    return Response.json({success:true,result:JSON.parse(init.body).batch.map(()=>({success:true,results:[{catalog_d1_primary:1}],meta:{served_by_primary:true,rows_read:1,rows_written:0,changes:0}}))});};
  const db=await createCatalogD1Rest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token:'SYNTHETIC_TOKEN',
    requestLimit:'observe',accounting:attempt.accounting,fetch,limits:{requests:600,statements:1500,reportedRowsRead:3000000,reportedRowsWritten:40000}});
  assert.equal(calls,2);unavailable=true;await assert.rejects(db.prepare('SELECT 1').all(),/catalog_d1_result_unknown/);
  assert.ok([...objects].some(([k,v])=>k.endsWith('/settled.json')&&JSON.parse(v).status==='unknown'));
  const prior=new Map(objects),retry=await bootstrapAccounting(runtime,source);assert.notEqual(retry.attemptId,attempt.attemptId);
  for(const [k,v]of prior)assert.deepEqual(objects.get(k),v);
  assert.ok(![...objects.values()].map(String).join('').includes('SYNTHETIC_TOKEN'));
  assert.ok(![...objects.values()].map(String).join('').includes('SELECT'));
});
function fixture({lostActivation=false,lostUpload=false,dispatchBinding}={}){
  const objects=new Map(),writes=[],state={version:old,marker:null,uploads:0,activations:0},bindings=[{name:'DB',type:'d1',id:SCOPE.databaseId},
    {name:'ASSETS',type:'assets'},{name:'VECTORIZE',type:'vectorize',index_name:SCOPE.indexName},{name:'SEMANTIC_VECTORIZE',type:'vectorize',index_name:'actual-existing-search'},
    {name:'OPENAI_API_KEY',type:'secret_text'},{name:'ENVIRONMENT',type:'plain_text',text:'production'},{name:'SEMANTIC_SEARCH_ENABLED',type:'plain_text',text:'true'},
    ...(dispatchBinding?[dispatchBinding]:[])];
  const runtime={hosted:true,token:async()=>'SYNTHETIC_TOKEN',durable:{async get(key){const bytes=objects.get(key);return bytes?{bytes,etag:'"test"'}:null;},async putImmutable(key,bytes){
    const prior=objects.get(key);if(prior)assert.ok(Buffer.from(prior).equals(Buffer.from(bytes)));else{objects.set(key,new Uint8Array(bytes));writes.push(key);}return{bytes,etag:'"test"'};}}};
  const ok=result=>Response.json({success:true,result});
  const send=async(input,options={})=>{
    const url=new URL(input);assert.ok(['api.cloudflare.com','stupid.gifts'].includes(url.hostname));
    if(url.hostname==='stupid.gifts')return Response.json(url.pathname.endsWith('runtime-catalog.json')?{contract:'runtime-catalog-v1',catalogReleaseId:'unchanged-catalog',dataSha256:'c'.repeat(64)}:
      {release_id:state.metadata.releaseId,code_sha:source,manifest_sha256:state.manifestSha256,catalog_revision:'unchanged-catalog',catalog_snapshot_sha256:'d'.repeat(64)});
    if(options.method==='POST'){
      const body=JSON.parse(options.body);assert.deepEqual(body.versions,[{version_id:next,percentage:100}]);state.activations++;state.version=next;state.marker=body.annotations['workers/message'];
      if(lostActivation){lostActivation=false;throw Error('synthetic lost committed POST acknowledgement');}return ok({id:deployment});
    }
    if(url.pathname.endsWith('/deployments'))return ok({deployments:[{id:deployment,versions:[{version_id:state.version,percentage:100}],annotations:{'workers/message':state.marker}}]});
    if(url.pathname.endsWith('/versions'))return ok({items:state.uploaded?[{id:next,annotations:{'workers/tag':state.tag}}]:[]});
    if(url.pathname.endsWith('/versions/'+old))return ok({id:old,resources:{bindings}});
    if(url.pathname.endsWith('/versions/'+next))return ok({id:next,annotations:{'workers/tag':state.tag,'workers/message':state.message},resources:{bindings:state.bindings}});
    throw Error('Unexpected provider path');
  };
  const command=async(file,args,options)=>{
    assert.equal(file,process.execPath);assert.ok(!Object.keys(options.env).some(k=>/STUPID_GIFTS_|AMAZON|OPENAI|R2_SECRET/.test(k)));
    assert.equal(options.env.CLOUDFLARE_API_TOKEN,'SYNTHETIC_TOKEN');assert.ok(writes.some(k=>k.endsWith('/upload-dispatched.json')));
    const configPath=args[args.indexOf('--config')+1],config=JSON.parse(await readFile(configPath,'utf8'));
    assert.equal(config.keep_vars,true);assert.equal(config.vars.SEMANTIC_SEARCH_ENABLED,'true');assert.equal(config.vectorize[1].index_name,'actual-existing-search');
    assert.equal(Object.hasOwn(config.vars,'GITHUB_CATALOG_DISPATCH_TOKEN'),false,'secrets never become generated plain-text variables');
    for(const [name,value]of Object.entries(contentAdminSettings))assert.equal(config.vars[name],value);
    const bytes=await readFile(path.join(path.dirname(configPath),'app-manifest.json'));state.metadata=JSON.parse(bytes);
    state.manifestSha256=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    state.tag=args[args.indexOf('--tag')+1];state.message=args[args.indexOf('--message')+1];state.uploads++;state.uploaded=true;
    state.bindings=[...bindings.filter(b=>b.type!=='plain_text'),...Object.entries(config.vars).map(([name,text])=>({type:'plain_text',name,text})),
      {type:'r2_bucket',name:'CATALOG_DATA',bucket_name:'stupid-gifts-catalog-private'}];
    if(lostUpload){lostUpload=false;throw Error('synthetic upload acknowledgement lost');}
  };
  return{runtime,send,command,state,objects};
}
for(const mode of ['normal','lostActivation','lostUpload'])test('app-only deploy preserves bindings/catalog and reconciles '+mode+' without catalog ownership or duplicate dispatch',async()=>{
  const f=fixture({[mode]:true}),result=await deployRuntimeApp({...f,source});
  assert.equal(result.state,'deployed');assert.equal(result.catalogReleaseId,'unchanged-catalog');assert.equal(result.supplierCalls,0);assert.equal(result.modelCalls,0);
  assert.equal(f.state.uploads,1);assert.equal(f.state.activations,1);
  const again=await deployRuntimeApp({...f,source});assert.equal(again.version,next);assert.equal(f.state.uploads,1);assert.equal(f.state.activations,1);
  assert.ok([...f.objects.keys()].every(k=>k.startsWith('app-releases/')),'No catalog pointer, product row or catalog mutation journal is written');
});
test('app deploy retains an existing dispatch secret without putting it in generated config',async()=>{
  const f=fixture({dispatchBinding:{name:'GITHUB_CATALOG_DISPATCH_TOKEN',type:'secret_text'}});
  assert.equal((await deployRuntimeApp({...f,source})).state,'deployed');
  assert.deepEqual(f.state.bindings.find(b=>b.name==='GITHUB_CATALOG_DISPATCH_TOKEN'),{name:'GITHUB_CATALOG_DISPATCH_TOKEN',type:'secret_text'});
  assert.ok(!JSON.stringify([...f.objects.values()].map(bytes=>Buffer.from(bytes).toString())).includes('TEST_ONLY_DISPATCH_TOKEN'));
  assert.equal(contentAdminSettings.CONTENT_ADMIN_DISPATCH_ENABLED,'false','not activated before independent publication proof');
});
test('app deploy rejects a plaintext dispatch credential before uploading',async()=>{
  const f=fixture({dispatchBinding:{name:'GITHUB_CATALOG_DISPATCH_TOKEN',type:'plain_text',text:'TEST_ONLY_DISPATCH_TOKEN'}});
  await assert.rejects(deployRuntimeApp({...f,source}),/runtime_app_bindings/);
  assert.equal(f.state.uploads,0);assert.equal(f.state.activations,0);
});
