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


// ---------------------------------------------------------------------------------------------
// Interlocking registration (default): tapered pegs on one flange face, matching sockets in the
// other (and in the parting boards), so the halves key into each other without loose pins.
// The peg section is a diamond (square rotated 45°) in the parting plane: its lower faces are
// at 45°, so pegs sticking out of an upright-printed flange need no supports, and the diamond
// centres the halves in both X and Z. Sides taper by PEG_TAPER for an easy, self-locating fit.
// ---------------------------------------------------------------------------------------------

const PEG_TAPER = Math.tan((12 * Math.PI) / 180);

export function registrationMode(P) {
  return P.registration === 'pins' ? 'pins' : 'interlock';
}

/** Keep-out radius (plane coords) of one registration site, for layout and clearance checks. */
export function siteRadius(P) {
  return registrationMode(P) === 'pins'
    ? (P.pinDiameter + P.pinClearance) / 2
    : P.pegSize / 2 + P.pegClearance;
}

/**
 * Diamond-section tapered prism along +Y starting at yStart: base half-diagonal a (at yStart),
 * shrinking by PEG_TAPER per mm, length len. Used for pegs (grow = 0) and sockets (grow = clearance).
 */
function diamondPrism(site, yStart, a, len) {
  const { CrossSection } = mf();
  const top = Math.max(0.4, a - len * PEG_TAPER);
  const d = CrossSection.ofPolygons([[[a, 0], [0, a], [-a, 0], [0, -a]]]);
  // extrude along local +Z, then local z -> +Y (rotate about X by -90°: (x,y,z) -> (x, z, -y))
  return d.extrude(len, 0, 0, [top / a, top / a]).rotate([-90, 0, 0]).translate([site[0], yStart, site[1]]);
}

/** Peg on a face at yFace, protruding +Y by pegHeight (its base overlaps the face by 0.05 mm). */
export function pegSolid(site, yFace, P) {
  const a = P.pegSize / 2;
  const back = 0.05;
  return diamondPrism(site, yFace - back, a + back * PEG_TAPER, P.pegHeight + back);
}

/**
 * Socket for a peg whose base sits at yFace: same taper, + pegClearance all round, depth
 * `depth` from the face (pegHeight + 0.5 for a blind socket, or through the part).
 */
export function socketSolid(site, yFace, P, depth) {
  const a = P.pegSize / 2 + P.pegClearance;
  const front = 0.05;
  return diamondPrism(site, yFace - front, a + front * PEG_TAPER, depth + front);
}
