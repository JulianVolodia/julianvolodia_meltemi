// Demo geometry (candles, primitives) + CLI argument parsing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTaperCandle, makeCandleRow, demoCandles } from '../src/demo/candles.js';
import {
  makeCylinder, makeCone, makeSphere, makeBox, makeHShape, extrudeXZ,
  checkClosedManifold, meshVolume, meshBBox,
} from '../src/demo/shapes.js';
import { parseArgs, coerceValue, partFileName } from '../cli/moldbox.mjs';
import { resolveInside } from '../cli/serve.mjs';

/** Every undirected edge used exactly twice, with opposite orientation. */
function assertClosedManifold(mesh, label) {
  const r = checkClosedManifold(mesh);
  assert.equal(r.boundaryEdges, 0, `${label}: boundary edges`);
  assert.equal(r.nonManifoldEdges, 0, `${label}: non-manifold / inconsistently oriented edges`);
  assert.equal(r.degenerate, 0, `${label}: degenerate triangles`);
  assert.equal(r.unused, 0, `${label}: unreferenced vertices`);
  assert.equal(r.eulerChar, 2, `${label}: genus 0 sphere topology`);
  assert.ok(mesh.positions instanceof Float32Array && mesh.indices instanceof Uint32Array, `${label}: typed arrays`);
  return r;
}

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

let manifoldLib = null;
async function manifold() {
  if (manifoldLib !== null) return manifoldLib;
  try {
    const { setup } = await import('./helpers.mjs');
    manifoldLib = await setup();
  } catch {
    manifoldLib = false; // manifold-3d not installed: skip the WASM cross-check
  }
  return manifoldLib;
}
async function assertManifoldOK(mesh, label) {
  const lib = await manifold();
  if (!lib) return null;
  const { Manifold, Mesh } = lib;
  const m = new Manifold(new Mesh({ numProp: 3, vertProperties: mesh.positions, triVerts: mesh.indices }));
  assert.equal(m.status(), 'NoError', `${label}: manifold status`);
  assert.equal(m.genus(), 0, `${label}: genus`);
  return m;
}

test('taper candle: closed, 2-manifold, outward, expected size', async () => {
  const c = makeTaperCandle();
  assertClosedManifold(c, 'candle');
  const v = meshVolume(c);
  // frustum r 11 -> 5.5 over ~174 mm plus a small dome: ~ 38-41 cm3
  assert.ok(v > 34000 && v < 46000, `volume ${v}`);
  const b = meshBBox(c);
  near(b.min[2], 0, 1e-6, 'base on z=0');
  near(b.max[2], 180, 1e-4, 'tip at z=height');
  for (const a of [0, 1]) {
    near(b.min[a], -11, 1.6, `bbox min ${a}`);
    near(b.max[a], 11, 1.6, `bbox max ${a}`);
  }
  // the base is a flat disc of ~baseRadius (relief fades out on the plain base band)
  const p = c.positions;
  let rMax0 = 0;
  for (let i = 0; i < p.length; i += 3) if (p[i + 2] === 0) rMax0 = Math.max(rMax0, Math.hypot(p[i], p[i + 1]));
  near(rMax0, 11, 0.05, 'base radius');
  const m = await assertManifoldOK(c, 'candle');
  if (m) near(m.volume(), v, 1e-3 * v, 'manifold volume == signed mesh volume (no self-overlap)');
});

test('taper candle: deterministic per seed, varied across seeds, robust options', () => {
  const a = makeTaperCandle({ seed: 3, radialSegments: 48, heightSegments: 60 });
  const b = makeTaperCandle({ seed: 3, radialSegments: 48, heightSegments: 60 });
  const c = makeTaperCandle({ seed: 4, radialSegments: 48, heightSegments: 60 });
  assert.deepEqual(a.positions, b.positions);
  assert.notDeepEqual(a.positions, c.positions);
  for (const opts of [
    { relief: 0, drips: false },
    { relief: 5, dripAmplitude: 5 }, // clamped below the radius
    { height: 60, baseRadius: 6, tipRadius: 2, radialSegments: 24, heightSegments: 30 },
    { seed: 99, tipRadius: 20 }, // tip clamped to the base radius
  ]) {
    const m = makeTaperCandle(opts);
    assertClosedManifold(m, JSON.stringify(opts));
    assert.ok(meshVolume(m) > 0);
    const p = m.positions;
    for (let i = 0; i < p.length; i += 3) {
      const z = p[i + 2], r = Math.hypot(p[i], p[i + 1]);
      if (z > 0 && z < (opts.height ?? 180) * 0.9) assert.ok(r >= 1 - 1e-4, `radius >= 1 mm (got ${r} at z ${z})`);
    }
  }
});

