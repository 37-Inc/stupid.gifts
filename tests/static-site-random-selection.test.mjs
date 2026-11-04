import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Icon} from '../static-site/components/Icon.tsx';
import {projectCard} from '../static-site/lib/card-shard.ts';

globalThis.React=React;
const commonJs={exports:{}},require=createRequire(new URL('../static-site/components/RandomSelection.tsx',import.meta.url));
const source=fs.readFileSync(new URL('../static-site/components/RandomSelection.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}});
vm.runInNewContext(compiled.outputText,{module:commonJs,exports:commonJs.exports,require:name=>name==='./ProductCard'
  ?{ProductCard:({product})=>React.createElement('article',{'data-product':product.id},product.title)}
  :name==='./Icon'?{Icon}:require(name)});
const {RandomSelection}=commonJs.exports;
const fixture=JSON.parse(fs.readFileSync(new URL('../static-site/fixtures/catalog.snapshot.json',import.meta.url)));
test('random action uses the existing decorative dice glyph without the redundant no-repeat sentence',()=>{
  const initial=projectCard(fixture.products[0]);
  const html=renderToStaticMarkup(React.createElement(RandomSelection,{initial,poolSize:1,
    poolPath:'/fixture/random.json',catalogRevision:fixture.catalogRevision,version:'a'.repeat(64)}));
  assert.doesNotMatch(html,/No repeat on the next spin/);
  const button=html.match(/<button\b[^>]*>(.*?)<\/button>/s)?.[1];
  assert.match(button,/<svg[^>]*aria-hidden="true"[^>]*focusable="false"/);
  assert.match(button,/Show me another gift/);
  assert.doesNotMatch(button,/\p{Extended_Pictographic}/u);
});
test('pre-rendered entry shows a neutral loading state, with the static gift only in the no-JS fallback',()=>{
  const initial=projectCard(fixture.products[0]);
  const html=renderToStaticMarkup(React.createElement(RandomSelection,{initial,poolSize:48,
    poolPath:'/fixture/random.json',catalogRevision:fixture.catalogRevision,version:'a'.repeat(64)}));
  assert.match(html,/role="status"/);assert.match(html,/Choosing a gift/);
  assert.match(html,/<noscript>.*data-product="fixture-paperweight".*<\/noscript>/s);
  assert.doesNotMatch(html.replace(/<noscript>.*?<\/noscript>/gs,''),/data-product=/);
});

function client(){
  const choices=fixture.products.slice(0,2).map(p=>({...projectCard(p),eligibleUntil:null}));
  const values=[],effects=[],requests=[];let cursor=0,pending=[];
  const element=(type,props)=>({type,props});
  const react={useState(initial){const i=cursor++;if(!(i in values))values[i]=initial;
    return[values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v;}];},
    useRef(initial){const i=cursor++;if(!(i in values))values[i]={current:initial};return values[i];},
    useEffect(fn,deps){const i=cursor++,old=effects[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n])))pending.push({i,fn,deps});}};
  const cjs={exports:{}};
  vm.runInNewContext(compiled.outputText,{module:cjs,exports:cjs.exports,AbortController,
    sessionStorage:{getItem:()=>choices[0].id,setItem(){}},
    require:name=>name==='react'?react:name==='react/jsx-runtime'?{jsx:element,jsxs:element,Fragment:'fragment'}
      :name==='./ProductCard'?{ProductCard:'product'}:name==='./Icon'?{Icon:'icon'}
      :name==='../lib/analytics'?{captureRenderedLists(){},captureStaticRandomSpin(){}}
      :name==='../lib/card-shard'?{fetchCardShard:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))}:require(name)});
  return{choices,requests,render(){cursor=0;pending=[];
    const view=cjs.exports.RandomSelection({initial:choices[0],poolSize:2,poolPath:'/fixture/random.json',
      catalogRevision:fixture.catalogRevision,version:'a'.repeat(64)});
    for(const {i,fn,deps} of pending){effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};}
    return view;}};
}
function nodes(view,type){
  if(!view||typeof view!=='object')return[];
  if(Array.isArray(view))return view.flatMap(v=>nodes(v,type));
  if(view.type==='noscript')return[];
  return[...(view.type===type?[view]:[]),...nodes(view.props?.children,type)];
}
const flush=()=>new Promise(setImmediate);
test('entry never renders the fallback before selection; later spins reuse the pool without repeating',async()=>{
  const c=client(),initial=c.render();
  assert.equal(nodes(initial,'product').length,0);assert.equal(c.requests.length,1);
  c.requests[0].resolve({products:c.choices});await flush();
  const ready=c.render();assert.equal(nodes(ready,'product')[0].props.product.id,c.choices[1].id);
  await nodes(ready,'button')[0].props.onClick();
  assert.equal(nodes(c.render(),'product')[0].props.product.id,c.choices[0].id);
  assert.equal(c.requests.length,1,'on-page spins keep using the already loaded pool');
});
test('failed initial loading restores the usable static gift and allows another attempt',async()=>{
  const c=client();c.render();c.requests[0].reject(Error('synthetic unavailable'));await flush();
  const fallback=c.render();assert.equal(nodes(fallback,'product')[0].props.product.id,c.choices[0].id);
  assert.equal(nodes(fallback,'button')[0].props.disabled,false);
  const retry=nodes(fallback,'button')[0].props.onClick();
  assert.equal(nodes(c.render(),'product').length,0);assert.equal(c.requests.length,2);
  c.requests[1].resolve({products:c.choices});await retry;
  assert.equal(nodes(c.render(),'product')[0].props.product.id,c.choices[1].id);
});
