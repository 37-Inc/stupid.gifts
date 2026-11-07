import assert from 'node:assert/strict';
import test from 'node:test';
import {publishHostedBootstrap} from '../scripts/catalog/hosted-bootstrap.mjs';
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
const accepted={releaseId:'owned',snapshotSha256:'a'.repeat(64),receiptSha256:'b'.repeat(64)};
const prepared={acceptedCatalog:accepted,initialPointer:{control:{path:'/home/runner/.codex/private/goose-gifts-migration/bootstrap/'+ 'a'.repeat(64)+'/catalog-control.json',sha256:'c'.repeat(64)},versionReference:'owned-version',manifestSha256:'d'.repeat(64)},
  files:[{relative:'daily-catalog-care/automation-policy.json',bytes:encode({enabled:false})}]};
function store(){const data=new Map(),calls=[];let n=0;return{data,calls,async get(k){return data.get(k)??null;},
  async putImmutable(k,bytes){calls.push(k);const old=data.get(k);if(old&&!Buffer.from(old.bytes).equals(bytes))throw Error('conflict');
    const value=old??{bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(k,value);return value;},
  async compareAndSwap(k,etag,bytes){calls.push(k);if((data.get(k)?.etag??null)!==etag)throw Error('conflict');
    const value={bytes:Buffer.from(bytes),etag:'"'+(++n)+'"'};data.set(k,value);return value;},async remove(){throw Error('no deletes');}};}
test('bootstrap seeds only the exact accepted pointer and does not migrate/rebind historical runs',async()=>{
  const s=store(),result=await publishHostedBootstrap(s,prepared,null,accepted);
  assert.equal(result.localHistoricalRunsMigrated,false);
  assert.deepEqual(JSON.parse(s.data.get('pointers/last-success.json').bytes),prepared.initialPointer);
  const before=s.calls.filter(k=>k==='pointers/last-success.json').length;
  await publishHostedBootstrap(s,prepared,s.data.get('pointers/operator-inputs.json').bytes,accepted);
  assert.equal(s.calls.filter(k=>k==='pointers/last-success.json').length,before);
});
test('existing different successor or unverified acceptance refuses before any write',async()=>{
  const s=store();await assert.rejects(publishHostedBootstrap(s,prepared,null,{...accepted,receiptSha256:'f'.repeat(64)}),/bootstrap_invalid/);
  assert.equal(s.calls.length,0);
  s.data.set('pointers/last-success.json',{bytes:encode({...prepared.initialPointer,manifestSha256:'f'.repeat(64)}),etag:'"owned"'});
  await assert.rejects(publishHostedBootstrap(s,prepared,null,accepted),/successor_exists/);assert.equal(s.calls.length,0);
});
