import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createBrowseRelease, merchandisingEpoch, merchandisedBrowseProducts } from "../static-site/lib/browse.ts";
import { readHomepageEdition } from "../lib/catalog/homepage-edition.ts";

const fixture = JSON.parse(fs.readFileSync(new URL("../static-site/fixtures/catalog.snapshot.json", import.meta.url)));
const product = (id, title = "Ordinary title") => ({ ...fixture.products[0], id, title, slug: "gift-"+id,
  qualityScore: 0.5, eligibleUntil: null });
const edition = {schemaVersion:1,day:"2026-11-03",
  anchors:Array.from({length:6},(_,i)=>"anchor"+i),rotation:Array.from({length:18},(_,i)=>"pick"+i)};
const snapshot = () => ({...fixture,products:[...edition.anchors,...edition.rotation,
  ...Array.from({length:100},(_,i)=>"other"+i)].map(id=>product(id)),heldProducts:[],slugHistory:[]});
const ids = products => products.map(p=>p.id);

test("ID-only editions reject duplicate, malformed, oversized and private content",()=>{
  assert.deepEqual(readHomepageEdition(edition),edition);
  for(const value of [null,{...edition,day:"2026-02-30"},{...edition,rotation:[...edition.rotation,"extra"]},
    {...edition,anchors:["anchor0",...edition.anchors.slice(0,5)]},{...edition,secret:"no"},
    {...edition,anchors:["https://example.com",...edition.anchors.slice(1)]}])assert.equal(readHomepageEdition(value),null);
});

test("editorial choices determine all24 spots, without keyword, category or legacy quality gates",()=>{
  const input=snapshot();
  input.products[6].title="Alligator Oven Mitts";
  input.products[7].title="An excellent unusual book";
  input.products[8].title="A sculpture with no funny gift keywords";
  const opening=merchandisedBrowseProducts(input, "2026-11-03T16:00:00.000Z",edition).slice(0,24);
  assert.equal(opening.length,24);
  assert.deepEqual([0,1,4,8,13,19].map(i=>opening[i].id),edition.anchors);
  assert.deepEqual(ids(opening).filter(id=>!edition.anchors.includes(id)),edition.rotation);
});

test("same edition stays stable; the editor changes daily discoveries while keeping weekly highlights",()=>{
  const input=snapshot(),time="2026-11-03T16:00:00.000Z";
  const opening=e=>merchandisedBrowseProducts(input,time,e).slice(0,24);
  assert.deepEqual(ids(opening(edition)),ids(opening(structuredClone(edition))));
  const tomorrow={...edition,day:"2026-11-04",rotation:Array.from({length:18},(_,i)=>"other"+i)};
  const updated=merchandisedBrowseProducts(input,"2026-11-04T16:00:00.000Z",tomorrow).slice(0,24);
  assert.deepEqual([0,1,4,8,13,19].map(i=>updated[i].id),edition.anchors);
  assert.notDeepEqual(ids(updated),ids(opening(edition)));
});

test("missing/invalid optional editions and unavailable picks never drop catalog identities",()=>{
  const input=snapshot(),before=JSON.stringify(input);
  input.products=input.products.filter(p=>p.id!=="anchor0");
  for(const e of [undefined,{},edition]){
    const all=merchandisedBrowseProducts(input,"2026-11-03T16:00:00.000Z",e);
    assert.deepEqual(ids(all).sort(),ids(input.products).sort());
    assert.equal(new Set(ids(all)).size,input.products.length);
    assert.equal(all.slice(0,24).length,24);
  }
  assert.notEqual(JSON.stringify(input),before);
  const tiny={...input,products:input.products.slice(0,2)};
  assert.equal(merchandisedBrowseProducts(tiny).length,2);
  assert.deepEqual(merchandisedBrowseProducts({...input,products:[]}),[]);
});

test("browse release preserves every product once across all24-item static batches",()=>{
  const input=snapshot(),release=createBrowseRelease(input,"2026-11-03T16:00:00.000Z",edition);
  const all=[...release.opening,...release.feed.initial,...release.shards.filter(s=>s.payload.kind==="feed").flatMap(s=>s.payload.products)];
  assert.deepEqual(ids(all).sort(),ids(input.products).sort());
  assert.equal(new Set(ids(all)).size,input.products.length);
  assert.notEqual(release.version,createBrowseRelease(input,"2026-11-03T16:00:00.000Z",
    {...edition,rotation:[...edition.rotation].reverse()}).version);
});

test("Pacific weekly boundaries remain explicit, including DST",()=>{
  assert.equal(merchandisingEpoch("2026-11-02T07:59:59.999Z").day,"2026-11-01");
  assert.equal(merchandisingEpoch("2026-11-02T08:00:00.000Z").day,"2026-11-02");
  assert.equal(merchandisingEpoch("2026-11-02T08:00:00.000Z").week,
    merchandisingEpoch("2026-11-02T07:59:59.999Z").week+1);
});
