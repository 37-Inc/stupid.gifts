import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,chmod,rm,realpath,readFile,readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openRunWorkspace,readRunWorkspace} from '../scripts/catalog/run-workspace.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {inventoryPublicationPackage} from '../scripts/catalog/publish-release.ts';

const NOW='2026-11-06T12:00:00.000Z',LATER='2026-11-06T14:00:00.000Z',HASH='a'.repeat(64);
const encode=value=>Buffer.from(canonicalJson(value)+'\n');
const cp=()=>({phase:'created',owner:{environment:'staging',indexName:'test-index',token:'same-owner',generation:3,epoch:9,
  phase:'writing',ownerReference:'test-run',operationKey:HASH,capturedAt:NOW},state:{private:'test-only'},pins:{},phaseComplete:null});
const reservation={id:'pending-call',requestSha256:HASH,units:{httpRequests:1,sqlStatements:2}};
function memoryStore(){
  const objects=new Map(),calls=[];let version=0,fault=null,headReadFault=false;
  const copy=v=>v?{bytes:new Uint8Array(v.bytes),etag:v.etag}:null;
  const write=(key,bytes)=>{const value={bytes:new Uint8Array(bytes),etag:`"version-${++version}"`};objects.set(key,value);return copy(value);};
  const store={async get(key){calls.push(['get',key]);if(headReadFault&&key.endsWith('/head.json'))throw Error('read_unknown');return copy(objects.get(key));},
    async putImmutable(key,bytes){calls.push(['put',key]);const old=objects.get(key);
      if(old){assert.deepEqual(old.bytes,new Uint8Array(bytes));return copy(old);}return write(key,bytes);},
    async compareAndSwap(key,expected,bytes){calls.push(['cas',key]);const old=objects.get(key);
      if(old?.etag!==expected&&!(old===undefined&&expected===null)){
        if(old&&Buffer.from(old.bytes).equals(Buffer.from(bytes)))return copy(old);throw Error('remote_conflict');}
      const current=fault;fault=null;
      if(current==='before')throw Error('write_unknown');
      if(current==='compete'){
        const wanted=JSON.parse(Buffer.from(bytes)),record={schemaVersion:1,sequence:wanted.sequence,parent:JSON.parse(Buffer.from(old.bytes)).sha256,
          event:{type:'reserve',reservation:{...reservation,id:'competing-call'}}};
        const hash=sha256(canonicalJson(record));write(`runs/test-run/events/${String(wanted.sequence).padStart(6,'0')}.${hash}.json`,encode(record));
        write(key,encode({sequence:wanted.sequence,sha256:hash}));throw Error('remote_conflict');}
      const value=write(key,bytes);
      if(current==='after'||current==='after-unreadable'){headReadFault=current==='after-unreadable';throw Error('write_unknown');}
      return value;},
    async remove(key,expected){calls.push(['remove',key]);const old=objects.get(key);if(old&&old.etag!==expected)throw Error('remote_conflict');objects.delete(key);}};
  return{store,objects,calls,setFault:value=>{fault=value;},readable:()=>{headReadFault=false;}};
}
async function fixture(t){
  const parent=await mkdtemp(join(await realpath(tmpdir()),'workspace-durable-'));await chmod(parent,0o700);
  const m=memoryStore();let now=NOW;const handles=[];
  const input={directory:join(parent,'runner-one'),repository:await realpath(new URL('..',import.meta.url).pathname),mode:'create',runId:'test-run',
    configSha256:HASH,codeSha:'b'.repeat(40),scope:{environment:'staging',accountId:'test-account',databaseId:'test-db',databaseName:'test-db',workerName:'test-worker',indexName:'test-index'},
    retention:{reviewReference:'test-only/retention',rules:Object.fromEntries(['amazon-observation','embedding-response','phase','publication','checkpoint']
      .map(kind=>[kind,{maxAgeMs:3600000,notAfter:'2026-11-07T00:00:00.000Z'}]))},
    budgetCaps:{httpRequests:10,sqlStatements:20},now:()=>now,durable:m.store};
  const open=async(overrides={})=>{const w=await openRunWorkspace({...input,...overrides});handles.push(w);return w;};
  t.after(async()=>{for(const w of handles.reverse())try{await w.close();}catch{}await rm(parent,{recursive:true,force:true});});
  return{...m,input,parent,open,setNow:value=>{now=value;}};
}

