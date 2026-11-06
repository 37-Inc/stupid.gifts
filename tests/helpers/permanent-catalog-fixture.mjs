import assert from 'node:assert/strict';
import {setup,scope,uuid} from './published-vector-fixture.mjs';
import {canonicalJson,sha256,convertSourceRow} from '../../scripts/catalog/migration.ts';
import {createCatalogD1MigrationRest,createCatalogD1Rest} from '../../scripts/catalog/d1-write-rest.ts';
import {createOneTimeMigrationBudget} from '../../scripts/catalog/one-time-migration-budget.ts';
import {captureOwnedD1} from '../../scripts/catalog/capture-owned-d1.ts';
import {prepareOwnedOperationalImport,applyOwnedOperationalImport} from '../../scripts/catalog/owned-operational-import.ts';
import {mapAuthoredCopyEvidence} from '../../scripts/catalog/authored-copy-evidence.ts';
import {assemblePermanentBaseline} from '../../scripts/catalog/permanent-baseline.ts';
import {permanentBaselineCurrent,preparePermanentDisplayPlan,applyPermanentDisplayPlan} from '../../scripts/catalog/permanent-display-d1.ts';
import {claimMutationOwnership,releaseMutationOwnership} from '../../lib/catalog/mutation-fence.ts';
import {permanentCatalogOperationKey} from '../../lib/catalog/freeze-permanent-catalog.ts';
import {prunedVectorPlan} from '../../lib/catalog/prune-existing-revision.ts';
import {createSealedSnapshotEnvelope} from '../../scripts/catalog/export-d1-snapshot.ts';

const accountId='a'.repeat(32),databaseId=uuid(9999),manifest='b'.repeat(64),asset='/images/gift-placeholder.svg';
const svg='<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10"/></svg>';
const grant=value=>({basis:'owned',value,reference:'ROOT approved exact synthetic value; no real rights claim'});

