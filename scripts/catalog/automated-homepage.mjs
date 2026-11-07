import path from 'node:path';
import {existsSync} from 'node:fs';
import {openRunWorkspace} from './run-workspace.ts';
import {canonicalJson,sha256} from './migration.ts';
import {resolveCatalogCredential} from './check-cloudflare-runner.ts';
import {createCatalogEditorial,createEditorialStages} from './catalog-editorial.mjs';
import {automatedHomepage} from './homepage-editor.mjs';
import {CATALOG_SCOPE} from './automation-runtime.mjs';
import {readHomepageEdition} from '../../lib/catalog/homepage-edition.ts';

/** Optional editor, using the SAME protected journal/storage implementation as
 * care. No catalog mutations, ownership takeovers, or extra publishing service.
 * An uncertain model dispatch retains its record and uses the last good edition.
 */
export async function curateAutomationHomepage({runtime,db,seal,prior,day,merchandising={},repository,source,complete}){
  const file=path.join(runtime.care,'homepage',day+'.json');
  try{const edition=readHomepageEdition(JSON.parse(await runtime.state.bytes(file)));
    if(edition?.day===day)return{state:'already_curated',edition};
  }catch(error){if(error.code!=='ENOENT')return{state:'last_good',edition:prior,attention:'homepage_saved_edition_unavailable'};}
  const config={schemaVersion:1,kind:'homepage-editor',day,acceptedCatalogSha256:sha256(canonicalJson(seal)),source};
  const runId='homepage-'+day+'-'+source.slice(0,8),now=new Date().toISOString();
  const retention={reviewReference:'catalog-automation-spec/homepage-v1',rules:Object.fromEntries(
    ['amazon-observation','embedding-response','phase','publication','checkpoint'].map(kind=>[kind,{maxAgeMs:86400000,notAfter:new Date(Date.parse(now)+86400000).toISOString()}]))};
  // Retention is anchored to the original journal, not a restart's wall clock.
  const recordFile=path.join(runtime.care,'homepage',day,'operator.json');
  let record;
  try{record=JSON.parse(await runtime.state.bytes(recordFile));}
  catch(error){if(error.code!=='ENOENT')return{state:'last_good',edition:prior,attention:'homepage_editor_state_unavailable'};
    record={config,retention,observedAt:now};
    try{await runtime.state.put(recordFile,record);}catch{return{state:'last_good',edition:prior,attention:'homepage_editor_state_unavailable'};}}
  if(canonicalJson(record.config)!==canonicalJson(config))return{state:'last_good',edition:prior,attention:'homepage_editor_source_changed'};
  let workspace;
  try{
    const options={directory:runtime.workspace,repository,runId,codeSha:source,configSha256:sha256(canonicalJson(config)),scope:CATALOG_SCOPE,
      retention:record.retention,budgetCaps:{httpRequests:1,sqlStatements:0},requestLimit:'observe',...(runtime.durable?{durable:runtime.durable}:{})};
    const local=existsSync(path.join(runtime.workspace,'runs',runId,'manifest.json')),
      remote=runtime.durable?await runtime.durable.get(`runs/${runId}/manifest.json`):null;
    // A saved response can outlive an edition-save failure or the runner.
    // Unknown remote state throws; it is never treated as absence/new work.
    workspace=await openRunWorkspace({...options,mode:local||remote?'resume':'create'});
    if(runtime.hosted)await (await import('./hosted-cleanup.mjs')).registerHostedWorkspaceCleanup(runtime,workspace.manifest);
    let checkpoint=await workspace.readCheckpoint(),state=checkpoint?.checkpoint.state??{entries:{}};
    const save=async next=>{checkpoint=await workspace.writeCheckpoint(checkpoint?.sha256??null,
      {phase:'editing',owner:null,state:next,pins:{},phaseComplete:null});state=next;};
    const stages=createEditorialStages({
      read:key=>state.entries[key]?workspace.readArtifact(state.entries[key]):undefined,
      put:async(key,value)=>{const ref=await workspace.putArtifact(value,{kind:'phase',observedAt:new Date().toISOString()});
        await save({...state,entries:{...state.entries,[key]:ref}});},
    });
    if(!complete){const {default:OpenAI}=await import('openai');
      const client=new OpenAI({apiKey:await resolveCatalogCredential(runtime.credentials.openai),maxRetries:0,timeout:90000});
      complete=request=>client.chat.completions.create(request);}
    const editor=createCatalogEditorial({complete,stages});
    return await automatedHomepage({db,revision:seal.projectionReceipt.catalog_revision,prior,day,merchandising,editor,
      save:edition=>runtime.state.put(file,edition)});
  }catch{return{state:'last_good',edition:prior,attention:'homepage_editor_unavailable'};}
  finally{try{await workspace?.close();}catch{console.warn(JSON.stringify({attention:'homepage_editor_close_pending'}));}}
}
