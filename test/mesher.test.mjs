import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { gridForBox, voxelizeManifold, signedDistance, sweepMin } from '../src/core/sdf.js';
import { isoSurfaceSolid } from '../src/core/mesher.js';

test('mesher: sphere offsets are closed manifolds with the right volume', async () => {
  const { Manifold } = await setup();
  const sph = Manifold.sphere(10, 96);
  const g = gridForBox([-10, -10, -10], [10, 10, 10], 6, { maxVoxels: 1e6, minVoxel: 0.3 });
  const phi = signedDistance(voxelizeManifold(sph, g), g);
  for (const level of [0, 3]) {
    const m = isoSurfaceSolid(phi, g, { level, simplify: 0 });
    const R = 10 + level, exp = (4 / 3) * Math.PI * R ** 3;
    assert.equal(m.status(), 'NoError');
    assert.equal(m.genus(), 0);
    assert.ok(Math.abs(m.volume() - exp) / exp < 0.03, `volume ${m.volume()} vs ${exp}`);
  }
});

test('mesher: swept field touching the grid boundary is closed at the bounds', async () => {
  const { Manifold } = await setup();
  const c = Manifold.cylinder(30, 8, 8, 64);
  const g = gridForBox([-8, -8, 0], [8, 8, 30], 4, { maxVoxels: 5e5, minVoxel: 0.4 });
  const phi = sweepMin(signedDistance(voxelizeManifold(c, g), g), g, 1, +1);
  const m = isoSurfaceSolid(phi, g, { level: 0 });
  assert.equal(m.status(), 'NoError');
  const b = m.boundingBox();
  assert.ok(b.max[1] >= g.bounds().max[1] - 1e-6, 'extends to the grid face');
  assert.ok(b.min[1] < -7, 'starts at the cylinder');
  const half = m.trimByPlane([0, 1, 0], 0);
  assert.ok(half.volume() > 0);
});

test('mesher: bounds restrict and close the surface', async () => {
  const { Manifold } = await setup();
  const sph = Manifold.sphere(10, 64);
  const g = gridForBox([-10, -10, -10], [10, 10, 10], 4, { maxVoxels: 5e5, minVoxel: 0.4 });
  const phi = signedDistance(voxelizeManifold(sph, g), g);
  const m = isoSurfaceSolid(phi, g, { bounds: { min: [-20, -20, -20], max: [20, 0, 20] } });
  assert.equal(m.status(), 'NoError');
  assert.ok(m.boundingBox().max[1] <= 0.5);
  assert.ok(Math.abs(m.volume() - (2 / 3) * Math.PI * 1000) / ((2 / 3) * Math.PI * 1000) < 0.05);
});
