import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {repairSavedAdmission,retainedFailedAdmission,savedAdmissionRepairProduct} from '../scripts/catalog/saved-admission-repair.mjs';
import {editorialSourceHash,SHORT_COPY_PROMPT_VERSION} from '../scripts/ops/catalog-editorial-core.mjs';
import {maintenanceEmbeddingText} from '../scripts/catalog/maintenance-state.ts';
import {encodePgvectorSendBase64} from '../scripts/catalog/pgvector-binary.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {claimMutationOwnership} from '../lib/catalog/mutation-fence.ts';

const NOW='2026-11-10T18:00:00.000Z',OBS='2026-11-10T09:23:00.000Z',REVIEW='2026-11-10T17:54:00.000Z',ID='B0FMXQJW2V',HASH='a'.repeat(64);
const source={title:'TEST ONLY Solar Peeing Dog Garden Statue',imageUrl:'https://example.invalid/dog.jpg',sourceFacts:{shape:'dog',illumination:'solar stream light'}},sourceHash=editorialSourceHash(source);
function evidence(){
  const refs=[],values=new Map(),kinds=new Map(),add=(value,kind)=>{
    const sha=sha256(canonicalJson(value)),ref={reference:'objects/'+sha+'.json',sha256:sha};values.set(sha,value);kinds.set(sha,kind);refs.push(ref);return ref;};
  const observation={schemaVersion:1,kind:'amazon-observation',operation:'getItems',observedAt:OBS,requestedIds:[ID],returnedIds:[ID],
    products:[{id:ID,availabilityStatus:'IN_STOCK',sourceFactsHash:sourceHash,snapshot:source}]},observationRef=add(observation,'amazon-observation');
  const review={schemaVersion:1,kind:'reviewed-short-copy',id:ID,sourceFactsHash:sourceHash,title:'Solar peeing dog statue',
    description:'A solar-powered garden dog statue with a small illuminated stream from its lifted leg.',observationReference:observationRef.reference,reviewedAt:REVIEW,quality:.95};
  add(review,'phase');
  const vector=Array(1536).fill(Math.fround(.1));vector[0]=-0;const nativeBase64=encodePgvectorSendBase64(vector);
  const embedding={schemaVersion:1,kind:'embedding-response',model:'text-embedding-3-small',observedAt:REVIEW,products:[{
    id:ID,sourceFactsHash:sourceHash,text:maintenanceEmbeddingText({...source,punnyTitle:review.title,wittyDescription:review.description,
      editorialStatus:'short_ready',editorialPromptVersion:SHORT_COPY_PROMPT_VERSION}),nativeBase64,
    vectorBytesSha256:sha256(Buffer.from(nativeBase64,'base64'))}]};
  add(embedding,'embedding-response');return{refs,values,kinds,add,observation,review,embedding,nativeBase64};
}
for(const loseAck of [false,true])test('saved-output admission repairs currency once through real D1 storage, retaining failed telemetry'+(loseAck?' after lost ACK':''),async t=>{
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('supplier/model/live network forbidden');};t.after(()=>{globalThis.fetch=originalFetch;});
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  for(const file of(await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^\d{4}.*\.sql$/.test(n)).sort())sql.exec(await readFile(new URL('../migrations/d1/'+file,import.meta.url),'utf8'));
  sql.function('strftime',()=>NOW);
  const db={prepare(query){let params=[];return{bind(...v){params=v;return this;},async all(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};},
    async run(){return sql.prepare(query).run(...params);},execute(){return{results:sql.prepare(query).all(...params).map(r=>({...r}))};}};},async batch(statements){sql.exec('BEGIN');try{const out=statements.map(s=>s.execute());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  const scope={environment:'production',indexName:'fixture'};sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run(scope.environment,scope.indexName);
  const config={runId:'saved-correction',catalogRevision:'saved-correction',environment:scope.environment,vectorIndex:{name:scope.indexName},
    inputs:{savedAdmission:{}},catalog:{marketplace:'www.amazon.com',associateTag:'goose-gifts-37-20'},cadence:{admitAsins:[ID]}};
  const owner=await claimMutationOwnership(db,scope,{phase:'writing',ownerReference:config.runId,operationKey:sha256('weekly:'+HASH)});
  const finish=canonicalJson({status:'failed',error_summary:'Invalid maintenance input',timings_ms:{openai_embedding:2},usage:{requests:3}});
  sql.prepare('INSERT INTO catalog_runs VALUES(?,?,?,?,?,?,?)').run(config.runId,'failed','daily',0,NOW,NOW,'{}');
  sql.prepare('INSERT INTO catalog_run_telemetry VALUES(?,?,?)').run(config.runId,'{}',finish);
  const e=evidence();let cp={sha256:HASH,checkpoint:{phase:'phase_failed',owner,pins:{},phaseComplete:null,state:{errorCode:'weekly_requires_review'}}},fail=loseAck;
  const ws={registeredArtifacts:async()=>e.refs.map(ref=>({ref,kind:e.kinds.get(ref.sha256)})),readArtifact:async r=>structuredClone(e.values.get(r.sha256)),
    readReceipt:async r=>structuredClone(e.values.get(r.sha256)),putArtifact:async(v,{kind})=>e.add(v,kind),readCheckpoint:async()=>structuredClone(cp)};
  const write=async patch=>{if(patch.phase==='phases_complete'&&fail){fail=false;throw Error('test lost checkpoint ACK');}cp={sha256:sha256(canonicalJson(patch)),checkpoint:{...cp.checkpoint,...patch}};};
  const run=()=>repairSavedAdmission({ws,db,config,configSha256:HASH,now:()=>NOW,checkpoint:cp.checkpoint,write});
  if(loseAck)await assert.rejects(run(),/lost checkpoint/);
  assert.equal((await run()).state,'repaired');
  const row=sql.prepare('SELECT * FROM products WHERE id=?').get(ID),display=JSON.parse(row.public_display_json);
  assert.equal(row.currency,'USD');assert.equal(display.price,0);assert.equal(display.persistent.title,e.review.title);
  assert.equal(display.imageUrl,source.imageUrl);assert.equal(display.eligibleUntil,'2026-11-11T09:23:00.000Z');
  assert.equal(sql.prepare('SELECT count(*) n FROM products').get().n,1);
  assert.equal(sql.prepare('SELECT count(*) n FROM vector_sync_outbox').get().n,1);
  assert.equal(sql.prepare('SELECT finish_json FROM catalog_run_telemetry').get().finish_json,finish);
  assert.equal(sql.prepare('SELECT status FROM catalog_runs').get().status,'failed');
  assert.equal(cp.checkpoint.phase,'phases_complete');assert(await retainedFailedAdmission(ws,db,config,HASH));
  await assert.rejects(retainedFailedAdmission(ws,db,config,'b'.repeat(64)),/repair_invalid/);
});
test('saved-output repair refuses copy/vector drift and does not regenerate anything',()=>{
  const e=evidence(),input={id:ID,observation:e.observation,review:e.review,embedding:e.embedding,associateTag:'goose-gifts-37-20'};
  assert.equal(savedAdmissionRepairProduct(input).currency,'USD');
  assert.throws(()=>savedAdmissionRepairProduct({...input,review:{...e.review,description:'Contradictory replacement copy'}}),/repair_invalid/);
});
