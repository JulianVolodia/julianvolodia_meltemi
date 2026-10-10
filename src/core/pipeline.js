// Mold-box pipeline (DESIGN.md §4) and mode B "support for an existing silicone form".
//
//   generateMoldBox(masters, params, onProgress)  masters (MeshData[] in the mold frame) -> Result
//   generateSupport(forms, params, onProgress)    outer surfaces of existing silicone forms -> Result
//   generate(masters, params, onProgress)         dispatch on params.mode
//
// Result = { parts: [{id, name, role, color, mesh, quantity, stages: {silicone?: Mat4[], cast?: Mat4[]},
//            printMatrix, printable, volume, mass}], stats, frame: {y0, zTop, zFloor, bboxMin, bboxMax},
//            warnings: string[], instructions: string[], analysis }
// Core module: no bare imports, no Node globals (runs in Web Workers); manifold via wasm.js.
import { resolveParams, mixFractions, CAST_MATERIALS } from './params.js';
import { manifoldFromMesh, meshFromManifold } from './meshio.js';
import { voxelizeManifold } from './sdf.js';
import { findAirTraps } from './analysis.js';
import { trimSide, trimZ, mat4Identity, mat4Translation, mat4Mul, unionAll } from './frame.js';
import { buildPourExtensions, buildWick, buildVents } from './features/channels.js';
import { shellGrid, buildShellFields, buildShells, regionBetween, CAV_LEVEL } from './features/shell.js';
import { buildFlangeGeometry, applyFlange } from './features/flanges.js';
import { buildRibs, ribPositions } from './features/ribs.js';
import { buildBoards } from './features/board.js';
import { collarOutline2D, buildCollarFrame, collarVoid, collarSilicone } from './features/collar.js';
import { buildClip, clipPose, clipPrintMatrix } from './features/clips.js';
import { buildPin, pinLengths, pinPose, pinHole, pinPrintMatrix } from './features/pins.js';
import { cutWindows } from './features/windows.js';

const MAX_VENTS = 12;
const SINGLE_GAP = 5; // display gap between the two single-board assemblies (silicone stage)

export const COLORS = {
  shellA: '#d9a441', shellB: '#c58f2c', board: '#e8c766', boardA: '#e8c766', boardB: '#dcb653',
  clip_silicone: '#43a047', clip_cast: '#2e7d32', clip: '#43a047',
  pin_silicone: '#26c6da', pin_cast: '#0097a7', pin: '#26c6da',
  siliconeA: '#3d7be0', siliconeB: '#5b93ef', cast: '#c62828', cageA: '#b39554', cageB: '#a0844a',
};

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
const tick = () => new Promise((r) => setTimeout(r, 0));

function isManifoldLike(x) {
  return x && typeof x.getMesh === 'function' && typeof x.volume === 'function';
}

/** Progress / timing helper: await step(label, frac, fn). */
function makeSteps(onProgress) {
  const timings = {};
  const report = (label, frac) => { try { onProgress(label, frac); } catch { /* UI errors never abort */ } };
  async function step(label, frac, fn) {
    report(label, frac);
    await tick();
    const t = now();
    const res = await fn();
    timings[label] = Math.round((timings[label] || 0) + (now() - t));
    return res;
  }
  return { step, timings, report };
}

/**
 * MeshData[] (or Manifolds) -> union M. Hollow masters (inner shells = negative-volume parts)
 * are filled: only the positive-volume parts are kept.
 */
export function prepareMasters(masters, warnings, label = 'Master') {
  const list = Array.isArray(masters) ? masters : [masters];
  if (!list.length) throw new Error('no masters given');
  const solids = [];
  list.forEach((mesh, i) => {
    const name = list.length > 1 ? `${label} ${i + 1}` : label;
    let m;
    if (isManifoldLike(mesh)) m = mesh;
    else {
      const r = manifoldFromMesh(mesh);
      for (const w of r.warnings) warnings.push(`${name}: ${w}`);
      m = r.manifold;
    }
    const parts = m.decompose();
    if (parts.length > 1) {
      const pos = parts.filter((p) => p.volume() > 1e-9);
      if (pos.length < parts.length) {
        warnings.push(`${name} is hollow (${parts.length - pos.length} inner shell(s)); it is molded as a solid.`);
        m = unionAll(pos);
      }
    }
    if (!m || m.isEmpty() || !(m.volume() > 0)) throw new Error(`${name} encloses no volume`);
    solids.push(m);
  });
  const M = unionAll(solids);
  const bb = M.boundingBox();
  const size = [0, 1, 2].map((a) => bb.max[a] - bb.min[a]);
  const maxDim = Math.max(...size);
  if (maxDim < 5) warnings.push(`${label}s are tiny (${maxDim.toFixed(2)} mm): check the units (millimetres expected).`);
  if (maxDim > 400) warnings.push(`${label}s are large (${maxDim.toFixed(0)} mm): print bed size and voxel resolution may be limiting.`);
  return M;
}

