import assert from 'node:assert/strict';
import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await readFile(resolve(root,'plugin.draft.json'),'utf8'));
const gaps=JSON.parse(await readFile(resolve(root,'readiness-gaps.json'),'utf8'));
assert.equal(manifest.$schema,'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
assert.match(manifest.name,/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
assert.ok(manifest.name.length<=64);
assert.match(manifest.version,/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
for(const forbidden of ['apps','mcpServers','skills','interface'])assert.equal(forbidden in manifest,false,`Unsupported portable root field: ${forbidden}`);
const openai=manifest.extensions?.['com.openai'];
assert.ok(openai);
assert.ok(openai.apps==null,'Private App bindings must not enter author-supplied public uploads.');
const listing=openai.interface;
for(const [key,max] of [['displayName',30],['shortDescription',30],['longDescription',4000]]){
 assert.equal(typeof listing[key],'string');assert.ok(listing[key].trim().length>0&&listing[key].length<=max,`${key} length`);
}
const categories=['Business & Operations','Communication','Creativity','Data & Analytics','Developer Tools','Education & Research','Entertainment','Finance','Healthcare','Other','Productivity','Scientific Research','Security','Travel'];
assert.ok(categories.includes(listing.category),'Unsupported category');
assert.ok(Array.isArray(listing.defaultPrompt)&&listing.defaultPrompt.length>=1&&listing.defaultPrompt.length<=3);
assert.equal(new Set(listing.defaultPrompt.map(x=>x.trim().replace(/\s+/g,' '))).size,listing.defaultPrompt.length);
for(const prompt of listing.defaultPrompt)assert.ok(typeof prompt==='string'&&prompt.trim()&&prompt.length<=128&&!/[\r\n@]/.test(prompt),'Invalid starter prompt');
for(const key of ['websiteURL','supportURL','privacyPolicyURL','termsOfServiceURL'])if(key in listing){
 const u=new URL(listing[key]);assert.equal(u.protocol,'https:');assert.ok(!u.username&&!u.password&&listing[key].length<=1024);
}
assert.equal(openai.review.test_cases.positive.length,5);
assert.equal(openai.review.test_cases.negative.length,3);
for(const c of openai.review.test_cases.positive){
 for(const key of ['description','prompt','tools_triggered','expected_behavior'])assert.ok(typeof c[key]==='string'&&c[key].trim(),`Missing positive ${key}`);
}
for(const c of openai.review.test_cases.negative)for(const key of ['description','prompt'])assert.ok(typeof c[key]==='string'&&c[key].trim(),`Missing negative ${key}`);
assert.equal(openai.review.commerce,true);
assert.ok(openai.review.commerce_description.trim());
assert.ok(openai.publication.release_notes.trim());
if ('countries' in openai.publication) {
 assert.ok(Array.isArray(openai.publication.countries)&&openai.publication.countries.every(x=>/^[A-Z]{2}$/.test(x)));
 assert.ok(gaps.gaps.find(x=>x.id==='countries')?.state==='complete','Country targeting needs a recorded owner decision.');
}
const icons=[];
for(const key of ['logo','composerIcon']){
 const value=listing[key];assert.ok(value.startsWith('./')&&!isAbsolute(value));
 const path=resolve(root,value), rel=relative(root,path);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
 const stat=await lstat(path);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=5*1024*1024);
 const bytes=await readFile(path);assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);assert.ok(width===height&&width>=256&&width<=4096);
 icons.push({key,path:value,width,height,bytes:stat.size});
}
const unresolved=gaps.gaps.filter(x=>x.state!=='complete');
const report={draftFieldsValid:true,displayNameCharacters:listing.displayName.length,subtitleCharacters:listing.shortDescription.length,positiveCases:5,negativeCases:3,icons,submissionReady:false,unresolved:unresolved.map(x=>({id:x.id,state:x.state})),packageState:'No MCP configuration or ZIP is produced; the production endpoint and other required facts are not complete.'};
console.log(JSON.stringify(report,null,2));
if(process.argv.includes('--ready'))process.exitCode=2;
