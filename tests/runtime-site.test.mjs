import test,{after} from 'node:test';
import {stop} from 'esbuild';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {buildRuntimeApp} from '../scripts/catalog/build-runtime-app.mjs';
import {runtimeDataBytes,runtimeDigest,runtimeAssetKey} from '../lib/catalog/runtime-catalog.ts';
import {createDerivedSemanticSearch} from '../workers/site/derived-search.ts';
import {DERIVED_SEARCH_PROFILE,semanticHash,semanticPublicFields,semanticVectorIdentity,semanticVectorMetadata} from '../lib/catalog/semantic-profile.ts';
import {canonicalJson} from '../lib/catalog/canonical-json.ts';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

const source='a'.repeat(40),uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
// server.browser uses browser MessageChannels. Close only channels created by
// this isolated test's bundles after all SSR streams settle, so Node can exit.
const NativeMessageChannel=globalThis.MessageChannel,channels=[];
globalThis.MessageChannel=class extends NativeMessageChannel {constructor(){super();channels.push(this);}};
after(()=>{for(const channel of channels){channel.port1.close();channel.port2.close();}globalThis.MessageChannel=NativeMessageChannel;stop();});
export async function runtimeFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'stupid-runtime-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const output=await buildRuntimeApp({codeSha:source,releaseId:'runtime-offline',outdir:path.join(directory,'app')});
  const time={now:Date.now()},products=Array.from({length:60},(_,i)=>({id:'B'+String(i+1).padStart(9,'0'),publicId:uuid(i+1),slug:'offline-desk-toy-'+(i+1),
    title:'Offline desk toy '+(i+1),description:'A cleared offline desk toy description '+(i+1)+'.',source:'amazon',currency:'USD',price:0,isActive:true,
    qualityScore:1,eligibleUntil:null,indexable:false,imageUrl:'/images/gift-placeholder.svg',affiliateUrl:'https://www.amazon.com/dp/B'+String(i+1).padStart(9,'0')+'?tag=goose-gifts-37-20'}));
  const snapshot={schemaVersion:1,dataKind:'catalog',catalogRevision:'offline-catalog',generatedAt:new Date(time.now-1000).toISOString(),products,
    heldProducts:[{id:'B999999999',publicId:uuid(999),slug:'held-offline',path:'/gifts/held-offline',title:'Gift currently unavailable',
      description:'This gift is not currently available in the curated catalog. Browse other gifts instead.',reason:'unavailable'}],
    slugHistory:[{slug:'historical-offline',canonicalSlug:products[0].slug,publicId:products[0].publicId}]};
  const objects=new Map(),lookups=[],data={schemaVersion:1,releaseId:'accepted-offline',sourceCodeSha:source,snapshot,assets:{},
    productOrder:products.map(p=>p.publicId),overlays:[],disclosures:{['amazon/'+products[0].id]:'Owned offline disclosure.'}};
  const head={version:1},collections=[{name:'/collections/saved-offline',revision:1,payload_json:JSON.stringify({ids:[products[1].publicId,products[0].publicId]})},
    {name:'/active-show',revision:1,payload_json:JSON.stringify({name:'saved-offline'})}];
  async function publish(){const bytes=runtimeDataBytes(data),sha=await runtimeDigest(bytes);objects.set('catalog-v1/public-catalog/'+sha+'.json',bytes);
    Object.assign(head,{release_id:data.releaseId,catalog_revision:data.snapshot.catalogRevision,data_sha256:sha,
      source_snapshot_sha256:await runtimeDigest(JSON.stringify(data.snapshot)+'\n'),public_snapshot_sha256:await runtimeDigest(JSON.stringify(data.snapshot)+'\n')});}
  await publish();
  const env={ENVIRONMENT:'production',RUNTIME_CATALOG_ENABLED:'true',DB:{prepare(sql){return{bind(){return this;},async all(){
    if(sql.includes('catalog_runtime_head'))return{results:[{...head}]};
    if(sql.includes('catalog_runtime_collections'))return{results:collections};
    throw Error('Unexpected offline SQL');}};}},
    CATALOG_DATA:{async get(key){lookups.push(key);const bytes=objects.get(key);return bytes?{async arrayBuffer(){return new Uint8Array(bytes).buffer;}}:null;}},
    ASSETS:{async fetch(request){const name=new URL(request.url).pathname;try{const bytes=await fs.readFile(path.join(output.assetsDirectory,name));
      return new Response(bytes,{headers:{'Content-Type':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'application/octet-stream'}});
    }catch{return new Response(null,{status:404});}}}};
  const realNow=Date.now;let worker;
  try{Date.now=()=>time.now;worker=(await import(pathToFileURL(output.entryPath).href)).default;}finally{Date.now=realNow;}
  const request=(url,options)=>worker.fetch(new Request('https://stupid.gifts'+url,options),env);
  return{directory,output,worker,request,env,data,head,collections,objects,lookups,publish,time,products};
}

