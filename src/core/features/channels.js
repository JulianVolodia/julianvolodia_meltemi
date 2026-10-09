// Pour opening, wick channel and air vents (DESIGN.md §4 step 2).
//
// Everything here is part of the *cast cavity* Mp (the space the casting material fills):
//   * pour extensions — per connected master component either an 'extend' riser (the flat top
//     face extruded up through the rim) or a 'sprue' funnel cone at the highest point with its
//     axis in the parting plane (plus a Y runner when that point is off the plane);
//   * wick channels — vertical rods through the top-face centroid (snapped to the plane);
//   * vents — per air trap a Y rod from the trap ceiling to the parting plane plus a vertical
//     rod in the plane up to zTop + 1 (half-channels formed by the board reliefs, demoldable ±Y).
// Core module: manifold comes from wasm.js (no bare imports).
import { mf } from '../wasm.js';
import { rod, unionAll } from '../frame.js';
import { pourModeFor } from '../analysis.js';

const OVERLAP = 0.5; // pour extensions start this far below the component top (robust union)

/** Connected components of M with positive volume (inner shells of hollow masters dropped). */
export function positiveComponents(M) {
  const parts = M.decompose();
  return parts.filter((c) => !c.isEmpty() && c.volume() > 1e-9);
}

/** Area-weighted centroid of a CrossSection (via its polygons, holes negative); null if empty. */
export function crossSectionCentroid(cs) {
  let A = 0, cx = 0, cy = 0;
  for (const poly of cs.toPolygons()) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xj, yj] = poly[j], [xi, yi] = poly[i];
      const c = xj * yi - xi * yj;
      A += c;
      cx += (xj + xi) * c;
      cy += (yj + yi) * c;
    }
  }
  if (Math.abs(A) < 1e-12) return null;
  return [cx / (3 * A), cy / (3 * A)];
}

/**
 * Highest point of a component: among the vertices within `tol` of the top, the one closest to
 * the parting plane; if the top ridge crosses the plane (vertices on both sides near that x),
 * its y is snapped to y0.
 * @returns {number[]} [x, y, z]
 */
export function highestPoint(c, y0, tol = 0.05) {
  const g = c.getMesh();
  const np = g.numProp, vp = g.vertProperties;
  const nv = (vp.length / np) | 0;
  let zMax = -Infinity;
  for (let v = 0; v < nv; v++) if (vp[np * v + 2] > zMax) zMax = vp[np * v + 2];
  const H = c.boundingBox().max[2] - c.boundingBox().min[2];
  const t = Math.max(tol, 0.002 * H);
  const top = [];
  for (let v = 0; v < nv; v++) if (vp[np * v + 2] >= zMax - t) top.push([vp[np * v], vp[np * v + 1], vp[np * v + 2]]);
  let best = top[0];
  for (const p of top) if (Math.abs(p[1] - y0) < Math.abs(best[1] - y0)) best = p;
  let below = false, above = false;
  for (const p of top) {
    if (Math.abs(p[0] - best[0]) > 3) continue;
    if (p[1] <= y0) below = true;
    if (p[1] >= y0) above = true;
  }
  return [best[0], below && above ? y0 : best[1], zMax];
}

/**
 * Pour extensions for every positive-volume component of M.
 * @param {*} M union of the masters (Manifold)
 * @param {object} P resolved params (pourMode, sprueR1, sprueR2)
 * @param {number} y0 parting plane
 * @param {number} zTop rim height (extensions reach zTop + 1)
 * @param {{modes?: object[]}} [info] optional: receives {component, mode, top, area} per component
 * @returns {*} Manifold | null
 */
