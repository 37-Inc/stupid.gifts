import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {createCatalogD1Rest,createCatalogD1ReadOnlyRest} from './d1-write-rest.ts';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {prepareStaffProduct,staffIntent,staffReady} from './staff-preparation.mjs';
const requestDay=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
export async function prepareAdminAdmissions(runtime,{checkout,source}){
  const s=CATALOG_SCOPE,db=await createCatalogD1ReadOnlyRest({accountId:s.accountId,databaseId:s.databaseId,databaseName:s.databaseName,token:await runtime.token(),requestLimit:'observe'});
  const rows=(await db.prepare(`SELECT r.request_id,r.payload_json,r.created_at FROM content_admin_requests r
    LEFT JOIN content_admin_results a ON a.request_id=r.request_id LEFT JOIN products p ON p.id=json_extract(r.payload_json,'$.asin')
    WHERE r.action='admit' AND a.request_id IS NULL AND p.id IS NULL ORDER BY r.rowid LIMIT 10`).all()).results;
  const repos=new Map(),results=[];
  for(const row of rows){const day=requestDay(row.created_at),asin=JSON.parse(row.payload_json).asin;
    const original=(await staffIntent(runtime,day,asin))?.source??source;
    // Never execute today's provider logic claiming to be an older source.
    if(!repos.has(original))repos.set(original,await checkout(original));
    const repository=repos.get(original);
    const prepare=original===source?prepareStaffProduct:(await import(pathToFileURL(repository+'/scripts/catalog/staff-preparation.mjs').href)).prepareStaffProduct;
    results.push(await prepare({runtime,db,row,day,source:original,repository}));
  }
  return {state:'prepared',requests:rows.length,results};
}

/** Consume explicit staff requests in the EXISTING catalog-production queue.
 * This adapter knows no supplier/copy/index implementation. Its durable claim
 * pins one exact cohort/date; retries call the same normal admission identity. */
export async function consumeAdminAdmissions({db,runtime,source,day,coordinate,ready,now=()=>new Date().toISOString()}){
  const running=(await db.prepare("SELECT request_id,result_json FROM content_admin_results WHERE state='running' AND json_extract(result_json,'$.kind')='admin-admission' ORDER BY created_at LIMIT 1").all()).results[0];
  let claim=running?JSON.parse(running.result_json):null;
  if(!claim){
    const query=db.prepare(`SELECT r.request_id,r.payload_json,r.created_at,p.public_id,
      EXISTS(SELECT 1 FROM catalog_runtime_head h JOIN catalog_runtime_publications v ON v.release_id=h.release_id
        JOIN catalog_public_products c ON c.catalog_revision=v.catalog_revision AND c.product_id=p.id AND c.public_id=p.public_id
        WHERE h.singleton=1 AND h.enabled=1) AS already_public
      FROM content_admin_requests r LEFT JOIN content_admin_results a ON a.request_id=r.request_id
      LEFT JOIN products p ON p.id=json_extract(r.payload_json,'$.asin')
      WHERE r.action='admit' AND a.request_id IS NULL ORDER BY r.rowid LIMIT 10`);
    let rows=(await query.all()).results;
    if(!rows.length)return{state:'empty',admissions:0};
    // Empty wakes and requests for already published gifts don't own or resume care.
    // A row staged by an unfinished run is NOT an accepted product.
    const pending=rows.some(r=>!r.already_public)&&await runtime.durable.get('pointers/pending-run.json');
    if(pending&&JSON.parse(Buffer.from(pending.bytes)).pending!==null){
      if(ready)return{state:'waiting',reason:'existing_catalog_run'};
      const resumed=await coordinate({mode:'full',resumeOnly:true,source,day,runtime});
      if(!['accepted','skipped','idle'].includes(resumed.state))return{state:'pending',reason:'existing_catalog_run',pending:resumed};
      rows=(await query.all()).results;
    }
    if(!rows.length)return{state:'empty',admissions:0};
    let newRows=rows.filter(r=>!r.public_id);const createdAt=now();
    for(const row of rows.filter(r=>r.public_id))await db.prepare("INSERT INTO content_admin_results(request_id,state,result_json,created_at) VALUES(?,'applied',?,?)")
      .bind(row.request_id,canonicalJson({kind:'admin-admission',outcome:'already_exists',publicId:row.public_id}),createdAt).run();
    if(!newRows.length)return{state:'settled',admissions:0};
    if(ready){
      const available=[];
      for(const row of newRows){const asin=JSON.parse(row.payload_json).asin,d=requestDay(row.created_at),pin=await ready(d,asin);
        if(pin?.requestId!==row.request_id||pin.asin!==asin||pin.day!==d)continue;
        if(Date.parse(pin.expiresAt)<=Date.parse(createdAt)){
          await db.prepare("INSERT INTO content_admin_results(request_id,state,result_json,created_at) VALUES(?,'failed',?,?)")
            .bind(row.request_id,canonicalJson({kind:'admin-admission',outcome:'preparation_expired'}),createdAt).run();
        }else available.push(row);}
      if(!available.length)return{state:'waiting',reason:'staff_preparation_not_ready'};
      newRows=available.slice(0,1);day=requestDay(newRows[0].created_at);
    }
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
  try{
    // Each completed new ID has its own receipt; later ready staff requests
    // can then run without waiting for tomorrow. Never restart unrelated care.
    let result;
    for(let i=0;i<10;i++){
      result=await consumeAdminAdmissions({db,runtime,...options,ready:(d,id)=>staffReady(runtime,d,id)});
      if(result.state!=='accepted')break;
      console.log(JSON.stringify({state:'staff_admission_accepted',runKey:result.runKey,releaseId:result.releaseId}));
    }
    return result;
  }
  finally{await retain('accounting',db.metrics());}
}
