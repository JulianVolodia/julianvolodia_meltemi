import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, approx } from './helpers.mjs';
import { resolveParams } from '../src/core/params.js';
import { mat4ApplyPoint } from '../src/core/frame.js';
import { clipGap, buildClip, clipPose, clipPrintMatrix } from '../src/core/features/clips.js';
import { pinLengths, buildPin, pinHole, pinPose, pinPrintMatrix } from '../src/core/features/pins.js';

function det3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

test('clip: valid solid, gap, local-frame extents, print matrix', async () => {
  await setup();
  const P = resolveParams({});
  const s = 2 * P.flangeThickness + P.boardThickness;
  const g = clipGap(s, P);
  assert.ok(approx(g, s - P.clipInterference, 1e-12));
  const clip = buildClip(s, P);
  assert.equal(clip.status(), 'NoError');
  assert.ok(clip.volume() > 0);
  assert.equal(clip.decompose().length, 1);
  const b = clip.boundingBox();
  assert.ok(approx(b.min[0], -P.clipWall, 1e-6) && approx(b.max[0], P.clipJaw, 1e-6));
  assert.ok(approx(b.max[1], g / 2 + P.clipWall, 1e-6) && approx(b.min[1], -(g / 2 + P.clipWall), 1e-6));
  assert.ok(approx(b.min[2], -P.clipWidth / 2, 1e-6) && approx(b.max[2], P.clipWidth / 2, 1e-6));
  // volume close to the C-profile area (minus chamfers/reliefs) * width
  const area = (P.clipWall + P.clipJaw) * (g + 2 * P.clipWall) - P.clipJaw * g;
  assert.ok(clip.volume() < area * P.clipWidth && clip.volume() > 0.9 * area * P.clipWidth);
  const pb = clip.transform(clipPrintMatrix(P)).boundingBox();
  assert.ok(approx(pb.min[2], 0, 1e-6) && approx(pb.max[2], P.clipWidth, 1e-6));
});

test('clip: jaw gap admits g - 0.01 but not g + 0.2', async () => {
  const { Manifold } = await setup();
  const P = resolveParams({});
  const s = 2 * P.flangeThickness;
  const g = clipGap(s, P);
  const clip = buildClip(s, P);
  const slab = (t) => Manifold.cube([P.clipJaw + 2, t, P.clipWidth + 2]).translate([0, -t / 2, -P.clipWidth / 2 - 1]);
  const vThin = clip.intersect(slab(g - 0.01)).volume();
  const vThick = clip.intersect(slab(g + 0.2)).volume();
  assert.ok(vThin < 1e-6, `thin slab intersects ${vThin}`);
  assert.ok(vThick > 0.5, `thick slab intersects only ${vThick}`);
});

test('clip poses: side edge and bottom edge', async () => {
  await setup();
  const P = resolveParams({});
  const s = 2 * P.flangeThickness + P.boardThickness;
  const g = clipGap(s, P);
  const clip = buildClip(s, P);
  // left flange edge at x = -50, z = 20, flange material towards +x
  const M = clipPose([-50, 20], [1, 0], 0);
  assert.ok(approx(det3(M), 1, 1e-12));
  const b = clip.transform(M).boundingBox();
  assert.ok(approx(b.min[0], -50 - P.clipWall, 1e-6) && approx(b.max[0], -50 + P.clipJaw, 1e-6), `x ${b.min[0]} ${b.max[0]}`);
  assert.ok(approx(b.max[1], g / 2 + P.clipWall, 1e-6) && approx(b.min[1], -(g / 2 + P.clipWall), 1e-6));
  assert.ok(approx(b.min[2], 20 - P.clipWidth / 2, 1e-6) && approx(b.max[2], 20 + P.clipWidth / 2, 1e-6));
  // right edge (inward -x) with an offset sandwich centre
  const bR = clip.transform(clipPose([60, 5], [-1, 0], 2)).boundingBox();
  assert.ok(approx(bR.max[0], 60 + P.clipWall, 1e-6) && approx(bR.min[0], 60 - P.clipJaw, 1e-6));
  assert.ok(approx(bR.max[1], 2 + g / 2 + P.clipWall, 1e-6));
  // bottom edge at z = -10, flange material above (+z)
  const MB = clipPose([3, -10], [0, 1], 0);
  assert.ok(approx(det3(MB), 1, 1e-12));
  const bb = clip.transform(MB).boundingBox();
  assert.ok(approx(bb.min[2], -10 - P.clipWall, 1e-6) && approx(bb.max[2], -10 + P.clipJaw, 1e-6), `z ${bb.min[2]} ${bb.max[2]}`);
  assert.ok(approx(bb.min[0], 3 - P.clipWidth / 2, 1e-6) && approx(bb.max[0], 3 + P.clipWidth / 2, 1e-6));
  // a transformed clip still clamps a flange sandwich placed in the mold frame
  const { Manifold } = await setup();
  const flange = Manifold.cube([20, g - 0.01, 30]).translate([-50, -(g - 0.01) / 2, 5]);
  assert.ok(clip.transform(M).intersect(flange).volume() < 1e-6);
});

