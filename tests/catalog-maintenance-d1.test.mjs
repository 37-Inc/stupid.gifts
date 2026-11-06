import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createD1CatalogMaintenanceStore, loadMaintenanceVectorPayload } from '../scripts/catalog/maintenance-d1.ts';
import { maintenanceEmbeddingText, maintenanceSlugs, maintenanceState, maintenanceTextArray } from '../scripts/catalog/maintenance-state.ts';
import { canonicalJson, canonicalTimestamp, convertSourceRow, sha256 } from '../scripts/catalog/migration.ts';
import { mergeCatalogMaintenanceUpsert } from '../scripts/ops/catalog-maintenance-merge.mjs';
import { editorialSourceHash, validateEditorialDraft } from '../scripts/ops/catalog-editorial-core.mjs';
import { claimMutationOwnership, readMutationOwner } from '../lib/catalog/mutation-fence.ts';
import { createPersistentCatalogProduct, publicProductRightsExpiry } from '../lib/catalog/snapshot.ts';
import { checkCurrent } from '../scripts/catalog/export-d1-snapshot.ts';
import { encodePgvectorSendBase64 } from '../scripts/catalog/pgvector-binary.ts';
import { getProductsByPublicIds } from '../lib/catalog/storage/d1.ts';
import { drainVectorOutbox } from '../scripts/catalog/vector-outbox.ts';
import { executeCatalog, parseArgs } from '../scripts/ops/prefetch-catalog.mjs';

// Entirely owned synthetic fixtures: no merchant/source calls, fixture publication,
// current product claims, or embedding generation. The UUIDs/ASINs are test data.
const NOW = '2026-10-20T07:00:00.123Z';
const OLD = '2026-07-01T00:00:00.000Z';
const id = n => `B${String(n).padStart(9,'0')}`;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const vectors = Array(1536).fill(Math.fround(.1)); vectors[1] = Math.fround(1e-45);
const writeup = Array(50).fill('Synthetic crab button fixture factual editorial paragraph.').join(' ')+'\n\n'
  +Array(50).fill('Owned test copy for exact SQL migration behavior only.').join(' ');
function input(n=1,values={}) {
  return { id:id(n),title:`TEST ONLY Crab Button ${n}`,price:'19.99',currency:'USD',imageUrl:'https://example.invalid/crab.jpg',
    affiliateUrl:`https://www.amazon.com/dp/${id(n)}?tag=fixture-20`,source:'amazon',sourceQuery:'test fixture',
    humorTags:['synthetic','crab'],punnyTitle:'Synthetic crab button',wittyDescription:'Owned synthetic fixture description.',
    qualityScore:'0.8500',rating:'4.50',reviewCount:12,isActive:true,editorialWriteup:writeup,sourceFacts:{fixture:true,quantity:1},
    availabilityStatus:'IN_STOCK',editorialStatus:'generated_ready',editorialQualityScore:'0.9500',
    editorialModel:'fixture-model',editorialPromptVersion:'fixture-v1',editorialGeneratedAt:OLD,editorialBlockReason:null,
    duplicateOfProductId:null,remotelyVerified:true,...values };
}
const snake = key => key.replace(/[A-Z]/g,letter => `_${letter.toLowerCase()}`);
function rawProduct(n=1,values={}) {
  const product = input(n,values);
  return { ...Object.fromEntries(Object.entries(product).filter(([key]) => !['remotelyVerified','embedding'].includes(key)).map(([key,value]) => [snake(key),
    key === 'humorTags' ? `{${value.map(v => v === null ? 'NULL' : `"${String(v).replaceAll('\\','\\\\').replaceAll('"','\\"')}"`).join(',')}}`
      : key === 'sourceFacts' ? JSON.stringify(value) : value])),public_id:uuid(n),slug:`test-fixture-${n}`,
    source_facts_hash:editorialSourceHash(product),editorial_source_hash:editorialSourceHash(product),
    availability_checked_at:OLD,last_verified_at:OLD,created_at:null,updated_at:OLD,content_updated_at:OLD,
    embedding:null };
}
const rights = p => Object.fromEntries(Object.entries({ title:p.title,description:p.wittyDescription,imageUrl:p.imageUrl,
  affiliateUrl:p.affiliateUrl,punnyTitle:p.punnyTitle,wittyDescription:p.wittyDescription,editorialWriteup:p.editorialWriteup,
  humorTags:JSON.stringify(p.humorTags) }).map(([key,value]) => [key,{basis:'owned',reference:'test-only-owned-fixture',value}]));
