// Flanges, pin sites and clip sites (DESIGN.md §4 step 5).
//
//   O  = planeSlice(outerA ∪ outerB, y0)                  outline of the shells on the plane
//   F  = hull(O).offset(flangeWidth) ∩ {zFloor <= z <= zTop}  flange outline (minus bottom-clip notches)
//   pins  on the mid-curve offset(hull(O), 0.45 f), P.pinsPerSide per vertical side, spread
//         between zFloor + f and zTop - f (+ one at the bottom centre when the floor is deep enough)
//   clips on the straight left/right edges of F (P.clipsPerSide, 0/'auto' -> ceil(height / 50)),
//         shifted away from pins; bottom clips sit in notches at the bottom of the two flange
//         strips (beside the shell body) so they never protrude below the floor the mold stands on.
//
// clipSites[i] = { e: [x, z] point on the flange edge, n: [nx, nz] OUTWARD unit normal of the edge
// (clips.clipPose takes the inward normal -n), side: 'left'|'right'|'bottom' }.
// Core module: manifold comes from wasm.js (no bare imports).
import { mf } from '../wasm.js';
import { planeSlice, planeExtrude, rect2 } from '../frame.js';
import { siteRadius } from './pins.js';

const BIG = 1e5;
const NOTCH_CLEAR = 0.5; // side clearance of a bottom-clip notch
const NOTCH_EXTRA = 0.3; // notch height above the clip spine

/** Crossings of the polygon set with the horizontal line z: [{x, dx, dz}] sorted by x. */
export function crossingsAtZ(polys, z) {
  const out = [];
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xa, za] = poly[j], [xb, zb] = poly[i];
      if ((za > z) !== (zb > z)) {
        const x = xa + ((z - za) * (xb - xa)) / (zb - za);
        out.push({ x, dx: xb - xa, dz: zb - za });
      }
    }
  }
  return out.sort((a, b) => a.x - b.x);
}

/** Outward unit normal (x, z) of a crossing edge on the left (sgn -1) or right (sgn +1) side. */
function edgeNormal(c, sgn) {
  let nx = c.dz, nz = -c.dx;
  const L = Math.hypot(nx, nz) || 1;
  nx /= L; nz /= L;
  if (nx * sgn < 0) { nx = -nx; nz = -nz; }
  return [nx, nz];
}

