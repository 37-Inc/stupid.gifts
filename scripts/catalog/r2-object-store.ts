import {createHash} from 'node:crypto';
import {AwsClient} from 'aws4fetch';
import {setTimeout as wait} from 'node:timers/promises';

export interface DurableObject {bytes:Uint8Array;etag:string}
export interface CatalogObjectStore {
  get(key:string):Promise<DurableObject|null>;
  putImmutable(key:string,bytes:Uint8Array):Promise<DurableObject>;
  compareAndSwap(key:string,expectedEtag:string|null,bytes:Uint8Array):Promise<DurableObject>;
  remove(key:string,expectedEtag:string):Promise<void>;
}
const MAX_BYTES=32*1024*1024;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const validEtag=(value:string)=>/^"[a-zA-Z0-9-]{1,128}"$/.test(value);
const mutableKey=(key:string)=>/^runs\/[a-zA-Z0-9._-]+\/head\.json$/.test(key)
  ||/^pointers\/(?:last-success|pending-run|operator-inputs|cleanup-runs)\.json$/.test(key);
const fail=(code:string):never=>{throw Error('catalog_object_store_'+code);};

/** One private bucket/prefix; no list/create-bucket, public URL or credential
 * discovery. Conditional writes are atomic in R2. SDK transport retries are
 * disabled; transient GETs have bounded retries. An uncertain write is
 * reconciled against exact bytes before ACK. A transient write retries only
 * after a fresh read still matches its ORIGINAL atomic precondition.
 * https://developers.cloudflare.com/r2/api/s3/api/ */