test('pins: lengths per board style', () => {
  const P = resolveParams({ flangeThickness: 4, boardThickness: 3 });
  assert.deepEqual(pinLengths({ ...P, boardStyle: 'double' }), { cast: 7.6, silicone: 2 * 4 + 3 - 0.4 });
  assert.ok(approx(pinLengths({ ...P, boardStyle: 'single' }).silicone, 4 + 3 - 0.4, 1e-12));
  const none = pinLengths({ ...P, boardStyle: 'none' });
  assert.equal(none.silicone, none.cast);
});

test('pins: pin solid, chamfers, pose and hole', async () => {
  await setup();
  const P = resolveParams({});
  const L = pinLengths(P).silicone;
  const pin = buildPin(L, P);
  assert.equal(pin.status(), 'NoError');
  const b = pin.boundingBox();
  const r = P.pinDiameter / 2;
  assert.ok(approx(b.min[2], 0, 1e-6) && approx(b.max[2], L, 1e-6));
  assert.ok(approx(b.max[0], r, 1e-6) && approx(b.min[0], -r, 1e-6));
  const vCyl = Math.PI * r * r * L;
  assert.ok(pin.volume() < vCyl && pin.volume() > 0.9 * vCyl, `pin volume ${pin.volume()} vs ${vCyl}`);
  // chamfer: the end face is smaller than the mid section
  assert.ok(pin.slice(0.05).area() < pin.slice(L / 2).area() * 0.9);
  assert.deepEqual(pinPrintMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const site = [12, 34], yStart = -6;
  const M = pinPose(site, yStart);
  assert.ok(approx(det3(M), 1, 1e-12));
  const top = mat4ApplyPoint(M, [0, 0, L]);
  assert.ok(approx(top[0], 12, 1e-9) && approx(top[1], yStart + L, 1e-9) && approx(top[2], 34, 1e-9));
  const pb = pin.transform(M).boundingBox();
  assert.ok(approx(pb.min[1], yStart, 1e-6) && approx(pb.max[1], yStart + L, 1e-6));
  assert.ok(approx(pb.min[0], 12 - r, 1e-6) && approx(pb.max[2], 34 + r, 1e-6));

  const hole = pinHole(site, -8, 8, P);
  assert.equal(hole.status(), 'NoError');
  const hb = hole.boundingBox();
  const rh = (P.pinDiameter + P.pinClearance) / 2;
  assert.ok(approx(hb.min[1], -8, 1e-6) && approx(hb.max[1], 8, 1e-6));
  assert.ok(approx(hb.min[0], 12 - rh, 1e-6) && approx(hb.max[2], 34 + rh, 1e-6));
  assert.ok(approx(hole.volume(), Math.PI * rh * rh * 16, 0.02 * Math.PI * rh * rh * 16));
  // the placed pin fits inside the hole with clearance
  assert.ok(pin.transform(M).subtract(hole).volume() < 1e-6);
  // radial clearance between pin and hole wall = pinClearance / 2 (polygonised, same segments)
  const { Manifold } = await setup();
  const plate = Manifold.cube([20, 16, 20]).translate([2, -8, 24]).subtract(hole);
  const gap = pin.transform(M).minGap(plate, 1);
  assert.ok(approx(gap, P.pinClearance / 2, 0.02), `pin/hole gap ${gap}`);
});
