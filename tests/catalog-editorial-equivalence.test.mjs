import assert from 'node:assert/strict';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {readFile,readdir} from 'node:fs/promises';
import {normalizedEditorialFacts,originalEditorialEquivalent,originalEditorialEquivalentRow,
  originalEditorialEquivalenceSql} from '../lib/catalog/editorial-equivalence.ts';
import {editorialSourceHash} from '../scripts/ops/catalog-editorial-core.mjs';
import {maintenanceProjection} from '../scripts/catalog/maintenance-state.ts';
import {canonicalJson,sha256} from '../scripts/catalog/migration.ts';
import {createPersistentCatalogProduct} from '../lib/catalog/snapshot.ts';
import {createProjectionPacket,importPublicProjection,getListedRevisionProductsByPublicIds,getRevisionProductsByPublicIds,
  keywordSearchRevision,visibleRevisionCountQuery,rollbackPreflight} from '../lib/catalog/d1.ts';
import {checkCurrent,readApprovedCurrentRows,readApprovedRevisionSource} from '../scripts/catalog/export-d1-snapshot.ts';
import {claimMutationOwnership} from '../lib/catalog/mutation-fence.ts';

const NOW='2026-10-24T16:00:00.000Z';
const article=Array(2).fill(Array(40).fill('Original plastic button commentary for an owned synthetic desk fixture.').join(' ')).join('\n\n');
function fixture(facts={material:'plastic',features:['clicking','desk'],quantity:1,
  itemDimensions:{height:'4 inches',weight:'0.20 pounds'},extra:{empty:{},nullable:null,flag:true}}){
  const old={id:'B000000001',publicId:'00000000-0000-4000-8000-000000000001',slug:'owned-button',source:'amazon',currency:'USD',
    title:'Original plastic desk button',imageUrl:'https://example.invalid/original.jpg',price:'19.99',affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=fixture-20',
    description:'An owned plastic desk button.',wittyDescription:'An owned plastic desk button.',punnyTitle:null,humorTags:[],sourceQuery:'owned fixture',
    isActive:true,duplicateOfProductId:null,qualityScore:'0.8500',rating:null,reviewCount:null,embedding:null,editorialWriteup:article,
    sourceFacts:facts,editorialStatus:'generated_ready',editorialQualityScore:'0.9500',editorialModel:'owned-fixture',
    editorialPromptVersion:'fixture-v1',editorialGeneratedAt:NOW,editorialBlockReason:null,contentUpdatedAt:NOW,
    availabilityStatus:'IN_STOCK',availabilityCheckedAt:NOW,lastVerifiedAt:NOW,createdAt:NOW,updatedAt:NOW};
  old.sourceFactsHash=editorialSourceHash(old);old.editorialSourceHash=old.sourceFactsHash;
  const raw=Object.fromEntries(Object.entries(old).map(([k,v])=>[k.replace(/[A-Z]/g,c=>'_'+c.toLowerCase()),k==='sourceFacts'?JSON.stringify(v):v]));
  const current={...structuredClone(old),title:'Supplier title revision',imageUrl:'https://example.invalid/revised.jpg',editorialStatus:'stale'};
  current.sourceFacts=structuredClone(facts);
  if(current.sourceFacts.itemDimensions&&!Array.isArray(current.sourceFacts.itemDimensions)){
    for(const k of Object.keys(current.sourceFacts.itemDimensions))if(typeof current.sourceFacts.itemDimensions[k]==='string')
      current.sourceFacts.itemDimensions[k]=current.sourceFacts.itemDimensions[k].replace(/inches|pounds/gi,u=>u.toUpperCase());
  }
  current.sourceFactsHash=editorialSourceHash(current);
  const rights=Object.fromEntries(['title','description','wittyDescription','imageUrl','affiliateUrl','editorialWriteup'].map(k=>
    [k,{basis:'owned',reference:'synthetic fixture only',value:old[k]}]));
  const base=createPersistentCatalogProduct({product:{...old,qualityScore:.85,editorialQualityScore:.95},rights},new Date(NOW));
  assert.equal(base.indexable,true);
  const previous={row:{rights_json:canonicalJson(rights),public_display_json:canonicalJson(base),source_record_json:canonicalJson(raw)},product:old};
  const projection=maintenanceProjection(current,rights,'equivalent',NOW,false,null,previous);
  const row={...projection.row,embedding_text_hash:null,timestamp_provenance_json:'{}',source_record_json:canonicalJson(raw)};
  return{old,raw,current,rights,base,row};
}
const positive=f=>originalEditorialEquivalentRow({...f.row,source_record_json:canonicalJson(f.raw),
  maintenance_semantic:canonicalJson(f.current)},article,editorialSourceHash);
