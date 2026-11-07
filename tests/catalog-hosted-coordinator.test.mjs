import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {coordinateHostedCatalog,hostedRunRecord,hostedCommandEnvironment,validateHostedProposal,checkHostedProviderShadow,hostedOperatorFailure} from '../scripts/catalog/hosted-coordinator.mjs';
import {canonicalJson} from '../lib/catalog/canonical-json.ts';
import {CATALOG_SCOPE} from '../scripts/catalog/automation-runtime.mjs';

const SOURCE='a'.repeat(40),NEW_SOURCE='b'.repeat(40),HASH='c'.repeat(64),DAY='2026-11-06';
const bytes=value=>Buffer.from(JSON.stringify(value)+'\n'),hash=value=>createHash('sha256').update(value).digest('hex');
const ref={schemaVersion:1,key:'inputs/'+HASH+'.json',sha256:HASH};
const missing=()=>{const e=Error('missing');e.code='ENOENT';throw e;};
const providerReport=()=>({schemaVersion:1,kind:'cloudflare-runner-readiness',environment:CATALOG_SCOPE.environment,
  resources:{accountId:CATALOG_SCOPE.accountId,databaseId:CATALOG_SCOPE.databaseId,databaseName:CATALOG_SCOPE.databaseName,indexName:CATALOG_SCOPE.indexName},
  status:'checks_passed_execution_unavailable',executionAvailable:false,issues:[],metrics:{requests:5,reportedRowsRead:201,reportedRowsWritten:0}});

test('operator failure reports only the final safe machine code, never raw output or command arguments',()=>{
  assert.deepEqual(hostedOperatorFailure({stderr:'secret URL https://example.invalid/private\nrun_workspace_durable_missing\n',
    stdout:'private supplier body',message:'command with secret'}),{state:'attention',errorCode:'run_workspace_durable_missing'});
  assert.deepEqual(hostedOperatorFailure({stderr:'semantic_delta_pending\n'}),{state:'pending',errorCode:'semantic_delta_pending'});
  assert.deepEqual(hostedOperatorFailure({stderr:'catalog_d1_identity_unavailable\n'}),{state:'pending',errorCode:'catalog_d1_identity_unavailable'});
  assert.deepEqual(hostedOperatorFailure({stderr:'catalog_d1_result_unknown\n'}),{state:'attention',errorCode:'catalog_d1_result_unknown'});
  assert.deepEqual(hostedOperatorFailure({stderr:'unknown secret',killed:true}),{state:'attention',errorCode:'catalog_hosted_operator_timeout'});
});
function fixture(){
  const files=new Map(),events=[],calls=[],waits=[],restored=[],checkedOut=[];let pointer=null;
  const runtime={hosted:true,durable:{},base:'/private',care:'/private/daily-catalog-care',workspace:'/private/weekly-runs',state:{
    async bytes(file){return files.get(file)??missing();},async readPointer(name){assert.equal(name,'pending-run');return pointer??missing();},
    async put(file,value){events.push('immutable');const body=bytes(value);if(files.has(file))assert.deepEqual(body,files.get(file));files.set(file,body);return body;},
    async pointer(name,file,value,expected){assert.equal(name,'pending-run');assert.deepEqual(pointer,expected);events.push(value.pending?'pending':'clear');pointer=bytes(value);return pointer;}}};
  const f={runtime,files,events,calls,waits,restored,checkedOut,prepared:false,phase:null,approvalPin:undefined,executingSource:null,
    config:{runId:'exact-run',catalogRevision:'exact-run'},activeRef:ref,
    accepted:{releaseId:'actual-release',receiptSha256:HASH},pointer:()=>pointer};
  const proposal={schemaVersion:1,runId:f.config.runId,catalogRevision:f.config.catalogRevision,
    changes:[{publicId:'public-gift',operationId:'actual-op',inputSha256:HASH,productSha256:HASH,displaySha256:HASH}]};
  f.proposal=proposal;f.proposalBytes=bytes(proposal);f.proposalSha=hash(f.proposalBytes);
  f.summary=[{id:'B000000001',publicId:'public-gift',slug:'screaming-desk-chicken',editorialStatus:'published',
    publicTitle:'Desk chicken',description:'A tiny loud chicken.',imageUrl:'https://example.invalid/photo.jpg',
    publicAffiliateUrl:'https://www.amazon.com/dp/B000000001?tag=goose-gifts-37-20',persistent:true,sourceFactsHash:HASH}];
  f.deps={currentInputs:async()=>{events.push('current-inputs');return f.activeRef;},restoreInputs:async input=>{restored.push(input);},
    shadowCheck:async()=>{events.push('provider-read-check');return providerReport();},
    checkout:async source=>{checkedOut.push(source);f.executingSource=source;return '/operators/'+source;},
    inspect:async()=>({prepared:f.prepared,started:f.phase!==null,phase:f.phase,config:f.config,approvalPin:f.approvalPin}),
    accepted:async()=>f.phase==='finalized'?f.accepted:null,
    registerCleanup:async()=>{events.push('cleanup-register');},cleanup:async()=>{},
    invoke:async(directory,args)=>{
      calls.push(args);const command=args[0];events.push(command);
      if(command==='prepare'){assert.ok(events.indexOf('pending')<events.indexOf('prepare'));f.prepared=true;
        return{source:f.executingSource,configSha256:HASH,runId:f.config.runId};}
      if(command==='start'||command==='resume'){f.phase='phases_complete';return{state:'pending',reason:'awaiting_reviewed_approval',phase:f.phase};}
      if(command==='review'){const runKey=args.at(-1),file=runtime.care+'/runs/'+runKey+'/reviewed-proposal.json';files.set(file,f.proposalBytes);
        return{state:'requires_agent_review',proposalPath:file,proposalSha256:f.proposalSha,summary:f.summary};}
      if(command==='publish'){assert.equal(args[1],f.proposalSha);f.approvalPin=hash(canonicalJson(proposal));f.phase='finalized';return{state:'finalized'};}
      throw Error('unexpected command');},wait:async ms=>{waits.push(ms);}};
  f.run=(options={},overrides={})=>coordinateHostedCatalog({mode:'full',source:SOURCE,day:DAY,runtime,...options},{...f.deps,...overrides});
  return f;
}