test('data-independent app builds without catalog paths or ambient credentials and renders a real SSR catalog',async t=>{
  const keys=['CATALOG_SNAPSHOT_PATH','OPENAI_API_KEY','NEXT_PUBLIC_POSTHOG_KEY'],previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys)process.env[key]='OFFLINE_SECRET_MUST_NOT_COMPILE';
  t.after(()=>{for(const key of keys)if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];});
  const f=await runtimeFixture(t),script=await fs.readFile(f.output.entryPath,'utf8'),client=await fs.readFile(path.join(f.output.assetsDirectory,f.output.metadata.clientPath),'utf8');
  assert.doesNotMatch(script+client,/OFFLINE_SECRET_MUST_NOT_COMPILE|A cleared offline desk toy|node:crypto|catalog-presentation\.json/);
  assert.equal(f.output.metrics.assetFiles,7);assert.ok(f.output.metrics.assetBytes<500000);assert.ok(f.output.metrics.workerBytes<1000000);
  const response=await f.request('/'),html=await response.text();assert.equal(response.status,200,html);
  assert.equal((html.match(/data-analytics-card=""/g)??[]).length,24);assert.match(html,/runtime-props/);assert.match(html,/rel="canonical" href="https:\/\/stupid.gifts\/"/);
  assert.match(html,/application\/ld\+json/);assert.equal(response.headers.get('Cache-Control'),'no-store');
  assert.ok(html.includes('property="og:image" content="https://stupid.gifts'+f.output.metadata.brandOgPath+'"'));
  const brand=await f.request(f.output.metadata.brandOgPath);assert.equal(brand.status,200);assert.equal(brand.headers.get('Content-Type'),'image/png');
  assert.deepEqual([...new Uint8Array(await brand.arrayBuffer()).slice(0,8)],[137,80,78,71,13,10,26,10]);
  const props=JSON.parse(html.match(/id="runtime-props" type="application\/json">([^<]+)</)[1]);
  const next=await f.request(props.next),shard=await next.json();assert.equal(next.status,200);assert.equal(shard.products.length,24);
  assert.equal(new Set([...props.cards,...shard.products].map(p=>p.id)).size,48);assert.equal(shard.version,props.version);
  assert.equal((await f.request('/catalog/'+'0'.repeat(64)+'/feed-1.json')).status,404);
  assert.equal((await f.request('/app/not-the-reviewed-client.js')).status,404);
  t.diagnostic(JSON.stringify({offline:true,...f.output.metrics,initialCards:24,afterOneShard:48}));
});

