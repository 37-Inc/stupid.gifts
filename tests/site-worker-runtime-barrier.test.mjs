import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {claimMutationOwnership,releaseMutationOwnership} from '../lib/catalog/mutation-fence.ts';
import {appendSearchDiagnostic} from '../lib/catalog/storage/d1.ts';
import {reserveSemanticSearch} from '../workers/site/semantic-budget.ts';
import {createSearchHandler} from '../workers/site/search.ts';

const scope={environment:'production',indexName:'permanent-catalog'},budgetScope={environment:'production',index:scope.indexName};
const now=new Date('2026-10-22T12:00:00.000Z');
const event=id=>({id,queryHash:'a'.repeat(64),queryLength:12,resultCount:1,topSimilarity:.8,matchType:'keyword',outcome:'ok'});
const env={ENVIRONMENT:'production',SEMANTIC_SEARCH_ENABLED:'true',SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'100',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'100000'};
const base={id:'B000000001',publicId:'00000000-0000-4000-8000-000000000001',slug:'desk-object',title:'Independent desk object',
  description:'An independently cleared useful identity.',imageUrl:'/brand/product.svg',affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=test-20',
  source:'amazon',currency:'USD',price:0,isActive:true,qualityScore:.8,eligibleUntil:null,indexable:false};
const latch=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
async function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of(await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())
    sql.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  let before;
  const db={prepare(query){let params=[];return{bind(...values){params=values;return this;},
    async all(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},
    async run(){await before?.(query);const result=sql.prepare(query).run(...params);return{success:true,meta:{changes:result.changes}};}};},
    async batch(statements){sql.exec('BEGIN');try{for(const s of statements)await s.run();sql.exec('COMMIT');}catch(error){sql.exec('ROLLBACK');throw error;}}};
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const owner=phase=>claimMutationOwnership(db,scope,{phase,ownerReference:'capture',operationKey:'b'.repeat(64)});
  const state=()=>({diagnostics:sql.prepare('SELECT * FROM search_diagnostics ORDER BY id').all(),
    budget:sql.prepare('SELECT * FROM semantic_search_budgets ORDER BY utc_day,index_scope').all()});
  const handler=embed=>createSearchHandler({catalogRevision:'sealed',now:()=>now.getTime(),providerTimeoutMs:1000,semanticBudgetScope:budgetScope,
    adapters:{storage:()=>({async byPublicIds(){return[base];},async keyword(){return[base];}}),
      reserveSemantic:(s,t,e)=>reserveSemanticSearch(db,s,e,t),embed,
      diagnostic:e=>appendSearchDiagnostic(db,e,now)}});
  return{sql,db,owner,state,handler,setBefore(fn){before=fn;},async request(handler,vector){return handler(new Request('https://stupid.gifts/api/search-products?q=desk+object'),
    {...env,VECTORIZE:{query:vector??(async()=>({matches:[]}))}});}};
}
test('owned capture blocks diagnostic/historical budget writes without gating read-only search',async t=>{
  for(const phase of ['writing','freezing']){
    const f=await fixture(t);await appendSearchDiagnostic(f.db,event('old'),new Date('2020-01-01T00:00:00.000Z'));
    f.sql.prepare("INSERT INTO semantic_search_budgets VALUES('production','old-index','2020-01-01',1,1,1,1)").run();
    assert.equal(await reserveSemanticSearch(f.db,budgetScope,env,20),true);
    const owner=await f.owner(phase),before=f.state();let providers=0;
    assert.equal(await reserveSemanticSearch(f.db,budgetScope,env,20),false);
    await assert.rejects(appendSearchDiagnostic(f.db,event('new'),now));
    const body=await(await f.request(f.handler(async()=>{providers++;return Array(1536).fill(.1);}))).json();
    assert.equal(body.results[0].id,base.id);assert.equal(body.results[0].matchType,'keyword');assert.equal(body.searchId,null);
    assert.equal(providers,1);assert.deepEqual(f.state(),before);
    await releaseMutationOwnership(f.db,owner);assert.equal(await reserveSemanticSearch(f.db,budgetScope,env,20),true);
    await appendSearchDiagnostic(f.db,event('released'),now);assert.equal(f.state().diagnostics.length,1);
  }
});
test('search during capture cannot touch budget storage or fail because that storage is unavailable',async t=>{
  const f=await fixture(t);let providers=0;
  f.setBefore(async query=>{if(query.includes('semantic_search_budgets'))throw Error('Budget writes must not run');});
  const owner=await f.owner('freezing'),before=f.state();
  const body=await(await f.request(f.handler(async()=>{providers++;return Array(1536).fill(.1);}))).json();
  assert.equal(body.results[0].matchType,'keyword');assert.equal(body.searchId,null);assert.equal(providers,1);assert.deepEqual(f.state(),before);
  await releaseMutationOwnership(f.db,owner);
});
test('provider begun before ownership cannot write late diagnostics or settle/debit after capture',async t=>{
  const f=await fixture(t),started=latch(),finish=latch();let vectors=0;
  const pending=f.request(f.handler(async()=>{started.resolve();await finish.promise;return Array(1536).fill(.1);}),async()=>{vectors++;return{matches:[]};});
  await started.promise;const owner=await f.owner('freezing'),before=f.state();finish.resolve();const body=await(await pending).json();
  assert.equal(body.results[0].matchType,'keyword');assert.equal(body.searchId,null);assert.equal(vectors,1);assert.deepEqual(f.state(),before);
  assert.equal(before.budget.length,0);await releaseMutationOwnership(f.db,owner);
});
