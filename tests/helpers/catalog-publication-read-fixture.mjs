import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PRUNING_CURRENT_COLUMNS} from '../../lib/catalog/pruning-current.ts';

// Match the release's cardinality and approximate row sizes, not its private product data.
export function fixture(){
  const sql=new DatabaseSync(':memory:');
  const cols='catalog_revision public_id product_id slug title description tags source_facts_hash eligible_until public_display_json display_sha256'.split(' ');
  sql.exec(`CREATE TABLE catalog_public_products(${cols.join(',')},PRIMARY KEY(catalog_revision,public_id));
    CREATE TABLE products(${PRUNING_CURRENT_COLUMNS.join(',')},source_record_json,PRIMARY KEY(public_id));
    CREATE TABLE catalog_maintenance_operations(id);CREATE TABLE catalog_maintenance_products(product_id PRIMARY KEY,semantic_json);
    CREATE TABLE catalog_vector_deliveries(environment,index_name,generation,prior_epoch,owner_json,status,dispatch_token,request_json);
    CREATE TABLE catalog_mutation_scopes(environment,index_name,owner_token,generation,mutation_epoch,phase,owner_reference,operation_key,external_pending);`);
  const owner={environment:'production',indexName:'fixture',token:'one',generation:1,epoch:0,phase:'freezing',ownerReference:'fixture',
    operationKey:'a'.repeat(64),capturedAt:'2026-11-14T00:00:00.000Z'};
  sql.prepare('INSERT INTO catalog_mutation_scopes VALUES(?,?,?,?,?,?,?,?,?)').run('production','fixture','one',1,0,'freezing','fixture',owner.operationKey,0);
  const source=sql.prepare('INSERT INTO products(public_id,public_display_json) VALUES(?,?)');
  const project=sql.prepare('INSERT INTO catalog_public_products(catalog_revision,public_id,public_display_json) VALUES(?,?,?)');
  const rows=[],ids=[];
  sql.exec('BEGIN');
  for(let i=0;i<3470;i++){
    const id='00000000-0000-4000-8000-'+String(i).padStart(12,'0');
    const display=JSON.stringify({title:'Gift '+i,description:'a'.repeat(1080+(i%83))});
    rows.push({public_id:id,public_display_json:display});source.run(id,display);
    if(i<3185){ids.push(id);project.run('sealed',id,display);}
  }
  sql.exec('COMMIT');
  sql.exec(readFileSync(new URL('../../migrations/d1/0020_catalog_source_version.sql',import.meta.url),'utf8'));
  let trips=0;
  const db={prepare(query){return{bind(...params){this.params=params;return this;},
    execute(){return {results:sql.prepare(query).all(...(this.params??[]))};},
    async all(){trips++;return this.execute();}};},
    async batch(statements){trips++;return statements.map(s=>s.execute());}};
  return {db,sql,owner,rows,ids,trips:()=>trips};
}
export async function profileReaders(f,api){
  const start=f.trips();
  const projection=await api.readOwnedProjection(f.db,f.owner,'sealed',f.ids);
  const projected=f.trips();
  await api.assertPruningCurrent(f.db,f.owner,f.rows);
  const first=f.trips();
  await api.assertPruningCurrent(f.db,f.owner,structuredClone(f.rows));
  const checked=f.trips(),ids=f.rows.map(r=>r.public_id);
  const firstCapture=await api.readApprovedRevisionSource(f.db,f.owner,ids,[]);
  const captured=f.trips();
  firstCapture[0].public_display_json='caller mutation must not change the saved capture';
  const second=await api.readApprovedRevisionSource(f.db,f.owner,ids,[]);
  if(second[0].public_display_json!==f.rows[0].public_display_json)throw Error('capture mutated');
  return {products:projection.length,digest:createHash('sha256').update(JSON.stringify(projection)).digest('hex'),
    projectionTrips:projected-start,firstSourceTrips:first-projected,repeatSourceTrips:checked-first,
    firstCaptureTrips:captured-checked,repeatCaptureTrips:f.trips()-captured};
}
