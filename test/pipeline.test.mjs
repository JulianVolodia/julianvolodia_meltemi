// End-to-end pipeline tests (quality 'draft', small masters).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup } from './helpers.mjs';
import { manifoldFromMesh, meshFromManifold, transformMesh } from '../src/core/meshio.js';
import { trimSide, trimZ, planeExtrude } from '../src/core/frame.js';
import { socketSolid } from '../src/core/features/pins.js';
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
  // shell A stays on y <= y0 except its registration pegs, which key into shell B's sockets
  assert.ok(A.trimByPlane([0, 1, 0], y0 + 1e-3).volume() > 0 === (P.registration !== 'pins'), 'pegs only in interlock mode');
  assert.ok(A.boundingBox().max[1] <= y0 + P.pegHeight + 0.06, 'shell A: nothing but pegs beyond y0');
  assert.ok(A.trimByPlane([0, 1, 0], y0 + 1e-3).intersect(B).volume() < 1e-3, 'pegs fit the sockets of shell B (no overlap)');
  assert.ok(B.boundingBox().min[1] >= y0 - 1e-6, 'shell B stays on y >= y0');
  assert.ok(Math.abs(A.boundingBox().min[2] - res.frame.zFloor) < 1e-6, 'stands on zFloor');
  assert.ok(A.boundingBox().max[2] <= res.frame.zPour + 1e-6, 'nothing above the collar dam (zPour)');
  // the top is open: just below the rim the shell does not reach into the cavity
  const zr = res.frame.zTop - 0.5;
  assert.ok(A.slice(zr).intersect(trimSide(res.solids.cavA, 'A', y0).slice(zr)).area() < 1, 'cavity open at the rim');

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
  if (P.registration === 'pins') {
    const pinCast = solids.pin_cast;
    for (const m of part(res, 'pin_cast').stages.cast) assert.ok(pinCast.transform(m).intersect(shells).volume() < 0.05, 'pin collides');
    assert.equal(part(res, 'pin_cast').quantity, res.analysis.pinSites.length);
  } else {
    assert.ok(!res.parts.some((p) => p.role === 'pin'), 'interlock: no loose pins');
  }
  assert.equal(part(res, 'clip_silicone').quantity, 2 * clipSites.length, 'single boards: two assemblies');

  // silicone / cast previews + stats
  const vSil = solids.siliconeA.volume() + solids.siliconeB.volume();
  assert.ok(Math.abs(res.stats.siliconeVolume - vSil) / vSil < 0.05, `voxel silicone ${res.stats.siliconeVolume} vs mesh ${vSil}`);
  assert.ok(Math.abs(res.stats.castNetVolume - Manifold.cylinder(60, 10, 10, 64).volume()) < 1);
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

test('interlock: a 6 mm flange shrinks the pegs so the sockets stay inside the flange edge', async () => {
  const res = await generate([await cylinderMaster()], { ...DRAFT, flangeWidth: 6 }, () => {}, { keepSolids: true });
  const P0 = resolveParams({ ...DRAFT, flangeWidth: 6 });
  assert.ok(res.analysis.pegSize < P0.pegSize, `effective peg size ${res.analysis.pegSize}`);
  assert.ok(res.warnings.some((w) => /Peg size reduced/.test(w)), res.warnings.join('; '));
  const P = { ...P0, pegSize: res.analysis.pegSize };
  const y0 = res.frame.y0, tf = P.flangeThickness;
  const inside = planeExtrude(res.solids.flange2D.offset(-0.8, 'Round'), y0 - 1, y0 + tf + 2);
  for (const s of res.analysis.pinSites) {
    assert.ok(socketSolid(s, y0, P, tf + 1).subtract(inside).volume() < 1e-6, `socket at ${s} leaves < 0.8 mm of flange`);
  }
  const solids = checkPartsValid(res);
  const pegs = solids.shellA.trimByPlane([0, 1, 0], y0 + 1e-3);
  assert.ok(pegs.volume() > 1 && pegs.intersect(solids.shellB).volume() < 1e-3, 'smaller pegs still key into shell B');
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
  assert.ok(Math.abs(res.stats.castNetVolume - 24 * 20 * 30) < 1, `net cast ${res.stats.castNetVolume}`);
  assert.ok(res.stats.castVolume > res.stats.castNetVolume, 'the real fill includes the riser');
  checkPartsValid(res);
});

test('wick: the wick channel is a leak path through the floor, the instructions say to plug it before the silicone pour', async () => {
  const res = await generateMoldBox([await cylinderMaster()], { ...DRAFT, wick: true, ribs: false }, () => {}, { keepSolids: true });
  // the wick hole really goes through the floor (cast stage needs it) ...
  assert.ok(res.solids.Mp.boundingBox().min[2] < res.frame.zFloor - 0.5, 'wick channel exits below the floor');
  // ... so the sealing step must tell the user to plug it for the silicone pour
  assert.ok(res.instructions.some((s) => /plug the wick hole/.test(s)), res.instructions.join('\n'));
});