async function setup({products=[],presence={},intent,revision='r-new'}={}) {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = (await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name => /^00\d\d_.*\.sql$/.test(name)).sort();
  for (const name of migrations) sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
  let clock=NOW;
  sqlite.function('strftime',(format,instant) => {assert.equal(format,'%Y-%m-%dT%H:%M:%fZ');assert.equal(instant,'now');return clock;});
  let beforeBatch; let afterBatch; let queries=0; let batches=0;
  const db = { prepare(sql) { let params=[]; return {sql,get params(){return params;},bind(...values){ params=values;return this;},
    async all(){ queries++;return {results:sqlite.prepare(sql).all(...params).map(row => ({...row}))}; },
    async run(){ queries++;return sqlite.prepare(sql).run(...params); } }; },async batch(statements) {
      beforeBatch?.(statements); batches++;sqlite.exec('BEGIN');
      try { for (const statement of statements) {assert.ok(statement.params.length <= 100);sqlite.prepare(statement.sql).all(...statement.params);}sqlite.exec('COMMIT'); }
      catch(error){sqlite.exec('ROLLBACK');throw error;}
      afterBatch?.();
    } };
  for (const raw of products) {
    const timestamps=Object.fromEntries(['created_at','updated_at'].filter(key => raw[key] === null).map(key => [`products.${key}`,
      {timezone:'unresolved',evidence:'Test-only unresolved historical instant retained raw'}]));
    const row=convertSourceRow('products',raw,{catalogRevision:'r-archive',archiveId:'test-archive',timestamps,now:new Date(NOW)});
    const keys=Object.keys(row);sqlite.prepare(`INSERT INTO products(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
  }
  sqlite.prepare(`INSERT INTO catalog_mutation_scopes(environment,index_name) VALUES('staging','fixture-index')`).run();
  const owner = await claimMutationOwnership(db,{environment:'staging',indexName:'fixture-index'},
    {phase:'writing',ownerReference:'test/maintenance',operationKey:'c'.repeat(64)});
  assert.ok(owner);
  let nextId=100;
  const options = {db,owner,runId:'test-run',catalogRevision:revision,newPublicId:() => uuid(nextId++),
    historical:{archiveSha256:'d'.repeat(64),embeddingPresence:Object.fromEntries(products.filter(p => p.public_id in presence).map(p => {
      const row={...p};delete row.embedding;
      return [p.public_id,{present:presence[p.public_id],sourceRecordSha256:sha256(canonicalJson(row))}];
    }))},
    intent:intent || (() => ({reviewedDeleteReference:'test/exact-maintenance-review'}))};
  const store=createD1CatalogMaintenanceStore(options);
  return {sqlite,db,owner,options,store,close:() => sqlite.close(),setClock(value){clock=value;},
    hookBefore(fn){beforeBatch=fn;},hookAfter(fn){afterBatch=fn;},counts:() => ({queries,batches}),
    row:n => ({...sqlite.prepare('SELECT * FROM products WHERE id=?').get(id(n))}),
    state:n => {const r=sqlite.prepare('SELECT * FROM catalog_maintenance_products WHERE product_id=?').get(id(n));return r ? {...r,product:JSON.parse(r.semantic_json)} : null;},
    events:() => sqlite.prepare('SELECT * FROM vector_sync_outbox ORDER BY sequence').all().map(row => ({...row})),
    epoch:() => sqlite.prepare('SELECT mutation_epoch FROM catalog_mutation_scopes').get().mutation_epoch};
}

// Local display-membership fixtures, not provider/publication evidence.
function markPublic(f,products) {
  for(const p of products)f.sqlite.prepare('UPDATE products SET public_display_json=? WHERE id=?').run(canonicalJson({
    id:p.id,publicId:p.public_id,slug:p.slug,source:p.source,title:p.title,description:'Synthetic short description.',
    imageUrl:'/images/gift-placeholder.svg',affiliateUrl:p.affiliate_url,currency:p.currency,price:0,isActive:true,
    qualityScore:Number(p.quality_score),indexable:false,eligibleUntil:null,
  }),p.id);
}

const permanentArticle=Array(9).fill('Synthetic plastic button fixture provides clicking behavior for this owned test.').join(' ')+'\n\n'
  +Array(9).fill('Original crab button commentary checks factual persistence without any real merchant offer.').join(' ');
async function permanentFixture({known=true,direct=false,preservePermanentListings=false,
  sourceFacts={material:'plastic',behavior:'clicking button fixture'}}={}) {
  const p=input(1,{embedding:vectors,editorialWriteup:permanentArticle,
    sourceFacts});
  const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
  assert.equal(validateEditorialDraft(p,p.editorialWriteup).approved,true);
  const supplierRights=rights(p);supplierRights.imageUrl={...supplierRights.imageUrl,basis:'merchant',observedAt:NOW,
    expiresAt:'2026-10-21T07:00:00.123Z'};
  const f=await setup({revision:'r-seed',intent:()=>({rightsById:{[p.id]:supplierRights},
    verificationById:{[p.id]:{reference:'test/original-observation',observedAt:NOW,sourceFactsHash:hash}},
    ...(known ? {embeddingById:{[p.id]:{reference:'test/original-native',model:'text-embedding-3-small',
      text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}} : {})})});
  await f.store.upsertProduct(p,hash);
  const row=f.row(1),baseProduct={...p,publicId:row.public_id,slug:row.slug,title:'Cleared crab identity',
    description:p.wittyDescription,imageUrl:'/images/gift-placeholder.svg',qualityScore:.85,editorialQualityScore:.95,
    sourceFactsHash:hash};
  const baseRights=rights(baseProduct),base=createPersistentCatalogProduct({product:baseProduct,rights:baseRights},new Date(NOW));
  assert.ok(base);assert.equal(base.indexable,true);
  const display=direct||!known ? base : {...JSON.parse(row.public_display_json),persistent:base};
  f.sqlite.prepare('UPDATE products SET public_display_json=?,rights_json=? WHERE id=?')
    .run(canonicalJson(display),canonicalJson({...supplierRights,persistent:baseRights}),p.id);
  // Local fixture receipt only: no vector dispatch or provider claim.
  f.sqlite.prepare("UPDATE vector_sync_outbox SET status='complete',completed_at=?").run(NOW);
  const owner=await readMutationOwner(f.db,f.owner);
  let intent={reviewedDeleteReference:'test/exact-changed-state-review'};
  const store=createD1CatalogMaintenanceStore({...f.options,owner,runId:'test-refresh',catalogRevision:'r-refresh',intent:()=>intent,preservePermanentListings});
  return {...f,p,hash,base,baseRights,supplierRights,store,useIntent(value){intent=value;}};
}

test('fresh merchant projection carries only existing exact permanent clearance and preserves native/source bytes',async()=>{
  const f=await permanentFixture();try{
    const before=f.row(1),native=f.state(1).embedding_native_base64,provenance=f.state(1).embedding_provenance_json;
    const observedAt='2026-10-20T08:00:00.123Z',freshRights=structuredClone(f.supplierRights);
    Object.assign(freshRights.imageUrl,{observedAt,expiresAt:'2026-10-21T08:00:00.123Z'});
    f.setClock(observedAt);f.useIntent({rightsById:{[f.p.id]:freshRights},verificationById:{[f.p.id]:{
      reference:'test/same-response-fresh-observation',observedAt,sourceFactsHash:f.hash}}});
    const fresh={...f.p,embedding:undefined};await f.store.upsertProduct(fresh,f.hash);
    const after=f.row(1),display=JSON.parse(after.public_display_json),permission=JSON.parse(after.rights_json);
    assert.deepEqual(display.persistent,f.base);assert.deepEqual(f.state(1).product.persistentBase,f.base);
    assert.deepEqual(permission,{...freshRights,persistent:f.baseRights});assert.equal(display.eligibleUntil,freshRights.imageUrl.expiresAt);
    assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.state(1).embedding_provenance_json,provenance);
    assert.equal(after.source_record_json,before.source_record_json);
    assert.equal(f.events().filter(e=>e.status==='pending'&&e.operation==='upsert').length,1);
    const epoch=f.epoch();await f.store.upsertProduct(fresh,f.hash);assert.equal(f.epoch(),epoch);assert.deepEqual(f.row(1),after);
  }finally{f.close();}
});
test('D1 daily retailer stock/unknown/price eligibility never revokes an exact cleared listing or renews a supplier offer',async()=>{
  for(const patch of [{availabilityStatus:'UNAVAILABLE'},{availabilityStatus:'UNKNOWN'},{price:999999}]){
    const f=await permanentFixture({preservePermanentListings:true});try{
      const before=f.row(1),native=f.state(1).embedding_native_base64;
      f.setClock('2027-01-01T00:00:00.000Z');
      const p={...f.p,...patch,title:'Fresh merchant title cannot rename a cleared listing',isActive:false,embedding:undefined};await f.store.upsertProduct(p,editorialSourceHash(p));
      const row=f.row(1),display=JSON.parse(row.public_display_json);
      assert.equal(row.is_active,1);assert.equal(display.eligibleUntil,null);assert.equal(display.title,f.base.title);
      assert.equal(display.imageUrl,f.base.imageUrl);assert.equal(display.publicId,f.base.publicId);
      assert.equal(f.state(1).product.supplierEligible,false);assert.equal(row.rights_json,before.rights_json);
      assert.equal(row.source_record_json,before.source_record_json);assert.equal(f.state(1).embedding_native_base64,native);
      assert.equal(f.events().filter(e=>e.status==='pending'&&e.operation==='upsert').length,0);
      assert.equal((await f.store.getActiveCatalogIdentities({includeInactive:true}))[0].title,f.base.title);
      assert.equal(f.state(1).product.title,p.title); // Source remains the actual merchant title.
      await assert.rejects(f.store.deactivateConfirmedMissing([f.p.id],1),/permanent_deactivation_forbidden/);
      assert.equal(f.row(1).is_active,1);
    }finally{f.close();}
  }
});
test('D1 daily retained listing policy never overrides explicit curation or invalid permanent rights',async()=>{
  for(const patch of [{editorialStatus:'blocked'},{editorialStatus:'needs_review'},{duplicateOfProductId:'reviewed-winner'},{qualityScore:null},{}]){
    const f=await permanentFixture({preservePermanentListings:true});try{
      if(Object.keys(patch).length){
        const [key,value]=Object.entries(patch)[0];
        f.sqlite.prepare(`UPDATE products SET ${snake(key)}=? WHERE id=?`).run(value,f.p.id);
        f.sqlite.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?')
          .run(canonicalJson({...f.state(1).product,...patch}),f.p.id);
      }
      if(!Object.keys(patch).length)f.useIntent({rightsById:{[f.p.id]:{persistent:{}}},reviewedDeleteReference:'test/revoked'});
      await f.store.upsertProduct({...f.p,...patch,isActive:false,embedding:undefined},f.hash);
      assert.equal(f.row(1).public_display_json,null);assert.equal(f.row(1).is_active,0);
    }finally{f.close();}
  }
});

test('daily changed supplier input preserves a cleared native vector without inventing deletion review or a new embedding',async()=>{
  const f=await permanentFixture({preservePermanentListings:true});try{
    const before=f.row(1),native=f.state(1).embedding_native_base64,proof=f.state(1).embedding_provenance_json;
    f.useIntent({}); // The real failed daily run supplied no deletion review.
    const p={...f.p,title:'Changed supplier name, not a new cleared identity',embedding:undefined};
    await f.store.upsertProduct(p,editorialSourceHash(p));
    assert.equal(JSON.parse(f.row(1).public_display_json).publicId,f.base.publicId);
    assert.equal(f.row(1).source_record_json,before.source_record_json);
    assert.equal(f.state(1).embedding_native_base64,native);
    assert.equal(f.state(1).embedding_provenance_json,proof);
    assert.equal(f.events().filter(e=>e.status==='pending').length,0);
    const receipt=f.sqlite.prepare('SELECT changes_json FROM catalog_maintenance_operations ORDER BY next_epoch DESC LIMIT 1').get();
    assert.equal(JSON.parse(receipt.changes_json)[0].vectorOperation,null);
  }finally{f.close();}
});

test('approved replacement short copy cannot revoke or borrow the existing permanent description grant',async()=>{
  const f=await permanentFixture({preservePermanentListings:true});try{
    const before=f.row(1),native=f.state(1).embedding_native_base64,proof=f.state(1).embedding_provenance_json;
    f.useIntent({});
    const replacement='A plastic clicking button with a crab motif for a desk.';
    const p={...f.p,wittyDescription:replacement,editorialStatus:'short_ready',embedding:undefined};
    await f.store.upsertProduct(p,editorialSourceHash(p));
    const row=f.row(1),display=JSON.parse(row.public_display_json);
    assert.equal(f.state(1).product.wittyDescription,replacement);
    assert.equal(display.description,f.base.description);assert.notEqual(display.description,replacement);
    assert.equal(display.imageUrl,f.base.imageUrl);assert.equal(display.eligibleUntil,null);
    assert.equal(row.rights_json,before.rights_json);assert.equal(row.source_record_json,before.source_record_json);
    assert.equal(row.embedding_text_hash,null);
    assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.state(1).embedding_provenance_json,proof);
    assert.equal(f.events().filter(e=>e.status==='pending').length,0);
  }finally{f.close();}
});

test('elapsed supplier and editorial windows keep a direct base and original grants with no expiry-only vector work',async()=>{
  for(const direct of [false,true]){
    const f=await permanentFixture({direct});try{
      const original=f.row(1),native=f.state(1).embedding_native_base64,proof=f.state(1).embedding_provenance_json,events=f.events();
      f.setClock('2027-01-01T00:00:00.000Z');
      await f.store.updateAmazonAffiliateUrl(f.p.id,f.p.affiliateUrl);
      const row=f.row(1),display=JSON.parse(row.public_display_json);
      assert.deepEqual(display,f.base);assert.equal(row.eligible_until,null);assert.equal('persistent' in display,false);
      assert.equal(row.rights_json,original.rights_json);assert.equal(row.source_record_json,original.source_record_json);
      assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.state(1).embedding_provenance_json,proof);
      assert.equal(f.state(1).product.availabilityCheckedAt,NOW);assert.deepEqual(f.events(),events);
      assert.equal(publicProductRightsExpiry(display,JSON.parse(row.rights_json),new Date('2027-01-01T00:00:00.000Z')),Infinity);
      assert.doesNotThrow(()=>checkCurrent(display,{source_facts_hash:f.hash},row,new Date('2027-01-01T00:00:00.000Z')));
      assert.equal((await getProductsByPublicIds(f.db,[row.public_id],new Date('2027-01-01T00:00:00.000Z'))).length,0);
    }finally{f.close();}
  }
});

test('public permanent truthiness never proves unknown native input or queues an upsert',async()=>{
  const f=await permanentFixture({known:false});try{
    const native=f.state(1).embedding_native_base64,proof=f.state(1).embedding_provenance_json;
    await f.store.upsertProduct({...f.p,embedding:undefined},f.hash);
    assert.deepEqual(JSON.parse(f.row(1).public_display_json),f.base);assert.equal(f.row(1).embedding_text_hash,null);
    assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.state(1).embedding_provenance_json,proof);
    assert.deepEqual(f.events(),[]);
  }finally{f.close();}
});

test('supplier title/photo churn and dimensional unit casing preserve sealed articles, not fresh semantic proof',async()=>{
  for(const patch of [{title:'A new retailer title'}, {imageUrl:'https://example.invalid/replacement.jpg'},
    {sourceFacts:{material:'plastic',behavior:'clicking button fixture',itemDimensions:{height:'4 Inches',weight:'0.2 Pounds'}}}]){
    const f=await permanentFixture(patch.sourceFacts ? {sourceFacts:{...patch.sourceFacts,
      itemDimensions:{height:'4 inches',weight:'0.2 pounds'}}} : {});try{
      const before=f.row(1),native=f.state(1).embedding_native_base64,proof=f.state(1).embedding_provenance_json;
      const p={...f.p,...patch,embedding:undefined,editorialStatus:'stale'},hash=editorialSourceHash(p);
      assert.notEqual(hash,f.hash);await f.store.upsertProduct(p,hash);
      const expected={...f.base,indexable:false};
      // The shared-copy projection deliberately omits historical display aliases;
      // those original fields still remain in persistentBase below.
      if(patch.title){delete expected.punnyTitle;delete expected.wittyDescription;delete expected.humorTags;}
      assert.deepEqual(JSON.parse(f.row(1).public_display_json),expected);
      assert.deepEqual(f.state(1).product.persistentBase,f.base);
      assert.equal(f.row(1).source_facts_hash,hash);assert.equal(f.row(1).editorial_source_hash,f.hash);
      assert.equal(f.row(1).editorial_status,'stale');assert.equal(f.row(1).embedding_text_hash,null);
      assert.doesNotThrow(()=>checkCurrent(expected,{source_facts_hash:hash},f.row(1),new Date(NOW)));
      assert.equal(f.row(1).rights_json,before.rights_json);assert.equal(f.row(1).source_record_json,before.source_record_json);
      assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.state(1).embedding_provenance_json,proof);
      assert.equal(f.events().filter(e=>e.status==='pending'&&e.operation==='upsert').length,0);
      // Retrying, then a later metadata-only refresh, cannot progressively erase approval.
      const epoch=f.epoch();await f.store.upsertProduct(p,hash);assert.equal(f.epoch(),epoch);
      f.setClock('2026-10-21T07:00:00.123Z');
      const next={...p,title:'Yet another supplier title'};await f.store.upsertProduct(next,editorialSourceHash(next));
      const nextExpected={...expected};delete nextExpected.punnyTitle;delete nextExpected.wittyDescription;delete nextExpected.humorTags;
      assert.deepEqual(JSON.parse(f.row(1).public_display_json),nextExpected);
    }finally{f.close();}
  }
});

test('material or unknown facts and unreviewed article changes still suppress public article without erasing private history',async()=>{
  for(const patch of [{sourceFacts:{material:'metal',behavior:'clicking button fixture'}},
    {sourceFacts:{material:'plastic',behavior:'different behavior'}}, {sourceFacts:{}},
    {sourceFacts:{material:'Plastic',behavior:'clicking button fixture',itemDimensions:{height:'4 inches'}}},
    {sourceFacts:{material:'plastic',behavior:'clicking button fixture',itemDimensions:{height:'5 inches'}}},
    {sourceFacts:{material:'plastic',behavior:'clicking button fixture',itemDimensions:{height:'4 pounds'}}},
    {editorialWriteup:'Invalid short replacement article.'}]){
    const f=await permanentFixture({sourceFacts:{material:'plastic',behavior:'clicking button fixture',itemDimensions:{height:'4 inches'}}});try{
      const original=f.row(1),native=f.state(1).embedding_native_base64,proof=f.state(1).embedding_provenance_json;
      const p={...f.p,embedding:undefined,editorialStatus:'generated_ready',...patch};
      const hash=editorialSourceHash(p);await f.store.upsertProduct(p,hash);
      const display=JSON.parse(f.row(1).public_display_json),expected={...f.base,indexable:false};delete expected.editorialWriteup;
      assert.deepEqual(display,expected);assert.deepEqual(f.state(1).product.persistentBase,f.base);
      if(!patch.editorialWriteup)assert.equal(f.state(1).product.editorialWriteup,f.p.editorialWriteup);
      assert.equal(f.row(1).rights_json,original.rights_json);assert.equal(f.row(1).source_record_json,original.source_record_json);
      assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.state(1).embedding_provenance_json,proof);
      assert.equal(f.events().filter(e=>e.status==='pending'&&e.operation==='delete').length,1);
      assert.equal(f.events().filter(e=>e.status==='pending'&&e.operation==='upsert').length,0);
    }finally{f.close();}
  }
});

test('later refreshes keep the original cleared base privately without republishing suppressed article',async()=>{
  const f=await permanentFixture({preservePermanentListings:true});try{
    const changed={...f.p,embedding:undefined,editorialStatus:'stale',sourceFacts:{material:'different'}};
    await f.store.upsertProduct(changed,editorialSourceHash(changed));
    const first=JSON.parse(f.row(1).public_display_json);
    assert.equal(first.editorialWriteup,undefined);assert.deepEqual(f.state(1).product.persistentBase,f.base);
    f.setClock('2026-10-21T07:00:00.123Z');
    const next={...changed,title:'A later retailer title'};
    await f.store.upsertProduct(next,editorialSourceHash(next));
    assert.equal(JSON.parse(f.row(1).public_display_json).editorialWriteup,undefined);
    assert.deepEqual(f.state(1).product.persistentBase,f.base);
  }finally{f.close();}
});

test('retained article approval cannot promote a previously nonindexable base',async()=>{
  const f=await permanentFixture({direct:true});try{
    const base={...f.base,indexable:false};
    f.sqlite.prepare('UPDATE products SET public_display_json=? WHERE id=?').run(canonicalJson(base),f.p.id);
    const p={...f.p,title:'Different retailer title',editorialStatus:'stale',embedding:undefined};
    await f.store.upsertProduct(p,editorialSourceHash(p));
    const expected={...base};delete expected.punnyTitle;delete expected.wittyDescription;delete expected.humorTags;
    assert.deepEqual(JSON.parse(f.row(1).public_display_json),expected);
    assert.equal(f.row(1).editorial_status,'stale');
  }finally{f.close();}
});

test('current curation holds hide permanent display but retain private clearance for a genuine later release',async()=>{
  for(const [patch,column,value] of [[{isActive:false},'is_active',0],[{duplicateOfProductId:'fixture-winner'},'duplicate_of_product_id','fixture-winner'],
    [{qualityScore:null},'quality_score',null],[{editorialStatus:'needs_review'},'editorial_status','needs_review']]){
    const held=await permanentFixture();try{
      held.sqlite.prepare(`UPDATE products SET ${column}=? WHERE id=?`).run(value,held.p.id);
      held.sqlite.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?')
        .run(canonicalJson({...held.state(1).product,...patch}),held.p.id);
      await held.store.upsertProduct({...held.p,embedding:undefined,...patch},held.hash);
      assert.equal(held.row(1).public_display_json,null);assert.deepEqual(held.state(1).product.persistentBase,held.base);
    }finally{held.close();}
  }
  const f=await permanentFixture();try{
    const state=f.state(1).product;state.editorialStatus='blocked';
    f.sqlite.prepare("UPDATE products SET editorial_status='blocked' WHERE id=?").run(f.p.id);
    f.sqlite.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?').run(canonicalJson(state),f.p.id);
    await f.store.upsertProduct({...f.p,embedding:undefined,editorialStatus:'blocked'},f.hash);
    assert.equal(f.row(1).public_display_json,null);assert.deepEqual(f.state(1).product.persistentBase,f.base);
    // Explicit local curation change, not a daily refresh inventing clearance.
    const cleared=f.state(1).product;cleared.editorialStatus='generated_ready';
    f.sqlite.prepare("UPDATE products SET editorial_status='generated_ready' WHERE id=?").run(f.p.id);
    f.sqlite.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?').run(canonicalJson(cleared),f.p.id);
    f.sqlite.prepare("UPDATE vector_sync_outbox SET status='complete',completed_at=? WHERE status='pending'").run(NOW);
    const store=createD1CatalogMaintenanceStore({...f.options,owner:await readMutationOwner(f.db,f.owner),
      runId:'test-after-hold',catalogRevision:'r-after-hold',intent:()=>({reviewedDeleteReference:'test/after-hold'})});
    f.setClock('2027-01-01T00:00:00.000Z');await store.updateAmazonAffiliateUrl(f.p.id,f.p.affiliateUrl);
    assert.deepEqual(JSON.parse(f.row(1).public_display_json),f.base);
  }finally{f.close();}
});

test('valid low permanent scores retain cleared listings without replacing source/history or weakening explicit holds',async()=>{
  for(const qualityScore of ['0.0000','0.4000','0.5000']){
    const f=await permanentFixture({preservePermanentListings:true});try{
      const original=f.row(1);
      f.sqlite.prepare('UPDATE products SET quality_score=? WHERE id=?').run(Number(qualityScore),f.p.id);
      f.sqlite.prepare('UPDATE catalog_maintenance_products SET semantic_json=? WHERE product_id=?')
        .run(canonicalJson({...f.state(1).product,qualityScore}),f.p.id);
      await f.store.upsertProduct({...f.p,qualityScore,embedding:undefined},f.hash);
      const row=f.row(1),display=JSON.parse(row.public_display_json);
      assert.equal(row.is_active,1);assert.equal(display.eligibleUntil,null);assert.equal(display.qualityScore,Number(qualityScore));
      assert.equal(display.title,f.base.title);assert.equal(display.id,f.base.id);assert.equal(display.publicId,f.base.publicId);
      assert.equal(row.source_record_json,original.source_record_json);assert.deepEqual(f.state(1).product.persistentBase,f.base);
    }finally{f.close();}
  }
});

test('new products and revoked/mismatched permanent grants cannot gain automatic clearance',async()=>{
  for(const revoke of [()=>({}),r=>({...r,title:{...r.title,value:'Unreviewed replacement'}})]){
    const f=await permanentFixture();try{
      f.useIntent({rightsById:{[f.p.id]:{persistent:revoke(f.baseRights)}},reviewedDeleteReference:'test/exact-revocation'});
      await f.store.upsertProduct({...f.p,embedding:undefined},f.hash);assert.equal(f.row(1).public_display_json,null);
    }finally{f.close();}
  }
  const g=await setup({intent:()=>({rightsById:{[id(1)]:{persistent: rights(input())}}})});try{
    await g.store.upsertProduct(input(),editorialSourceHash(input()));
    assert.equal(g.row(1).public_display_json,null);assert.equal(g.state(1).product.persistentBase,undefined);
  }finally{g.close();}
});

test('changed optional short copy is not carried under an old exact permanent grant',async()=>{
  const f=await permanentFixture();try{
    const permission=f.row(1).rights_json;
    await f.store.upsertProduct({...f.p,embedding:undefined,punnyTitle:'New unreviewed short title'},f.hash);
    const display=JSON.parse(f.row(1).public_display_json),expected={...f.base};delete expected.punnyTitle;
    assert.deepEqual(display,expected);assert.equal(f.row(1).rights_json,permission);
    assert.equal(display.description,f.p.wittyDescription);assert.equal(display.editorialWriteup,f.p.editorialWriteup);
  }finally{f.close();}
});

test('all11 methods are usable via explicit D1 construction; immutable archive/identity and private versus public separation',async () => {
  const original=rawProduct(1);const f=await setup({products:[original],presence:{[uuid(1)]:true}});
  try {
    assert.equal(Object.keys(f.store).length,11);assert.ok(Object.isFrozen(f.store));
    const archived=f.row(1).source_record_json; const p=input(1,{editorialStatus:'pending',editorialWriteup:null,price:0,rating:0,reviewCount:0,humorTags:[],embedding:null});
    const hash=editorialSourceHash(p);
    assert.deepEqual(await f.store.upsertProduct(p,hash),{inserted:false,slug:original.slug});
    assert.equal(f.row(1).public_id,uuid(1));assert.equal(f.row(1).source_record_json,archived);
    assert.equal(f.state(1).product.editorialWriteup,original.editorial_writeup);assert.equal(f.state(1).product.price,'0.00');
    assert.equal(f.state(1).product.rating,null);assert.equal(f.state(1).product.reviewCount,null);
    assert.equal(f.state(1).embedding_present,1);assert.equal(f.state(1).embedding_native_base64,null);
    assert.equal(f.row(1).title,'');assert.equal(f.row(1).public_display_json,null);assert.equal(f.row(1).embedding_text_hash,null);
    const identities=await f.store.getActiveCatalogIdentities();assert.equal(identities[0].title,p.title);assert.equal(identities[0].sourceFacts,null);
    assert.deepEqual(await f.store.getExistingEditorialWriteups([]),[original.editorial_writeup]);
    assert.deepEqual(await f.store.getExistingEditorialWriteups([id(1)]),[]);
    assert.deepEqual(await f.store.getAffiliateUrlMismatches('other-20'),[{id:id(1),affiliate_url:p.affiliateUrl}]);
    assert.equal(await f.store.updateAmazonAffiliateUrl(id(1),p.affiliateUrl+'&extra=1'),1);
    assert.equal(await f.store.updateAmazonAffiliateUrl(id(999),p.affiliateUrl),0);
    assert.deepEqual(await f.store.getProductsForRevalidation({limit:50,staleDays:30,publishedStaleDays:21,publishedSlots:40,legacySlots:10}),[]);
    assert.equal((await f.store.getProductsNeedingEnrichment(25,[id(1)]))[0].slug,original.slug);
    await f.store.recordEditorialEvent({runId:'test-run',productId:id(1),eventType:'test',status:'pending',details:{fixture:true}});
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_editorial_events').get().n,1);
    assert.deepEqual(await f.store.markConfirmedMissingUnavailable([id(1),id(999)]),[id(1)]);
    assert.deepEqual(await f.store.deactivateConfirmedMissing([id(1)],90),[]); // Newly verified earlier in this run.
    await f.store.markCatalogDuplicate(id(1),'test-winner','test-only-duplicate');
    assert.equal(f.state(1).product.duplicateOfProductId,'test-winner');assert.equal(f.row(1).editorial_status,'duplicate');
    assert.equal(f.row(1).source_record_json,archived);assert.deepEqual(f.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    f.sqlite.prepare(`INSERT INTO products_fts(products_fts,rank) VALUES('integrity-check',1)`).run();
    assert.equal(f.events().length,1);assert.equal(f.events()[0].operation,'delete');
    assert.ok(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_vector_payloads').get().n > f.events().length);
    assert.throws(() => f.sqlite.prepare('UPDATE products SET source_record_json=? WHERE id=?').run('{}',id(1)),/immutable/);
    assert.throws(() => f.sqlite.prepare('UPDATE products SET public_id=? WHERE id=?').run(uuid(9),id(1)),/immutable/);
    assert.throws(() => f.sqlite.prepare('UPDATE products SET slug=? WHERE id=?').run('rename-not-authorized',id(1)),/slugs/);
  } finally {f.close();}
});

test('proven current embeddings and exact owned rights alone can produce a ready projection and immutable native payload',async () => {
  const p=input(1,{embedding:vectors,editorialSourceHash:null});const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
  const evidence={rightsById:{[p.id]:rights(p)},verificationById:{[p.id]:{reference:'test/real-fixture-observation',observedAt:NOW,sourceFactsHash:hash}},
    embeddingById:{[p.id]:{reference:'test/embedding-response',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}};
  const f=await setup({intent:() => evidence});
  try {
    const result=await f.store.upsertProduct(p,hash);assert.equal(result.inserted,true);
    const row=f.row(1);assert.equal(row.public_id,uuid(100));assert.equal(row.price_minor,1999);assert.equal(row.source_facts_hash,hash);
    const ready=await getProductsByPublicIds(f.db,[uuid(100)],new Date(NOW),'r-new');assert.equal(ready.length,1);
    assert.equal(ready[0].price,0);assert.equal(row.embedding_text_hash,sha256(maintenanceEmbeddingText(p)));
    const event=f.events()[0];assert.equal(event.operation,'upsert');
    const payload=await loadMaintenanceVectorPayload(f.db,{sequence:event.sequence});
    const native=Buffer.from(encodePgvectorSendBase64(vectors),'base64');
    assert.equal(payload.vectorBytesSha256,createHash('sha256').update(native).digest('hex'));
    assert.equal(payload.vectorBytesSha256,JSON.parse(f.state(1).embedding_provenance_json).vectorBytesSha256);
    assert.deepEqual(payload.values,vectors);assert.equal(payload.sequence,event.sequence);
    const before=f.counts().batches;assert.deepEqual(await f.store.upsertProduct(p,hash),result);assert.equal(f.counts().batches,before);
    assert.equal(f.events().length,1);assert.equal(f.state(1).version,1);
    assert.equal(JSON.parse(row.timestamp_provenance_json).fields.last_verified_at.state,'evidenced');
    let providerCalls=0;
    const forbidden=async () => {providerCalls++;throw new Error('provider-must-not-run');};
    await assert.rejects(drainVectorOutbox({db:f.db,catalogRevision:'r-new',adapters:{loadPayload:forbidden,readback:forbidden,upsert:forbidden,delete:forbidden}}),/mutation_ownership_required/);
    assert.equal(providerCalls,0);
  } finally {f.close();}
});

test('immutable native payload preserves signed zero and refuses ambiguous or mismatched bytes',async()=>{
  const original=[...vectors];original[0]=-0;
  const p=input(1,{embedding:original});const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
  const evidence={rightsById:{[p.id]:rights(p)},verificationById:{[p.id]:{reference:'test/fresh-observation',observedAt:NOW,sourceFactsHash:hash}},
    embeddingById:{[p.id]:{reference:'test/original-embedding',model:'text-embedding-3-small',text:maintenanceEmbeddingText(p),sourceFactsHash:hash}}};
  const f=await setup({intent:()=>evidence});try{
    await f.store.upsertProduct(p,hash);const event=f.events()[0];
    const stored=JSON.parse(f.sqlite.prepare('SELECT payload_json FROM catalog_maintenance_vector_payloads WHERE sequence=?').get(event.sequence).payload_json);
    assert.equal(typeof stored.nativeBase64,'string');assert.equal('values'in stored,false);
    const payload=await loadMaintenanceVectorPayload(f.db,event);assert.deepEqual(payload.values,original);assert.ok(Object.is(payload.values[0],-0));
    for(const bad of [{...stored,values:original},{...stored,vectorBytesSha256:'0'.repeat(64)},{...stored,nativeBase64:'invalid'}]){
      const malformed={prepare(){return{bind(){return this;},async all(){return{results:[{payload_json:JSON.stringify(bad)}]};}};}};
      await assert.rejects(loadMaintenanceVectorPayload(malformed,event));
    }
  }finally{f.close();}
});

test('unknown rights/facts/hash/observation remain held, no deadline or hash invented and no blanket legacy regeneration',async () => {
  const p=input(1,{embedding:vectors,editorialSourceHash:'a'.repeat(64)});const f=await setup();
  try {
    await f.store.upsertProduct(p,'a'.repeat(64));
    assert.equal(f.row(1).public_display_json,null);assert.equal(f.row(1).eligible_until,null);assert.equal(f.row(1).embedding_text_hash,null);
    assert.equal(f.state(1).embedding_present,1);assert.equal(f.state(1).embedding_native_base64,encodePgvectorSendBase64(vectors));
    assert.equal(JSON.parse(f.state(1).embedding_provenance_json).input,'unverified');assert.equal(f.events().length,0);
    assert.equal(JSON.parse(f.row(1).timestamp_provenance_json).fields.last_verified_at.state,'unverified_claim');
  } finally {f.close();}
  const original=rawProduct(1);const g=await setup({products:[original]});
  try {
    await assert.rejects(g.store.getProductsNeedingEnrichment(25),/presence_unproven/);
    await g.store.updateAmazonAffiliateUrl(id(1),input().affiliateUrl+'&test=1');
    assert.equal(g.state(1).embedding_present,null);assert.equal(g.state(1).embedding_native_base64,null);
  } finally {g.close();}
});

test('lost committed response/restart replays exact prior result/time/UUID, changed intent is distinct, immutable receipt tampering fails',async () => {
  const f=await setup();
  try {
    const operationTime='2026-10-20T08:00:00.456Z';f.setClock(operationTime);assert.equal(f.owner.capturedAt,NOW);
    let once=true;f.hookAfter(() => {if(once){once=false;throw new Error('lost-response');}});
    const p=input();const hash=editorialSourceHash(p);const result=await f.store.upsertProduct(p,hash);
    assert.equal(result.inserted,true);const original=f.row(1);assert.equal(f.epoch(),1);
    assert.equal(original.updated_at,operationTime);assert.equal(original.last_verified_at,operationTime);
    assert.equal(f.sqlite.prepare('SELECT database_time FROM catalog_maintenance_operations').get().database_time,operationTime);
    f.setClock('2026-10-20T09:00:00.000Z');
    const restarted=createD1CatalogMaintenanceStore({...f.options,newPublicId:() => {throw new Error('No second identity');}});
    assert.deepEqual(await restarted.upsertProduct({...p,availabilityCheckedAt:new Date('2026-10-21T01:00:00Z'),slug:'ignored-input-slug'},hash),result);
    assert.deepEqual(f.row(1),original);assert.equal(f.epoch(),1);
    await restarted.upsertProduct({...p,price:'20.00'},hash);assert.equal(f.state(1).product.price,'20.00');assert.equal(f.epoch(),2);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,2);
    assert.throws(() => f.sqlite.prepare(`UPDATE catalog_maintenance_operations SET result_json='null'`).run(),/immutable/);
    assert.throws(() => f.sqlite.prepare('DELETE FROM catalog_maintenance_operations').run(),/retained/);
  } finally {f.close();}
});

test('CAS and epoch conflicts roll back product, current private state, outbox, receipt and epoch together',async () => {
  const f=await setup({products:[rawProduct(1)],presence:{[uuid(1)]:true}});
  try {
    const before=f.row(1);let once=true;
    f.hookBefore(() => {if(once){once=false;f.sqlite.prepare("UPDATE products SET editorial_status='manual_locked' WHERE id=?").run(id(1));}});
    await assert.rejects(f.store.upsertProduct(input(1,{title:'Attempted stale overwrite'}),'b'.repeat(64)),/conflict/);
    assert.equal(f.row(1).editorial_status,'manual_locked');assert.equal(f.row(1).source_record_json,before.source_record_json);
    assert.equal(f.state(1),null);assert.equal(f.events().length,0);assert.equal(f.epoch(),0);
    f.hookBefore(null);
    const competing=createD1CatalogMaintenanceStore(f.options);
    await competing.updateAmazonAffiliateUrl(id(1),input().affiliateUrl+'&winner=1');
    await assert.rejects(f.store.updateAmazonAffiliateUrl(id(1),input().affiliateUrl+'&stale=1'),/fenced/);
    assert.match(f.state(1).product.affiliateUrl,/winner=1/);assert.equal(f.epoch(),1);
  } finally {f.close();}
});

test('unsent repeated updates coalesce into one newest event but retain immutable history; attempted/dispatched events fence all changes',async () => {
  const f=await setup({products:[rawProduct(1)],presence:{[uuid(1)]:true}});
  try {
    await f.store.markConfirmedMissingUnavailable([id(1)]);const first=f.events()[0];
    await f.store.markCatalogDuplicate(id(1),'winner','reviewed-duplicate');const second=f.events()[0];
    assert.equal(f.events().length,1);assert.ok(second.sequence > first.sequence);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_vector_payloads').get().n,2);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM vector_delete_mutations').get().n,2);
    f.sqlite.prepare('UPDATE vector_sync_outbox SET attempts=1,mutation_reference=? WHERE sequence=?').run('provider-accepted',second.sequence);
    const before=f.row(1);const state=f.state(1);const epoch=f.epoch();
    await assert.rejects(f.store.updateAmazonAffiliateUrl(id(1),input().affiliateUrl+'&rejected=1'),/conflict/);
    assert.deepEqual(f.row(1),before);assert.deepEqual(f.state(1),state);assert.equal(f.epoch(),epoch);
    assert.equal(f.events()[0].mutation_reference,'provider-accepted');
  } finally {f.close();}
});

test('new identity allocation matches PG fallback order and atomically respects live/history collisions',async () => {
  const f=await setup({products:[rawProduct(1,{punnyTitle:'same test title'})],presence:{[uuid(1)]:false}});
  try {
    const p=input(2,{punnyTitle:'same test title'});
    f.sqlite.prepare('UPDATE products SET title=? WHERE id=?').run('',id(1)); // Private source title still preserved.
    f.sqlite.prepare(`INSERT INTO product_slug_history(slug,product_id,created_at,source_record_json) VALUES(?,?,?,'{}')`).run('same-test-title',id(1),NOW);
    f.sqlite.prepare(`INSERT INTO product_slug_history(slug,product_id,created_at,source_record_json) VALUES(?,?,?,'{}')`).run('same-test-title-00000000',id(1),NOW);
    const result=await f.store.upsertProduct(p,editorialSourceHash(p));
    assert.equal(result.slug,'same-test-title-000000000000');assert.equal(f.row(2).public_id,uuid(100));
    await f.store.upsertProduct({...p,punnyTitle:'A different candidate title'},editorialSourceHash(p));assert.equal(f.row(2).slug,result.slug);
    assert.deepEqual(maintenanceSlugs({title:'É & Café',punnyTitle:null},uuid(1)).slice(0,2),['caf','caf-00000000']);
    assert.equal(maintenanceSlugs({title:'🦀',punnyTitle:null},uuid(1))[0],'ridiculous-gift');
    assert.equal(maintenanceSlugs({title:'a'.repeat(119)+' b'},uuid(1))[0],'a'.repeat(119));
    for(let boundary=110;boundary<130;boundary++)for(const candidate of maintenanceSlugs({title:'a'.repeat(boundary)+' b'},uuid(1)))
      assert.match(candidate,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    const before=f.epoch();let once=true;
    f.hookBefore(() => {if(once){once=false;f.sqlite.prepare(`INSERT INTO product_slug_history(slug,product_id,created_at,source_record_json) VALUES(?,?,?,'{}')`)
      .run('new-race-title',id(1),NOW);}});
    await assert.rejects(f.store.upsertProduct(input(3,{punnyTitle:'new race title'}),editorialSourceHash(input(3))),/conflict/);
    assert.equal(f.row(3).id,undefined);assert.equal(f.epoch(),before);assert.equal(f.state(3),null);
  } finally {f.close();}
});

test('published/legacy revalidation retains40/10 lanes, overdue published pages, NULL-first and fallback order',async () => {
  const products=[];const presence={};
  for(let n=1;n<=55;n++){const p=rawProduct(n);p.availability_checked_at=OLD;p.last_verified_at=OLD;products.push(p);presence[p.public_id]=true;}
  for(let n=101;n<=115;n++){const p=rawProduct(n,{editorialStatus:'pending'});p.last_verified_at=null;p.updated_at=null;products.push(p);presence[p.public_id]=true;}
  const f=await setup({products,presence});
  try {
    const selection={limit:50,staleDays:30,publishedStaleDays:21,publishedSlots:40,legacySlots:10};
    const rows=await f.store.getProductsForRevalidation(selection);
    assert.deepEqual(rows.slice(0,40).map(row => row.id),Array.from({length:40},(_,i) => id(i+1)));
    assert.deepEqual(rows.slice(40).map(row => row.id),Array.from({length:10},(_,i) => id(i+101)));
    const small=await f.store.getProductsForRevalidation({limit:100,staleDays:30,publishedStaleDays:21,publishedSlots:80,legacySlots:20});
    assert.equal(small.length,70);assert.equal(small.filter(row => row.editorial_status === 'generated_ready').length,55);
    assert.deepEqual(await f.store.deactivateConfirmedMissing([id(101)],90),[]); // Both historical instants unknown.
    assert.deepEqual(await f.store.deactivateConfirmedMissing([id(1)],90),[id(1)]);
  } finally {f.close();}
});

test('daily public selection reserves4featured/6nonfeatured without article gates or admitting31exclusions; no writes',async () => {
  const featured=Array.from({length:8},(_,n)=>rawProduct(n+1));
  const others=Array.from({length:12},(_,n)=>rawProduct(n+100,{editorialStatus:'pending',editorialWriteup:null,editorialQualityScore:null}));
  const excluded=Array.from({length:31},(_,n)=>rawProduct(n+500));
  featured[0].availability_checked_at=NOW;
  others[0].availability_checked_at=null;others[0].last_verified_at=null;
  const inactive=rawProduct(998,{isActive:false}),duplicate=rawProduct(999,{duplicateOfProductId:id(1)});
  const products=[...featured,...others,...excluded,inactive,duplicate];
  const f=await setup({products,presence:Object.fromEntries(products.map(p=>[p.public_id,true]))});
  try{
    markPublic(f,[...featured,...others,inactive,duplicate]);
    const before=f.epoch();
    const selection={daily:true,limit:10,featuredIds:[...featured.map(p=>p.id),excluded[0].id,inactive.id,duplicate.id]};
    const rows=await f.store.getProductsForRevalidation(selection);
    assert.deepEqual(rows.map(r=>r.id),[...featured.slice(1,5),...others.slice(0,6)].map(p=>p.id));
    assert.equal(new Set(rows.map(r=>r.id)).size,10);
    assert.ok(rows.every(row=>row.has_embedding===true));
    assert.ok(rows.every(row=>!Object.hasOwn(row,'embedding')));
    assert.deepEqual(await f.store.getProductsForRevalidation(selection),rows);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM products WHERE public_display_json IS NULL').get().n,31);
    assert.equal(f.epoch(),before);
    assert.equal((await f.store.getActiveCatalogIdentities()).some(p=>p.id===inactive.id),false);
    assert.equal((await f.store.getActiveCatalogIdentities({includeInactive:true})).some(p=>p.id===inactive.id),true);
    // A later normal batch reaches older unselected products in both lanes.
    for(const row of rows)f.sqlite.prepare('UPDATE products SET availability_checked_at=? WHERE id=?').run(NOW,row.id);
    const next=await f.store.getProductsForRevalidation(selection);
    assert.deepEqual(next.slice(0,3).map(r=>r.id),featured.slice(5).map(p=>p.id));
    assert.deepEqual(next.slice(4).map(r=>r.id),others.slice(6).map(p=>p.id));
  }finally{f.close();}
});

test('daily public selection deterministically lends sparse lanes and respects smaller limits',async()=>{
  for(const [featuredCount,otherCount,limit]of [[1,15,10],[15,2,10],[0,12,10],[12,0,10],[1,2,10],[0,0,10],[8,12,3]]){
    const featured=Array.from({length:featuredCount},(_,n)=>rawProduct(n+1));
    const others=Array.from({length:otherCount},(_,n)=>rawProduct(n+100));
    const products=[...featured,...others],f=await setup({products});
    try{
      markPublic(f,products);const before=f.epoch();
      const rows=await f.store.getProductsForRevalidation({daily:true,limit,featuredIds:featured.map(p=>p.id)});
      const initialFeatured=Math.min(featuredCount,4,limit),initialOthers=Math.min(otherCount,Math.max(0,limit-4));
      const expected=[...featured.slice(0,initialFeatured),...others.slice(0,initialOthers),
        ...featured.slice(initialFeatured),...others.slice(initialOthers)].slice(0,limit);
      assert.deepEqual(rows.map(r=>r.id),expected.map(p=>p.id));
      assert.equal(new Set(rows.map(r=>r.id)).size,rows.length);assert.equal(f.epoch(),before);
    }finally{f.close();}
  }
});

test('daily selection refreshes expired/imminent supplier-only photos before permanent-photo rotation',async()=>{
  const products=Array.from({length:20},(_,n)=>rawProduct(n+1));
  const f=await setup({products});
  try{
    markPublic(f,products);
    const deadlines=['2026-10-19T07:00:00.123Z','2026-10-20T08:00:00.123Z','2026-10-21T07:00:00.123Z'];
    for(let n=0;n<3;n++)f.sqlite.prepare('UPDATE products SET rights_json=?,availability_checked_at=? WHERE id=?')
      .run(canonicalJson({imageUrl:{basis:'merchant',expiresAt:deadlines[n]},persistent:{imageUrl:{basis:'owned',value:'/images/gift-placeholder.svg'}}}),NOW,id(18+n));
    // A known permanent photo and a nonpublic identity must not take priority.
    f.sqlite.prepare('UPDATE products SET rights_json=? WHERE id=?').run(canonicalJson({
      imageUrl:{basis:'merchant',expiresAt:deadlines[0]},persistent:{imageUrl:{basis:'owned',value:'https://example.invalid/cleared.jpg'}}}),id(17));
    const rows=await f.store.getProductsForRevalidation({daily:true,limit:10,featuredIds:products.slice(0,8).map(p=>p.id)});
    assert.deepEqual(rows.slice(0,3).map(p=>p.id),[id(18),id(19),id(20)]);
    assert.equal(rows.length,10);assert.equal(new Set(rows.map(p=>p.id)).size,10);
    const photos=await f.store.getProductsForRevalidation({daily:true,limit:10,photosOnly:true});
    assert.deepEqual(photos.map(p=>p.id),[id(18),id(19),id(20)],'photo-only care must not fill with permanent images');
    const before=f.epoch();assert.deepEqual(await f.store.getProductsForRevalidation({daily:true,limit:2,featuredIds:[]}),rows.slice(0,2));
    assert.equal(f.epoch(),before);
  }finally{f.close();}
});

test('one weekly-due unavailable listing gets a stock recheck without enlarging or duplicating the daily batch',async()=>{
  const products=Array.from({length:20},(_,n)=>rawProduct(n+1));
  const f=await setup({products});
  try{
    markPublic(f,products);
    for(const n of [18,19])f.sqlite.prepare('UPDATE products SET availability_status=?,availability_checked_at=? WHERE id=?')
      .run('OUT_OF_STOCK',OLD,id(n));
    f.sqlite.prepare('UPDATE products SET availability_status=?,availability_checked_at=? WHERE id=?').run('UNAVAILABLE',NOW,id(20));
    const before=f.epoch(),selection={daily:true,limit:10,featuredIds:products.slice(0,8).map(p=>p.id)};
    const rows=await f.store.getProductsForRevalidation(selection);
    assert.equal(rows[0].id,id(18));assert.equal(rows.length,10);assert.equal(new Set(rows.map(p=>p.id)).size,10);
    assert.equal(rows.some(p=>p.id===id(19)||p.id===id(20)),false);
    assert.deepEqual(await f.store.getProductsForRevalidation({...selection,photosOnly:true}),[]);
    assert.equal(f.epoch(),before);
  }finally{f.close();}
});

test('same-response photo refresh restores a placeholder-backed listing without copy/embedding generation',async()=>{
  const f=await permanentFixture({preservePermanentListings:true});
  try{
    const before=f.row(1),native=f.state(1).embedding_native_base64,provenance=f.state(1).embedding_provenance_json;
    const observedAt='2026-10-22T08:00:00.123Z';f.setClock(observedAt);
    f.useIntent({verificationById:{[f.p.id]:{reference:'test/real-new-photo-response',observedAt,sourceFactsHash:f.hash}}});
    await f.store.upsertProduct({...f.p,embedding:undefined},f.hash);
    const row=f.row(1),display=JSON.parse(row.public_display_json),permission=JSON.parse(row.rights_json);
    assert.equal(permission.imageUrl.observedAt,observedAt,'new observation must refresh the photo-only grant');
    assert.equal(display.imageUrl,f.p.imageUrl);assert.equal(display.title,f.base.title);assert.deepEqual(display.persistent,f.base);
    assert.equal(display.eligibleUntil,'2026-10-23T08:00:00.123Z');
    assert.equal(permission.imageUrl.reference,'test/real-new-photo-response');assert.equal(permission.imageUrl.observedAt,observedAt);
    assert.deepEqual(permission.persistent,f.baseRights);assert.equal(f.base.imageUrl,'/images/gift-placeholder.svg');
    assert.equal(row.source_record_json,before.source_record_json);assert.equal(f.state(1).embedding_native_base64,native);
    assert.equal(f.state(1).embedding_provenance_json,provenance);
    assert.equal(f.supplierRights.imageUrl.expiresAt,'2026-10-21T07:00:00.123Z');
  }finally{f.close();}
});

test('photo refresh cannot extend an old observation or replace independently cleared photography',async()=>{
  for(const permanent of [false,true]){
    const f=await permanentFixture({preservePermanentListings:true});
    try{
      if(permanent){
        const base={...f.base,imageUrl:'https://example.invalid/cleared-photo.jpg'};
        const rights={...f.baseRights,imageUrl:{basis:'owned',reference:'test/licensed-photo',value:base.imageUrl}};
        f.sqlite.prepare('UPDATE products SET public_display_json=?,rights_json=? WHERE id=?')
          .run(canonicalJson(base),canonicalJson({...f.supplierRights,persistent:rights}),f.p.id);
      }
      const observedAt='2026-10-22T08:00:00.123Z';f.setClock(observedAt);
      if(permanent)f.useIntent({verificationById:{[f.p.id]:{reference:'test/new-response',observedAt,sourceFactsHash:f.hash}}});
      await f.store.upsertProduct({...f.p,embedding:undefined},f.hash);
      const row=f.row(1),display=JSON.parse(row.public_display_json),permission=JSON.parse(row.rights_json);
      assert.equal(display.imageUrl,permanent?'https://example.invalid/cleared-photo.jpg':'/images/gift-placeholder.svg');
      assert.equal(permission.imageUrl.expiresAt,'2026-10-21T07:00:00.123Z');
    }finally{f.close();}
  }
});

test('compact catalog reads fail closed on oversized views and ownership changes, without returning a partial catalog',async()=>{
  const oversized=await setup({products:[rawProduct(1,{title:'"\\'.repeat(70000)})]});
  try{
    const before=oversized.row(1);const epoch=oversized.epoch();
    await assert.rejects(oversized.store.getActiveCatalogIdentities({includeInactive:true}),/maintenance_catalog_bound/);
    assert.deepEqual(oversized.row(1),before);assert.equal(oversized.epoch(),epoch);
  }finally{oversized.close();}
  const f=await setup({products:[rawProduct(1)]});
  try{
    let changed=false;
    const db={...f.db,prepare(sql){const statement=f.db.prepare(sql);return{
      bind(...params){statement.bind(...params);return this;},run:()=>statement.run(),async all(){
        const result=await statement.all();
        if(sql.startsWith('WITH candidates')&&!changed){changed=true;
          f.sqlite.prepare('UPDATE catalog_mutation_scopes SET mutation_epoch=mutation_epoch+1').run();}
        return result;
      },
    };}};
    await assert.rejects(createD1CatalogMaintenanceStore({...f.options,db}).getActiveCatalogIdentities(),/maintenance_fenced/);
    assert.equal(changed,true);
  }finally{f.close();}
  const drift=await setup({products:[rawProduct(1)]});
  try{
    await drift.store.upsertProduct(input(1),editorialSourceHash(input(1)));
    drift.sqlite.prepare('UPDATE products SET quality_score=.99 WHERE id=?').run(id(1));
    await assert.rejects(drift.store.getActiveCatalogIdentities(),/maintenance_current_state_drift/);
  }finally{drift.close();}
});

test('compact keyset retry keeps every identity and selected full loads retain real tag/presence validation',async()=>{
  const products=Array.from({length:140},(_,index)=>rawProduct(index+1));
  const f=await setup({products});
  try{
    const pages=[];let lost=false;
    const db={...f.db,prepare(sql){const statement=f.db.prepare(sql);let params;return{
      bind(...values){params=values;statement.bind(...values);return this;},run:()=>statement.run(),async all(){
        if(sql.startsWith('WITH candidates')){
          pages.push([...params]);if(!lost){lost=true;throw new Error('catalog_d1_result_unknown');}
        }
        return statement.all();
      },
    };}};
    const store=createD1CatalogMaintenanceStore({...f.options,db});
    assert.deepEqual((await store.getActiveCatalogIdentities({includeInactive:true})).map(p=>p.id),products.map(p=>p.id));
    assert.deepEqual(pages.slice(0,2),[['',128],['',64]]);
    const malformed=createD1CatalogMaintenanceStore({...f.options,historical:{archiveSha256:'d'.repeat(64),
      embeddingPresence:{[uuid(1)]:{present:true,sourceRecordSha256:'0'.repeat(64)}}}});
    markPublic(f,[products[0]]);
    await assert.rejects(malformed.getProductsForRevalidation({daily:true,limit:1,featuredIds:[id(1)]}),/maintenance_embedding_inventory_mismatch/);
    const preserved={...maintenanceState(f.row(1)),title:'TEST ONLY reviewed preserved title override'};
    const override=createD1CatalogMaintenanceStore({...f.options,historical:{...f.options.historical,
      overrides:{[id(1)]:{product:preserved,evidence:'test-only-independent-preserved-state'}}}});
    assert.equal((await override.getActiveCatalogIdentities()).find(p=>p.id===id(1)).title,preserved.title);
    assert.equal((await override.getProductsForRevalidation({daily:true,limit:1,featuredIds:[id(1)]}))[0].title,preserved.title);
  }finally{f.close();}
});

test('manual_locked, stale, numeric defaults and nullable fields retain the native-PG-reviewed pure merge semantics',async () => {
  const cases=[
    [{editorialStatus:'manual_locked'}, {editorialStatus:'generated_ready',editorialWriteup:'Replacement rejected by manual lock',editorialSourceHash:'b'.repeat(64)}],
    [{editorialStatus:'generated_ready'}, {editorialStatus:'pending',editorialWriteup:null,title:'Changed current listing facts'}],
    [{editorialStatus:'stale'}, {editorialStatus:'needs_review',editorialWriteup:'Incomplete candidate draft'}],
    [{editorialStatus:'pending'}, {editorialStatus:'generated_ready',editorialWriteup:'Reviewed replacement',price:'-1.005',rating:'0',reviewCount:'0',editorialQualityScore:'0'}],
    [{editorialStatus:'generated_ready'}, {editorialStatus:'pending',price:0,rating:0,reviewCount:0,qualityScore:0,remotelyVerified:false,imageUrl:null}],
  ];
  for(const [oldValues,newValues] of cases){
    const raw=rawProduct(1,oldValues);const f=await setup({products:[raw],presence:{[uuid(1)]:true}});
    try {
      const before=(await f.store.getProductsForRevalidation({limit:50,staleDays:30,publishedStaleDays:21,publishedSlots:40,legacySlots:10}))[0];
      const p=input(1,newValues);const hash=editorialSourceHash(p);
      await f.store.upsertProduct(p,hash);const actual=f.state(1).product;
      const existing=Object.fromEntries(Object.entries(raw).map(([key,value]) => [key.replace(/_([a-z])/g,(_,letter) => letter.toUpperCase()),value]));
      Object.assign(existing,{humorTags:['synthetic','crab'],sourceFacts:JSON.parse(raw.source_facts),embedding:null,createdAt:null,
        availabilityCheckedAt:canonicalTimestamp(raw.availability_checked_at),lastVerifiedAt:canonicalTimestamp(raw.last_verified_at),updatedAt:canonicalTimestamp(raw.updated_at)});
      const expected=mergeCatalogMaintenanceUpsert(existing,p,{sourceFactsHash:hash,databaseTime:NOW}).product;
      for(const key of ['title','price','rating','reviewCount','qualityScore','punnyTitle','wittyDescription','editorialWriteup','editorialStatus',
        'editorialSourceHash','editorialQualityScore','editorialModel','editorialGeneratedAt','contentUpdatedAt','availabilityCheckedAt','lastVerifiedAt','createdAt','updatedAt'])
        assert.deepEqual(actual[key],expected[key],`${oldValues.editorialStatus}/${newValues.editorialStatus}: ${key}`);
      if(oldValues.editorialStatus === 'manual_locked'){
        await f.store.markCatalogDuplicate(id(1),'winner','not-allowed');assert.equal(f.row(1).editorial_status,'manual_locked');
      }
      assert.ok(before);
    } finally {f.close();}
  }
});

test('invalid proofs/naive new editorial times/missing delete review or editorial parent fail before any write',async () => {
  const f=await setup({products:[rawProduct(1)],presence:{[uuid(1)]:true},intent:() => ({})});
  try {
    const before=f.row(1);
    await assert.rejects(f.store.updateAmazonAffiliateUrl(id(1),'https://www.amazon.com/dp/'+id(1)+'?tag=new-20'),/delete_review_required/);
    await assert.rejects(f.store.upsertProduct(input(2,{editorialGeneratedAt:'2026-10-20 00:00:00'}),null),/utc_required/);
    await assert.rejects(f.store.recordEditorialEvent({runId:'test-run',productId:id(999),eventType:'fixture',status:'pending',details:{}}),/conflict/);
    assert.deepEqual(f.row(1),before);assert.equal(f.row(2).id,undefined);assert.equal(f.epoch(),0);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,0);
  } finally {f.close();}
  const p=input(1,{embedding:vectors});const hash=editorialSourceHash(p);
  const g=await setup({intent:() => ({embeddingById:{[p.id]:{reference:'fixture',model:'text-embedding-3-small',text:'wrong text',sourceFactsHash:hash}}})});
  try {await assert.rejects(g.store.upsertProduct(p,hash),/embedding_proof/);assert.equal(g.epoch(),0);}finally{g.close();}
});

test('ordinary changed legacy listings need no deletion review when native presence is absent or unknown',async () => {
  for (const knownAbsent of [true, false]) {
    const p=rawProduct(1,{sourceFacts:{fixture:'old'},editorialStatus:'pending',editorialWriteup:null});
    const f=await setup({products:[p],presence:knownAbsent?{[uuid(1)]:false}:{},intent:()=>({})});
    try {
      const before=f.row(1).source_record_json;
      // Public display is NOT evidence that a native vector exists.
      f.sqlite.prepare('UPDATE products SET public_display_json=? WHERE id=?').run('{}',p.id);
      const fresh=input(1,{title:'Changed fixture title',sourceFacts:{fixture:'fresh'},editorialStatus:'pending',editorialWriteup:null});
      await f.store.upsertProduct(fresh,editorialSourceHash(fresh));
      assert.equal(f.state(1).product.title,fresh.title);
      assert.equal(f.row(1).source_record_json,before);
      assert.deepEqual(f.events(),[]);
      assert.equal(f.sqlite.prepare('SELECT count(*) n FROM vector_delete_mutations').get().n,0);
    } finally { f.close(); }
  }
});

test('private text-array decoding preserves native NULL/empty/quotes/backslashes instead of coercing absence',() => {
  assert.equal(maintenanceTextArray(null),null);assert.deepEqual(maintenanceTextArray('{}'),[]);
  assert.deepEqual(maintenanceTextArray('{NULL,"NULL","","comma,tag","quote\\\"tag","slash\\\\tag"}'),[null,'NULL','','comma,tag','quote"tag','slash\\tag']);
  for(const value of ['{"unterminated}','{{nested}}','{tag,}','not-array'])assert.throws(() => maintenanceTextArray(value));
});

test('new verified native vector binding is preserved without regeneration; changed facts invalidate binding and queue reviewed delete',async () => {
  const p=input(1,{embedding:vectors});const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
  const f=await setup({intent:(method,args) => {
    const current=args[0];const sourceHash=args[1];
    return {reviewedDeleteReference:'test/reviewed-current-mutation',rightsById:{[p.id]:rights(p)},
      ...(method === 'upsertProduct' ? {verificationById:{[p.id]:{reference:'test/observed',observedAt:NOW,sourceFactsHash:sourceHash}},
        ...(current.embedding?.length ? {embeddingById:{[p.id]:{reference:'test/generated-exact-input',model:'text-embedding-3-small',text:maintenanceEmbeddingText(current),sourceFactsHash:sourceHash}}} : {})} : {})};
  }});
  try {
    await f.store.upsertProduct(p,hash);const native=f.state(1).embedding_native_base64;
    await f.store.upsertProduct({...p,embedding:undefined,price:'21.00'},hash);
    assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.row(1).embedding_text_hash,sha256(maintenanceEmbeddingText(p)));
    assert.equal(f.events().length,1);assert.equal(f.events()[0].operation,'upsert');
    const changed={...p,embedding:undefined,title:'TEST ONLY Changed crab listing facts',editorialStatus:'pending'};
    await f.store.upsertProduct(changed,editorialSourceHash(changed));
    assert.equal(f.state(1).embedding_native_base64,native);assert.equal(f.row(1).embedding_text_hash,null);
    assert.equal(f.row(1).public_display_json,null);assert.equal(f.row(1).editorial_status,'stale');
    assert.equal(f.events().length,1);assert.equal(f.events()[0].operation,'delete');
    assert.equal(JSON.parse(f.state(1).embedding_provenance_json).sourceFactsHash,hash);
  } finally {f.close();}
});

test('old actual observations cannot become fresh when persisted now; recent observations cap deadline across later same-facts writes',async () => {
  for(const observedAt of ['2026-07-01T00:00:00.000Z','2026-10-19T04:00:00.000Z']){
    const p=input(1,{embedding:vectors});const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
    const f=await setup({intent:(method,args) => ({rightsById:{[p.id]:rights(p)},
      ...(method === 'upsertProduct' ? {verificationById:{[p.id]:{reference:'test/actual-observation',observedAt,sourceFactsHash:hash}},
        embeddingById:{[p.id]:{reference:'test/exact-input',model:'text-embedding-3-small',text:maintenanceEmbeddingText(args[0]),sourceFactsHash:hash}}} : {})})});
    try {
      await f.store.upsertProduct(p,hash);
      assert.equal(f.state(1).product.lastVerifiedAt,NOW);assert.equal(f.row(1).availability_checked_at,NOW);
      assert.equal(JSON.parse(f.row(1).timestamp_provenance_json).fields.availability_checked_at.observedAt,observedAt);
      const expired=observedAt.startsWith('2026-07');
      const deadline=expired ? null : '2026-11-23T04:00:00.000Z';
      assert.equal(f.row(1).eligible_until,deadline);assert.equal(Boolean(f.row(1).public_display_json),!expired);
      f.setClock('2026-10-21T09:00:00.000Z');
      await f.store.updateAmazonAffiliateUrl(p.id,p.affiliateUrl);
      assert.equal(f.row(1).eligible_until,deadline);assert.equal(Boolean(f.row(1).public_display_json),!expired);
      assert.equal(f.state(1).product.lastVerifiedAt,NOW);
    } finally {f.close();}
  }
});

test('microsecond thresholds and equal instants with3/6 fractions preserve exact due ordering',async () => {
  const early=rawProduct(1,{editorialStatus:'pending'});early.last_verified_at='2026-09-20T07:00:00.123000Z';
  const late=rawProduct(2,{editorialStatus:'pending'});late.last_verified_at='2026-09-20T07:00:00.123001Z';
  const equal=rawProduct(3,{editorialStatus:'pending'});equal.last_verified_at='2026-09-20T07:00:00.123Z';
  const f=await setup({products:[early,late,equal],presence:{[uuid(1)]:true,[uuid(2)]:true,[uuid(3)]:true}});
  try {
    const rows=await f.store.getProductsForRevalidation({limit:50,staleDays:30,publishedStaleDays:21,publishedSlots:40,legacySlots:10});
    assert.deepEqual(rows.map(row => row.id),[id(1),id(3)]);
    const bad=createD1CatalogMaintenanceStore({...f.options,historical:{archiveSha256:'d'.repeat(64),embeddingPresence:{[uuid(1)]:{present:false,sourceRecordSha256:'0'.repeat(64)}}}});
    await assert.rejects(bad.getProductsNeedingEnrichment(25),/inventory_mismatch/);
  } finally {f.close();}
});

test('a retained real observation of old facts cannot verify changed facts through a new embedding alone',async () => {
  for(const merchantImage of [false,true]){
  const p=input(1,{embedding:vectors});const hash=editorialSourceHash(p);p.editorialSourceHash=hash;
  const f=await setup({intent:(_method,args) => {
    const current=args[0];const currentHash=args[1];
    const grants=rights(current);
    if(merchantImage)grants.imageUrl={basis:'merchant',reference:'test/same-image-observation',value:p.imageUrl,observedAt:NOW,expiresAt:'2026-10-21T07:00:00.123Z'};
    return {rightsById:{[p.id]:grants},embeddingById:{[p.id]:{reference:'test/new-exact-input',model:'text-embedding-3-small',text:maintenanceEmbeddingText(current),sourceFactsHash:currentHash}},
      ...(current.remotelyVerified !== false ? {verificationById:{[p.id]:{reference:'test/actual-observation',observedAt:NOW,sourceFactsHash:currentHash}}} : {})};
  }});
  try {
    await f.store.upsertProduct(p,hash);assert.ok(f.row(1).public_display_json);
    const changed={...p,title:'TEST ONLY new current facts',remotelyVerified:false};const changedHash=editorialSourceHash(changed);changed.editorialSourceHash=changedHash;
    await f.store.upsertProduct(changed,changedHash);
    assert.equal(f.row(1).public_display_json,null);assert.equal(f.row(1).eligible_until,null);
    assert.equal(JSON.parse(f.row(1).timestamp_provenance_json).fields.availability_checked_at.sourceFactsHash,hash);
    assert.equal(f.row(1).source_facts_hash,changedHash);
  } finally {f.close();}
  }
});

test('a multi-product CAS failure cannot partially update the first product or advance its receipt/epoch',async () => {
  const f=await setup({products:[rawProduct(1),rawProduct(2)],presence:{[uuid(1)]:true,[uuid(2)]:true}});
  try {
    const before=f.row(1);let once=true;
    f.hookBefore(() => {if(once){once=false;f.sqlite.prepare("UPDATE products SET is_active=0 WHERE id=?").run(id(2));}});
    await assert.rejects(f.store.markConfirmedMissingUnavailable([id(1),id(2)]),/conflict/);
    assert.deepEqual(f.row(1),before);assert.equal(f.state(1),null);assert.equal(f.state(2),null);assert.equal(f.events().length,0);assert.equal(f.epoch(),0);
  } finally {f.close();}
});

test('nonfinite source numerics and sparse arrays cannot turn into nullable defaults during receipt serialization',async () => {
  const f=await setup();
  try {
    for(const values of [{qualityScore:Infinity},{price:NaN},{reviewCount:Infinity},{rating:-Infinity},{humorTags:new Array(2)}])
      await assert.rejects(f.store.upsertProduct(input(1,values),null),/nonfinite|tag_array/);
    assert.equal(f.epoch(),0);assert.equal(f.row(1).id,undefined);
    const p=input(1,{humorTags:[null,undefined,''],remotelyVerified:false});
    await f.store.upsertProduct(p,editorialSourceHash(p));assert.deepEqual(f.state(1).product.humorTags,['null','undefined','']);
    assert.equal(f.row(1).last_verified_at,null);
  } finally {f.close();}
});

test('existing executeCatalog explicitly consumes the real D1 store for affiliate-only execution, not a second default backend',async t => {
  const previous=process.env.AMAZON_ASSOCIATE_TAG;process.env.AMAZON_ASSOCIATE_TAG='fixture-20';
  t.after(() => {if(previous === undefined)delete process.env.AMAZON_ASSOCIATE_TAG;else process.env.AMAZON_ASSOCIATE_TAG=previous;});
  const raw=rawProduct(1,{affiliateUrl:`https://www.amazon.com/dp/${id(1)}?tag=wrong-20`});
  const f=await setup({products:[raw],presence:{[uuid(1)]:false}});
  try {
    const output=await executeCatalog(parseArgs(['--repair-affiliate-urls-only']),undefined,undefined,f.store);
    assert.deepEqual(output.affiliateAudit,{mismatched:1,repaired:1});
    assert.equal(f.state(1).product.affiliateUrl,`https://www.amazon.com/dp/${id(1)}?tag=fixture-20`);
    assert.equal(f.sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,1);
  } finally {f.close();}
});

test('0010 is additive on populated FK/FTS/projection/history/outbox rows and preserves original rowids/sequences',async () => {
  const sqlite=new DatabaseSync(':memory:');
  try {
    const names=(await readdir(new URL('../migrations/d1/',import.meta.url))).filter(name => /^00\d\d_.*\.sql$/.test(name)).sort();
    for(const name of names.filter(name => !name.startsWith('0010_')))sqlite.exec(await readFile(new URL(`../migrations/d1/${name}`,import.meta.url),'utf8'));
    const row=convertSourceRow('products',rawProduct(1),{catalogRevision:'r-archive',archiveId:'test',timestamps:{'products.created_at':{timezone:'unresolved',evidence:'fixture unresolved creation'}},now:new Date(NOW)});
    row.title='Synthetic searchable fixture';const keys=Object.keys(row);
    sqlite.prepare(`INSERT INTO products(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...keys.map(key => row[key]));
    sqlite.prepare(`INSERT INTO product_slug_history(slug,product_id,created_at,source_record_json) VALUES('previous-fixture',?,?,'{}')`).run(id(1),NOW);
    sqlite.prepare(`INSERT INTO catalog_public_products(catalog_revision,public_id,product_id,slug,title,description,tags,source_facts_hash,eligible_until,public_display_json,display_sha256)
      VALUES('r-archive',?,?,?,?,?,?,?,?,?,?)`).run(uuid(1),id(1),row.slug,'Synthetic fixture','Owned fixture','fixture',row.source_facts_hash,NOW,'{}','a'.repeat(64));
    sqlite.prepare(`INSERT INTO vector_sync_outbox(public_id,source_revision,embedding_text_hash,operation,created_at) VALUES(?,'r-archive',?,'upsert',?)`).run(uuid(1),'b'.repeat(64),NOW);
    const tables=['products','product_slug_history','catalog_public_products','vector_sync_outbox'];
    const before=Object.fromEntries(tables.map(table => [table,canonicalJson(sqlite.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all())]));
    sqlite.exec('BEGIN');sqlite.exec(await readFile(new URL('../migrations/d1/0010_catalog_maintenance.sql',import.meta.url),'utf8'));sqlite.exec('COMMIT');
    for(const table of tables)assert.equal(canonicalJson(sqlite.prepare(`SELECT rowid,* FROM ${table} ORDER BY rowid`).all()),before[table]);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    for(const table of ['products_fts','catalog_public_products_fts'])sqlite.prepare(`INSERT INTO ${table}(${table},rank) VALUES('integrity-check',1)`).run();
    assert.equal(sqlite.prepare(`SELECT seq FROM sqlite_sequence WHERE name='vector_sync_outbox'`).get().seq,1);
    assert.equal(sqlite.prepare('SELECT count(*) n FROM catalog_maintenance_operations').get().n,0);
  } finally {sqlite.close();}
});
