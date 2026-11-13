import {catalogClockSlot} from '../lib/catalog/clock-slot.mjs';
import {dispatchCatalogWorkflow} from '../lib/catalog/github-dispatch.ts';
/** A clock only: no catalog, merchant, model, database or storage credentials. */
export async function dispatchCatalogClock(time,env,{send=fetch,now=Date.now,log=console.log}={}){
  const slot=catalogClockSlot(time);
  if(!slot||env.CLOCK_ENABLED!=='true'){
    const result={state:'skipped',reason:env.CLOCK_ENABLED!=='true'?'disabled':'outside_pacific_slot',
      wakeAt:Number.isFinite(new Date(time).getTime())?new Date(time).toISOString():null};
    log(JSON.stringify(result));return result;
  }
  if(!env.GITHUB_CATALOG_DISPATCH_TOKEN)throw Error('catalog_clock_credential_missing');
  const started=now(),report={...slot,wakeAt:new Date(time).toISOString(),dispatchedAt:new Date(started).toISOString()};
  // Do not blindly retry an uncertain POST. The existing two-hour catch-up
  // uses the same durable run identity and cannot create another supplier batch.
  const dispatch=await dispatchCatalogWorkflow(env.GITHUB_CATALOG_DISPATCH_TOKEN,slot,send);
  const result={state:dispatch.state==='accepted'?'dispatched':dispatch.state==='rejected'?'failed':'dispatch_unknown',
    ...report,status:dispatch.providerStatus,workflowRunId:dispatch.workflowRunId,elapsedMs:now()-started};
  log(JSON.stringify(result));
  if(dispatch.state!=='accepted')throw Error(dispatch.state==='rejected'?'catalog_clock_dispatch_failed_'+dispatch.providerStatus:'catalog_clock_dispatch_unknown');
  return result;
}
const worker={
  async scheduled(controller,env){await dispatchCatalogClock(controller.scheduledTime,env);},
  fetch(){return new Response('Not found',{status:404});},
};
export default worker;
