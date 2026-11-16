import {createHash} from 'node:crypto';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
import {encodePgvectorSendBase64} from './pgvector-binary.ts';
export interface ImmutableNativeVector {
  id:string;values:number[];metadata:{kind:'immutable-native-v1';publicId:string;catalogRevision:string;
    embeddingTextHash:string;embeddingModel:'text-embedding-3-small';vectorBytesSha256:string;payloadSha256:string};
}
export const nativeVectorDigest=(values:number[])=>createHash('sha256').update(Buffer.from(encodePgvectorSendBase64(values),'base64')).digest('hex');
export const immutableNativeId=(metadata:ImmutableNativeVector['metadata'])=>createHash('sha256').update(canonicalJson(metadata)).digest('hex');
/** Explicit immutable-ID lane; legacy UUID vectors/readers stay unchanged. */
export function isImmutableNativeVector(value:unknown):value is ImmutableNativeVector{
  try{const v=value as ImmutableNativeVector,m=v?.metadata;
    return !!v&&Object.keys(v).sort().join(',')==='id,metadata,values'&&!!m
      &&Object.keys(m).sort().join(',')==='catalogRevision,embeddingModel,embeddingTextHash,kind,payloadSha256,publicId,vectorBytesSha256'
      &&m.kind==='immutable-native-v1'&&m.embeddingModel==='text-embedding-3-small'
      &&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(m.publicId)
      &&/^[a-zA-Z0-9._-]{1,200}$/.test(m.catalogRevision)
      &&[v.id,m.embeddingTextHash,m.vectorBytesSha256,m.payloadSha256].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s))
      &&immutableNativeId(m)===v.id&&Array.isArray(v.values)&&v.values.length===1536
      &&v.values.every(n=>typeof n==='number'&&Number.isFinite(n)&&Object.is(Math.fround(n),n))
      &&nativeVectorDigest(v.values)===m.vectorBytesSha256;
  }catch{return false;}
}
