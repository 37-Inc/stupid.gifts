/** Exact successor-run authority. This is deliberately absent from historical
 * requests: it is not a larger default cap or permission to scan ready rows. */
export interface AutomationCohortAuthority {
  schemaVersion:1;runId:string;configSha256:string;journalSha256:string;writerGeneration:number;
  refreshIds:string[];admittedIds:string[];products:Array<{id:string;publicId:string}>;photosOnly?:true;
}
const HASH=/^[a-f0-9]{64}$/,ASIN=/^[A-Z0-9]{10}$/;
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const exact=(value:unknown,keys:string)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys;
function refuse():never{throw Error('automation_cohort_invalid');}
export function validateAutomationCohort(value:AutomationCohortAuthority,approval?:{runId:string;changes:Array<{publicId:string}>}) {
  if(!exact(value,'admittedIds,configSha256,journalSha256,'+(value?.photosOnly===true?'photosOnly,':'')+'products,refreshIds,runId,schemaVersion,writerGeneration')
    ||value.schemaVersion!==1||typeof value.configSha256!=='string'||!HASH.test(value.configSha256)
    ||typeof value.journalSha256!=='string'||!HASH.test(value.journalSha256)
    ||typeof value.runId!=='string'||!/^[a-zA-Z0-9._-]{1,100}$/.test(value.runId)||!Number.isSafeInteger(value.writerGeneration)||value.writerGeneration<1
    ||!Array.isArray(value.refreshIds)||!Array.isArray(value.admittedIds)||!Array.isArray(value.products)
    // Existing complete captured-catalog transport bound, not a growth quota.
    ||value.refreshIds.length+value.admittedIds.length>10000||value.products.length>10000||value.photosOnly&&value.admittedIds.length)refuse();
  const allowed=[...value.refreshIds,...value.admittedIds];
  if(new Set(allowed).size!==allowed.length||allowed.some(id=>typeof id!=='string'||!ASIN.test(id))
    ||value.products.some(p=>!exact(p,'id,publicId')||typeof p.id!=='string'||typeof p.publicId!=='string')
    ||new Set(value.products.map(p=>p.id)).size!==value.products.length||new Set(value.products.map(p=>p.publicId)).size!==value.products.length
    ||value.products.some(p=>!exact(p,'id,publicId')||!allowed.includes(p.id)||!UUID.test(p.publicId))
    ||value.admittedIds.some(id=>!value.products.some(p=>p.id===id)))refuse();
  if(approval&&(approval.runId!==value.runId||approval.changes.length!==value.products.length
    ||new Set(approval.changes.map(c=>c.publicId)).size!==approval.changes.length
    ||approval.changes.some(c=>!value.products.some(p=>p.publicId===c.publicId))))refuse();
  return value;
}
export function automationContains(value:AutomationCohortAuthority|undefined,ids:string[]) {
  if(!value)return false;
  validateAutomationCohort(value);
  return new Set(ids).size===ids.length&&ids.every(id=>value.products.some(p=>p.publicId===id));
}
