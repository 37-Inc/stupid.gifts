import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createCatalogSnapshot } from '../lib/catalog/snapshot.ts';
import { createProjectionPacket, projectionQueries, getRevisionProductsByPublicIds, visibleRevisionCountQuery } from '../lib/catalog/d1.ts';
import { getProductsByPublicIds, keywordSearch } from '../lib/catalog/storage/d1.ts';
import { hasReviewedGiftShortCopy } from '../lib/gift-slugs.ts';
import { maintenanceProjection, maintenanceEmbeddingText, publishedMaintenanceProduct } from '../scripts/catalog/maintenance-state.ts';
import { createD1CatalogMaintenanceStore } from '../scripts/catalog/maintenance-d1.ts';
import { claimMutationOwnership } from '../lib/catalog/mutation-fence.ts';
import { sha256 } from '../scripts/catalog/migration.ts';
import { checkCurrent } from '../scripts/catalog/export-d1-snapshot.ts';
import { mergeCatalogMaintenanceUpsert } from '../scripts/ops/catalog-maintenance-merge.mjs';
import { editorialSourceHash } from '../scripts/ops/catalog-editorial-core.mjs';

// Entirely synthetic, in-memory fixtures. No merchant, model or live database calls.
const NOW = '2026-10-29T12:00:00.000Z';
const BEFORE = '2026-10-29T11:00:00.000Z';
const SHORT = 'A plastic crab-shaped button for a synthetic test desk.';
function product(overrides = {}) {
  const input = { id:'B000000001', title:'Synthetic Crab Button', price:12, currency:'USD',
    imageUrl:'https://example.invalid/owned-test-crab.jpg', affiliateUrl:'https://www.amazon.com/dp/B000000001?tag=test-20',
    source:'amazon', humorTags:['crab','desk'], punnyTitle:'Synthetic crab button', wittyDescription:SHORT,
    qualityScore:.9, isActive:true, sourceFacts:{material:'plastic',object:'crab button'}, availabilityStatus:'IN_STOCK',
    editorialStatus:'short_ready', editorialQualityScore:.9, editorialModel:'test-only', editorialPromptVersion:'test-short',
    editorialGeneratedAt:BEFORE, remotelyVerified:true, ...overrides };
  const hash = editorialSourceHash(input);
  const merged = mergeCatalogMaintenanceUpsert(null,{...input,editorialSourceHash:hash},
    {sourceFactsHash:hash,databaseTime:BEFORE}).product;
  return {...merged,publicId:'00000000-0000-4000-8000-000000000001',slug:'synthetic-crab-button'};
}
function rights(p) {
  return Object.fromEntries(Object.entries({title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,
    affiliateUrl:p.affiliateUrl,punnyTitle:p.punnyTitle,wittyDescription:p.wittyDescription,humorTags:JSON.stringify(p.humorTags)})
    .map(([field,value])=>[field,{basis:'owned',reference:'test-only-owned-copy',value,
      ...(field==='imageUrl'?{basis:'merchant',observedAt:BEFORE,expiresAt:'2026-10-29T13:00:00.000Z'}:{})}]));
}
const snapshot = p => createCatalogSnapshot([{...p,qualityScore:Number(p.qualityScore),editorialQualityScore:Number(p.editorialQualityScore)}],
  {[p.id]:rights(p)},{catalogRevision:'test-short',now:new Date(NOW)});
