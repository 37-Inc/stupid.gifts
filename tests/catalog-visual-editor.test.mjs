import assert from 'node:assert/strict';
import test from 'node:test';
import {createCatalogEditorial,createEditorialStages,validateHomepageDecision} from '../scripts/catalog/catalog-editorial.mjs';
import {automatedHomepage} from '../scripts/catalog/homepage-editor.mjs';
import {editorialSourceHash} from '../scripts/ops/catalog-editorial-core.mjs';

function storage(){
  const records=new Map();
  return{records,read:async key=>structuredClone(records.get(key)),put:async(key,value)=>{
    if(records.has(key))assert.deepEqual(records.get(key),value);else records.set(key,structuredClone(value));
  }};
}
const NOW='2026-11-06T20:00:00.000Z';
const completion=value=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{total_tokens:7}});
const candidate={id:'B000000001',title:'Alligator oven mitts',imageUrl:'https://example.invalid/mitts.jpg',
  sourceFacts:{shape:'alligator',function:'oven mitts'}};
const decision={id:candidate.id,decision:'admit',appeal:'giftable',imageMatches:true,duplicateOfId:null,reason:'The alligator mouths turn oven mitts into a visual animal gag.'};
function editor(send,store=storage(),usage=[]){
  return{store,usage,editor:createCatalogEditorial({complete:send,stages:createEditorialStages({...store,now:()=>NOW}),onUsage:item=>usage.push(item)})};
}
test('visual review uses a photo, factual data, fixed Luna and a strict output schema',async()=>{
  let requests=0;
  const f=editor(async request=>{
    requests++;assert.equal(request.model,'gpt-6-luna');assert.equal(request.reasoning_effort,'none');
    assert.equal(request.response_format.type,'json_schema');assert.equal(request.response_format.json_schema.strict,true);
    assert.equal(request.messages[1].content[2].image_url.url,candidate.imageUrl);
    assert.match(request.messages[0].content,/untrusted data/);
    return completion(decision);
  });
  assert.deepEqual(await f.editor.reviewDiscovery([candidate]),[decision]);
  assert.deepEqual(await f.editor.reviewDiscovery([{...candidate,price:999,rating:1,availabilityStatus:'IN_STOCK'}]),[decision]);
  assert.equal(requests,1);assert.equal(f.usage.length,1); // Volatile offers do not buy another judgment.
  await f.editor.reviewDiscovery([{...candidate,title:'Different actual object'}]);assert.equal(requests,2);
});
test('ordinary, ambiguous and malformed decisions never become automatic admissions',async()=>{
  for(const value of [
    {...decision,appeal:'ordinary'}, {...decision,imageMatches:false}, {...decision,id:'foreign'},
    {...decision,reason:''}, {...decision,extra:'not allowed'},
  ]){
    const f=editor(async()=>completion(value));
    assert.equal((await f.editor.reviewDiscovery([candidate]))[0].decision,'defer');
  }
  const f=editor(async()=>{throw Error('must not call');});
  assert.equal((await f.editor.reviewDiscovery([{...candidate,imageUrl:''}]))[0].decision,'defer');
});
test('only a bounded photo-backed comparison can reject a different ASIN as the same design',async()=>{
  const catalog=Array.from({length:100},(_,i)=>({id:`existing-${i}`,title:`Alligator oven mitts design ${i}`,imageUrl:`https://example.invalid/existing-${i}.jpg`}));
  let requests=0;
  const f=editor(async request=>{
    requests++;const content=request.messages[1].content;
    assert.equal(content.filter(item=>item.type==='image_url').length,4); // Candidate plus three hints, never the whole catalog.
    assert.doesNotMatch(content[0].text,/existing-99/);
    return completion({...decision,decision:'reject',duplicateOfId:'existing-0',reason:'Both photographs show the same toothy alligator mitt design.'});
  });
  const result=await f.editor.reviewDiscovery([candidate],{catalog});
  assert.equal(result[0].duplicateOfId,'existing-0');assert.equal(result[0].decision,'reject');assert.equal(requests,1);
  const invalid=editor(async()=>completion({...decision,decision:'reject',duplicateOfId:'not-supplied'}));
  assert.equal((await invalid.editor.reviewDiscovery([candidate],{catalog}))[0].decision,'defer');
});
test('confirmed relationships are reused and new same-run admissions become bounded comparison hints',async()=>{
  const existing={id:'existing',title:'Alligator mitts',imageUrl:'https://example.invalid/existing.jpg'};
  const confirmed=editor(async()=>{throw Error('confirmed duplicate needs no model call');});
  const result=await confirmed.editor.reviewDiscovery([candidate],{catalog:[existing],verifiedDuplicates:{[candidate.id]:{
    duplicateOfId:existing.id,sourceFactsHash:editorialSourceHash(candidate),evidenceReference:'fixture/verified-design-review',
    reason:'The saved exact family review confirmed this same alligator design.'}}});
  assert.equal(result[0].decision,'reject');assert.equal(result[0].duplicateOfId,existing.id);
  const second={...candidate,id:'B000000002',imageUrl:'https://example.invalid/second.jpg'};
  const f=editor(async request=>{
    const data=JSON.parse(request.messages[1].content[0].text.split('\n').at(-1));
    return completion(data.id===candidate.id?decision:{...decision,id:second.id,decision:'reject',duplicateOfId:candidate.id,
      reason:'The second photograph shows the same already-admitted alligator design.'});
  });
  assert.deepEqual((await f.editor.reviewDiscovery([candidate,second])).map(p=>p.decision),['admit','reject']);
});
test('saved complete result survives a new editor instance without another model dispatch',async()=>{
  const store=storage();let calls=0;
  const first=editor(async()=>{calls++;return completion(decision);},store);
  await first.editor.reviewDiscovery([candidate]);
  const restarted=editor(async()=>{calls++;throw Error('forbidden replay');},store);
  assert.deepEqual(await restarted.editor.reviewDiscovery([candidate]),[decision]);assert.equal(calls,1);
});
test('unknown dispatch and failed result persistence never cause automatic paid retries',async()=>{
  const store=storage();let calls=0;
  const f=editor(async()=>{calls++;throw Error('private provider detail');},store);
  assert.equal((await f.editor.reviewDiscovery([candidate]))[0].decision,'defer');
  assert.equal((await f.editor.reviewDiscovery([candidate]))[0].decision,'defer');assert.equal(calls,1);
  const failed=storage();const put=failed.put;failed.put=async(key,value)=>{
    if(key.endsWith('-result'))throw Error('disk lost');return put(key,value);
  };
  const g=editor(async()=>{calls++;return completion(decision);},failed);
  await assert.rejects(g.editor.reviewDiscovery([candidate]),/editorial_storage_unconfirmed/);
  assert.equal((await g.editor.reviewDiscovery([candidate]))[0].decision,'defer');assert.equal(calls,2);
});
test('one unconfirmed visual review defers only that candidate and preserves unrelated saved judgments',async()=>{
  const second={...candidate,id:'B000000002',title:'Lobster oven mitts'};let calls=0;
  const f=editor(async request=>{calls++;if(request.messages[1].content[0].text.includes(second.id))return completion({...decision,id:second.id});
    throw Error('test only lost model response');});
  assert.deepEqual((await f.editor.reviewDiscovery([candidate,second])).map(p=>p.decision),['defer','admit']);
  assert.deepEqual((await f.editor.reviewDiscovery([candidate,second])).map(p=>p.decision),['defer','admit']);assert.equal(calls,2);
});
test('evidence identity rejection remains a hold across restart, unlike an unconfirmed external response',async()=>{
  const store=storage();let calls=0;
  for(let restart=0;restart<2;restart++){
    const stages=createEditorialStages({...store,now:()=>NOW});
    await assert.rejects(stages.run('embedding',{fixture:true},async()=>{calls++;throw Error('provider_evidence_embedding_input');}),/provider_evidence_embedding_input/);
  }
  assert.equal(calls,1);
});
test('an acknowledged result with a lost save response resolves from exact saved content',async()=>{
  const store=storage(),put=store.put;let calls=0,lost=false;
  store.put=async(key,value)=>{await put(key,value);if(key.endsWith('-result')&&!lost){lost=true;throw Error('lost ACK');}};
  const f=editor(async()=>{calls++;return completion(decision);},store);
  await assert.rejects(f.editor.reviewDiscovery([candidate]),/editorial_storage_unconfirmed/);
  assert.deepEqual(await f.editor.reviewDiscovery([candidate]),[decision]);assert.equal(calls,1);
});
test('journal read failure is explicit storage uncertainty, not permission to make another model call',async()=>{
  let calls=0;
  const stages=createEditorialStages({read:async()=>{throw Error('private storage failure');},put:async()=>{throw Error('not reached');}});
  const editor=createCatalogEditorial({stages,complete:async()=>{calls++;return completion(decision);}});
  await assert.rejects(editor.reviewDiscovery([candidate]),/editorial_storage_unconfirmed/);assert.equal(calls,0);
});
function homepage(){
  const candidates=Array.from({length:30},(_,i)=>({id:`p${i}`,title:`Gift ${i}`,description:'An original visual gag.',
    imageUrl:`https://example.invalid/${i}.jpg`,lanes:['rediscovery'],merchandising:{}}));
  return{day:'2026-11-06',previous:{schemaVersion:1,day:'2026-11-05',anchors:candidates.slice(0,6).map(p=>p.id),rotation:candidates.slice(6,24).map(p=>p.id)},candidates};
}
test('homepage selects only accepted candidate IDs and preserves weekly anchors absent a concrete replacement',async()=>{
  const brief=homepage(),choice={anchors:brief.previous.anchors,rotation:brief.candidates.slice(12,30).map(p=>p.id),anchorReplacements:[]};
  const f=editor(async request=>{
    assert.equal(request.messages[1].content.filter(c=>c.type==='image_url').length,30);return completion(choice);
  });
  const chosen=await f.editor.selectHomepage(brief);assert.deepEqual(chosen.anchors,brief.previous.anchors);
  const replacement={...choice,anchors:['p6',...choice.anchors.slice(1)]};
  assert.throws(()=>validateHomepageDecision(replacement,brief),/weekly_anchor_changed/);
  assert.equal(validateHomepageDecision({...replacement,anchorReplacements:[{id:'p0',reason:'The photograph shows a confusing promotional overlay.'}]},brief).anchors[0],'p6');
  assert.throws(()=>validateHomepageDecision({...choice,rotation:['foreign',...choice.rotation.slice(1)]},brief),/homepage_invalid/);
  assert.throws(()=>validateHomepageDecision({...choice,rotation:[...choice.anchors,...choice.rotation.slice(6)]},brief),/homepage_invalid/);
});
test('optional automated homepage failure preserves the prior edition without writing it',async()=>{
  const brief=homepage();let saves=0;
  const result=await automatedHomepage({db:{prepare(){throw Error('read unavailable');}},revision:'accepted',prior:brief.previous,
    day:brief.day,editor:{selectHomepage(){throw Error('not reached');}},save:async()=>{saves++;}});
  assert.deepEqual(result.edition,brief.previous);assert.equal(result.state,'last_good');assert.equal(saves,0);
});
test('homepage rejects only explicitly reviewed repeated designs, not categories or keywords',()=>{
  const brief=homepage(),choice={anchors:brief.previous.anchors,rotation:brief.previous.rotation,anchorReplacements:[]};
  brief.candidates[0].merchandising.variantGroup='reviewed-lobster-claw-mitts';
  brief.candidates[6].merchandising.variantGroup='reviewed-lobster-claw-mitts';
  assert.throws(()=>validateHomepageDecision(choice,brief),/repeated_design/);
  delete brief.candidates[6].merchandising.variantGroup;
  brief.candidates[6].title=brief.candidates[0].title;
  assert.deepEqual(validateHomepageDecision(choice,brief).anchors,choice.anchors);
});
