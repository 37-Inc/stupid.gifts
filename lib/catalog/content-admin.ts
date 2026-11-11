import type {CatalogD1} from './storage/d1.ts';
import {canonicalJson} from './canonical-json.ts';

export class ContentAdminError extends Error {
  readonly status:number;
  constructor(status:number,code:string){super(code);this.status=status;}
}
export interface ContentRequest {
  requestId:string;resource:string;revision:number;actor:string;reason:string;baseCatalogRevision:string;
  action:'admit'|'product'|'collection'|'active-show'|'restore';payload:unknown;createdAt:string;
  state:'awaiting_application';
}
type Row={request_id:string;request_hash:string;resource:string;revision:number;actor:string;reason:string;
  base_catalog_revision:string;action:ContentRequest['action'];payload_json:string;created_at:string};
const view=(r:Row):ContentRequest=>({requestId:r.request_id,resource:r.resource,revision:r.revision,actor:r.actor,
  reason:r.reason,baseCatalogRevision:r.base_catalog_revision,action:r.action,payload:JSON.parse(r.payload_json),
  createdAt:r.created_at,state:'awaiting_application'});
async function digest(value:unknown){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(value)));
  return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
}
/** One shared request service for HTTP and a future sole-coordinator consumer.
 * It never changes products, calls suppliers/models or invents publication. */
export function createContentRequestStore(db:CatalogD1){
  const one=async(sql:string,...args:unknown[])=>(await db.prepare(sql).bind(...args).all<Row>()).results[0];
  return{
    async get(resource:string,revision?:number){
      const row=await one('SELECT * FROM content_admin_requests WHERE resource=?'+(revision===undefined?' ORDER BY revision DESC LIMIT 1':' AND revision=?'),
        resource,...(revision===undefined?[]:[revision]));return row?view(row):null;
    },
    async byId(requestId:string){const row=await one('SELECT * FROM content_admin_requests WHERE request_id=?',requestId);return row?view(row):null;},
    async recent(){return(await db.prepare('SELECT * FROM content_admin_requests ORDER BY rowid DESC LIMIT 50').all<Row>()).results.map(view);},
    async save(input:Omit<ContentRequest,'revision'|'state'|'createdAt'>&{expectedRevision:number},now:string){
      if(!/^[a-zA-Z0-9_-]{16,100}$/.test(input.requestId)||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
        ||!input.actor||input.actor.length>256||!input.reason.trim()||input.reason.length>500
        ||!/^\/(?:admissions\/[A-Z0-9]{10}|products\/[a-zA-Z0-9._-]{1,100}|collections\/[a-z0-9-]{1,60}|active-show)$/.test(input.resource)
        ||!input.baseCatalogRevision||input.baseCatalogRevision.length>200||new Date(now).toISOString()!==now
        ||!['admit','product','collection','active-show','restore'].includes(input.action))throw new ContentAdminError(400,'invalid_request');
      const hash=await digest(input),payload=canonicalJson(input.payload);
      if(new TextEncoder().encode(payload).length>16000)throw new ContentAdminError(413,'request_too_large');
      const prior=await one('SELECT * FROM content_admin_requests WHERE request_id=?',input.requestId);
      if(prior){if(prior.request_hash!==hash)throw new ContentAdminError(409,'idempotency_conflict');return{request:view(prior),replayed:true};}
      let error:unknown;
      try{
        await db.prepare(`INSERT INTO content_admin_requests
          (request_id,request_hash,resource,revision,actor,reason,base_catalog_revision,action,payload_json,created_at)
          SELECT ?,?,?,?, ?,?,?,?,?,? WHERE coalesce((SELECT max(revision) FROM content_admin_requests WHERE resource=?),0)=?`)
          .bind(input.requestId,hash,input.resource,input.expectedRevision+1,input.actor,input.reason,input.baseCatalogRevision,
            input.action,payload,now,input.resource,input.expectedRevision).run();
      }catch(cause){error=cause;}
      // Exact readback also settles a lost INSERT acknowledgement. No automatic
      // write replay, and an unrelated storage error must not masquerade as 409.
      const saved=await one('SELECT * FROM content_admin_requests WHERE request_id=?',input.requestId);
      if(saved){if(saved.request_hash!==hash)throw new ContentAdminError(409,'idempotency_conflict');return{request:view(saved),replayed:false};}
      const latest=await one('SELECT * FROM content_admin_requests WHERE resource=? ORDER BY revision DESC LIMIT 1',input.resource);
      if((latest?.revision??0)!==input.expectedRevision)throw new ContentAdminError(409,'revision_conflict');
      throw error??new Error('content_admin_write_unconfirmed');
    },
  };
}
