import {createEditorialStages,createCatalogEditorial} from './catalog-editorial.mjs';
import {prepareReviewedPhase} from './reviewed-provider-phases.mjs';
import {automatedCatalogExecutor} from '../ops/catalog-daily.mjs';

/** Shared provider preparation, deliberately unaware of publication/ownership.
 * The caller supplies the existing protected journal and read-only catalog.
 * Daily care and exact staff additions use identical evidence/copy rules.
 * Saved phases do not even initialize a model client on retry. */
export async function prepareCatalogProducts({phases,runId,journal,evidence,store,now,
  execute,complete,progress=(_value)=>{}}){
  await journal.restore(evidence);
  const savedStages=createEditorialStages({read:key=>journal.read(key),put:(key,value)=>journal.put(key,value),now});
  const stages={async run(stage,input,action){
    const result=await savedStages.run(stage,input,action);
    return stage==='embedding'&&result.reused?{...result,value:await journal.embeddingResponse(input,result.value)}:result;
  }};
  const bounded=automatedCatalogExecutor(execute),prepared=[];
  let editor;
  for(let index=0;index<phases.length;index++){
    const key=`phase-${index}`,phase=phases[index],started=Date.now();
    progress({phase:index+1,totalPhases:phases.length,stage:'start',elapsedMs:0});
    const saved=await journal.read(`${key}-prepared`);
    if(saved){prepared.push(saved);}
    else{
      let supplierCall=0;
      const providerEvidence={...evidence,amazon:async(...args)=>args[0]==='getItems'
        ?(await stages.run('refresh-collect',{run:runId,phase:index,call:supplierCall++,ids:args[3]},()=>evidence.amazon(...args))).value
        :evidence.amazon(...args)};
      // Exact staff selections have already been chosen by the owner. They
      // still get factual draft/review; only discovery needs admission judgment.
      if(phase.discoveryNewOnly&&!phase.admitAsins){
        if(!complete)throw Error('product_admission_review_unavailable');
        editor??=createCatalogEditorial({stages,complete});
      }
      prepared.push(await prepareReviewedPhase({key,journal,execute:bounded,
        options:{...phase,editorialStages:stages,...(phase.discoveryNewOnly&&!phase.admitAsins?{discoveryEditor:editor}:{})},
        store,evidence:providerEvidence,runId}));
    }
    progress({phase:index+1,totalPhases:phases.length,stage:'complete',elapsedMs:Math.max(0,Date.now()-started)});
  }
  return prepared;
}