export async function permanentCatalogFixture(t,{count=12,afterExpiry=false,merchant=false,publicCount=2361,initialTime,ownerHeld=0,ownerDuplicates=0,meter,publicDuplicate=false}={}){
  // This fixture exercises the historical migration/capture schema, not the
  // subsequently added operational search-telemetry table.
  const f=await setup(t,{providerIdentity:`cloudflare:${accountId}:${scope.indexName}`,migrationThrough:16,merchant,...(initialTime===undefined?{}:{initialTime})});
  if(afterExpiry)f.advance(Date.parse(f.revision.snapshot.products[0].eligibleUntil)-f.now().getTime()+3600000);
  let statements=0,requests=0,maxRequest=0,maxResponse=0,loseSeal=false,inspect,lastFailure;const queryText=[],queryWire=[];
  const ledger={httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},dbScope={accountId,databaseId,databaseName:'permanent-freeze'};
  // Explicit LOCAL fixture profile covers genuine union+installer+freeze/replay;
  // synthetic usage is not account evidence or authorization for any live run.
  const budget=createOneTimeMigrationBudget({scope:dbScope,ledgerAtObservation:ledger,observations:[{accountId,utcDay:f.now().toISOString().slice(0,10),
    capturedAt:f.now().toISOString(),coverage:'account-wide',resources:[databaseId],rowsRead:0,rowsWritten:0,evidenceSha256:'a'.repeat(64)}],
    required:{requests:10000,statements:25000,rowsRead:2000000,rowsWritten:85000,evidenceSha256:'b'.repeat(64)}},f.now());
  const send=async(url,init)=>{requests++;assert.equal(url,`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}${init.method==='POST'?'/query':''}`);
      if(init.method==='GET')return Response.json({success:true,result:{uuid:databaseId,name:'permanent-freeze',read_replication:{mode:'disabled'}}});
      const {batch}=JSON.parse(init.body);await meter?.initialise(f.sql);inspect?.(batch);assert.ok(batch.length<=50);statements+=batch.length;queryText.push(...batch.map(q=>q.sql));
      queryWire.push(...batch.filter(q=>q.sql.includes('FROM json_each(?) e CROSS JOIN catalog_public_products p')));
      maxRequest=Math.max(maxRequest,Buffer.byteLength(init.body));assert.ok(maxRequest<=512*1024);f.sql.exec('BEGIN');let result;
      let activeQuery;try{result=batch.map(q=>{activeQuery=q.sql;assert.ok(q.params.length<=100);const before=f.sql.prepare('SELECT total_changes() n').get().n;
        const rows=f.sql.prepare(q.sql).all(...q.params).map(r=>({...r}));return{success:true,results:rows,meta:{served_by_primary:true,
          rows_read:rows.length,rows_written:f.sql.prepare('SELECT total_changes() n').get().n-before}};});f.sql.exec('COMMIT');}
      catch(error){lastFailure={query:activeQuery,error:error.message};f.sql.exec('ROLLBACK');throw error;}
      if(meter){const measured=await meter.batch(batch,f.now().toISOString()).catch(error=>{t.diagnostic('workerd meter: '+error.message.slice(0,2000));throw error;});assert.equal(measured.length,result.length);
        result=result.map((r,i)=>{if(!/sqlite_schema|pragma_table_info/.test(batch[i].sql)){
          // Replacing the fixture clock changes unnamed expression labels,
          // not their ordered values. Physical schema rowids differ as well.
          try{assert.deepEqual(measured[i].results.map(Object.values),r.results.map(Object.values));}
          catch(error){t.diagnostic(JSON.stringify({query:batch[i].sql.slice(0,160),mismatch:error.message.slice(0,2000)}));throw error;}}
          return{...r,meta:{...r.meta,rows_read:measured[i].rowsRead,rows_written:measured[i].rowsWritten}};});}
      if(loseSeal&&batch.some(q=>q.sql.startsWith('INSERT INTO catalog_projection_receipts'))){loseSeal=false;throw new Error('synthetic committed seal ACK loss');}
      const bytes=JSON.stringify({success:true,result});maxResponse=Math.max(maxResponse,Buffer.byteLength(bytes));assert.ok(maxResponse<=512*1024);return new Response(bytes);};
  const makeDb=(initial=ledger)=>createCatalogD1MigrationRest({accountId,databaseId,databaseName:'permanent-freeze',token:'FIXTURE_ONLY',budget,ledger:initial,now:f.now,
    accounting:{scope:dbScope,initial,async reserve(){},async settle(){}},fetch:send});
  const makeNextDayDb=(limits={requests:800})=>createCatalogD1Rest({accountId,databaseId,databaseName:'permanent-freeze',token:'FIXTURE_ONLY',limits,
    accounting:{scope:dbScope,initial:ledger,async reserve(){},async settle(){}},fetch:send});
  const db=await makeDb();
  await releaseMutationOwnership(db,f.owner);
  const now=()=>f.now().toISOString(),writers=()=>[{id:'daily',kind:'application',codePaths:['scripts/catalog/run-cloudflare-weekly.ts'],reference:'Synthetic stopped job',stoppedAt:now()},
    {id:'operator',kind:'operator',codePaths:[],reference:'Synthetic sole operator',stoppedAt:now()}];
  const claim=key=>claimMutationOwnership(db,scope,{phase:'writing',ownerReference:key,operationKey:sha256(key)});
  const owner=await claim('union'),initial=await captureOwnedD1({db,owner,reference:'Synthetic initial capture',stoppedWriters:writers()});
  const source=Array.from({length:count},(_,i)=>{const n=i+1,current=initial.capture.tables.products.find(p=>p.public_id===uuid(n));
    const id=publicDuplicate&&n===11?'B0BQ9LZNXN':publicDuplicate&&n===12?'B0DP9GRD9K':`B${String(n).padStart(9,'0')}`;
    return{id,public_id:uuid(n),slug:current?.slug??`original-gift-${n}`,source:'amazon',
      title:ownerHeld&&n>count-ownerHeld&&n<=count-ownerHeld+ownerDuplicates?'Brass lobster desk bell':`Supplier fixture ${n}`,
      price:'19.99',currency:'USD',image_url:`https://supplier.invalid/${n}.jpg`,affiliate_url:`https://www.amazon.com/dp/${id}?tag=fixture-20`,
      source_query:'synthetic',humor_tags:'{}',punny_title:null,witty_description:ownerHeld&&n>count-ownerHeld?`Original owned short description ${n}.`:null,
      quality_score:ownerHeld&&n>count-ownerHeld?'0.50':'0.85',rating:null,review_count:null,
      is_active:ownerHeld?n<=count-ownerHeld&&![9,10].includes(n):count===3383?n<=publicCount+2&&![9,10].includes(n):![9,10].includes(n),editorial_writeup:null,source_facts:null,source_facts_hash:null,
      editorial_source_hash:null,availability_status:'IN_STOCK',editorial_status:'pending',editorial_quality_score:null,editorial_model:null,
      editorial_prompt_version:null,editorial_generated_at:null,editorial_block_reason:null,
      duplicate_of_product_id:ownerHeld&&n>count-ownerHeld&&n<=count-ownerHeld+ownerDuplicates?'B000000001':null,content_updated_at:null,
      availability_checked_at:null,last_verified_at:null,created_at:now(),updated_at:now(),embedding:null};});
  const incoming=source.slice(10).map(row=>convertSourceRow('products',row,{catalogRevision:'archive',archiveId:manifest,timestamps:{}})),batches=[];
  for(let i=0;i<incoming.length;i+=40)batches.push({table:'products',rows:incoming.slice(i,i+40),exportSha256:manifest});
  const packet={batches,preservedRows:initial.capture.tables.products,summary:{sourceManifestSha256:manifest,importedAt:now(),batchCount:batches.length,importedRows:incoming.length,sourceIdentityCount:count}};
  const union=prepareOwnedOperationalImport({packet,capture:initial.capture,captureSha256:initial.captureSha256,owner}),cursor={current:owner};
  await applyOwnedOperationalImport({db,plan:union.plan,planSha256:union.sha256,ownerCursor:cursor,cooperativeCapture:{receipt:initial.receipt,sha256:initial.receiptSha256}});
  const captured=await captureOwnedD1({db,owner:cursor.current,reference:'Synthetic completed union',stoppedWriters:writers()});
  const raw=source.map(row=>JSON.stringify(row)).join('\n')+'\n',tables=[{raw,rows:source,definition:{schema:'public',name:'products',sha256:sha256(raw),rowCount:count,columns:Object.keys(source[0]).map(name=>({name}))}},
    {raw:'',rows:[],definition:{schema:'public',name:'catalog_editorial_events',sha256:sha256(''),rowCount:0,columns:[]}}];
  const evidence=mapAuthoredCopyEvidence({tables,summary:{manifestSha256:manifest,tables:tables.map(t=>({schema:'public',name:t.definition.name,sourceSha256:t.definition.sha256,rowCount:t.rows.length}))}},
    {expectedManifestSha256:manifest,archiveReference:'private:synthetic',canonicalAffiliateTag:'fixture-20',seeds:[]});
  const assembler={expectedEvidenceSha256:sha256(canonicalJson(evidence)),approvedRightsById:Object.fromEntries(evidence.products.map(p=>[p.id,
    {title:grant(p.fields.title.value),description:grant(p.fields.title.value),imageUrl:grant(asset),affiliateUrl:grant(p.fields.retailerUrl.value)}])),
    placeholder:{path:asset,bytes:Buffer.from(svg),expectedSha256:sha256(svg)},now:f.now()};
  const proposal=assemblePermanentBaseline(evidence,permanentBaselineCurrent(captured.capture),assembler);
  const installation=preparePermanentDisplayPlan({capture:captured.capture,captureSha256:captured.captureSha256,owner:cursor.current,
    union:{plan:union.plan,sha256:union.sha256},evidence,assembler,approvedProposal:{value:proposal,sha256:sha256(canonicalJson(proposal)),reference:'ROOT exact synthetic plan'}});
  await applyPermanentDisplayPlan({db,plan:installation.plan,planSha256:installation.sha256,ownerCursor:cursor,cooperativeCapture:{receipt:captured.receipt,sha256:captured.receiptSha256}});
  await releaseMutationOwnership(db,cursor.current);
  const previous=f.revision.snapshot,receipt=f.sql.prepare("SELECT * FROM publication_receipts WHERE release_id='original-release'").get();
  const request={scope,codeSha:'9'.repeat(40),catalogRevision:'permanent',previous,preserveSupplierPhotos:true,
    productOrder:[...previous.products.map(p=>p.publicId),...proposal.proposed.map(p=>p.input.product.publicId).filter(id=>!previous.products.some(p=>p.publicId===id))],
    context:{envelopeSha256:sha256(`${JSON.stringify(createSealedSnapshotEnvelope(previous))}\n`),snapshotSha256:f.revision.packet.receipt.snapshot_sha256,
      projectionSha256:f.revision.packet.receipt.projection_sha256,sourceExportSha256:f.revision.sourceDigest,vectorSyncWatermark:f.revision.vectorSyncWatermark,
      publicationReceiptWatermark:2,cutoff:new Date(f.now().getTime()+3600000).toISOString(),priorPublication:{releaseId:'original-release',receiptSha256:sha256(canonicalJson(receipt))}},
    installation:{...installation,capture:{receipt:captured.receipt,sha256:captured.receiptSha256}},
    native:{source:f.published.source,revisionSha256:sha256(canonicalJson(f.revision)),plan:prunedVectorPlan(f.revision)}};
  const freezing=await claimMutationOwnership(db,scope,{phase:'freezing',ownerReference:'permanent',operationKey:permanentCatalogOperationKey(request)});
  const metrics=()=>({requests,statements,maxRequest,maxResponse});
  return{...f,scope,accountId,databaseId,db,makeDb,makeNextDayDb,request,owner:freezing,metrics,queryText,queryWire,
    failure:()=>lastFailure,inspect(fn){inspect=fn;},loseSeal(){loseSeal=true;},setMeter(value){meter=value;}};
}
