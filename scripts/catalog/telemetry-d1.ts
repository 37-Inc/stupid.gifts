import type { CatalogD1, D1Statement } from '../../lib/catalog/storage/d1.ts';
import { mutationAssertion, mutationAdvance, readMutationOwner } from '../../lib/catalog/mutation-fence.ts';
import type { MutationOwner } from '../../lib/catalog/mutation-fence.ts';
import { canonicalJson, canonicalTimestamp, sha256 } from './migration.ts';
import { CATALOG_TELEMETRY_VERSION, redactTelemetryText, safeCatalogConfig, sanitizeTelemetryValue } from '../ops/catalog-telemetry.mjs';

type Row=Record<string,unknown>;
type OwnerCursor={current:MutationOwner};
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const KEY=/^[a-zA-Z0-9._:/-]{1,200}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const ITEM_FIELDS=['id','phase','stage','decision','reasonCode','productId','externalId','source','sourceQuery','title','imageUrl',
  'affiliateUrl','canonicalPath','winnerProductId','sourceFactsHash','editorialSourceHash','requiresManualReview','nextAction'];
const snake=(key:string)=>key.replace(/[A-Z]/g,letter=>`_${letter.toLowerCase()}`);
function same(a:MutationOwner|null,b:MutationOwner):boolean {
  return Boolean(a&&a.token===b.token&&a.generation===b.generation&&a.phase==='writing'&&a.environment===b.environment
    &&a.indexName===b.indexName&&a.ownerReference===b.ownerReference&&a.operationKey===b.operationKey);
}
/** Shared full-current read semantics; immutable source JSON alone is not a finished run. */
export function decodeD1CatalogTelemetryRow(row:Row):Row {
  const raw=JSON.parse(String(row.source_record_json));
  const value={...raw,...(row.start_json?JSON.parse(String(row.start_json)):{}),...(row.finish_json?JSON.parse(String(row.finish_json)):{}),...row};
  for(const key of ['config','counts','timings_ms','usage','warnings','details'])if(typeof value[key]==='string')value[key]=JSON.parse(value[key]);
  delete value.start_json;delete value.finish_json;delete value.source_record_json;
  if('dry_run' in value)value.dry_run=value.dry_run===true||value.dry_run===1;
  if('requires_manual_review' in value)value.requires_manual_review=value.requires_manual_review===true||value.requires_manual_review===1;
  return value;
}

/** Five-method existing telemetry seam. Explicit authoritative D1 + same writing
 * owner cursor as maintenance; callers await operations sequentially. Never
 * claims/releases/auto-refreshes ownership or changes historical source bytes.
 */