const snake = value => value.replace(/[A-Z]/g,letter=>'_'+letter.toLowerCase());
async function setup(p = product()) {
  const sqlite = new DatabaseSync(':memory:');
  for(const name of (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(n=>/^00\d\d_.*\.sql$/.test(n)).sort())
    sqlite.exec(await readFile(new URL('../migrations/d1/'+name,import.meta.url),'utf8'));
  sqlite.function('strftime',(format,instant)=>{assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return NOW;});
  const projected = maintenanceProjection(p,rights(p),'test-short',NOW,true,BEFORE);
  const raw = Object.fromEntries(Object.entries(p).map(([key,value])=>[snake(key),value]));
  raw.humor_tags='{crab,desk}';
  const current = {...projected.row,source_record_json:JSON.stringify(raw)};
  const columns=Object.keys(current);
  sqlite.prepare(`INSERT INTO products(${columns.join(',')}) VALUES(${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>current[k]));
  const sealed = snapshot(p), packet = await createProjectionPacket(sealed,{[p.publicId]:p.sourceFactsHash},'b'.repeat(64),new Date(NOW));
  for(const query of projectionQueries(packet))sqlite.prepare(query.sql).run(...query.params);
  const db={prepare(sql){let values=[];return {sql,get params(){return values;},bind(...params){values=params;return this;},
    async all(){return {results:sqlite.prepare(sql).all(...values).map(r=>({...r}))};},async run(){return sqlite.prepare(sql).run(...values);}};},
    async batch(statements){sqlite.exec('BEGIN');try{for(const s of statements)sqlite.prepare(s.sql).all(...s.params);sqlite.exec('COMMIT');}
      catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  return {sqlite,db,projected,sealed,packet,current,close:()=>sqlite.close()};
}

test('approved short copy without an article becomes a factual public projection and passes final SQL',async()=>{
  const p=product(),f=await setup(p);try{
    assert.equal(hasReviewedGiftShortCopy(p),true);
    assert.equal(publishedMaintenanceProduct(p),true);
    assert.equal(f.projected.semanticEligible,true);
    assert.equal(f.sealed.products.length,1);
    assert.equal(f.sealed.products[0].description,SHORT);
    assert.equal('editorialWriteup' in f.sealed.products[0],false);
    assert.deepEqual(await getRevisionProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-short'),f.sealed.products);
    assert.deepEqual(await getProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-short'),f.sealed.products);
    assert.deepEqual(await keywordSearch(f.db,'crab',60,new Date(NOW),'test-short'),f.sealed.products);
    const count=visibleRevisionCountQuery('test-short',new Date(NOW));
    assert.equal(Object.values(f.sqlite.prepare(count.sql).get(...count.params))[0],1);
    checkCurrent(f.sealed.products[0],f.packet.rows[0],{...f.current,timestamp_provenance_json:'{}'},new Date(NOW));
  }finally{f.close();}
});

test('D1 short-copy upsert accepts exact synthetic vector proof and preserves the immutable source',async()=>{
  const p=product(),f=await setup(p);try{
    const source=f.current.source_record_json;
    f.sqlite.prepare("INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES('staging','test-short')").run();
    const owner=await claimMutationOwnership(f.db,{environment:'staging',indexName:'test-short'},
      {phase:'writing',ownerReference:'test-only-short-copy',operationKey:'d'.repeat(64)});
    const incoming={...p,embedding:Array(1536).fill(.25),remotelyVerified:true};
    const store=createD1CatalogMaintenanceStore({db:f.db,owner,runId:'test-short-native',catalogRevision:'test-short-native',intent:()=>({
      rightsById:{[p.id]:rights(p)},verificationById:{[p.id]:{reference:'test-only-observation',observedAt:BEFORE,sourceFactsHash:p.sourceFactsHash}},
      embeddingById:{[p.id]:{reference:'test-only-native-proof',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:p.sourceFactsHash}},
    })});
    await store.upsertProduct(incoming,p.sourceFactsHash);
    const row=f.sqlite.prepare('SELECT * FROM products WHERE id=?').get(p.id);
    const state=f.sqlite.prepare('SELECT * FROM catalog_maintenance_products WHERE product_id=?').get(p.id);
    assert.equal(row.editorial_status,'short_ready');assert.equal(row.source_record_json,source);
    assert.equal(row.embedding_text_hash,sha256(maintenanceEmbeddingText(p)));
    assert.equal(state.embedding_present,1);assert.ok(state.embedding_native_base64);
    assert.equal(JSON.parse(state.embedding_provenance_json).input,'verified');
    assert.equal('editorialWriteup' in JSON.parse(row.public_display_json),false);
    assert.deepEqual(await getRevisionProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-short'),f.sealed.products);
  }finally{f.close();}
});

test('short-copy projection rejects invalid quality, hash, length and availability without an article gate',()=>{
  for(const patch of [{editorialQualityScore:.79},{editorialQualityScore:1.01},{editorialSourceHash:'b'.repeat(64)},
    {sourceFactsHash:''},{wittyDescription:'Too short.'},{wittyDescription:Array(36).fill('crab').join(' ')},
    {wittyDescription:'crab '.repeat(5)+'x'.repeat(220)},{wittyDescription:'A plastic crab button\nfor a test desk.'},
    {availabilityStatus:'UNAVAILABLE'}]){
    const p={...product(),...patch};
    assert.equal(snapshot(p).products.length,0,JSON.stringify(patch));
    assert.equal(maintenanceProjection(p,rights(p),'test-short',NOW,true,BEFORE).semanticEligible,false,JSON.stringify(patch));
  }
});

test('short review never newly approves a preserved historical article',()=>{
  const historical='Unreviewed historical article must remain private.';
  const p=product({editorialWriteup:historical}),sealed=snapshot(p);
  assert.equal(sealed.products.length,1);
  assert.equal('editorialWriteup' in sealed.products[0],false);
  assert.equal(p.editorialWriteup,historical);
});

test('failed edits retain approved short copy and historical article while changed facts mark it stale',()=>{
  const historical='Historical article retained exactly, never approved by a short review.';
  const old=product({editorialWriteup:historical});
  const incoming={...old,editorialStatus:'needs_review',wittyDescription:'This unapproved replacement must never become the approved short note.',
    editorialWriteup:'Unapproved article replacement.',editorialQualityScore:.1,editorialSourceHash:null};
  const same=mergeCatalogMaintenanceUpsert(old,incoming,{sourceFactsHash:old.sourceFactsHash,databaseTime:NOW}).product;
  assert.equal(same.editorialStatus,'short_ready');
  assert.equal(same.wittyDescription,old.wittyDescription);
  assert.equal(same.editorialWriteup,historical);
  assert.equal(same.editorialQualityScore,old.editorialQualityScore);
  assert.equal(same.editorialSourceHash,old.editorialSourceHash);
  const changed=mergeCatalogMaintenanceUpsert(old,incoming,{sourceFactsHash:'c'.repeat(64),databaseTime:NOW}).product;
  assert.equal(changed.editorialStatus,'stale');
  assert.equal(changed.wittyDescription,old.wittyDescription);
  assert.equal(changed.editorialWriteup,historical);
});

test('a genuinely reviewed short replacement updates its note but not the historical article',()=>{
  const old=product({editorialWriteup:'Historical article, separately preserved.'});
  const note='A synthetic plastic crab button shaped for a desk.';
  const next=mergeCatalogMaintenanceUpsert(old,{...old,wittyDescription:note,editorialStatus:'short_ready',editorialQualityScore:.95},
    {sourceFactsHash:old.sourceFactsHash,databaseTime:NOW}).product;
  assert.equal(next.wittyDescription,note);assert.equal(next.editorialWriteup,old.editorialWriteup);
  assert.equal(next.editorialStatus,'short_ready');assert.equal(next.contentUpdatedAt,NOW);
  assert.equal(snapshot(next).products[0].description,note);
  assert.equal('editorialWriteup' in snapshot(next).products[0],false);
});

test('current finite short-copy quality/text drift cannot pass SQL or final source checks',async()=>{
  for(const patch of [{editorialQualityScore:.1},{wittyDescription:'Too short.'},{editorialStatus:'pending'},
    {sourceFactsHash:'c'.repeat(64)}]){
    const p=product(),f=await setup(p);try{
      const semantic={...p,...patch};
      f.sqlite.prepare(`INSERT INTO catalog_maintenance_products(product_id,version,semantic_json,embedding_present,embedding_provenance_json)
        VALUES(?,1,?,NULL,'{}')`).run(p.id,JSON.stringify(semantic));
      assert.deepEqual(await getRevisionProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-short'),[]);
      assert.deepEqual(await getProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-short'),[]);
      assert.deepEqual(await keywordSearch(f.db,'crab',60,new Date(NOW),'test-short'),[]);
      assert.throws(()=>checkCurrent(f.sealed.products[0],f.packet.rows[0],{...f.current,
        maintenance_semantic:JSON.stringify(semantic),timestamp_provenance_json:'{}'},new Date(NOW)),/current_hold_or_factual_drift/);
    }finally{f.close();}
  }
});

test('short approval cannot smuggle a granted but unreviewed historical article into a finite display',async()=>{
  const p=product({editorialWriteup:'Historical article with no independent long-form approval.'}),f=await setup(p);try{
    const display={...f.sealed.products[0],editorialWriteup:p.editorialWriteup};
    const grants={...rights(p),editorialWriteup:{basis:'owned',reference:'test-only-history-not-editorial-approval',value:p.editorialWriteup}};
    f.sqlite.prepare('UPDATE products SET public_display_json=?,rights_json=? WHERE id=?').run(JSON.stringify(display),JSON.stringify(grants),p.id);
    const changed={...f.sealed,catalogRevision:'test-history',products:[display]};
    const packet=await createProjectionPacket(changed,{[p.publicId]:p.sourceFactsHash},'b'.repeat(64),new Date(NOW));
    for(const query of projectionQueries(packet))f.sqlite.prepare(query.sql).run(...query.params);
    assert.deepEqual(await getRevisionProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-history'),[]);
    assert.deepEqual(await getProductsByPublicIds(f.db,[p.publicId],new Date(NOW),'test-short'),[]);
    assert.throws(()=>checkCurrent(display,packet.rows[0],{...f.current,public_display_json:JSON.stringify(display),
      rights_json:JSON.stringify(grants),timestamp_provenance_json:'{}'},new Date(NOW)),/current_hold_or_factual_drift/);
  }finally{f.close();}
});
