// Procedural test / demo solids as plain MeshData (pure JS: no manifold, no three).
//
//   MeshData = { positions: Float32Array (xyz), indices: Uint32Array (tri) }
//
// Every generator returns a closed, 2-manifold, consistently outward-oriented (CCW seen from
// outside) mesh with welded vertices, so it can be fed straight into `new Manifold(mesh)`.
// The small mesh utilities at the bottom (meshBBox, meshVolume, checkClosedManifold, ...) are
// shared by the demo candles, the CLI and the tests.

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------------------------
// Lathe builder
// ---------------------------------------------------------------------------------------------

/**
 * Surface of revolution around the Z axis.
 *
 * rings: [{ z, r }] with strictly increasing z. `r` is either a number or a function
 *        r(theta, ringIndex) -> radius (> 0) for non-circular rings (relief, drips...).
 * bottom / top: 'cap'  -> flat triangle fan to a centre vertex at the ring's z
 *               { pole: z } -> close to a single apex vertex at (0, 0, z) (z beyond the ring)
 *
 * Every ring is star-shaped around the axis and rings sit on strictly increasing z planes, so
 * the result is always an embedded (self-intersection free) closed surface as long as r > 0.
 */
export function latheMesh({ rings, segments = 48, bottom = 'cap', top = 'cap', minRadius = 1e-3 }) {
  const n = Math.max(3, segments | 0);
  const m = rings.length;
  if (m < 1) throw new Error('latheMesh: need at least one ring');
  for (let j = 1; j < m; j++) if (!(rings[j].z > rings[j - 1].z)) throw new Error('latheMesh: ring z must increase');
  if (m === 1 && bottom === 'cap' && top === 'cap') throw new Error('latheMesh: a single ring needs at least one pole');

  const nv = m * n + 2;
  const pos = new Float32Array(nv * 3);
  const cosT = new Float64Array(n), sinT = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / n) * TAU;
    cosT[i] = Math.cos(t);
    sinT[i] = Math.sin(t);
  }
  for (let j = 0; j < m; j++) {
    const { z, r } = rings[j];
    const fn = typeof r === 'function';
    for (let i = 0; i < n; i++) {
      let rr = fn ? r((i / n) * TAU, j) : r;
      if (!(rr > minRadius)) rr = minRadius;
      const k = (j * n + i) * 3;
      pos[k] = rr * cosT[i];
      pos[k + 1] = rr * sinT[i];
      pos[k + 2] = z;
    }
  }
  const iBot = m * n, iTop = m * n + 1;
  const zBot = bottom === 'cap' ? rings[0].z : bottom.pole;
  const zTop = top === 'cap' ? rings[m - 1].z : top.pole;
  if (!(zBot <= rings[0].z) || !(zTop >= rings[m - 1].z)) throw new Error('latheMesh: poles must lie beyond the end rings');
  pos.set([0, 0, zBot], iBot * 3);
  pos.set([0, 0, zTop], iTop * 3);

  const tris = new Uint32Array(((m - 1) * n * 2 + 2 * n) * 3);
  let t = 0;
  for (let j = 0; j < m - 1; j++)
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      const a = j * n + i, b = j * n + i1, c = (j + 1) * n + i1, d = (j + 1) * n + i;
      // split each quad along its shorter diagonal (nicer on twisted relief)
      if (dist2(pos, a, c) <= dist2(pos, b, d)) {
        tris[t++] = a; tris[t++] = b; tris[t++] = c;
        tris[t++] = a; tris[t++] = c; tris[t++] = d;
      } else {
        tris[t++] = a; tris[t++] = b; tris[t++] = d;
        tris[t++] = b; tris[t++] = c; tris[t++] = d;
      }
    }
  const last = (m - 1) * n;
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    tris[t++] = iBot; tris[t++] = i1; tris[t++] = i; // bottom faces -Z
    tris[t++] = last + i; tris[t++] = last + i1; tris[t++] = iTop; // top faces +Z
  }
  return { positions: pos, indices: tris };
}

