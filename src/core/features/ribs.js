// Ribs / feet (DESIGN.md §4 step 6).
//
// Each shell half gets vertical plates ("ribs") of thickness P.ribThickness lying in YZ
// planes. A rib spans y from the half's back plane (yBackA / yBackB) to the back face of the
// flange (|y - y0| = flangeThickness) and z from zFloor to zTop - ribTopInset, minus the
// cavity. Because every rib reaches zFloor AND the back plane, a half both stands upright
// on the table and lies flat on its back (the two print/handling orientations).
//
// Rib x positions:
//   * valleys of the top-view outline: local minima (with prominence) of the shell's
//     outward extent e(x) = max |y - y0| over the shell's points at that x — i.e. the
//     top-view (XY) silhouette sampled along x, computed exactly from the triangles;
//   * the two ends of the shell body (so there are always >= 2 ribs);
//   * evenly spaced fillers so the gap between neighbouring ribs is <= P.ribSpacing;
//   * every position is pushed out of the keep-out zones of clips and pins.
import { mf } from '../wasm.js';
import { box } from '../frame.js';
import { siteRadius } from './pins.js';

const EPS_OVERLAP = 0.02; // ribs overlap the flange plate slightly -> robust union

/**
 * Outward extent profile of a solid on one side of the parting plane, sampled along x.
 * e[i] = max over solid points with x = x0 + i*dx of (side A: y0 - y, side B: y - y0),
 * or -Infinity when the solid does not reach that x. Exact w.r.t. the triangle mesh
 * (equivalent to sampling the top-view silhouette `solid.project()`).
 * @returns {{x0:number, dx:number, e:Float64Array}}
 */
export function extentProfile(solid, side, y0, dx = 0.5) {
  const bb = solid.boundingBox();
  const x0 = bb.min[0];
  const n = Math.max(1, Math.floor((bb.max[0] - x0) / dx) + 1);
  const e = new Float64Array(n).fill(-Infinity);
  const mesh = solid.getMesh();
  const P = mesh.vertProperties, np = mesh.numProp, T = mesh.triVerts;
  const sgn = side === 'A' ? -1 : 1;
  const upd = (i, y) => {
    const v = sgn * (y - y0);
    if (v > e[i]) e[i] = v;
  };
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * np, b = T[t + 1] * np, c = T[t + 2] * np;
    const xa = P[a], ya = P[a + 1], xb = P[b], yb = P[b + 1], xc = P[c], yc = P[c + 1];
    const xmin = Math.min(xa, xb, xc), xmax = Math.max(xa, xb, xc);
    let i0 = Math.ceil((xmin - x0) / dx), i1 = Math.floor((xmax - x0) / dx);
    if (i0 < 0) i0 = 0;
    if (i1 > n - 1) i1 = n - 1;
    for (let i = i0; i <= i1; i++) {
      const xs = x0 + i * dx;
      // The triangle's section at x = xs is a segment whose endpoints lie on its edges.
      edge(xa, ya, xb, yb, xs, i, upd);
      edge(xb, yb, xc, yc, xs, i, upd);
      edge(xc, yc, xa, ya, xs, i, upd);
    }
  }
  return { x0, dx, e };
}

function edge(xp, yp, xq, yq, xs, i, upd) {
  const dp = xp - xs, dq = xq - xs;
  if (dp === 0) upd(i, yp);
  if (dq === 0) upd(i, yq);
  if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) upd(i, yp + ((yq - yp) * dp) / (xp - xq));
}

/** Topographic prominence of the local minima of e[lo..hi]; returns [{i, depth}]. */
function valleys(e, lo, hi, minProm) {
  const out = [];
  let i = lo + 1;
  while (i < hi) {
    // plateau-aware local minimum
    let j = i;
    while (j + 1 < hi && e[j + 1] === e[i]) j++;
    if (e[i - 1] > e[i] && e[j + 1] > e[i]) {
      const v = e[i];
      let maxL = v, maxR = v;
      for (let k = i - 1; k >= lo && e[k] >= v; k--) maxL = Math.max(maxL, e[k]);
      for (let k = j + 1; k <= hi && e[k] >= v; k++) maxR = Math.max(maxR, e[k]);
      const prom = Math.min(maxL, maxR) - v;
      if (prom >= minProm) out.push({ i: Math.round((i + j) / 2), depth: prom });
    }
    i = j + 1;
  }
  return out;
}