function volumeOf(m) {
  return m && !m.isEmpty() ? m.volume() : 0;
}

function dropMatrix(solid) {
  const bb = solid.boundingBox();
  return mat4Translation(0, 0, -bb.min[2]);
}

/** Shell pin holes for half `side`. */
function pinHolesFor(ctx, side) {
  const { y0, P } = ctx;
  const tf = P.flangeThickness;
  const holes = (ctx.pinSites || []).map((s) => (side === 'A' ? pinHole(s, y0 - tf - 1, y0 + 0.01, P) : pinHole(s, y0 - 0.01, y0 + tf + 1, P)));
  return unionAll(holes);
}

/** Final shell (or cage) half: flange-applied base [-> windows] ∪ ribs − pin holes − wick − cav − Mp. */
function finishHalf(ctx, side, base, { windows = false, wick = null } = {}) {
  const P = ctx.P;
  let s = base;
  let ribX = null;
  if (windows) {
    ribX = P.ribs ? ribPositions(ctx, side, base) : [];
    s = cutWindows(s, ctx, side, { ribX });
  }
  const ribs = P.ribs ? buildRibs(ctx, side) : null;
  if (ribs) s = s.add(ribs);
  const holes = pinHolesFor(ctx, side);
  if (holes) s = s.subtract(holes);
  if (wick) s = s.subtract(wick);
  if (ctx.collarVoid) s = s.subtract(ctx.collarVoid);
  const cav = side === 'A' ? ctx.cavA : ctx.cavB;
  if (cav) s = s.subtract(cav);
  if (ctx.Mp) s = s.subtract(ctx.Mp);
  if (s.status() !== 'NoError') throw new Error(`shell ${side}: invalid manifold (${s.status()})`);
  return { solid: s, ribX };
}

function heatWarning(P, warnings) {
  const pm = P.printMaterial === undefined || P.printMaterial === null ? 'pla' : String(P.printMaterial).toLowerCase();
  if ((P.castMaterial === 'wax' || P.castMaterial === 'resin') && pm === 'pla') {
    warnings.push(`PLA softens at ~55-60 °C; hot ${P.castMaterial === 'wax' ? 'wax (60-85 °C)' : 'resin exotherm (> 80 °C)'} can warp PLA shells and make clips creep — print the cast-stage parts (shells/cage, clips) in PETG or ASA.`);
  }
}

function fmtG(g) {
  return `${g >= 100 ? g.toFixed(0) : g.toFixed(1)} g`;
}

// ---------------------------------------------------------------------------------------------
// Core runner shared by both modes
// ---------------------------------------------------------------------------------------------

