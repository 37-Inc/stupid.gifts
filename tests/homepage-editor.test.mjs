import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {candidateSweep,homepageBrief,validateSelection,previewHtml} from '../scripts/catalog/homepage-editor.mjs';
import {routineHomepageEdition} from '../scripts/catalog/daily-operator.mjs';
import {validateBuildContext} from '../scripts/staging/build.mts';
import {verifyReleaseContext} from '../scripts/staging/verify-release.mts';
import {validatePublicationConfig} from '../scripts/catalog/publish-release.ts';

const fixture=JSON.parse(fs.readFileSync(new URL('../static-site/fixtures/catalog.snapshot.json',import.meta.url)));
const edition={schemaVersion:1,day:'2026-11-03',anchors:Array.from({length:6},(_,i)=>'p'+i),rotation:Array.from({length:18},(_,i)=>'p'+(i+6))};
function database(){
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE products(id TEXT PRIMARY KEY,created_at TEXT); CREATE TABLE catalog_public_products(catalog_revision TEXT,product_id TEXT,public_display_json TEXT)');
  for(let i=0;i<150;i++){
    const p={...fixture.products[0],id:'p'+i,publicId:'public'+i,slug:'gift'+i,title:i===149?'Alligator Oven Mitts':'Unclassified object '+i,eligibleUntil:null,qualityScore:0.5};
    sql.prepare('INSERT INTO products VALUES(?,?)').run(p.id,i===149?'2026-11-02':null);
    sql.prepare('INSERT INTO catalog_public_products VALUES(?,?,?)').run('accepted',p.id,JSON.stringify(p));
  }
  const db={prepare(query){return{bind(...params){return{all:async()=>({results:sql.prepare(query).all(...params)})};}};},
    batch:async statements=>Promise.all(statements.map(s=>s.all())),metrics:()=>({writes:0})};
  return{sql,db};
}
test('a shuffled sweep covers every catalog identity without category or title gates',()=>{
  const ids=Array.from({length:3355},(_,i)=>'p'+i),seen=new Set();
  for(let i=0;i<48;i++)for(const id of candidateSweep(ids,new Date(Date.UTC(2026,10,3+i)).toISOString().slice(0,10)))seen.add(id);
  assert.equal(seen.size,ids.length);
  assert.deepEqual(candidateSweep(ids,'2026-11-03'),candidateSweep([...ids].reverse(),'2026-11-03'));
  assert.deepEqual(candidateSweep([],'2026-11-03'),[]);
});
test('brief contains real new arrivals, previous favorites and a broad rotating sample',async()=>{
  const{sql,db}=database();try{
    const brief=await homepageBrief(db,'accepted',edition,'2026-11-03');
    assert.equal(brief.catalogSize,150);
    assert.equal(brief.candidates.filter(p=>p.lanes.includes('newest')).length,1);
    assert.ok(brief.candidates.find(p=>p.id==='p149'));
    assert.equal(brief.candidates.filter(p=>p.lanes.includes('previous')).length,24);
    assert.equal(brief.candidates.filter(p=>p.lanes.includes('rediscovery')).length,72);
    assert.equal(new Set(brief.candidates.map(p=>p.id)).size,brief.candidates.length);
    assert.ok(brief.candidates.length<=116);
    await validateSelection(db,'accepted',edition);
    await assert.rejects(validateSelection(db,'wrong-revision',edition),/not_public/);
  }finally{sql.close();}
});
test('preview escapes listing content and contains no executable product markup',()=>{
  const html=previewHtml({day:'2026-11-03',candidates:[{id:'p1',title:'<script>alert(1)</script>',description:'"hello"',imageUrl:'https://example.com/x?y="',lanes:['previous']}]});
  assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('noindex'));
});
test('missing or corrupt daily editorial input reuses last good edition; all missing uses reviewed seed',async()=>{
  const old={...edition,day:'2026-11-02'},prior='/protected/old/catalog-control.json';
  assert.deepEqual(await routineHomepageEdition('2026-11-03',prior,async file=>file.includes('/homepage/')?null:old),old);
  assert.deepEqual(await routineHomepageEdition('2026-11-03',prior,async file=>{if(file.includes('/homepage/'))throw Error('invalid');return old;}),old);
  assert.deepEqual(await routineHomepageEdition('2026-11-03',prior,async()=>old),old);
  const fallback=await routineHomepageEdition('2026-11-03',prior,async()=>null);
  assert.equal(fallback.anchors.length,6);assert.equal(fallback.rotation.length,18);
});
test('editorial IDs are sealed through publication config, context and manifest, including tamper detection',()=>{
  const context={schemaVersion:1,sourceMode:'stupid-production',releaseId:'editorial',codeSha:'a'.repeat(40),catalogRevision:fixture.catalogRevision,
    catalogSnapshotSha256:'b'.repeat(64),generatedAt:fixture.generatedAt,vectorSyncWatermark:0,priorReleaseId:null,retainedManifestSha256:null,homepage:edition};
  const validated=validateBuildContext(context,fixture,context.codeSha,context.catalogSnapshotSha256,new Date(fixture.generatedAt));
  assert.deepEqual(validated.homepage,edition);
  const manifest={...context,retention:null};
  assert.deepEqual(verifyReleaseContext(context,manifest,fixture,context.codeSha,new Date(fixture.generatedAt)).homepage,edition);
  assert.throws(()=>verifyReleaseContext(context,{...manifest,homepage:{...edition,rotation:[...edition.rotation].reverse()}},fixture,context.codeSha,new Date(fixture.generatedAt)),/context changed/);
  const config={schemaVersion:1,environment:'production',accountId:'a'.repeat(32),workerName:'stupid-gifts-production',database:{id:'11111111-1111-4111-8111-111111111111',name:'test'},indexName:'test',codeSha:context.codeSha,
    sourceMode:'stupid-production',sourceRoot:'/test',releaseId:'editorial',identityOrigin:'https://stupid.gifts',compatibilityDate:'2026-10-19',prior:null,homepage:edition};
  assert.deepEqual(validatePublicationConfig(config).homepage,edition);
  assert.throws(()=>validatePublicationConfig({...config,homepage:{...edition,secret:'bad'}}),/homepage_invalid/);
});
