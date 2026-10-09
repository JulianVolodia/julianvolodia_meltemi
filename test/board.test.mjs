// Parting board, key ring, ribs and windows on a synthetic context (no SDF pipeline).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approx } from './helpers.mjs';
import { resolveParams } from '../src/core/params.js';
import {
  planeExtrude, planeSlice, trimSide, trimZ, rect2, pointInPolygons, mat4ApplyPoint,
} from '../src/core/frame.js';
import { buildRibs, ribPositions } from '../src/core/features/ribs.js';
import { cutWindows } from '../src/core/features/windows.js';
import { keyRing2D, buildBoards } from '../src/core/features/board.js';

const y0 = 0, d1 = 5, w = 2.4, zTop = 62, zFloor = -7.4;

/** Synthetic mold context around a vertical cylinder "candle" r=10, z 0..60. */
function makeCtx(Manifold, params = {}) {
  const P = resolveParams(params);
  const tf = P.flangeThickness;
  const master = Manifold.cylinder(60, 10, 10, 64);
  const pour = Manifold.cylinder(zTop + 1 - 59.5, 10, 10, 64).translate([0, 0, 59.5]);
  const Mp = master.add(pour);
  const cav = Manifold.cylinder(80, 10 + d1, 10 + d1, 64).translate([0, 0, -5]);
  const outer = Manifold.cylinder(70 - zFloor, 10 + d1 + w, 10 + d1 + w, 64).translate([0, 0, zFloor]);
  const clipZ = rect2(-1e3, zFloor, 1e3, zTop);
  const outline2D = planeSlice(outer, y0).intersect(clipZ);
  const flange2D = outline2D.hull().offset(P.flangeWidth, 'Round').intersect(clipZ);
  const shell = (side) => {
    const body = trimZ(trimSide(outer, side, y0), zFloor, zTop).subtract(cav);
    const plate = (side === 'A' ? planeExtrude(flange2D, y0 - tf, y0) : planeExtrude(flange2D, y0, y0 + tf)).subtract(cav);
    return body.add(plate);
  };
  const R = 10 + d1 + w;
  const xPin = R + 0.45 * P.flangeWidth;
  const xEdge = R + P.flangeWidth;
  return {
    P, y0, zTop, zFloor, h: 0.5,
    Mp, Msdf: null,
    cavA: cav, cavB: cav, outerA: outer, outerB: outer,
    shellA: shell('A'), shellB: shell('B'),
    outline2D, flange2D,
    pinSites: [[-xPin, 5], [-xPin, 30], [-xPin, 55], [xPin, 5], [xPin, 30], [xPin, 55]],
    clipSites: [
      { e: [-xEdge, 12], n: [-1, 0], side: 'left' }, { e: [-xEdge, 48], n: [-1, 0], side: 'left' },
      { e: [xEdge, 12], n: [1, 0], side: 'right' }, { e: [xEdge, 48], n: [1, 0], side: 'right' },
      { e: [0, zFloor], n: [0, -1], side: 'bottom' },
    ],
    yBackA: -R, yBackB: R,
  };
}

test('ribs: valid plates on the back of each half, standing on zFloor, clear of the cavity and clips', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold);
  const P = ctx.P;
  for (const side of ['A', 'B']) {
    const ribs = buildRibs(ctx, side);
    assert.ok(ribs, `ribs ${side}`);
    assert.equal(ribs.status(), 'NoError');
    const bb = ribs.boundingBox();
    if (side === 'A') assert.ok(bb.max[1] <= y0 - P.flangeThickness + 0.05 && bb.min[1] >= ctx.yBackA - 1e-6);
    else assert.ok(bb.min[1] >= y0 + P.flangeThickness - 0.05 && bb.max[1] <= ctx.yBackB + 1e-6);
    assert.ok(approx(bb.min[2], zFloor, 1e-6), `min z ${bb.min[2]}`);
    assert.ok(bb.max[2] <= zTop + 1e-6);
    const cav = side === 'A' ? ctx.cavA : ctx.cavB;
    assert.ok(ribs.intersect(cav).volume() < 1e-3, 'ribs must not enter the cavity');
    assert.ok(ribs.decompose().length >= 2, 'at least two ribs');
    // ribs reach the back plane (the half lies flat on its back)
    assert.ok(approx(side === 'A' ? bb.min[1] : bb.max[1], side === 'A' ? ctx.yBackA : ctx.yBackB, 1e-6));
    const xs = ribPositions(ctx, side);
    const xr = ctx.yBackB; // body half width
    for (const x of xs) {
      assert.ok(Math.abs(x) >= P.clipWidth / 2 + 3 + P.ribThickness / 2 - 1e-6, `rib at ${x} collides with the bottom clip`);
      assert.ok(Math.abs(x) <= xr, `rib at ${x} outside the shell body`);
    }
    for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] <= P.ribSpacing + 1e-6, 'rib spacing');
  }
});

