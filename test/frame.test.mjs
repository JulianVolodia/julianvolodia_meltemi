import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { planeExtrude, planeSlice, trimSide, rod, rect2 } from '../src/core/frame.js';

test('frame helpers: plane extrude / slice / trim / rod', async () => {
  const { Manifold } = await setup();
  const s = planeExtrude(rect2(5, 100, 15, 120), -1, 2);
  const b = s.boundingBox();
  assert.deepEqual([...b.min], [5, -1, 100]);
  assert.deepEqual([...b.max], [15, 2, 120]);
  assert.equal(Math.round(planeSlice(s, 0.5).area()), 200);
  const c = Manifold.cube([10, 10, 10], true);
  assert.equal(Math.round(trimSide(c, 'A', 0).boundingBox().max[1]), 0);
  assert.equal(Math.round(trimSide(c, 'B', 0).boundingBox().min[1]), 0);
  const r = rod([0, 0, 0], [10, 0, 0], 1);
  assert.ok(Math.abs(r.boundingBox().max[0] - 10) < 1e-6);
});
