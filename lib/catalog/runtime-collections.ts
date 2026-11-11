import type {CatalogD1} from './storage/d1.ts';
import type {ContentRequest} from './content-admin.ts';
import {ContentAdminError} from './content-admin.ts';
import {canonicalJson} from './canonical-json.ts';

/** Shared by staff writes and the existing homepage editor. A saved request is
 * not a publish: the conditional transaction records its actual application. */
export async function applyRuntimeCollection(db:CatalogD1,request:ContentRequest){
  if(!['collection','restore','active-show'].includes(request.action))throw new ContentAdminError(409,'coordinator_application_required');
  const read=async()=>(await db.prepare('SELECT state,result_json FROM content_admin_results WHERE request_id=?').bind(request.requestId).all<{state:string;result_json:string}>()).results[0];
  const prior=await read();if(prior){if(prior.state!=='applied')throw new ContentAdminError(409,'application_in_progress');return JSON.parse(prior.result_json);}
  const result={state:'applied',resource:request.resource,revision:request.revision,catalogRevision:request.baseCatalogRevision};
  try{await db.batch([
    db.prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id WHERE h.singleton=1 AND h.enabled=1 AND p.catalog_revision=?)
      AND EXISTS(SELECT 1 FROM content_admin_requests WHERE request_id=? AND resource=? AND revision=? AND payload_json=?)
      AND (SELECT max(revision) FROM content_admin_requests WHERE resource=?)=?
      THEN 'true' ELSE 'runtime_collection_conflict' END)`)
      .bind(request.baseCatalogRevision,request.requestId,request.resource,request.revision,canonicalJson(request.payload),request.resource,request.revision),
    db.prepare('INSERT INTO catalog_runtime_collections(name,revision,request_id,payload_json) VALUES(?,?,?,?)')
      .bind(request.resource,request.revision,request.requestId,canonicalJson(request.payload)),
    db.prepare("INSERT INTO content_admin_results(request_id,state,result_json,created_at) VALUES(?,'applied',?,?)")
      .bind(request.requestId,canonicalJson(result),request.createdAt),
    db.prepare('UPDATE catalog_runtime_head SET version=version+1 WHERE singleton=1'),
  ]);}catch(error){const actual=await read();if(actual?.state==='applied'&&actual.result_json===canonicalJson(result))return result;
    const revision=(await db.prepare('SELECT max(revision) n FROM content_admin_requests WHERE resource=?').bind(request.resource).all<{n:number}>()).results[0]?.n;
    if(revision!==request.revision)throw new ContentAdminError(409,'revision_conflict');throw error;}
  const actual=await read();if(actual?.state!=='applied'||actual.result_json!==canonicalJson(result))throw Error('runtime_collection_unconfirmed');return result;
}
