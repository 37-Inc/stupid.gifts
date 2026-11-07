import path from 'node:path';
import {createHash} from 'node:crypto';
import {currentHostedInputs,restoreHostedInputs,publishHostedInputs} from './hosted-inputs.ts';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {createCatalogD1ReadOnlyRest} from './d1-write-rest.ts';
import {routineServingPrior} from './daily-operator.mjs';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {registerHostedCleanup} from './hosted-cleanup.mjs';

const fail=()=>{throw Error('catalog_hosted_policy_requires_accepted_canary');};
const hash=b=>createHash('sha256').update(b).digest('hex');
const json=b=>JSON.parse(Buffer.from(b));
async function verifyCurrent(runtime,seal,pointer){
  const token=await runtime.token(),live=await routineServingPrior(token,seal),c=CATALOG_SCOPE;
  if(live.releaseId!==seal.publication.releaseId||live.versionReference!==pointer.versionReference
    ||live.manifestSha256!==pointer.manifestSha256)fail();
  const db=await createCatalogD1ReadOnlyRest({accountId:c.accountId,databaseId:c.databaseId,databaseName:c.databaseName,token});
  const rows=await db.batch([
    db.prepare('SELECT * FROM publication_receipts WHERE release_id=?').bind(live.releaseId),
    db.prepare('SELECT state,version_reference FROM catalog_build_requests WHERE environment=? AND release_id=?').bind(c.environment,live.releaseId),
    db.prepare('SELECT phase,external_pending FROM catalog_mutation_scopes WHERE environment=? AND index_name=?').bind(c.environment,c.indexName),
  ]);
  if(rows.some(r=>r.results.length!==1)||hash(canonicalJson(rows[0].results[0]))!==seal.publication.receiptSha256
    ||rows[1].results[0].state!=='resolved'||rows[1].results[0].version_reference!==live.versionReference
    ||rows[2].results[0].phase!=='idle'||rows[2].results[0].external_pending!==0)fail();
  return{releaseId:live.releaseId,receiptSha256:seal.publication.receiptSha256,metrics:db.metrics()};
}

/** Explicit configuration activation, never a product run or publisher.
 * The owner stops local publishing and reviews the real canary before invoking.
 * Retain original input bytes; replace only the versioned policy via CAS. */
export async function activateHostedPolicy(runtime,asin,verify=verifyCurrent,register=registerHostedCleanup){
  if(!runtime.hosted||!runtime.durable||! /^[A-Z0-9]{10}$/.test(asin??''))fail();
  const store=runtime.durable,originalInputs=await store.get('pointers/operator-inputs.json');
  const ref=await currentHostedInputs(store),files=await restoreHostedInputs(store,runtime.base,ref);
  if(!files.some(f=>f.relative==='daily-catalog-care/automation-policy.json'))fail();
  const pointerFile=runtime.care+'/last-success.json',pointer=json(await runtime.state.readPointer('last-success',pointerFile));
  const relative=path.relative(runtime.care,pointer.control?.path??'');
  const match=relative.match(/^runs\/(canary-\d{4}-\d{2}-\d{2}-([A-Z0-9]{10}))\/catalog-control.json$/);
  if(!match||match[2]!==asin)fail();
  const directory=path.dirname(pointer.control.path),saved=json(await runtime.state.bytes(directory+'/success.json')),
    record=json(await runtime.state.bytes(directory+'/hosted-run.json')),sealBytes=await runtime.state.bytes(pointer.control.path);
  if(saved.result?.state!=='finalized'||canonicalJson(saved.next)!==canonicalJson(pointer)
    ||record.kind!=='canary'||record.canaryId!==asin||record.runKey!==match[1]||saved.source!==record.source
    ||hash(sealBytes)!==pointer.control.sha256)fail();
  const pending=await store.get('pointers/pending-run.json');
  if(!pending||json(pending.bytes).pending!==null)fail();
  const accepted=await verify(runtime,json(sealBytes),pointer);
  await register(runtime,record);
  if(canonicalJson(json(await runtime.state.readPointer('last-success',pointerFile)))!==canonicalJson(pointer)
    ||!Buffer.from((await store.get('pointers/pending-run.json'))?.bytes??[]).equals(Buffer.from(pending.bytes)))fail();
  const policy={schemaVersion:1,enabled:true,discovery:true,homepage:true};
  const inputs=await Promise.all(files.map(async f=>({relative:f.relative,bytes:f.relative==='daily-catalog-care/automation-policy.json'
    ?Buffer.from(JSON.stringify(policy)+'\n'):await runtime.state.bytes(path.join(runtime.base,f.relative))})));
  const inputsRef=await publishHostedInputs(store,inputs,originalInputs?.bytes??null);
  return{state:'policy_enabled',policy,inputsRef,acceptedCanary:accepted};
}

/** First-use quality check through the SAME optional homepage editor. It may
 * save an edition, never fetch suppliers, claim D1, publish or enable policy. */
export async function previewHostedHomepage(runtime,{repository,source,day}){
  const files=await currentHostedInputs(runtime.durable);await restoreHostedInputs(runtime.durable,runtime.base,files);
  const pending=await runtime.durable.get('pointers/pending-run.json');if(pending&&json(pending.bytes).pending!==null)fail();
  const pointer=json(await runtime.state.readPointer('last-success',runtime.care+'/last-success.json')),
    sealBytes=await runtime.state.bytes(pointer.control.path);if(hash(sealBytes)!==pointer.control.sha256)fail();
  const seal=json(sealBytes),accepted=await verifyCurrent(runtime,seal,pointer),c=CATALOG_SCOPE;
  const db=await createCatalogD1ReadOnlyRest({accountId:c.accountId,databaseId:c.databaseId,databaseName:c.databaseName,token:await runtime.token()});
  const {routineHomepageEdition}=await import('./daily-operator.mjs'),{loadAutomationMerchandising}=await import('./automation-inputs.mjs'),
    {curateAutomationHomepage}=await import('./automated-homepage.mjs');
  const result=await curateAutomationHomepage({runtime,db,seal,prior:await routineHomepageEdition(day,pointer.control.path),
    merchandising:await loadAutomationMerchandising({runtime,db,seal}),repository,source,day});
  return{state:'editorial_preview',editorState:result.state,attention:result.attention??null,edition:result.edition,
    acceptedCatalog:accepted,metrics:db.metrics(),supplierRequests:0,productMutations:0,publication:false};
}
