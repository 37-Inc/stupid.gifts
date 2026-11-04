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
const module={exports:{}},require=createRequire(new URL('../static-site/components/RandomSelection.tsx',import.meta.url));
const source=fs.readFileSync(new URL('../static-site/components/RandomSelection.tsx',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,jsx:ts.JsxEmit.ReactJSX}});
vm.runInNewContext(compiled.outputText,{module,exports:module.exports,require:name=>name==='./ProductCard'
  ?{ProductCard:({product})=>React.createElement('article',{'data-product':product.id},product.title)}
  :name==='./Icon'?{Icon}:require(name)});
const {RandomSelection}=module.exports;
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
