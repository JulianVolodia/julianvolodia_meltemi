// Alignment dowels (pins) through the flanges (and parting board) + their holes.
// Core module: manifold comes from wasm.js (no bare imports).
import { mf } from '../wasm.js';
import { mat4Identity } from '../frame.js';

const CHAMFER = 0.4;
const SEGMENTS = 32; // same for pins and holes so the clearance is uniform

/** Pin lengths: cast stage (two flanges) and silicone-pour stage (flanges + board). */
export function pinLengths(P) {
  const tf = P.flangeThickness, T = P.boardThickness;
  const cast = 2 * tf - 0.4;
  let silicone;
  if (P.boardStyle === 'double') silicone = 2 * tf + T - 0.4;
  else if (P.boardStyle === 'single') silicone = tf + T - 0.4;
  else silicone = cast;
  return { cast, silicone };
}

/** Cylindrical pin of diameter P.pinDiameter along +Z over [0, length], 0.4 mm chamfers at both ends. */
export function buildPin(length, P) {
  const { CrossSection } = mf();
  const r = P.pinDiameter / 2;
  const c = Math.min(CHAMFER, r * 0.5, length / 4);
  const profile = [[0, 0], [r - c, 0], [r, c], [r, length - c], [r - c, length], [0, length]];
  return CrossSection.ofPolygons([profile]).revolve(SEGMENTS);
}

/** Pose mapping the pin's +Z axis to +Y with its base at (site.x, yStart, site.z). det = +1. */
export function pinPose(site, yStart) {
  // columns: local x -> (1,0,0), local y -> (0,0,-1), local z -> (0,1,0)
  return [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, site[0], yStart, site[1], 1];
}

/** Hole (to subtract): cylinder along Y spanning [yA, yB] at (x, z), diameter pinDiameter + pinClearance. */
export function pinHole(site, yA, yB, P) {
  const { Manifold } = mf();
  const lo = Math.min(yA, yB), L = Math.abs(yB - yA);
  if (!(L > 0)) return Manifold.cube([0, 0, 0]);
  const r = (P.pinDiameter + P.pinClearance) / 2;
  return Manifold.cylinder(L, r, r, SEGMENTS).transform(pinPose(site, lo));
}

/** Pins print standing (axis = Z). */
export function pinPrintMatrix() {
  return mat4Identity();
}