export function createD1CatalogTelemetryStore(options:{db:CatalogD1;owner:MutationOwner;ownerCursor?:OwnerCursor;runId:string;catalogRevision:string;
  /** Optional durable dispatch journal, after exact normalization and before D1. */
  beforeMutation?:(input:{operationId:string;inputSha256:string;owner:MutationOwner})=>Promise<void>}) {
  const {db,runId,catalogRevision}=options;const cursor=options.ownerCursor||{current:options.owner};
  if(!KEY.test(runId)||!KEY.test(catalogRevision)||catalogRevision.length>64||options.owner.phase!=='writing')throw new Error('telemetry_configuration');
  let tail:Promise<unknown>=Promise.resolve();
  const prepare=(sql:string,params:unknown[]=[])=>{
    if(params.length>100||params.some(value=>typeof value==='string'&&Buffer.byteLength(value)>128*1024))throw new Error('telemetry_bounds');
    return db.prepare(sql).bind(...params);
  };
  const rows=async(sql:string,params:unknown[]=[])=> (await prepare(sql,params).all<Row>()).results;
  const assert=(condition:string,params:unknown[]=[])=>prepare(`SELECT json(CASE WHEN ${condition} THEN 'true' ELSE 'telemetry_conflict' END)`,params);
  const serialize=<T>(operation:()=>Promise<T>)=>{const work=tail.then(operation);tail=work.catch(()=>{});return work;};
  async function mutate(method:string,input:unknown,build:(now:string,operationId:string)=>Promise<D1Statement[]>) {
    const owner={...cursor.current};if(!same(owner,options.owner))throw new Error('telemetry_fenced');
    const bytes=canonicalJson({method,input,runId,catalogRevision,environment:owner.environment,indexName:owner.indexName});
    // Raw item JSON appears twice in the atomic batch (insert + assertion).
    // This input cap also bounds escaped HTTP bodies below512KiB.
    if(Buffer.byteLength(bytes)>96*1024)throw new Error('telemetry_bounds');
    const hash=sha256(bytes);const operationId=sha256(`telemetry:${runId}:${hash}`);
    await options.beforeMutation?.({operationId,inputSha256:hash,owner:{...owner}});
    const recover=async()=>{
      const receipt=(await rows('SELECT * FROM catalog_maintenance_operations WHERE operation_id=?',[operationId]))[0];
      if(!receipt)return false;
      if(receipt.input_sha256!==hash||receipt.environment!==owner.environment||receipt.index_name!==owner.indexName)throw new Error('telemetry_receipt_mismatch');
      const actual=await readMutationOwner(db,owner);
      const ownCommit=receipt.generation===owner.generation&&receipt.prior_epoch===owner.epoch&&actual?.epoch===receipt.next_epoch;
      if(!same(actual,owner)||actual!.epoch<Number(receipt.next_epoch)||(!ownCommit&&actual!.epoch!==owner.epoch))throw new Error('telemetry_fenced');
      cursor.current=Object.freeze(actual!);return true;
    };
    if(await recover())return;
    try{await mutationAssertion(db,owner).all();}catch{throw new Error('telemetry_fenced');}
    const now=String((await rows(`SELECT ${NOW} now`))[0].now);canonicalTimestamp(now);
    const next={...owner,epoch:owner.epoch+1};
    const statements=[mutationAssertion(db,owner),...await build(now,operationId),
      prepare(`INSERT INTO catalog_maintenance_operations(operation_id,input_sha256,run_id,catalog_revision,environment,index_name,
        generation,prior_epoch,next_epoch,database_time,result_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?,?,'null','[]')`,
      [operationId,hash,runId,catalogRevision,owner.environment,owner.indexName,owner.generation,owner.epoch,next.epoch,now]),
      mutationAdvance(db,owner,{sql:'SELECT 1 FROM catalog_maintenance_operations WHERE operation_id=? AND input_sha256=? AND prior_epoch=? AND next_epoch=?',
        params:[operationId,hash,owner.epoch,next.epoch]}),mutationAssertion(db,next)];
    if(statements.length>50)throw new Error('telemetry_batch_bound');
    try{await db.batch(statements);}catch{if(await recover())return;throw new Error('telemetry_conflict');}
    // A confirmed primary transaction already asserted this exact next owner.
    // The catch path above retains exact receipt recovery for a lost ACK.
    cursor.current=Object.freeze(next);
  }
  const runQuery=`SELECT r.*,t.start_json,t.finish_json FROM catalog_runs r LEFT JOIN catalog_run_telemetry t ON t.run_id=r.id`;
  return Object.freeze({
    startCatalogRun:(input:Row={})=>serialize(async()=>{
      if(input.id!==runId)throw new Error('telemetry_run_identity');
      const data={id:runId,telemetry_version:CATALOG_TELEMETRY_VERSION,mode:input.mode||'catalog',trigger:input.trigger||'manual',
        dry_run:input.dryRun===true,git_sha:input.gitSha??null,config:safeCatalogConfig(input.config as Row||{}),status:'running'};
      await mutate('start',data,async now=>{
        const value={...data,started_at:now,updated_at:now};const json=canonicalJson(value);
        return [prepare(`INSERT INTO catalog_runs(id,status,mode,dry_run,started_at,completed_at,source_record_json) VALUES(?,'running',?,?,?,NULL,?)`,
          [runId,data.mode,data.dry_run?1:0,now,json]),prepare('INSERT INTO catalog_run_telemetry(run_id,start_json) VALUES(?,?)',[runId,json])];
      });return runId;
    }),
    finishCatalogRun:(id:string,input:Row={})=>serialize(async()=>{
      if(id!==runId||!['completed','partial','failed'].includes(String(input.status||'completed')))throw new Error('telemetry_run_identity');
      const usage=sanitizeTelemetryValue(input.usage||{}) as Row;
      const data={status:input.status||'completed',counts:sanitizeTelemetryValue(input.counts||{}),timings_ms:sanitizeTelemetryValue(input.timingsMs||{}),usage,
        estimated_cost_usd:Number.isFinite(usage.estimatedCostUsd)?usage.estimatedCostUsd:null,warnings:sanitizeTelemetryValue(input.warnings||[]),
        error_summary:input.error?redactTelemetryText(input.error instanceof Error?input.error.message:input.error):null};
      await mutate('finish',data,async now=>{
        const current=(await rows(`${runQuery} WHERE r.id=?`,[id]))[0];
        if(!current||!current.start_json||current.finish_json!==null)throw new Error('telemetry_already_finalized');
        const finish=canonicalJson({...data,completed_at:now,updated_at:now});
        return [assert(`EXISTS(SELECT 1 FROM catalog_runs WHERE id=? AND status='running' AND completed_at IS NULL AND source_record_json=?)`,[id,current.source_record_json]),
          prepare('UPDATE catalog_run_telemetry SET finish_json=? WHERE run_id=? AND finish_json IS NULL',[finish,id]),
          assert('EXISTS(SELECT 1 FROM catalog_run_telemetry WHERE run_id=? AND start_json=? AND finish_json=?)',[id,current.start_json,finish]),
          prepare('UPDATE catalog_runs SET status=?,completed_at=? WHERE id=?',[data.status,now,id]),
          assert('EXISTS(SELECT 1 FROM catalog_runs WHERE id=? AND status=? AND completed_at=?)',[id,data.status,now])];
      });
    }),
    insertCatalogRunItems:(id:string,items:Row[])=>serialize(async()=>{
      if(id!==runId||!Array.isArray(items)||items.length>2000)throw new Error('telemetry_item_bound');
      for(let offset=0;offset<items.length;offset+=20){
        const batch=items.slice(offset,offset+20).map(item=>{
          if(typeof item.id!=='string'||!UUID.test(item.id))throw new Error('telemetry_item_identity');
          return {...Object.fromEntries(ITEM_FIELDS.map(key=>[snake(key),item[key]??null])),run_id:id,
            requires_manual_review:item.requiresManualReview===true,details:sanitizeTelemetryValue(item.details||{})} as Row;
        });
        await mutate('append',batch,async now=>{
          // Explicit recovery may append the exact pending observations to a
          // failed/partial current run; its immutable finish remains truthful.
          const statements=[assert(`EXISTS(SELECT 1 FROM catalog_runs r JOIN catalog_run_telemetry t ON t.run_id=r.id WHERE r.id=?
            AND ((r.status='running' AND t.finish_json IS NULL) OR
              (r.status IN('partial','failed') AND json_extract(t.finish_json,'$.status')=r.status)))`,[id])];
          for(const item of batch){
            const prior=(await rows('SELECT created_at FROM catalog_run_items WHERE id=?',[item.id]))[0];
            const created=prior?.created_at||now;const raw=canonicalJson({...item,created_at:created});
            statements.push(prepare(`INSERT INTO catalog_run_items(id,run_id,product_id,external_id,decision,requires_manual_review,created_at,source_record_json)
              VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,[item.id,id,item.product_id,item.external_id,item.decision,item.requires_manual_review?1:0,created,raw]),
            assert('EXISTS(SELECT 1 FROM catalog_run_items WHERE id=? AND run_id=? AND source_record_json=?)',[item.id,id,raw]));
          }return statements;
        });
      }
    }),
    loadCatalogRun:(id:string,options:{items?:boolean}={})=>serialize(async()=>{
      const current=(await rows(`${runQuery} WHERE r.id=?`,[id]))[0];if(!current)return null;
      const items=options.items===false?[]:await rows('SELECT * FROM catalog_run_items WHERE run_id=? ORDER BY sequence LIMIT 10001',[id]);
      if(items.length>10000)throw new Error('telemetry_read_bound');
      return {run:decodeD1CatalogTelemetryRow(current),items:items.map(decodeD1CatalogTelemetryRow)};
    }),
    loadRecentCatalogRuns:(limit=10)=>serialize(async()=> (await rows(`${runQuery} ORDER BY r.started_at DESC LIMIT ?`,
      [Math.max(1,Math.min(100,Number(limit)||10))])).map(decodeD1CatalogTelemetryRow)),
  });
}
