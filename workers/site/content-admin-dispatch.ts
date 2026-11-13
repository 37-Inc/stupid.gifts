import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import {dispatchCatalogWorkflow} from '../../lib/catalog/github-dispatch.ts';

type DispatchState='claimed'|'accepted'|'rejected'|'unknown';
export interface AdmissionDispatch {state:DispatchState;providerStatus:number|null;workflowRunId:number|null;updatedAt:string}
export async function readAdmissionDispatch(db:CatalogD1,requestId:string):Promise<AdmissionDispatch|null>{
  const row=(await db.prepare('SELECT state,provider_status,workflow_run_id,updated_at FROM content_admin_dispatches WHERE request_id=?')
    .bind(requestId).all<{state:DispatchState;provider_status:number|null;workflow_run_id:number|null;updated_at:string}>()).results[0];
  return row?{state:row.state,providerStatus:row.provider_status,workflowRunId:row.workflow_run_id,updatedAt:row.updated_at}:null;
}

/** Dispatch only the reviewed workflow on main. No caller-controlled repo,
 * ref, workflow, secret, or additional product cohort reaches GitHub.
 * A durable single claim precedes POST. Uncertain POSTs are never repeated;
 * the existing coordinator/daily queue can still consume the saved request. */
export async function dispatchAdmission(input:{db:CatalogD1;requestId:string;token:string;
  now?:()=>string;send?:typeof fetch}):Promise<AdmissionDispatch>{
  const {db,requestId,token}=input,now=input.now??(()=>new Date().toISOString());
  if(!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)||!token||token.length>4096||/[^\x21-\x7e]/.test(token))
    throw Error('admin_dispatch_configuration');
  const prior=await readAdmissionDispatch(db,requestId);if(prior)return prior;
  const claim=crypto.randomUUID(),at=now();
  // Atomic insertion, not a pre-read lock. A racing request cannot dispatch.
  try{await db.prepare(`INSERT INTO content_admin_dispatches(request_id,claim_token,state,created_at,updated_at)
    SELECT ?,?,'claimed',?,? FROM content_admin_requests r WHERE r.request_id=? AND r.action='admit'
      AND NOT EXISTS(SELECT 1 FROM content_admin_results a WHERE a.request_id=r.request_id)
    ON CONFLICT(request_id) DO NOTHING`).bind(requestId,claim,at,at,requestId).run();}
  catch{/* Settle the exact claim after an uncertain insertion response. */}
  const row=(await db.prepare('SELECT claim_token FROM content_admin_dispatches WHERE request_id=?').bind(requestId)
    .all<{claim_token:string}>()).results[0];
  if(row?.claim_token!==claim){const saved=await readAdmissionDispatch(db,requestId);
    if(saved)return saved;throw Error('admin_dispatch_claim_unconfirmed');}
  let state:DispatchState='unknown',status:number|null=null,workflowRunId:number|null=null;
  try{
    const result=await dispatchCatalogWorkflow(token,{mode:'admin'},input.send);
    state=result.state;status=result.providerStatus;workflowRunId=result.workflowRunId;
  }catch{/* A connection loss is unknown, never proof that no workflow started. */}
  try{await db.prepare(`UPDATE content_admin_dispatches SET state=?,provider_status=?,workflow_run_id=?,updated_at=?
    WHERE request_id=? AND claim_token=? AND state='claimed'`).bind(state,status,workflowRunId,now(),requestId,claim).run();}
  catch{/* Never repeat a dispatched POST because its local acknowledgement failed. */}
  return await readAdmissionDispatch(db,requestId)??{state:'unknown',providerStatus:status,workflowRunId:null,updatedAt:at};
}
