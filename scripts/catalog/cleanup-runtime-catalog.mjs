import {createCatalogD1Rest} from './d1-write-rest.ts';
import {CATALOG_SCOPE as SCOPE} from './automation-runtime.mjs';
import {createHash} from 'node:crypto';
export async function cleanupRuntimeCatalog(runtime,{now=()=>new Date()}={}){
  const db=await createCatalogD1Rest({accountId:SCOPE.accountId,databaseId:SCOPE.databaseId,databaseName:SCOPE.databaseName,token:await runtime.token(),requestLimit:'observe'});
  if(!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='catalog_runtime_retention'").all()).results.length)return{state:'not_enabled'};
  const at=now().toISOString(),rows=(await db.prepare('SELECT * FROM catalog_runtime_retention WHERE not_after<=? AND purged_at IS NULL ORDER BY not_after LIMIT 100').bind(at).all()).results;
  let removed=0;
  for(const row of rows){
    const match=row.object_key.match(/^public-(?:overlays|finite-assets)\/(\d+)\/([a-f0-9]{64})(?:\.json)?$/);
    if(!match||Number(match[1])!==Date.parse(row.not_after)||match[2]!==row.sha256)throw Error('runtime_retention_binding_changed');
    const object=await runtime.durable.get(row.object_key);if(object){
      if(createHash('sha256').update(object.bytes).digest('hex')!==row.sha256)throw Error('runtime_retention_body_changed');
      await runtime.durable.remove(row.object_key,object.etag);
    }
    await db.prepare('UPDATE catalog_runtime_retention SET purged_at=? WHERE object_key=? AND sha256=? AND not_after=? AND purged_at IS NULL')
      .bind(at,row.object_key,row.sha256,row.not_after).run();removed++;
  }
  return{state:'complete',removed,metrics:db.metrics()};
}