test('runtime pages retain saved/custom shows, submit-only search, product links/history, guides, privacy and branded 404',async t=>{
  const f=await runtimeFixture(t);
  const show=await (await f.request('/h')).text();assert.match(show,/<form[^>]+action="\/h"/);assert.match(show,/Owned offline disclosure/);
  assert.ok(show.indexOf('Offline desk toy 2')<show.indexOf('Offline desk toy 1'));
  const named=await f.request('/h/saved-offline');assert.equal(named.status,200);assert.match(named.headers.get('X-Robots-Tag'),/noindex/);
  assert.equal((await f.request('/h/not-a-saved-collection')).status,404);
  const lookup=await f.request('/api/catalog-gifts?ids='+uuid(1)+','+uuid(2)+'&view=cards'),cards=await lookup.json();
  assert.equal(lookup.status,200);assert.deepEqual(cards.products.map(p=>p.id),[f.products[0].id,f.products[1].id]);
  const detail=await (await f.request('/gifts/'+f.products[0].slug)).text();assert.match(detail,/tag=goose-gifts-37-20/);
  assert.match(detail,/rel="sponsored noopener noreferrer"/);assert.match(detail,/Owned offline disclosure/);assert.match(detail,/You might also like/);
  assert.doesNotMatch(detail,/<meta name="robots" content="noindex/,'An optional article flag must not noindex an accepted ready product');
  const held=await f.request('/gifts/held-offline'),heldHtml=await held.text();assert.equal(held.status,200);assert.match(heldHtml,/Gift currently unavailable/);assert.doesNotMatch(heldHtml,/Check price on/);
  const redirect=await f.request('/gifts/historical-offline');assert.equal(redirect.status,308);assert.equal(redirect.headers.get('Location'),'/gifts/'+f.products[0].slug);
  for(const path of ['/gift-guides','/gift-guides/novelty-desk-toys','/privacy','/random-gift','/howie'])assert.equal((await f.request(path)).status,200,path);
  const guide=await (await f.request('/gift-guides/white-elephant-gifts')).text();assert.match(guide,/What to know before picking one/);assert.match(guide,/FAQPage/);
  const sitemap=await (await f.request('/sitemap.xml')).text();assert.doesNotMatch(sitemap,/\/h<|held-offline/);assert.match(sitemap,/https:\/\/stupid.gifts\/gift-guides/);
  assert.ok(sitemap.includes('/gifts/'+f.products[0].slug),'Ready public gift with indexable:false remains in sitemap');
  const missing=await f.request('/not-a-real-gift'),missingHtml=await missing.text();assert.equal(missing.status,404);assert.match(missingHtml,/That gift wandered off/);assert.match(missingHtml,/stupid<span>\.<\/span>gifts/);
  assert.equal((await f.request('/gifts')).status,404);assert.equal((await f.request('/random-gift?gift=unapproved')).status,404);
  assert.equal((await f.request('/api/search-products?q=desk')).status,200);
  const identity=await (await f.request('/.well-known/catalog-release.json')).json();assert.equal(identity.code_sha,source);assert.equal(identity.catalog_revision,f.data.snapshot.catalogRevision);
  const runtime=await (await f.request('/.well-known/runtime-catalog.json')).json();assert.equal(runtime.contract,'runtime-catalog-v1');assert.equal(runtime.catalogReleaseId,f.data.releaseId);assert.equal(runtime.dataSha256,f.head.data_sha256);
  assert.equal((await f.request('/',{method:'HEAD'})).body,null);
});

test('runtime preview mounting follows the resolved show, never archived lineups',async t=>{
  const f=await runtimeFixture(t),props=async path=>JSON.parse((await(await f.request(path)).text()).match(/id="runtime-props" type="application\/json">([^<]+)</)[1]);
  assert.equal((await props('/h')).showPreviews,false);
  assert.equal((await props('/h/billy-ray')).showPreviews,false);
  assert.equal((await props('/h/matan')).showPreviews,true);
  f.collections[1].payload_json=JSON.stringify({name:'matan'});f.collections[1].revision++;f.head.version++;f.time.now+=6000;
  assert.equal((await props('/h')).showPreviews,true);
  assert.equal((await props('/h/billy-ray')).showPreviews,false);
  f.collections[1].payload_json=JSON.stringify({name:'billy-ray'});f.collections[1].revision++;f.head.version++;f.time.now+=6000;
  assert.equal((await props('/h')).showPreviews,false);
  // The hydrated preview component returns cards directly, so its mount must
  // be a child of the same grid before the ordinary saved ProductCards.
  const app=await fs.readFile(new URL('../static-site/runtime/App.tsx',import.meta.url),'utf8');
  assert.match(app,/<Grid products=\{props.products\} show>\{props.showPreviews&&<ShowPreviews\/>\}<\/Grid>/);
  assert.match(app,/className="catalog-grid" aria-label="Gifts">\{children\}\{products.map/);
});
test('one runtime correction reaches cards, detail, real keyword search and shows; unlisting hides shopping without deleting URLs',async t=>{
  const f=await runtimeFixture(t),p=f.products[0];
  f.collections.push({name:'/products/'+p.publicId,revision:1,payload_json:JSON.stringify({title:'Corrected pineapple handset',description:'A wired retro handset.'})});
  const detail=await(await f.request('/gifts/'+p.slug)).text();assert.match(detail,/Corrected pineapple handset/);assert.match(detail,/A wired retro handset/);
  assert.doesNotMatch(detail,/A cleared offline desk toy description 1\./);
  const cards=await(await f.request('/api/catalog-gifts?ids='+p.publicId+'&view=cards')).json();assert.equal(cards.products[0].title,'Corrected pineapple handset');
  const search=await(await f.request('/api/search-products?q=pineapple')).json();assert.ok(JSON.stringify(search).includes('Corrected pineapple handset'));
  assert.match(await(await f.request('/h')).text(),/Corrected pineapple handset/);
  f.collections.at(-1).revision=2;f.collections.at(-1).payload_json=JSON.stringify({visibility:'unlisted'});f.head.version++;f.time.now+=6000;
  const held=await f.request('/gifts/'+p.slug);assert.equal(held.status,200);assert.doesNotMatch(await held.text(),/Check price on/);
  assert.doesNotMatch(await(await f.request('/sitemap.xml')).text(),new RegExp('/gifts/'+p.slug+'<'));
  assert.doesNotMatch(await(await f.request('/h')).text(),/Corrected pineapple handset/);
  assert.equal(f.data.snapshot.products.length,60,'Source catalog is not modified');
});

test('runtime assets only read accepted digest-bound public keys and fail closed on expiry/corruption',async t=>{
  const f=await runtimeFixture(t),bytes=new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),sha256=await runtimeDigest(bytes),asset={sha256,eligibleUntil:null,contentType:'image/svg+xml'};
  f.data.assets['/images/owned.svg']=asset;f.objects.set(runtimeAssetKey(asset),bytes);await f.publish();
  let response=await f.request('/images/owned.svg');assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'image/svg+xml');
  assert.ok(f.lookups.includes('catalog-v1/public-assets/'+sha256));assert.match(response.headers.get('Cache-Control'),/max-age=300/);
  f.objects.set(runtimeAssetKey(asset),new TextEncoder().encode('corrupt'));
  assert.equal((await f.request('/images/owned.svg')).status,503);
  assert.equal((await f.request('/catalog-v1/private/operator.json')).status,404);assert.ok(f.lookups.every(key=>key.startsWith('catalog-v1/public-')));
  const expired={...asset,eligibleUntil:new Date(f.time.now-1).toISOString()};f.data.assets['/images/expired.svg']=expired;
  // A new app instance consumes the same accepted data, not a compiled snapshot.
  await f.publish();const next=await buildRuntimeApp({codeSha:'b'.repeat(40),releaseId:'runtime-next',outdir:path.join(f.directory,'next')});
  const app=(await import(pathToFileURL(next.entryPath).href)).default;
  assert.equal((await app.fetch(new Request('https://stupid.gifts/images/expired.svg'),f.env)).status,404);
  const identity=await (await app.fetch(new Request('https://stupid.gifts/.well-known/catalog-release.json'),f.env)).json();
  assert.equal(identity.code_sha,'b'.repeat(40));assert.equal(identity.catalog_revision,f.data.snapshot.catalogRevision);
});

