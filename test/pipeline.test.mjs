// End-to-end pipeline tests (quality 'draft', small masters).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { manifoldFromMesh, meshFromManifold, transformMesh } from '../src/core/meshio.js';
import { trimSide, trimZ } from '../src/core/frame.js';
import { resolveParams } from '../src/core/params.js';
import { buildClip, clipPose } from '../src/core/features/clips.js';
import { layoutPinsAndClips, placeAvoiding, crossingsAtZ } from '../src/core/features/flanges.js';
import { generate, generateMoldBox, generateSupport } from '../src/core/pipeline.js';
import { makeHShape } from '../src/demo/shapes.js';

const DRAFT = { quality: 'draft' };
const cache = new Map();

/** Cached pipeline run (several tests inspect the same result). */
async function runCached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

async function cylinderMaster() {
  const { Manifold } = await setup();
  return meshFromManifold(Manifold.cylinder(60, 10, 10, 64));
}

function part(res, id) {
  return res.parts.find((p) => p.id === id);
}

/** Every part mesh converts back to a valid, unrepaired Manifold with positive volume. */
function checkPartsValid(res) {
  const out = {};
  for (const p of res.parts) {
    const r = manifoldFromMesh(p.mesh);
    assert.equal(r.repaired, false, `${p.id}: mesh needed repair (${r.warnings.join('; ')})`);
    assert.equal(r.manifold.status(), 'NoError', p.id);
    assert.ok(r.manifold.volume() > 0, `${p.id} volume`);
    assert.ok(p.quantity >= 1, `${p.id} quantity`);
    assert.equal(p.printMatrix.length, 16, `${p.id} printMatrix`);
    assert.ok(Number.isFinite(p.mass) && p.mass > 0, `${p.id} mass`);
    assert.ok(Object.keys(p.stages).length > 0, `${p.id} stages`);
    for (const poses of Object.values(p.stages)) for (const m of poses) assert.equal(m.length, 16);
    if (p.printable) {
      const b = manifoldFromMesh(transformMesh(p.mesh, p.printMatrix)).manifold.boundingBox();
      assert.ok(Math.abs(b.min[2]) < 1e-3, `${p.id} print orientation min z ${b.min[2]}`);
    }
    out[p.id] = r.manifold;
  }
  return out;
}

test('layout helpers: placeAvoiding and pin/clip interleaving', () => {
  const z = placeAvoiding(3, 0, 100, [[40, 60]], 12);
  assert.equal(z.length, 3);
  for (const v of z) assert.ok(!(v > 40 && v < 60));
  const lay = layoutPinsAndClips(3, 4, [14, 160], [15, 155], 9, 12);
  assert.equal(lay.clips.length, 4);
  assert.equal(lay.pins.length, 3);
  for (const p of lay.pins) for (const c of lay.clips) assert.ok(Math.abs(p - c) >= 9 - 1e-9);
  // short flange: keeps >= 2 pins, as many clips as fit
  const s = layoutPinsAndClips(3, 4, [6, 50], [7, 52], 9, 12);
  assert.ok(s.pins.length >= 2 && s.clips.length >= 2, JSON.stringify(s));
  const cr = crossingsAtZ([[[0, 0], [10, 0], [10, 10], [0, 10]]], 5);
  assert.deepEqual(cr.map((c) => c.x), [0, 10]);
});

