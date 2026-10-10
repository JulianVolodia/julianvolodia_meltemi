// Silicone collar ("kołnierz") at the pour end.
//
// A thin silicone skin needs something to hang from: without it the skin can slide down
// inside the mother mold and the parting seam at the pour face is not clamped. The collar is
// a flat silicone lip of height collarHeight on top of the shell rim (z = zTop .. zPour),
// reaching collarOverhang beyond the shell's outer wall. The pour openings (Mp) run through it.
//
// To cast it, each shell half gets
//   * a dam: a wall of thickness wallThickness around the collar outline (zTop .. zPour), and
//   * a ledge under the overhang: 0.5 mm steps at 45° below the rim, so the dam prints upright
//     without supports.
// Both are straight-pull demoldable: the collar outline is y-monotone on each side of the
// parting plane (it is a round offset of the straight-pull shell's top section).
//
//   C = (slice(outerA, zTop) ∩ {y <= y0}) ∪ (slice(outerB, zTop) ∩ {y >= y0}), offset by o
import { mf } from '../wasm.js';
import { trimSide } from '../frame.js';

const STEP = 0.5; // ledge step (mm): 0.5 mm out per 0.5 mm down = 45°, finer steps print cleaner
const E = 0.01;

/**
 * Collar outline (top view, XY) or null when the collar is disabled.
 * @param {object} ctx pipeline context (P, y0, zTop, zPour, outerA, outerB)
 */
export function collarOutline2D(ctx) {
  const { CrossSection } = mf();
  const { P, y0, zTop } = ctx;
  if (!(ctx.zPour > zTop)) return null;
  const big = 1e4;
  const z = zTop - 0.05;
  const a = ctx.outerA.slice(z).intersect(CrossSection.square([2 * big, big]).translate([-big, y0 - big]));
  const b = ctx.outerB.slice(z).intersect(CrossSection.square([2 * big, big]).translate([-big, y0]));
  const top = a.add(b);
  if (top.isEmpty()) return null;
  const o = Math.max(0, Number(P.collarOverhang) || 0);
  return { top, collar: o > 0 ? top.offset(o, 'Round', 2, 64) : top };
}

/**
 * Dam + stepped ledge for one shell half (to be unioned into the shell before the cavity,
 * the cast cavity and the collar void are subtracted).
 * @returns {*} Manifold | null
 */
export function buildCollarFrame(ctx, side) {
  const { Manifold } = mf();
  const { P, y0, zTop, zPour } = ctx;
  const c = ctx.collar2D;
  if (!c) return null;
  const wd = P.wallThickness;
  const o = Math.max(0, Number(P.collarOverhang) || 0);
  const e = Math.max(0, Number(P.endWallExtra) || 0);
  const L = Number(P.endWallBlend) || 12;
  const ends = e > 0 ? endStrips(c.collar, L) : null;
  // tapered extra at the ±X ends: TAPER bands, the outermost (shortest) one gets the full e
  const TAPER = 4;
  const bands = e > 0 ? Array.from({ length: TAPER }, (_, j) => ({ add: (e * (j + 1)) / TAPER, strip: endStrips(c.collar, L * (1 - j / TAPER)) })) : [];
  // region within `r` of `base`, plus up to `e` more towards the ±X ends (broader end walls)
  const grow = (base, r) => {
    let g = base.offset(r, 'Round', 2, 64);
    for (const bd of bands) g = g.add(base.offset(r + bd.add, 'Round', 2, 64).intersect(bd.strip));
    return g;
  };
  const parts = [];
  // dam around the collar
  const dam2D = grow(c.collar, wd).subtract(c.collar);
  parts.push(dam2D.extrude(zPour - zTop + E).translate([0, 0, zTop - E]));
  // 45° ledge: step k spans z in [zTop - (k+1) s, zTop - k s] and reaches (o + wd - k s) out
  // (+ e at the ends, with as many extra steps as that needs)
  const reach = o + wd;
  const n = Math.ceil((reach + e) / STEP);
  for (let k = 0; k < n; k++) {
    const r = reach - k * STEP;
    const ring = r > 0 ? grow(c.top, r) : ends && r + e > 0 ? c.top.offset(r + e, 'Round', 2, 64).intersect(ends) : null;
    if (!ring || ring.isEmpty()) break;
    parts.push(ring.extrude(STEP + E).translate([0, 0, zTop - (k + 1) * STEP]));
  }
  const frame = trimSide(Manifold.union(parts), side, y0);
  return frame.isEmpty() ? null : frame;
}

/** Strips (top view) of length L at both X-ends of `cs`, extended far outward. */
function endStrips(cs, L) {
  const { CrossSection } = mf();
  const b = cs.bounds();
  const big = 1e4;
  const sq = (x0, x1) => CrossSection.square([x1 - x0, 2 * big]).translate([x0, -big]);
  return sq(b.min[0] - big, b.min[0] + L).add(sq(b.max[0] - L, b.max[0] + big));
}

/** The collar's own volume (zTop .. zPour + 1 inside the outline): kept free of shell material. */
export function collarVoid(ctx) {
  const c = ctx.collar2D;
  if (!c) return null;
  return c.collar.extrude(ctx.zPour - ctx.zTop + 1).translate([0, 0, ctx.zTop]);
}

/** Silicone of the collar on one side: collar prism minus the cast cavity. */
export function collarSilicone(ctx, side) {
  const c = ctx.collar2D;
  if (!c) return null;
  const prism = c.collar.extrude(ctx.zPour - ctx.zTop).translate([0, 0, ctx.zTop]);
  const s = trimSide(prism, side, ctx.y0).subtract(ctx.Mp);
  return s.isEmpty() ? null : s;
}
