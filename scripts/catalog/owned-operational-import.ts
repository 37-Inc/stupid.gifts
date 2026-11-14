import type { CatalogD1 } from '../../lib/catalog/storage/d1.ts';
import type { MutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { mutationAssertion, mutationFenceQuery, readMutationOwner,pendingVectorReadFence } from '../../lib/catalog/mutation-fence.ts';
import { canonicalJson, sha256 } from './migration.ts';
import { D1_RECOVERY_TABLES } from './d1-logical-tables.ts';
import type { FrozenD1RecoveryInput } from './recovery-delta.ts';
import type { prepareOperationalPacket } from './prepare-operational.ts';
import { decodePgvectorSendBase64 } from './pgvector-binary.ts';
import type { CooperativeCaptureReceipt } from './capture-owned-d1.ts';

type Row=Record<string,unknown>;
type Packet=ReturnType<typeof prepareOperationalPacket>;
const TABLES=['catalog_runs','products','product_slug_history','catalog_run_items','catalog_editorial_events','search_history'] as const;
type Table=typeof TABLES[number];
const COLUMNS:Record<Table,string[]>={
  products:'id public_id slug source title description tags price_minor currency quality_score is_active duplicate_of_product_id editorial_status availability_status availability_checked_at last_verified_at source_facts_hash editorial_source_hash embedding_text_hash catalog_revision eligible_until public_display_json rights_json source_record_json created_at updated_at timestamp_provenance_json'.split(' '),
  product_slug_history:'slug product_id created_at source_record_json'.split(' '),
  catalog_runs:'id status mode dry_run started_at completed_at source_record_json'.split(' '),
  catalog_run_items:'sequence id run_id product_id external_id decision requires_manual_review created_at source_record_json'.split(' '),
  catalog_editorial_events:'id run_id product_id event_type status created_at source_record_json timestamp_provenance_json'.split(' '),
  search_history:'id created_at legacy_bundle_id legacy_bundle_slug archive_reference source_record_json timestamp_provenance_json'.split(' '),
};
const HASH=/^[a-f0-9]{64}$/;
const key=(table:string)=>table==='product_slug_history'?'slug':'id';
const sorted=(rows:Row[])=>[...rows].sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
const digest=(rows:Row[])=>sha256(canonicalJson(sorted(rows)));
function refuse(code='input'):never{throw new Error(`owned_import_${code}`);}
function index(rows:Row[],field:string){const map=new Map<string,Row>();for(const row of rows){
  if(typeof row[field]!=='string'||!row[field]||map.has(row[field] as string))refuse('identity');map.set(row[field] as string,row);
}return map;}
function integer(value:unknown):number{if(!Number.isSafeInteger(value)||Number(value)<0)refuse('sequence');return Number(value);}
function scalarRows(rows:Row[]){for(const row of rows)if(!row||typeof row!=='object'||Array.isArray(row)
  ||Object.keys(row).some(c=>!/^[_a-z][_a-z0-9]*$/.test(c))||Object.values(row).some(v=>v!==null&&typeof v!=='string'&&!(typeof v==='number'&&Number.isFinite(v))))refuse();}
export interface OwnedImportBatch {table:Table;rows:Row[]}
export interface OwnedOperationalImportPlan {
  schemaVersion:1;kind:'owned-operational-union';sourceManifestSha256:string;packetSha256:string;captureSha256:string;
  provenance:FrozenD1RecoveryInput['provenance'];owner:MutationOwner;importedAt:string;
  baseline:Record<string,Row[]>;batches:OwnedImportBatch[];
  sequenceMapping:Array<{id:string;sourceSequence:number;targetSequence:number}>;
}
const ownerAt=(plan:OwnedOperationalImportPlan,n:number):MutationOwner=>({...plan.owner,epoch:plan.owner.epoch+n});
function receipt(plan:OwnedOperationalImportPlan,planSha256:string,n:number){return{
  export_sha256:planSha256,table_name:plan.batches[n].table,batch_number:n,
  batch_sha256:sha256(canonicalJson({planSha256,batch:plan.batches[n],owner:ownerAt(plan,n),
    sequenceMapping:plan.batches[n].rows.flatMap(row=>plan.sequenceMapping.filter(m=>m.id===row.id))})),
  row_count:plan.batches[n].rows.length,imported_at:plan.importedAt,
};}
type Query={sql:string;params:unknown[]};
function queries(plan:OwnedOperationalImportPlan,planSha256:string,n:number):Query[]{
  const owner=ownerAt(plan,n),next=ownerAt(plan,n+1),batch=plan.batches[n],columns=COLUMNS[batch.table],r=receipt(plan,planSha256,n);
  const gate=mutationFenceQuery(owner),after=mutationFenceQuery(next),payload=canonicalJson(batch.rows);
  const predicate=columns.map(c=>`t.${c} IS json_extract(j.value,'$.${c}')`).join(' AND ');
  const receiptColumns=Object.keys(r),receiptParams=Object.values(r);
  // The same strict assertion now runs inside INSERT; the final next-owner
  // assertion still rolls back rows, receipt and epoch on any later drift.
  return[
    {sql:`INSERT INTO ${batch.table}(${columns.join(',')}) SELECT ${columns.map(c=>`json_extract(j.value,'$.${c}')`).join(',')} FROM json_each(?) j
      WHERE json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'mutation_fenced' END)='true'`,params:[payload,...gate.params]},
    {sql:`INSERT INTO migration_imports(${receiptColumns.join(',')}) SELECT ${receiptColumns.map(()=>'?').join(',')}
      WHERE (SELECT count(*) FROM json_each(?) j JOIN ${batch.table} t ON t.${key(batch.table)}=json_extract(j.value,'$.${key(batch.table)}') WHERE ${predicate})=?`,params:[...receiptParams,payload,batch.rows.length]},
    {sql:`UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1 WHERE environment=? AND index_name=? AND ${gate.sql}
      AND EXISTS(SELECT 1 FROM migration_imports WHERE export_sha256=? AND table_name=? AND batch_number=? AND batch_sha256=? AND row_count=? AND imported_at=?)`,params:[owner.environment,owner.indexName,...gate.params,...receiptParams]},
    {sql:`SELECT json(CASE WHEN ${after.sql} THEN 'true' ELSE 'mutation_fenced' END)`,params:after.params},
  ];
}

/** Pure private packet composition. Does not infer public rights, touch original
 * native vectors, or turn an unverified capture into barrier evidence. */
export function prepareOwnedOperationalImport(options:{packet:Packet;capture:FrozenD1RecoveryInput;captureSha256:string;owner:MutationOwner}){
  const {packet,capture,owner}=options;mutationFenceQuery(owner);
  if(owner.phase!=='writing'||!HASH.test(options.captureSha256)||sha256(canonicalJson(capture))!==options.captureSha256
    ||capture.schemaVersion!==1||capture.scope!=='application-logical-tables-through-0012'
    ||!['synthetic-fixture','unverified-capture'].includes(capture.provenance.kind)||capture.provenance.barrierEvidence!==null
    ||!capture.provenance.reference.trim()||Object.keys(capture.tables).sort().join(',')!==D1_RECOVERY_TABLES.join(',')
    ||capture.inventory.length!==D1_RECOVERY_TABLES.length||new Set(capture.inventory.map(i=>i.table)).size!==D1_RECOVERY_TABLES.length
    ||!HASH.test(packet.summary.sourceManifestSha256)||new Date(packet.summary.importedAt).toISOString()!==packet.summary.importedAt)refuse();
  let total=0;for(const name of D1_RECOVERY_TABLES){const rows=capture.tables[name],entry=capture.inventory.find(i=>i.table===name);
    if(!Array.isArray(rows)||rows.length>20_000||!entry||entry.rows!==rows.length||entry.sha256!==sha256(canonicalJson(rows)))refuse();
    scalarRows(rows);total+=rows.length;
  }
  if(total>100_000||Buffer.byteLength(canonicalJson(capture))>128*1024*1024)refuse('bounds');
  const scopeRows=capture.tables.catalog_mutation_scopes.filter(r=>r.environment===owner.environment&&r.index_name===owner.indexName);
  const captured=scopeRows[0];if(scopeRows.length!==1||!captured||captured.owner_token!==owner.token||captured.generation!==owner.generation
    ||captured.mutation_epoch!==owner.epoch||captured.phase!=='writing'||captured.owner_reference!==owner.ownerReference
    ||captured.operation_key!==owner.operationKey||captured.captured_at!==owner.capturedAt||captured.external_pending!==0)refuse('capture_owner');
  for(const row of capture.tables.catalog_maintenance_products){if(row.embedding_present===1
    &&(typeof row.embedding_native_base64!=='string'||decodePgvectorSendBase64(row.embedding_native_base64).length!==1536))refuse('native');}
  const baseline=structuredClone(capture.tables),existing=Object.fromEntries(TABLES.map(t=>[t,index(baseline[t],key(t))])) as Record<Table,Map<string,Row>>;
  const incoming=Object.fromEntries(TABLES.map(t=>[t,[] as Row[]])) as Record<Table,Row[]>;
  for(const batch of packet.batches){if(!TABLES.includes(batch.table as Table)||batch.exportSha256!==packet.summary.sourceManifestSha256)refuse();
    incoming[batch.table as Table].push(...structuredClone(batch.rows));}
  if(packet.summary.batchCount!==packet.batches.length||packet.summary.importedRows!==packet.batches.reduce((n,b)=>n+b.rows.length,0)
    ||packet.summary.sourceIdentityCount!==packet.summary.importedRows+packet.preservedRows.length)refuse('packet');
  const preserved=index(packet.preservedRows,'id');
  for(const [id,row] of preserved)if(canonicalJson(existing.products.get(id))!==canonicalJson(row))refuse('preserved');
  const sequenceMapping:OwnedOperationalImportPlan['sequenceMapping']=[];
  let maximum=Math.max(0,...baseline.catalog_run_items.map(r=>integer(r.sequence)),
    ...baseline.sqlite_sequence.filter(r=>r.name==='catalog_run_items').map(r=>integer(r.seq)));
  for(const table of TABLES){index(incoming[table],key(table));
    incoming[table].sort((a,b)=>table==='catalog_run_items'?integer(a.sequence)-integer(b.sequence):String(a[key(table)]).localeCompare(String(b[key(table)])));
    incoming[table]=incoming[table].filter(row=>{
      scalarRows([row]);if(Object.keys(row).sort().join(',')!==[...COLUMNS[table]].sort().join(','))refuse('columns');
      const old=existing[table].get(String(row[key(table)]));
      if(old){if(canonicalJson(old)!==canonicalJson(row))refuse('overlap');return false;}
      if(table==='products'&&(row.public_display_json!==null||row.eligible_until!==null||row.rights_json!=='{}'||row.title!==''))refuse('rights');
      if(table==='catalog_run_items'){
        const original=integer(row.sequence),raw=JSON.parse(String(row.source_record_json));
        if(String(raw.sequence)!==String(original)||raw.id!==row.id||!original||!Number.isSafeInteger(maximum+1))refuse('sequence');
        row.sequence=++maximum;sequenceMapping.push({id:String(row.id),sourceSequence:original,targetSequence:maximum});
      }
      return true;
    });
  }
  const products=[...baseline.products,...incoming.products];index(products,'public_id');index(products,'slug');
  const productIds=index(products,'id'),runs=index([...baseline.catalog_runs,...incoming.catalog_runs],'id');
  if([...baseline.product_slug_history,...incoming.product_slug_history].some(r=>!productIds.has(String(r.product_id)))
    ||[...baseline.catalog_run_items,...incoming.catalog_run_items].some(r=>!runs.has(String(r.run_id))))refuse('relation');
  const plan:OwnedOperationalImportPlan={schemaVersion:1,kind:'owned-operational-union',sourceManifestSha256:packet.summary.sourceManifestSha256,
    packetSha256:sha256(canonicalJson(packet)),captureSha256:options.captureSha256,provenance:structuredClone(capture.provenance),owner:{...owner},
    importedAt:packet.summary.importedAt,baseline,batches:[],sequenceMapping};
  // Account for the exact escaped JSON request, including repeated assertion
  // payloads. No row/field truncation or transport-limit increase is permitted.
  for(const table of TABLES)for(const row of incoming[table]){
    const last=plan.batches.at(-1);if(!last||last.table!==table||last.rows.length===40)plan.batches.push({table,rows:[]});
    let batch=plan.batches.at(-1)!;batch.rows.push(row);
    if(Buffer.byteLength(JSON.stringify(queries(plan,'0'.repeat(64),plan.batches.length-1)))>480*1024){
      batch.rows.pop();if(!batch.rows.length)refuse('row_bounds');plan.batches.push({table,rows:[row]});batch=plan.batches.at(-1)!;
      if(Buffer.byteLength(JSON.stringify(queries(plan,'0'.repeat(64),plan.batches.length-1)))>480*1024)refuse('row_bounds');
    }
  }
  if(!Number.isSafeInteger(owner.epoch+plan.batches.length)||Buffer.byteLength(canonicalJson(plan))>128*1024*1024)refuse('bounds');
  return{plan,sha256:sha256(canonicalJson(plan))};
}

function validate(plan:OwnedOperationalImportPlan,expected:string){if(!HASH.test(expected)||sha256(canonicalJson(plan))!==expected
  ||plan.schemaVersion!==1||plan.kind!=='owned-operational-union')refuse('plan');}
function sameOwner(a:MutationOwner|null,b:MutationOwner){return a&&canonicalJson(a)===canonicalJson(b);}
function progressRows(plan:OwnedOperationalImportPlan,planSha256:string,completed:number){
  const result=structuredClone(plan.baseline);
  for(let i=0;i<completed;i++){const batch=plan.batches[i];result[batch.table].push(...batch.rows);result.migration_imports.push(receipt(plan,planSha256,i));}
  const items=result.catalog_run_items;if(items.length){const max=Math.max(...items.map(r=>integer(r.sequence)));
    const row=result.sqlite_sequence.find(r=>r.name==='catalog_run_items');if(row)row.seq=Math.max(integer(row.seq),max);else result.sqlite_sequence.push({name:'catalog_run_items',seq:max});}
  const scope=result.catalog_mutation_scopes.find(r=>r.environment===plan.owner.environment&&r.index_name===plan.owner.indexName)!;
  scope.mutation_epoch=plan.owner.epoch+completed;return result;
}

/** Pure exact completed-union state, including genuine batch receipts and
 * allocator/epoch changes. Reusers must compare every captured table. */
export function expectedOwnedOperationalImportRows(plan:OwnedOperationalImportPlan,planSha256:string){
  validate(plan,planSha256);return progressRows(plan,planSha256,plan.batches.length);
}

export interface OwnedImportSequenceRollback {
  planSha256:string;importedSequences:OwnedOperationalImportPlan['sequenceMapping'];
  nativeSequences:Array<{id:string;from:number;to:number}>;normalizedInputSha256:string;
}
/** Pure inverse allocator mapping, not permission to change a source/native
 * record. The original captured bytes remain the rollback sidecar. */
export function normalizeOwnedImportSequences(plan:OwnedOperationalImportPlan,planSha256:string,input:FrozenD1RecoveryInput,
  originals:Row[]){
  validate(plan,planSha256);
  if(Object.keys(input.tables).sort().join(',')!==D1_RECOVERY_TABLES.join(',')||input.inventory.length!==D1_RECOVERY_TABLES.length
    ||new Set(input.inventory.map(i=>i.table)).size!==D1_RECOVERY_TABLES.length)refuse('rollback_input');
  let total=0;
  for(const table of D1_RECOVERY_TABLES){const entry=input.inventory.find(i=>i.table===table),rows=input.tables[table];
    if(!Array.isArray(rows)||rows.length>20_000||!entry||entry.rows!==rows.length||entry.sha256!==sha256(canonicalJson(rows)))refuse('rollback_input');total+=rows.length;}
  if(total>100_000||Buffer.byteLength(canonicalJson(input))>128*1024*1024)refuse('rollback_input');
  const normalized=structuredClone(input);
  const receipts=input.tables.migration_imports;
  for(let n=0;n<plan.batches.length;n++){
    const expected=receipt(plan,planSha256,n),found=receipts.filter(r=>r.export_sha256===planSha256&&r.table_name===expected.table_name&&r.batch_number===n);
    if(found.length!==1||canonicalJson(found[0])!==canonicalJson(expected))refuse('rollback_receipt');
  }
  if(receipts.filter(r=>r.export_sha256===planSha256).length!==plan.batches.length)refuse('rollback_receipt');
  const rows=index(normalized.tables.catalog_run_items,'id'),baseline=index(originals,'id');
  const sourceSequences=originals.map(row=>{
    if(typeof row.sequence!=='string'||!/^[1-9][0-9]*$/.test(row.sequence))refuse('rollback_mapping');
    return integer(Number(row.sequence));
  });
  if(new Set(sourceSequences).size!==sourceSequences.length)refuse('rollback_mapping');
  const imported=index(plan.batches.filter(b=>b.table==='catalog_run_items').flatMap(b=>b.rows),'id');
  const mapped=new Set<string>();
  for(const mapping of plan.sequenceMapping){
    const row=rows.get(mapping.id),expected=imported.get(mapping.id),original=baseline.get(mapping.id);
    if(mapped.has(mapping.id)||!row||!expected||!original||String(original.sequence)!==String(mapping.sourceSequence)
      ||row.sequence!==mapping.targetSequence||canonicalJson(row)!==canonicalJson(expected)
      ||String(JSON.parse(String(row.source_record_json)).sequence)!==String(mapping.sourceSequence))refuse('rollback_mapping');
    row.sequence=mapping.sourceSequence;mapped.add(mapping.id);
  }
  if(mapped.size!==imported.size)refuse('rollback_mapping');
  const used=new Set(sourceSequences.map(String));
  let maximum=Math.max(0,...sourceSequences,...normalized.tables.catalog_run_items.map(r=>integer(r.sequence)));
  const nativeSequences:OwnedImportSequenceRollback['nativeSequences']=[];
  for(const row of [...rows.values()].filter(r=>!baseline.has(String(r.id))).sort((a,b)=>integer(a.sequence)-integer(b.sequence)||String(a.id).localeCompare(String(b.id)))){
    const from=integer(row.sequence);if(!from)refuse('rollback_mapping');
    if(used.has(String(from))){if(!Number.isSafeInteger(maximum+1))refuse('sequence');row.sequence=++maximum;nativeSequences.push({id:String(row.id),from,to:maximum});}
    used.add(String(row.sequence));
  }
  normalized.inventory=D1_RECOVERY_TABLES.map(table=>({table,rows:normalized.tables[table].length,sha256:sha256(canonicalJson(normalized.tables[table]))}));
  const proof:OwnedImportSequenceRollback={planSha256,importedSequences:structuredClone(plan.sequenceMapping),nativeSequences,
    normalizedInputSha256:sha256(canonicalJson(normalized))};
  return{input:normalized,proof};
}

/** Source triggers invalidate both row captures and inventory proofs. Missing
 * migration retains ordinary reads; no cache survives this process. */
export async function readOwnedSourceVersion(db:CatalogD1,owner:MutationOwner,signal?:AbortSignal){
  const schema=await db.prepare(`SELECT count(*) n FROM sqlite_master WHERE (name='catalog_source_version' AND type='table')
    OR (type='trigger' AND name IN('catalog_source_products_insert','catalog_source_products_update','catalog_source_products_delete',
      'catalog_source_private_insert','catalog_source_private_update','catalog_source_private_delete',
      'catalog_source_operations_insert','catalog_source_operations_update','catalog_source_operations_delete'))`).all<{n:number}>({signal});
  if(schema.results[0]?.n!==10)return null;
  const fence=pendingVectorReadFence(owner);
  const row=(await db.prepare(`SELECT version,json(CASE WHEN ${fence.sql} THEN 'true' ELSE 'mutation_fenced' END) owned
    FROM catalog_source_version WHERE singleton=1`).bind(...fence.params).all<{version:number}>({signal})).results;
  if(row.length!==1||!Number.isSafeInteger(row[0].version)||row[0].version<0)refuse('source_version');
  return row[0].version;
}
const sourceCaptures=new WeakMap<CatalogD1,{key:string;version:number;rows:Record<string,Row[]>}>();
const SOURCE_TABLES=['catalog_maintenance_operations','catalog_maintenance_products','products'];
/** Exact logical read bounded by SQLite's own serialized row sizes. Caller owns
 * the barrier; before/after assertions cannot replace gating every writer. */
export async function readOwnedLogicalRows(db:CatalogD1,owner:MutationOwner,options:{phase?:'freezing'|'activating';signal?:AbortSignal;
  tables?:typeof D1_RECOVERY_TABLES[number][];pendingVector?:true}={}){
  const phase=options.phase??'writing';if(owner.phase!==phase)refuse('owner');
  if(options.pendingVector&&phase!=='freezing')refuse('owner');
  const fence=options.pendingVector?pendingVectorReadFence(owner):mutationFenceQuery(owner,[phase]);
  const assert=()=>db.prepare(`SELECT json(CASE WHEN ${fence.sql} THEN 'true' ELSE 'mutation_fenced' END)`).bind(...fence.params);
  const tables=options.tables??D1_RECOVERY_TABLES;
  if(!tables.length||new Set(tables).size!==tables.length||tables.some(t=>!D1_RECOVERY_TABLES.includes(t)))refuse('schema');
  options.signal?.throwIfAborted();await assert().all({signal:options.signal});
  const cacheable=['freezing','activating'].includes(phase)&&[...tables].sort().join(',')===SOURCE_TABLES.join(','),
    version=cacheable?await readOwnedSourceVersion(db,owner,options.signal):null,
    cacheKey=canonicalJson({...owner,epoch:0,phase:'source-capture'}),cached=sourceCaptures.get(db);
  if(version!==null&&cached?.key===cacheKey&&cached.version===version){
    await assert().all({signal:options.signal});
    if(await readOwnedSourceVersion(db,owner,options.signal)!==version)refuse('source_changed');
    return structuredClone(cached.rows);
  }
  const schemas=await db.batch(tables.map(t=>db.prepare(options.signal?`SELECT name FROM pragma_table_info('${t}')`:`PRAGMA table_info(${t})`)),{signal:options.signal}) as Array<{results:Array<{name:string}>}>;
  if(!Array.isArray(schemas)||schemas.length!==tables.length)refuse('schema');
  const result:Record<string,Row[]>={};
  for(const [i,table] of tables.entries()){
    const columns=schemas[i].results.map(r=>r.name);if(!columns.length||columns.some(c=>!/^[_a-z][_a-z0-9]*$/.test(c)||['_cursor','_bytes','_total','rowid'].includes(c))
      ||TABLES.includes(table as Table)&&[...columns].sort().join(',')!==[...COLUMNS[table as Table]].sort().join(','))refuse('schema');
    const list=columns.join(','),size=`length(CAST(json_object(${columns.flatMap(c=>[`'${c}'`,c]).join(',')}) AS BLOB))`;
    const rows:Row[]=[];let cursor:string|undefined;
    for(;;){
      const sql=`WITH bounded AS (SELECT rowid _cursor,${list},${size} _bytes FROM ${table}
        ${cursor===undefined?'':'WHERE rowid>CAST(? AS INTEGER)'} ORDER BY rowid LIMIT 40), sized AS
        (SELECT *,sum(_bytes) OVER(ORDER BY _cursor) _total FROM bounded)
        SELECT CAST(_cursor AS TEXT) _cursor,${list} FROM sized
        WHERE CASE WHEN _bytes>393216 THEN json('owned_import_read_bounds') ELSE _total<=393216 END ORDER BY sized._cursor`;
      const page=(await db.prepare(options.signal?`SELECT * FROM (${sql})`:sql)
        .bind(...(cursor===undefined?[]:[cursor])).all<Row>({signal:options.signal})).results;
      // Every bounded nonempty input has a fitting first row or throws above;
      // an empty result is therefore EOF, never an oversized hidden record.
      if(!page.length)break;
      for(const row of page){cursor=String(row._cursor);delete row._cursor;rows.push(row);}if(rows.length>20_000)refuse('bounds');
    }
    result[table]=rows;
  }
  await assert().all({signal:options.signal});
  if(version!==null){
    if(await readOwnedSourceVersion(db,owner,options.signal)!==version)refuse('source_changed');
    sourceCaptures.set(db,{key:cacheKey,version,rows:structuredClone(result)});
  }
  return result;
}

async function inspect(db:CatalogD1,plan:OwnedOperationalImportPlan,planSha256:string,cursor:MutationOwner){
  const actual=await readMutationOwner(db,plan.owner);if(!actual)refuse('owner');
  const completed=actual.epoch-plan.owner.epoch;
  if(!Number.isSafeInteger(completed)||completed<0||completed>plan.batches.length||!sameOwner(actual,ownerAt(plan,completed))
    ||!(sameOwner(cursor,actual)||completed>0&&sameOwner(cursor,ownerAt(plan,completed-1))))refuse('owner');
  const expected=progressRows(plan,planSha256,completed),rows=await readOwnedLogicalRows(db,actual);
  for(const table of D1_RECOVERY_TABLES)if(digest(rows[table])!==digest(expected[table]))refuse(`baseline_drift_${table}`);
  return{owner:actual,completed,rows};
}

/** No claim/release, schema changes, publication or vector work. Non-synthetic
 * input requires independently rechecked cooperative capture evidence; selecting
 * a real database still requires the actual canary and reviewed writer stops. */
export async function applyOwnedOperationalImport(options:{db:CatalogD1;plan:OwnedOperationalImportPlan;planSha256:string;
  ownerCursor:{current:MutationOwner};checkpoint?:(owner:MutationOwner)=>Promise<void>;
  cooperativeCapture?:{receipt:CooperativeCaptureReceipt;sha256:string}}){
  const {db,planSha256,ownerCursor}=options;const plan=structuredClone(options.plan);validate(plan,planSha256);
  if(plan.provenance.kind!=='synthetic-fixture'&&!options.cooperativeCapture)refuse('capture_unverified');
  if(plan.provenance.kind==='synthetic-fixture'&&options.cooperativeCapture)refuse('capture_proof_kind');
  const proof=options.cooperativeCapture?structuredClone(options.cooperativeCapture):undefined;
  const validateCapture=proof?async(currentOwner:MutationOwner)=>{
    // Deferred local import avoids a module-initialization cycle with the
    // shared logical reader. No HTTP assertion/callback can supply this proof.
    const {validateCooperativeCaptureReceipt}=await import('./capture-owned-d1.ts');
    await validateCooperativeCaptureReceipt({db,originalOwner:plan.owner,currentOwner,baseline:plan.baseline,
      provenance:plan.provenance,captureSha256:plan.captureSha256,proof});
  }:undefined;
  const before=await inspect(db,plan,planSha256,ownerCursor.current);ownerCursor.current=before.owner;
  await validateCapture?.(before.owner);
  for(let n=before.completed;n<plan.batches.length;n++){
    let uncertain=false;
    try{await db.batch(queries(plan,planSha256,n).map(q=>db.prepare(q.sql).bind(...q.params)));}
    catch{uncertain=true;}
    if(uncertain){const recovered=await inspect(db,plan,planSha256,ownerCursor.current);
      if(recovered.completed!==n+1)refuse('batch_unconfirmed');ownerCursor.current=recovered.owner;
    }else ownerCursor.current=ownerAt(plan,n+1);
    await options.checkpoint?.(ownerCursor.current);
  }
  const final=await inspect(db,plan,planSha256,ownerCursor.current);
  await validateCapture?.(final.owner);
  const foreign=(await db.prepare('PRAGMA foreign_key_check').all()).results;if(foreign.length)refuse('foreign_key');
  await db.batch([mutationAssertion(db,final.owner),db.prepare("INSERT INTO products_fts(products_fts) VALUES('integrity-check')"),
    db.prepare("INSERT INTO catalog_public_products_fts(catalog_public_products_fts) VALUES('integrity-check')"),mutationAssertion(db,final.owner)]);
  return{state:'reconciled' as const,owner:final.owner,planSha256,sourceManifestSha256:plan.sourceManifestSha256,
    ...(proof?{cooperativeReceiptSha256:proof.sha256}:{}),
    sequenceMapping:plan.sequenceMapping,tables:D1_RECOVERY_TABLES.map(table=>({table,rows:final.rows[table].length,sha256:digest(final.rows[table])})),
    barrierVerified:false as const,publicationEmitted:false as const,vectorWorkEmitted:0};
}