test('journal ACK precedes dispatch; fresh runner restores original bodies, owner and unknown reservation without locks',async t=>{
  const f=await fixture(t),w=await f.open();
  const blob=await w.putBlob(Buffer.alloc(300000,7),{kind:'phase',observedAt:NOW});await w.writeCheckpoint(null,cp());
  await w.reserveBudget(reservation);
  const head=JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes));
  assert.ok(f.objects.has(`runs/test-run/events/${String(head.sequence).padStart(6,'0')}.${head.sha256}.json`));
  const originalLocks=await readdir(join(f.input.directory,'locks'));
  const restored=await f.open({directory:join(f.parent,'runner-two'),mode:'resume',expectedManifestSha256:w.manifestSha256});
  assert.deepEqual((await restored.readCheckpoint()).checkpoint,cp());
  assert.deepEqual(await restored.readBlob(blob),Buffer.alloc(300000,7));
  assert.deepEqual(await restored.budget(),{httpRequests:1,sqlStatements:2,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:1});
  assert.deepEqual(await readdir(join(f.input.directory,'locks')),originalLocks);
  for(const name of originalLocks)assert.notEqual(await readFile(join(f.input.directory,'locks',name),'utf8'),
    await readFile(join(f.parent,'runner-two','locks',name),'utf8'));
  assert.ok([...f.objects.keys()].every(key=>!key.includes('/locks/')&&!key.includes('.pending-')));
  const bodyIndex=f.calls.findIndex(([method,key])=>method==='put'&&key.includes('/objects/'));
  assert.ok(bodyIndex>=0&&f.calls.slice(bodyIndex+1).some(([method,key])=>method==='cas'&&key.endsWith('/head.json')));
});

test('lost remote CAS ACK is reconciled by exact readback',async t=>{
  const f=await fixture(t),w=await f.open();f.setFault('after');await w.reserveBudget(reservation);
  assert.equal((await w.budget()).unconfirmedRequests,1);
  assert.equal(f.calls.filter(([method])=>method==='cas').length,2); // initial head + reservation, no redispatch
});

test('same-runner resume reuses hash-verified immutable bytes but still checks the remote head and manifest',async t=>{
  const f=await fixture(t),w=await f.open();await w.putArtifact({fixture:'cached'},{kind:'phase',observedAt:NOW});
  await w.writeCheckpoint(null,cp());await w.reserveBudget(reservation);await w.close();f.calls.length=0;
  const resumed=await f.open({mode:'resume'});assert.equal((await resumed.budget()).unconfirmedRequests,1);
  assert.deepEqual(f.calls.filter(([method])=>method==='get').map(([,key])=>key),
    ['runs/test-run/head.json','runs/test-run/manifest.json','runs/test-run/head.json']);
});

for(const target of ['event','body'])test(`same-runner resume refuses a tampered cached ${target}`,async t=>{
  const f=await fixture(t),w=await f.open(),ref=await w.putArtifact({fixture:'unchanged'},{kind:'phase',observedAt:NOW});await w.close();
  const file=target==='body'?join(w.directory,ref.reference):join(w.directory,'events',(await readdir(join(w.directory,'events')))[0]);
  const value=JSON.parse(await readFile(file));if(target==='body')value.value.fixture='tampered';else value.sequence=999;
  await writeFile(file,encode(value),{mode:0o600});
  await assert.rejects(f.open({mode:'resume'}),/artifact_hash|journal_chain|body_registration/);
});

test('provider dispatch cannot pass an unfinished remote reservation CAS',async t=>{
  const f=await fixture(t),w=await f.open(),original=f.store.compareAndSwap.bind(f.store);let release,entered,dispatched=false;
  const barrier=new Promise(resolve=>{release=resolve;}),reached=new Promise(resolve=>{entered=resolve;});
  f.store.compareAndSwap=async(...args)=>{entered();await barrier;return original(...args);};
  const action=(async()=>{await w.reserveBudget(reservation);dispatched=true;})();await reached;
  assert.equal(dispatched,false);assert.equal(JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes)).sequence,0);
  release();await action;assert.equal(dispatched,true);assert.equal((await w.budget()).unconfirmedRequests,1);
});

