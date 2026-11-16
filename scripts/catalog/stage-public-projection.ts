import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {MutationOwner} from '../../lib/catalog/mutation-fence.ts';
import {mutationAssertion,mutationFenceQuery} from '../../lib/catalog/mutation-fence.ts';
import type {ProjectionPacket} from '../../lib/catalog/d1.ts';
import {projectionQueries} from '../../lib/catalog/d1.ts';
import {readOwnedProjection} from './export-d1-snapshot.ts';
import {canonicalJson,sha256} from './migration.ts';

type Row=Record<string,unknown>;
function readOptions(owner:MutationOwner){
  if(!['writing','freezing'].includes(owner?.phase))throw Error('projection_owner_invalid');
  return owner.phase==='writing'?{phase:'writing' as const}:{};
}

/** Public rows only. This never reads private product archives, invokes a
 * provider/index, seals a receipt, advances the public head, or takes ownership. */
export async function verifyOwnedPublicProjection(db:CatalogD1,owner:MutationOwner,packet:ProjectionPacket){
  const rows=await readOwnedProjection(db,owner,packet.receipt.catalog_revision,
    packet.rows.map(row=>String(row.public_id)).sort(),readOptions(owner));
  if(rows.length!==packet.rows.length||canonicalJson(rows)!==canonicalJson([...packet.rows].sort((a,b)=>String(a.public_id).localeCompare(String(b.public_id)))))
    throw Error('prune_projection_changed');
}

/** Shared restartable staging for legacy seals and short runtime publication.
 * Copy unchanged accepted public rows in SQL; transfer only actual differences.
 * A partial/lost write is inspected on resume, never blindly inserted again. */
export async function stageOwnedPublicProjection(input:{db:CatalogD1;owner:MutationOwner;packet:ProjectionPacket;
  previousRevision:string;previousRows:Row[];sealed?:boolean}){
  const {db,owner,packet,previousRevision}=input,revision=packet.receipt.catalog_revision;
  const options=readOptions(owner),gate=mutationFenceQuery(owner,[owner.phase]);
  if(previousRevision===revision)throw Error('projection_revision_invalid');
  if(packet.rows.length!==packet.receipt.product_count||packet.rows.some(row=>row.catalog_revision!==revision)
    ||sha256(JSON.stringify(packet.rows))!==packet.receipt.projection_sha256)throw Error('prune_projection_changed');
  const target=(await db.prepare(`SELECT EXISTS(SELECT 1 FROM catalog_public_products WHERE catalog_revision=?) populated WHERE ${gate.sql}`)
    .bind(revision,...gate.params).all<{populated:number}>()).results;
  if(target.length!==1)throw Error('prune_owner_mismatch');
  const partial=target[0].populated===0?[]:await readOwnedProjection(db,owner,revision,packet.rows.map(row=>String(row.public_id)).sort(),options);
  const expected=new Map(packet.rows.map(row=>[row.public_id,row]));
  if(partial.some(row=>canonicalJson(row)!==canonicalJson(expected.get(String(row.public_id)))))throw Error('prune_projection_changed');
  const present=new Set(partial.map(row=>row.public_id));let missing=packet.rows.filter(row=>!present.has(row.public_id));
  if(input.sealed&&missing.length)throw Error('prune_projection_changed');
  const prior=new Map(input.previousRows.map(row=>[row.public_id,row]));
  const copied=missing.filter(row=>{
    const before=prior.get(row.public_id);
    return before?.catalog_revision===previousRevision&&Object.keys(before).length===Object.keys(row).length
      &&Object.keys(row).every(key=>key==='catalog_revision'||row[key]===before[key]);
  }).map(row=>row.public_id);
  if(copied.length){
    await db.batch([mutationAssertion(db,owner,[owner.phase]),db.prepare(`INSERT INTO catalog_public_products
      (catalog_revision,public_id,product_id,slug,title,description,tags,source_facts_hash,eligible_until,public_display_json,display_sha256)
      SELECT ?,public_id,product_id,slug,title,description,tags,source_facts_hash,eligible_until,public_display_json,display_sha256
      FROM catalog_public_products WHERE catalog_revision=? AND public_id IN (SELECT value FROM json_each(?))`)
      .bind(revision,previousRevision,JSON.stringify(copied))]);
    const reused=new Set(copied);missing=missing.filter(row=>!reused.has(row.public_id));
  }
  const guard={sql:`SELECT json(CASE WHEN ${gate.sql} THEN 'true' ELSE 'mutation_fenced' END)`,params:gate.params};
  for(let offset=0;offset<missing.length;){
    let queries:ReturnType<typeof projectionQueries>=[],inserted=0;
    for(let count=1;count<=Math.min(35,missing.length-offset);count++){
      const next=projectionQueries({...packet,rows:missing.slice(offset,offset+count)},9).slice(0,-1);
      if(next.length>=50||Buffer.byteLength(JSON.stringify({batch:[guard,...next]}))>512*1024)break;
      queries=next;inserted=count;
    }
    if(!queries.length)throw Error('prune_projection_bound');
    await db.batch([mutationAssertion(db,owner,[owner.phase]),...queries.map(query=>db.prepare(query.sql).bind(...query.params))]);
    offset+=inserted;
  }
  await verifyOwnedPublicProjection(db,owner,packet);
  return{copied:copied.length,inserted:packet.rows.length-present.size-copied.length};
}
