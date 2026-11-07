import {constants} from 'node:fs';
import {lstat,mkdir,open,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {CatalogObjectStore} from './r2-object-store.ts';

const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const json=(value:unknown)=>Buffer.from(JSON.stringify(value)+'\n');
function fail():never{throw Error('catalog_hosted_inputs_invalid');}
const HASH=/^[a-f0-9]{64}$/;
export interface HostedInputsReference {schemaVersion:1;key:string;sha256:string}
interface HostedInputs {
  schemaVersion:1;kind:'catalog-hosted-inputs';files:Array<{relative:string;sha256:string;key:string}>;
}
function relative(value:string){
  return /^bootstrap\/[a-f0-9]{64}\/(?:catalog-control|config|homepage-edition|derived-search-catalog)\.json$/.test(value)
    ||/^daily-catalog-care\/(?:automation-policy|semantic-search)\.json$/.test(value)
    ||/^daily-catalog-care\/campaigns\/(?:website-feed|product-reviews|research-leads)\.json$/.test(value);
}
function reference(ref:HostedInputsReference){
  if(!ref||Object.keys(ref).sort().join(',')!=='key,schemaVersion,sha256'||ref.schemaVersion!==1
    ||!HASH.test(ref.sha256)||ref.key!==`inputs/${ref.sha256}.json`)fail();
}
/** Versioned nonsecret input files; one CAS pointer, not workflow phase state.
 * An unfinished run captures its original reference and never adopts new inputs.
 */
export async function publishHostedInputs(store:CatalogObjectStore,files:Array<{relative:string;bytes:Uint8Array}>,expected:Uint8Array|null){
  if(!Array.isArray(files)||!files.length||files.length>20||new Set(files.map(f=>f.relative)).size!==files.length)fail();
  const manifest:HostedInputs={schemaVersion:1,kind:'catalog-hosted-inputs',files:[]};
  for(const file of [...files].sort((a,b)=>a.relative.localeCompare(b.relative))){
    if(!relative(file.relative)||!(file.bytes instanceof Uint8Array)||file.bytes.length>10*1024*1024)fail();
    try{const value=JSON.parse(Buffer.from(file.bytes).toString('utf8'));if(!value||typeof value!=='object')fail();}catch{fail();}
    const digest=hash(file.bytes),key=`inputs/files/${digest}.json`;
    await store.putImmutable(key,file.bytes);manifest.files.push({relative:file.relative,sha256:digest,key});
  }
  const bytes=json(manifest),digest=hash(bytes),ref:HostedInputsReference={schemaVersion:1,key:`inputs/${digest}.json`,sha256:digest};
  await store.putImmutable(ref.key,bytes);
  const pointer=json(ref),current=await store.get('pointers/operator-inputs.json');
  if(current&&Buffer.from(current.bytes).equals(pointer))return ref;
  if(Boolean(current)!==Boolean(expected)||current&&expected&&!Buffer.from(current.bytes).equals(Buffer.from(expected)))fail();
  await store.compareAndSwap('pointers/operator-inputs.json',current?.etag??null,pointer);return ref;
}
export async function currentHostedInputs(store:CatalogObjectStore){
  const object=await store.get('pointers/operator-inputs.json');if(!object)throw Error('catalog_hosted_inputs_missing');
  const ref=JSON.parse(Buffer.from(object.bytes).toString('utf8')) as HostedInputsReference;reference(ref);return ref;
}
export async function restoreHostedInputs(store:CatalogObjectStore,base:string,ref:HostedInputsReference){
  reference(ref);if(!path.isAbsolute(base)||path.normalize(base)!==base||base==='/')fail();
  const object=await store.get(ref.key);if(!object||hash(object.bytes)!==ref.sha256)fail();
  const manifest=JSON.parse(Buffer.from(object.bytes).toString('utf8')) as HostedInputs;
  if(!manifest||Object.keys(manifest).sort().join(',')!=='files,kind,schemaVersion'||manifest.schemaVersion!==1||manifest.kind!=='catalog-hosted-inputs'
    ||!Array.isArray(manifest.files)||!manifest.files.length||manifest.files.length>20
    ||new Set(manifest.files.map(f=>f.relative)).size!==manifest.files.length)fail();
  for(const file of manifest.files){
    if(!file||Object.keys(file).sort().join(',')!=='key,relative,sha256'||!relative(file.relative)||!HASH.test(file.sha256)
      ||file.key!==`inputs/files/${file.sha256}.json`)fail();
    const value=await store.get(file.key);if(!value||value.bytes.length>10*1024*1024||hash(value.bytes)!==file.sha256)fail();
    const destination=path.join(base,file.relative);await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    if(await realpath(path.dirname(destination))!==path.dirname(destination))fail();
    const directory=await lstat(path.dirname(destination));if(directory.uid!==process.getuid?.()||(directory.mode&0o777)!==0o700)fail();
    let handle;try{handle=await open(destination,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
    catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const stat=await lstat(destination);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid?.()||stat.nlink!==1
        ||(stat.mode&0o777)!==0o600||hash(await readFile(destination))!==file.sha256)fail();continue;}
    try{await handle.writeFile(value.bytes);await handle.sync();}finally{await handle.close();}
  }
  return manifest.files.map(f=>({relative:f.relative,sha256:f.sha256}));
}
