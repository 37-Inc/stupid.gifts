import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';

test('actual Workers Request handles clock/admin dispatch without redirects or external traffic',async t=>{
  const bundle=await build({stdin:{contents:`
    import {dispatchCatalogWorkflow} from './lib/catalog/github-dispatch.ts';
    import {dispatchCatalogClock} from './workers/catalog-clock.mjs';
    export default {async fetch(){
      let calls=0;
      const send=async request=>{
        calls++;
        if(request.redirect!=='manual')throw Error('unsafe_redirect');
        const body=await request.json();
        if(body.ref!=='main'||!['full','admin'].includes(body.inputs.mode))throw Error('wrong_target');
        return Response.json({workflow_run_id:43210});
      };
      const admin=await dispatchCatalogWorkflow('OFFLINE_ONLY',{mode:'admin'},send);
      const clock=await dispatchCatalogClock('2026-11-13T16:30:15.559Z',
        {CLOCK_ENABLED:'true',GITHUB_CATALOG_DISPATCH_TOKEN:'OFFLINE_ONLY'},{send,log:()=>{}});
      let unsupported=false;try{new Request('https://example.invalid/',{redirect:'error'});}catch{unsupported=true;}
      return Response.json({admin,clock,calls,unsupported});
    }}`,
    resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-10-19'}));
  t.after(()=>mf.dispose());
  const response=await mf.dispatchFetch('http://localhost/'),result=await response.json();
  assert.equal(response.status,200);assert.equal(result.calls,2);assert.equal(result.unsupported,true);
  assert.equal(result.admin.state,'accepted');assert.equal(result.clock.state,'dispatched');
  assert.equal(result.clock.workflowRunId,43210);
});