test('same app consumes new accepted catalog and collection revisions without rebuilding code or fetching suppliers',async t=>{
  const f=await runtimeFixture(t);assert.equal((await f.request('/')).status,200);
  f.data.snapshot.products[0].title='A newly accepted offline title';f.data.releaseId='accepted-offline-next';f.head.version++;await f.publish();f.time.now+=6000;
  const detail=await (await f.request('/gifts/'+f.products[0].slug)).text();assert.match(detail,/A newly accepted offline title/);
  f.collections[0].revision++;f.collections[0].payload_json=JSON.stringify({ids:[f.products[2].publicId]});f.head.version++;f.time.now+=6000;
  const show=await (await f.request('/h')).text();assert.match(show,/Offline desk toy 3/);assert.doesNotMatch(show,/Offline desk toy 2</);
  const identity=await (await f.request('/.well-known/catalog-release.json')).json();assert.equal(identity.code_sha,source);assert.equal(identity.release_id,'runtime-offline');
  const head=await (await f.request('/.well-known/runtime-catalog.json')).json();assert.equal(head.catalogReleaseId,'accepted-offline-next');
  assert.ok(f.lookups.every(key=>key.startsWith('catalog-v1/public-')));
});

test('finite photos retain exact deadlines, never enter evergreen SSR, and disappear without removing cleared gifts',async t=>{
  const f=await runtimeFixture(t),base=f.data.snapshot.products[0],expiresAt=new Date(f.time.now+10000).toISOString(),
    overlay={...base,imageUrl:'https://m.media-amazon.com/images/I/OFFLINE-NOT-FETCHED.jpg',eligibleUntil:expiresAt,persistent:base},
    bytes=new TextEncoder().encode(JSON.stringify([overlay])+'\n'),sha256=await runtimeDigest(bytes);
  f.data.overlays=[{sha256,expiresAt}];f.objects.set(`catalog-v1/public-overlays/${Date.parse(expiresAt)}/${sha256}.json`,bytes);await f.publish();
  const html=await (await f.request('/')).text();assert.doesNotMatch(html,/OFFLINE-NOT-FETCHED/);
  const props=JSON.parse(html.match(/id="runtime-props" type="application\/json">([^<]+)</)[1]);assert.ok(props.photoIndex);
  const index=await (await f.request(props.photoIndex)).json(),entry=index.products[base.id];assert.equal(entry.eligibleUntil,expiresAt);
  const detail=await (await f.request('/gifts/'+base.slug)).text();
  const detailProps=JSON.parse(detail.match(/id="runtime-props" type="application\/json">([^<]+)</)[1]);
  assert.deepEqual(detailProps.initialPhotoIndex.products[base.id],entry);
  assert.equal(detailProps.initialPhotoIndex.version,index.version);
  assert.ok(Object.keys(detailProps.initialPhotoIndex.products).length<=24);
  assert.doesNotMatch(JSON.stringify(detailProps.initialPhotoIndex),/https:|imageUrl|OFFLINE-NOT-FETCHED/);
  const shardPath=props.photoIndex.replace('photos.json','photos-'+entry.shard+'.json'),photo=await (await f.request(shardPath)).json();
  assert.equal(photo.images[base.id].imageUrl,overlay.imageUrl);assert.equal(photo.eligibleUntil,expiresAt);
  f.time.now=Date.parse(expiresAt)+1;
  assert.equal((await f.request(shardPath)).status,404);
  const fresh=await (await f.request('/gifts/'+base.slug)).text();assert.match(fresh,/A cleared offline desk toy description 1/);assert.doesNotMatch(fresh,/OFFLINE-NOT-FETCHED/);
});

