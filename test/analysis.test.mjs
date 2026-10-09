import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approx } from './helpers.mjs';
import { findAirTraps, autoOrient, sliceAreaProfile, pourModeFor } from '../src/core/analysis.js';
import { mat4ApplyPoint } from '../src/core/frame.js';

// tiny Grid-like object: voxel centre (i,j,k) = origin + h*[i,j,k]
function makeTestGrid(nx, ny, nz, h = 0.5, origin = [0, 0, 0]) {
  return { origin, h, nx, ny, nz, n: nx * ny * nz, occ: new Uint8Array(nx * ny * nz) };
}
function fill(g, i0, i1, j0, j1, k0, k1, v = 1) {
  for (let k = k0; k <= k1; k++)
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) g.occ[i + g.nx * (j + g.ny * k)] = v;
}
const zOf = (g, k) => g.origin[2] + g.h * k;

test('air traps: solid box reaching zTop has no traps', () => {
  const g = makeTestGrid(20, 20, 30);
  fill(g, 3, 16, 3, 16, 2, 27);
  assert.equal(findAirTraps(g.occ, g, { zTop: zOf(g, 27) }).length, 0);
  assert.equal(findAirTraps(g.occ, g).length, 0); // zTop defaults to the highest occupied layer
});

test('air traps: U-tube with a shorter closed right column -> exactly one trap at its top', () => {
  const g = makeTestGrid(24, 10, 44);
  fill(g, 2, 5, 3, 6, 2, 41); // left column reaches zTop
  fill(g, 14, 17, 3, 6, 2, 31); // right column stops lower
  fill(g, 2, 17, 3, 6, 2, 7); // bottom bar
  const traps = findAirTraps(g.occ, g, { zTop: zOf(g, 41), minDepth: 1.5 });
  assert.equal(traps.length, 1, JSON.stringify(traps));
  const t = traps[0];
  assert.ok(t.p[0] >= zOf(g, 14) - 1e-9 && t.p[0] <= zOf(g, 17) + 1e-9, `x ${t.p[0]}`);
  assert.ok(approx(t.p[2], zOf(g, 31), 1e-9), `z ${t.p[2]}`);
  assert.equal(t.k, 31);
  const expected = zOf(g, 31) - zOf(g, 7);
  assert.ok(Math.abs(t.depth - expected) <= 1.5 * g.h, `depth ${t.depth} vs ${expected}`);
  assert.equal(t.closed, false);
  // peak is the centre of the ceiling (i in 14..17 -> 15 or 16, j in 3..6 -> 4 or 5)
  assert.ok(t.i >= 15 && t.i <= 16 && t.j >= 4 && t.j <= 5);
});

test('air traps: ceiling bumps shallower than minDepth are ignored, deeper ones are found', () => {
  const g = makeTestGrid(30, 12, 30);
  fill(g, 2, 25, 2, 9, 2, 8); // slab
  fill(g, 24, 27, 2, 9, 2, 27); // riser to the opening
  // 1-voxel (0.5 mm) bumps on the slab ceiling
  for (const i of [4, 8, 12, 16]) fill(g, i, i, 5, 5, 9, 9);
  assert.equal(findAirTraps(g.occ, g, { zTop: zOf(g, 27), minDepth: 1.5 }).length, 0);
  // a 5-voxel (2.5 mm) blind hole up from the ceiling is a trap
  fill(g, 10, 11, 5, 6, 9, 13);
  const traps = findAirTraps(g.occ, g, { zTop: zOf(g, 27), minDepth: 1.5 });
  assert.equal(traps.length, 1);
  assert.equal(traps[0].k, 13);
  assert.ok(approx(traps[0].depth, 5 * g.h, 1e-9));
});

test('air traps: two separate closed pockets -> 2 traps (sorted by z desc)', () => {
  const g = makeTestGrid(30, 10, 30);
  fill(g, 2, 5, 2, 7, 0, 27); // open column
  fill(g, 10, 15, 2, 7, 5, 12); // closed pocket 1
  fill(g, 20, 26, 2, 7, 8, 18); // closed pocket 2 (higher)
  const traps = findAirTraps(g.occ, g, { zTop: zOf(g, 27) });
  assert.equal(traps.length, 2, JSON.stringify(traps));
  assert.ok(traps.every((t) => t.closed));
  assert.equal(traps[0].k, 18);
  assert.equal(traps[1].k, 12);
  assert.ok(approx(traps[0].depth, 10 * g.h, 1e-9));
});

test('air traps: nearby traps are merged (mergeDistance)', () => {
  const g = makeTestGrid(30, 10, 30);
  fill(g, 2, 25, 2, 7, 2, 8);
  fill(g, 24, 27, 2, 7, 2, 27);
  fill(g, 6, 6, 4, 4, 9, 16); // two thin blind holes 2 voxels apart
  fill(g, 8, 8, 4, 4, 9, 14);
  assert.equal(findAirTraps(g.occ, g, { zTop: zOf(g, 27), mergeDistance: 0.1 }).length, 2);
  const merged = findAirTraps(g.occ, g, { zTop: zOf(g, 27) }); // default 3h = 1.5 mm
  assert.equal(merged.length, 1);
  assert.equal(merged[0].k, 16); // keeps the highest
});

