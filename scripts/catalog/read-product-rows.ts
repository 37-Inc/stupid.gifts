import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
type Row=Record<string,unknown>;

/** Exact point reads, byte-paged before crossing the REST response bound. Return
 * raw SQLite columns (not JSON-rounded numbers); no cache or write authority. */
export async function readProductRows(db:CatalogD1,ids:string[],options:{semantic?:boolean;allowMissing?:boolean}={}):Promise<Row[]>{
  const semantic=options.semantic===true;
  if(!Array.isArray(ids)||ids.length>10000||new Set(ids).size!==ids.length
    ||ids.some(id=>typeof id!=='string'||!id||id.length>255))throw Error('catalog_product_read_bounds');
  if(!ids.length)return [];
  const columns=(await db.prepare("SELECT name FROM pragma_table_info('products') ORDER BY cid").all<{name:string}>()).results.map(r=>r.name);
  if(!columns.length||columns.length>65||columns.some(c=>!/^[_a-z][_a-z0-9]*$/.test(c)))throw Error('catalog_product_read_schema');
  const extras=semantic?{maintenance_version:'s.version',maintenance_semantic:'s.semantic_json',
    maintenance_present:'s.embedding_present',maintenance_native:'NULL',maintenance_provenance:'NULL'}:{};
  const fields=[...columns.map(c=>[c,`p.${c}`]),...Object.entries(extras)],names=fields.map(([c])=>c);
  const wire=`length(CAST(json_object(${fields.map(([c,value])=>`'${c}',${value}`).join(',')}) AS BLOB))+1024`;
  const result:Row[]=[];let bytes=0;
  for(let offset=0;offset<ids.length;){
    const wanted=ids.slice(offset,offset+80);
    const rows=(await db.prepare(`WITH captured AS MATERIALIZED (
      SELECT CAST(i.key AS INTEGER) _position,${fields.map(([c,value])=>`${value} AS ${c}`).join(',')},${wire} _wire
      FROM json_each(?) i LEFT JOIN products p ON p.id=i.value
      ${semantic?'LEFT JOIN catalog_maintenance_products s ON s.product_id=p.id':''}), sized AS (
      SELECT *,sum(_wire) OVER(ORDER BY _position) _total FROM captured)
      SELECT _position,${names.join(',')} FROM sized
      WHERE _total<=393216 OR (_position=0 AND _wire<=512000) ORDER BY _position`)
      .bind(JSON.stringify(wanted)).all<Row>()).results;
    if(!rows.length||rows.length>wanted.length||Buffer.byteLength(JSON.stringify(rows))>512*1024)throw Error('catalog_product_read_bounds');
    for(const [index,row]of rows.entries()){
      if(row._position!==index||Object.keys(row).length!==names.length+1)throw Error('catalog_product_read_changed');
      if(row.id===null&&options.allowMissing)continue;
      if(row.id!==wanted[index])throw Error('catalog_product_read_changed');
      const {_position,...value}=row;void _position;
      bytes+=Buffer.byteLength(JSON.stringify(value));if(bytes>64*1024*1024)throw Error('catalog_product_read_bounds');
      result.push(value);
    }
    offset+=rows.length;
  }
  return result;
}