function dist2(p, a, b) {
  const dx = p[a * 3] - p[b * 3], dy = p[a * 3 + 1] - p[b * 3 + 1], dz = p[a * 3 + 2] - p[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Vertical cylinder, base on z = 0 (or centred on the origin with center: true). */
export function makeCylinder({ r = 10, h = 30, segments = 64, center = false } = {}) {
  const z0 = center ? -h / 2 : 0;
  return latheMesh({ rings: [{ z: z0, r }, { z: z0 + h, r }], segments });
}

/** Truncated cone (frustum) from radius r1 at z = 0 to r2 at z = h. r1 or r2 may be 0 (apex). */
export function makeCone({ r1 = 10, r2 = 4, h = 30, segments = 64, center = false } = {}) {
  const z0 = center ? -h / 2 : 0;
  if (!(r1 > 0) && !(r2 > 0)) throw new Error('makeCone: r1 or r2 must be > 0');
  if (!(r2 > 0)) return latheMesh({ rings: [{ z: z0, r: r1 }], segments, bottom: 'cap', top: { pole: z0 + h } });
  if (!(r1 > 0)) return latheMesh({ rings: [{ z: z0 + h, r: r2 }], segments, bottom: { pole: z0 }, top: 'cap' });
  return latheMesh({ rings: [{ z: z0, r: r1 }, { z: z0 + h, r: r2 }], segments });
}

/** UV sphere (lathe with two poles). */
export function makeSphere({ r = 10, segments = 48, rings = 24, center = [0, 0, 0] } = {}) {
  const rs = [];
  for (let j = 1; j < rings; j++) {
    const phi = -Math.PI / 2 + (j / rings) * Math.PI;
    rs.push({ z: r * Math.sin(phi), r: r * Math.cos(phi) });
  }
  const mesh = latheMesh({ rings: rs, segments, bottom: { pole: -r }, top: { pole: r } });
  return translateMesh(mesh, center);
}

/**
 * Axis-aligned box. `size` = [sx, sy, sz] (or a number); `min` places the min corner, otherwise
 * the box sits on z = 0 centred in x/y (center: true centres it on the origin).
 */
export function makeBox({ size = [20, 20, 20], min = null, center = false } = {}) {
  const [sx, sy, sz] = typeof size === 'number' ? [size, size, size] : size;
  const o = min || (center ? [-sx / 2, -sy / 2, -sz / 2] : [-sx / 2, -sy / 2, 0]);
  const x0 = o[0], y0 = o[1], z0 = o[2], x1 = x0 + sx, y1 = y0 + sy, z1 = z0 + sz;
  const positions = new Float32Array([
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0,
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1,
  ]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // -Z
    4, 5, 6, 4, 6, 7, // +Z
    0, 1, 5, 0, 5, 4, // -Y
    2, 3, 7, 2, 7, 6, // +Y
    1, 2, 6, 1, 6, 5, // +X
    3, 0, 4, 3, 4, 7, // -X
  ]);
  return { positions, indices };
}

/**
 * Prism of a simple polygon drawn in the parting-plane coordinates (x, z), extruded along Y
 * over [y0, y1]. The polygon may be concave and in either winding.
 */
export function extrudeXZ(polygon, y0, y1) {
  if (!(y1 > y0)) throw new Error('extrudeXZ: y1 must be > y0');
  let poly = dedupePolygon(polygon);
  if (signedArea2(poly) < 0) poly = poly.slice().reverse(); // CCW in (x, z)
  const n = poly.length;
  const positions = new Float32Array(n * 2 * 3);
  for (let i = 0; i < n; i++) {
    positions.set([poly[i][0], y0, poly[i][1]], i * 3); // front (y0)
    positions.set([poly[i][0], y1, poly[i][1]], (n + i) * 3); // back (y1)
  }
  const capTris = earClip(poly); // CCW in (x, z)
  const tris = [];
  // (x, 0, 0) x (0, 0, z) = -Y: a CCW (x, z) triangle faces -Y. Front cap (y0) must face -Y
  // -> keep the winding; the back cap (y1) faces +Y -> reverse it.
  for (const [a, b, c] of capTris) {
    tris.push(a, b, c);
    tris.push(n + a, n + c, n + b);
  }
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n;
    // side quad of edge (i -> i1); for a CCW (x, z) polygon the outward side is to the right
    tris.push(i, n + i, n + i1, i, n + i1, i1);
  }
  return { positions, indices: new Uint32Array(tris) };
}

/**
 * "H" test body for air-vent detection: two vertical legs with domed tops (one leg shorter)
 * joined by a horizontal bar near the bottom, as one prism (extruded along Y, centred on y = 0).
 * Poured from the top of the tall leg, the short leg's dome is a closed ceiling that traps air
 * once the bar is full -> the vent finder must report exactly one vent (above the short leg).
 *
 * Defaults: legs 12 mm wide at x = -15 / +15, tall leg 50 mm, short leg 34 mm, bar z 4..14.
 */
export function makeHShape({
  legWidth = 12, depth = 12, spacing = 30, tallHeight = 50, shortHeight = 34,
  barBottom = 4, barTop = 14, domeSegments = 12,
} = {}) {
  const r = legWidth / 2;
  const xl = -spacing / 2, xr = spacing / 2; // leg axes: left = tall, right = short
  if (!(barTop < shortHeight - r && barBottom >= 0 && spacing > legWidth)) throw new Error('makeHShape: inconsistent dimensions');
  const pts = [];
  // CCW in (x, z): start bottom-left, go right along the bottom...
  pts.push([xl - r, 0], [xl + r, 0], [xl + r, barBottom], [xr - r, barBottom], [xr - r, 0], [xr + r, 0]);
  // right (short) leg up, domed top from angle 0 to pi
  const zr = shortHeight - r;
  pts.push([xr + r, zr]);
  for (let k = 1; k < domeSegments; k++) {
    const a = (k / domeSegments) * Math.PI;
    pts.push([xr + r * Math.cos(a), zr + r * Math.sin(a)]);
  }
  pts.push([xr - r, zr], [xr - r, barTop], [xl + r, barTop]);
  const zl = tallHeight - r;
  pts.push([xl + r, zl]);
  for (let k = 1; k < domeSegments; k++) {
    const a = (k / domeSegments) * Math.PI;
    pts.push([xl + r * Math.cos(a), zl + r * Math.sin(a)]);
  }
  pts.push([xl - r, zl]);
  return extrudeXZ(pts, -depth / 2, depth / 2);
}

