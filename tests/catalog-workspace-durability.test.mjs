import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,chmod,rm,realpath,readFile,readdir,lstat,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
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

test('publication progress and summary survive supplier expiry and cold restore without renewing evidence',async t=>{
  const f=await fixture(t),w=await f.open({publicationControls:true});
  const body=await w.putArtifact({title:'finite supplier body'},{kind:'phase',observedAt:NOW});
  const summary={counts:{refreshed:2},timingsMs:{productPreparation:100},usage:{embedding:2},warnings:[]};
  const phaseComplete=await w.putPublicationControl('summary',summary);
  const checkpoint={...cp(),phase:'freezing',state:{vectorOffset:0,vectorIds:[]},pins:{body},phaseComplete};
  const first=await w.writeCheckpoint(null,checkpoint);await w.reserveBudget(reservation);
  f.setNow(LATER);await w.purgeExpired();
  await assert.rejects(w.readArtifact(body),/expired/);
  const second=await w.writeCheckpoint(first.sha256,{...checkpoint,state:{vectorOffset:1,vectorIds:[]}});
  await assert.rejects(w.writeCheckpoint(second.sha256,{...second.checkpoint,state:{title:'do not retain supplier content'}}),/publication_control_invalid/);
  await assert.rejects(w.putPublicationControl('summary',{...summary,counts:{products:[{title:'unsafe'}]}}));
  await w.close();
  const restored=await f.open({directory:join(f.parent,'publication-runner'),mode:'resume'});
  assert.deepEqual(await restored.readCheckpoint(),second);
  assert.deepEqual(await restored.readArtifact(phaseComplete),summary);
  assert.equal((await restored.budget()).unconfirmedRequests,1);
  await assert.rejects(restored.readArtifact(body),/expired/);
  await assert.rejects(restored.putArtifact({title:'not renewed'},{kind:'phase',observedAt:LATER}),/expired/);
  const third=await restored.writeCheckpoint(second.sha256,{...second.checkpoint,state:{vectorOffset:2,vectorIds:[]}});
  assert.equal(third.checkpoint.state.vectorOffset,2);
  await assert.rejects(restored.writeCheckpoint(second.sha256,checkpoint),/checkpoint_cas/);
});

test('legacy expired control can advance with old immutable pins; no expired body is restored',async t=>{
  const f=await fixture(t),w=await f.open();
  const body=await w.putArtifact({title:'old supplier body'},{kind:'phase',observedAt:NOW});
  const original=await w.writeCheckpoint(null,{...cp(),pins:{body},state:{vectorOffset:0}});
  await w.close();f.setNow(LATER);
  const restored=await f.open({mode:'resume',publicationControls:true});await restored.purgeExpired();
  await assert.rejects(restored.readCheckpoint(),/expired/);
  const summary=await restored.putPublicationControl('summary',{counts:{originalPhases:null},timingsMs:{},usage:null,warnings:[]});
  const next=await restored.writeCheckpoint(original.sha256,{...original.checkpoint,state:{},pins:{body,publicationSummary:summary}});
  assert.deepEqual(await restored.readCheckpoint(),next);
  await assert.rejects(restored.readArtifact(body),/expired/);
  await assert.rejects(restored.writeCheckpoint(next.sha256,{...next.checkpoint,pins:{publicationSummary:summary}}),/pin_rewrite/);
});

test('catalog-sized publication metadata survives both cold and warm runner recovery',async t=>{
  const f=await fixture(t),w=await f.open({publicationControls:true});
  const reviews=Array.from({length:10000},(_,i)=>({id:'B'+String(i).padStart(9,'0'),sourceSha256:HASH,appeal:'giftable'}));
  assert.ok(encode(reviews).length>1024*1024);
  const ref=await w.putPublicationControl('appeals',reviews);
  await w.close();f.setNow(LATER);
  // The first inspect restores R2 to disk; the following operator reopens that
  // same verified cache. Both must use the control artifact's 8 MiB reader.
  const directory=join(f.parent,'large-control-runner');
  const cold=await f.open({directory,mode:'resume',publicationControls:true});
  assert.deepEqual(await cold.readArtifact(ref),reviews);await cold.close();
  const warm=await f.open({directory,mode:'resume',publicationControls:true});
  assert.deepEqual(await warm.readArtifact(ref),reviews);
});