export function createCatalogR2Store(options:{accountId:string;bucket:string;prefix:string;
  accessKeyId:string;secretAccessKey:string;send?:typeof fetch;timeoutMs?:number}):CatalogObjectStore {
  const {accountId,bucket,prefix}=options;
  if(!/^[a-f0-9]{32}$/.test(accountId)||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    ||!/^[a-zA-Z0-9_-]{1,100}$/.test(prefix)
    ||[options.accessKeyId,options.secretAccessKey].some(v=>typeof v!=='string'||!v||v.length>4096||/[^\x21-\x7e]/.test(v))
    ||options.timeoutMs!==undefined&&(!Number.isInteger(options.timeoutMs)||options.timeoutMs<1||options.timeoutMs>180000))fail('configuration');
  const client=new AwsClient({accessKeyId:options.accessKeyId,secretAccessKey:options.secretAccessKey,
    service:'s3',region:'auto',retries:0});
  const send=options.send??fetch;
  const url=(key:string)=>{
    if(typeof key!=='string'||key.length>1024||!/^[a-zA-Z0-9_.\/-]+$/.test(key)
      ||key.split('/').some(part=>!part||part==='.'||part==='..'||part==='locks'))fail('key');
    return `https://${accountId}.r2.cloudflarestorage.com/${bucket}/${prefix}/${key}`;
  };
  async function request(key:string,method:string,headers:Record<string,string>={},body?:Uint8Array){
    const target=url(key);
    if(body&&body.byteLength>MAX_BYTES)fail('body_bound');
    try{
      const signed=await client.sign(new Request(target,{method,headers,...(body?{body:new Uint8Array(body)}:{})}));
      // Signing reconstructs Request and drops redirect/signal settings. Apply
      // transport policy AFTER signing so credentials cannot follow a redirect.
      return await send(new Request(signed,{redirect:'error',signal:AbortSignal.timeout(options.timeoutMs??30000)}));
    }
    catch{return fail('unavailable');}
  }
  async function object(response:Response):Promise<DurableObject>{
    const etag=response.headers.get('etag')??'',digest=response.headers.get('x-amz-meta-sha256')??'';
    if(!validEtag(etag)||!/^[a-f0-9]{64}$/.test(digest))fail('metadata');
    const reader=response.body?.getReader(),parts:Uint8Array[]=[];let size=0;
    try{if(reader)for(;;){const part=await reader.read();if(part.done)break;
      size+=part.value.byteLength;if(size>MAX_BYTES)fail('body_bound');parts.push(part.value);}}
    catch(error){void reader?.cancel().catch(()=>{});if(error instanceof Error&&error.message==='catalog_object_store_body_bound')throw error;return fail('unavailable');}
    finally{reader?.releaseLock();}
    const bytes=Buffer.concat(parts);
    if(hash(bytes)!==digest)fail('digest');return{bytes:new Uint8Array(bytes),etag};
  }
  async function get(key:string){
    for(let attempt=0;;attempt++){
      let delay=100*2**attempt;
      try{
        const response=await request(key,'GET');
        if(response.status===404){await response.body?.cancel();return null;}
        if(response.status===429||response.status>=500){
          const header=response.headers.get('retry-after'),retry=header===null?NaN:/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now();
          await response.body?.cancel();if(Number.isFinite(retry))delay=Math.max(0,retry);
          if(delay>30000)fail('read_throttled');fail('unavailable');
        }
        if(response.status!==200){await response.body?.cancel();return fail('read_refused');}
        return await object(response);
      }catch(error){if(attempt===2||!(error instanceof Error)||error.message!=='catalog_object_store_unavailable')throw error;}
      await wait(delay);
    }
  }
  async function write(key:string,expectedEtag:string|null,body:Uint8Array){
    if(!(body instanceof Uint8Array)||body.byteLength>MAX_BYTES||expectedEtag!==null&&!validEtag(expectedEtag))fail('configuration');
    const bytes=new Uint8Array(body),digest=hash(bytes),md5=createHash('md5').update(bytes).digest();
    for(let attempt=0;;attempt++){
      let status:number|undefined,delay=100*2**attempt;
      try{const response=await request(key,'PUT',{'Content-Type':'application/octet-stream','x-amz-meta-sha256':digest,'Content-MD5':md5.toString('base64'),
      ...(expectedEtag===null?{'If-None-Match':'*'}:{'If-Match':expectedEtag})},bytes);
      status=response.status;const etag=response.headers.get('etag'),header=response.headers.get('retry-after'),
        retry=header===null?NaN:/^\d+$/.test(header)?Number(header)*1000:Date.parse(header)-Date.now();
      if(Number.isFinite(retry))delay=Math.max(0,retry);await response.body?.cancel();
      // Single-part PUT: R2 validates Content-MD5 and atomically commits the
      // conditional write. A matching successful ACK is durable; avoid a
      // redundant GET for every journal event/head. Lost/odd ACKs still use
      // exact SHA-256+byte readback below, never another blind write.
      // https://developers.cloudflare.com/r2/reference/consistency/
      if(status===200&&etag==='"'+md5.toString('hex')+'"')return{bytes,etag};
      }catch{/* A lost ACK is settled by exact readback, never an overwrite. */}
      const actual=await get(key);
      if(actual&&hash(actual.bytes)===digest&&Buffer.from(actual.bytes).equals(Buffer.from(bytes)))return actual;
      // A negative read does NOT rule out an earlier in-flight PUT. Retain the
      // ORIGINAL atomic condition and exact bytes on retry: even a late commit
      // cannot cause a duplicate transition or overwrite a competing head.
      const unchanged=expectedEtag===null?actual===null:actual?.etag===expectedEtag;
      if(status===412||!unchanged)return fail('conflict');
      const transient=status===undefined||status===429||status>=500;
      if(transient&&delay>30000)return fail('write_throttled');
      if(!transient||attempt===2)return fail(status!==undefined&&status>=400?'write_refused':'write_unknown');
      await wait(delay);
    }
  }
  return Object.freeze({get,putImmutable:(key:string,bytes:Uint8Array)=>write(key,null,bytes),
    compareAndSwap:async(key:string,expectedEtag:string|null,bytes:Uint8Array)=>{
      if(!mutableKey(key))fail('immutable_key');return write(key,expectedEtag,bytes);
    },
    async remove(key:string,expectedEtag:string){
      if(!validEtag(expectedEtag))fail('configuration');
      // R2 documents atomic conditional PUT, not conditional DELETE. Only
      // immutable run bodies can be removed, under the caller's registered
      // cleanup authority. Never use this for mutable heads/pointers.
      if(mutableKey(key))fail('mutable_key');
      const before=await get(key);if(before===null)return;
      if(before.etag!==expectedEtag)fail('conflict');
      let status:number|undefined;
      try{const response=await request(key,'DELETE');status=response.status;await response.body?.cancel();}catch{/* reconcile */}
      const actual=await get(key);if(actual===null)return;
      if(status!==undefined&&status>=400)fail('delete_refused');return fail('delete_unknown');
    }});
}
