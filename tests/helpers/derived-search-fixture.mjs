import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../../lib/catalog/canonical-json.ts';
import { semanticProductInput, normalizeSemanticPrefix } from '../../lib/catalog/semantic-profile.ts';
import { encodePgvectorSendBase64 } from '../../scripts/catalog/pgvector-binary.ts';
import { prepareSemanticCatalog } from '../../scripts/catalog/prepare-semantic-catalog.ts';
import { createSiteWorker } from '../../workers/site/index.ts';

export const digest = text => createHash('sha256').update(text).digest('hex');
export async function derivedFixture() {
  const snapshot = JSON.parse(readFileSync(new URL('../../static-site/fixtures/catalog.snapshot.json', import.meta.url)));
  snapshot.products = snapshot.products.map(p => ({ ...p, eligibleUntil: null, indexable: false }));
  const receipt = { schemaVersion: 1, kind: 'embedding-response', model: 'text-embedding-3-small',
    observedAt: '2026-10-26T15:00:00.000Z', products: snapshot.products.map((product,i) => {
      const nativeBase64 = encodePgvectorSendBase64(Array.from({length:1536},(_,n) => Math.fround(((n+i)%11-5)/100)));
      return { id: product.id, sourceFactsHash: 'a'.repeat(64), text: semanticProductInput(product,'SYNTHETIC retained context'),
        nativeBase64, vectorBytesSha256: digest(Buffer.from(nativeBase64,'base64')) };
    }) };
  const sources = receipt.products.map(p => ({receipt, receiptSha256:digest(canonicalJson(receipt)),
    receiptReference:'fixture-only/retained-embedding', productId:p.id, expectedInput:p.text,
    expectedSourceFactsHash:p.sourceFactsHash,expectedNativeSha256:p.vectorBytesSha256,retainedContext:'SYNTHETIC retained context'}));
  const prepared = await prepareSemanticCatalog({snapshot,indexName:'synthetic-derived-index',sources});
  return { snapshot, sources, ...prepared };
}
/** The actual Worker with fake bindings: no network, credential, index or DB mutation. */
export function derivedWorker(fixture, options = {}) {
  const calls = {reserve:[],embed:0,vector:[],legacy:0};
  const env = { ENVIRONMENT:'staging', SEMANTIC_SEARCH_ENABLED:'true', SEMANTIC_SEARCH_DAILY_REQUEST_CAP:'50',
    SEMANTIC_SEARCH_DAILY_TOKEN_CAP:'32768',STAGING_AUTH_SECRET:'SYNTHETIC-STAGING-SECRET', ASSETS:{async fetch(){throw new Error('not an asset test');}},
    VECTORIZE:{async query(){calls.legacy++;throw new Error('native index must stay untouched');}},
    SEMANTIC_VECTORIZE:{async query(vector,params){calls.vector.push({vector,params});
      if(options.vector) return options.vector(vector,params);
      return {matches:fixture.vectors.map(v => ({id:v.id,score:.9,metadata:v.metadata}))};}}, ...options.env };
  const snapshot = options.snapshot ?? fixture.snapshot;
  const manifest = {catalogRevision:snapshot.catalogRevision,routes:{},checksums:{},semanticCatalog:options.catalog ?? fixture.catalog};
  const worker = createSiteWorker({snapshot,manifest,now:()=>Date.parse('2026-10-26T20:00:00Z'),
    semanticBudgetScope:{environment:'staging',index:'native-fixture-index'},searchAdapters:{
      storage:()=>({async byPublicIds(){throw new Error('do not use finite supplier/native lookup');},
        async keyword(){throw new Error('cleared keyword search must stay database-free');}}),
      async embed(_q,_env,_signal,profile){calls.embed++;if(options.embed)return options.embed(profile);
        return normalizeSemanticPrefix(Array(1536).fill(.1),profile.dimensions);},
    }});
  return {calls,env,worker,async request(query='paperweight',limit=36){
    const response=await worker.fetch(new Request(`https://preview.example/api/search-products?q=${encodeURIComponent(query)}&limit=${limit}`,
      {headers:{Authorization:`Basic ${btoa(`staging:${env.STAGING_AUTH_SECRET}`)}`}}),env);
    return {response,body:await response.json()};
  }};
}
