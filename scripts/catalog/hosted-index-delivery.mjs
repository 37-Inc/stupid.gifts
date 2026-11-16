import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {automationRuntime,CATALOG_SCOPE as scope} from './automation-runtime.mjs';
import {createCatalogD1Rest} from './d1-write-rest.ts';
import {currentHostedInputs,readHostedInput} from './hosted-inputs.ts';
import {accountedPublicationFetch} from './publication-read-fetch.ts';
import {drainRuntimeIndexEvents} from './runtime-index-events.ts';

/** Uses the existing private accounting store; each attempt is append-only.
 * These are new delivery attempts, not refunds/resets of earlier unknowns. */
export async function runHostedIndexDelivery(runtime,{send=fetch,openDatabase=createCatalogD1Rest,drain=drainRuntimeIndexEvents,wait=pause,now=()=>new Date()}={}){
  if(!runtime.hosted||!runtime.durable)throw Error('catalog_index_hosted_required');
  const attempt=randomUUID(),root=runtime.care+'/index-attempts/'+attempt+'/',records=new Map(),token=await runtime.token();
  const reserve=async value=>{await runtime.state.put(root+value.id+'-reserved.json',value);records.set(value.id,{reservation:value});};
  const settle=async(id,value)=>{await runtime.state.put(root+id+'-settled.json',value);const record=records.get(id);
    if(!record||record.settlement)throw Error('catalog_index_accounting_changed');record.settlement=value;};
  const db=await openDatabase({accountId:scope.accountId,databaseId:scope.databaseId,databaseName:scope.databaseName,token,
    fetch:send,requestLimit:'observe',accounting:{scope:{accountId:scope.accountId,databaseId:scope.databaseId,databaseName:scope.databaseName},
      initial:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},reserve,settle}});
  try{
    if(!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_runtime_index_events'").all()).results.length)
      return{state:'not_enabled',catalogBlocked:false};
    const ref=await currentHostedInputs(runtime.durable),file=await readHostedInput(runtime.durable,ref,'daily-catalog-care/semantic-search.json'),policy=JSON.parse(Buffer.from(file.bytes));
    const servingIndexName=policy.derivedCatalog?.indexName;
    if(!policy.enabled||typeof servingIndexName!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(servingIndexName))
      throw Error('catalog_index_policy_unavailable');
    const transport=accountedPublicationFetch({reserveBudget:reserve,settleBudget:settle},send,{...scope,identityOrigin:'https://stupid.gifts',
      immutableNative:true,derivedIndexName:servingIndexName});
    let result;
    for(let pass=0;pass<4;pass++){
      result=await drain({db,store:runtime.durable,accountId:scope.accountId,nativeIndexName:scope.indexName,servingIndexName,
        token,fetch:transport,now});
      if(!result.pending||!result.outcomes.length||result.outcomes.some(v=>v.state==='attention'))break;
      if(pass<3)await wait(45000);
    }
    return{state:result.outcomes.some(v=>v.state==='attention')?'attention':result.pending?'pending':'complete',catalogBlocked:false,...result};
  }finally{
    await runtime.state.put(root+'accounting.json',{schemaVersion:1,attempt,completedAt:now().toISOString(),database:db.metrics(),
      requests:records.size,unknown:[...records.values()].filter(r=>!r.settlement||r.settlement.status==='unknown').length});
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.umask(0o077);
  runHostedIndexDelivery(automationRuntime()).then(result=>{
    console.log(JSON.stringify({indexDelivery:result}));if(result.state==='pending')console.warn('::warning::Optional index delivery is pending; catalog publication is already independent.');
    if(result.state==='attention'){console.warn('::warning::Optional index delivery needs attention; catalog publication remains accepted.');process.exitCode=1;}
  }).catch(error=>{const message=error instanceof Error?error.message:'';
    console.warn(JSON.stringify({notice:'index_delivery_attention',errorCode:/^(?:catalog_index|runtime_index|catalog_hosted_input|catalog_object_store)_[a-z0-9_]{1,100}$/.test(message)?message:'catalog_index_delivery_failed',catalogBlocked:false}));
    process.exitCode=1;
  });
}