/** Evenly spread n values over [lo, hi] (centre for n = 1). */
function spread(n, lo, hi) {
  if (n <= 0) return [];
  if (n === 1 || !(hi > lo)) return [(lo + hi) / 2];
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

/**
 * Place n positions near their nominal spread in [lo, hi], outside the open keep-out intervals
 * and at least minSep apart (each nominal position moves to the nearest admissible spot).
 */
export function placeAvoiding(n, lo, hi, keepOuts, minSep) {
  if (n <= 0) return [];
  if (!(hi >= lo)) { lo = hi = (lo + hi) / 2; }
  const placed = [];
  const free = (z) => keepOuts.every(([a, b]) => !(z > a + 1e-9 && z < b - 1e-9)) && placed.every((q) => Math.abs(q - z) >= minSep - 1e-9);
  for (const z of spread(n, lo, hi)) {
    const cands = [z, lo, hi];
    for (const [a, b] of keepOuts) cands.push(a, b);
    for (const q of placed) cands.push(q - minSep, q + minSep);
    let best = null, bd = Infinity;
    for (const c of cands) {
      if (c < lo - 1e-9 || c > hi + 1e-9 || !free(c)) continue;
      const d = Math.abs(c - z);
      if (d < bd) { bd = d; best = c; }
    }
    if (best !== null) placed.push(best);
  }
  return placed.sort((a, b) => a - b);
}

/** Number of side clips per side (P.clipsPerSide; 0 / 'auto' / invalid -> ceil(height / 50)). */
export function clipsPerSideFor(P, height) {
  const n = Number(P.clipsPerSide);
  if (P.clipsPerSide === 'auto' || !(n > 0)) return Math.max(1, Math.ceil(height / 50));
  return Math.round(n);
}

/**
 * Shared z layout of the side pins and side clips (same on both sides). Pins and clips keep
 * |z_pin - z_clip| >= keep; clips keep >= clipSep from each other. Candidates: (a) pins evenly
 * spread (requested count, then down to 2) with clips shifted around them; (b) clips evenly
 * spread with pins in the gaps between them (interleaved). Preference: >= 1 clip, >= 2 pins,
 * then the most clips, then the most pins.
 * @returns {{pins: number[], clips: number[]}}
 */
export function layoutPinsAndClips(nP, nC, [pLo, pHi], [cLo, cHi], keep, clipSep) {
  const cands = [];
  const pinCounts = [];
  for (let p = nP; p >= Math.min(nP, 2); p--) pinCounts.push(p);
  for (const p of pinCounts) {
    const pins = p > 0 ? spread(p, pLo, pHi) : [];
    const clips = placeAvoiding(nC, cLo, cHi, pins.map((z) => [z - keep, z + keep]), clipSep);
    cands.push({ pins, clips });
  }
  for (let c = nC; c >= 2; c--) {
    const clips = spread(c, cLo, cHi);
    if (clips.length > 1 && clips[1] - clips[0] < Math.max(2 * keep, clipSep)) continue;
    const mids = [];
    for (let i = 0; i + 1 < clips.length; i++) {
      const z = (clips[i] + clips[i + 1]) / 2;
      if (z >= pLo - 1e-9 && z <= pHi + 1e-9) mids.push(z);
    }
    const p = Math.min(nP, mids.length);
    const pins = p <= 0 ? [] : p === mids.length ? mids : spread(p, 0, mids.length - 1).map((t) => mids[Math.round(t)]);
    cands.push({ pins: [...new Set(pins)], clips });
  }
  let best = { pins: [], clips: [] }, bestScore = -1;
  for (const c of cands) {
    // at least one clip per side first (the halves must be clamped), then >= 2 pins (alignment),
    // then as many clips as asked (seal), then pins
    const score = (c.clips.length >= Math.min(1, nC) ? 1000 : 0) + (c.pins.length >= Math.min(2, nP) ? 100 : 0) +
      2 * Math.min(c.clips.length, nC) + Math.min(c.pins.length, nP);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/**
 * Flange outline, pin sites and clip sites.
 * @param {object} ctx pipeline context (P, y0, zTop, zFloor, outerA, outerB, cavA, cavB, Mp)
 * @returns {{outline2D, flange2D, pinSites: number[][], clipSites: object[], warnings: string[]}}
 */
export function buildFlangeGeometry(ctx) {
  const { CrossSection } = mf();
  const { P, y0, zTop, zFloor } = ctx;
  const f = P.flangeWidth;
  const warnings = [];
  const outline2D = planeSlice(ctx.outerA, y0).add(planeSlice(ctx.outerB, y0));
  if (outline2D.isEmpty()) throw new Error('flanges: the shells do not reach the parting plane');
  const hullO = outline2D.hull();
  // the flange plate also closes the collar pocket at the parting plane (up to zPour)
  const zClip = rect2(-BIG, zFloor, BIG, Math.max(zTop, ctx.zPour ?? zTop));
  let F = hullO.offset(f, 'Round', 2, 64).intersect(zClip);
  // The collar pocket and its dam must be backed by the plate / board at the parting plane. The
  // rounded flange corner recedes above zTop (by f - sqrt(f² - h²) at the collar top), so with a
  // narrow flange, a tall collar or a wide overhang the pocket would be open there: add the dam's
  // footprint on the plane (+2 mm) to the flange outline (a no-op when F already covers it).
  if (ctx.collar2D && ctx.zPour > zTop) {
    const wd = (Number(P.wallThickness) || 0) + Math.max(0, Number(P.endWallExtra) || 0); // dam incl. broader ends
    const strip = ctx.collar2D.collar.offset(wd, 'Round', 2, 64)
      .intersect(CrossSection.square([2 * BIG, 0.02]).translate([-BIG, y0 - 0.01]));
    if (!strip.isEmpty()) {
      const b = strip.bounds();
      F = F.add(rect2(b.min[0] - 2, zTop - 1, b.max[0] + 2, ctx.zPour));
    }
  }

  // obstacles on the plane: silicone faces and the cast cavity (wick rods below the floor)
  let obst = null;
  for (const s of [ctx.cavA, ctx.cavB, ctx.Mp]) {
    if (!s) continue;
    const sl = planeSlice(s, y0);
    obst = obst ? obst.add(sl) : sl;
  }

  // ---- bottom clips (in notches of the two flange strips) ------------------------------------
  const clipSites = [];
  const cw = P.clipWidth;
  const rHole = siteRadius(P);
  const notchH = P.clipWall + NOTCH_EXTRA;
  const nBottom = Math.max(0, Math.round(Number(P.clipsBottom) || 0));
  let bottomUsed = false;
  if (nBottom > 0) {
    const zb = zFloor + 0.25;
    const fc = crossingsAtZ(F.toPolygons(), zb);
    const hc = crossingsAtZ(hullO.toPolygons(), zb);
    const strips = [];
    if (fc.length >= 2 && hc.length >= 2) {
      strips.push([fc[0].x, hc[0].x]);
      strips.push([hc[hc.length - 1].x, fc[fc.length - 1].x]);
    }
    const perStrip = Math.ceil(nBottom / 2);
    const notches = [];
    for (const [a, b] of strips) {
      const room = b - a - 2; // keep 1 mm from the shell body and the flange edge
      const fit = Math.floor((room + 1) / (cw + 2 * NOTCH_CLEAR + 1));
      const k = Math.min(perStrip, fit);
      if (k <= 0) continue;
      for (const x of spread(k, a + 1 + cw / 2 + NOTCH_CLEAR, b - 1 - cw / 2 - NOTCH_CLEAR)) {
        notches.push(rect2(x - cw / 2 - NOTCH_CLEAR, zFloor - 1, x + cw / 2 + NOTCH_CLEAR, zFloor + notchH));
        clipSites.push({ e: [x, zFloor + notchH], n: [0, -1], side: 'bottom' });
      }
    }
    if (notches.length) {
      F = F.subtract(CrossSection.union(notches));
      bottomUsed = true;
    } else {
      warnings.push(`No room for bottom clips (flange strips narrower than clip width ${cw} mm + 3 mm); use more side clips or a wider flange.`);
    }
  }

  // ---- side pins + side clips: one z layout shared by both sides ----------------------------
  const H = zTop - zFloor;
  const nP = Math.max(0, Math.round(Number(P.pinsPerSide) || 0));
  const nC = clipsPerSideFor(P, H);
  const pinLo = zFloor + f, pinHi = zTop - f;
  let clipLo = zFloor + cw;
  if (bottomUsed) clipLo = Math.max(clipLo, zFloor + notchH + P.clipJaw + cw / 2 + 1);
  const clipHi = zTop - cw;
  const lay = layoutPinsAndClips(nP, nC, [pinLo, pinHi], [clipLo, clipHi], cw / 2 + 2 * siteRadius(P), cw + 2);
  if (lay.clips.length < nC || lay.pins.length < nP) {
    warnings.push(`Flange height allows ${lay.clips.length} clip(s) and ${lay.pins.length} pin(s) per side (asked ${nC} and ${nP}).`);
  }
  const pinSites = [];
  if (lay.pins.length) {
    const midPolys = hullO.offset(0.45 * f, 'Round', 2, 64).toPolygons();
    for (const z of lay.pins) {
      const cr = crossingsAtZ(midPolys, z);
      if (cr.length < 2) continue;
      pinSites.push([cr[0].x, z], [cr[cr.length - 1].x, z]);
    }
  }
  const Fpolys = F.toPolygons();
  for (const [side, sgn] of [['left', -1], ['right', 1]]) {
    for (const z of lay.clips) {
      const cr = crossingsAtZ(Fpolys, z);
      if (cr.length < 2) continue;
      const c = sgn < 0 ? cr[0] : cr[cr.length - 1];
      clipSites.push({ e: [c.x, z], n: edgeNormal(c, sgn), side });
    }
  }
  if (lay.clips.length > 1) {
    const pitch = Math.max(...lay.clips.slice(1).map((z, i) => z - lay.clips[i]));
    if (pitch > 60) warnings.push(`Side clips are up to ${pitch.toFixed(0)} mm apart; <= 50 mm keeps the seams tight during the silicone pour (clipsPerSide = ${Math.ceil(H / 50) + 1}).`);
  }

  // bottom centre pin, when the floor below the silicone face is deep enough
  if (nP > 0 && obst) {
    const bO = hullO.bounds();
    const xc = (bO.min[0] + bO.max[0]) / 2;
    const rr = rHole + 1.2;
    const col = obst.intersect(rect2(xc - rr, zFloor - 1, xc + rr, zTop));
    const zTopFloor = col.isEmpty() ? zTop : col.bounds().min[1];
    const zc = (zFloor + zTopFloor) / 2;
    const disk = CrossSection.circle(rr, 32).translate([xc, zc]);
    if (zTopFloor - zFloor >= 2 * rr && disk.subtract(F).area() < 1e-6 && disk.intersect(obst).area() < 1e-6) pinSites.push([xc, zc]);
  }

  return { outline2D, flange2D: F, pinSites, clipSites, warnings };
}

/**
 * Add the flange plate of half `side` to a shell and re-subtract that half's cavity.
 * A: planeExtrude(F, y0 - tf, y0); B: planeExtrude(F, y0, y0 + tf).
 */
export function applyFlange(shell, ctx, side) {
  const { y0, P } = ctx;
  const tf = P.flangeThickness;
  const plate = side === 'A' ? planeExtrude(ctx.flange2D, y0 - tf, y0) : planeExtrude(ctx.flange2D, y0, y0 + tf);
  const cav = side === 'A' ? ctx.cavA : ctx.cavB;
  let s = shell.add(plate);
  if (cav) s = s.subtract(cav);
  return s;
}
