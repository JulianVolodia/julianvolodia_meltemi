import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import {
  Grid, gridForBox, voxelize, voxelizeManifold, signedDistance, sweepMin, addScalar, minFields, maxFields,
  makeSampler, levelSetSolid, occupancyVolume, fieldVolume,
} from '../src/core/sdf.js';
import { meshFromManifold } from '../src/core/meshio.js';

const sphereVol = (r) => (4 / 3) * Math.PI * r ** 3;
const relErr = (a, b) => Math.abs(a - b) / Math.abs(b);

test('Grid / gridForBox basics', () => {
  const g = new Grid([1, 2, 3], 0.5, 4, 5, 6);
  assert.equal(g.n, 120);
  assert.equal(g.index(1, 2, 3), 1 + 4 * (2 + 5 * 3));
  assert.deepEqual(g.point(2, 0, 4), [2, 2, 5]);
  assert.deepEqual(g.bounds(), { min: [1, 2, 3], max: [2.5, 4, 5.5] });

  const gb = gridForBox([-10, -5, 0], [10, 5, 40], 3, { maxVoxels: 1e5, minVoxel: 0.1 });
  const vol = 26 * 16 * 46;
  assert.ok(Math.abs(gb.h - Math.cbrt(vol / 1e5)) < 1e-12);
  const b = gb.bounds();
  for (let a = 0; a < 3; a++) {
    assert.ok(b.min[a] <= [-13, -8, -3][a] - 2 * gb.h + 1e-9, `min covers axis ${a}`);
    assert.ok(b.max[a] >= [13, 8, 43][a] + 2 * gb.h - 1e-9, `max covers axis ${a}`);
  }
  assert.ok(gb.n < 1.6e5, `voxel budget ~respected incl. padding (${gb.n})`);
  const gm = gridForBox([0, 0, 0], [1, 1, 1], 0, { maxVoxels: 1e9, minVoxel: 0.4 });
  assert.equal(gm.h, 0.4);
});

test('sphere r=10: occupancy volume, signed distance, offset level set', async () => {
  const { Manifold } = await setup();
  const mesh = meshFromManifold(Manifold.sphere(10, 96));
  const grid = gridForBox([-10, -10, -10], [10, 10, 10], 8, { maxVoxels: 1e9, minVoxel: 0.5 });
  assert.equal(grid.h, 0.5);
  let t = performance.now();
  const occ = voxelize(mesh, grid);
  const tVox = performance.now() - t;
  const vOcc = occupancyVolume(occ, grid);
  assert.ok(relErr(vOcc, sphereVol(10)) < 0.03, `occupancy volume ${vOcc.toFixed(1)}`);

  t = performance.now();
  const phi = signedDistance(occ, grid);
  const tEdt = performance.now() - t;
  const s = makeSampler(phi, grid);
  const h = grid.h;
  assert.ok(Math.abs(s([0, 0, 0]) + 10) <= h, `phi(centre) = ${s([0, 0, 0])}`);
  assert.ok(Math.abs(s([15, 0, 0]) - 5) <= h, `phi(15,0,0) = ${s([15, 0, 0])}`);
  assert.ok(Math.abs(s([0, 0, -15]) - 5) <= h, `phi(0,0,-15) = ${s([0, 0, -15])}`);
  const d = 15 / Math.sqrt(3);
  assert.ok(Math.abs(s([d, -d, d]) - 5) <= h, `phi(diag 15) = ${s([d, -d, d])}`);
  assert.ok(Math.abs(s([0, 5, 0]) + 5) <= h, `phi(0,5,0) = ${s([0, 5, 0])}`);
  assert.equal(s([1000, 0, 0]), 1e6, 'outside the grid -> 1e6');
  // fieldVolume at 0 ~ sphere volume; at level 3 ~ r=13 (clipped by the grid only near 18 mm)
  assert.ok(relErr(fieldVolume(phi, grid, 0), sphereVol(10)) < 0.03);
  assert.ok(relErr(fieldVolume(phi, grid, 3), sphereVol(13)) < 0.05);

  t = performance.now();
  const off = levelSetSolid(phi, grid, { level: 3 });
  const tLs3 = performance.now() - t;
  assert.equal(off.status(), 'NoError');
  assert.ok(relErr(off.volume(), sphereVol(13)) < 0.05, `offset volume ${off.volume().toFixed(1)} vs ${sphereVol(13).toFixed(1)}`);
  const bb = off.boundingBox();
  assert.ok(Math.abs(bb.max[0] - 13) < 2 * h && Math.abs(bb.min[2] + 13) < 2 * h);

  t = performance.now();
  const base = levelSetSolid(phi, grid, { level: 0, edgeLength: 0.5 });
  const tLs0 = performance.now() - t;
  assert.ok(relErr(base.volume(), sphereVol(10)) < 0.03, `level-0 volume ${base.volume().toFixed(1)}`);
  // explicit full-grid bounds give the same solid
  t = performance.now();
  const full = levelSetSolid(phi, grid, { level: 0, edgeLength: 0.5, bounds: grid.bounds() });
  const tLsFull = performance.now() - t;
  assert.ok(relErr(full.volume(), base.volume()) < 0.01);
  assert.equal(levelSetSolid(phi, grid, { level: -20 }), null, 'empty region -> null');
  console.log(
    `[sdf] sphere r=10 grid ${grid.nx}x${grid.ny}x${grid.nz} (${(grid.n / 1e6).toFixed(2)} M voxels, h=${h}): ` +
    `voxelize ${tVox.toFixed(0)} ms, EDT ${tEdt.toFixed(0)} ms, levelSet(level 3) ${tLs3.toFixed(0)} ms, ` +
    `levelSet(level 0, edge 0.5) ${tLs0.toFixed(0)} ms [${base.numTri()} tris], same with full-grid bounds ${tLsFull.toFixed(0)} ms`,
  );
});

