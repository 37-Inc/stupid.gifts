import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {consumeAdminAdmissions} from '../scripts/catalog/admin-admissions.mjs';
import {createContentRequestStore} from '../lib/catalog/content-admin.ts';

async function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(await readFile(new URL('../migrations/d1/0018_content_admin_requests.sql',import.meta.url),'utf8'));
  sql.exec("CREATE TABLE products(id TEXT PRIMARY KEY,public_id TEXT);CREATE TABLE content_admin_results(request_id TEXT PRIMARY KEY,state TEXT,result_json TEXT,created_at TEXT);");
  const db={prepare(query){let params=[];return{bind(...p){params=p;return this;},async all(){return{results:sql.prepare(query).all(...params)};},async run(){return sql.prepare(query).run(...params);}};},
    async batch(statements){sql.exec('BEGIN');try{for(const s of statements)await s.run();sql.exec('COMMIT');}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const pending={value:null},runtime={durable:{async get(){return{bytes:Buffer.from(JSON.stringify({pending:pending.value}))};}}};
  const request=async(asin,id)=>createContentRequestStore(db).save({requestId:id,resource:'/admissions/'+asin,action:'admit',payload:{asin},
    actor:'staff',reason:'Owner picked this gift',baseCatalogRevision:'accepted',expectedRevision:0},'2026-11-11T12:00:00.000Z');
  return{sql,db,runtime,pending,request};
}
test('admin queue is inert when empty or unrelated catalog work is pending',async t=>{
  const f=await fixture(t),options={...f,source:'a'.repeat(40),day:'2026-11-11',coordinate:()=>{throw Error('must not run');}};
  assert.equal((await consumeAdminAdmissions(options)).state,'empty');
  await f.request('B000000001','admin-admission-one');f.pending.value={path:'original-pending'};
  assert.equal((await consumeAdminAdmissions(options)).state,'waiting');assert.equal(f.sql.prepare('SELECT count(*) n FROM content_admin_results').get().n,0);
});
test('exact claimed cohort/date survives retries and late requests, admission settlement does not refetch',async t=>{
  const f=await fixture(t);await f.request('B000000001','admin-admission-one');let calls=0;
  const options={...f,source:'a'.repeat(40),day:'2026-11-11',coordinate:async input=>{calls++;
    assert.deepEqual(input.admitAsins,['B000000001']);assert.equal(input.day,'2026-11-11');
    if(calls===1)return{state:'attention',runKey:'original-admission',errorCode:'pending'};
    f.sql.prepare('INSERT OR IGNORE INTO products VALUES(?,?)').run('B000000001','public-one');
    return{state:'accepted',runKey:'original-admission',releaseId:'accepted-new',receiptSha256:'c'.repeat(64)};}};
  await consumeAdminAdmissions(options);await f.request('B000000002','admin-admission-two');
  assert.equal((await consumeAdminAdmissions({...options,day:'2026-11-12'})).state,'accepted');
  const row=f.sql.prepare('SELECT state,result_json FROM content_admin_results').get();assert.equal(row.state,'applied');
  assert.equal(JSON.parse(row.result_json).publicId,'public-one');assert.equal(f.sql.prepare('SELECT count(*) n FROM content_admin_results').get().n,1);
});
test('known held/private identities settle without supplier calls; rejected admissions are not called published products',async t=>{
  const f=await fixture(t);await f.request('B000000001','admin-admission-known');f.sql.exec("INSERT INTO products VALUES('B000000001','held-one')");
  const options={...f,source:'a'.repeat(40),day:'2026-11-11',coordinate:()=>{throw Error('no fetch');}};
  assert.equal((await consumeAdminAdmissions(options)).state,'settled');
  await f.request('B000000002','admin-admission-rejected');
  await consumeAdminAdmissions({...options,coordinate:async()=>({state:'accepted',runKey:'rejected',releaseId:'accepted',receiptSha256:'c'.repeat(64)})});
  assert.equal(JSON.parse(f.sql.prepare("SELECT result_json FROM content_admin_results WHERE request_id='admin-admission-rejected'").get().result_json).outcome,'not_admitted');
});
