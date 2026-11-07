import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,chmod,rm,realpath,readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openRunWorkspace,readRunWorkspace} from '../scripts/catalog/run-workspace.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';

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

for(const fault of ['before','after-unreadable'])test(`same local resume reconciles ${fault} without local-only repair or losing a charge`,async t=>{
  const f=await fixture(t),w=await f.open();f.setFault(fault);let dispatched=false;
  await assert.rejects(async()=>{await w.reserveBudget(reservation);dispatched=true;},/unknown/);assert.equal(dispatched,false);
  await assert.rejects(w.budget(),/journal_uncertain/);await w.close();f.readable();
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
  const key=corruption==='event'?[...f.objects.keys()].find(key=>key.includes('/events/'))
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