test('candle row: 3 candles centred on x=0, y=0, base up in cast orientation', async () => {
  const row = makeCandleRow();
  assert.equal(row.length, 3);
  const boxes = row.map(meshBBox);
  const cx = boxes.map((b) => (b.min[0] + b.max[0]) / 2);
  near(cx[0] + cx[1] + cx[2], 0, 0.5, 'row centred in x');
  near(cx[1], 0, 0.5, 'middle candle at x=0');
  near(cx[2] - cx[0], 52, 0.5, '2 x spacing');
  for (const [i, b] of boxes.entries()) {
    near((b.min[1] + b.max[1]) / 2, 0, 0.5, `candle ${i} centred in y`);
    near(b.min[2], 0, 1e-4, `candle ${i} on z=0`);
    near(b.max[2], 180, 1e-4, `candle ${i} height`);
    assertClosedManifold(row[i], `row[${i}]`);
    assert.ok(meshVolume(row[i]) > 0, 'still outward after flipping');
  }
  // cast orientation: wide flat base at the top (z = height), narrow tip at the bottom
  const p = row[1].positions;
  let rTop = 0, rLow = 0;
  for (let i = 0; i < p.length; i += 3) {
    const r = Math.hypot(p[i], p[i + 1]);
    if (Math.abs(p[i + 2] - 180) < 1e-4) rTop = Math.max(rTop, r);
    if (p[i + 2] < 20) rLow = Math.max(rLow, r);
  }
  near(rTop, 11, 0.05, 'flat base at the top');
  assert.ok(rLow < 7.5, `narrow tip at the bottom (r ${rLow})`);
  const natural = makeCandleRow({ count: 2, castOrientation: false, radialSegments: 32, heightSegments: 40 });
  assert.equal(natural.length, 2);
  near(meshBBox(natural[0]).min[0], -24, 0.6, 'count 2 -> x = -13 +/- r');

  const lib = await manifold();
  if (lib) {
    const parts = row.map((m) => new lib.Manifold(new lib.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices })));
    const u = lib.Manifold.union(parts);
    assert.equal(u.status(), 'NoError');
    assert.equal(u.decompose().length, 3, 'candles do not touch');
  }
});

test('demo candles preset is valid', async () => {
  const d = demoCandles();
  assert.equal(d.length, 3);
  for (const m of d) {
    assertClosedManifold(m, 'demo');
    await assertManifoldOK(m, 'demo');
    near(meshBBox(m).max[2], 150, 1e-4, 'demo height');
  }
});

test('primitives: closed, outward, analytic volumes', async () => {
  const cases = [
    ['cylinder', makeCylinder({ r: 10, h: 30, segments: 128 }), Math.PI * 100 * 30, 0.01],
    ['cone', makeCone({ r1: 10, r2: 4, h: 30, segments: 128 }), (Math.PI * 30 / 3) * (100 + 40 + 16), 0.01],
    ['cone apex', makeCone({ r1: 10, r2: 0, h: 30, segments: 128 }), (Math.PI * 100 * 30) / 3, 0.01],
    ['inverted cone', makeCone({ r1: 0, r2: 10, h: 30, segments: 128 }), (Math.PI * 100 * 30) / 3, 0.01],
    ['sphere', makeSphere({ r: 10, segments: 96, rings: 48 }), (4 / 3) * Math.PI * 1000, 0.01],
    ['box', makeBox({ size: [10, 20, 30] }), 6000, 1e-9],
    ['box min', makeBox({ size: 5, min: [1, 2, 3] }), 125, 1e-9],
  ];
  for (const [label, mesh, vol, rel] of cases) {
    assertClosedManifold(mesh, label);
    const v = meshVolume(mesh);
    assert.ok(Math.abs(v - vol) <= rel * vol, `${label}: volume ${v} vs ${vol}`);
    await assertManifoldOK(mesh, label);
  }
  const bb = meshBBox(makeBox({ size: 5, min: [1, 2, 3] }));
  assert.deepEqual(bb, { min: [1, 2, 3], max: [6, 7, 8] });
  const cyl = meshBBox(makeCylinder({ r: 10, h: 30, center: true }));
  near(cyl.min[2], -15, 1e-6, 'centred cylinder');
});

