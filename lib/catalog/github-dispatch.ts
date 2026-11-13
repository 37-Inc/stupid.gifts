export interface CatalogDispatchResult {
  state:'accepted'|'rejected'|'unknown';
  providerStatus:number|null;
  workflowRunId:number|null;
}
const URL='https://api.github.com/repos/37-Inc/stupid.gifts/actions/workflows/catalog-manual.yml/dispatches';

/** One fixed workflow, no redirects and no retry after an uncertain POST.
 * Shared by the clock and staff admissions; safe in the actual Workers runtime. */
export async function dispatchCatalogWorkflow(token:string,inputs:{mode:'admin'}|{mode:'full'|'photos';scheduled_at:string},
  send:typeof fetch=fetch):Promise<CatalogDispatchResult>{
  // Construct outside the transport catch: configuration errors are not an
  // uncertain network dispatch. Workers does not support redirect:"error".
  const request=new Request(URL,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(15000),headers:{
    Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json',
    'X-GitHub-Api-Version':'2026-03-10','User-Agent':'Stupid-Gifts-Catalog'},body:JSON.stringify({ref:'main',inputs})});
  let providerStatus:number|null=null;
  try{
    const response=await send(request);providerStatus=response.status;
    if(providerStatus===200){
      const value=await response.json() as {workflow_run_id?:unknown};
      if(Number.isSafeInteger(value.workflow_run_id)&&Number(value.workflow_run_id)>0)
        return{state:'accepted',providerStatus,workflowRunId:Number(value.workflow_run_id)};
    }else{
      await response.body?.cancel();
      if(providerStatus===204)return{state:'accepted',providerStatus,workflowRunId:null};
      if(providerStatus>=300&&providerStatus<500)return{state:'rejected',providerStatus,workflowRunId:null};
    }
  }catch{/* No provider body, exception text, credential or URL enters telemetry. */}
  return{state:'unknown',providerStatus,workflowRunId:null};
}