for(const fault of ['before','after-unreadable'])test(`same local resume reconciles ${fault} without local-only repair or losing a charge`,async t=>{
  const f=await fixture(t),w=await f.open();f.setFault(fault);let dispatched=false;
  await assert.rejects(async()=>{await w.reserveBudget(reservation);dispatched=true;},/unknown/);assert.equal(dispatched,false);
  await assert.rejects(w.budget(),error=>error.message==='run_workspace_journal_uncertain'&&error.cause?.message?.includes('unknown'));await w.close();f.readable();
  const resumed=await f.open({mode:'resume'});assert.equal((await resumed.budget()).unconfirmedRequests,1);
  const head=JSON.parse(await readFile(join(resumed.directory,'head.json'),'utf8'));
  assert.deepEqual(JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes)),head);
  const status=await readRunWorkspace({...f.input,mode:'resume'});assert.equal(status.budget.httpRequests,1);
});

test('a genuine competing remote head cannot be bypassed by local tail repair',async t=>{
  const f=await fixture(t),w=await f.open();f.setFault('compete');
  await assert.rejects(w.reserveBudget(reservation),/remote_conflict/);await w.close();
  await assert.rejects(f.open({mode:'resume'}),/journal_chain|immutable_conflict/);
  const fresh=await f.open({directory:join(f.parent,'runner-two'),mode:'resume'});
  assert.equal((await fresh.budget()).unconfirmedRequests,1);
  await assert.rejects(fresh.settleBudget('pending-call',{status:'known',usage:{rowsRead:0,rowsWritten:0}}),/budget_reservation_missing/);
});

for(const corruption of ['missing','body','event','manifest'])test(`restore refuses ${corruption} corruption and wrong source/config identity`,async t=>{
  const f=await fixture(t),w=await f.open(),ref=await w.putArtifact({fixture:'canonical body'},{kind:'phase',observedAt:NOW});
  await w.writeCheckpoint(null,cp());await w.close();
  await assert.rejects(f.open({directory:join(f.parent,'wrong-source'),mode:'resume',codeSha:'c'.repeat(40)}),/manifest_mismatch/);
  const key=corruption==='event'?[...f.objects.keys()].find(key=>key.includes('/events/')&&JSON.parse(Buffer.from(f.objects.get(key).bytes)).event.type==='artifact')
    :corruption==='manifest'?'runs/test-run/manifest.json':`runs/test-run/${ref.reference}`;
  if(corruption==='missing')f.objects.delete(key);
  else{const object=f.objects.get(key),value=JSON.parse(Buffer.from(object.bytes));
    if(corruption==='body')value.value.fixture='changed';else if(corruption==='event')value.event.ref.sha256='d'.repeat(64);else value.codeSha='d'.repeat(40);
    object.bytes=encode(value);}
  await assert.rejects(f.open({directory:join(f.parent,'runner-two'),mode:'resume'}),/durable_missing|artifact_hash|journal_chain|manifest_mismatch/);
});

test('registered expiry removes only original expired bodies; locked/unexpired controls and history survive',async t=>{
  const f=await fixture(t),w=await f.open(),ref=await w.putArtifact({fixture:'expires'},{kind:'phase',observedAt:NOW});
  await w.writeCheckpoint(null,cp());const manifest=await readFile(join(w.directory,'manifest.json'));
  await assert.rejects(f.open({mode:'resume'}),/locked/);
  assert.deepEqual(await w.purgeExpired(),[]);assert.ok(f.objects.has(`runs/test-run/${ref.reference}`));
  f.setNow(LATER);await w.purgeExpired();assert.equal(f.objects.has(`runs/test-run/${ref.reference}`),false);
  assert.ok(f.objects.has('runs/test-run/manifest.json'));assert.ok(f.objects.has('runs/test-run/head.json'));
  assert.deepEqual(await readFile(join(w.directory,'manifest.json')),manifest);
  assert.deepEqual((await w.readCheckpoint({controlOnly:true})).checkpoint.owner,cp().owner);
  await w.close();const restored=await f.open({directory:join(f.parent,'runner-two'),mode:'resume'});
  assert.deepEqual((await restored.readCheckpoint({controlOnly:true})).checkpoint.owner,cp().owner);
  assert.deepEqual(await restored.purgeExpired(),[]);
  assert.equal((await lstat(join(restored.directory,'manifest.json'))).mode&0o777,0o600);
  assert.ok(f.calls.filter(([method])=>method==='remove').every(([,key])=>/\/objects\/[a-f0-9]{64}\.json$/.test(key)));
});

