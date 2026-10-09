// Pure-JS iso-surface mesher (marching tetrahedra on the voxel grid).
//
// Replaces Manifold.levelSet, whose WASM build traps on large outputs. The voxel cube
// (i..i+1, j..j+1, k..k+1) is split into the 6 Kuhn/Freudenthal tetrahedra along its main
// diagonal; this split is identical in every cube, so neighbouring tetrahedra share faces and
// the piecewise-linear zero set is a closed 2-manifold. Each crossing edge gets exactly one
// vertex (hashed by its lower grid vertex + edge direction), so the triangle soup is welded by
// construction. Values outside the cell range read as "outside", which closes the surface at
// the bounds (same semantics as Manifold.levelSet).
import { mf } from './wasm.js';

// Corner c -> offset (c & 1, (c >> 1) & 1, (c >> 2) & 1). All 6 tets are monotone chains 0 -> 7.
const TETS = [
  [0, 1, 3, 7], [0, 3, 2, 7], [0, 2, 6, 7],
  [0, 6, 4, 7], [0, 4, 5, 7], [0, 5, 1, 7],
];

/**
 * Triangle mesh of the boundary of {phi < level} inside the voxel box [lo, hi] (inclusive
 * voxel index ranges), closed at the box faces.
 * @returns {{positions: Float32Array, indices: Uint32Array}|null}
 */
export function isoSurface(phi, grid, level = 0, lo = [0, 0, 0], hi = [grid.nx - 1, grid.ny - 1, grid.nz - 1]) {
  const { nx, ny, h } = grid;
  const [ox, oy, oz] = grid.origin;
  const [i0, j0, k0] = lo;
  const [i1, j1, k1] = hi;
  const OUT = 0.5 * h;
  // Edge -> vertex tables for two z-layers of lower edge endpoints (padded x/y index space).
  const px = i1 - i0 + 3, py = j1 - j0 + 3;
  const layer = px * py;
  let L0 = new Int32Array(8 * layer).fill(-1);
  let L1 = new Int32Array(8 * layer).fill(-1);
  const val = (i, j, k) =>
    i < i0 || j < j0 || k < k0 || i > i1 || j > j1 || k > k1 ? OUT : phi[i + nx * (j + ny * k)] - level;

  let pos = new Float32Array(3 * 65536);
  let nv = 0;
  let tri = new Uint32Array(3 * 131072);
  let nt = 0;

  const cv = new Float64Array(8);
  const ci = new Int32Array(8), cj = new Int32Array(8);
  const cx = new Float64Array(8), cy = new Float64Array(8), cz = new Float64Array(8);

  function vertex(a, b) {
    // a, b: corner indices with a "lower" in the chain order (monotone offsets)
    const low = (a & b) === a ? a : b; // lower endpoint: its offset bits are a subset
    const type = a ^ b; // offset bits of high - low (1..7)
    const table = (low >> 2) & 1 ? L1 : L0;
    const key = type * layer + (ci[low] - i0 + 1) + px * (cj[low] - j0 + 1);
    let id = table[key];
    if (id >= 0) return id;
    const fa = cv[a], fb = cv[b];
    let t = fa / (fa - fb);
    if (t < 1e-4) t = 1e-4; else if (t > 1 - 1e-4) t = 1 - 1e-4;
    if (3 * (nv + 1) > pos.length) {
      const np = new Float32Array(pos.length * 2);
      np.set(pos);
      pos = np;
    }
    pos[3 * nv] = cx[a] + (cx[b] - cx[a]) * t;
    pos[3 * nv + 1] = cy[a] + (cy[b] - cy[a]) * t;
    pos[3 * nv + 2] = cz[a] + (cz[b] - cz[a]) * t;
    id = nv++;
    table[key] = id;
    return id;
  }

  function pushTri(a, b, c) {
    if (3 * (nt + 1) > tri.length) {
      const nt2 = new Uint32Array(tri.length * 2);
      nt2.set(tri);
      tri = nt2;
    }
    tri[3 * nt] = a; tri[3 * nt + 1] = b; tri[3 * nt + 2] = c;
    nt++;
  }

  // Polygon (3 or 4 verts, cyclic order) separating the inside corners from the outside
  // ones; flip it as a whole so its normal points from inside (mean of inC) to outside.
  function emitPoly(vs, inC, outC) {
    const P = (v, d) => pos[3 * v + d];
    let nxv, nyv, nzv;
    if (vs.length === 3) {
      const ux = P(vs[1], 0) - P(vs[0], 0), uy = P(vs[1], 1) - P(vs[0], 1), uz = P(vs[1], 2) - P(vs[0], 2);
      const vx = P(vs[2], 0) - P(vs[0], 0), vy = P(vs[2], 1) - P(vs[0], 1), vz = P(vs[2], 2) - P(vs[0], 2);
      nxv = uy * vz - uz * vy; nyv = uz * vx - ux * vz; nzv = ux * vy - uy * vx;
    } else {
      const ux = P(vs[2], 0) - P(vs[0], 0), uy = P(vs[2], 1) - P(vs[0], 1), uz = P(vs[2], 2) - P(vs[0], 2);
      const vx = P(vs[3], 0) - P(vs[1], 0), vy = P(vs[3], 1) - P(vs[1], 1), vz = P(vs[3], 2) - P(vs[1], 2);
      nxv = uy * vz - uz * vy; nyv = uz * vx - ux * vz; nzv = ux * vy - uy * vx;
    }
    let ix = 0, iy = 0, iz = 0, qx = 0, qy = 0, qz = 0;
    for (const c of inC) { ix += cx[c]; iy += cy[c]; iz += cz[c]; }
    for (const c of outC) { qx += cx[c]; qy += cy[c]; qz += cz[c]; }
    const dx = qx / outC.length - ix / inC.length, dy = qy / outC.length - iy / inC.length, dz = qz / outC.length - iz / inC.length;
    const flip = nxv * dx + nyv * dy + nzv * dz < 0;
    if (vs.length === 3) {
      if (flip) pushTri(vs[0], vs[2], vs[1]); else pushTri(vs[0], vs[1], vs[2]);
    } else if (flip) {
      pushTri(vs[0], vs[2], vs[1]);
      pushTri(vs[0], vs[3], vs[2]);
    } else {
      pushTri(vs[0], vs[1], vs[2]);
      pushTri(vs[0], vs[2], vs[3]);
    }
  }

  for (let k = k0 - 1; k <= k1; k++) {
    if (k > k0 - 1) {
      const tmp = L0; L0 = L1; L1 = tmp; L1.fill(-1);
    }
    for (let j = j0 - 1; j <= j1; j++) {
      for (let i = i0 - 1; i <= i1; i++) {
        let nIn = 0;
        for (let c = 0; c < 8; c++) {
          const v = val(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1));
          cv[c] = v;
          if (v < 0) nIn++;
        }
        if (nIn === 0 || nIn === 8) continue;
        for (let c = 0; c < 8; c++) {
          const ii = i + (c & 1), jj = j + ((c >> 1) & 1), kk = k + ((c >> 2) & 1);
          ci[c] = ii; cj[c] = jj;
          cx[c] = ox + h * ii; cy[c] = oy + h * jj; cz[c] = oz + h * kk;
        }
        for (let t = 0; t < 6; t++) {
          const T = TETS[t];
          let mask = 0;
          for (let q = 0; q < 4; q++) if (cv[T[q]] < 0) mask |= 1 << q;
          if (mask === 0 || mask === 15) continue;
          const ins = [], outs = [];
          for (let q = 0; q < 4; q++) (mask & (1 << q) ? ins : outs).push(T[q]);
          if (ins.length === 1 || outs.length === 1) {
            const single = ins.length === 1 ? ins[0] : outs[0];
            const others = ins.length === 1 ? outs : ins;
            emitPoly([vertex(single, others[0]), vertex(single, others[1]), vertex(single, others[2])], ins, outs);
          } else {
            const [p, q] = ins, [r, s] = outs;
            emitPoly([vertex(p, r), vertex(p, s), vertex(q, s), vertex(q, r)], ins, outs);
          }
        }
      }
    }
  }
  if (nt === 0) return null;
  return { positions: pos.slice(0, 3 * nv), indices: tri.slice(0, 3 * nt) };
}

