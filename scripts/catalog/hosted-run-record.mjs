import {createHash} from 'node:crypto';
import {canonicalJson} from '../../lib/catalog/canonical-json.ts';
const HASH=/^[a-f0-9]{64}$/,SOURCE=/^[a-f0-9]{40}$/,ASIN=/^[A-Z0-9]{10}$/;
const fail=(reason='run_record')=>{throw Error('catalog_hosted_'+reason);};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.split(',').sort().join(',');
const hash=value=>createHash('sha256').update(value).digest('hex');
export function validAdmissionAsins(ids){return Array.isArray(ids)&&ids.length>0&&ids.length<=10
  &&ids.every(id=>typeof id==='string'&&ASIN.test(id))&&new Set(ids).size===ids.length
  &&canonicalJson(ids)===canonicalJson([...ids].sort());}
export function hostedRunKey(kind,day,source,canaryId,admitAsins){
  return kind==='code'?'serving-'+source.slice(0,12):kind==='full'?'scheduled-'+day:kind==='photos'?'photos-'+day
    :kind==='admit'?'admit-'+day+'-'+hash(canonicalJson(admitAsins)).slice(0,12):'canary-'+day+'-'+canaryId;
}
/** One immutable intent contract shared by the coordinator AND real operator. */
export function hostedRunRecord(value){
  if(!exact(value,'schemaVersion,runKey,source,day,kind,inputsRef'+(value?.kind==='canary'?',canaryId':value?.kind==='admit'?',admitAsins':''))||value.schemaVersion!==1
    ||!SOURCE.test(value.source)||!['full','photos','canary','code','admit'].includes(value.kind))fail();
  const date=new Date(value.day+'T00:00:00Z');
  if(typeof value.day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value.day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value.day)fail('day');
  const ref=value.inputsRef;if(!exact(ref,'schemaVersion,key,sha256')||ref.schemaVersion!==1||!HASH.test(ref.sha256)||ref.key!==`inputs/${ref.sha256}.json`)fail('inputs_reference');
  if(value.kind==='admit'&&!validAdmissionAsins(value.admitAsins))fail('admission_asins');
  if(value.kind==='canary'&&!ASIN.test(value.canaryId))fail();
  if(value.runKey!==hostedRunKey(value.kind,value.day,value.source,value.canaryId,value.admitAsins))fail();
  return value;
}
