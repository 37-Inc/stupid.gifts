import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {beginAvailabilityPublication} from '../scripts/catalog/availability-publication.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
test('policy-only publication records zero provider/product work and resumes a lost checkpoint without repeating telemetry',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  for(const n of (await fs.readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())sql.exec(await fs.readFile(new URL('../migrations/d1/'+n,import.meta.url),'utf8'));
  const scope={environment:'staging',indexName:'policy-test'};
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const db={prepare(q){let a=[];return{bind(...v){a=v;return this;},async all(){return{results:sql.prepare(q).all(...a).map(r=>({...r}))};},async run(){return{success:true,meta:{changes:sql.prepare(q).run(...a).changes}};},execute(){return sql.prepare(q).all(...a);}};},
    async batch(items){sql.exec('BEGIN');try{const r=items.map(s=>({results:s.execute()}));sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'availability-policy-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const inputs={};for(const name of ['previous','context','rights']){const bytes='{}\n',file=path.join(dir,name+'.json');await fs.writeFile(file,bytes);inputs[name]={path:file,sha256:sha256(bytes),observedAt:new Date().toISOString()};}
  const config={runId:'policy-only',catalogRevision:'policy-only',environment:scope.environment,vectorIndex:{name:scope.indexName},codeSha:'a'.repeat(40),inputs};
  let cp=null,sequence=0,lose=true,network=0;const raw=globalThis.fetch;t.after(()=>{globalThis.fetch=raw;});globalThis.fetch=async()=>{network++;throw Error('Live providers forbidden');};
  const w={async readCheckpoint(){return cp;},async putArtifact(value){const h=sha256(canonicalJson(value));return{sha256:h,reference:'objects/'+h+'.json'};},
    async writeCheckpoint(prior,checkpoint){assert.equal(prior,cp?.sha256??null);if(checkpoint.phase==='phases_complete'&&lose){lose=false;throw Error('Synthetic lost local finish');}
      cp={sha256:sha256(String(++sequence)),checkpoint:structuredClone(checkpoint)};return cp;}};
  const input={workspace:w,db,config,configSha256:'b'.repeat(64)};
  await assert.rejects(beginAvailabilityPublication(input),/Synthetic lost local finish/);
  assert.equal(cp.checkpoint.phase,'phases_running');assert.equal(sql.prepare('SELECT count(*) n FROM catalog_runs').get().n,1);
  await beginAvailabilityPublication(input);assert.equal(cp.checkpoint.phase,'phases_complete');
  const changes=sql.prepare('SELECT total_changes() n').get().n;await beginAvailabilityPublication(input);
  assert.equal(sql.prepare('SELECT total_changes() n').get().n,changes);assert.equal(network,0);
  assert.equal(sql.prepare('SELECT count(*) n FROM products').get().n,0);
  assert.equal(sql.prepare('SELECT count(*) n FROM catalog_maintenance_operations WHERE changes_json!=\'[]\'').get().n,0);
});
