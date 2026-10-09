// Mold-frame helpers. Mold frame: Z up (pour), parting plane y = y0,
// half A on y < y0 (pulled -Y), half B on y > y0 (pulled +Y).
// Plane 2-D coordinates are (u, v) = (x, z).
import { mf } from './wasm.js';

/** Extrude a CrossSection given in plane coords (x, z) along Y over [yA, yB] (yA < yB). */
export function planeExtrude(cs, yA, yB) {
  const L = yB - yA;
  if (!(L > 0)) throw new Error(`planeExtrude: empty Y range [${yA}, ${yB}]`);
  return cs.extrude(L).rotate([90, 0, 0]).translate([0, yB, 0]);
}

/** Cross-section of a solid at plane y, returned in plane coords (x, z). */
export function planeSlice(solid, y) {
  return solid.rotate([-90, 0, 0]).slice(-y);
}

/** Silhouette of a solid projected onto the parting plane, in plane coords (x, z). */
export function planeProject(solid) {
  return solid.rotate([-90, 0, 0]).project();
}

/** Keep the part of `solid` with y <= y0 (side 'A') or y >= y0 (side 'B'). */
export function trimSide(solid, side, y0) {
  // trimByPlane keeps the side the normal points to: dot(n, p) >= offset
  return side === 'A' ? solid.trimByPlane([0, -1, 0], -y0) : solid.trimByPlane([0, 1, 0], y0);
}

/** Keep zMin <= z <= zMax. */
export function trimZ(solid, zMin, zMax) {
  let s = solid;
  if (zMin !== undefined && zMin !== null) s = s.trimByPlane([0, 0, 1], zMin);
  if (zMax !== undefined && zMax !== null) s = s.trimByPlane([0, 0, -1], -zMax);
  return s;
}

/** Axis-aligned box solid from min/max corners. */
export function box(min, max) {
  const { Manifold } = mf();
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (size.some((s) => !(s > 0))) return null; // empty box
  return Manifold.cube(size).translate(min);
}

/** Rectangle CrossSection in plane coords (x, z). */
export function rect2(xMin, zMin, xMax, zMax) {
  const { CrossSection } = mf();
  return CrossSection.square([xMax - xMin, zMax - zMin]).translate([xMin, zMin]);
}

/** Cylinder between two points (radius r), any orientation. */
export function rod(p0, p1, r, segments = 24) {
  const { Manifold } = mf();
  const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (len < 1e-9) return Manifold.sphere(r, segments).translate(p0);
  // cylinder along +Z of height len, then rotate so +Z -> d
  const c = Manifold.cylinder(len, r, r, segments);
  const m = rotationZTo([d[0] / len, d[1] / len, d[2] / len]);
  m[12] = p0[0]; m[13] = p0[1]; m[14] = p0[2];
  return c.transform(m);
}

/** Column-major rotation matrix mapping +Z to unit vector n. */
export function rotationZTo(n) {
  const z = [0, 0, 1];
  const dot = n[2];
  if (dot > 1 - 1e-12) return mat4Identity();
  if (dot < -1 + 1e-12) return [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1];
  const ax = [z[1] * n[2] - z[2] * n[1], z[2] * n[0] - z[0] * n[2], z[0] * n[1] - z[1] * n[0]];
  const s = Math.hypot(ax[0], ax[1], ax[2]);
  const k = [ax[0] / s, ax[1] / s, ax[2] / s];
  return mat4AxisAngle(k, Math.atan2(s, dot));
}

export function mat4Identity() {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

export function mat4Translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

/** Rotation about unit axis k by angle a (radians), column-major. */
export function mat4AxisAngle(k, a) {
  const c = Math.cos(a), s = Math.sin(a), t = 1 - c;
  const [x, y, z] = k;
  return [
    t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0,
    t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0,
    t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0,
    0, 0, 0, 1,
  ];
}

/** a * b (column-major). */
export function mat4Mul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      o[c * 4 + r] = s;
    }
  return o;
}

export function mat4ApplyPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** Bounding box of a manifold as {min:[3], max:[3]}. */
export function bbox(solid) {
  const b = solid.boundingBox();
  return { min: [...b.min], max: [...b.max] };
}

/** Point-in-polygon (even-odd) over CrossSection.toPolygons() output. */
export function pointInPolygons(polys, x, y) {
  let inside = false;
  for (const poly of polys) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** Signed area of a simple polygon ([[x,y],...]). */
export function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return -a / 2;
}

/** Union that tolerates empty / null entries. */
export function unionAll(list) {
  const { Manifold } = mf();
  const items = list.filter((m) => m && !m.isEmpty());
  if (items.length === 0) return null;
  if (items.length === 1) return items[0];
  return Manifold.union(items);
}