test('ribs: a rib is placed in the valley between two masters', async () => {
  const { Manifold } = await setup();
  const P = resolveParams({ ribSpacing: 120 });
  const tf = P.flangeThickness;
  const R = 17.4;
  const outer = Manifold.union([-20, 20].map((x) => Manifold.cylinder(70, R, R, 64).translate([x, 0, zFloor])));
  const cav = Manifold.union([-20, 20].map((x) => Manifold.cylinder(80, 15, 15, 64).translate([x, 0, -5])));
  const flange2D = planeSlice(outer, 0).hull().offset(14).intersect(rect2(-1e3, zFloor, 1e3, zTop));
  const shellA = trimZ(trimSide(outer, 'A', 0), zFloor, zTop).add(planeExtrude(flange2D, -tf, 0)).subtract(cav);
  const ctx = { P, y0: 0, zTop, zFloor, h: 0.5, shellA, cavA: cav, yBackA: -R, pinSites: [], clipSites: [] };
  const xs = ribPositions(ctx, 'A');
  assert.ok(xs.some((x) => Math.abs(x) < 0.6), `valley rib near x=0, got ${xs.map((x) => x.toFixed(2))}`);
  assert.ok(xs.length >= 3, 'two end ribs + the valley rib');
  const ribs = buildRibs(ctx, 'A');
  assert.equal(ribs.status(), 'NoError');
  assert.equal(ribs.decompose().length, xs.length);
});

test('windows: cut the shell body but never the flange zone', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold);
  const tf = ctx.P.flangeThickness;
  for (const side of ['A', 'B']) {
    const shell = side === 'A' ? ctx.shellA : ctx.shellB;
    const cut = cutWindows(shell, ctx, side);
    assert.equal(cut.status(), 'NoError');
    assert.ok(cut.volume() < shell.volume() - 50, `windows remove material (${shell.volume()} -> ${cut.volume()})`);
    const flangeZone = (s) => (side === 'A' ? s.trimByPlane([0, 1, 0], y0 - tf - 0.5) : s.trimByPlane([0, -1, 0], -(y0 + tf + 0.5))).volume();
    assert.ok(approx(flangeZone(cut), flangeZone(shell), 1e-6 * flangeZone(shell)), 'flange zone unchanged');
    // windows stay clear of the ribs: ribs ∩ removed material ≈ 0
    const removed = shell.subtract(cut);
    const ribs = buildRibs(ctx, side);
    assert.ok(removed.intersect(ribs).volume() < 1e-3, 'windows avoid rib planes');
    // floor and rim bands are intact
    const band = (s, z0, z1) => trimZ(s, z0, z1).volume();
    assert.ok(approx(band(cut, zFloor, zFloor + ctx.P.windowBar - 0.1), band(shell, zFloor, zFloor + ctx.P.windowBar - 0.1), 1e-6 * shell.volume()));
    assert.ok(approx(band(cut, zTop - ctx.P.windowBar + 0.1, zTop), band(shell, zTop - ctx.P.windowBar + 0.1, zTop), 1e-6 * shell.volume()));
  }
});

