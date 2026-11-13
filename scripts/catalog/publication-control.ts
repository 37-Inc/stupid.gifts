import {canonicalJson,sha256} from './migration.ts';
import {activatedPermanentSummary} from './activated-permanent-control.ts';
import {catalogSuccessorBytes} from './approved-catalog-seal.ts';
import {validateAutomationCohort} from '../../lib/catalog/automation-cohort.ts';
import {validatePermanentCatalogSeal} from './permanent-catalog-seal.ts';

export type PublicationControlKind='request'|'revision'|'summary'|'appeals'|'search-delta'|'publication-result';
export interface DurablePublicationArtifact {schemaVersion:1;kind:PublicationControlKind;value:unknown}
const exact=(v:unknown,keys:string[])=>Boolean(v&&typeof v==='object'&&!Array.isArray(v)
  &&Object.keys(v).sort().join(',')===[...keys].sort().join(','));
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
function fail():never{throw Error('publication_control_invalid');}

/** Only IDs, hashes, original timestamps, numeric telemetry and fixed control
 * labels survive supplier retention. Never a provider body, copy or vector. */
function metadata(v:unknown,key='',depth=0):void{
  if(depth>30)fail();
  if(key==='automation'){validateAutomationCohort(v as Parameters<typeof validateAutomationCohort>[0]);return;}
  if(key==='predecessor'){
    if((v as {kind?:string})?.kind==='permanent-catalog-seal')validatePermanentCatalogSeal(v as Parameters<typeof validatePermanentCatalogSeal>[0]);
    else{if((v as {kind?:string})?.kind!=='approved-catalog-seal')fail();catalogSuccessorBytes(v as Parameters<typeof catalogSuccessorBytes>[0]);}return;
  }
  if(key==='envelopeJson'){
    if(typeof v!=='string')fail();const e=JSON.parse(v);
    if(!exact(e,['schemaVersion','dataKind','catalogRevision','generatedAt','products','heldProducts','slugHistory'])
      ||e.schemaVersion!==1||e.dataKind!=='catalog'||!Array.isArray(e.products)||!e.products.every(uuid)
      ||e.products.length>10000||!Array.isArray(e.heldProducts)||!Array.isArray(e.slugHistory))fail();
    for(const h of e.heldProducts){
      if(!exact(h,['id','publicId','slug','path','title','description','reason',...(h.affiliateUrl===undefined?[]:['affiliateUrl'])])
        ||!uuid(h.publicId)||h.title!=='Gift currently unavailable'
        ||h.description!=='This gift is not currently available in the curated catalog. Browse other gifts instead.'
        ||h.affiliateUrl!==undefined&&!/^https:\/\/[^\s]{1,2000}$/.test(h.affiliateUrl))fail();
      const {title,description,affiliateUrl,...identity}=h;void title;void description;void affiliateUrl;metadata(identity,'',depth+1);
    }
    metadata(e.slugHistory,'',depth+1);metadata(e.catalogRevision,'',depth+1);metadata(e.generatedAt,'',depth+1);return;
  }
  if(key==='manifest_json'){if(typeof v!=='string')fail();metadata(JSON.parse(v),'',depth+1);return;}
  if(/^(?:title|description|imageUrl|affiliateUrl|products|candidates|snapshot|packet|sourceRows|sourceFacts|source_facts|source_record_json|embedding|nativeBase64|values|rawBody|text)$/.test(key))fail();
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
  if(typeof v==='string'){if(!/^[a-zA-Z0-9_.:/+-]{0,250}$/.test(v)||v.includes('://'))fail();return;}
  if(Array.isArray(v)){if(v.length>20000)fail();for(const item of v)metadata(item,'',depth+1);return;}
  if(v&&typeof v==='object'&&Object.keys(v).length<=100){for(const[k,value]of Object.entries(v)){
    if(!/^[a-zA-Z0-9_.:-]{1,100}$/.test(k))fail();metadata(value,k,depth+1);
  }return;}fail();
}
export function validatePublicationControlArtifact(input:DurablePublicationArtifact):DurablePublicationArtifact{
  if(!exact(input,['schemaVersion','kind','value'])||input.schemaVersion!==1
    ||!['request','revision','summary','appeals','search-delta','publication-result'].includes(input.kind))fail();
  if(input.kind==='appeals'){
    if(!Array.isArray(input.value)||input.value.length>10000||input.value.some(v=>!exact(v,['id','sourceSha256','appeal'])
      ||!/^B[A-Z0-9]{9}$/.test(v.id)||!hash(v.sourceSha256)||!['standout','giftable','ordinary','unreviewed'].includes(v.appeal)))fail();
    return input;
  }
  const v=input.value as Record<string,unknown>&{request?:Record<string,unknown>;revision?:Record<string,unknown>};
  if(input.kind==='summary'){activatedPermanentSummary(v);return input;}
  if(input.kind==='request'){
    if(!exact(v,['schemaVersion','kind','request','previous','requestSha256'])||v.schemaVersion!==1||v.kind!=='approved-request-control'
      ||!hash(v.requestSha256)||!v.request||!hash(v.request.approvalSha256)
      ||sha256(canonicalJson(v.request.approval))!==v.request.approvalSha256)fail();
  }else if(input.kind==='revision'){
    if(!exact(v,['schemaVersion','kind','revision','request','projection','sourceIds','sourceRowsSha256','revisionSha256'])
      ||v.schemaVersion!==2||v.kind!=='approved-revision-control'||!hash(v.sourceRowsSha256)||!hash(v.revisionSha256)
      ||!Array.isArray(v.sourceIds)||!v.sourceIds.every(uuid)||!v.revision?.persistent)fail();
    validatePublicationControlArtifact({schemaVersion:1,kind:'request',value:v.request});
  }else if(input.kind==='search-delta'){
    if(!exact(v,['catalogRevision','indexName','entries','verified','upserted'])||!Array.isArray(v.entries))fail();
  }else if(!exact(v,['state','owner','releaseId','receiptSha256','receipt'])||v.state!=='published'||v.owner!==null||!hash(v.receiptSha256))fail();
  metadata(v);if(Buffer.byteLength(canonicalJson(input))>8*1024*1024)fail();return input;
}
export function validatePublicationCheckpointState(value:unknown):void{
  if(!value||typeof value!=='object'||Array.isArray(value)
    ||Object.keys(value).some(k=>!['automationJournal','outboxSequence','vectorOffset','vectorIds','requestId','errorCode'].includes(k)))fail();
  metadata(value);
}
