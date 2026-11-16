import type {CatalogD1,D1Statement} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner,MutationQuery} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion} from '../../lib/catalog/mutation-fence.ts';
import {encodePublicationIntent} from '../../lib/catalog/publication.ts';
import {encodeBuildRequest} from '../../lib/catalog/build-requests.ts';
import type {CatalogBuildRequest} from '../../lib/catalog/build-requests.ts';
import {canonicalJson,sha256} from './migration.ts';

type Receipt={release_id:string;catalog_revision:string;code_sha:string;completed_at:string;manifest_json:string};
export interface RuntimeCommit {
  owner:MutationOwner;receipt:Receipt;requestId:string;runReference:string;request:CatalogBuildRequest;
  dataSha256:string;sourceSnapshotSha256:string;publicSnapshotSha256:string;handoffSha256:string;
  previousReleaseId:string;previousDataSha256:string;
}

/** Exact durable acceptance, including the original owner and real data build.
 * Reading a receipt alone, a successful upload or staging is not acceptance. */
export async function readRuntimeAcceptance(db:CatalogD1,input:RuntimeCommit):Promise<Receipt|null>{
  const {receipt,owner}=input;
  const rows=(await db.prepare(`SELECT r.*,p.data_sha256,p.source_snapshot_sha256,p.public_snapshot_sha256,
    p.handoff_sha256,p.request_id,p.owner_json,p.previous_release_id FROM publication_receipts r
    JOIN catalog_runtime_publications p USING(release_id) WHERE r.release_id=?`).bind(receipt.release_id).all<Record<string,unknown>>()).results;
  if(!rows.length)return null;
  const expected={...receipt,data_sha256:input.dataSha256,source_snapshot_sha256:input.sourceSnapshotSha256,
    public_snapshot_sha256:input.publicSnapshotSha256,handoff_sha256:input.handoffSha256,request_id:input.requestId,
    owner_json:canonicalJson(owner),previous_release_id:input.previousReleaseId};
  if(rows.length!==1||canonicalJson(rows[0])!==canonicalJson(expected))throw Error('runtime_receipt_changed');
  const proof=(await db.prepare(`SELECT h.release_id,b.state,b.request_json,b.run_reference,b.release_id build_release,
    b.dispatch_reference,b.version_reference,s.phase,s.external_pending,s.generation,s.mutation_epoch
    FROM catalog_runtime_head h JOIN catalog_build_requests b ON b.request_id=? JOIN catalog_mutation_scopes s
    ON s.environment=? AND s.index_name=? WHERE h.singleton=1`).bind(input.requestId,owner.environment,owner.indexName).all<Record<string,unknown>>()).results[0];
  if(!proof||proof.release_id!==receipt.release_id||proof.state!=='resolved'||proof.build_release!==receipt.release_id
    ||proof.request_json!==encodeBuildRequest(input.request)||proof.run_reference!==input.runReference
    ||proof.dispatch_reference!=='runtime:'+input.dataSha256||proof.version_reference!==null||proof.phase!=='idle'
    ||proof.external_pending!==0||proof.generation!==owner.generation||proof.mutation_epoch!==owner.epoch)throw Error('runtime_acceptance_changed');
  return receipt;
}

/** The ONE atomic runtime head transition, shared by legacy sealed publication
 * and reviewed public deltas. No ownership claim, provider, build or index call.
 * A lost batch ACK is settled by exact readback, never a blind write replay. */
