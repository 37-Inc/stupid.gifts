import {createHash} from 'node:crypto';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {hostedRunRecord,validAdmissionAsins} from './hosted-run-record.mjs';
import {readSavedAmazonObservation} from './run-workspace.ts';
import {CATALOG_SCOPE} from './automation-runtime.mjs';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw Error('catalog_saved_admission_invalid');};
export function savedAdmissionRun(value){
  if(typeof value!=='string'||!/^admit-\d{4}-\d{2}-\d{2}-[a-f0-9]{12}$/.test(value))fail();
  return value;
}
/** Resolve only an already accepted exact-admission run. The existing
 * workspace reader authenticates its original source, journal and retention. */
export async function loadSavedAdmission(runtime,runKey,ids,{readObservation=readSavedAmazonObservation,now=()=>new Date().toISOString()}={}){
  savedAdmissionRun(runKey);
  if(!validAdmissionAsins(ids))fail();
  const directory=runtime.care+'/runs/'+runKey;
  const read=async file=>JSON.parse(Buffer.from(await runtime.state.bytes(directory+'/'+file)).toString('utf8'));
  const record=hostedRunRecord(await read('hosted-run.json')),operator=await read('operator.json'),success=await read('success.json');
  if(record.kind!=='admit'||record.runKey!==runKey||!ids?.length||ids.some(id=>!record.admitAsins.includes(id))
    ||operator.source!==record.source||operator.configPath!==directory+'/config.json'||success.source!==record.source
    ||success.result?.state!=='finalized')fail();
  const bytes=await runtime.state.bytes(operator.configPath);if(sha(bytes)!==operator.configSha256)fail();
  const config=JSON.parse(Buffer.from(bytes).toString('utf8'));
  if(config.codeSha!==record.source||config.runId!==operator.runId||config.cadence?.admitAsins?.some(id=>!record.admitAsins.includes(id))
    ||canonicalJson(config.cadence?.admitAsins)!==canonicalJson(record.admitAsins)
    ||config.publication?.sourceRoot!=='/home/runner/stupid-gifts/operators/'+record.source
    ||config.environment!==CATALOG_SCOPE.environment||config.accountId!==CATALOG_SCOPE.accountId
    ||config.database?.id!==CATALOG_SCOPE.databaseId||config.vectorIndex?.name!==CATALOG_SCOPE.indexName)fail();
  const observation=await readObservation({directory:runtime.workspace,repository:config.publication.sourceRoot,mode:'resume',
    runId:config.runId,codeSha:config.codeSha,configSha256:operator.configSha256,scope:CATALOG_SCOPE,
    retention:config.retention,budgetCaps:{httpRequests:config.limits.requests,sqlStatements:config.limits.statements},
    requestLimit:'observe',...(runtime.durable?{durable:runtime.durable}:{}),now},ids);
  const pin={schemaVersion:1,runKey,runId:config.runId,source:record.source,configSha256:operator.configSha256,
    manifestSha256:observation.manifestSha256,receiptSha256:observation.ref.sha256,expiresAt:observation.expiresAt,ids:[...ids]};
  return{pin,...observation};
}
/** This adapter cannot dispatch a supplier request. It returns only the exact
 * saved facts; price/rating are unknown rather than invented. Original receipts
 * are restored separately so copy/embedding review retains the original clock. */
export function savedAdmissionEvidence(evidence,saved,ids,associateTag){
  return{...evidence,async amazon(operation,_load,normalize,requestedIds){
    if(operation!=='getItems'||canonicalJson(requestedIds)!==canonicalJson(ids))fail();
    return ids.map(id=>{
      const entry=saved.receipt.products.find(p=>p.id===id);if(!entry)fail();
      const product={...structuredClone(entry.snapshot),id,source:'amazon',currency:'USD',availabilityStatus:entry.availabilityStatus,
        isActive:['IN_STOCK','IN_STOCK_SCARCE','INSTOCKSCARCE','AVAILABLE_DATE','LEADTIME','PREORDER'].includes(entry.availabilityStatus),
        remotelyVerified:true,affiliateUrl:`https://www.amazon.com/dp/${id}?tag=${encodeURIComponent(associateTag)}`};
      return normalize?normalize(product):product;
    });}};
}