/** Keep-out x-intervals for ribs, from clip and pin sites. */
function keepOuts(ctx) {
  const P = ctx.P;
  const half = P.ribThickness / 2;
  const zLo = ctx.zFloor, zHi = ctx.zTop - (P.ribTopInset || 0);
  const out = [];
  for (const c of ctx.clipSites || []) {
    const ex = c.e[0];
    const [nx, nz] = c.n || [0, 0];
    const m = P.clipWidth / 2 + 3 + half;
    out.push([ex - m, ex + m]);
    if (Math.abs(nx) >= Math.abs(nz)) {
      // side clip: its jaws reach clipJaw inward from the edge along x (+3 mm margin)
      const reach = P.clipJaw + 3 + half;
      out.push(nx > 0 ? [ex - reach, ex + m] : [ex - m, ex + reach]);
    }
  }
  for (const p of ctx.pinSites || []) {
    const [px, pz] = p;
    if (pz < zLo - 5 || pz > zHi + 5) continue;
    const m = siteRadius(P) + 1 + half;
    out.push([px - m, px + m]);
  }
  return out;
}

function isFree(x, kos) {
  for (const [a, b] of kos) if (x > a && x < b) return false;
  return true;
}

/** Move x to the nearest position in [lo, hi] outside every keep-out; null if none. */
function pushOut(x, lo, hi, kos) {
  if (x >= lo && x <= hi && isFree(x, kos)) return x;
  const cands = [lo, hi];
  for (const [a, b] of kos) cands.push(a, b);
  let best = null, bd = Infinity;
  for (const c of cands) {
    if (c < lo - 1e-9 || c > hi + 1e-9 || !isFree(c, kos)) continue;
    const d = Math.abs(c - x);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

/**
 * Rib x positions for one half (deterministic; windows.js uses the same positions to keep
 * windows clear of ribs).
 * @param {object} ctx pipeline context (needs P, y0, zFloor, zTop, h, shellA/shellB, clipSites, pinSites)
 * @param {'A'|'B'} side
 * @param {object} [shell] shell solid to analyse (default ctx.shellA / ctx.shellB)
 * @returns {number[]} sorted x positions (rib centre planes)
 */
export function ribPositions(ctx, side, shell) {
  const P = ctx.P;
  const s = shell || (side === 'A' ? ctx.shellA : ctx.shellB);
  if (!s || s.isEmpty()) return [];
  const tf = P.flangeThickness;
  const t = P.ribThickness;
  const h = ctx.h || 0.5;
  const dx = Math.min(0.5, Math.max(0.2, h / 2));
  const { x0, e } = extentProfile(s, side, ctx.y0, dx);
  const n = e.length;

  // Shell body = where the shell reaches noticeably beyond the flange plate.
  const thr = tf + 0.5;
  let lo = -1, hi = -1;
  for (let i = 0; i < n; i++) if (e[i] > thr) { if (lo < 0) lo = i; hi = i; }
  if (lo < 0) return [];
  // fill holes (x without any shell point) with the flange level so minima are sane
  for (let i = 0; i < n; i++) if (!Number.isFinite(e[i])) e[i] = 0;

  let xL = x0 + lo * dx + t / 2, xR = x0 + hi * dx - t / 2;
  if (xR < xL) xL = xR = (xL + xR) / 2;
  const kos = keepOuts(ctx);
  const minSep = Math.max(2 * t, 6);

  // 1) valleys of the top-view outline (strongest first)
  const minProm = Math.max(1.0, 2 * h);
  const vs = valleys(e, lo, hi, minProm).sort((a, b) => b.depth - a.depth);
  let xs = [];
  for (const v of vs) {
    const x = pushOut(x0 + v.i * dx, xL, xR, kos);
    if (x === null) continue;
    if (xs.every((q) => Math.abs(q - x) >= minSep)) xs.push(x);
  }
  // 2) the two ends of the body (skipped when a valley already sits close by)
  for (const xe of [xL, xR]) {
    const x = pushOut(xe, Math.min(xL, xR), Math.max(xL, xR), kos);
    if (x === null) continue;
    if (xs.every((q) => Math.abs(q - x) >= minSep)) xs.push(x);
  }
  xs.sort((a, b) => a - b);
  // 3) evenly spaced fillers so that gaps <= ribSpacing (two passes: keep-outs may move them)
  const spacing = Math.max(P.ribSpacing, minSep + t);
  for (let pass = 0; pass < 2; pass++) {
    const add = [];
    for (let k = 0; k + 1 < xs.length; k++) {
      const g = xs[k + 1] - xs[k];
      if (g <= spacing + 1e-6) continue;
      const m = Math.ceil(g / spacing) - 1;
      for (let j = 1; j <= m; j++) {
        const x = pushOut(xs[k] + (g * j) / (m + 1), xs[k] + t, xs[k + 1] - t, kos);
        if (x === null) continue;
        if ([...xs, ...add].every((q) => Math.abs(q - x) >= t + 1)) add.push(x);
      }
    }
    if (!add.length) break;
    xs = [...xs, ...add].sort((a, b) => a - b);
  }
  // 4) at least two ribs whenever the body is wide enough to hold two plates
  if (xs.length < 2 && xR - xL >= t + 1) {
    const cands = [xL, xR, (xL + xR) / 2];
    for (const c of cands) {
      const x = pushOut(c, xL, xR, kos);
      if (x !== null && xs.every((q) => Math.abs(q - x) >= t + 1)) xs.push(x);
      if (xs.length >= 2) break;
    }
    xs.sort((a, b) => a - b);
  }
  return xs;
}

/**
 * Build the ribs of one half.
 * @param {object} ctx pipeline context (P, y0, zTop, zFloor, h, cavA/cavB, shellA/shellB, yBackA/yBackB, clipSites, pinSites, Mp)
 * @param {'A'|'B'} side
 * @returns {import('manifold-3d').Manifold|null} union of all ribs (valid manifold) or null
 */
export function buildRibs(ctx, side) {
  const { Manifold } = mf();
  const P = ctx.P;
  if (P.ribs === false) return null;
  const xs = ribPositions(ctx, side);
  if (xs.length === 0) return null;
  const t = P.ribThickness, tf = P.flangeThickness, y0 = ctx.y0;
  const zLo = ctx.zFloor, zHi = ctx.zTop - (P.ribTopInset || 0);
  if (!(zHi - zLo > 1)) return null;
  const shell = side === 'A' ? ctx.shellA : ctx.shellB;
  let yA, yB;
  if (side === 'A') { yA = ctx.yBackA ?? shell.boundingBox().min[1]; yB = y0 - tf + EPS_OVERLAP; }
  else { yA = y0 + tf - EPS_OVERLAP; yB = ctx.yBackB ?? shell.boundingBox().max[1]; }
  if (!(yB - yA > 0.5)) return null;
  const plates = xs.map((x) => box([x - t / 2, yA, zLo], [x + t / 2, yB, zHi])).filter(Boolean);
  if (!plates.length) return null;
  let ribs = plates.length === 1 ? plates[0] : Manifold.compose(plates); // disjoint plates
  const cav = side === 'A' ? ctx.cavA : ctx.cavB;
  if (cav) ribs = ribs.subtract(cav);
  // wick/vent rods of the cast cavity may leave the silicone envelope (e.g. below the floor)
  if (ctx.Mp) ribs = ribs.subtract(ctx.Mp);
  if (ribs.isEmpty()) return null;
  return ribs;
}
