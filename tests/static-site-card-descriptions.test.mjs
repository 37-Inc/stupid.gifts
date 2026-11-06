import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import React from 'react';
import copy from '../content/catalog-presentation.json' with {type:'json'};
import {productPresentation} from '../lib/catalog/presentation.ts';
import {CatalogDescription} from '../static-site/components/CatalogPhotos.tsx';
globalThis.React=React;

test('all retained presentation corrections are bound to the actual original title/copy',()=>{
  assert.equal(Object.keys(copy).length,1036);
  for(const [id,note]of Object.entries(copy)){
    assert.match(id,/^[A-Z0-9]{10}$/);assert.ok(note.sourceTitle.trim()&&note.sourceCopy.trim()&&note.description.trim());
    assert.notEqual(note.description,'A strange little catalog find.');
  }
  for(const id of ['B0BQ9LZNXN','B0F45GMFH3','B0F912SZ4M'])assert.equal(copy[id],undefined);
});
test('card and detail render the SAME normalized short copy, without context overlays',()=>{
  const [id,note]=Object.entries(copy)[0];
  const product=productPresentation({id,source:'amazon',title:note.sourceTitle,description:note.sourceCopy});
  for(const card of [true,false]){
    const html=renderToStaticMarkup(React.createElement(CatalogDescription,{id,source:'amazon',title:product.title,fallback:product.description,card}));
    assert.ok(!html.includes('A strange little catalog find.'));
    assert.ok(html.includes(card?'card-description':'detail-line'));
  }
});