test('blob transfer batches metadata without changing any chunk bytes, hash, deadline or final ACK',async t=>{
  const f=await fixture(t),w=await f.open(),bytes=Buffer.alloc(8*1024*1024,7),count=32;
  const put=f.store.putImmutable,cas=f.store.compareAndSwap;let active=0,peak=0,acknowledged=0;
  f.calls.length=0;
  f.store.putImmutable=async(key,body)=>{
    const value=JSON.parse(Buffer.from(body));if(value.value?.type!=='run-workspace-chunk')return put(key,body);
    const head=JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes));
    const event=JSON.parse(Buffer.from(f.objects.get(`runs/test-run/events/${String(head.sequence).padStart(6,'0')}.${head.sha256}.json`).bytes)).event;
    assert.equal(event.type,'blob-bodies');assert.equal(event.artifacts.length,count);
    active++;peak=Math.max(peak,active);
    try{await new Promise(resolve=>setTimeout(resolve,2));const result=await put(key,body);acknowledged++;return result;}finally{active--;}
  };
  f.store.compareAndSwap=async(key,expected,body)=>{
    const head=JSON.parse(Buffer.from(body)),record=f.objects.get(`runs/test-run/events/${String(head.sequence).padStart(6,'0')}.${head.sha256}.json`);
    if(record&&JSON.parse(Buffer.from(record.bytes)).event.type==='blob-parts'){
      assert.equal(acknowledged,count);assert.equal(active,0);
    }
    return cas(key,expected,body);
  };
  const ref=await w.putBlob(bytes,{kind:'phase',observedAt:NOW});
  assert.ok(peak>1&&peak<=16);assert.equal(acknowledged,count);
  assert.equal(f.calls.filter(([method])=>method==='cas').length,4); // formerly 2*32+2
  const descriptor=await w.readArtifact(ref);assert.equal(descriptor.chunkBytes,256*1024);assert.equal(descriptor.parts.length,count);
  await w.close();const restored=await f.open({directory:join(f.parent,'batch-runner'),mode:'resume'});
  assert.deepEqual(await restored.readBlob(ref),bytes);
  const stored=JSON.parse(Buffer.from(f.objects.get(`runs/test-run/${ref.reference}`).bytes));
  assert.equal(Date.parse(stored.observedAt),Date.parse(NOW));assert.equal(stored.expiresAt,'2026-11-06T13:00:00.000Z');
});

for(const all of [false,true])test(`${all?'Entire':'Partial'} parallel blob failure joins transfers and resumes original retention without activating missing parts`,async t=>{
  const f=await fixture(t),w=await f.open(),bytes=Buffer.alloc(2*1024*1024,8),put=f.store.putImmutable;
  await w.reserveBudget(reservation);let active=0;
  f.store.putImmutable=async(key,body)=>{
    const value=JSON.parse(Buffer.from(body));if(value.value?.type!=='run-workspace-chunk')return put(key,body);
    active++;try{await new Promise(resolve=>setTimeout(resolve,2));if(all||value.value.index===2)throw Error('body_transfer_unknown');return await put(key,body);}finally{active--;}
  };
  await assert.rejects(w.putBlob(bytes,{kind:'phase',observedAt:NOW}),/body_transfer_unknown/);assert.equal(active,0);
  const head=JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes));
  assert.equal(JSON.parse(Buffer.from(f.objects.get(`runs/test-run/events/${String(head.sequence).padStart(6,'0')}.${head.sha256}.json`).bytes)).event.type,'blob-bodies');
  await w.close();f.store.putImmutable=put;f.setNow('2026-11-06T12:05:00.000Z');
  const restored=await f.open({directory:join(f.parent,'partial-batch-runner'),mode:'resume'});
  assert.equal((await restored.budget()).unconfirmedRequests,1);
  const ref=await restored.putBlob(bytes,{kind:'phase',observedAt:'2026-11-06T12:05:00.000Z'});
  assert.deepEqual(await restored.readBlob(ref),bytes);
  assert.equal(JSON.parse(Buffer.from(f.objects.get(`runs/test-run/${ref.reference}`).bytes)).expiresAt,'2026-11-06T13:00:00.000Z');
});

