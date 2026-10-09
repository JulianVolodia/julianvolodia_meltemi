// C-clips that clamp the flange sandwich (shell flange A | [board] | shell flange B).
// Core module: manifold comes from wasm.js (no bare imports).
import { mf } from '../wasm.js';
import { mat4Translation } from '../frame.js';

const CHAMFER = 0.6; // 45° lead-in on the inner jaw tips
const RELIEF_R = 0.5; // stress-relief radius at the inner spine corners
const MIN_GAP = 0.2;

/** Jaw opening of a clip for a sandwich of the given thickness (tighter by clipInterference). */
export function clipGap(sandwich, P) {
  return sandwich - P.clipInterference;
}

/**
 * C-clip solid in its LOCAL frame: flange edge at x = 0, flange material at x > 0,
 * sandwich centred on y = 0 (thickness `sandwich`), clip width along z centred on z = 0.
 * Profile (x, y): spine x in [-clipWall, 0], |y| <= g/2 + clipWall;
 * jaws x in [0, clipJaw], g/2 <= |y| <= g/2 + clipWall  (g = clipGap).
 */
export function buildClip(sandwich, P) {
  const { CrossSection } = mf();
  const g = Math.max(MIN_GAP, clipGap(sandwich, P));
  const w = P.clipWall, jaw = P.clipJaw, half = g / 2, outer = half + w;
  let cs = CrossSection.square([w + jaw, 2 * outer]).translate([-w, -outer]);
  // slot between the jaws (overshoots the open end)
  cs = cs.subtract(CrossSection.square([jaw + 1, g]).translate([0, -half]));
  // lead-in chamfers on the inner tips of both jaws
  const c = Math.min(CHAMFER, jaw * 0.5, w * 0.5);
  if (c > 0) {
    for (const s of [1, -1]) {
      const tri = [[jaw - c, s * half], [jaw + 0.01, s * half], [jaw + 0.01, s * (half + c + 0.01)]];
      if (s < 0) tri.reverse(); // keep CCW winding
      cs = cs.subtract(CrossSection.ofPolygons([tri]));
    }
  }
  // stress-relief radius at the inner spine corners
  const rr = Math.min(RELIEF_R, w * 0.4);
  if (rr > 0) {
    for (const s of [1, -1]) cs = cs.subtract(CrossSection.circle(rr, 24).translate([0, s * half]));
  }
  return cs.extrude(P.clipWidth).translate([0, 0, -P.clipWidth / 2]);
}

/**
 * Pose of a clip in the mold frame. edge = [x, z] point on the flange edge, inward = [nx, nz]
 * unit inward normal in the XZ plane (pointing into the flange), yCenter = sandwich centre.
 * local x -> (nx, 0, nz), local y -> (0, 1, 0), local z -> local x × local y = (-nz, 0, nx).
 */
export function clipPose(edge, inward, yCenter) {
  let [nx, nz] = inward;
  const L = Math.hypot(nx, nz) || 1;
  nx /= L; nz /= L;
  return [
    nx, 0, nz, 0,
    0, 1, 0, 0,
    -nz, 0, nx, 0,
    edge[0], yCenter, edge[1], 1,
  ];
}

/** Print orientation: profile flat on the bed (XY), extrusion along Z, min z = 0. */
export function clipPrintMatrix(P) {
  return mat4Translation(0, 0, P.clipWidth / 2);
}