test('moldbox (cylinder r10 h60, default single boards): valid parts and geometry', async () => {
  const { Manifold } = await setup();
  const res = await runCached('cyl', async () => generateMoldBox([await cylinderMaster()], DRAFT, () => {}, { keepSolids: true }));
  const P = resolveParams(DRAFT);
  const d1 = P.siliconeThickness, h = res.stats.voxelSize, y0 = res.frame.y0;
  const solids = checkPartsValid(res);
  const { Mp } = res.solids;
  const A = solids.shellA, B = solids.shellB;
  assert.ok(A && B, 'two shell halves');
  assert.ok(A.intersect(Mp).volume() < 1, `shellA ∩ Mp = ${A.intersect(Mp).volume()}`);
  assert.ok(B.intersect(Mp).volume() < 1, `shellB ∩ Mp = ${B.intersect(Mp).volume()}`);
  assert.ok(A.intersect(B).volume() < 1, `shellA ∩ shellB = ${A.intersect(B).volume()}`);
  const gap = A.minGap(Mp, d1 + 5);
  assert.ok(gap >= d1 - 1.0 && gap <= d1 + 2 * h, `silicone thickness ${gap} (d1 ${d1}, h ${h})`);
  const gapB = B.minGap(Mp, d1 + 5);
  assert.ok(gapB >= d1 - 1.0 && gapB <= d1 + 2 * h, `silicone thickness B ${gapB}`);
  assert.ok(A.boundingBox().max[1] <= y0 + 1e-6, 'shell A stays on y <= y0');
  assert.ok(B.boundingBox().min[1] >= y0 - 1e-6, 'shell B stays on y >= y0');
  assert.ok(Math.abs(A.boundingBox().min[2] - res.frame.zFloor) < 1e-6, 'stands on zFloor');
  assert.ok(A.boundingBox().max[2] <= res.frame.zTop + 1e-6, 'open rim at zTop');
  // the top is open: a slice just below the rim has the cavity hole
  assert.ok(A.slice(res.frame.zTop - 0.5).area() < trimSide(res.solids.outerA, 'A', y0).slice(res.frame.zTop - 0.5).area() - 50);

  // boards (single): reliefs cover Mp exactly per half, slabs behind the plane
  const bA = solids.boardA, bB = solids.boardB;
  assert.ok(bA && bB, 'two single boards');
  for (const [side, board] of [['A', bA], ['B', bB]]) {
    const half = trimZ(trimSide(Mp, side, y0), res.frame.zFloor, res.frame.zTop);
    const missing = half.subtract(board).volume();
    assert.ok(missing < 0.01 * half.volume(), `board ${side} relief misses ${missing} of ${half.volume()} mm³`);
  }
  // silicone stage: shells and boards touch but do not overlap
  const pose = (id) => part(res, id).stages.silicone[0];
  const placed = (id) => solids[id].transform(pose(id));
  assert.ok(placed('shellA').intersect(placed('boardA')).volume() < 1, 'shell A / board A overlap');
  assert.ok(placed('shellB').intersect(placed('boardB')).volume() < 1, 'shell B / board B overlap');
  assert.ok(placed('boardA').intersect(placed('boardB')).volume() < 1e-6, 'the two assemblies are separate');

  // cast stage: clips (without interference) and pins do not collide with the shells
  const clipSites = res.analysis.clipSites;
  assert.ok(clipSites.length >= 4, `clips ${clipSites.length}`);
  const clip0 = buildClip(2 * P.flangeThickness, { ...P, clipInterference: 0 });
  const shells = A.add(B);
  for (const s of clipSites) {
    const c = clip0.transform(clipPose(s.e, [-s.n[0], -s.n[1]], y0));
    assert.ok(c.intersect(shells).volume() < 0.05, `clip at ${s.e} (${s.side}) collides with a shell`);
    assert.ok(c.boundingBox().min[2] >= res.frame.zFloor - 1e-6, `clip at ${s.e} protrudes below the floor`);
  }
  const pinCast = solids.pin_cast;
  for (const m of part(res, 'pin_cast').stages.cast) assert.ok(pinCast.transform(m).intersect(shells).volume() < 0.05, 'pin collides');
  assert.equal(part(res, 'pin_cast').quantity, res.analysis.pinSites.length);
  assert.equal(part(res, 'clip_silicone').quantity, 2 * clipSites.length, 'single boards: two assemblies');

  // silicone / cast previews + stats
  const vSil = solids.siliconeA.volume() + solids.siliconeB.volume();
  assert.ok(Math.abs(res.stats.siliconeVolume - vSil) / vSil < 0.05, `voxel silicone ${res.stats.siliconeVolume} vs mesh ${vSil}`);
  assert.ok(Math.abs(res.stats.castVolume - Manifold.cylinder(60, 10, 10, 64).volume()) < 1);
  assert.ok(Math.abs(res.stats.siliconeMassA + res.stats.siliconeMassB - res.stats.siliconeMass) < 1e-6);
  assert.ok(res.stats.moldMass > 0 && Math.abs(res.stats.moldMass - res.stats.moldMassA - res.stats.moldMassB) < 1e-6);
  assert.deepEqual(res.analysis.pourModes, ['extend']);
  assert.equal(res.analysis.vents.length, 0);
  assert.ok(res.instructions.length >= 8);
  for (const k of ['Preparing masters', 'Distance field', 'Shell surfaces', 'Masses & export meshes']) assert.ok(k in res.stats.timings, k);
});

test("moldbox boardStyle 'double': one board, shells at -T/2 / +T/2, valid parts", async () => {
  const res = await generate([await cylinderMaster()], { ...DRAFT, boardStyle: 'double' }, () => {}, { keepSolids: true });
  const P = resolveParams({ ...DRAFT, boardStyle: 'double' });
  const solids = checkPartsValid(res);
  assert.ok(solids.board && !solids.boardA, 'one double board');
  const T = P.boardThickness;
  const yA = part(res, 'shellA').stages.silicone[0][13], yB = part(res, 'shellB').stages.silicone[0][13];
  assert.ok(Math.abs(yA + T / 2) < 1e-9 && Math.abs(yB - T / 2) < 1e-9);
  const sA = solids.shellA.transform(part(res, 'shellA').stages.silicone[0]);
  const sB = solids.shellB.transform(part(res, 'shellB').stages.silicone[0]);
  assert.ok(sA.intersect(solids.board).volume() < 1 && sB.intersect(solids.board).volume() < 1, 'board sandwiched without overlap');
  assert.equal(part(res, 'clip_silicone').quantity, res.analysis.clipSites.length);
});