test('silicone collar: dam + ledge on the shells, lip on the silicone, openings through it; collar:false keeps the flat rim', async () => {
  const { Manifold } = await setup();
  const res = await runCached('cyl', async () => generateMoldBox([await cylinderMaster()], DRAFT, () => {}, { keepSolids: true }));
  const P = resolveParams(DRAFT);
  const { zTop, zPour, y0 } = res.frame;
  assert.ok(Math.abs(zPour - zTop - P.collarHeight) < 1e-9, 'collar height');
  const solids = checkPartsValid(res);
  const A = solids.shellA, silA = solids.siliconeA;
  const probe = (m, p) => m.intersect(Manifold.cube([0.3, 0.3, 0.3], true).translate(p)).volume() > 0.01;
  // shell A outer wall along -Y at x = 0, measured below the ledge
  const outerY = trimSide(res.solids.outerA, 'A', y0).boundingBox().min[1];
  const o = P.collarOverhang, wd = P.wallThickness;
  assert.ok(!probe(A, [0, outerY - o / 2, zTop + 2]), 'overhang zone above the rim is free for silicone');
  assert.ok(probe(A, [0, outerY - o / 2, zTop - 0.5]), 'ledge supports the overhang');
  assert.ok(probe(A, [0, outerY - o - wd / 2, zTop + 2]), 'dam wall around the collar');
  assert.ok(!probe(A, [0, outerY - o - wd - 1, zTop + 2]), 'nothing outside the dam');
  assert.ok(probe(silA, [0, outerY - o / 2, zTop + 2]), 'silicone lip over the rim');
  assert.ok(Math.abs(silA.boundingBox().max[2] - zPour) < 0.1, 'silicone reaches the collar top');
  assert.ok(res.solids.Mp.boundingBox().max[2] >= zPour + 0.5, 'pour opening goes through the collar');
  assert.ok(A.intersect(silA).volume() < 30, `shell ∩ silicone ${A.intersect(silA).volume()}`);
  // 45° ledge: every 1 mm down the shell section grows by at most ~1 mm
  for (let dz = 0.5; dz < o + wd; dz += 1) {
    const w1 = A.slice(zTop - dz).bounds(), w2 = A.slice(zTop - dz - 1).bounds();
    assert.ok(w2.min[1] <= w1.min[1] + 1.05, `overhang at z ${zTop - dz}: ${w1.min[1]} vs ${w2.min[1]}`);
  }
  const flat = await generateMoldBox([await cylinderMaster()], { ...DRAFT, collar: false, boardStyle: 'none' }, () => {}, { keepSolids: true });
  assert.equal(flat.frame.zPour, flat.frame.zTop);
  const fA = checkPartsValid(flat).shellA;
  assert.ok(fA.boundingBox().max[2] <= flat.frame.zTop + 1e-6, 'no collar: rim at zTop');
});

test('silicone collar: the flange plate / board backs the collar pocket and dam at the parting plane even when the rounded flange corner recedes (narrow flange, wide overhang)', async () => {
  const { Manifold } = await setup();
  for (const boardStyle of ['single', 'double']) {
    const res = await generateMoldBox([await cylinderMaster()], { ...DRAFT, boardStyle, flangeWidth: 8, collarOverhang: 10 }, () => {}, { keepSolids: true });
    const { zTop, zPour, y0 } = res.frame;
    const solids = checkPartsValid(res);
    for (const side of ['A', 'B']) {
      const sh = part(res, `shell${side}`).stages.silicone[0];
      const bid = boardStyle === 'single' ? `board${side}` : 'board';
      const board = solids[bid].transform(part(res, bid).stages.silicone[0]);
      const toBoard = side === 'A' ? 0.5 : -0.5;
      const other = side === 'A' ? 'B' : 'A';
      // collar pocket (silicone lip) and dam, pushed 0.5 mm across the plane, must land inside the board
      const lip = trimZ(solids[`silicone${side}`], zTop + 0.2, zPour - 0.2).transform(sh);
      const dam = trimZ(solids[`shell${side}`], zTop + 0.2, zPour - 0.2).transform(sh);
      const yPlane = y0 + sh[13];
      for (const [name, s] of [['lip', lip], ['dam', dam]]) {
        const pushed = trimSide(s.translate([0, toBoard, 0]), other, yPlane);
        const open = pushed.subtract(board).volume();
        assert.ok(open < 1, `${boardStyle} ${side}: ${name} face at the parting plane not backed by the board (${open} mm³ open)`);
      }
    }
  }
});