async function run(inputs, P, onProgress, opts, mode) {
  const { step, timings } = makeSteps(onProgress);
  const warnings = [];
  const support = mode === 'support';
  const keep = !!opts.keepSolids;
  const owned = new Set(); // manifolds to free at the end
  const own = (m) => { if (m && typeof m.delete === 'function') owned.add(m); return m; };
  const tStart = now();

  try {
    // ---- 1. masters ------------------------------------------------------------------------
    const M = await step(support ? 'Preparing form' : 'Preparing masters', 0.02, () => own(prepareMasters(inputs, warnings, support ? 'Form' : 'Master')));
    const bb = M.boundingBox();
    const y0 = (bb.min[1] + bb.max[1]) / 2 + (Number(P.partingOffset) || 0);
    const d1 = support ? P.cageClearance : P.siliconeThickness;
    const w = P.wallThickness;
    const tf = P.flangeThickness;
    const T = P.boardThickness;
    const zTop = support ? bb.max[2] : bb.max[2] + P.topExtension;
    const zFloor = bb.min[2] - d1 - w - (P.baseExtra || 0);
    // silicone collar at the pour end: the silicone continues collarHeight above the rim
    const zPour = !support && P.collar ? zTop + Math.max(0, Number(P.collarHeight) || 0) : zTop;
    if (!(y0 > bb.min[1] && y0 < bb.max[1])) warnings.push(`Parting plane y0 = ${y0.toFixed(2)} does not cut the ${support ? 'form' : 'masters'} (partingOffset too large).`);

    // ---- 2. channels, vents -----------------------------------------------------------------
    const analysis = { pourModes: [], vents: [], siliconeTraps: [] };
    let Mpour = M, wick = null, grid;
    let Msdf, Mp;
    await step('Generating channels and funnel', 0.08, () => {
      if (!support) {
        const info = { modes: [] };
        const pour = own(buildPourExtensions(M, P, y0, zPour, info));
        analysis.pourModes = info.modes.map((m) => m.mode);
        Mpour = pour ? own(M.add(pour)) : M;
        if (P.wick) {
          const r = buildWick(M, P, y0, zFloor);
          wick = own(r.solid);
          warnings.push(...r.warnings);
        }
      }
      const bp = Mpour.boundingBox();
      grid = shellGrid([...bp.min], [...bp.max], P, { d1, extra: !support && P.cage ? P.cageClearance : 0 });
    });
    const h = grid.h;
    if (h > Math.min(1, 0.15 * d1) && !support) warnings.push(`Voxel size ${h.toFixed(2)} mm is coarse for ${d1} mm of silicone; use quality 'normal'/'fine' for the final mold.`);

    await step('Voxelizing', 0.14, () => {
      let vents = null;
      if (!support && P.vents) {
        const occ = voxelizeManifold(Mpour, grid);
        let traps = findAirTraps(occ, grid, { zTop: zPour, minDepth: P.ventMinDepth });
        if (traps.length > MAX_VENTS) {
          warnings.push(`${traps.length} air traps found; only the ${MAX_VENTS} deepest get vents — consider re-orienting the master.`);
          traps = [...traps].sort((a, b) => b.depth - a.depth).slice(0, MAX_VENTS);
        }
        analysis.vents = traps.map((t) => ({ p: t.p, depth: t.depth }));
        vents = own(buildVents(traps, P, y0, zPour));
      }
      Msdf = vents ? own(Mpour.add(vents)) : Mpour;
      Mp = wick ? own(Msdf.add(wick)) : Msdf;
    });

    // ---- 3. fields --------------------------------------------------------------------------
    let fields = await step('Distance field', 0.2, () => buildShellFields(Msdf, P, y0, { grid, d1, zFloor }));

    // ---- 4. shells --------------------------------------------------------------------------
    const sh = await step('Shell surfaces', 0.32, () => buildShells(fields, P, y0, zTop, zFloor, { Mp: Msdf, warnings, label: support ? 'Support' : 'Shell' }));
    for (const k of Object.keys(sh)) own(sh[k]);

    // silicone volume + bubble-prone ceilings of the silicone pour (voxel estimate, ±3 %)
    let sil = null;
    if (!support) {
      sil = await step('Silicone volume', 0.5, () => {
        const occMp = voxelizeManifold(Mp, grid);
        const reg = regionBetween(fields, y0, zFloor, zTop, occMp, CAV_LEVEL * h);
        const traps = findAirTraps(reg.occ, grid, { zTop, minDepth: P.ventMinDepth });
        analysis.siliconeTraps = traps.map((t) => ({ p: t.p, depth: t.depth }));
        if (traps.length) {
          warnings.push(`${traps.length} bubble-prone ceiling(s) in the silicone pour (downward-facing surfaces of the master/reliefs): brush a thin detail coat of silicone onto the reliefs before closing the box, pour slowly in a thin stream, or drill Ø1 mm bleed holes through the shell above them.`);
        }
        return { volA: reg.volA, volB: reg.volB };
      });
    }

    // optional cage around the silicone (moldbox mode): same fields, offset by cageClearance
    let cageSh = null;
    if (!support && P.cage) {
      cageSh = await step('Support cage', 0.55, () => buildShells(fields, P, y0, zTop, zFloor, { Mp: Msdf, warnings, extra: P.cageClearance, label: 'Cage' }));
      for (const k of Object.keys(cageSh)) own(cageSh[k]);
    }
    fields.phiCavA = fields.phiCavB = fields.phiOutA = fields.phiOutB = null;
    fields = null;

    // ---- 5. flanges, pins, clip sites ---------------------------------------------------------
    const ctx = {
      P, y0, zTop, zPour, zFloor, h, warnings, Mp, Msdf,
      cavA: sh.cavA, cavB: sh.cavB, outerA: sh.outerA, outerB: sh.outerB,
      collar2D: null, collarVoid: null,
      shellA: null, shellB: null, outline2D: null, flange2D: null, pinSites: [], clipSites: [],
      yBackA: null, yBackB: null,
    };
    await step('Flanges, pins & clips', 0.62, () => {
      // collar outline first: the flange plate must back the collar pocket and its dam at the plane
      ctx.collar2D = zPour > zTop ? collarOutline2D(ctx) : null;
      const fl = buildFlangeGeometry(ctx);
      warnings.push(...fl.warnings);
      Object.assign(ctx, { outline2D: fl.outline2D, flange2D: fl.flange2D, pinSites: fl.pinSites, clipSites: fl.clipSites });
      ctx.shellA = own(applyFlange(sh.shellA, ctx, 'A'));
      ctx.shellB = own(applyFlange(sh.shellB, ctx, 'B'));
      // collar dam + 45° ledge (before the back planes are measured: the dam may stick out)
      if (ctx.collar2D) {
        ctx.collarVoid = own(collarVoid(ctx));
        for (const side of ['A', 'B']) {
          const frame = buildCollarFrame(ctx, side);
          if (frame) {
            const key = side === 'A' ? 'shellA' : 'shellB';
            ctx[key] = own(ctx[key].add(frame));
          }
        }
      } else if (zPour > zTop) {
        warnings.push('Could not build the silicone collar (no shell section at the rim); the collar was skipped.');
      }
      ctx.yBackA = ctx.shellA.boundingBox().min[1];
      ctx.yBackB = ctx.shellB.boundingBox().max[1];
    });

    // ---- 6. ribs + final shells ---------------------------------------------------------------
    const windowsOnShell = support && !!P.cage;
    const fin = await step('Ribs & feet', 0.7, () => ({
      A: finishHalf(ctx, 'A', ctx.shellA, { windows: windowsOnShell, wick }),
      B: finishHalf(ctx, 'B', ctx.shellB, { windows: windowsOnShell, wick }),
    }));
    own(fin.A.solid); own(fin.B.solid);

    // ---- 7. boards ----------------------------------------------------------------------------
    let boards = { boards: [], shellOffsetY: { A: 0, B: 0 } };
    const style = support ? 'none' : (P.boardStyle || 'double');
    if (style !== 'none') {
      boards = await step('Parting board & keys', 0.78, () => buildBoards(ctx));
      for (const b of boards.boards) own(b.solid);
      if (P.keys && P.siliconeThickness < 6) warnings.push(`Silicone thickness ${P.siliconeThickness} mm < 6 mm: the key groove/tongue leaves thin silicone webs (~${Math.max(0, P.keyOffset - P.keyWidth / 2).toFixed(1)} mm) that can tear; use >= 6 mm or disable keys.`);
    }

    // ---- 8. support cage (moldbox mode) ------------------------------------------------------
    let cage = null;
    if (cageSh) {
      cage = await step('Support cage', 0.84, () => {
        const ctxC = { ...ctx, cavA: cageSh.cavA, cavB: cageSh.cavB, outerA: cageSh.outerA, outerB: cageSh.outerB };
        ctxC.shellA = own(applyFlange(cageSh.shellA, ctxC, 'A'));
        ctxC.shellB = own(applyFlange(cageSh.shellB, ctxC, 'B'));
        ctxC.yBackA = ctxC.shellA.boundingBox().min[1];
        ctxC.yBackB = ctxC.shellB.boundingBox().max[1];
        return {
          A: own(finishHalf(ctxC, 'A', ctxC.shellA, { windows: true, wick }).solid),
          B: own(finishHalf(ctxC, 'B', ctxC.shellB, { windows: true, wick }).solid),
        };
      });
    }

    // ---- 9. parts, masses, export meshes -------------------------------------------------------
    const result = await step('Masses & export meshes', 0.9, () => {
      const parts = [];
      const rhoP = P.densityPrint, rhoS = P.densitySilicone, rhoC = P.densityCast;
      const I = mat4Identity();
      const add = (id, name, role, solid, { quantity = 1, stages = {}, printMatrix = null, printable = true, density = rhoP, volume } = {}) => {
        if (!solid || solid.isEmpty()) return null;
        const vol = volume ?? solid.volume();
        const part = {
          id, name, role, color: COLORS[id] || '#9aa4b2',
          mesh: meshFromManifold(solid), quantity, stages,
          printMatrix: printMatrix || dropMatrix(solid), printable,
          volume: vol, mass: (vol / 1000) * density,
        };
        parts.push(part);
        return part;
      };

      const offA = style === 'single' ? -(T + SINGLE_GAP) : boards.shellOffsetY.A || 0;
      const offB = style === 'single' ? T + SINGLE_GAP : boards.shellOffsetY.B || 0;
      const castShells = !cage; // with a cage the cast stage uses the cage, not the shells
      const nameHalf = support ? 'Support half' : 'Shell half';
      const pA = add('shellA', `${nameHalf} A`, 'shell', fin.A.solid, {
        stages: support ? { cast: [I] } : { silicone: [mat4Translation(0, offA, 0)], ...(castShells ? { cast: [I] } : {}) },
      });
      const pB = add('shellB', `${nameHalf} B`, 'shell', fin.B.solid, {
        stages: support ? { cast: [I] } : { silicone: [mat4Translation(0, offB, 0)], ...(castShells ? { cast: [I] } : {}) },
      });

      let boardMass = 0;
      for (const b of boards.boards) {
        const off = b.id === 'boardA' ? offA : b.id === 'boardB' ? offB : 0;
        const pose = style === 'single' ? mat4Mul(mat4Translation(0, off, 0), b.poseSilicone) : b.poseSilicone;
        const p = add(b.id, b.name, 'board', b.solid, { stages: { silicone: [pose] }, printMatrix: b.printMatrix });
        if (p) boardMass += p.mass;
      }

      // clips & pins
      const sites = ctx.clipSites;
      const inward = (s) => [-s.n[0], -s.n[1]];
      const L = pinLengths({ ...P, boardStyle: style });
      const castClipPoses = sites.map((s) => clipPose(s.e, inward(s), y0));
      const castPinPoses = ctx.pinSites.map((s) => pinPose(s, y0 - tf + 0.2));
      let clipsMass = 0, pinsMass = 0;
      const clipCast = sites.length ? own(buildClip(2 * tf, P)) : null;
      const pinCast = ctx.pinSites.length ? own(buildPin(L.cast, P)) : null;
      if (style === 'none') {
        const stages = support ? { cast: castClipPoses } : { silicone: castClipPoses, cast: castClipPoses };
        const c = add('clip', 'Clip', 'clip', clipCast, { quantity: sites.length, stages, printMatrix: clipPrintMatrix(P) });
        if (c) clipsMass += c.mass * c.quantity;
        const pstages = support ? { cast: castPinPoses } : { silicone: castPinPoses, cast: castPinPoses };
        const p = add('pin', 'Pin', 'pin', pinCast, { quantity: ctx.pinSites.length, stages: pstages, printMatrix: pinPrintMatrix() });
        if (p) pinsMass += p.mass * p.quantity;
      } else {
        let silClipPoses, silPinPoses, sandwich;
        if (style === 'single') {
          sandwich = tf + T;
          const yA = y0 + offA + (T - tf) / 2, yB = y0 + offB + (tf - T) / 2;
          silClipPoses = [...sites.map((s) => clipPose(s.e, inward(s), yA)), ...sites.map((s) => clipPose(s.e, inward(s), yB))];
          silPinPoses = [...ctx.pinSites.map((s) => pinPose(s, y0 + offA - tf + 0.2)), ...ctx.pinSites.map((s) => pinPose(s, y0 + offB - T + 0.2))];
        } else {
          sandwich = 2 * tf + T;
          silClipPoses = sites.map((s) => clipPose(s.e, inward(s), y0));
          silPinPoses = ctx.pinSites.map((s) => pinPose(s, y0 - T / 2 - tf + 0.2));
        }
        const clipSil = sites.length ? own(buildClip(sandwich, P)) : null;
        const pinSil = ctx.pinSites.length ? own(buildPin(L.silicone, P)) : null;
        for (const [id, name, solid, poses, stage] of [
          ['clip_silicone', `Clip, silicone stage (${sandwich.toFixed(1)} mm)`, clipSil, silClipPoses, 'silicone'],
          ['clip_cast', `Clip, cast stage (${(2 * tf).toFixed(1)} mm)`, clipCast, castClipPoses, 'cast'],
        ]) {
          const c = add(id, name, 'clip', solid, { quantity: poses.length, stages: { [stage]: poses }, printMatrix: clipPrintMatrix(P) });
          if (c) clipsMass += c.mass * c.quantity;
        }
        for (const [id, name, solid, poses, stage] of [
          ['pin_silicone', `Pin, long (${L.silicone.toFixed(1)} mm)`, pinSil, silPinPoses, 'silicone'],
          ['pin_cast', `Pin, short (${L.cast.toFixed(1)} mm)`, pinCast, castPinPoses, 'cast'],
        ]) {
          const p = add(id, name, 'pin', solid, { quantity: poses.length, stages: { [stage]: poses }, printMatrix: pinPrintMatrix() });
          if (p) pinsMass += p.mass * p.quantity;
        }
      }

      // cage halves
      let cageMass = 0;
      if (cage) {
        for (const [id, side, solid] of [['cageA', 'A', cage.A], ['cageB', 'B', cage.B]]) {
          const p = add(id, `Support cage ${side}`, 'cage', solid, { stages: { cast: [I] } });
          if (p) cageMass += p.mass;
        }
      }

      // silicone halves and cast (previews)
      let siliconeVolume = 0, castVolume = 0;
      const silMass = { A: 0, B: 0 };
      if (!support) {
        for (const side of ['A', 'B']) {
          const cav = side === 'A' ? sh.cavA : sh.cavB;
          let solid = own(trimZ(trimSide(cav, side, y0), zFloor, zTop).subtract(Mp));
          const lip = ctx.collar2D ? own(collarSilicone(ctx, side)) : null;
          const vLip = lip ? lip.volume() : 0;
          if (lip) solid = own(solid.add(lip));
          const vVox = (side === 'A' ? sil.volA : sil.volB) + vLip;
          const p = add(`silicone${side}`, `Silicone half ${side}`, 'silicone', solid, {
            stages: { cast: [I] }, printable: false, density: rhoS, printMatrix: I,
          });
          if (p) { p.voxelVolume = vVox; }
          silMass[side] = (vVox / 1000) * rhoS;
          siliconeVolume += vVox;
        }
        castVolume = volumeOf(M);
        add('cast', `Cast (${(CAST_MATERIALS[P.castMaterial] || {}).label || P.castMaterial})`, 'cast', M, {
          stages: { cast: [I] }, printable: false, density: rhoC, printMatrix: I, volume: castVolume,
        });
      }

      const [fa, fb] = mixFractions(P.siliconeMixRatio);
      const ratio = String(P.siliconeMixRatio || '1:1').split(':').map(Number);
      const siliconeMass = (siliconeVolume / 1000) * rhoS;
      const moldMassA = pA ? pA.mass : 0, moldMassB = pB ? pB.mass : 0;
      const stats = {
        moldMass: moldMassA + moldMassB, moldMassA, moldMassB,
        boardMass, clipsMass, pinsMass, cageMass,
        printMassTotal: moldMassA + moldMassB + boardMass + clipsMass + pinsMass + cageMass,
        siliconeVolume, siliconeMass,
        siliconeMix: { a: ratio[0] > 0 ? ratio[0] : 1, b: ratio[1] > 0 ? ratio[1] : 1 },
        siliconeMassA: siliconeMass * fa, siliconeMassB: siliconeMass * fb,
        siliconeHalves: { A: silMass.A, B: silMass.B },
        castVolume, castMass: (castVolume / 1000) * rhoC,
        voxelSize: h,
        grid: [grid.nx, grid.ny, grid.nz],
        timings,
      };
      if (support) {
        for (const k of ['siliconeVolume', 'siliconeMass', 'siliconeMix', 'siliconeMassA', 'siliconeMassB', 'siliconeHalves', 'castVolume', 'castMass']) delete stats[k];
      }
      return { parts, stats };
    });

    heatWarning(P, warnings);
    const instructions = support ? supportInstructions(result.parts, P) : moldInstructions(result.parts, P, result.stats, style, !!P.wick, !!cage, analysis);
    result.stats.timings.total = Math.round(now() - tStart);
    const out = {
      parts: result.parts,
      stats: result.stats,
      frame: { y0, zTop, zPour, zFloor, bboxMin: [...bb.min], bboxMax: [...bb.max] },
      warnings: [...new Set(warnings)],
      instructions,
      analysis: {
        pourModes: analysis.pourModes,
        vents: analysis.vents,
        siliconeTraps: analysis.siliconeTraps,
        pinSites: ctx.pinSites,
        clipSites: ctx.clipSites,
      },
    };
    if (keep) {
      out.solids = {
        M, Mp, Msdf, cavA: sh.cavA, cavB: sh.cavB, outerA: sh.outerA, outerB: sh.outerB,
        shellA: fin.A.solid, shellB: fin.B.solid, boards: boards.boards.map((b) => b.solid), cage,
        flange2D: ctx.flange2D, outline2D: ctx.outline2D, grid,
      };
    }
    return out;
  } finally {
    if (!keep) {
      for (const m of owned) {
        try { if (!inputs.includes?.(m)) m.delete(); } catch { /* already freed */ }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------------------------

function qtyOf(parts, id) {
  const p = parts.find((x) => x.id === id);
  return p ? p.quantity : 0;
}

function printList(parts) {
  return parts.filter((p) => p.printable).map((p) => `${p.quantity} x ${p.name}`).join(', ');
}

function moldInstructions(parts, P, stats, style, wick, cage, analysis) {
  const S = [];
  const castMat = (CAST_MATERIALS[P.castMaterial] || { label: P.castMaterial }).label;
  S.push(`Print: ${printList(parts)}. Shells upright as exported (open top up), boards as exported, clips flat, pins standing. PETG is recommended for every part used while casting hot material (PLA is fine for the silicone stage only); 0.2 mm layers, 4 perimeters, 15-25 % infill, 100 % for clips and pins.`);
  S.push('Clean up the board reliefs (light sanding / primer gives a smoother cast), then coat every printed surface that will touch silicone — board reliefs, board faces, shell interiors and flange faces — with a release agent (mold-release spray or a thin film of vaseline). Platinum silicones can be cure-inhibited by some prints: do a small test first, or use tin-cure silicone.');
  if (style === 'double') {
    S.push(`Assemble shell A | parting board | shell B: push the ${qtyOf(parts, 'pin_silicone')} long pins through the flange and board holes and clamp the sandwich with the ${qtyOf(parts, 'clip_silicone')} silicone-stage clips (bottom clips first, then the sides from the bottom up).`);
  } else if (style === 'single') {
    S.push(`Assemble two boxes: shell A + board A and shell B + board B, each pinned with long pins and clamped with silicone-stage clips (${qtyOf(parts, 'pin_silicone')} pins and ${qtyOf(parts, 'clip_silicone')} clips in total, bottom clips first).`);
  } else {
    S.push('Fix the master in shell A (no parting board), close with shell B, pins and clips.');
  }
  S.push(`Seal every external flange/board seam and the bottom edge with hot glue, plasticine or vaseline so the silicone cannot leak${wick ? ', and plug the wick hole under the floor (the wick channel connects the cavity to the outside) with a blob of putty' : ''}; stand the box upright on its floor/ribs on a level surface.`);
  const mix = `${fmtG(stats.siliconeMassA)} part A + ${fmtG(stats.siliconeMassB)} part B (ratio ${P.siliconeMixRatio} by weight)`;
  const halves = style === 'single' ? ` — box A needs ${fmtG(stats.siliconeHalves.A)}, box B ${fmtG(stats.siliconeHalves.B)}` : '';
  S.push(`Weigh ${fmtG(stats.siliconeMass)} of silicone = ${mix}${halves}; mix ~10 % extra for losses. Mix thoroughly, degas if you can, brush a thin detail coat onto the reliefs, then pour in a thin, steady stream into the open top${P.collar ? ` until the silicone fills the collar pocket up to the top of the dam (${Number(P.collarHeight)} mm above the shell rim) — this forms the silicone collar` : ' until the silicone reaches the rim'}.`);
  S.push('Let the silicone cure completely (see its datasheet), then remove clips and pins, pull the shells off along ±Y and peel the parting board(s) out of the silicone halves.');
  if (wick) S.push('Thread the wick through the wick channel (split on the parting plane) and keep it centred and taut with a wick bar or clothes peg across the top opening; seal the hole under the floor with a little putty.');
  S.push(cage
    ? `Put the silicone halves into the support cage halves, join them with the ${qtyOf(parts, 'pin_cast')} short pins and clamp with the ${qtyOf(parts, 'clip_cast')} cast-stage clips.`
    : `Put the silicone halves back into shell A and shell B${P.collar ? ' (each collar lip seats on its shell rim inside the dam, so the skin hangs from it and cannot slide down)' : ''}, join the halves with the ${qtyOf(parts, 'pin_cast')} short pins and clamp with the ${qtyOf(parts, 'clip_cast')} cast-stage clips.`);
  const vents = analysis.vents && analysis.vents.length ? ` The ${analysis.vents.length} vent channel(s) let trapped air out — stop when material appears in them.` : '';
  S.push(`Pour ${fmtG(stats.castMass)} of ${castMat.toLowerCase()} (+ ~15 % for top-ups and the riser) through the opening(s) at the top.${vents}`);
  S.push(P.castMaterial === 'wax'
    ? 'Wax shrinks 10-15 % while it sets: top up the sink at the pour face once the first pour has skinned over, then level the base.'
    : 'Top up the pour face after the material has settled/shrunk, then let it cure.');
  S.push('Demold: remove the clips and pins, pull the shells (or cage) off along ±Y, open the silicone halves and take the cast out. Trim the pour stub and vent sprues.');
  return S;
}

function supportInstructions(parts, P) {
  const S = [];
  S.push(`Print: ${printList(parts)}. Support halves upright as exported, clips flat, pins standing; PETG recommended when casting hot material.`);
  S.push(`Check the fit: the support leaves ${P.cageClearance} mm clearance around the silicone form.`);
  S.push(`Place the closed silicone form into support half A, close with half B, insert the ${qtyOf(parts, 'pin')} pins and clamp with the ${qtyOf(parts, 'clip')} clips.`);
  S.push('Stand the support on its floor/ribs, pour the casting material into the form, top up after shrinkage and let it set.');
  S.push('Demold: remove the clips and pins, pull the halves off along ±Y and take the form out.');
  return S;
}

// ---------------------------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------------------------

/**
 * Mold box (shells, board(s), clips, pins, previews of silicone and cast) for masters given in
 * the mold frame (Z up = pour direction, parting plane y = bbox centre + partingOffset).
 * @param {Array<{positions: Float32Array, indices: Uint32Array}>} masters
 * @param {object} params user parameters (see params.js)
 * @param {(step: string, fraction: number) => void} [onProgress]
 * @param {{keepSolids?: boolean}} [opts] keepSolids: also return the internal Manifolds (tests)
 */
export async function generateMoldBox(masters, params = {}, onProgress = () => {}, opts = {}) {
  const P = resolveParams({ ...params, mode: 'moldbox' });
  return run(masters, P, onProgress, opts, 'moldbox');
}

/**
 * Support (mother mold) for existing silicone forms: input = outer surface of the form;
 * clearance d1 = cageClearance; flanges, pins, clips, ribs; windows when params.cage.
 */
export async function generateSupport(forms, params = {}, onProgress = () => {}, opts = {}) {
  const P = resolveParams({ ...params, mode: 'support' });
  return run(Array.isArray(forms) ? forms : [forms], P, onProgress, opts, 'support');
}

/** Dispatch on params.mode ('moldbox' default | 'support'). */
export async function generate(masters, params = {}, onProgress = () => {}, opts = {}) {
  return (params && params.mode === 'support')
    ? generateSupport(masters, params, onProgress, opts)
    : generateMoldBox(masters, params, onProgress, opts);
}
