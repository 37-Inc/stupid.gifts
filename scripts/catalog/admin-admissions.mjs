import {randomUUID} from 'node:crypto';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {createCatalogD1Rest} from './d1-write-rest.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';

/** Consume explicit staff requests in the EXISTING catalog-production queue.
 * This adapter knows no supplier/copy/index implementation. Its durable claim
 * pins one exact cohort/date; retries call the same normal admission identity. */
export async function consumeAdminAdmissions({db,runtime,source,day,coordinate,now=()=>new Date().toISOString()}){
  const running=(await db.prepare("SELECT request_id,result_json FROM content_admin_results WHERE state='running' AND json_extract(result_json,'$.kind')='admin-admission' ORDER BY created_at LIMIT 1").all()).results[0];
  let claim=running?JSON.parse(running.result_json):null;
  if(!claim){
    const pending=await runtime.durable.get('pointers/pending-run.json');
    if(pending&&JSON.parse(Buffer.from(pending.bytes)).pending!==null){
      const resumed=await coordinate({mode:'full',resumeOnly:true,source,day,runtime});
      if(!['accepted','skipped','idle'].includes(resumed.state))return{state:'pending',reason:'existing_catalog_run',pending:resumed};
    }
    const rows=(await db.prepare(`SELECT r.request_id,r.payload_json,p.public_id FROM content_admin_requests r
      LEFT JOIN content_admin_results a ON a.request_id=r.request_id LEFT JOIN products p ON p.id=json_extract(r.payload_json,'$.asin')
      WHERE r.action='admit' AND a.request_id IS NULL ORDER BY r.rowid LIMIT 10`).all()).results;
    if(!rows.length)return{state:'empty',admissions:0};
    const newRows=rows.filter(r=>!r.public_id),createdAt=now();
    for(const row of rows.filter(r=>r.public_id))await db.prepare("INSERT INTO content_admin_results(request_id,state,result_json,created_at) VALUES(?,'applied',?,?)")
      .bind(row.request_id,canonicalJson({kind:'admin-admission',outcome:'already_exists',publicId:row.public_id}),createdAt).run();
    if(!newRows.length)return{state:'settled',admissions:0};
    claim={kind:'admin-admission',day,asins:[...new Set(newRows.map(r=>JSON.parse(r.payload_json).asin))].sort(),requestIds:newRows.map(r=>r.request_id)};
    if(claim.asins.some(id=>! /^[A-Z0-9]{10}$/.test(id)))throw Error('catalog_admin_invalid_admission');
    await db.batch(newRows.map(row=>db.prepare("INSERT INTO content_admin_results(request_id,state,result_json,created_at) VALUES(?,'running',?,?)")
      .bind(row.request_id,canonicalJson(claim),createdAt)));
  }
  if(claim.kind!=='admin-admission'||!/^\d{4}-\d{2}-\d{2}$/.test(claim.day)||!Array.isArray(claim.asins)
    ||!claim.asins.length||claim.asins.length>10||claim.asins.some(id=>! /^[A-Z0-9]{10}$/.test(id))
    ||!Array.isArray(claim.requestIds)||!claim.requestIds.length||claim.requestIds.length>10)throw Error('catalog_admin_invalid_claim');
  // Exact readback before provider work also handles a previously lost claim ACK.
  for(const id of claim.requestIds){const row=(await db.prepare('SELECT state,result_json FROM content_admin_results WHERE request_id=?').bind(id).all()).results[0];
    if(!row||!['running','applied'].includes(row.state)||row.state==='running'&&row.result_json!==canonicalJson(claim))throw Error('catalog_admin_claim_changed');}
  const result=await coordinate({mode:'admit',admitAsins:claim.asins,source,day:claim.day,runtime});
  if(result.state!=='accepted')return{state:'pending',...result};
  for(const id of claim.requestIds){
    const row=(await db.prepare(`SELECT p.public_id FROM content_admin_requests r LEFT JOIN products p ON p.id=json_extract(r.payload_json,'$.asin') WHERE r.request_id=?`).bind(id).all()).results[0];
    const applied={...claim,releaseId:result.releaseId,receiptSha256:result.receiptSha256,runKey:result.runKey,
      outcome:row?.public_id?'catalog_identity_recorded':'not_admitted',publicId:row?.public_id??null};
    await db.prepare("UPDATE content_admin_results SET state='applied',result_json=? WHERE request_id=? AND state='running' AND result_json=?")
      .bind(canonicalJson(applied),id,canonicalJson(claim)).run();
    const actual=(await db.prepare('SELECT state,result_json FROM content_admin_results WHERE request_id=?').bind(id).all()).results[0];
    if(actual?.state!=='applied'||actual.result_json!==canonicalJson(applied))throw Error('catalog_admin_settlement_unconfirmed');
  }
  return{state:'accepted',runKey:result.runKey,releaseId:result.releaseId,requests:claim.requestIds.length};
}
export async function runAdminAdmissions(runtime,options){
  const scope=CATALOG_SCOPE,attempt=randomUUID(),prefix=runtime.care+'/admin-attempts/'+attempt+'/';
  const retain=(name,value)=>runtime.state.put(prefix+name+'.json',value);
  const db=await createCatalogD1Rest({accountId:scope.accountId,databaseId:scope.databaseId,databaseName:scope.databaseName,
    token:await runtime.token(),requestLimit:'observe',accounting:{scope,
      initial:{httpRequests:0,sqlStatements:0,knownRowsRead:0,knownRowsWritten:0,unconfirmedRequests:0},
      reserve:value=>retain(value.id+'-reserved',value),settle:(id,value)=>retain(id+'-settled',value)}});
  try{return await consumeAdminAdmissions({db,runtime,...options});}
  finally{await retain('accounting',db.metrics());}
}
