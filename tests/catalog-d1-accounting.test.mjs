import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalogD1Rest } from '../scripts/catalog/d1-write-rest.ts';

const config={accountId:'a'.repeat(32),databaseId:'00000000-0000-4000-8000-000000000001',databaseName:'test-only',token:'TEST_ONLY'};
const scope={accountId:config.accountId,databaseId:config.databaseId,databaseName:config.databaseName};
function fixture({requests=20,statements=20}={}){
  const entries=new Map();let calls=0,failReserve=false,failSettle=false,failResponse=false,loseAck=false,settlements=0;
  const state=()=>({httpRequests:entries.size,sqlStatements:[...entries.values()].reduce((n,r)=>n+r.units.sqlStatements,0),
    knownRowsRead:[...entries.values()].reduce((n,r)=>n+(r.result?.usage?.rowsRead||0),0),
    knownRowsWritten:[...entries.values()].reduce((n,r)=>n+(r.result?.usage?.rowsWritten||0),0),
    unconfirmedRequests:[...entries.values()].filter(r=>r.result?.status!=='known').length});
  const accounting=()=>({scope,initial:state(),async reserve(input){
    if(failReserve)throw new Error(failReserve);
    assert.match(input.requestSha256,/^[a-f0-9]{64}$/);assert.deepEqual(Object.keys(input).sort(),['id','requestSha256','units']);
    assert.equal(entries.has(input.id),false);const old=state();
    if(old.httpRequests+1>requests||old.sqlStatements+input.units.sqlStatements>statements)throw new Error('test-only cap');
    entries.set(input.id,structuredClone(input));
  },async settle(id,result){settlements++;if(failSettle)throw new Error('PRIVATE ledger failure');entries.get(id).result=structuredClone(result);
    if(loseAck){loseAck=false;throw new Error('PRIVATE committed settlement acknowledgement loss');}}});
  const fetch=async(url,init)=>{
    calls++;assert.equal(entries.size,calls); // Durable reservation precedes EVERY request, including identity.
    if(failResponse){failResponse=false;throw new Error('PRIVATE lost result');}
    if(init.method==='GET')return Response.json({success:true,result:{uuid:config.databaseId,name:config.databaseName,read_replication:{mode:'disabled'}}});
    const batch=JSON.parse(init.body).batch;
    return Response.json({success:true,result:batch.map(q=>({success:true,results:q.sql.includes('catalog_d1_primary')?[{catalog_d1_primary:1}]:[{value:1}],
      meta:{served_by_primary:true,rows_read:1,rows_written:0}}))});
  };
  return{accounting,fetch,state,entries,calls:()=>calls,settlements:()=>settlements,setReserveFailure(message='PRIVATE ledger failure'){failReserve=message;},setSettleFailure(value=true){failSettle=value;},
    loseSettlementAck(){loseAck=true;},loseResponse(){failResponse=true;}};
}
test('restored exact-scoped durable reservations precede network; independent clients share finite caps',async()=>{
  const f=fixture({requests:5});const a=await createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()});
  const b=await createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()});
  const outcomes=await Promise.allSettled([a.prepare('SELECT 1').all(),b.prepare('SELECT 1').all()]);
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls(),5);assert.equal(f.state().httpRequests,5);
  assert.equal(f.state().unconfirmedRequests,0);
  assert.doesNotMatch(JSON.stringify([...f.entries.values()]),/SELECT|TEST_ONLY|Authorization|params/);
});
test('reservation failure sends nothing; unacknowledged response settlement refuses success and survives restart as unknown',async()=>{
  const f=fixture();const db=await createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()});
  f.setReserveFailure();await assert.rejects(db.prepare('SELECT 1').all(),/^Error: catalog_d1_accounting_reservation_failed$/);assert.equal(f.calls(),2);
  const g=fixture();const first=await createCatalogD1Rest({...config,fetch:g.fetch,accounting:g.accounting()});
  g.setSettleFailure();await assert.rejects(first.prepare('SELECT 1').all(),/^Error: catalog_d1_accounting_unknown$/);
  assert.equal(g.calls(),3);assert.equal(first.metrics().unconfirmedRequests,1);assert.equal(g.state().unconfirmedRequests,1);
  g.setSettleFailure(false);
  const second=await createCatalogD1Rest({...config,fetch:g.fetch,accounting:g.accounting()});
  assert.equal(second.metrics().requests,5);assert.equal(second.metrics().reportedRowsRead,null);assert.equal(second.metrics().reportedRowsWritten,null);
});
test('accounting preserves safe workspace errors but never exposes arbitrary adapter errors',async()=>{
  const f=fixture(),db=await createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()});
  f.setReserveFailure('run_workspace_journal_uncertain');
  await assert.rejects(db.prepare('SELECT 1').all(),/^Error: run_workspace_journal_uncertain$/);
  assert.equal(f.calls(),2);
  f.setReserveFailure('PRIVATE provider credential or body');
  await assert.rejects(db.prepare('SELECT 1').all(),/^Error: catalog_d1_accounting_reservation_failed$/);
  assert.equal(f.calls(),2);
});

test('unknown provider result is durably consumed without refund or automatic retry; restored limits cannot grow',async()=>{
  const f=fixture();const first=await createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()});
  f.loseResponse();await assert.rejects(first.prepare('SELECT 1').all(),/^Error: catalog_d1_result_unknown$/);assert.equal(f.calls(),3);
  assert.equal(f.state().unconfirmedRequests,1);
  const next=await createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()});
  assert.equal(next.metrics().requests,5);assert.equal(next.metrics().statements,3);assert.equal(next.metrics().reportedRowsRead,null);
  const initial=f.state();const calls=f.calls();
  for(const accounting of [{...f.accounting(),scope:{...scope,databaseName:'wrong'}},{...f.accounting(),initial:{...initial,httpRequests:NaN}},
    {...f.accounting(),initial:{...initial,httpRequests:10001}},{...f.accounting(),initial:{...initial,unconfirmedRequests:100}}])
    await assert.rejects(createCatalogD1Rest({...config,fetch:f.fetch,accounting}),/^Error: catalog_d1_accounting_invalid$/);
  assert.equal(f.calls(),calls);
});
test('identity settlement acknowledgement loss refuses success without a contradictory unknown settlement',async()=>{
  const f=fixture();f.loseSettlementAck();
  await assert.rejects(createCatalogD1Rest({...config,fetch:f.fetch,accounting:f.accounting()}),/^Error: catalog_d1_accounting_unknown$/);
  assert.equal(f.calls(),1);assert.equal(f.settlements(),1);assert.equal(f.state().httpRequests,1);
  assert.equal([...f.entries.values()][0].result.status,'known'); // Exact durable commit can be read independently.
});
