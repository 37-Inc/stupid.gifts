import {readFile} from 'node:fs/promises';
import {claimMutationOwnership} from '../../lib/catalog/mutation-fence.ts';
import {sha256} from './migration.ts';
import {putOrdered} from './run-cloudflare-weekly.ts';
import {createD1CatalogTelemetryStore} from './telemetry-d1.ts';
import {createUsageLedger,finalizeUsageLedger} from '../ops/catalog-telemetry.mjs';
import type {CatalogD1} from '../../lib/catalog/storage/d1.ts';
import type {RunWorkspace} from './run-workspace.ts';
import type {CloudflareWeeklyConfig} from './run-cloudflare-weekly.ts';

/** Owner-requested membership policy publication, using existing saved source.
 * No merchant/model phase, product mutation, reservation reset or custom deploy.
 * Afterwards the normal review/publish command owns all freeze/index/receipts. */
export async function beginAvailabilityPublication(input:{workspace:RunWorkspace;db:CatalogD1;config:CloudflareWeeklyConfig;configSha256:string}) {
  const {workspace:w,db,config,configSha256}=input;
  let saved=await w.readCheckpoint();const cp=saved?.checkpoint;
  if(cp?.phase==='phases_complete')return;
  if(cp&&!(cp.phase==='phases_running'&&cp.state&&typeof cp.state==='object'&&!Array.isArray(cp.state)
    &&cp.state.kind==='availability-policy'))throw Error('availability_publication_phase');
  const pins=cp?.pins??{};
  if(!cp){
    for(const [name,ref]of Object.entries(config.inputs)){
      const bytes=await readFile(ref.path);if(sha256(bytes.toString('utf8'))!==ref.sha256)throw Error('availability_publication_input');
      const value=JSON.parse(bytes.toString('utf8'));
      pins[name]=name==='previous'?await putOrdered(w,value,ref.observedAt,'phase'):await w.putArtifact(value,{kind:'phase',observedAt:ref.observedAt});
    }
  }
  const owner=await claimMutationOwnership(db,{environment:config.environment,indexName:config.vectorIndex.name},
    {phase:'writing',ownerReference:config.runId,operationKey:sha256(`weekly:${configSha256}`)});
  if(!owner)throw Error('availability_publication_owner_busy');
  if(cp?.owner&&(cp.owner.token!==owner.token||cp.owner.generation!==owner.generation))throw Error('availability_publication_owner_changed');
  const cursor={current:owner};
  saved=await w.writeCheckpoint(saved?.sha256??null,{phase:'phases_running',owner,pins,state:{kind:'availability-policy'},phaseComplete:null});
  const telemetry=createD1CatalogTelemetryStore({db,owner,ownerCursor:cursor,runId:config.runId,catalogRevision:config.catalogRevision});
  await telemetry.startCatalogRun({id:config.runId,mode:'availability-policy',trigger:'manual',gitSha:config.codeSha,
    config:{supplierRequests:0,modelRequests:0,productMutations:0}});
  const summary={counts:{policy:{supplierRequests:0,modelRequests:0,productMutations:0}},timingsMs:{},
    usage:finalizeUsageLedger(createUsageLedger()),warnings:[]};
  const phaseComplete=await w.putArtifact(summary,{kind:'publication',observedAt:new Date().toISOString()});
  await w.writeCheckpoint(saved.sha256,{phase:'phases_complete',owner:cursor.current,pins,state:{kind:'availability-policy'},phaseComplete});
}