test('H shape: one closed prism, tall + short leg, bar near the bottom', async () => {
  const h = makeHShape();
  assertClosedManifold(h, 'H');
  const b = meshBBox(h);
  near(b.max[2], 50, 1e-4, 'tall leg height');
  near(b.min[2], 0, 1e-6, 'on z=0');
  near((b.min[1] + b.max[1]) / 2, 0, 1e-6, 'centred on the parting plane y=0');
  // volume: legs (12 x 12 x (h - r) + half disc r=6 x 12) + bar (18 x 12 x 10)
  const leg = (H) => 12 * 12 * (H - 6) + 0.5 * Math.PI * 36 * 12;
  const expected = leg(50) + leg(34) + 18 * 12 * 10;
  near(meshVolume(h), expected, 0.01 * expected, 'H volume');
  // highest point of the right (short) leg = 34
  const p = h.positions;
  let zr = 0;
  for (let i = 0; i < p.length; i += 3) if (p[i] > 5) zr = Math.max(zr, p[i + 2]);
  near(zr, 34, 1e-4, 'short leg top');
  const m = await assertManifoldOK(h, 'H');
  if (m) assert.equal(m.decompose().length, 1);
  // concave L-shaped polygon, clockwise input
  const L = extrudeXZ([[0, 0], [0, 10], [3, 10], [3, 3], [10, 3], [10, 0]], -1, 1);
  assertClosedManifold(L, 'L prism');
  near(meshVolume(L), 2 * (10 * 3 + 7 * 3), 1e-6, 'L volume');
});

test('CLI argument parsing', () => {
  const o = parseArgs(['a.stl', 'b.stl', '--set', 'siliconeThickness=6', '--set=wick=true', '--quality=fine',
    '--mode', 'support', '--auto-orient', '--out', 'x/y', '--set', 'keyOffset=null', '--set', 'siliconeMixRatio=10:1']);
  assert.deepEqual(o.inputs, ['a.stl', 'b.stl']);
  assert.equal(o.out, 'x/y');
  assert.equal(o.autoOrient, true);
  assert.deepEqual(o.params, { siliconeThickness: 6, wick: true, quality: 'fine', mode: 'support', keyOffset: null, siliconeMixRatio: '10:1' });
  assert.equal(parseArgs(['--demo', 'candles']).demo, 'candles');
  assert.equal(parseArgs(['--demo', 'h']).out, 'out/run');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs([]), /no input/);
  assert.throws(() => parseArgs(['--demo', 'teapot']), /unknown demo/);
  assert.throws(() => parseArgs(['a.stl', '--demo', 'h']), /either/);
  assert.throws(() => parseArgs(['a.stl', '--quality', 'ultra']), /quality/);
  assert.throws(() => parseArgs(['a.stl', '--mode', 'x']), /mode/);
  assert.throws(() => parseArgs(['a.stl', '--set', 'novalue']), /key=value/);
  assert.throws(() => parseArgs(['a.stl', '--out']), /expects a value/);
  assert.throws(() => parseArgs(['a.stl', '--frobnicate']), /unknown option/);
  assert.equal(coerceValue('-2.5'), -2.5);
  assert.equal(coerceValue('1e3'), 1000);
  assert.equal(coerceValue('off'), false);
  assert.equal(coerceValue('auto'), 'auto');
  assert.equal(partFileName(3, { id: 'clip_silicone', quantity: 6 }), '03_clip_silicone_x6.stl');
  assert.equal(partFileName(12, { id: 'shell A', quantity: 1 }), '12_shell_A.stl');
});

test('static server refuses path traversal', () => {
  const root = '/srv/app';
  assert.equal(resolveInside(root, '/index.html'), '/srv/app/index.html');
  assert.equal(resolveInside(root, '/src/ui/../core/x.js?v=1'), '/srv/app/src/core/x.js');
  assert.equal(resolveInside(root, '/'), '/srv/app');
  assert.equal(resolveInside(root, '/../../etc/passwd'), '/srv/app/etc/passwd'); // clamped to root
  assert.equal(resolveInside(root, '/%2e%2e/%2e%2e/etc/passwd'), '/srv/app/etc/passwd');
  assert.equal(resolveInside(root, '/..%5c..%5cetc/passwd'), '/srv/app/etc/passwd');
  assert.equal(resolveInside(root, '/%E0%A4%A'), null); // malformed escape
  assert.equal(resolveInside(root, '/a%00b'), null);
});
