import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,profileReaders} from './helpers/catalog-publication-read-fixture.mjs';
import * as api from '../scripts/catalog/export-d1-snapshot.ts';

test('catalog-size reads preserve every row and invalidate proof on source or ownership changes',async t=>{
  const f=fixture();t.after(()=>f.sql.close());
  const measured=await profileReaders(f,api);
  assert.equal(measured.products,3185);assert.ok(measured.projectionTrips<=17);
  assert.equal(measured.digest,'e10c5717f425f9c5e4b831591dd0b9a3e873feb3f3e680eb02edb683b7f902f5','same catalog bytes as the previous reader');
  assert.equal(measured.repeatSourceTrips,2);
  assert.equal(measured.repeatCaptureTrips,3);
  const verify=(rows=f.rows)=>api.assertPruningCurrent(f.db,f.owner,rows);
  await assert.rejects(verify([{...f.rows[0],public_display_json:'wrong'},...f.rows.slice(1)]));
  f.sql.exec('UPDATE catalog_mutation_scopes SET external_pending=1');await assert.rejects(verify());
  f.sql.exec('UPDATE catalog_mutation_scopes SET external_pending=0,mutation_epoch=1');await assert.rejects(verify());
  f.owner.epoch=1;await verify();
  f.sql.prepare("UPDATE products SET public_display_json='changed' WHERE public_id=?").run(f.ids[0]);
  await assert.rejects(verify());
  const fresh=await api.readApprovedRevisionSource(f.db,f.owner,f.rows.map(r=>r.public_id),[]);
  assert.equal(fresh[0].public_display_json,'changed');
  f.sql.exec('DROP TRIGGER catalog_source_products_update');await assert.rejects(verify());
  f.sql.prepare('UPDATE products SET public_display_json=? WHERE public_id=?').run(f.rows[0].public_display_json,f.ids[0]);
  const before=f.trips();await verify();assert.ok(f.trips()-before>2,'missing migration always reads the actual rows');
});
