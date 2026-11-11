import type { MutationScope } from '../../lib/catalog/mutation-fence.ts';
import type { SyncVector } from './vector-outbox.ts';
import type { OwnedVectorAdapters } from './owned-vector-delivery.ts';
import { drainDeploymentObservation } from '../../lib/catalog/build-requests.ts';
import { isAccountedPublicationFetch } from './publication-read-fetch.ts';

const ownedReadbacks=new WeakSet<OwnedVectorAdapters['readback']|NonNullable<OwnedVectorAdapters['readbacks']>>();
const ownedTransports=new WeakSet<OwnedVectorAdapters>();
export function hasAccountedVectorTransport(adapters:OwnedVectorAdapters):boolean{return ownedTransports.has(adapters);}
export function hasAccountedVectorReadback(adapters:Pick<OwnedVectorAdapters,'readback'|'readbacks'>):boolean{
  return ownedReadbacks.has(adapters.readback)&&(!adapters.readbacks||ownedReadbacks.has(adapters.readbacks));
}

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
/** Explicit protected-workflow wiring only. No ambient credentials, redirects,
 * automatic retries, embedding generation, namespaces, or provider activation.
 * Docs: developers.cloudflare.com/api/resources/vectorize/ (v2 async mutations).
 */
export function createVectorizeRestAdapters(options: MutationScope & {
  accountId: string; token: string; fetch?: typeof fetch; timeoutMs?: number;
}): OwnedVectorAdapters {
  // Background delivery latency budget, not a request-time search timeout.
  const { accountId,indexName,environment,token } = options; const timeout = options.timeoutMs ?? 10_000;
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-zA-Z0-9_-]{1,100}$/.test(indexName)
    || !['staging','production'].includes(environment) || typeof token !== 'string' || !token.trim()
    || token.length > 4096 || /\s/.test(token) || !Number.isInteger(timeout) || timeout < 10 || timeout > 30_000)
    throw new Error('invalid_vectorize_configuration');
  const send = options.fetch ?? fetch;
  const accounted=isAccountedPublicationFetch(send);
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/vectorize/v2/indexes/${indexName}`;
  async function request(path: string, signal: AbortSignal, body?: string, ndjson = false): Promise<unknown> {
    signal.throwIfAborted();
    const controller = new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let sent:Promise<Response>|undefined,pending:Promise<unknown>|undefined,cancellation:Promise<unknown>|undefined,rejectAbort:(error:Error)=>void=()=>{};
    const aborted=new Promise<never>((_,reject)=>{rejectAbort=reject;});
    const abort = () => {controller.abort();cancellation??=reader?.cancel().catch(()=>{});rejectAbort(new Error('vector_provider_failed'));};
    signal.addEventListener('abort',abort,{once:true});
    // The accounted sender bounds provider headers separately from durable
    // reservation/settlement. Its body clock starts once that sender returns.
    let timer=accounted?undefined:setTimeout(abort,timeout);
    try {
      pending=(async()=>{const response=await(sent=send(`${base}/${path}`,{method:body===undefined?'GET':'POST',redirect:'error',signal:controller.signal,
        headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':ndjson?'application/x-ndjson':'application/json'})},body}));
      if(accounted)timer=setTimeout(abort,timeout);
      if(controller.signal.aborted||!response.ok||!response.body){void response.body?.cancel().catch(()=>{});throw new Error();}
      reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
      try { for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
        if(size>128*1024){await reader.cancel();throw new Error();}chunks.push(part.value);} }
      finally {reader.releaseLock();}
      const bytes=Buffer.concat(chunks);const envelope=JSON.parse(bytes.toString('utf8'));
      if(!envelope||envelope.success!==true||!Object.hasOwn(envelope,'result'))throw new Error();
      return envelope.result;})();return await Promise.race([pending,aborted]);
    } catch { throw new Error('vector_provider_failed'); }
    finally {clearTimeout(timer);signal.removeEventListener('abort',abort);
      if(controller.signal.aborted&&pending&&(path==='get_by_ids'||path==='info'||isAccountedPublicationFetch(send))){
        if(isAccountedPublicationFetch(send)&&sent)await sent.catch(()=>{});
        await drainDeploymentObservation(Promise.allSettled([pending,cancellation]));}}
  }
  function id(value:string){if(!UUID.test(value))throw new Error('vector_provider_invalid_id');}
  function vector(value:unknown):SyncVector {
    const v=value as SyncVector;
    if(!v||!UUID.test(v.id)||!Array.isArray(v.values)||v.values.length!==1536
      ||!Array.from(v.values).every(n=>typeof n==='number'&&Number.isFinite(n)&&Number.isFinite(Math.fround(n)))
      ||!v.metadata||typeof v.metadata!=='object'||Array.isArray(v.metadata)
      ||Buffer.byteLength(JSON.stringify(v.metadata))>4096||v.namespace)
      throw new Error('vector_provider_invalid_vector');
    return v;
  }
  async function readbacks(ids:string[],signal:AbortSignal) {
    if(!ids.length||ids.length>2||new Set(ids).size!==ids.length)throw new Error('vector_provider_invalid_id');
    ids.forEach(id);const result=await request('get_by_ids',signal,JSON.stringify({ids}));
    if(!Array.isArray(result)||result.length>ids.length)throw new Error('vector_provider_failed');
    const found=new Map<string,SyncVector>();
    for(const raw of result){const v=vector(raw);
      if(!ids.includes(v.id)||found.has(v.id))throw new Error('vector_provider_failed');
      found.set(v.id,{...structuredClone(v),values:v.values.map(Math.fround)});
    }
    return ids.map(id=>found.get(id)??null);
  }
  const adapters:OwnedVectorAdapters={environment,indexName,providerIdentity:`cloudflare:${accountId}:${indexName}`,
    async dispatchBatch(inputs,signal){
      if(!inputs.length||inputs.length>8||new Set(inputs.map(p=>p.publicId)).size!==inputs.length)throw Error('vector_provider_invalid_id');
      const lines=inputs.map(input=>{id(input.publicId);const v=vector(input.vector);
        if(v.id!==input.publicId)throw Error('vector_provider_invalid_id');
        return `{"id":${JSON.stringify(v.id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':JSON.stringify(n)).join(',')}],"metadata":${JSON.stringify(v.metadata)}}`;
      });
      const body=lines.join('\n')+'\n';if(Buffer.byteLength(body)>384*1024)throw Error('vector_payload_bound');
      const result=await request('upsert',signal,body,true) as {mutationId?:unknown};
      if(typeof result?.mutationId!=='string'||!UUID.test(result.mutationId))throw Error('vector_provider_failed');
      return{reference:result.mutationId};
    },
    async dispatch(input,signal){
      id(input.publicId);let body:string;
      if(input.vector){const v=vector(input.vector);if(v.id!==input.publicId)throw new Error('vector_provider_invalid_id');
        // JSON's -0 number is legal, but JSON.stringify silently changes it to0.
        // Keep the sign so the REST bridge does not falsify native-byte parity.
        body=`{"id":${JSON.stringify(v.id)},"values":[${v.values.map(n=>Object.is(n,-0)?'-0':JSON.stringify(n)).join(',')}],"metadata":${JSON.stringify(v.metadata)}}\n`;
      }else body=JSON.stringify({ids:[input.publicId]});
      const result=await request(input.vector?'upsert':'delete_by_ids',signal,body,Boolean(input.vector)) as {mutationId?:unknown};
      if(!result||typeof result.mutationId!=='string'||!UUID.test(result.mutationId))throw new Error('vector_provider_failed');
      return{reference:result.mutationId};
    },
    async resolve(input,signal){
      // REST has no client-delivery-id lookup. A lost mutationId cannot safely
      // be retried, guessed from visible bytes, or resolved by elapsed time.
      if(input.reference===null)return{state:'pending'};
      if(!UUID.test(input.reference))throw new Error('vector_provider_failed');
      const info=await request('info',signal) as {dimensions?:unknown;processedUpToMutation?:unknown};
      if(!info||info.dimensions!==1536)throw new Error('vector_provider_failed');
      return info.processedUpToMutation===input.reference?{state:'settled',reference:input.reference}:{state:'pending'};
    },
    readbacks,
    async readback(publicId,signal){return(await readbacks([publicId],signal))[0];},
  };
  if(isAccountedPublicationFetch(send)){ownedReadbacks.add(adapters.readback);ownedReadbacks.add(readbacks);ownedTransports.add(adapters);}
  return Object.freeze(adapters);
}