test('runtime repaired-copy exclusion also rejects legacy provider-metadata fallback, without relabeling native vectors',async t=>{
  const f=await runtimeFixture(t),p=f.products[0],other=f.products[1];
  async function entry(product,recipe){const value={publicId:product.publicId,productId:product.id,publicFieldsSha256:await semanticHash(canonicalJson(semanticPublicFields(product,recipe))),
    inputSha256:'1'.repeat(64),originalNativeSha256:'2'.repeat(64),derivedNativeSha256:'3'.repeat(64),receiptSha256:'4'.repeat(64),sourceFactsHash:'5'.repeat(64),...(recipe?{inputRecipe:recipe}:{})};
    return{...value,vectorId:await semanticVectorIdentity(value)};}
  const legacy=await entry(p),catalog={schemaVersion:1,indexName:'offline-derived',profile:DERIVED_SEARCH_PROFILE,entries:[await entry(other)]},
    match=value=>({id:value.vectorId,score:.9,metadata:semanticVectorMetadata(value)});
  assert.equal((await createDerivedSemanticSearch(f.data.snapshot,catalog).resolve([match(legacy)])).length,1);
  assert.equal((await createDerivedSemanticSearch(f.data.snapshot,catalog,[p.publicId]).resolve([match(legacy)])).length,0);
  const current=await entry(p,'canonical-short-description-v2');
  assert.equal((await createDerivedSemanticSearch(f.data.snapshot,catalog,[p.publicId]).resolve([match(current)])).length,1);
  const display=structuredClone(f.data.snapshot);display.products[0].title='Approved clearer display title';
  const originalFields={[p.publicId]:legacy.publicFieldsSha256};
  assert.equal((await createDerivedSemanticSearch(display,catalog).resolve([match(legacy)])).length,0);
  const preserved=await createDerivedSemanticSearch(display,catalog,[],originalFields).resolve([match(legacy)]);
  assert.equal(preserved.length,1);assert.equal(preserved[0].product.title,'Approved clearer display title');
  assert.equal((await createDerivedSemanticSearch(display,catalog,[p.publicId],originalFields).resolve([match(legacy)])).length,0);
  assert.equal((await createDerivedSemanticSearch(display,catalog,[],originalFields).resolve([match(current)])).length,0);
  assert.equal((await createDerivedSemanticSearch(display,catalog,[],originalFields).resolve([match(await entry(display.products[0],'canonical-short-description-v2'))])).length,1);
});