function sqlProof(f,semantic=canonicalJson(f.current)){
  const sql=new DatabaseSync(':memory:');try{
    sql.exec('CREATE TABLE products(id,public_id,slug,source,source_facts_hash,editorial_source_hash,editorial_status,is_active,quality_score,duplicate_of_product_id,source_record_json,public_display_json); CREATE TABLE catalog_maintenance_products(product_id,semantic_json)');
    sql.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...['id','public_id','slug','source','source_facts_hash','editorial_source_hash','editorial_status','is_active','quality_score','duplicate_of_product_id'].map(k=>f.row[k]),canonicalJson(f.raw),canonicalJson(f.base));
    sql.prepare('INSERT INTO catalog_maintenance_products VALUES(?,?)').run(f.row.id,semantic);
    return sql.prepare(`SELECT ${originalEditorialEquivalenceSql('p','m.semantic_json',"json_extract(p.public_display_json,'$.editorialWriteup')")} ok
      FROM products p LEFT JOIN catalog_maintenance_products m ON m.product_id=p.id`).get().ok===1;
  }finally{sql.close();}
}

test('JS and SQL retain original source approval through title/photo/unit casing with zero provenance mutation',()=>{
  const f=fixture(),before=structuredClone(f);assert.equal(positive(f),true);assert.equal(sqlProof(f),true);
  assert.equal(originalEditorialEquivalent(canonicalJson(f.raw),f.current,article,editorialSourceHash),true);
  assert.deepEqual(JSON.parse(f.row.public_display_json),f.base);
  assert.doesNotThrow(()=>checkCurrent(f.base,{source_facts_hash:f.current.sourceFactsHash},
    {...f.row,maintenance_semantic:canonicalJson(f.current)},new Date(NOW)));
  assert.deepEqual(f,before);assert.notEqual(f.current.sourceFactsHash,f.old.sourceFactsHash);
  assert.equal(f.current.editorialSourceHash,f.old.editorialSourceHash);assert.equal(f.current.editorialStatus,'stale');
});

test('complete structural facts parity preserves arrays, empty containers, nulls and only dimensional casing',()=>{
  const fixtures=[fixture(),fixture({quantity:1,nested:{z:[],a:{}}}),fixture({itemDimensions:['4 Inches']}),
    fixture({itemDimensions:{height:'04.00 Inches',weight:'0.2 Pounds'},tags:['A','B']})];
  for(const f of fixtures){assert.equal(positive(f),true);assert.equal(sqlProof(f),true);}
  assert.equal(normalizedEditorialFacts({itemDimensions:{height:'4 Inches'}}),normalizedEditorialFacts({itemDimensions:{height:'4 inches'}}));
  assert.notEqual(normalizedEditorialFacts({itemDimensions:['4 Inches']}),normalizedEditorialFacts({itemDimensions:['4 inches']}));
  const numeric=fixture();assert.equal(sqlProof(numeric,canonicalJson(numeric.current).replace('"quantity":1','"quantity":1.0')),true);
  for(const value of ['4e0 Inches','4. Inches','.4 Inches','4..0 Inches','4  Inches','４ Inches']){
    const f=fixture({material:'plastic',itemDimensions:{height:value}});assert.equal(positive(f),false);assert.equal(sqlProof(f),false);
  }
  for(const mutate of [p=>{p.sourceFacts.quantity=2;},p=>{p.sourceFacts.material='metal';},p=>{p.sourceFacts.features.reverse();},
    p=>{delete p.sourceFacts.itemDimensions;},p=>{p.sourceFacts.itemDimensions.height='5 inches';},p=>{p.sourceFacts.itemDimensions.height='4 pounds';},
    p=>{p.sourceFacts.extra.empty=[];},p=>{delete p.sourceFacts.extra.nullable;},p=>{p.sourceFacts.extra.flag=1;},
    p=>{p.sourceFacts.features[0]='CLICKING';},p=>{p.sourceFacts={};}]){
    const f=fixture();mutate(f.current);f.current.sourceFactsHash=editorialSourceHash(f.current);f.row.source_facts_hash=f.current.sourceFactsHash;
    assert.equal(positive(f),false);assert.equal(sqlProof(f),false);
  }
});

