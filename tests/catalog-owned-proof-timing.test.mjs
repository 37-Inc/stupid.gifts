import assert from 'node:assert/strict';
import test from 'node:test';
import {setup,scope,uuid} from './helpers/published-vector-fixture.mjs';
import {createCatalogD1Rest} from '../scripts/catalog/d1-write-rest.ts';
import {accountedPublicationReadFetch} from '../scripts/catalog/publication-read-fetch.ts';
import {createVectorizeRestAdapters} from '../scripts/catalog/vectorize-rest.ts';
import {settleOwnedApprovedCohortVectorProof} from '../scripts/catalog/owned-vector-delivery.ts';
import {canonicalJson} from '../scripts/catalog/migration.ts';

for(const fault of [null,'source','native','owner','projection','watermark'])test(`owned build queue separates journal latency and preserves ${fault??'healthy'} validation`,async t=>{
  const accountId='a'.repeat(32),databaseId=uuid(70),name='fixture-db',base=`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}`;
  const pause=()=>new Promise(resolve=>setTimeout(resolve,30)),events=[];let changed=false,queueCount;
  const timer=globalThis.setTimeout;t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>timer(fn,ms===30_000?100:ms,...args));
  const run=()=>setup(t,{fullPlan:true,providerIdentity:`cloudflare:${accountId}:${scope.indexName}`,settleProof:async input=>{
    const prior=canonicalJson((await input.db.prepare('SELECT * FROM products ORDER BY id').all()).results);
    const queuedBefore=(await input.db.prepare('SELECT count(*) n FROM catalog_build_requests').all()).results[0].n;
    const ledger={scope:{accountId,databaseId,databaseName:name},initial:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},
      async reserve(){events.push('reserve');await pause();},async settle(_id,value){events.push(value.status);await pause();}};
    const db=await createCatalogD1Rest({accountId,databaseId,databaseName:name,token:'TEST_ONLY',requestLimit:'observe',accounting:ledger,
      fetch:async(url,init)=>{
        if(url===base)return Response.json({success:true,result:{uuid:databaseId,name,read_replication:{mode:'disabled'}}});
        assert.equal(url,base+'/query');const batch=JSON.parse(init.body).batch;
        const before=(await input.db.prepare('SELECT total_changes() n').all()).results[0].n;
        const results=await input.db.batch(batch.map(q=>input.db.prepare(q.sql).bind(...q.params)));
        const writes=(await input.db.prepare('SELECT total_changes() n').all()).results[0].n-before;
        return Response.json({success:true,result:results.map((r,i)=>({success:true,results:r.results,
          meta:{served_by_primary:true,rows_read:r.results.length,rows_written:i===results.length-1?writes:0}}))});
      }});
    const read=accountedPublicationReadFetch({async reserveBudget(){events.push('reserve');await pause();},
      async settleBudget(_id,value){events.push(value.status);await pause();}},async(_url,init)=>{
      if(fault&&!changed&&fault!=='native'){
        changed=true;
        if(fault==='source')await input.db.prepare('UPDATE products SET title=? WHERE public_id=?').bind('Changed out of band',uuid(1)).all();
        if(fault==='owner')await input.db.prepare('UPDATE catalog_mutation_scopes SET generation=generation+1').all();
        if(fault==='projection')await input.db.prepare('UPDATE catalog_public_products SET title=? WHERE catalog_revision=?')
          .bind('Changed out of band',input.revision.snapshot.catalogRevision).all();
        if(fault==='watermark')await input.db.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,status,created_at,completed_at)
          VALUES(?,'foreign-revision',?,'upsert','complete',?,?)`).bind(uuid(99),'a'.repeat(64),input.revision.snapshot.generatedAt,input.revision.snapshot.generatedAt).all();
      }
      const found=[];for(const id of JSON.parse(init.body).ids){const v=await input.adapters.readback(id,init.signal);if(!v)continue;
        if(fault==='native'&&!changed){changed=true;v.values[0]=Math.fround(.25);}
        found.push(`{"id":${JSON.stringify(id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':n).join(',')}],"metadata":${JSON.stringify(v.metadata)}}`);
      }return new Response(`{"success":true,"result":[${found.join(',')}]}`);
    },{accountId,databaseId,workerName:'fixture',indexName:scope.indexName,identityOrigin:'https://fixture.invalid'});
    const adapters=createVectorizeRestAdapters({...scope,accountId,token:'TEST_ONLY',fetch:read});
    try{
      const result=await settleOwnedApprovedCohortVectorProof({...input,db,adapters});assert.equal(fault,null);
      assert.equal(canonicalJson((await input.db.prepare('SELECT * FROM products ORDER BY id').all()).results),prior);
      assert.equal(result.owner.epoch,input.owner.epoch+1);return result;
    }finally{
      queueCount=(await input.db.prepare('SELECT count(*) n FROM catalog_build_requests').all()).results[0].n-queuedBefore;
      assert.equal(queueCount,fault?0:1);
    }
  }});
  if(fault)await assert.rejects(run());else await run();assert.ok(events.length>0);
});
