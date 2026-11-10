import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { showPreview } from '../workers/site/show-preview.ts';
import { readShowPreviews } from '../static-site/lib/show-preview.ts';

const observed=Date.parse('2026-11-10T20:27:10Z'),deadline=Date.parse('2026-11-11T20:20:00Z');
const request=new Request('https://stupid.gifts/api/show-preview');
test('filming-only pair is exact, directly tagged, no-store and finite before JSON',async()=>{
  const response=showPreview(request,observed),body=await response.json();
  assert.deepEqual(body.products.map(p=>p.id),['B01DVUSR1Y','B0DK82DBDG']);
  assert.deepEqual(body.products.map(p=>p.title),['Jeweled butt-plug set','Inflatable girlfriend']);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert.equal(response.headers.get('CDN-Cache-Control'),'no-store');
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'),'no-store');
  assert.equal(response.headers.get('X-Robots-Tag'),'noindex, nofollow');
  assert.equal(readShowPreviews(body,observed).length,2);
  for(const p of body.products){
    assert.equal(p.affiliateUrl,`https://www.amazon.com/dp/${p.id}?tag=goose-gifts-37-20`);
    assert.equal(p.eligibleUntil,'2026-11-11T20:20:00Z');
    assert.equal(Object.keys(p).sort().join(','),'affiliateUrl,description,eligibleUntil,id,imageUrl,title');
  }
  assert.equal(readShowPreviews(body,deadline).length,0);
  for(const time of [observed-1,deadline,deadline+86400_000]){
    const expired=await showPreview(request,time).text();
    assert.equal(expired,'{"products":[]}');assert.doesNotMatch(expired,/media-amazon|amazon\.com|B01DV/);
  }
  for(const method of ['POST','HEAD','PUT'])assert.equal(showPreview(new Request(request,{method}),observed).status,405);
});
test('optional preview client validates URLs/expiry and never contains finite item/photo bytes',async()=>{
  const body=await showPreview(request,observed).json(),p=body.products[0];
  for(const changes of [{imageUrl:'https://evil.example/photo.jpg'},{affiliateUrl:p.affiliateUrl.replace('goose-gifts-37-20','wrong-20')},
    {affiliateUrl:'/gifts/fake-preview'},{eligibleUntil:'invalid'},{eligibleUntil:new Date(observed).toISOString()}])
    assert.deepEqual(readShowPreviews({products:[{...p,...changes}]},observed),[]);
  const client=fs.readFileSync(new URL('../static-site/components/ShowPreviews.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(client,/61wQj|71Jj60|B01DVUSR1Y|B0DK82DBDG|Jeweled|Inflatable girlfriend/);
  assert.match(client,/has\('ids'\)/);assert.match(client,/catch \{/);assert.match(client,/visibilitychange/);
  assert.match(client,/gift-placeholder\.svg/);assert.match(client,/Date\.parse\(product\.eligibleUntil\) > Date\.now\(\)/);
  const page=fs.readFileSync(new URL('../static-site/components/ShowShortlist.tsx',import.meta.url),'utf8');
  assert.match(page,/\(!preset \|\| preset === "matan"\) && <ShowPreviews \/>/);
  assert(page.indexOf('<ShowPreviews />')<page.indexOf('picks.map'));
});
