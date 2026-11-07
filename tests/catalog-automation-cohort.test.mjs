import assert from 'node:assert/strict';
import test from 'node:test';
import {validateAutomationCohort,automationContains} from '../lib/catalog/automation-cohort.ts';

const id=n=>`B${String(n).padStart(9,'0')}`,uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const products=Array.from({length:120},(_,n)=>({id:id(n+1),publicId:uuid(n+1)}));
const authority={schemaVersion:1,runId:'fixture',configSha256:'a'.repeat(64),journalSha256:'b'.repeat(64),writerGeneration:3,
  refreshIds:products.slice(0,100).map(p=>p.id),admittedIds:products.slice(100).map(p=>p.id),products};
const approval={runId:'fixture',changes:products.map(p=>({publicId:p.publicId}))};

test('automation grants exact changed membership, not an arbitrary enlarged count allowance',()=>{
  assert.equal(validateAutomationCohort(authority,approval),authority);
  assert.equal(automationContains(authority,[uuid(1),uuid(120)]),true);
  assert.equal(automationContains(authority,[uuid(121)]),false);
  assert.equal(automationContains(authority,[uuid(1),uuid(1)]),false);
  assert.equal(automationContains(undefined,[uuid(1)]),false);
  // Failed/unobserved refreshes may remain unchanged, but every actually
  // admitted new identity and every approved change must have an exact member.
  const partial={...authority,products:products.filter(p=>p.id!==id(1))};
  validateAutomationCohort(partial,{...approval,changes:approval.changes.slice(1)});
});

test('outside-pin IDs, duplicate identities, missing admissions, wrong run and malformed authority are rejected',()=>{
  const invalid=[
    {...authority,extra:true}, {...authority,configSha256:'unknown'}, {...authority,writerGeneration:0},
    {...authority,products:[...products.slice(1),{id:id(999),publicId:uuid(999)}]},
    {...authority,products:[...products.slice(1),products[1]]},
    {...authority,products:[{...products[0],publicId:products[1].publicId},...products.slice(1)]},
    {...authority,refreshIds:[...authority.refreshIds,id(101)]},
    {...authority,products:products.slice(0,119)},
  ];
  for(const value of invalid)assert.throws(()=>validateAutomationCohort(value,approval),/automation_cohort_invalid/);
  for(const changed of [{...approval,runId:'other'}, {...approval,changes:approval.changes.slice(1)},
    {...approval,changes:[...approval.changes.slice(1),{publicId:uuid(999)}]},
    {...approval,changes:[...approval.changes.slice(1),approval.changes[1]]}])
    assert.throws(()=>validateAutomationCohort(authority,changed),/automation_cohort_invalid/);
});