export function buildPourExtensions(M, P, y0, zTop, info = null) {
  const { Manifold } = mf();
  const out = [];
  const zEnd = zTop + 1;
  positiveComponents(M).forEach((c, idx) => {
    const bb = c.boundingBox();
    const H = bb.max[2] - bb.min[2];
    let mode = P.pourMode === 'extend' || P.pourMode === 'sprue' ? P.pourMode : pourModeFor(c);
    let solid = null;
    let top = null;
    if (mode === 'extend') {
      const zs = bb.max[2] - Math.min(0.25, H / 4);
      const cs = c.slice(zs);
      if (!cs.isEmpty() && cs.area() > 1e-6) {
        const z0 = bb.max[2] - Math.min(OVERLAP, H / 2);
        solid = cs.extrude(zEnd - z0).translate([0, 0, z0]);
        const ctr = crossSectionCentroid(cs);
        top = ctr ? [ctr[0], ctr[1], bb.max[2]] : null;
      } else {
        mode = 'sprue';
      }
    }
    if (mode === 'sprue') {
      const p = highestPoint(c, y0);
      top = p;
      const r1 = Math.max(0.5, P.sprueR1), r2 = Math.max(r1, P.sprueR2);
      const z0 = p[2] - Math.min(OVERLAP, H / 2);
      const parts = [];
      if (zEnd - z0 > 1e-3) parts.push(Manifold.cylinder(zEnd - z0, r1, r2, 48).translate([p[0], y0, z0]));
      if (Math.abs(p[1] - y0) > 0.25) {
        // runner from the plane to the off-plane highest point (+ rounded ends for a clean union)
        const rr = r1;
        parts.push(rod([p[0], y0, p[2] - rr / 2], [p[0], p[1], p[2] - rr / 2], rr, 32));
        parts.push(Manifold.sphere(rr, 32).translate([p[0], p[1], p[2] - rr / 2]));
        parts.push(Manifold.sphere(rr, 32).translate([p[0], y0, p[2] - rr / 2]));
      }
      solid = unionAll(parts);
    }
    if (info) {
      if (!info.modes) info.modes = [];
      info.modes.push({ component: idx, mode, top, height: H });
    }
    if (solid) out.push(solid);
  });
  return unionAll(out);
}

/**
 * Wick channels: per component a vertical rod (diameter P.wickDiameter) through the centroid of
 * its top slice, from below the shell floor (zFloor - 1) up to 60 % of the component height.
 * The rod is snapped to the parting plane when within 2 mm of it (a split channel clamps the
 * wick and is demoldable); otherwise a warning is issued.
 * @returns {{solid: *, warnings: string[], sites: number[][]}}
 */
export function buildWick(M, P, y0, zFloor) {
  const warnings = [];
  const sites = [];
  const rods = [];
  const r = Math.max(0.2, P.wickDiameter / 2);
  positiveComponents(M).forEach((c, idx) => {
    const bb = c.boundingBox();
    const H = bb.max[2] - bb.min[2];
    if (!(H > 0)) return;
    const cs = c.slice(bb.max[2] - Math.min(0.25, H / 4));
    let ctr = cs.isEmpty() ? null : crossSectionCentroid(cs);
    if (!ctr) ctr = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2];
    let [x, y] = ctr;
    if (Math.abs(y - y0) <= 2) y = y0;
    else warnings.push(`Wick channel of part ${idx + 1} is ${(y - y0).toFixed(1)} mm off the parting plane (not split by the plane): thread the wick before closing the mold.`);
    const zHi = bb.min[2] + 0.6 * H;
    rods.push(rod([x, y, zFloor - 1], [x, y, zHi], r, 24));
    sites.push([x, y]);
  });
  return { solid: unionAll(rods), warnings, sites };
}

/**
 * Air vents for the given traps (analysis.findAirTraps output: {p:[x,y,z], ...}): a Y rod from
 * the trap ceiling to the plane and a vertical rod in the plane up to zTop + 1, radius
 * P.ventDiameter / 2, with a sphere at the elbow.
 * @returns {*} Manifold | null
 */
export function buildVents(traps, P, y0, zTop) {
  const { Manifold } = mf();
  const r = Math.max(0.2, P.ventDiameter / 2);
  const parts = [];
  for (const t of traps || []) {
    const p = t.p || t;
    const [x, y, z] = p;
    if (!(z < zTop + 1)) continue;
    if (Math.abs(y - y0) > 1e-3) {
      parts.push(rod([x, y, z], [x, y0, z], r, 24));
      parts.push(Manifold.sphere(r, 24).translate([x, y, z]));
    }
    parts.push(Manifold.sphere(r, 24).translate([x, y0, z]));
    parts.push(rod([x, y0, z], [x, y0, zTop + 1], r, 24));
  }
  return unionAll(parts);
}
