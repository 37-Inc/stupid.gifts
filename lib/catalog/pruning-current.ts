/** Shared bounded current-field CAS. Pure SQL construction: usable by Worker
 * publication code without importing Node-only snapshot/operator machinery. */
type Row = Record<string, unknown>;
export const PRUNING_CURRENT_LIMITS = Object.freeze({ rowBytes: 128 * 1024, pageBytes: 384 * 1024 });
export const CATALOG_IDENTITY_LIMITS=Object.freeze({ready:5000,held:10000,slugs:20000,identities:10000});
export const PRUNING_CURRENT_COLUMNS = ['id', 'public_id', 'slug', 'source', 'quality_score', 'is_active', 'duplicate_of_product_id',
  'editorial_status', 'availability_status', 'availability_checked_at', 'last_verified_at', 'source_facts_hash',
  'editorial_source_hash', 'embedding_text_hash', 'eligible_until', 'public_display_json', 'rights_json', 'timestamp_provenance_json'];
export const PRUNING_ARCHIVE_TIMES = Object.fromEntries(['id', 'public_id', 'source', 'availability_checked_at', 'last_verified_at']
  .map((key) => [`archived_${key}`, `json_extract(p.source_record_json,'$.${key}')`]));
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).byteLength;

/** Exact original CAS and outer REST escaping bounds. A single-row fragment
 * remains in vector intent transactions; whole snapshots use the owner fence. */
export function pruningCurrentQueries(rows: Row[],deliveryId?:string): Array<{ sql: string; params: unknown[]; count: number }> {
  // A native intent's request_json is immutable. Check its exact saved source
  // in the same transaction instead of rebinding that large body on every CAS.
  if(deliveryId!==undefined&&(!/^[a-f0-9]{64}$/.test(deliveryId)||rows.length!==1))throw Error('read_bounds');
  const chunks: Row[][] = []; let bytes = 0;
  for (const row of rows) {
    const size = byteLength(JSON.stringify(row));
    if (size > PRUNING_CURRENT_LIMITS.rowBytes) throw new Error('read_bounds');
    if (!chunks.length || chunks.at(-1)!.length >= 80 || bytes + size > 256 * 1024) { chunks.push([]); bytes = 0; }
    chunks.at(-1)!.push(row); bytes += size;
  }
  const comparisons = [...PRUNING_CURRENT_COLUMNS.map(key => `p.${key} IS json_extract(e.value,'$.${key}')`),
    ...Object.entries(PRUNING_ARCHIVE_TIMES).map(([key, expression]) => `${expression} IS json_extract(e.value,'$.${key}')`)];
  function query(chunk: Row[]): { sql: string; params: unknown[]; count: number } {
    const columns=[...new Set(chunk.flatMap(row=>row.approved_product_json ? Object.keys(JSON.parse(String(row.approved_product_json))) : []))];
    if(columns.length>65||columns.some(key=>!/^[a-z_]+$/.test(key)))throw new Error('read_bounds');
    const operationCas=['verification_operation_json','approval_operation_json'].map(field=>chunk.some(row=>row[field])
      ? ` AND (json_extract(e.value,'$.${field}') IS NULL OR EXISTS(SELECT 1 FROM catalog_maintenance_operations o
        WHERE o.operation_id=json_extract(json_extract(e.value,'$.${field}'),'$.operation_id')
        AND ${['input_sha256','run_id','catalog_revision','environment','index_name','generation','prior_epoch','next_epoch','database_time','result_json','changes_json']
          .map(key => `o.${key} IS json_extract(json_extract(e.value,'$.${field}'),'$.${key}')`).join(' AND ')}))` : '').join('');
    const source=deliveryId===undefined?'?':`(SELECT json_array(json_extract(request_json,'$.pruneCurrent'))
      FROM catalog_vector_deliveries WHERE delivery_id=?)`;
    return { sql: `SELECT count(*) FROM json_each(${source}) e CROSS JOIN products p
      ON p.public_id=json_extract(e.value,'$.public_id') WHERE ${comparisons.join(' AND ')}${operationCas}${columns.length
        ? ` AND (json_extract(e.value,'$.approved_product_json') IS NULL OR (${columns.map(key=>`p.${key} IS json_extract(json_extract(e.value,'$.approved_product_json'),'$.${key}')`).join(' AND ')}))` : ''}`,
    params: [deliveryId??JSON.stringify(chunk)], count: chunk.length };
  }
  const output: Array<ReturnType<typeof query>> = [];
  function bounded(chunk: Row[]) {
    const value = query(chunk);
    // The JSON param is escaped AGAIN by REST. Reserve room for the ownership
    // assertion and the CAS wrapper, rather than treating raw row bytes as wire.
    if (byteLength(JSON.stringify({batch:[{sql:value.sql,params:value.params}]})) > PRUNING_CURRENT_LIMITS.pageBytes) {
      if (chunk.length === 1) throw new Error('read_bounds');
      const middle = Math.floor(chunk.length/2); bounded(chunk.slice(0,middle)); bounded(chunk.slice(middle));
    } else output.push(value);
  }
  chunks.forEach(bounded); return output;
}