test("moldbox boardStyle 'none' and the cage option produce valid parts", async () => {
  const res = await generateMoldBox([await cylinderMaster()], { ...DRAFT, boardStyle: 'none', cage: true, ribs: true });
  const solids = checkPartsValid(res);
  assert.ok(!res.parts.some((p) => p.role === 'board'));
  assert.ok(solids.cageA && solids.cageB, 'cage halves');
  assert.ok(solids.cageA.volume() < solids.shellA.volume(), 'windows make the cage lighter');
  assert.ok(!part(res, 'shellA').stages.cast, 'with a cage the shells are used for the silicone stage only');
  assert.ok(solids.cageA.intersect(solids.siliconeA).volume() < 1, 'cage clears the silicone');
});

test("'h' master gets a vent", async () => {
  const res = await generateMoldBox([makeHShape()], DRAFT, () => {}, { keepSolids: true });
  assert.ok(res.analysis.vents.length >= 1, `vents ${res.analysis.vents.length}`);
  assert.deepEqual(res.analysis.pourModes, ['sprue']);
  const v = res.analysis.vents[0].p;
  assert.ok(Math.abs(v[0] - 15) < 3 && Math.abs(v[2] - 34) < 2, `vent over the short leg: ${v}`);
  const solids = checkPartsValid(res);
  // vents are inside the silicone envelope: the shells never touch the cast cavity
  assert.ok(solids.shellA.intersect(res.solids.Mp).volume() < 1);
  assert.ok(solids.shellB.intersect(res.solids.Mp).volume() < 1);
});

test('candle-like cone (wide end up): no vents, extend pour', async () => {
  const { Manifold } = await setup();
  const cone = meshFromManifold(Manifold.cylinder(45, 6, 18, 64));
  const res = await generateMoldBox([cone], { ...DRAFT, ribs: false });
  assert.equal(res.analysis.vents.length, 0);
  assert.deepEqual(res.analysis.pourModes, ['extend']);
  checkPartsValid(res);
});

test('support mode: shells around an existing form, no boards / silicone / channels', async () => {
  const { Manifold } = await setup();
  const form = meshFromManifold(Manifold.cylinder(50, 16, 16, 64));
  const progress = [];
  const res = await generate([form], { ...DRAFT, mode: 'support', cage: true }, (s) => progress.push(s), { keepSolids: true });
  const solids = checkPartsValid(res);
  assert.ok(solids.shellA && solids.shellB);
  assert.ok(!res.parts.some((p) => ['board', 'silicone', 'cast'].includes(p.role)), res.parts.map((p) => p.role).join());
  const P = resolveParams({ mode: 'support' });
  const F = res.solids.M;
  const gap = solids.shellA.minGap(F, 5);
  assert.ok(gap >= P.cageClearance - 0.5 && gap <= P.cageClearance + 2 * res.stats.voxelSize, `clearance ${gap}`);
  assert.ok(solids.shellA.intersect(F).volume() < 1);
  assert.ok(Math.abs(res.frame.zTop - 50) < 1e-6);
  assert.ok(progress.length >= 5);
  assert.ok(part(res, 'clip').stages.cast.length >= 4);
});

test('hollow master is filled and warned', async () => {
  const { Manifold } = await setup();
  const hollow = Manifold.cube([24, 20, 30], true).subtract(Manifold.cube([16, 12, 22], true)).translate([0, 0, 15]);
  const res = await generateMoldBox([meshFromManifold(hollow)], { ...DRAFT, ribs: false, boardStyle: 'none' }, () => {}, { keepSolids: true });
  assert.ok(res.warnings.some((w) => /hollow/.test(w)), res.warnings.join('\n'));
  assert.ok(Math.abs(res.stats.castVolume - 24 * 20 * 30) < 1);
  checkPartsValid(res);
});

test('wick: the wick channel is a leak path through the floor, the instructions say to plug it before the silicone pour', async () => {
  const res = await generateMoldBox([await cylinderMaster()], { ...DRAFT, wick: true, ribs: false }, () => {}, { keepSolids: true });
  // the wick hole really goes through the floor (cast stage needs it) ...
  assert.ok(res.solids.Mp.boundingBox().min[2] < res.frame.zFloor - 0.5, 'wick channel exits below the floor');
  // ... so the sealing step must tell the user to plug it for the silicone pour
  assert.ok(res.instructions.some((s) => /plug the wick hole/.test(s)), res.instructions.join('\n'));
});