export async function commitRuntimePublication(db:CatalogD1,input:RuntimeCommit,gate:MutationQuery,beforeCommit:D1Statement[]=[]){
  const {owner,receipt}=input,intent=JSON.parse(receipt.manifest_json),bytes=encodePublicationIntent(intent);
  const requestBytes=encodeBuildRequest(input.request),token=sha256('runtime:'+bytes),at=receipt.completed_at;
  if(!['writing','freezing'].includes(owner.phase)||bytes!==receipt.manifest_json||intent.releaseId!==receipt.release_id
    ||intent.catalogRevision!==receipt.catalog_revision||intent.codeSha!==receipt.code_sha||intent.manifestSha256!==input.dataSha256
    ||intent.catalogSnapshotSha256!==input.sourceSnapshotSha256||intent.priorReleaseId!==input.previousReleaseId
    ||input.request.sourceRevision!==receipt.catalog_revision||input.request.sourceDigest!==input.sourceSnapshotSha256
    ||input.request.codeSha!==receipt.code_sha||input.request.priorReleaseId!==input.previousReleaseId
    ||input.request.environment!==owner.environment||!gate.sql||!Number.isFinite(Date.parse(at))
    ||new Date(at).toISOString()!==at||[input.previousDataSha256,input.dataSha256,input.sourceSnapshotSha256,input.publicSnapshotSha256,input.handoffSha256]
      .some(v=>! /^[a-f0-9]{64}$/.test(v)))throw Error('runtime_commit_invalid');
  const existing=()=>readRuntimeAcceptance(db,input);
  const prior=await existing();if(prior)return prior;
  const assert=(sql:string,params:unknown[]=[])=>db.prepare(`SELECT json(CASE WHEN ${sql} THEN 'true' ELSE 'runtime_publication_fenced' END)`).bind(...params);
  try{await db.batch([
    mutationAssertion(db,owner,[owner.phase]),assert(gate.sql,gate.params),
    assert(`EXISTS(SELECT 1 FROM catalog_runtime_head h JOIN catalog_runtime_publications p ON p.release_id=h.release_id
      WHERE h.singleton=1 AND p.release_id=? AND p.data_sha256=?)`,[input.previousReleaseId,input.previousDataSha256]),
    assert(`EXISTS(SELECT 1 FROM catalog_build_requests WHERE request_id=? AND request_json=? AND state='pending' AND attempts=0)
      AND NOT EXISTS(SELECT 1 FROM publication_outbox WHERE release_id=?)`,[input.requestId,requestBytes,receipt.release_id]),
    ...beforeCommit,
    db.prepare(`INSERT INTO publication_outbox(intent_id,release_id,catalog_revision,intent_json,state,attempts,dispatch_reference,completed_token,created_at,updated_at)
      VALUES(?,?,?,?,'verified',1,?,?,?,?)`).bind(sha256(bytes),receipt.release_id,receipt.catalog_revision,bytes,'runtime:'+input.dataSha256,token,at,at),
    db.prepare('INSERT INTO publication_receipts(release_id,catalog_revision,code_sha,completed_at,manifest_json) VALUES(?,?,?,?,?)')
      .bind(receipt.release_id,receipt.catalog_revision,receipt.code_sha,at,bytes),
    db.prepare(`INSERT INTO catalog_runtime_publications(release_id,catalog_revision,data_sha256,source_snapshot_sha256,
      public_snapshot_sha256,handoff_sha256,request_id,owner_json,previous_release_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(receipt.release_id,receipt.catalog_revision,input.dataSha256,input.sourceSnapshotSha256,input.publicSnapshotSha256,
        input.handoffSha256,input.requestId,canonicalJson(owner),input.previousReleaseId,at),
    db.prepare('UPDATE catalog_runtime_head SET release_id=?,version=version+1 WHERE singleton=1 AND release_id=?').bind(receipt.release_id,input.previousReleaseId),
    db.prepare("UPDATE catalog_revisions SET status='published' WHERE revision=?").bind(receipt.catalog_revision),
    db.prepare(`UPDATE catalog_build_requests SET state='resolved',lease_token=?,lease_until=NULL,run_reference=?,release_id=?,
      dispatch_reference=?,version_reference=NULL,error_code=NULL WHERE request_id=? AND state='pending'`)
      .bind(token,input.runReference,receipt.release_id,'runtime:'+input.dataSha256,input.requestId),
    db.prepare(`UPDATE catalog_mutation_scopes SET phase='idle',owner_token=NULL,owner_reference=NULL,operation_key=NULL,captured_at=NULL
      WHERE environment=? AND index_name=? AND owner_token=? AND generation=? AND mutation_epoch=? AND phase=? AND external_pending=0`)
      .bind(owner.environment,owner.indexName,owner.token,owner.generation,owner.epoch,owner.phase),
    assert(`EXISTS(SELECT 1 FROM catalog_mutation_scopes WHERE environment=? AND index_name=? AND phase='idle'
      AND external_pending=0 AND generation=? AND mutation_epoch=?)`,[owner.environment,owner.indexName,owner.generation,owner.epoch]),
  ]);}catch(error){const accepted=await existing();if(accepted)return accepted;throw error;}
  const accepted=await existing();if(!accepted)throw Error('runtime_receipt_missing');return accepted;
}