test('one existing operator performs prepare/start/review/exact-SHA publish; pointer clears only after acceptance',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.state,'accepted');
  assert.deepEqual(f.calls.map(args=>args[0]),['prepare','start','review','publish']);
  assert.deepEqual(f.events.filter(e=>['immutable','pending','clear'].includes(e)),['immutable','pending','clear']);
  assert.ok(f.events.indexOf('cleanup-register')<f.events.indexOf('clear'));
  assert.deepEqual(JSON.parse(f.pointer()),{schemaVersion:1,pending:null});
  assert.deepEqual(JSON.parse(f.files.get(f.runtime.care+'/runs/scheduled-'+DAY+'/hosted-run.json')),
    {schemaVersion:1,runKey:'scheduled-'+DAY,source:SOURCE,day:DAY,kind:'full',inputsRef:ref});
});
test('pending intent survives interrupted prepare and resumes original source/day/inputs before any new operation',async()=>{
  const f=fixture();await assert.rejects(f.run({}, {invoke:async()=>{throw Error('lost runner');}}));
  const original=f.pointer();f.activeRef={schemaVersion:1,key:'inputs/'+'d'.repeat(64)+'.json',sha256:'d'.repeat(64)};
  const result=await f.run({mode:'photos',source:NEW_SOURCE,day:'2026-11-07'});
  assert.equal(result.state,'accepted');assert.equal(result.kind,'full');assert.equal(result.resumed,true);
  assert.deepEqual(f.checkedOut,[SOURCE,SOURCE]);assert.deepEqual(f.restored,[ref,ref]);
  assert.equal(f.events.filter(e=>e==='current-inputs').length,1);assert.ok(original);
  assert.ok(f.calls.every(args=>args.at(-1)==='scheduled-'+DAY));
});
test('old-run cleanup failure is advisory; lost cleanup registration preserves accepted pending work for bookkeeping-only retry',async()=>{
  const f=fixture();
  await assert.rejects(f.run({}, {cleanup:async()=>{throw Error('old cleanup unavailable');},registerCleanup:async()=>{throw Error('save unknown');}}),/save unknown/);
  assert.equal(f.phase,'finalized');assert.ok(JSON.parse(f.pointer()).pending);const calls=f.calls.length;
  assert.equal((await f.run()).state,'accepted');assert.equal(f.calls.length,calls);assert.equal(JSON.parse(f.pointer()).pending,null);
});

