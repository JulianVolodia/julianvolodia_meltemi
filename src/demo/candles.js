// Procedural decorative taper candles — the demo masters from the reference footage
// (three textured tapers with leafy vines and wax drips near the tip).
//
// Pure JS (no manifold, no three). Output is MeshData { positions: Float32Array, indices:
// Uint32Array }: closed, 2-manifold, welded, outward oriented and self-intersection free.
//
// Construction: a lathe (surface of revolution) whose rings are star-shaped around the Z axis
// and sit on strictly increasing z planes; every ring vertex is displaced radially by
//   radius(z) + relief(theta, z) + drips(theta, z)  >= 1 mm
// which keeps the surface a single-valued graph over the cylinder -> always embedded.

import { latheMesh, flipUpsideDown, translateMesh } from './shapes.js';

const TAU = Math.PI * 2;

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sq = (x) => x * x;
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Wrap an angle difference to (-pi, pi]. */
const wrap = (a) => a - TAU * Math.round(a / TAU);

/**
 * One decorative taper candle in its natural standing orientation:
 * flat wide base on z = 0, rounded narrow tip at z = height, axis = Z through the origin.
 *
 * @param {object} o
 * @param {number} [o.height=180]      overall height (mm)
 * @param {number} [o.baseRadius=11]   radius at the base (mm)
 * @param {number} [o.tipRadius=5.5]   radius where the tip dome starts (mm)
 * @param {number} [o.relief=0.8]      relief amplitude (mm), vines / leaves / helical ribs
 * @param {boolean} [o.drips=true]     wax drips running down from the tip
 * @param {number} [o.dripAmplitude=1.5] drip height above the surface (mm)
 * @param {number} [o.plainBase=16]    undecorated band at the base (fits a candle holder)
 * @param {number} [o.seed=1]          random seed (vine phase, leaves, drips)
 * @param {number} [o.radialSegments=96]
 * @param {number} [o.heightSegments=180]
 * @returns {{positions: Float32Array, indices: Uint32Array}}
 */