test('original approval, current provenance, archive identity and typed consistency cannot be substituted',()=>{
  for(const mutate of [f=>{f.raw.editorial_status='pending';},f=>{f.raw.editorial_quality_score='unknown';},
    f=>{f.raw.editorial_quality_score='1.2';},f=>{f.raw.editorial_source_hash='f'.repeat(64);},f=>{f.raw.id='foreign';},
    f=>{f.current.editorialWriteup+=' changed';},f=>{f.current.editorialModel='different';},f=>{f.current.editorialGeneratedAt='different';},
    f=>{f.current.editorialQualityScore='0.9';},f=>{f.current.editorialStatus='pending';f.row.editorial_status='pending';},
    f=>{f.current.editorialStatus='needs_review';f.row.editorial_status='needs_review';},f=>{f.current.editorialSourceHash='f'.repeat(64);},
    f=>{f.current.sourceFactsHash='f'.repeat(64);},f=>{f.current.isActive=false;},f=>{f.current.duplicateOfProductId='another';},
    f=>{f.current.qualityScore='0.9';},f=>{f.raw.editorial_source_hash=[f.old.editorialSourceHash];},
    f=>{f.raw.editorial_status=['generated_ready'];}]){
    const f=fixture();mutate(f);assert.equal(positive(f),false);assert.equal(sqlProof(f),false);
  }
  const f=fixture();assert.equal(originalEditorialEquivalentRow({...f.row,source_facts_hash:'f'.repeat(64),maintenance_semantic:canonicalJson(f.current)},article,editorialSourceHash),false);
  for(const [rawKey,currentKey] of [['editorial_model','editorialModel'],['editorial_prompt_version','editorialPromptVersion'],['editorial_generated_at','editorialGeneratedAt']]){
    for(const value of ['', ' \t\n', '\u00a0', '\ufeff']){
      const p=fixture();p.raw[rawKey]=value;p.current[currentKey]=value;
      assert.equal(positive(p),false);assert.equal(sqlProof(p),false);
    }
  }
  // JS also recomputes BOTH source hashes; SQL trusts the immutable validated
  // original archive, never an instruction to rewrite it for a new comparison.
  f.raw.title='Unbound raw title';assert.equal(positive(f),false);
});

test('review and curation scores require the same finite JSON numeric types and grammar in JS and SQL',()=>{
  for(const [scope,key] of [['raw','editorial_quality_score'],['current','editorialQualityScore'],['current','qualityScore']]){
    for(const value of [true,false,[.95],{score:.95},null,'','01','0b1','NaN','Infinity']){
      const f=fixture();f[scope][key]=value;
      // Boolean true must not masquerade as the otherwise valid upper bound1.
      if(value===true){f.raw.editorial_quality_score=1;f.current.editorialQualityScore=1;f.row.quality_score=1;f.current.qualityScore=1;f[scope][key]=true;}
      assert.equal(positive(f),false,`${scope}.${key} JS ${JSON.stringify(value)}`);
      assert.equal(sqlProof(f),false,`${scope}.${key} SQL ${JSON.stringify(value)}`);
    }
  }
  for(const value of [.95,'0.9500',' 0.95 ','9.5e-1']){
    const f=fixture();f.raw.editorial_quality_score=value;f.current.editorialQualityScore=value;
    assert.equal(positive(f),true);assert.equal(sqlProof(f),true);
  }
});

