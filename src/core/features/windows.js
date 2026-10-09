// Windows for the support cage / mother mold (DESIGN.md §4 step 10).
//
// Rounded-rectangle slots (P.windowWidth along X, P.windowHeight along Z, bars P.windowBar)
// laid out as a grid over the shell body's XZ extent and extruded along Y only through
// |y - y0| >= flangeThickness + 1, so flanges (pins, clips, mating faces) are never cut.
// A margin of one bar is kept near zFloor, zTop and the x-extremes of the body. Columns are
// laid out per "bay" between rib planes so ribs (unioned later by the pipeline) never sit
// inside a window.
import { mf } from '../wasm.js';
import { planeExtrude } from '../frame.js';
import { ribPositions } from './ribs.js';

/** Rounded rectangle CrossSection centred at (cx, cz), size w x h, corner radius r. */
export function roundedRect2(cx, cz, w, h, r) {
  const { CrossSection } = mf();
  const rr = Math.max(0, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3));
  if (rr <= 1e-3) return CrossSection.square([w, h], true).translate([cx, cz]);
  return CrossSection.square([w - 2 * rr, h - 2 * rr], true).offset(rr, 'Round', 2, 32).translate([cx, cz]);
}

/** Lay out n cells of size `cell` with gap `bar`, centred in [a, b]; returns cell centres. */
function layout(a, b, cell, bar, stretch) {
  const W = b - a;
  if (!(W > 0)) return { size: cell, centres: [] };
  // stretch: pick the cell count whose stretched size is closest to the nominal one
  let n = stretch ? Math.round((W + bar) / (cell + bar)) : Math.floor((W + bar) / (cell + bar));
  let size = cell;
  if (n < 1) {
    // one narrower cell when at least half a window fits
    if (W >= Math.max(3, cell * 0.5)) { n = 1; size = W; } else return { size: cell, centres: [] };
  } else if (stretch) {
    size = (W - (n - 1) * bar) / n; // fill the span exactly with bars of width `bar`
  }
  const total = n * size + (n - 1) * bar;
  const start = a + (W - total) / 2 + size / 2;
  return { size, centres: Array.from({ length: n }, (_, i) => start + i * (size + bar)) };
}

/**
 * Cut windows into one shell half.
 * @param {import('manifold-3d').Manifold} shellSolid shell (incl. flange plate) of half `side`
 * @param {object} ctx pipeline context (P, y0, zFloor, zTop, ...; shellA/B used for rib bays)
 * @param {'A'|'B'} side
 * @param {{ribX?: number[]}} [opts] optional explicit rib x positions to keep clear of
 * @returns {import('manifold-3d').Manifold} shellSolid minus the windows
 */
export function cutWindows(shellSolid, ctx, side, opts = {}) {
  const { CrossSection } = mf();
  if (!shellSolid || shellSolid.isEmpty()) return shellSolid;
  const P = ctx.P;
  const y0 = ctx.y0, tf = P.flangeThickness;
  const bar = P.windowBar, ww = P.windowWidth, wh = P.windowHeight;
  const yCut = side === 'A' ? y0 - tf - 1 : y0 + tf + 1;
  // the part of the shell the windows may cut (beyond the flange zone)
  const body = side === 'A' ? shellSolid.trimByPlane([0, -1, 0], -yCut) : shellSolid.trimByPlane([0, 1, 0], yCut);
  if (body.isEmpty()) return shellSolid;
  const bb = body.boundingBox();
  const xMin = bb.min[0] + bar, xMax = bb.max[0] - bar;
  const zMin = Math.max(ctx.zFloor, bb.min[2]) + bar, zMax = Math.min(ctx.zTop, bb.max[2]) - bar;
  if (!(xMax - xMin > 3 && zMax - zMin > 3)) return shellSolid;

  // bays between ribs (ribs are unioned later; keep a half bar of shell beside each rib)
  let ribX = opts.ribX;
  if (!ribX && P.ribs !== false) {
    try { ribX = ribPositions(ctx, side); } catch { ribX = []; }
  }
  const t = P.ribThickness || 0;
  const bays = [];
  let a = xMin;
  for (const x of [...(ribX || [])].sort((p, q) => p - q)) {
    const l = x - t / 2 - bar / 2, r = x + t / 2 + bar / 2;
    if (r <= a || l >= xMax) { if (l >= xMax) break; continue; }
    if (l > a) bays.push([a, l]);
    a = Math.max(a, r);
  }
  if (xMax > a) bays.push([a, xMax]);

  const rows = layout(zMin, zMax, wh, bar, true);
  if (!rows.centres.length) return shellSolid;
  const cells = [];
  for (const [ba, bb2] of bays) {
    const cols = layout(ba, bb2, ww, bar, false);
    for (const cx of cols.centres)
      for (const cz of rows.centres)
        cells.push(roundedRect2(cx, cz, cols.size, rows.size, (Math.min(cols.size, rows.size) / 2) * 0.6));
  }
  if (!cells.length) return shellSolid;
  const cs = CrossSection.union(cells);
  const yA = side === 'A' ? bb.min[1] - 1 : yCut;
  const yB = side === 'A' ? yCut : bb.max[1] + 1;
  const prism = planeExtrude(cs, yA, yB);
  return shellSolid.subtract(prism);
}