// ---------------------------------------------------------------------------------------------
// 2-D helpers
// ---------------------------------------------------------------------------------------------

function signedArea2(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a;
}

function dedupePolygon(poly) {
  const out = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-9) out.pop();
  if (out.length < 3) throw new Error('polygon needs at least 3 distinct points');
  return out;
}

/** Ear-clipping triangulation of a simple CCW polygon -> [[i, j, k], ...] (CCW). */
export function earClip(poly) {
  const idx = poly.map((_, i) => i);
  const out = [];
  const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cross(a, b, p) >= -1e-12 && cross(b, c, p) >= -1e-12 && cross(c, a, p) >= -1e-12;
  let guard = 0;
  while (idx.length > 3 && guard++ < 100000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length], ib = idx[k], ic = idx[(k + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic];
      if (cross(a, b, c) <= 1e-12) continue; // reflex or degenerate
      let ear = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        const p = poly[j];
        if ((p[0] === a[0] && p[1] === a[1]) || (p[0] === c[0] && p[1] === c[1])) continue;
        if (inTri(p, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      out.push([ia, ib, ic]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) throw new Error('earClip: polygon is not simple');
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

// ---------------------------------------------------------------------------------------------
// MeshData utilities
// ---------------------------------------------------------------------------------------------

export function translateMesh(mesh, [dx = 0, dy = 0, dz = 0] = []) {
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) {
    p[i] += dx; p[i + 1] += dy; p[i + 2] += dz;
  }
  return { positions: p, indices: mesh.indices };
}

/**
 * Proper rotation by 180 deg about the X axis through z = h/2: (x, y, z) -> (x, -y, h - z).
 * Determinant +1, so triangle winding (outward orientation) is preserved.
 */
export function flipUpsideDown(mesh, h) {
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) {
    p[i + 1] = -p[i + 1];
    p[i + 2] = h - p[i + 2];
  }
  return { positions: p, indices: mesh.indices };
}

export function meshBBox(mesh) {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3)
    for (let a = 0; a < 3; a++) {
      const v = p[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  return { min, max };
}

/** Signed volume (mm^3); positive for a closed, outward-oriented mesh. */
export function meshVolume(mesh) {
  const p = mesh.positions, t = mesh.indices;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

export function meshArea(mesh) {
  const p = mesh.positions, t = mesh.indices;
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    s += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  }
  return s;
}

/**
 * Topological check: closed & 2-manifold & consistently oriented <=> every directed edge occurs
 * exactly once and its reverse occurs exactly once. Also flags degenerate (repeated-index)
 * triangles and unreferenced vertices.
 * @returns {{ok: boolean, triangles: number, vertices: number, boundaryEdges: number,
 *            nonManifoldEdges: number, degenerate: number, unused: number, eulerChar: number}}
 */
export function checkClosedManifold(mesh) {
  const t = mesh.indices, nv = mesh.positions.length / 3;
  const directed = new Map();
  let degenerate = 0;
  const used = new Uint8Array(nv);
  for (let i = 0; i < t.length; i += 3) {
    const v = [t[i], t[i + 1], t[i + 2]];
    if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) degenerate++;
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      used[a] = 1;
      const key = a * nv + b;
      directed.set(key, (directed.get(key) || 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0, undirected = 0;
  for (const [key, cnt] of directed) {
    const a = Math.floor(key / nv), b = key % nv;
    const rev = directed.get(b * nv + a) || 0;
    if (cnt > 1) nonManifold++;
    if (rev === 0) boundary++;
    else if (rev !== cnt) nonManifold++;
    if (a < b || rev === 0) undirected++;
  }
  let unused = 0;
  for (let i = 0; i < nv; i++) if (!used[i]) unused++;
  const nt = t.length / 3;
  return {
    ok: boundary === 0 && nonManifold === 0 && degenerate === 0,
    triangles: nt,
    vertices: nv,
    boundaryEdges: boundary,
    nonManifoldEdges: nonManifold,
    degenerate,
    unused,
    eulerChar: nv - unused - undirected + nt,
  };
}

/** Concatenate several MeshData into one (no welding across meshes). */
export function mergeMeshes(meshes) {
  let np = 0, ni = 0;
  for (const m of meshes) { np += m.positions.length; ni += m.indices.length; }
  const positions = new Float32Array(np), indices = new Uint32Array(ni);
  let op = 0, oi = 0;
  for (const m of meshes) {
    positions.set(m.positions, op);
    const base = op / 3;
    for (let i = 0; i < m.indices.length; i++) indices[oi + i] = m.indices[i] + base;
    op += m.positions.length;
    oi += m.indices.length;
  }
  return { positions, indices };
}