test('end walls (±X) are broader by endWallExtra; endWallExtra 0 restores the uniform wall', async () => {
  const { CrossSection } = await setup();
  const measure = async (extra) => {
    const res = await generateMoldBox([await cylinderMaster()], { ...DRAFT, endWallExtra: extra, collar: false, ribs: false }, () => {}, { keepSolids: true });
    const { y0, zTop, zFloor } = res.frame;
    const P = resolveParams({ ...DRAFT, endWallExtra: extra });
    const z = (zTop + zFloor) / 2, yp = y0 - P.flangeThickness - 1.5; // just behind the flange plate
    const line = CrossSection.square([400, 0.2]).translate([-200, yp - 0.1]);
    const cav = trimSide(res.solids.cavA, 'A', y0).slice(z).intersect(line).bounds();
    const shell = checkPartsValid(res).shellA.slice(z).intersect(line).bounds();
    return { right: shell.max[0] - cav.max[0], left: cav.min[0] - shell.min[0], w: P.wallThickness };
  };
  const thin = await measure(0), thick = await measure(2.4);
  for (const k of ['left', 'right']) {
    assert.ok(Math.abs(thin[k] - thin.w) < 1.0, `uniform ${k} end wall ${thin[k]} ~ ${thin.w}`);
    assert.ok(thick[k] - thin[k] > 1.6, `broader ${k} end wall: ${thick[k]} vs ${thin[k]}`);
  }
});

test('real fills: silicone halves carry the key groove (A) / tongue (B) and the collar; the cast is the enclosed cavity incl. riser; no loose pins', async () => {
  const { Manifold } = await setup();
  const res = await runCached('cyl', async () => generateMoldBox([await cylinderMaster()], DRAFT, () => {}, { keepSolids: true }));
  const P = resolveParams(DRAFT);
  const { y0, zPour } = res.frame;
  assert.ok(!res.warnings.some((w) => /not closed|leak/.test(w)), res.warnings.join('\n'));
  assert.ok(!res.parts.some((p) => p.role === 'pin'), 'interlock mode: no loose pins');
  const solids = checkPartsValid(res);
  const silA = solids.siliconeA, silB = solids.siliconeB, cast = solids.cast;
  // tongue of B crosses the plane into A's groove; A has the matching groove (no material there)
  const tongue = silB.trimByPlane([0, -1, 0], -(y0 - 0.05));
  assert.ok(tongue.volume() > 10, `silicone B tongue ${tongue.volume()} mm³`);
  assert.ok(tongue.intersect(silA).volume() < 0.25 * tongue.volume(), 'the tongue sits in A\'s groove (only the squeeze clearance overlaps)');
  // the cast is what the halves enclose: it reaches the pour level and contains the master
  const M = res.solids.M;
  assert.ok(M.subtract(cast).volume() < 0.01 * M.volume(), 'cast contains the master');
  assert.ok(cast.boundingBox().max[2] > zPour - 0.2, 'riser up to the pour level');
  assert.ok(Math.abs(res.stats.castVolume - cast.volume()) < 1e-3 * cast.volume(), `cast ${res.stats.castVolume} vs ${cast.volume()}`);
  assert.ok(Math.abs(res.stats.siliconeVolume - (silA.volume() + silB.volume())) < 1, 'silicone stats are the real fills');
  // silicone fills do not overlap the shells (beyond the 0.02 mm seal)
  assert.ok(silA.intersect(solids.shellA).volume() < 5, `silA ∩ shellA ${silA.intersect(solids.shellA).volume()}`);
  assert.ok(silB.intersect(solids.shellB).volume() < 5, `silB ∩ shellB ${silB.intersect(solids.shellB).volume()}`);
});

test('enclosedFill: a closed container gives its interior, an open one is reported as leaking (null)', async () => {
  const { Manifold } = await setup();
  const { enclosedFill } = await import('../src/core/pipeline.js');
  const cup = Manifold.cube([20, 20, 20], true).subtract(Manifold.cube([16, 16, 20], true).translate([0, 0, 2])); // open top
  const fill = enclosedFill([cup], [-12, -12, -12], [12, 12, 10]);
  assert.ok(fill && Math.abs(fill.volume() - 16 * 16 * (10 - 0.05 + 8)) < 1, `fill ${fill && fill.volume()}`);
  const leaky = cup.subtract(Manifold.cylinder(30, 1, 1, 16).rotate([0, 90, 0]).translate([-15, 0, 0])); // hole through the walls
  assert.equal(enclosedFill([leaky], [-12, -12, -12], [12, 12, 10]), null);
});