test('key ring: U-shaped band inside the silicone face, open at the pour side', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold);
  const P = ctx.P;
  const ring = keyRing2D(ctx);
  assert.ok(ring && !ring.isEmpty() && ring.area() > 10);
  const S = planeSlice(ctx.Mp, y0);
  const face = planeSlice(ctx.cavA, y0).add(planeSlice(ctx.cavB, y0)).subtract(S);
  assert.ok(ring.subtract(face).area() < 1e-6, 'inside the silicone face');
  assert.ok(ring.intersect(S).area() < 1e-6, 'does not enter the cavity opening');
  const b = ring.bounds();
  assert.ok(b.max[1] <= zTop - Math.max(2 * P.keyWidth, 0.6 * P.siliconeThickness) + 1e-6, 'open at the top');
  assert.ok(b.min[1] >= zFloor - 1e-6);
  assert.equal(ring.decompose().length, 1, 'one connected U');
  // the band sits around the cavity: x extent = 10 + keyOffset + keyWidth/2
  assert.ok(approx(b.max[0], 10 + P.keyOffset + P.keyWidth / 2, 0.05));
  assert.equal(keyRing2D({ ...ctx, P: { ...P, keys: false } }), null);
});

test('double board: reliefs, ridge, groove, pin holes, handle', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold);
  const P = ctx.P;
  const T = P.boardThickness;
  const res = buildBoards(ctx);
  assert.deepEqual(res.shellOffsetY, { A: -T / 2, B: T / 2 });
  assert.equal(res.boards.length, 1);
  const { solid: board, printMatrix, poseSilicone } = res.boards[0];
  assert.equal(board.status(), 'NoError');
  assert.equal(poseSilicone.length, 16);
  assert.ok(approx(board.transform(printMatrix).boundingBox().min[2], 0, 1e-6));
  const bb = board.boundingBox();
  assert.ok(approx(bb.max[2], zTop + P.boardTopExtra, 1e-6), 'handle above the rim');
  assert.ok(approx(bb.min[2], zFloor, 1e-6));

  // reliefs translated back reconstruct the cast cavity (keys off to isolate them)
  const plain = buildBoards({ ...ctx, P: { ...P, keys: false } }).boards[0].solid;
  const relA = trimSide(plain, 'A', y0 - T / 2).translate([0, T / 2, 0]);
  const relB = trimSide(plain, 'B', y0 + T / 2).translate([0, -T / 2, 0]);
  const vRel = relA.add(relB).volume();
  const vMp = trimZ(ctx.Mp, null, zTop).volume();
  assert.ok(Math.abs(vRel - vMp) / vMp < 0.02, `relief volume ${vRel} vs Mp ${vMp}`);

  // ridge on face A: the slice just in front of face A contains the ring
  const ring = keyRing2D(ctx);
  const S = planeSlice(ctx.Mp, y0);
  const ridgeSlice = planeSlice(board, y0 - T / 2 - P.keyHeight / 2).subtract(S.offset(0.05));
  assert.ok(approx(ridgeSlice.area(), ring.area(), 0.02 * ring.area()), `ridge ${ridgeSlice.area()} vs ring ${ring.area()}`);
  assert.ok(bb.min[1] < y0 - T / 2 - P.keyHeight + 0.01 || bb.min[1] < y0 - T / 2 - 9, 'ridge/relief protrude from face A');
  assert.ok(planeSlice(plain, y0 - T / 2 - P.keyHeight / 2).subtract(S.offset(0.05)).area() < 1e-6, 'no ridge without keys');

  // groove on face B: lower volume than without groove, slice lacks ring.offset(clearance)
  assert.ok(board.volume() < plain.volume() + ring.area() * P.keyHeight - 1, 'groove removes material');
  const yG = y0 + T / 2 - (P.keyHeight + P.keyClearance) / 2;
  const missing = planeSlice(plain, yG).area() - planeSlice(board, yG).area();
  const gArea = ring.offset(P.keyClearance, 'Round').area();
  assert.ok(approx(missing, gArea, 0.02 * gArea), `groove area ${missing} vs ${gArea}`);
  // the groove does not cut through the board
  assert.ok(approx(planeSlice(board, y0 + T / 2 - P.keyHeight - P.keyClearance - 0.3).area(),
    planeSlice(plain, y0 + T / 2 - P.keyHeight - P.keyClearance - 0.3).area(), 1e-3));

  // pin holes go through at every pin site
  const mid = planeSlice(board, y0).toPolygons();
  for (const [x, z] of ctx.pinSites) assert.equal(pointInPolygons(mid, x, z), false, `pin hole at ${x},${z}`);
  assert.equal(pointInPolygons(mid, ctx.pinSites[0][0] + 3, ctx.pinSites[0][1]), true);
});