async function packageFixture(t,large=false){
  const f=await fixture(t);f.input.repository=join(f.parent,'source');await mkdir(f.input.repository,{mode:0o700});
  const w=await f.open(),release='sealed-release',expiry='2026-11-06T12:20:00.000Z';
  await w.preparePublicationDirectories(release,NOW,expiry);const root=join(w.directory,'packages',release);
  await mkdir(join(root,'assets'),{recursive:true,mode:0o700});
  const files={'entry.mts':Buffer.from('export default {fetch(){return new Response("fixture")}};'),
    'wrangler.json':Buffer.from(JSON.stringify({main:join(root,'entry.mts')})),
    'assets/image.bin':Buffer.alloc(large?32*1024*1024:300000,71)};
  for(const [name,bytes]of Object.entries(files))await writeFile(join(root,name),bytes,{mode:0o600});
  const inventory=await inventoryPublicationPackage(root),packageSha256=sha256(canonicalJson(inventory));
  return{...f,w,root,files,release,expiry,packageSha256};
}

test('fresh runner recreates temporary publication parents before an interrupted package was sealed',async t=>{
  const f=await packageFixture(t),owner=cp();await f.w.writeCheckpoint(null,owner);await f.w.reserveBudget(reservation);
  const head=Buffer.from(f.objects.get('runs/test-run/head.json').bytes);
  await f.w.close();await rm(f.input.directory,{recursive:true});
  f.setNow('2026-11-06T12:05:00.000Z');
  const restored=await f.open({mode:'resume'});
  await restored.preparePublicationDirectories(f.release,NOW,f.expiry);
  for(const path of ['packages','publication-runtime','publication-runtime/'+f.release,'publication-runtime/'+f.release+'/tmp'])
    assert.equal((await lstat(join(restored.directory,path))).mode&0o777,0o700);
  assert.deepEqual(Buffer.from(f.objects.get('runs/test-run/head.json').bytes),head);
  assert.deepEqual((await restored.readCheckpoint()).checkpoint,owner);
  assert.equal((await restored.budget()).unconfirmedRequests,1);
  await assert.rejects(restored.preparePublicationDirectories(f.release,'2026-11-06T12:05:00.000Z',f.expiry),/publication_directories/);
});

test('sealed exact package survives runner loss before/after upload with original paths, owner and finite expiry',async t=>{
  const f=await packageFixture(t,true);await f.w.retainPublicationPackage(f.release,f.packageSha256);
  await f.w.writeCheckpoint(null,{...cp(),state:{uploadedVersion:'synthetic-version',intent:'original unchanged intent'}});
  await f.w.reserveBudget({...reservation,id:'upload-may-have-dispatched'});
  const archived=[...f.objects.entries()].filter(([key])=>key.includes('/objects/'));
  assert.ok(archived.length>130); // A real 32MiB file crosses the bounded archive-part seam.
  for(const [,object]of archived){const body=JSON.parse(Buffer.from(object.bytes));
    if(body.publicationReleaseId){assert.equal(Date.parse(body.observedAt),Date.parse(NOW));assert.equal(body.expiresAt,f.expiry);}}
  await writeFile(join(f.w.directory,'publication-runtime',f.release,'transient-output.json'),'DO NOT COPY',{mode:0o600});
  await f.w.close();await rm(f.input.directory,{recursive:true});
  const restored=await f.open({mode:'resume'});
  assert.equal(sha256(canonicalJson(await inventoryPublicationPackage(f.root))),f.packageSha256);
  for(const [name,bytes]of Object.entries(f.files))assert.deepEqual(await readFile(join(f.root,name)),bytes);
  assert.deepEqual((await restored.readCheckpoint()).checkpoint.owner,cp().owner);
  assert.equal((await restored.readCheckpoint()).checkpoint.state.uploadedVersion,'synthetic-version');
  assert.equal((await restored.budget()).unconfirmedRequests,1);
  await assert.rejects(readFile(join(restored.directory,'publication-runtime',f.release,'transient-output.json')),/ENOENT/);
  assert.deepEqual(await restored.purgeExpired(),[]);
  f.setNow('2026-11-06T12:20:00.000Z');await restored.purgeExpired();
  for(const [key,object]of archived)if(JSON.parse(Buffer.from(object.bytes)).publicationReleaseId)assert.equal(f.objects.has(key),false);
  assert.ok(f.objects.has('runs/test-run/head.json'));assert.ok(f.objects.has('runs/test-run/manifest.json'));
  assert.deepEqual((await restored.readCheckpoint({controlOnly:true})).checkpoint.owner,cp().owner);
});