test('original single-part journal records remain readable and reusable without rewriting history',async t=>{
  const f=await fixture(t),w=await f.open(),bytes=Buffer.alloc(300000,9),digest=b=>createHash('sha256').update(b).digest('hex');
  const parts=[];
  for(let index=0;index<2;index++){
    const part=bytes.subarray(index*256*1024,(index+1)*256*1024);
    parts.push((await w.putArtifact({schemaVersion:1,type:'run-workspace-chunk',blobSha256:digest(bytes),blobByteLength:bytes.length,
      index,count:2,sha256:digest(part),byteLength:part.length,base64:part.toString('base64')},{kind:'phase',observedAt:NOW})).sha256);
  }
  const ref=await w.putArtifact({schemaVersion:1,type:'run-workspace-blob',sha256:digest(bytes),byteLength:bytes.length,chunkBytes:256*1024,parts},
    {kind:'phase',observedAt:NOW});const head=Buffer.from(f.objects.get('runs/test-run/head.json').bytes);
  await w.close();const restored=await f.open({directory:join(f.parent,'legacy-blob-runner'),mode:'resume'});
  assert.deepEqual(await restored.readBlob(ref),bytes);
  assert.deepEqual(await restored.putBlob(bytes,{kind:'phase',observedAt:'2026-11-06T12:05:00.000Z'}),ref);
  assert.deepEqual(Buffer.from(f.objects.get('runs/test-run/head.json').bytes),head);
});

for(const corrupt of [false,true])test(`cold body restore is parallel, joined and read-only${corrupt?' on corruption':''}`,async t=>{
  const f=await fixture(t),w=await f.open(),bytes=Buffer.alloc(8*1024*1024,11),ref=await w.putBlob(bytes,{kind:'phase',observedAt:NOW});
  await w.reserveBudget(reservation);await w.close();const head=Buffer.from(f.objects.get('runs/test-run/head.json').bytes),get=f.store.get;
  let active=0,peak=0;
  if(corrupt){const descriptor=JSON.parse(Buffer.from(f.objects.get(`runs/test-run/${ref.reference}`).bytes)).value;
    const key=`runs/test-run/objects/${descriptor.parts[0]}.json`,body=JSON.parse(Buffer.from(f.objects.get(key).bytes));
    body.value.base64='invalid';f.objects.get(key).bytes=encode(body);}
  f.store.get=async key=>{if(!key.includes('/objects/'))return get(key);active++;peak=Math.max(peak,active);
    try{await new Promise(resolve=>setTimeout(resolve,2));return await get(key);}finally{active--;}};
  f.calls.length=0;
  if(corrupt)await assert.rejects(f.open({directory:join(f.parent,'body-corrupt-runner'),mode:'resume'}),/artifact_hash|body_registration/);
  else{const restored=await f.open({directory:join(f.parent,'body-parallel-runner'),mode:'resume'});
    assert.deepEqual(await restored.readBlob(ref),bytes);assert.equal((await restored.budget()).unconfirmedRequests,1);}
  assert.ok(peak>1&&peak<=16);assert.equal(active,0);
  assert.deepEqual(Buffer.from(f.objects.get('runs/test-run/head.json').bytes),head);
  assert.ok(f.calls.every(([method])=>method==='get'));
});