for(const originalHashRestored of [false,true])test(`real publication/listing/keyword SQL accepts only permanent equivalence; semantic freshness and holds stay gated (original hash restored: ${originalHashRestored})`,async t=>{
  const f=fixture(),sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  // A later observation can match the original facts again while the writer
  // correctly retains its old stale label. Export must still carry the proof.
  if(originalHashRestored){
    f.current.title=f.old.title;f.current.imageUrl=f.old.imageUrl;
    f.current.sourceFacts=structuredClone(f.old.sourceFacts);
    f.current.sourceFactsHash=editorialSourceHash(f.current);
    f.row.source_facts_hash=f.current.sourceFactsHash;
    assert.equal(f.current.sourceFactsHash,f.current.editorialSourceHash);
    assert.equal(f.current.editorialStatus,'stale');
  }
  for(const file of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(f=>/^00\d\d_.*\.sql$/.test(f)).sort())
    sql.exec(await readFile(new URL('../migrations/d1/'+file,import.meta.url),'utf8'));
  sql.function('strftime',()=>NOW);
  const querySizes=[];
  const db={prepare(text){querySizes.push(Buffer.byteLength(text));let params=[];return{bind(...p){params=p;assert.ok(p.length<=100);return this;},
    async all(){return{results:sql.prepare(text).all(...params).map(r=>({...r}))};},async run(){sql.prepare(text).run(...params);return{success:true};}};},
    async batch(statements){sql.exec('BEGIN');try{const r=[];for(const s of statements)r.push(await s.all());sql.exec('COMMIT');return r;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  sql.prepare(`INSERT INTO products(${Object.keys(f.row).join(',')}) VALUES(${Object.keys(f.row).map(()=>'?')})`).run(...Object.values(f.row));
  sql.prepare('INSERT INTO catalog_maintenance_products VALUES(?,1,?,0,NULL,?)').run(f.row.id,canonicalJson(f.current),'{}');
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:'equivalent',generatedAt:NOW,products:[f.base],heldProducts:[],slugHistory:[]};
  await importPublicProjection(db,await createProjectionPacket(snapshot,{[f.base.publicId]:f.current.sourceFactsHash},'d'.repeat(64),new Date(NOW)));
  assert.deepEqual(await getListedRevisionProductsByPublicIds(db,[f.base.publicId],new Date(NOW),'equivalent'),[f.base]);
  assert.deepEqual(await keywordSearchRevision(db,'plastic',24,new Date(NOW),'equivalent'),[f.base]);
  assert.equal((await rollbackPreflight(db,snapshot,new Date(NOW))).ok,true);
  const q=visibleRevisionCountQuery('equivalent',new Date(NOW));assert.equal(Object.values(sql.prepare(q.sql).get(...q.params))[0],1);
  assert.deepEqual(await getRevisionProductsByPublicIds(db,[f.base.publicId],new Date(NOW),'equivalent'),[]);
  assert.throws(()=>sql.prepare('UPDATE products SET source_record_json=? WHERE id=?').run('{}',f.row.id),/immutable/);
  sql.prepare('INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES(?,?)').run('staging','equivalence-fixture');
  const owner=await claimMutationOwnership(db,{environment:'staging',indexName:'equivalence-fixture'},
    {phase:'freezing',ownerReference:'equivalence-fixture',operationKey:'a'.repeat(64)});
  const captured=await readApprovedCurrentRows(db,[f.base.publicId],owner);
  assert.equal(sha256(canonicalJson(captured.rows[0])),sha256(canonicalJson({...sql.prepare('SELECT * FROM products').get()})));
  assert.doesNotThrow(()=>checkCurrent(f.base,{source_facts_hash:f.current.sourceFactsHash},captured.current[0],new Date(NOW)));
  const unchanged=await readApprovedRevisionSource(db,owner,[f.base.publicId],[]);
  assert.doesNotThrow(()=>checkCurrent(f.base,{source_facts_hash:f.current.sourceFactsHash},unchanged[0],new Date(NOW)));
  assert.ok(Math.max(...querySizes)<100_000,`maximum SQL text ${Math.max(...querySizes)}`);
  for(const patch of [{editorial_status:'blocked'},{editorial_status:'needs_review'},{is_active:0},{duplicate_of_product_id:'another'},
    {rights_json:'{}'}]){
    const [key,value]=Object.entries(patch)[0];sql.prepare(`UPDATE products SET ${key}=? WHERE id=?`).run(value,f.row.id);
    assert.deepEqual(await getListedRevisionProductsByPublicIds(db,[f.base.publicId],new Date(NOW),'equivalent'),[]);
    sql.prepare(`UPDATE products SET ${key}=? WHERE id=?`).run(f.row[key],f.row.id);
  }
  const changed={...f.current,sourceFacts:{...f.current.sourceFacts,quantity:99}};
  sql.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?').run(canonicalJson(changed),f.row.id);
  assert.deepEqual(await keywordSearchRevision(db,'plastic',24,new Date(NOW),'equivalent'),[]);
});