test('exact-surface SDF vs occupancy-only estimate (sphere r=10, h=0.5)', async () => {
  const { Manifold } = await setup();
  const R = 10;
  const mesh = meshFromManifold(Manifold.sphere(R, 256));
  const grid = gridForBox([-R, -R, -R], [R, R, R], 6, { maxVoxels: 1e9, minVoxel: 0.5 });
  const occ = voxelize(mesh, grid);
  assert.ok(occ.source, 'voxelize attaches its source mesh');
  const stats = (phi) => {
    const s = makeSampler(phi, grid);
    let seed = 7, sum = 0, max = 0, bias = 0, cnt = 0;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let q = 0; q < 50000; q++) {
      const p = [(rnd() * 2 - 1) * (R + 5), (rnd() * 2 - 1) * (R + 5), (rnd() * 2 - 1) * (R + 5)];
      const r = Math.hypot(p[0], p[1], p[2]);
      if (r < 2) continue; // skip the medial-axis cusp at the centre
      const e = s(p) - (r - R);
      sum += Math.abs(e); max = Math.max(max, Math.abs(e)); bias += e; cnt++;
    }
    return { mean: sum / cnt, max, bias: bias / cnt };
  };
  const ex = stats(signedDistance(occ, grid));
  const est = stats(signedDistance(occ, grid, { exact: false }));
  // a copied occupancy has no source -> estimate path, identical to exact:false
  const copy = signedDistance(Uint8Array.from(occ), grid);
  const est2 = stats(copy);
  console.log(`[sdf] |phi err| exact: mean ${ex.mean.toFixed(3)} max ${ex.max.toFixed(3)} bias ${ex.bias.toFixed(3)}; ` +
    `estimate: mean ${est.mean.toFixed(3)} max ${est.max.toFixed(3)} bias ${est.bias.toFixed(3)} (h=${grid.h})`);
  assert.ok(ex.mean < 0.15 * grid.h && ex.max < 0.6 * grid.h);
  assert.ok(est.mean < 0.5 * grid.h && est.max < grid.h);
  assert.ok(ex.mean < est.mean);
  assert.equal(est2.mean, est.mean);
  // an edited occupancy (same object, count changed) must not use the stale mesh
  const edited = voxelize(mesh, grid);
  edited[grid.index(1, 1, 1)] = 1; // stray voxel far from the sphere
  const phiE = signedDistance(edited, grid);
  assert.ok(phiE[grid.index(1, 1, 1)] < 0 && phiE[grid.index(3, 1, 1)] > 0 && phiE[grid.index(3, 1, 1)] <= 1.5 * grid.h + 1e-6);
});

