import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createProjectionPacket, projectionQueries } from '../../lib/catalog/d1.ts';
import { validateCatalogSnapshot } from '../../lib/catalog/snapshot.ts';
import { claimMutationOwnership, releaseMutationOwnership } from '../../lib/catalog/mutation-fence.ts';
import { approvedCohortOperationKey, approvedCohortVectorPlan, prepareApprovedCohort } from '../../lib/catalog/freeze-approved-cohort.ts';
import { claimBuildRequest, beginBuildActivation, resolveBuildActivation } from '../../lib/catalog/build-requests.ts';
import { enqueuePublication, claimPublication, recordPublicationDispatch, completePublication } from '../../lib/catalog/publication.ts';
import { createD1CatalogMaintenanceStore, loadMaintenanceVectorPayload } from '../../scripts/catalog/maintenance-d1.ts';
import { maintenanceEmbeddingText } from '../../scripts/catalog/maintenance-state.ts';
import { editorialSourceHash } from '../../scripts/ops/catalog-editorial-core.mjs';
import { canonicalJson, sha256 } from '../../scripts/catalog/migration.ts';
import { createSealedSnapshotEnvelope } from '../../scripts/catalog/export-d1-snapshot.ts';
import { deliverOwnedOutboxEvent, reuseOwnedApprovedCohortVectorProof, settleOwnedApprovedCohortVectorProof,
  prepareOwnedApprovedCohortPlan, publishedCatalogOperationKey, readActivatedCatalogVectors } from '../../scripts/catalog/owned-vector-delivery.ts';

export const AT=Date.parse('2026-10-20T12:00:00.000Z'),at=ms=>new Date(AT+ms).toISOString();
export const scope={environment:'staging',indexName:'published-proof'},source='b'.repeat(64),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const names=['Brass lobster desk bell','Velvet mushroom reading lamp','Cosmic pickle kayak anchor','Glass cactus snow globe',
  'Rubber flamingo bath mat','Wooden octopus pencil stand','Ceramic rocket flower vase','Copper hedgehog book holder'];
export const values=Array(1536).fill(Math.fround(.1));values[0]=-0;
export function product(n,fresh=false){return{id:`B${String(n).padStart(9,'0')}`,title:names[n-1]??`Held fixture ${n}`,price:19.99,currency:'USD',source:'amazon',
  imageUrl:`https://example.invalid/owned-${n}.jpg`,affiliateUrl:`https://www.amazon.com/dp/B${String(n).padStart(9,'0')}?tag=fixture-20`,
  humorTags:[`fixture${n}`],punnyTitle:null,wittyDescription:`Synthetic description ${n}.`,sourceQuery:'synthetic',sourceFacts:{fixture:n,fresh},
  isActive:n<=8,qualityScore:.85,availabilityStatus:'IN_STOCK',remotelyVerified:true,editorialStatus:'generated_ready',editorialQualityScore:.95,
  editorialWriteup:Array(2).fill(Array(55).fill(`Specific useful owned editorial ${n}`).join(' ')).join('\n\n'),embedding:n<=8?[...values]:null};}
export const rights=p=>Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,affiliateUrl:p.affiliateUrl,
  wittyDescription:p.wittyDescription,editorialWriteup:p.editorialWriteup,humorTags:JSON.stringify(p.humorTags)})
  .map(([k,value])=>[k,{basis:'owned',reference:`test-only/${p.id}/${k}`,value}]));
