import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import {mutationAssertion,readMutationOwner} from '../../lib/catalog/mutation-fence.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {approvedCohortOperationKey,prepareApprovedCohort} from '../../lib/catalog/freeze-approved-cohort.ts';
import {approvedRequestControl,hydrateApprovedRequest} from './approved-catalog-seal.ts';
import {canonicalJson} from './migration.ts';

/** Recover only the SAME owner's one committed projection-seal step. Rebuild
 * and authenticate the complete approved candidate before recording its epoch;
 * never claim an idle/foreign owner or infer native/upload completion. */
export async function recoverProjectionSeal(db:CatalogD1,owner:MutationOwner,control:ReturnType<typeof approvedRequestControl>){
  const actual=await readMutationOwner(db,owner);
  if(canonicalJson(actual)===canonicalJson(owner))return{owner,request:await hydrateApprovedRequest(db,owner,control)};
  if(owner.phase!=='freezing'||!actual||actual.epoch!==owner.epoch+1
    ||canonicalJson({...actual,epoch:owner.epoch})!==canonicalJson(owner))throw Error('cohort_projection_recovery_owner');
  const target=control.request.publicationRevision??control.request.approval.catalogRevision;
  const rows=await db.batch([
    mutationAssertion(db,actual,['freezing']),
    db.prepare('SELECT * FROM catalog_projection_receipts WHERE catalog_revision=?').bind(target),
    db.prepare('SELECT status,source_export_sha256 FROM catalog_revisions WHERE revision=?').bind(target),
    db.prepare('SELECT count(*) n FROM catalog_vector_deliveries WHERE environment=? AND index_name=? AND generation=?')
      .bind(owner.environment,owner.indexName,owner.generation),
    db.prepare('SELECT count(*) n FROM catalog_build_requests WHERE source_revision=?').bind(target),
  ]) as Array<{results:Record<string,unknown>[]} >;
  if(rows[1].results.length!==1||rows[2].results.length!==1||rows[2].results[0].status!=='importing'
    ||rows[3].results[0].n!==0||rows[4].results[0].n!==0)throw Error('cohort_projection_recovery_state');
  const request=await hydrateApprovedRequest(db,actual,control);
  if(approvedCohortOperationKey(request)!==owner.operationKey||owner.ownerReference!==`${request.approval.runId}:freeze`)
    throw Error('cohort_projection_recovery_request');
  // Existing receipt + exact source digest makes staging restartable: this
  // verifies every source/projection row, without inserting missing rows,
  // advancing ownership again, writing products or touching either index.
  const prepared=await prepareApprovedCohort(db,actual,request);
  if(canonicalJson(prepared.owner)!==canonicalJson(actual)
    ||canonicalJson(prepared.revision.packet.receipt)!==canonicalJson(rows[1].results[0])
    ||prepared.revision.sourceDigest!==rows[2].results[0].source_export_sha256)
    throw Error('cohort_projection_recovery_changed');
  return{owner:actual,request};
}