test('EDT is exact against brute force on a random occupancy', () => {
  const grid = new Grid([0, 0, 0], 0.7, 11, 9, 7);
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const occ = new Uint8Array(grid.n);
  for (let v = 0; v < grid.n; v++) occ[v] = rnd() < 0.08 ? 1 : 0;
  const phi = signedDistance(occ, grid);
  const { nx, ny, nz, h } = grid;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const v = grid.index(i, j, k);
    let best = Infinity;
    for (let kk = 0; kk < nz; kk++) for (let jj = 0; jj < ny; jj++) for (let ii = 0; ii < nx; ii++) {
      if (occ[grid.index(ii, jj, kk)] === occ[v]) continue;
      const d2 = (ii - i) ** 2 + (jj - j) ** 2 + (kk - k) ** 2;
      if (d2 < best) best = d2;
    }
    const expect = occ[v] ? -(Math.sqrt(best) * h - h / 2) : Math.sqrt(best) * h - h / 2;
    assert.ok(Math.abs(phi[v] - expect) < 1e-4, `voxel ${i},${j},${k}: ${phi[v]} vs ${expect}`);
  }
  // empty occupancy -> +1e6 everywhere
  const empty = signedDistance(new Uint8Array(grid.n), grid);
  assert.ok(empty.every((x) => x === 1e6));
});

test('sweepMin prefix / suffix semantics and pointwise field ops', () => {
  const grid = new Grid([0, 0, 0], 1, 3, 4, 5);
  const phi = new Float32Array(grid.n);
  for (let v = 0; v < grid.n; v++) phi[v] = ((v * 37) % 23) - 11;
  for (const axis of [0, 1, 2]) {
    for (const dir of [1, -1]) {
      const out = sweepMin(phi, grid, axis, dir);
      for (let k = 0; k < grid.nz; k++) for (let j = 0; j < grid.ny; j++) for (let i = 0; i < grid.nx; i++) {
        const c = [i, j, k];
        const len = [grid.nx, grid.ny, grid.nz][axis];
        let m = Infinity;
        const [from, to] = dir > 0 ? [0, c[axis]] : [c[axis], len - 1];
        for (let t = from; t <= to; t++) {
          const q = c.slice();
          q[axis] = t;
          m = Math.min(m, phi[grid.index(q[0], q[1], q[2])]);
        }
        assert.equal(out[grid.index(i, j, k)], m, `axis ${axis} dir ${dir} at ${c}`);
      }
    }
  }
  // tiny explicit example along x: [3, 1, 2]
  const g1 = new Grid([0, 0, 0], 1, 3, 1, 1);
  assert.deepEqual([...sweepMin(Float32Array.from([3, 1, 2]), g1, 0, 1)], [3, 1, 1]);
  assert.deepEqual([...sweepMin(Float32Array.from([3, 1, 2]), g1, 0, -1)], [1, 1, 2]);
  assert.deepEqual([...addScalar(Float32Array.from([1, 2]), -0.5)], [0.5, 1.5]);
  assert.deepEqual([...minFields(Float32Array.from([1, 5]), Float32Array.from([2, 3]))], [1, 3]);
  assert.deepEqual([...maxFields(Float32Array.from([1, 5]), Float32Array.from([2, 3]))], [2, 5]);
});

test('box voxel volume, box distances, xyz voting agrees', async () => {
  const { Manifold } = await setup();
  const box = Manifold.cube([10, 20, 30]).translate([0.123, -7.31, 2.77]);
  const bb = box.boundingBox();
  const grid = gridForBox(bb.min, bb.max, 4, { maxVoxels: 1e9, minVoxel: 0.5 });
  const occ = voxelizeManifold(box, grid);
  assert.ok(relErr(occupancyVolume(occ, grid), 6000) < 0.03, `box voxel volume ${occupancyVolume(occ, grid)}`);
  const occ3 = voxelize(meshFromManifold(box), grid, { axes: 'xyz' });
  let diff = 0;
  for (let v = 0; v < grid.n; v++) diff += occ[v] !== occ3[v] ? 1 : 0;
  assert.equal(diff, 0, 'xyz voting equals z scan on a closed mesh');
  const phi = signedDistance(occ, grid);
  const s = makeSampler(phi, grid);
  const c = [0.123 + 5, -7.31 + 10, 2.77 + 15];
  assert.ok(Math.abs(s(c) + 5) <= grid.h, `phi(box centre) ${s(c)}`);
  assert.ok(Math.abs(s([c[0] + 8, c[1], c[2]]) - 3) <= grid.h, `phi(3 mm off +x face) ${s([c[0] + 8, c[1], c[2]])}`);
  // swept cavity semantics: prefix-min along y of the box field reaches y -> grid min
  const swept = sweepMin(phi, grid, 1, 1);
  const ss = makeSampler(swept, grid);
  assert.ok(ss([c[0], grid.bounds().max[1] - 0.01, c[2]]) < 0, 'prefix-min sweep extends to +y bound');
  assert.ok(ss([c[0], bb.min[1] - 2, c[2]]) > 1.5, 'nothing swept toward -y');
});