export function makeTaperCandle({
  height = 180, baseRadius = 11, tipRadius = 5.5, relief = 0.8, drips = true, dripAmplitude = 1.5,
  plainBase = 16, seed = 1, radialSegments = 96, heightSegments = 180,
} = {}) {
  const H = +height, R0 = +baseRadius, R1 = Math.min(+tipRadius, R0);
  if (!(H > 10 && R0 >= 2 && R1 >= 1.5)) throw new Error('makeTaperCandle: height > 10, baseRadius >= 2, tipRadius >= 1.5 required');
  const rand = mulberry32(seed * 7919 + 17);
  // Keep relief well below the radius (no self-intersection, radius >= 1 mm everywhere).
  const A = Math.max(0, Math.min(+relief, 0.3 * R1));
  const dripA = drips ? Math.max(0, Math.min(+dripAmplitude, 0.5 * R1)) : 0;

  // ----- profile ----------------------------------------------------------------------------
  const hd = Math.min(1.15 * R1, 0.25 * H); // tip dome height
  const zd = H - hd; // dome starts here
  const radiusAt = (z) => R0 + (R1 - R0) * (z / zd); // linear taper on the body
  const reliefTop = zd - Math.max(4, 0.06 * H); // relief fades out below the drips/dome
  const baseBand = Math.min(plainBase, 0.3 * H);
  const reliefWeight = (z) => smoothstep(baseBand, baseBand + 8, z) * (1 - smoothstep(reliefTop - 10, reliefTop, z));

  // ----- decoration: vines, leaves, helical ribs ---------------------------------------------
  const nV = 2 + Math.floor(rand() * 2); // 2..3 vines
  const vines = [];
  for (let k = 0; k < nV; k++) {
    vines.push({
      th0: (k / nV) * TAU + (rand() - 0.5) * 0.6,
      pitch: (rand() < 0.5 ? -1 : 1) * (0.55 + 0.25 * rand()) * H, // one turn per ~0.55..0.8 H
      wobA: 0.18 + 0.12 * rand(),
      wobL: 18 + 10 * rand(),
      wobP: rand() * TAU,
      width: 1.1 + 0.3 * rand(),
    });
  }
  const vineTheta = (v, z) => v.th0 + (TAU * z) / v.pitch + v.wobA * Math.sin((TAU * z) / v.wobL + v.wobP);
  // leaves: alternating sides of each vine, pointing up-and-out at ~40 deg
  const leaves = [];
  const leafStep = 13;
  for (const v of vines) {
    let side = rand() < 0.5 ? -1 : 1;
    for (let z = baseBand + 10 + rand() * 6; z < reliefTop - 6; z += leafStep * (0.8 + 0.4 * rand())) {
      const ang = side * (0.6 + 0.3 * rand()); // leaf axis angle from vertical, toward one side
      const len = 3.8 + 1.4 * rand();
      const ux = Math.sin(ang), uz = Math.cos(ang); // unit axis in (arc, z)
      leaves.push({ v, z0: z, ux, uz, len, wid: 1.5 + 0.4 * rand(), off: len * 0.95, amp: 0.85 + 0.15 * rand() });
      side = -side;
    }
  }
  const ribs1 = { k: 10 + Math.floor(rand() * 5), p: 36 + 10 * rand(), ph: rand() * TAU };
  const ribs2 = { k: 6 + Math.floor(rand() * 4), p: -(50 + 12 * rand()), ph: rand() * TAU };

  function decoration(theta, z, r) {
    let V = 0;
    for (const v of vines) {
      const d = wrap(theta - vineTheta(v, z)) * r;
      const b = Math.exp(-sq(d / v.width));
      if (b > V) V = b;
    }
    for (const L of leaves) {
      const dzc = z - L.z0;
      if (dzc < -8 || dzc > 10) continue;
      // leaf centre in (arc, z) relative to its attachment point on the vine
      const thAttach = vineTheta(L.v, L.z0);
      const da = wrap(theta - thAttach) * r - L.ux * L.off;
      const dz = dzc - L.uz * L.off;
      const u = da * L.ux + dz * L.uz; // along leaf axis
      const w = -da * L.uz + dz * L.ux; // across
      // pointed leaf: width shrinks toward both ends
      const taper = Math.max(0.15, 1 - sq(u / (L.len * 1.25)));
      const b = L.amp * Math.exp(-sq(u / L.len) - sq(w / (L.wid * taper)));
      if (b > V) V = b;
    }
    const s1 = Math.sin(ribs1.k * theta + (TAU * z) / ribs1.p + ribs1.ph);
    const s2 = Math.sin(ribs2.k * theta + (TAU * z) / ribs2.p + ribs2.ph);
    return 0.2 * s1 + 0.12 * s2 + V;
  }

  // ----- drips -------------------------------------------------------------------------------
  const dripList = [];
  if (dripA > 0) {
    const nD = 3 + Math.floor(rand() * 3); // 3..5 drips
    for (let k = 0; k < nD; k++) {
      dripList.push({
        th: (k / nD) * TAU + (rand() - 0.5) * (TAU / nD) * 0.7,
        len: (0.08 + 0.17 * rand()) * H, // 8..25 % of the height
        w: 1.3 + 0.9 * rand(), // half-width (mm, arc length)
        a: dripA * (0.7 + 0.3 * rand()),
        meander: (rand() - 0.5) * 0.25,
      });
    }
  }
  const zDripTop = zd + 0.45 * hd;
  function dripAt(theta, z, r) {
    let D = 0;
    for (const d of dripList) {
      const zEnd = zd - d.len;
      if (z < zEnd - 4 * d.w || z > zDripTop) continue;
      const t = clamp01((zDripTop - z) / (zDripTop - zEnd)); // 0 at tip -> 1 at drip end
      const th = d.th + d.meander * Math.sin(t * Math.PI * 1.5);
      const w = d.w * (0.75 + 0.45 * t * t); // fattens toward the end (bulb)
      const across = wrap(theta - th) * Math.max(r, 1);
      let env = smoothstep(zDripTop, zd - 0.5, z) * (0.85 + 0.25 * t);
      if (z < zEnd + w) env *= Math.exp(-sq((zEnd + w - z) / (0.9 * w))); // rounded end
      const b = d.a * env * Math.exp(-sq(across / w));
      if (b > D) D = b;
    }
    return D;
  }

  // ----- rings ------------------------------------------------------------------------------
  const nBody = Math.max(4, Math.round(heightSegments * (zd / H)));
  const nDome = Math.max(4, Math.round(heightSegments * (hd / H) * 1.6));
  const rings = [];
  for (let j = 0; j <= nBody; j++) {
    const z = (zd * j) / nBody;
    const r0 = radiusAt(z);
    const wR = reliefWeight(z);
    rings.push({
      z,
      r: (theta) => Math.max(1, r0 + A * wR * decoration(theta, z, r0) + dripAt(theta, z, r0)),
    });
  }
  // tip dome: z = zd + hd sin(phi), r = R1 cos(phi); displacements scale with cos(phi) so they
  // vanish at the pole.
  for (let k = 1; k < nDome; k++) {
    const phi = (k / nDome) * (Math.PI / 2);
    const z = zd + hd * Math.sin(phi);
    const c = Math.cos(phi);
    const r0 = R1 * c;
    rings.push({ z, r: (theta) => Math.max(0.05, r0 + c * dripAt(theta, z, R1)) });
  }
  return latheMesh({ rings, segments: radialSegments, bottom: 'cap', top: { pole: H } });
}

/**
 * A row of `count` candles along X, centred on x = 0, y = 0, standing on z = 0.
 * castOrientation (default true): flipped upside down — wide flat base at the top (z = height)
 * where the mold's pour opening is, narrow tip at z = 0 — exactly how the reference mold box
 * casts tapers. Each candle gets its own seed (seed + index) so the decoration varies.
 * @returns {Array<{positions: Float32Array, indices: Uint32Array}>}
 */
export function makeCandleRow({ count = 3, spacing = 26, castOrientation = true, seed = 1, ...candleOpts } = {}) {
  const out = [];
  const H = candleOpts.height ?? 180;
  for (let k = 0; k < count; k++) {
    let m = makeTaperCandle({ ...candleOpts, seed: seed + k });
    if (castOrientation) m = flipUpsideDown(m, H);
    out.push(translateMesh(m, [(k - (count - 1) / 2) * spacing, 0, 0]));
  }
  return out;
}

/** Demo preset used by the UI / CLI: three 150 mm tapers, cast orientation (base up). */
export function demoCandles(opts = {}) {
  return makeCandleRow({ count: 3, spacing: 27, height: 150, baseRadius: 10.5, tipRadius: 5, ...opts });
}