test('new reviewed controller uses recovery only for the original already-approved post-provider publication',async()=>{
  const f=fixture(),invoke=f.deps.invoke;
  const held=await f.run({}, {invoke:async(directory,args)=>{
    if(args[0]==='publish'){f.calls.push(args);f.phase='freezing';f.approvalPin=hash(canonicalJson(f.proposal));
      return{state:'attention',errorCode:'catalog_hosted_operator_failed'};}return invoke(directory,args);}});
  assert.equal(held.state,'attention');const startCalls=f.calls.filter(args=>args[0]==='start').length;
  const resumed=await f.run({source:NEW_SOURCE},{invoke:async(directory,args)=>{
    assert.equal(args[0],'recover');assert.equal(args[1],f.proposalSha);assert.equal(args.at(-1),'scheduled-'+DAY);
    assert.notEqual(directory,'/operators/'+SOURCE);f.calls.push(args);f.phase='finalized';return{state:'finalized'};}});
  assert.equal(resumed.state,'accepted');assert.equal(f.calls.filter(args=>args[0]==='start').length,startCalls);
  assert.deepEqual(f.checkedOut,[SOURCE,SOURCE]);assert.deepEqual(f.restored,[ref,ref]);
});
test('unpointed immutable intent is recovered after pointer ACK loss, not relabeled to newer code/inputs',async()=>{
  const f=fixture(),record={schemaVersion:1,runKey:'scheduled-'+DAY,source:SOURCE,day:DAY,kind:'full',inputsRef:ref};
  f.files.set(f.runtime.care+'/runs/'+record.runKey+'/hosted-run.json',bytes(record));
  const result=await f.run({source:NEW_SOURCE});assert.equal(result.state,'accepted');assert.deepEqual(f.checkedOut,[SOURCE]);
  assert.equal(f.events.includes('current-inputs'),false);
});
test('shadow reads exact inputs/source only, never writes pending or invokes/repairs an operator',async()=>{
  const f=fixture(),result=await f.run({mode:'shadow'});assert.equal(result.state,'shadow');assert.equal(result.workspace,'not_verified_readonly');
  assert.equal(result.providerScopeVerified,true);assert.equal(result.providerChecksPassed,true);assert.equal(result.providerExecutionVerified,false);
  assert.deepEqual(result.providerMetrics,{requests:5,reportedRowsRead:201,reportedRowsWritten:0});
  assert.equal(f.pointer(),null);assert.equal(f.files.size,0);assert.deepEqual(f.calls,[]);assert.deepEqual(f.restored,[ref]);
  await assert.rejects(f.run({}, {invoke:async()=>{throw Error('saved pending');}}));const before=f.pointer();
  const pendingShadow=await f.run({mode:'shadow',source:NEW_SOURCE});assert.equal(pendingShadow.pending,true);
  assert.deepEqual(f.pointer(),before);assert.equal(f.calls.length,0);
  assert.equal(f.events.filter(e=>e==='provider-read-check').length,2);
});
test('shadow preflight fixes canonical read scope and only the explicit reviewed Cloudflare credential reference',async()=>{
  const cloudflare={type:'environment',name:'STUPID_GIFTS_CLOUDFLARE_API_TOKEN'};let called=0;
  const result=await checkHostedProviderShadow({credentials:{cloudflare,amazonId:'must not be inspected',openai:'must not be inspected'}},async(config,options)=>{
    called++;assert.deepEqual(config,{schemaVersion:1,environment:'production',accountId:CATALOG_SCOPE.accountId,
      database:{id:CATALOG_SCOPE.databaseId,name:CATALOG_SCOPE.databaseName},vectorIndex:{name:CATALOG_SCOPE.indexName,dimensions:1536,metric:'cosine'},
      catalog:{associateTag:'goose-gifts-37-20',marketplace:'www.amazon.com'},cloudflareReadToken:cloudflare});
    assert.deepEqual(options,{timeoutMs:10000});return providerReport();});
  assert.equal(called,1);assert.deepEqual(result,providerReport());
});
test('blocked/unknown provider findings remain body-free and do not claim execution readiness or alter pending state',async()=>{
  const f=fixture(),report={...providerReport(),status:'blocked',issues:['ownership_busy'],metrics:{requests:5,reportedRowsRead:null,reportedRowsWritten:null},
    unexpectedProviderBody:'DO NOT OUTPUT',ownership:{owner_token:'DO NOT OUTPUT'}};
  const result=await f.run({mode:'shadow'},{shadowCheck:async()=>report});
  assert.equal(result.providerScopeVerified,true);assert.equal(result.providerChecksPassed,false);assert.equal(result.providerMetrics.reportedRowsRead,null);
  assert.deepEqual(result.providerIssues,['ownership_busy']);assert.ok(!JSON.stringify(result).includes('DO NOT OUTPUT'));
  assert.equal(f.pointer(),null);assert.equal(f.files.size,0);assert.equal(f.calls.length,0);
});
test('provider credential failure or mismatched scope stops shadow without starting/repairing a run',async()=>{
  for(const check of [async()=>{throw Error('synthetic missing credential');},async()=>({...providerReport(),resources:{...providerReport().resources,databaseId:'foreign'}}),
    async()=>({...providerReport(),metrics:{requests:5,reportedRowsRead:1,reportedRowsWritten:1}})]){
    const f=fixture();await assert.rejects(f.run({mode:'shadow'},{shadowCheck:check}));
    assert.equal(f.pointer(),null);assert.equal(f.files.size,0);assert.deepEqual(f.calls,[]);
  }
});
for(const errorCode of ['semantic_delta_pending','publication_provider_unavailable','catalog_d1_identity_unavailable'])test(`bounded ${errorCode} retry uses the same approved publication, never supplier/model phases again`,async()=>{
  const f=fixture(),invoke=f.deps.invoke;let publishes=0;
  const result=await f.run({}, {invoke:async(directory,args)=>{
    if(args[0]==='publish'&&publishes++===0){f.calls.push(args);f.phase='publishing';f.approvalPin=hash(canonicalJson(f.proposal));return{state:'pending',errorCode};}
    return invoke(directory,args);}});
  assert.equal(result.state,'accepted');assert.deepEqual(f.calls.map(args=>args[0]),['prepare','start','review','publish','publish']);
  assert.deepEqual(f.waits,[45000]);assert.equal(f.calls[3][1],f.calls[4][1]);
});
for(const errorCode of ['mutation_unknown','catalog_d1_result_unknown','publication_activation_unknown','publication_upload_unknown','publication_read_scope_invalid'])test(`${errorCode} stays pending with no automatic retry, fresh run or acceptance claim`,async()=>{
  const f=fixture(),invoke=f.deps.invoke,result=await f.run({}, {invoke:async(directory,args)=>{
    if(args[0]==='publish'){f.calls.push(args);return{state:'pending',errorCode};}return invoke(directory,args);}});
  assert.equal(result.state,'attention');assert.equal(result.errorCode,errorCode);assert.equal(f.waits.length,0);
  assert.ok(JSON.parse(f.pointer()).pending);assert.equal(f.calls.filter(a=>a[0]==='start').length,1);
  assert.equal(f.calls.filter(a=>a[0]==='publish').length,1);
});
test('visibility retries are finite and leave the same publication pending without a new provider run',async()=>{
  const f=fixture(),invoke=f.deps.invoke;
  const result=await f.run({}, {invoke:async(directory,args)=>{
    if(args[0]==='publish'){f.calls.push(args);f.phase='publishing';f.approvalPin=hash(canonicalJson(f.proposal));return{state:'pending',errorCode:'not_visible'};}
    return invoke(directory,args);}});
  assert.equal(result.state,'attention');assert.equal(f.waits.length,8);assert.equal(f.calls.filter(a=>a[0]==='start').length,1);
  assert.equal(f.calls.filter(a=>a[0]==='review').length,1);assert.equal(f.calls.filter(a=>a[0]==='publish').length,9);assert.ok(JSON.parse(f.pointer()).pending);
});
test('an accepted pending run is checked and cleared without running today\'s requested different operation',async()=>{
  const f=fixture();await assert.rejects(f.run({}, {invoke:async()=>{throw Error('lost runner');}}));
  f.prepared=true;f.phase='finalized';const result=await f.run({mode:'photos',source:NEW_SOURCE,day:'2026-11-07'});
  assert.equal(result.state,'accepted');assert.equal(result.kind,'full');assert.deepEqual(f.calls,[]);assert.deepEqual(f.checkedOut,[SOURCE,SOURCE]);
});
test('lost completion ACK recovers the immutable accepted intent without publishing a second time',async()=>{
  const f=fixture(),write=f.runtime.state.pointer.bind(f.runtime.state);let fail=true;
  f.runtime.state.pointer=async(...args)=>{const body=await write(...args);if(args[2].pending===null&&fail){fail=false;throw Error('lost completion ACK');}return body;};
  await assert.rejects(f.run());const before=f.calls.length,result=await f.run({source:NEW_SOURCE});
  assert.equal(result.state,'accepted');assert.equal(f.calls.length,before);assert.equal(f.events.filter(v=>v==='current-inputs').length,1);
});
test('exit-zero finalized without accepted successor does not clear the pending pointer',async()=>{
  const f=fixture();f.accepted=null;const result=await f.run();assert.equal(result.state,'attention');assert.ok(JSON.parse(f.pointer()).pending);
  assert.equal(f.calls.filter(a=>a[0]==='publish').length,1);assert.equal(f.calls.filter(a=>a[0]==='resume').length,1);
});
test('photo-current is a healthy skip; canary is explicit and never inferred from a scheduled invocation',async()=>{
  const f=fixture();const result=await f.run({mode:'photos'}, {invoke:async(directory,args)=>{f.calls.push(args);return{state:'skipped',reason:'photos_current'};}});
  assert.equal(result.state,'skipped');assert.deepEqual(f.calls,[['prepare','--photos-only','--run','photos-'+DAY]]);
  const canary=fixture();await canary.run({mode:'canary',canaryId:'B000000001'});
  assert.deepEqual(canary.calls[0],['prepare','--canary-id','B000000001','--run','canary-'+DAY+'-B000000001']);
  await assert.rejects(fixture().run({mode:'canary'}),/canary/);await assert.rejects(fixture().run({canaryId:'B000000001'}),/canary/);
});
test('tampered review SHA, mismatched rows/copy and unsafe image links cannot reach publish',async()=>{
  for(const mutate of [f=>{f.proposalSha='e'.repeat(64);},f=>{f.summary[0].publicId='other';},
    f=>{f.summary[0].imageUrl='file:///private/secret';},f=>{f.summary[0].description='';},
    f=>{f.summary[0].publicAffiliateUrl='https://www.amazon.com/dp/B000000001?tag=wrong-20';},
    f=>{f.summary[0].publicAffiliateUrl='https://www.amazon.com/dp/B000000002?tag=goose-gifts-37-20';},
    f=>{delete f.summary[0].description;}]){
    const f=fixture();mutate(f);await assert.rejects(f.run());assert.equal(f.calls.some(args=>args[0]==='publish'),false);assert.ok(JSON.parse(f.pointer()).pending);
  }
});
test('already approved proposal is hash-bound; matching file never requires inventing new review state',()=>{
  const f=fixture();assert.deepEqual(validateHostedProposal({bytes:f.proposalBytes,sha256:f.proposalSha,
    runId:f.config.runId,catalogRevision:f.config.catalogRevision,approvalPin:hash(canonicalJson(f.proposal))}),{sha256:f.proposalSha,changes:1});
  assert.throws(()=>validateHostedProposal({bytes:f.proposalBytes,sha256:f.proposalSha,runId:'other',catalogRevision:f.config.catalogRevision,approvalPin:HASH}));
});
test('tampered pending reference/record and foreign original source stop before commands',async()=>{
  const f=fixture();await assert.rejects(f.run({}, {invoke:async()=>{throw Error('pending');}}));
  const pointer=JSON.parse(f.pointer()),body=JSON.parse(f.files.get(pointer.pending.path));body.day='2026-11-07';f.files.set(pointer.pending.path,bytes(body));
  await assert.rejects(f.run(),/pending_digest/);assert.equal(f.calls.length,0);
  assert.throws(()=>hostedRunRecord({schemaVersion:1,runKey:'scheduled-'+DAY,source:SOURCE,day:'2026-99-99',kind:'full',inputsRef:ref}),/day/);
  const g=fixture();await assert.rejects(g.run({}, {checkout:async()=>{throw Error('not ancestor');}}));assert.equal(g.calls.length,0);assert.ok(g.pointer());
});
test('dependency install has no credentials and application child receives only explicit approved key names',()=>{
  const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'37-Inc/stupid.gifts',GITHUB_REF:'refs/heads/main',GITHUB_SHA:SOURCE,
    STUPID_GIFTS_CLOUDFLARE_API_TOKEN:'synthetic',STUPID_GIFTS_OPENAI_API_KEY:'synthetic-model',STUPID_GIFTS_UNKNOWN_SECRET:'never',
    OPENAI_API_KEY:'ambient-secret',AMAZON_KEY:'ambient',GH_TOKEN:'ambient',GITHUB_TOKEN:'ambient',CATALOG_MODE:'full'};
  const install=hostedCommandEnvironment(env,{credentials:false});assert.ok(Object.keys(install).every(k=>!/(TOKEN|KEY|SECRET|GITHUB|STUPID)/.test(k)));
  const app=hostedCommandEnvironment(env);assert.equal(app.STUPID_GIFTS_CLOUDFLARE_API_TOKEN,'synthetic');assert.equal(app.STUPID_GIFTS_OPERATOR_MODE,'hosted');
  for(const key of ['STUPID_GIFTS_UNKNOWN_SECRET','OPENAI_API_KEY','AMAZON_KEY','GH_TOKEN','GITHUB_TOKEN','CATALOG_MODE'])assert.equal(app[key],undefined);
});
test('editorial preview uses the same stable source checkout as routine care and cleanup',async()=>{
  const code=await readFile(new URL('../scripts/catalog/hosted-coordinator.mjs',import.meta.url),'utf8');
  assert.match(code,/const repository=await defaults\(runtime,process\.env\)\.checkout\(source\);\s*console\.log\(JSON\.stringify\(await previewHostedHomepage\(runtime,\{repository,source,day:/);
  assert.doesNotMatch(code,/previewHostedHomepage\(runtime,\{repository:ROOT/);
});
test('one Pacific workflow remains main-only, protected, serialized and has no PR/push trigger',async()=>{
  const yaml=await readFile(new URL('../.github/workflows/catalog-manual.yml',import.meta.url),'utf8');
  assert.match(yaml,/workflow_dispatch:/);assert.doesNotMatch(yaml,/\b(?:pull_request|push):/);
  assert.match(yaml,/cron: '30 8 \* \* \*'/);assert.match(yaml,/cron: '30 20 \* \* \*'/);assert.match(yaml,/cron: '30 10 \* \* \*'/);
  assert.equal((yaml.match(/timezone: America\/Los_Angeles/g)||[]).length,3);
  assert.match(yaml,/inputs.mode \|\| \(github.event.schedule == '30 20 \* \* \*' && 'photos' \|\| 'full'\)/);
  assert.match(yaml,/group: catalog-production/);assert.match(yaml,/cancel-in-progress: false/);assert.match(yaml,/environment: Production/);
  assert.match(yaml,/if: github.ref == 'refs\/heads\/main'/);assert.match(yaml,/runs-on: ubuntu-24.04/);assert.match(yaml,/node-version: '22.23.1'/);
  assert.match(yaml,/persist-credentials: false/);assert.match(yaml,/apparmor_parser -r \.github\/catalog-bwrap.apparmor/);
  assert.doesNotMatch(yaml,/sysctl|--privileged|curl.*secret/i);assert.match(yaml,/npm ci --ignore-scripts/);
});