/**
 * Manifold of {phi < level}. `bounds` (mm box) restricts and closes the surface; `simplify`
 * is the manifold simplify tolerance in mm (default 0.25 h, 0 disables).
 */
export function isoSurfaceSolid(phi, grid, { level = 0, bounds, simplify } = {}) {
  const { Manifold, Mesh } = mf();
  const { nx, ny, nz, h } = grid;
  const o = grid.origin;
  let lo = [0, 0, 0], hi = [nx - 1, ny - 1, nz - 1];
  if (bounds) {
    lo = [0, 1, 2].map((a) => Math.max(0, Math.ceil((bounds.min[a] - o[a]) / h - 1e-9)));
    hi = [0, 1, 2].map((a, idx) => Math.min([nx, ny, nz][idx] - 1, Math.floor((bounds.max[a] - o[a]) / h + 1e-9)));
  }
  // tighten to the voxels that are inside
  const t = tightRange(phi, grid, level, lo, hi);
  if (!t) return null;
  const surf = isoSurface(phi, grid, level, t.lo, t.hi);
  if (!surf) return null;
  const mesh = new Mesh({ numProp: 3, vertProperties: surf.positions, triVerts: surf.indices });
  let m = new Manifold(mesh);
  if (m.status() !== 'NoError') throw new Error(`isoSurfaceSolid: mesher produced a non-manifold mesh (${m.status()})`);
  const tol = simplify === undefined ? 0.25 * h : simplify;
  if (tol > 0) {
    const s = m.simplify(tol);
    m.delete?.();
    m = s;
  }
  if (m.isEmpty()) return null;
  return m;
}

function tightRange(phi, grid, level, lo, hi) {
  const { nx, ny } = grid;
  let a0 = Infinity, a1 = -1, b0 = Infinity, b1 = -1, c0 = Infinity, c1 = -1;
  for (let k = lo[2]; k <= hi[2]; k++) {
    for (let j = lo[1]; j <= hi[1]; j++) {
      let v = lo[0] + nx * (j + ny * k);
      let hit = false;
      for (let i = lo[0]; i <= hi[0]; i++, v++) {
        if (phi[v] < level) {
          hit = true;
          if (i < a0) a0 = i;
          if (i > a1) a1 = i;
        }
      }
      if (hit) {
        if (j < b0) b0 = j;
        if (j > b1) b1 = j;
        if (k < c0) c0 = k;
        if (k > c1) c1 = k;
      }
    }
  }
  if (a1 < 0) return null;
  return {
    lo: [Math.max(lo[0], a0 - 1), Math.max(lo[1], b0 - 1), Math.max(lo[2], c0 - 1)],
    hi: [Math.min(hi[0], a1 + 1), Math.min(hi[1], b1 + 1), Math.min(hi[2], c1 + 1)],
  };
}