test('double board: thin board clamps the groove and warns', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold, { boardThickness: 2 });
  const res = buildBoards(ctx);
  assert.equal(res.boards[0].solid.status(), 'NoError');
  assert.ok(res.warnings.length >= 1);
  // 2 mm board -> groove depth 1.2 mm: the board is intact 0.8 mm behind face B
  const b = res.boards[0].solid;
  const plainSlice = planeSlice(buildBoards({ ...ctx, P: { ...ctx.P, keys: false } }).boards[0].solid, y0 - 1 + 0.4).area();
  assert.ok(approx(planeSlice(b, y0 - 1 + 0.4).area(), plainSlice, 1e-3));
});

test('single boards: two flat-printable boards, relief up, ridge on A, groove on B', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold, { boardStyle: 'single' });
  const P = ctx.P;
  const T = P.boardThickness;
  const res = buildBoards(ctx);
  assert.deepEqual(res.shellOffsetY, { A: 0, B: 0 });
  assert.deepEqual(res.boards.map((b) => b.id), ['boardA', 'boardB']);
  const [A, B] = res.boards;
  for (const b of [A, B]) {
    assert.equal(b.solid.status(), 'NoError');
    const placed = b.solid.transform(b.printMatrix);
    const pb = placed.boundingBox();
    assert.ok(approx(pb.min[2], 0, 1e-6), `${b.id} min z ${pb.min[2]}`);
    assert.ok(approx(pb.max[2], T + 10, 1e-3), `${b.id} relief (r=10) points up: max z ${pb.max[2]}`);
    // flat back on the bed: the first layer is the full board outline
    const slab = placed.slice(0.2).area();
    const top = placed.slice(T + 5).area();
    assert.ok(slab > 3 * top && top > 500, `${b.id}: slab ${slab}, relief section ${top}`);
  }
  // relief A protrudes to y < y0 (face y0), slab behind it on y in [y0, y0+T]
  const ba = A.solid.boundingBox(), bbB = B.solid.boundingBox();
  assert.ok(approx(ba.max[1], y0 + T, 1e-6) && approx(ba.min[1], y0 - 10, 1e-3));
  assert.ok(approx(bbB.min[1], y0 - T, 1e-6) && approx(bbB.max[1], y0 + 10, 1e-3));
  // the slab face point of the ridge maps upward in print orientation
  const ring = keyRing2D(ctx);
  const rb = ring.bounds();
  const p = mat4ApplyPoint(A.printMatrix, [rb.max[0] - P.keyWidth / 2, y0 - P.keyHeight, 30]);
  assert.ok(approx(p[2], T + P.keyHeight, 1e-6));
  const S = planeSlice(ctx.Mp, y0);
  assert.ok(approx(planeSlice(A.solid, y0 - P.keyHeight / 2).subtract(S.offset(0.05)).area(), ring.area(), 0.02 * ring.area()), 'ridge on A');
  const gArea = ring.offset(P.keyClearance, 'Round').area();
  const full = planeSlice(B.solid, y0 - T + 0.3).area();
  assert.ok(approx(full - planeSlice(B.solid, y0 - 0.5).area(), gArea, 0.02 * gArea), 'groove in B');
});

test('board style none', async () => {
  const { Manifold } = await setup();
  const ctx = makeCtx(Manifold, { boardStyle: 'none' });
  const res = buildBoards(ctx);
  assert.deepEqual(res.boards, []);
  assert.deepEqual(res.shellOffsetY, { A: 0, B: 0 });
});
