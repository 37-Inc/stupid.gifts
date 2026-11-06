type Row=Record<string,unknown>;
const HASH=/^[a-f0-9]{64}$/;
/** Retailer observations, never age, unknown stock or transport errors.
 * Current-field CAS authenticates the referenced immutable operation. */
function retailEvidence(row:Row,missing=false):boolean {
  if(row.source!=='amazon')return false;
  try{
    const p=JSON.parse(String(row.timestamp_provenance_json)).fields?.availability_checked_at;
    const op=JSON.parse(String(row.verification_operation_json));
    if(p?.basis!=='maintenance_operation'||!HASH.test(p.operationId)||op.operation_id!==p.operationId
      ||op.database_time!==row.availability_checked_at
      ||!JSON.parse(String(op.changes_json)).some((c:Row)=>c.productId===row.id))return false;
    if(p.state==='evidenced'&&p.sourceFactsHash===row.source_facts_hash&&typeof p.reference==='string'&&p.reference
      &&typeof p.observedAt==='string'&&Number.isFinite(Date.parse(p.observedAt)))return true;
    const result=JSON.parse(String(op.result_json));
    // Existing confirmation returns missing IDs only after two successful
    // GetItems responses omit them; failed confirmation writes no such receipt.
    return missing&&row.availability_status==='UNAVAILABLE'&&p.state==='unverified_claim'
      &&Array.isArray(result)&&result.includes(row.id);
  }catch{return false;}
}
export function confirmedRetailUnavailable(row:Row):boolean {
  return ['OUT_OF_STOCK','UNAVAILABLE'].includes(String(row.availability_status))&&retailEvidence(row,true);
}
export function confirmedRetailAvailable(row:Row):boolean {
  return ['IN_STOCK','IN_STOCK_SCARCE','INSTOCKSCARCE','AVAILABLE_DATE','LEADTIME','PREORDER'].includes(String(row.availability_status))&&retailEvidence(row);
}
