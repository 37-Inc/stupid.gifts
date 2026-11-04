import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { createSearchHandler } from '../workers/site/search.ts';
import { derivedFixture, derivedWorker } from './helpers/derived-search-fixture.mjs';

const NOW = Date.parse('2026-10-19T12:00:00Z');
const product = { id:'one',publicId:'public-one',slug:'one',title:'Funny Fart Button',description:'A ridiculous gift.',
  imageUrl:'/brand/button.svg',affiliateUrl:'https://www.amazon.com/dp/B123456789?tag=test-20',source:'amazon',currency:'USD',
  price:0,isActive:true,qualityScore:.8,eligibleUntil:'2027-01-01T00:00:00.000Z' };
function setup(options={}) {
  const calls={embed:[],vector:0,budget:0};
  const env={ENVIRONMENT:'staging',SEMANTIC_SEARCH_ENABLED:'true',VECTORIZE:{async query(){calls.vector++;return{matches:[{id:'public-one',score:.9}]};}},...options.env};
  const handler=createSearchHandler({catalogRevision:'fixture',now:()=>NOW,providerTimeoutMs:1000,
    semanticBudgetScope:{environment:'staging',index:'fixture-index'},adapters:{
      storage:()=>({async byPublicIds(){return[product];},async keyword(){return[{...product,id:'keyword'}];}}),
      async embed(query){calls.embed.push(query);return Array(1536).fill(.1);},
      // A stale/custom adapter cannot reinstate the retired budget gate.
      async reserveSemantic(){calls.budget++;throw Error('Retired budget unavailable');},
      ...options.adapters,
    },...options.config});
  return{env,calls,request:(query='funny button',client='fixture')=>handler(new Request(
    `https://example.test/api/search-products?q=${encodeURIComponent(query)}`,{headers:{'CF-Connecting-IP':client}}),env)};
}
const mode=async response=>(await response.json()).results[0]?.matchType;

test('more than50 distinct searches remain semantic without any daily request/token reservation',async()=>{
  const f=setup({env:{SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'50',SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'1'}});
  const responses=await Promise.all(Array.from({length:80},(_,i)=>f.request(`funny button ${i}`,`client-${i%10}`)));
  assert.equal((await Promise.all(responses.map(mode))).filter(value=>value==='semantic').length,80);
  assert.equal(f.calls.embed.length,80);assert.equal(f.calls.vector,80);assert.equal(f.calls.budget,0);
});

test('missing, exhausted or malformed historical cap configuration cannot disable search',async()=>{
  for(const value of [undefined,'','0','-1','invalid','50','32768']){
    const f=setup({env:{SEMANTIC_SEARCH_DAILY_REQUEST_CAP:value,SEMANTIC_SEARCH_DAILY_TOKEN_CAP:value}});
    assert.equal(await mode(await f.request()),'semantic');assert.equal(f.calls.budget,0);
  }
});

test('real Worker ignores exhausted historical D1 budgets and never accesses budget storage',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(await readFile(new URL('../migrations/d1/0006_semantic_search_budget.sql',import.meta.url),'utf8'));
  sql.prepare('INSERT INTO semantic_search_budgets VALUES(?,?,?,?,?,?,?)')
    .run('staging','synthetic-derived-index','2026-10-26',50,32768,50,32768);
  const before=sql.prepare('SELECT * FROM semantic_search_budgets').all();let databaseCalls=0;
  const f=await derivedFixture(),w=derivedWorker(f,{env:{DB:{prepare(){databaseCalls++;throw Error('Budget DB unavailable');}}}});
  const {response,body}=await w.request();assert.equal(response.status,200);assert.equal(body.results[0].matchType,'semantic');
  assert.equal(databaseCalls,0);assert.equal(w.calls.embed,1);assert.equal(w.calls.vector.length,1);
  assert.deepEqual(sql.prepare('SELECT * FROM semantic_search_budgets').all(),before);
});

test('explicit opt-in and compiled environment/index scope still protect semantic serving',async()=>{
  for(const options of [{env:{SEMANTIC_SEARCH_ENABLED:undefined}},{env:{SEMANTIC_SEARCH_ENABLED:'false'}},
    {env:{ENVIRONMENT:'production'}},{env:{ENVIRONMENT:'preview'}},{config:{semanticBudgetScope:undefined}},
    {config:{semanticBudgetScope:{environment:'staging',index:'../unsafe'}}},
    {env:{VECTORIZE:undefined}},{adapters:{embed:undefined}}]){
    const f=setup(options);assert.equal(await mode(await f.request()),'keyword');assert.equal(f.calls.embed.length,0);
    assert.equal(f.calls.vector,0);assert.equal(f.calls.budget,0);
  }
});

test('cache, normalized query and kill switch work without a budget allocation',async()=>{
  const f=setup();assert.equal(await mode(await f.request('  Ａ   お誕生日 🔥  ')),'semantic');
  assert.equal(await mode(await f.request('A お誕生日 🔥')),'semantic');assert.deepEqual(f.calls.embed,['A お誕生日 🔥']);
  f.env.SEMANTIC_SEARCH_ENABLED='false';assert.equal(await mode(await f.request('A お誕生日 🔥')),'keyword');
  assert.equal(f.calls.embed.length,1);assert.equal(f.calls.budget,0);
});

test('provider failures fall back immediately without refund, reservation or background retries',async()=>{
  let attempts=0;const f=setup({adapters:{async embed(){attempts++;throw Error('PRIVATE_PROVIDER_BODY');}}});
  const response=await f.request();assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.results[0].matchType,'keyword');assert.equal(attempts,1);assert.equal(f.calls.vector,0);
  assert.equal(f.calls.budget,0);assert.doesNotMatch(JSON.stringify(body),/PRIVATE/);
});