test('cold journal reads are parallel but original hash chain, charges and write ordering stay authoritative',async t=>{
  const f=await fixture(t),w=await f.open({requestLimit:'observe'});
  for(let i=0;i<24;i++)await w.reserveBudget({...reservation,id:'original-'+i});await w.close();
  const head=Buffer.from(f.objects.get('runs/test-run/head.json').bytes),get=f.store.get;
  let active=0,peak=0;
  f.store.listJournal=async()=>[...f.objects.keys()].filter(k=>k.startsWith('runs/test-run/events/')).map(k=>k.slice('runs/test-run/'.length)).reverse();
  f.store.get=async key=>{if(!key.includes('/events/'))return get(key);active++;peak=Math.max(peak,active);
    try{await new Promise(resolve=>setTimeout(resolve,2));return await get(key);}finally{active--;}};
  f.calls.length=0;const restored=await f.open({directory:join(f.parent,'parallel-runner'),mode:'resume',requestLimit:'observe'});
  assert.ok(peak>1&&peak<=16);assert.equal((await restored.budget()).unconfirmedRequests,24);
  assert.deepEqual(Buffer.from(f.objects.get('runs/test-run/head.json').bytes),head);
  assert.ok(f.calls.every(([method])=>method==='get'));await restored.reserveBudget({...reservation,id:'continuation'});
  assert.equal(JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes)).sequence,25);
  await restored.close();
  const event=[...f.objects.keys()].find(k=>k.includes('/events/000001.'));
  f.objects.get(event).bytes=encode({corrupt:true});
  await assert.rejects(f.open({directory:join(f.parent,'corrupt-parallel-runner'),mode:'resume',requestLimit:'observe'}),/journal_chain/);
});

test('lost remote CAS ACK is reconciled by exact readback',async t=>{
  const f=await fixture(t),w=await f.open();f.setFault('after');await w.reserveBudget(reservation);
  assert.equal((await w.budget()).unconfirmedRequests,1);
  assert.equal(f.calls.filter(([method])=>method==='cas').length,2); // initial head + reservation, no redispatch
});

test('a long recovery preserves all charges and appends beyond the former journal count limit',async t=>{
  const f=await fixture(t),first=await f.open({requestLimit:'observe'});await first.close();
  let sequence=0,parent=null;
  const seed=event=>{const record={schemaVersion:1,sequence:++sequence,parent,event};parent=sha256(canonicalJson(record));
    f.objects.set(`runs/test-run/events/${String(sequence).padStart(6,'0')}.${parent}.json`,{bytes:encode(record),etag:`"seed-${sequence}"`});};
  for(let i=0;i<10_001;i++){
    seed({type:'reserve',reservation:{id:`saved-${i}`,requestSha256:HASH,units:{httpRequests:1,sqlStatements:1}}});
    seed({type:'settle',id:`saved-${i}`,settlement:i===0?{status:'unknown',usage:null}:{status:'known',usage:{rowsRead:1,rowsWritten:0}}});
  }
  f.objects.set('runs/test-run/head.json',{bytes:encode({sequence,sha256:parent}),etag:'"saved-head"'});
  const originalHead=Buffer.from(f.objects.get('runs/test-run/head.json').bytes);
  const resumed=await f.open({directory:join(f.parent,'runner-two'),mode:'resume',requestLimit:'observe'});
  assert.deepEqual(await resumed.budget(),{httpRequests:10_001,sqlStatements:10_001,knownRowsRead:10_000,knownRowsWritten:0,unconfirmedRequests:1});
  assert.deepEqual(Buffer.from(f.objects.get('runs/test-run/head.json').bytes),originalHead);
  await resumed.reserveBudget({...reservation,id:'same-run-continuation'});
  assert.equal(JSON.parse(Buffer.from(f.objects.get('runs/test-run/head.json').bytes)).sequence,20_003);
  assert.equal((await resumed.budget()).unconfirmedRequests,2);
  assert.equal(f.objects.size,20_005); // manifest, head, every old event and the new event; nothing pruned.
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
  assert.equal(await w.retainedBodies(),false);
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
