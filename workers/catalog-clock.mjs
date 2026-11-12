import {catalogClockSlot} from '../lib/catalog/clock-slot.mjs';

const DISPATCH='https://api.github.com/repos/37-Inc/stupid.gifts/actions/workflows/catalog-manual.yml/dispatches';
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
  let response;
  try{response=await send(DISPATCH,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{
    authorization:`Bearer ${env.GITHUB_CATALOG_DISPATCH_TOKEN}`,accept:'application/vnd.github+json',
    'content-type':'application/json','user-agent':'Stupid-Gifts-Catalog-Clock','x-github-api-version':'2026-03-10'},
    body:JSON.stringify({ref:'main',inputs:slot})});}
  catch{log(JSON.stringify({state:'dispatch_unknown',...report,elapsedMs:now()-started}));throw Error('catalog_clock_dispatch_unknown');}
  await response.body?.cancel();
  const result={state:response.status===204?'dispatched':'failed',...report,status:response.status,elapsedMs:now()-started};
  log(JSON.stringify(result));
  if(response.status!==204)throw Error('catalog_clock_dispatch_failed_'+response.status);
  return result;
}
const worker={
  async scheduled(controller,env){await dispatchCatalogClock(controller.scheduledTime,env);},
  fetch(){return new Response('Not found',{status:404});},
};
export default worker;