test('overlapping shells and inverted mesh use non-zero winding; open mesh is voted', async () => {
  const { Manifold } = await setup();
  const a = meshFromManifold(Manifold.cube([10, 10, 10]));
  const b = meshFromManifold(Manifold.cube([10, 10, 10]).translate([5, 0, 0]));
  // concatenated (not unioned) overlapping cubes -> union volume 1500
  const pos = new Float32Array([...a.positions, ...b.positions]);
  const idx = new Uint32Array([...a.indices, ...[...b.indices].map((i) => i + a.positions.length / 3)]);
  const grid = gridForBox([0, 0, 0], [15, 10, 10], 1, { maxVoxels: 1e9, minVoxel: 0.25 });
  assert.ok(relErr(occupancyVolume(voxelize({ positions: pos, indices: idx }, grid), grid), 1500) < 0.03);
  // inverted cube
  const inv = Uint32Array.from(a.indices);
  for (let t = 0; t < inv.length; t += 3) [inv[t + 1], inv[t + 2]] = [inv[t + 2], inv[t + 1]];
  assert.ok(relErr(occupancyVolume(voxelize({ positions: a.positions, indices: inv }, grid), grid), 1000) < 0.03);
  // open cube (one triangle removed): 'z' parity loses the columns under the hole, auto/xyz recover
  const open = { positions: a.positions, indices: a.indices.slice(3) };
  const vz = occupancyVolume(voxelize(open, grid, { axes: 'z' }), grid);
  const vAuto = occupancyVolume(voxelize(open, grid), grid);
  assert.ok(vz <= 1000 * 1.03);
  assert.ok(relErr(vAuto, 1000) < 0.03, `auto-voted open cube volume ${vAuto}`);
});

test('voxelize speed: ~200k-triangle sphere at 2-4 M voxels', async () => {
  const { Manifold } = await setup();
  const sph = Manifold.sphere(20, 640);
  const mesh = meshFromManifold(sph);
  const nTri = mesh.indices.length / 3;
  assert.ok(nTri >= 2e5, `triangles ${nTri}`);
  const grid = gridForBox([-20, -20, -20], [20, 20, 20], 2, { maxVoxels: 3e6, minVoxel: 0.05 });
  assert.ok(grid.n >= 2e6 && grid.n <= 4e6, `voxels ${grid.n}`);
  let t = performance.now();
  const occ = voxelize(mesh, grid);
  const tVox = performance.now() - t;
  t = performance.now();
  const phi = signedDistance(occ, grid);
  const tEdt = performance.now() - t;
  t = performance.now();
  const sw = sweepMin(phi, grid, 1, 1);
  const tSweep = performance.now() - t;
  t = performance.now();
  const s = makeSampler(phi, grid);
  let acc = 0;
  for (let q = 0; q < 1e6; q++) acc += s([((q % 97) / 97) * 40 - 20, ((q % 89) / 89) * 40 - 20, ((q % 83) / 83) * 40 - 20]);
  const tSamp = performance.now() - t;
  assert.ok(Number.isFinite(acc) && sw.length === grid.n);
  assert.ok(relErr(occupancyVolume(occ, grid), sphereVol(20)) < 0.02);
  console.log(
    `[sdf] ${nTri} tris -> ${(grid.n / 1e6).toFixed(2)} M voxels (h=${grid.h.toFixed(3)}): voxelize ${tVox.toFixed(0)} ms, ` +
    `EDT ${tEdt.toFixed(0)} ms, sweepMin ${tSweep.toFixed(0)} ms, 1 M samples ${tSamp.toFixed(0)} ms`,
  );
  assert.ok(tVox < 10000, `voxelize took ${tVox} ms`);
});