test('actual workerd starts the browser-SSR bundle and renders live D1/R2 data plus virtual feed shards',async t=>{
  const f=await runtimeFixture(t),mf=new Miniflare(convertV4MiniflareOptions({modules:true,
    // Inline the exact bundle bytes: V4 scriptPath conversion cannot resolve a
    // generated module outside its default modulesRoot in this installed SDK.
    script:await fs.readFile(f.output.entryPath,'utf8'),compatibilityDate:'2026-10-19',
    bindings:{ENVIRONMENT:'production',RUNTIME_CATALOG_ENABLED:'true'},d1Databases:{DB:'runtime-offline-db'},r2Buckets:['CATALOG_DATA']}));
  t.after(()=>mf.dispose());
  const db=await mf.getD1Database('DB'),bucket=await mf.getR2Bucket('CATALOG_DATA');
  await db.exec(`CREATE TABLE catalog_runtime_publications(release_id TEXT PRIMARY KEY,catalog_revision TEXT,data_sha256 TEXT,source_snapshot_sha256 TEXT,public_snapshot_sha256 TEXT);
    CREATE TABLE catalog_runtime_head(singleton INTEGER,release_id TEXT,version INTEGER,enabled INTEGER);
    CREATE TABLE catalog_runtime_collections(name TEXT,revision INTEGER,payload_json TEXT);`);
  await db.batch([db.prepare('INSERT INTO catalog_runtime_publications VALUES(?,?,?,?,?)').bind(f.head.release_id,f.head.catalog_revision,f.head.data_sha256,f.head.source_snapshot_sha256,f.head.public_snapshot_sha256),
    db.prepare('INSERT INTO catalog_runtime_head VALUES(1,?,1,1)').bind(f.head.release_id),
    ...f.collections.map(c=>db.prepare('INSERT INTO catalog_runtime_collections VALUES(?,?,?)').bind(c.name,c.revision,c.payload_json))]);
  for(const [key,bytes]of f.objects)await bucket.put(key,bytes);
  const response=await mf.dispatchFetch('https://stupid.gifts/'),html=await response.text();assert.equal(response.status,200,html);
  assert.equal((html.match(/data-analytics-card=""/g)??[]).length,24);
  const props=JSON.parse(html.match(/id="runtime-props" type="application\/json">([^<]+)</)[1]);
  const shard=await (await mf.dispatchFetch('https://stupid.gifts'+props.next)).json();assert.equal(shard.products.length,24);
  assert.equal((await mf.dispatchFetch('https://stupid.gifts/api/content-admin')).status,404);
});

test('runtime failures log only bounded machine codes, never bucket errors, SQL, queries or private body text',async t=>{
  const f=await runtimeFixture(t),previous=console.error,logs=[];
  console.error=value=>logs.push(value);
  try{
    f.env.CATALOG_DATA.get=async()=>{throw Error('PRIVATE_SQL_OR_BUCKET_BODY token=secret');};
    const failed=await f.request('/?q=PRIVATE_SEARCH');assert.equal(failed.status,503);
    assert.deepEqual(JSON.parse(logs[0]),{state:'runtime_site_error',errorCode:'runtime_site_unavailable'});
    f.env.RUNTIME_CATALOG_ENABLED='false';
    assert.equal((await f.request('/')).status,503);
    assert.deepEqual(JSON.parse(logs[1]),{state:'runtime_site_error',errorCode:'runtime_catalog_unavailable'});
    assert.doesNotMatch(logs.join(''),/PRIVATE|secret|token|SELECT/);
  }finally{console.error=previous;}
});


test('homepage prioritizes only its first three photos in server HTML', async t => {
  const f=await runtimeFixture(t);
  for(const p of f.data.snapshot.products)p.imageUrl='https://m.media-amazon.com/images/I/OFFLINE-NOT-FETCHED.jpg';
  await f.publish();
  const html=await(await f.request('/')).text();
  const images=[...html.matchAll(/<img[^>]+>/g)].map(m=>m[0]);
  assert.equal(images.length,24);
  assert.equal(images.filter(tag=>tag.includes('loading="eager"')).length,3);
  assert.equal(images.filter(tag=>tag.includes('fetchPriority="high"')).length,3);
  assert.ok(images.slice(3).every(tag=>tag.includes('loading="lazy"')));
});