test('air traps: performance on a 4M-voxel grid', () => {
  const g = makeTestGrid(160, 160, 160);
  // wavy-ceiling cavity: column heights vary
  for (let j = 10; j < 150; j++)
    for (let i = 10; i < 150; i++) {
      const top = 100 + Math.round(8 * Math.sin(i / 7) * Math.cos(j / 9));
      for (let k = 10; k <= top; k++) g.occ[i + g.nx * (j + g.ny * k)] = 1;
    }
  fill(g, 148, 152, 70, 74, 10, 155); // riser
  const t0 = performance.now();
  const traps = findAirTraps(g.occ, g, { zTop: zOf(g, 155) });
  const dt = performance.now() - t0;
  assert.ok(traps.length > 3, `traps ${traps.length}`);
  assert.ok(dt < 5000, `took ${dt} ms`);
});

function rotPart(m) {
  return [[m[0], m[4], m[8]], [m[1], m[5], m[9]], [m[2], m[6], m[10]]];
}
function det3(R) {
  return R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
}
function applyDir(m, v) {
  return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2], m[1] * v[0] + m[5] * v[1] + m[9] * v[2], m[2] * v[0] + m[6] * v[1] + m[10] * v[2]];
}
// manifold.rotate([x,y,0]) = Ry * Rx
function eulerXY(v, ax, ay) {
  const a = (ax * Math.PI) / 180, b = (ay * Math.PI) / 180;
  const r = [v[0], v[1] * Math.cos(a) - v[2] * Math.sin(a), v[1] * Math.sin(a) + v[2] * Math.cos(a)];
  return [r[0] * Math.cos(b) + r[2] * Math.sin(b), r[1], -r[0] * Math.sin(b) + r[2] * Math.cos(b)];
}

test('autoOrient: tilted cylinder -> long axis to Z, proper rotation, bbox placed', async () => {
  const { Manifold } = await setup();
  const cyl = Manifold.cylinder(80, 8, 8, 48, true).rotate([30, 40, 0]).translate([12, -7, 33]);
  const { matrix, info } = autoOrient(cyl);
  assert.ok(approx(det3(rotPart(matrix)), 1, 1e-9));
  const axis = eulerXY([0, 0, 1], 30, 40);
  const mapped = applyDir(matrix, axis);
  assert.ok(Math.abs(mapped[2]) > 0.99, `mapped axis ${mapped}`);
  assert.ok(Math.abs(axis[0] * info.longAxis[0] + axis[1] * info.longAxis[1] + axis[2] * info.longAxis[2]) > 0.99);
  const b = cyl.transform(matrix).boundingBox();
  assert.ok(approx(b.min[2], 0, 1e-6));
  assert.ok(approx(b.min[0] + b.max[0], 0, 1e-6) && approx(b.min[1] + b.max[1], 0, 1e-6));
  assert.ok(approx(b.max[2], 80, 0.5), `height ${b.max[2]}`);
});

test('autoOrient: cone -> wide end up (+Z)', async () => {
  const { Manifold } = await setup();
  for (const rot of [[0, 0, 0], [120, 25, 10], [180, 0, 0]]) {
    const cone = Manifold.cylinder(80, 15, 1.5, 48).rotate(rot);
    const { matrix, info } = autoOrient(cone);
    assert.ok(approx(det3(rotPart(matrix)), 1, 1e-9));
    const m = cone.transform(matrix);
    const b = m.boundingBox();
    const H = b.max[2] - b.min[2];
    assert.ok(approx(H, 80, 0.5), `H ${H} rot ${rot}`);
    const top = m.slice(b.max[2] - 0.1 * H).area(), bot = m.slice(b.min[2] + 0.1 * H).area();
    assert.ok(top > bot * 2, `top ${top} bottom ${bot} rot ${rot} info ${JSON.stringify(info)}`);
  }
});

test('autoOrient: 100x30x10 box -> x 30, y 10, z 100', async () => {
  const { Manifold } = await setup();
  for (const rot of [[0, 0, 0], [10, 70, 35]]) {
    const bx = Manifold.cube([100, 30, 10], true).rotate(rot);
    const { matrix, info } = autoOrient(bx);
    assert.ok(approx(det3(rotPart(matrix)), 1, 1e-9));
    const b = bx.transform(matrix).boundingBox();
    const ext = [0, 1, 2].map((i) => b.max[i] - b.min[i]);
    assert.ok(approx(ext[0], 30, 0.05) && approx(ext[1], 10, 0.05) && approx(ext[2], 100, 0.05), `ext ${ext} rot ${rot}`);
    assert.ok(approx(info.silhouetteArea, 3000, 1));
    const p = mat4ApplyPoint(matrix, [0, 0, 0]);
    assert.ok(approx(p[0], 0, 1e-6) && approx(p[1], 0, 1e-6) && approx(p[2], 50, 1e-6));
  }
});

test('sliceAreaProfile and pourModeFor', async () => {
  const { Manifold } = await setup();
  const prof = sliceAreaProfile(Manifold.cube([10, 20, 30]), 24);
  assert.equal(prof.length, 24);
  assert.ok(prof.every((s) => approx(s.area, 200, 1e-6)));
  assert.ok(approx(prof[0].z, 30 / 48, 1e-9));
  // candle base up (flat top) -> extend; cone tip up -> sprue; sphere -> sprue
  assert.equal(pourModeFor(Manifold.cylinder(80, 1.5, 10, 48)), 'extend');
  assert.equal(pourModeFor(Manifold.cylinder(80, 10, 1.0, 48)), 'sprue');
  assert.equal(pourModeFor(Manifold.sphere(10, 48)), 'sprue');
  assert.equal(pourModeFor(Manifold.cube([10, 10, 10])), 'extend');
});