test('package restore refuses conflicting local files and changed source, never overwrites or rebinds',async t=>{
  const f=await packageFixture(t);await assert.rejects(f.w.retainPublicationPackage(f.release,'e'.repeat(64)),/publication_package/);
  await f.w.retainPublicationPackage(f.release,f.packageSha256);await f.w.close();
  await writeFile(join(f.root,'entry.mts'),'unrelated current edit',{mode:0o600});
  await assert.rejects(f.open({mode:'resume'}),/immutable_conflict/);
  assert.equal(await readFile(join(f.root,'entry.mts'),'utf8'),'unrelated current edit');
  const otherSource=join(f.parent,'different-source');await mkdir(otherSource,{mode:0o700});
  await assert.rejects(f.open({mode:'resume',repository:otherSource}),/publication_scope/);
});

for(const crash of ['before-body','after-body-before-head'])test(`runner loss ${crash} preserves cleanup identity without activating a missing/incomplete body`,async t=>{
  const f=await fixture(t),w=await f.open();await w.reserveBudget(reservation);
  const put=f.store.putImmutable.bind(f.store),cas=f.store.compareAndSwap.bind(f.store);let stopped=false;
  if(crash==='before-body')f.store.putImmutable=async(key,bytes)=>{
    if(!stopped&&key.includes('/objects/')){stopped=true;throw Error('synthetic_runner_loss');}return put(key,bytes);};
  else f.store.compareAndSwap=async(key,expected,bytes)=>{
    const next=JSON.parse(Buffer.from(bytes)),eventKey=`runs/test-run/events/${String(next.sequence).padStart(6,'0')}.${next.sha256}.json`;
    const event=f.objects.get(eventKey);
    if(!stopped&&event&&JSON.parse(Buffer.from(event.bytes)).event.type==='artifact'){stopped=true;throw Error('synthetic_runner_loss');}
    return cas(key,expected,bytes);};
  const value={fixture:'one original response'},ref={sha256:sha256(canonicalJson(value)),reference:`objects/${sha256(canonicalJson(value))}.json`};
  await assert.rejects(w.putArtifact(value,{kind:'phase',observedAt:NOW}),/synthetic_runner_loss/);
  await w.close();await rm(f.input.directory,{recursive:true});f.store.putImmutable=put;f.store.compareAndSwap=cas;
  const restored=await f.open({mode:'resume'});assert.equal((await restored.budget()).unconfirmedRequests,1);
  await assert.rejects(restored.readArtifact(ref),/unregistered_artifact/);
  assert.deepEqual(await restored.purgeExpired(),[]);
  assert.equal(f.objects.has(`runs/test-run/${ref.reference}`),crash==='after-body-before-head');
  f.setNow(LATER);const expired=await restored.purgeExpired();assert.equal(expired.length,1);
  assert.equal(f.objects.has(`runs/test-run/${ref.reference}`),false);
  assert.ok([...f.objects.values()].some(v=>{try{return JSON.parse(Buffer.from(v.bytes)).event?.type==='body-registered';}catch{return false;}}));
  assert.ok(f.objects.has('runs/test-run/manifest.json'));assert.equal((await restored.budget()).unconfirmedRequests,1);
});