export async function setup(t,{providerIdentity='fixture:published-index',codeSha='f'.repeat(40),originalVersion,migrationThrough=99,merchant=false,initialTime=AT,fullPlan=false,settleProof=settleOwnedApprovedCohortVectorProof}={}){
  const at=ms=>new Date(initialTime+ms).toISOString();
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());sql.exec('PRAGMA foreign_keys=ON');
  for(const name of(await readdir(new URL('../../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)&&Number(n.slice(0,4))<=migrationThrough).sort())
    sql.exec(await readFile(new URL(`../../migrations/d1/${name}`,import.meta.url),'utf8'));
  let clock=initialTime,proofOnly=false;const metrics={statements:0,maxParams:0,maxRequest:0,maxResponse:0};
  sql.function('strftime',(format,instant)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return new Date(clock).toISOString();});
  const db={prepare(query){let params=[];return{query,wire(){return{sql:query,params};},bind(...args){assert.ok(args.length<=100);metrics.maxParams=Math.max(metrics.maxParams,args.length);params=args;return this;},
    execute(){if(proofOnly)assert.match(query,/^SELECT /);metrics.statements++;
      metrics.maxRequest=Math.max(metrics.maxRequest,Buffer.byteLength(JSON.stringify({sql:query,params})));
      const rows=sql.prepare(query).all(...params).map(r=>({...r}));metrics.maxResponse=Math.max(metrics.maxResponse,Buffer.byteLength(JSON.stringify(rows)));return rows;},
    async all({signal}={}){signal?.throwIfAborted();return{results:this.execute()};},
    async run(){if(proofOnly)assert.fail('proof attempted mutation');const result=sql.prepare(query).run(...params);return{success:true,meta:{changes:Number(result.changes)}};}};},
    async batch(statements,{signal}={}){signal?.throwIfAborted();assert.ok(statements.length<=50);
      const bytes=Buffer.byteLength(JSON.stringify({batch:statements.map(s=>s.wire())}));metrics.maxRequest=Math.max(metrics.maxRequest,bytes);assert.ok(bytes<512*1024);sql.exec('BEGIN');
      try{const results=statements.map(s=>({results:s.execute()}));const size=Buffer.byteLength(JSON.stringify(results));assert.ok(size<512*1024);
        metrics.maxResponse=Math.max(metrics.maxResponse,size);sql.exec('COMMIT');return results;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const index=new Map();let dispatches=0,mode={runId:'seed',catalogRevision:'prior'},cursor={current:await claimMutationOwnership(db,scope,
    {phase:'writing',ownerReference:'seed',operationKey:'a'.repeat(64)})};
  const adapters={...scope,providerIdentity,async dispatch(input){assert.equal(proofOnly,false);dispatches++;
    if(input.vector)index.set(input.publicId,structuredClone(input.vector));else index.delete(input.publicId);return{reference:`fixture:${dispatches}`};},
    async resolve(input){return{state:'settled',reference:input.reference};},async readback(id,signal){signal.throwIfAborted();return structuredClone(index.get(id)??null);}};
  async function upsert(p){const hash=editorialSourceHash(p);p.editorialSourceHash=hash;const grants=rights(p);
    if(merchant)for(const grant of Object.values(grants))Object.assign(grant,{basis:'merchant',observedAt:at(-3600000),expiresAt:at(23*3600000)});
    const store=createD1CatalogMaintenanceStore({db,...mode,
    owner:cursor.current,ownerCursor:cursor,newPublicId:()=>uuid(Number(sql.prepare('SELECT count(*) n FROM products').get().n)+1),
    intent(){return{rightsById:{[p.id]:grants},verificationById:{[p.id]:{reference:'fixture:observation',observedAt:at(-3600000),sourceFactsHash:hash}},
      ...(p.embedding?{embeddingById:{[p.id]:{reference:'fixture:embedding',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}}:{})};}});
    await store.upsertProduct(p,hash);}
  async function drain(){for(const r of sql.prepare("SELECT sequence FROM vector_sync_outbox WHERE status='pending' ORDER BY sequence").all()){
    const options={db,owner:cursor.current,sequence:r.sequence,catalogRevision:mode.catalogRevision,loadPayload:e=>loadMaintenanceVectorPayload(db,e),adapters};
    let result=await deliverOwnedOutboxEvent(options);cursor.current=result.owner;
    if(result.state==='pending')result=await deliverOwnedOutboxEvent({...options,owner:cursor.current});cursor.current=result.owner;assert.equal(result.state,'complete');}}
  for(let n=1;n<=10;n++)await upsert(product(n));await drain();
  const rows=sql.prepare('SELECT * FROM products ORDER BY public_id').all();
  const previous=validateCatalogSnapshot({schemaVersion:1,dataKind:'catalog',catalogRevision:'prior',generatedAt:at(0),
    products:rows.filter(r=>r.public_display_json).map(r=>JSON.parse(r.public_display_json)),heldProducts:rows.filter(r=>!r.public_display_json).map(r=>({
      id:r.id,publicId:r.public_id,slug:r.slug,path:`/gifts/${r.slug}`,title:'Gift currently unavailable',
      description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'inactive'})),slugHistory:[]},new Date(clock));
  const packet=await createProjectionPacket(previous,Object.fromEntries(rows.map(r=>[r.public_id,r.source_facts_hash])),source,new Date(clock));
  sql.prepare("INSERT INTO catalog_revisions(revision,created_at,source_export_sha256,status) VALUES(?,?,?,'published')").run('prior',at(0),source);
  for(const q of projectionQueries(packet))sql.prepare(q.sql).run(...q.params);
  const priorIntent={releaseId:'prior-release',catalogRevision:'prior',codeSha:'c'.repeat(40),catalogSnapshotSha256:packet.receipt.snapshot_sha256,
    manifestSha256:'f'.repeat(64),vectorSyncWatermark:8,priorReleaseId:null,nextExpiry:previous.products[0].eligibleUntil};
  const prior={release_id:'prior-release',catalog_revision:'prior',code_sha:priorIntent.codeSha,completed_at:at(0),manifest_json:JSON.stringify(priorIntent)};
  sql.prepare('INSERT INTO publication_receipts VALUES(?,?,?,?,?)').run(...Object.values(prior));
  const context={envelopeSha256:sha256(`${JSON.stringify(createSealedSnapshotEnvelope(previous))}\n`),snapshotSha256:packet.receipt.snapshot_sha256,
    projectionSha256:packet.receipt.projection_sha256,sourceExportSha256:source,vectorSyncWatermark:8,publicationReceiptWatermark:1,cutoff:at(6*3600000),
    priorPublication:{releaseId:prior.release_id,receiptSha256:sha256(canonicalJson(prior))}};
  await releaseMutationOwnership(db,cursor.current);clock+=1000;mode={runId:'maintained',catalogRevision:'maintained'};
  cursor={current:await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:'maintained',operationKey:'d'.repeat(64)})};
  for(let n=1;n<=8;n++)await upsert(product(n,true));await drain();
  const changes=Array.from({length:8},(_,i)=>{const row={...sql.prepare('SELECT * FROM products WHERE public_id=?').get(uuid(i+1))};
    const op=sql.prepare("SELECT * FROM catalog_maintenance_operations WHERE run_id='maintained' AND EXISTS(SELECT 1 FROM json_each(changes_json) c WHERE json_extract(c.value,'$.productId')=?)").get(row.id);
    return{publicId:row.public_id,operationId:op.operation_id,inputSha256:op.input_sha256,productSha256:sha256(canonicalJson(row)),displaySha256:sha256(row.public_display_json)};});
  const approval={schemaVersion:1,...mode,changes},request={previous,context,scope,codeSha:'e'.repeat(40),approval,approvalSha256:sha256(canonicalJson(approval))};
  await releaseMutationOwnership(db,cursor.current);const owner=await claimMutationOwnership(db,scope,
    {phase:'freezing',ownerReference:'original-publish',operationKey:approvedCohortOperationKey(request)});
  const prepared=fullPlan?await prepareOwnedApprovedCohortPlan({db,owner,request,adapters}):await prepareApprovedCohort(db,owner,request),revision=prepared.revision;
  const reused=fullPlan?{owner:prepared.owner,deliveryId:sql.prepare("SELECT delivery_id FROM catalog_vector_deliveries WHERE json_extract(request_json,'$.kind')='approved-cohort-plan'").get().delivery_id}
    :await reuseOwnedApprovedCohortVectorProof({db,owner:prepared.owner,revision,adapters});
  if(fullPlan)assert.deepEqual(prepared.remainingIds,[]);else assert.equal(reused.state,'complete');
  const queued=await settleProof({db,owner:reused.owner,revision,adapters});
  const build=await claimBuildRequest(db,queued.requestId,'fixture:original-build',new Date(clock));
  const f={sql,db,index,adapters,revision,metrics,now:()=>new Date(clock),advance(ms){clock+=ms;},dispatches:()=>dispatches,
    async readonly(fn){const before=sql.prepare('SELECT total_changes() n').get().n;proofOnly=true;try{return await fn();}
      finally{proofOnly=false;assert.equal(sql.prepare('SELECT total_changes() n').get().n,before);}},
    async activate(build,owner,releaseId,prior){const intent={releaseId,catalogRevision:revision.snapshot.catalogRevision,codeSha:build.request.codeSha,
      catalogSnapshotSha256:revision.packet.receipt.snapshot_sha256,manifestSha256:'a'.repeat(64),vectorSyncWatermark:revision.vectorSyncWatermark,
      priorReleaseId:build.request.priorReleaseId,nextExpiry:revision.snapshot.products[0].eligibleUntil};
      await enqueuePublication(db,revision.snapshot,intent,new Date(clock));const publication=await claimPublication(db,revision.snapshot,releaseId,new Date(clock));
      await recordPublicationDispatch(db,revision.snapshot,publication,'fixture:dispatch',new Date(clock));
      const permit=await beginBuildActivation(db,build,revision.snapshot,publication,originalVersion??`fixture:version-${releaseId}`,
        async()=>({environment:scope.environment,settled:true,active:{...prior,versionReference:'fixture:prior-version'}}),new Date(clock),owner);
      return{intent,publication,permit};},
    async finish(active,read){await completePublication(db,revision.snapshot,active.intent.releaseId,active.publication.token,async()=>{
      await read();return active.intent;},()=>new Date(clock),active.permit.mutationOwner);
      assert.equal(await resolveBuildActivation(db,active.permit,async()=>{await read();return{environment:scope.environment,settled:true,
        active:{...active.intent,versionReference:active.permit.versionReference}};}),'resolved');}};
  const original=await f.activate(build,queued.owner,'original-release',priorIntent);
  const plan=approvedCohortVectorPlan(revision),control={catalogRevision:plan.catalogRevision,planSha256:sha256(canonicalJson(plan)),ids:plan.products.map(p=>p.publicId)};
  await f.finish(original,()=>readActivatedCatalogVectors(db,original.permit,control,adapters));
  const receipt={...sql.prepare("SELECT * FROM publication_receipts WHERE release_id='original-release'").get()},delivery={...sql.prepare('SELECT * FROM catalog_vector_deliveries WHERE delivery_id=?').get(reused.deliveryId)};
  const published={source:{releaseId:'original-release',receiptSha256:sha256(canonicalJson(receipt)),deliveryId:reused.deliveryId,
    deliverySha256:sha256(canonicalJson(delivery))},revision,request:{schemaVersion:1,environment:scope.environment,sourceRevision:revision.snapshot.catalogRevision,
    sourceDigest:revision.packet.receipt.snapshot_sha256,codeSha,priorReleaseId:'original-release',capturedAt:revision.snapshot.generatedAt,cutoff:context.cutoff}};
  f.owner=await claimMutationOwnership(db,scope,{phase:'freezing',ownerReference:'new-code',operationKey:publishedCatalogOperationKey(published)});
  f.published=published;f.control=control;f.original=original;f.options={db,owner:f.owner,published,adapters};return f;
}

