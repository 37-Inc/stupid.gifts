import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readProductRows} from '../scripts/catalog/read-product-rows.ts';

function fixture(t,count=300,size=100){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec('CREATE TABLE products(id TEXT PRIMARY KEY,title TEXT,quality_score REAL,source_record_json TEXT); CREATE TABLE catalog_maintenance_products(product_id TEXT PRIMARY KEY,version INTEGER,semantic_json TEXT,embedding_present INTEGER,embedding_native_base64 TEXT,embedding_provenance_json TEXT)');
  const ids=Array.from({length:count},(_,i)=>String(i+1).padStart(10,'0'));
  const insert=sql.prepare('INSERT INTO products VALUES(?,?,?,?)');
  sql.exec('BEGIN');for(const id of ids)insert.run(id,'A complete title',.7777777777777778,JSON.stringify({test:'"\\🦆'.repeat(size)}));sql.exec('COMMIT');
  sql.prepare('INSERT INTO catalog_maintenance_products VALUES(?,1,?,1,?,?)').run(ids[0],'{}','fixture-private-native','fixture-private-provenance');
  let calls=0,maxBytes=0,transform;
  const db={prepare(query){let params=[];return{bind(...v){params=v;return this;},async all(){calls++;
    let results=sql.prepare(query).all(...params).map(r=>({...r}));maxBytes=Math.max(maxBytes,Buffer.byteLength(JSON.stringify(results)));
    if(query.startsWith('WITH captured'))results=transform?.(results)??results;return{results};}};}};
  return{sql,db,ids,stats:()=>({calls,maxBytes}),transform(fn){transform=fn;}};
}
test('300 exact review rows preserve physical values/order in bounded pages without per-item queries',async t=>{
  const f=fixture(t),wanted=[...f.ids].reverse(),rows=await readProductRows(f.db,wanted);
  assert.deepEqual(rows,f.sql.prepare('SELECT * FROM products ORDER BY id DESC').all().map(r=>({...r})));
  assert.equal(rows[0].quality_score,.7777777777777778);assert.equal(f.stats().calls,5);assert.ok(f.stats().maxBytes<512*1024);
  t.diagnostic(JSON.stringify({baselinePointQueries:300,...f.stats()}));
});
test('escaped large rows page without truncation; semantic preparation never fetches native proof',async t=>{
  const f=fixture(t,10,5000),rows=await readProductRows(f.db,f.ids,{semantic:true});
  assert.equal(rows.length,10);assert.equal(rows[0].maintenance_semantic,'{}');
  assert.ok(rows.every(r=>r.maintenance_native===null&&r.maintenance_provenance===null));
  assert.equal(rows[0].source_record_json,f.sql.prepare('SELECT source_record_json FROM products LIMIT 1').get().source_record_json);
  assert.ok(f.stats().calls>2);assert.ok(f.stats().maxBytes<512*1024);
});
test('missing/duplicate/misordered identities and oversized rows refuse, with explicit absent-admission support',async t=>{
  const f=fixture(t,2);
  await assert.rejects(readProductRows(f.db,[...f.ids,'missing']),/read_changed/);
  assert.deepEqual((await readProductRows(f.db,[...f.ids,'missing'],{allowMissing:true})).map(r=>r.id),f.ids);
  await assert.rejects(readProductRows(f.db,[f.ids[0],f.ids[0]]),/read_bounds/);
  f.transform(rows=>rows.reverse());await assert.rejects(readProductRows(f.db,f.ids),/read_changed/);
  f.transform(null);f.sql.prepare('UPDATE products SET source_record_json=? WHERE id=?').run('x'.repeat(600000),f.ids[0]);
  await assert.rejects(readProductRows(f.db,f.ids),/read_bounds/);
});
