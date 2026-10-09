// Voxel signed-distance-field toolkit used for offsets of arbitrary meshes.
//
//   occ  = voxelize(mesh, grid)          Uint8Array, 1 = inside (scan-line crossings)
//   phi  = signedDistance(occ, grid)     Float32Array, mm, negative inside (exact EDT)
//   sweepMin / addScalar / minFields / maxFields   cheap column / pointwise field ops
//   levelSetSolid(phi, grid, {level})    Manifold of {phi < level} via Manifold.levelSet
//
// Layout: voxel (i,j,k) has its centre at origin + h*[i,j,k] and linear index
// i + nx*(j + ny*k) (x fastest). No bare imports here (runs in Web Workers): the WASM
// module comes from mf().
import { mf } from './wasm.js';
import { isoSurfaceSolid } from './mesher.js';

const FAR = 1e6;
let BUMP_BOUNDS = typeof process !== "undefined" && process.env && process.env.MELTEMI_BUMP === "1";
const INF = 1e20; // EDT infinity (squared voxel units)
// Tiny irrational jitter of the column centres (fraction of h) so scan lines never pass
// exactly through mesh vertices or edges that lie on "nice" coordinates.
const JIT_A = 1e-4 * 0.7548776662;
const JIT_B = 1e-4 * 0.569840291;

export class Grid {
  /** Voxel centres at origin + h*[i,j,k], i<nx, j<ny, k<nz. */
  constructor(origin, h, nx, ny, nz) {
    if (!(h > 0)) throw new Error(`Grid: invalid voxel size ${h}`);
    this.origin = [origin[0], origin[1], origin[2]];
    this.h = h;
    this.nx = nx | 0;
    this.ny = ny | 0;
    this.nz = nz | 0;
    if (this.nx < 1 || this.ny < 1 || this.nz < 1) throw new Error(`Grid: invalid dims ${nx}x${ny}x${nz}`);
    this.n = this.nx * this.ny * this.nz;
  }

  index(i, j, k) {
    return i + this.nx * (j + this.ny * k);
  }

  point(i, j, k) {
    const o = this.origin, h = this.h;
    return [o[0] + h * i, o[1] + h * j, o[2] + h * k];
  }

  /** Box spanned by the centres of the extreme voxels. */
  bounds() {
    const o = this.origin, h = this.h;
    return {
      min: [o[0], o[1], o[2]],
      max: [o[0] + h * (this.nx - 1), o[1] + h * (this.ny - 1), o[2] + h * (this.nz - 1)],
    };
  }
}

/**
 * Grid covering [min - margin, max + margin] with voxel size
 * h = max(minVoxel, cbrt(boxVolume / maxVoxels)) and 2 extra voxels of padding per side.
 */
export function gridForBox(min, max, margin = 0, { maxVoxels = 4e6, minVoxel = 0.4 } = {}) {
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a]) || max[a] < min[a]) {
      throw new Error(`gridForBox: invalid box [${min}] - [${max}]`);
    }
  }
  const lo = [min[0] - margin, min[1] - margin, min[2] - margin];
  const hi = [max[0] + margin, max[1] + margin, max[2] + margin];
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  // guard against flat boxes: never let an axis contribute less than one voxel of extent
  const vol = Math.max(size[0], minVoxel) * Math.max(size[1], minVoxel) * Math.max(size[2], minVoxel);
  const h = Math.max(minVoxel, Math.cbrt(vol / maxVoxels));
  const PAD = 2;
  // The lattice is shifted by an irrational fraction of h so that voxel centres do not land
  // exactly on axis-aligned faces of the input (e.g. bbox faces): avoids ambiguous
  // in/out decisions and the +1 voxel layer bias they cause. One extra cell keeps >= PAD
  // voxels of padding on both sides.
  const SHIFT = 0.3819660113;
  const dims = [0, 0, 0];
  const origin = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const cells = Math.max(1, Math.ceil(size[a] / h - 1e-9)); // cells spanning [lo, hi]
    dims[a] = cells + 2 + 2 * PAD;
    origin[a] = lo[a] - (PAD + SHIFT) * h;
  }
  return new Grid(origin, h, dims[0], dims[1], dims[2]);
}

// ---------------------------------------------------------------------------------------
// Voxelization
// ---------------------------------------------------------------------------------------

/**
 * Scan-line voxelization. For every column of voxel centres parallel to the scan axis the
 * crossings with the mesh are collected, sorted and turned into inside intervals.
 * Fill rule per column: non-zero winding when the column's crossings balance (closed,
 * consistently oriented meshes — also correct for overlapping shells / inverted meshes),
 * otherwise even-odd parity with the last crossing ignored if the count is odd (open mesh).
 *
 * @param {{positions: ArrayLike<number>, indices?: ArrayLike<number>}} mesh
 * @param {Grid} grid
 * @param {{axes?: 'z'|'xyz'|'auto'}} [opts]
 *   'z'    — single scan along +Z (fast path).
 *   'xyz'  — scan along X, Y and Z and take a majority vote per voxel; columns with
 *            unbalanced crossings abstain (robust for open / broken meshes).
 *   'auto' (default) — 'z'; if any column was unbalanced (open mesh) redo with 'xyz'.
 * @returns {Uint8Array} occ, 1 = inside
 */
export function voxelize(mesh, grid, { axes = 'auto' } = {}) {
  const pos = mesh.positions;
  const idx = mesh.indices && mesh.indices.length ? mesh.indices : null;
  const nTri = idx ? (idx.length / 3) | 0 : (pos.length / 9) | 0;
  let occ = new Uint8Array(grid.n);
  if (nTri === 0) return occ;
  if (axes === 'xyz') occ = voxelizeVote(pos, idx, nTri, grid);
  else {
    const unbalanced = scanAxis(pos, idx, nTri, grid, 2, occ, null);
    if (axes === 'auto' && unbalanced > 0) occ = voxelizeVote(pos, idx, nTri, grid);
  }
  attachSource(occ, grid, { positions: pos, indices: idx }, nTri);
  return occ;
}

// The source mesh rides along with the occupancy (non-enumerable, lost on copies / worker
// transfer) so that signedDistance() can compute sub-voxel-exact distances near the surface.
function attachSource(occ, grid, mesh, nTri) {
  let count = 0;
  for (let v = 0; v < occ.length; v++) count += occ[v];
  Object.defineProperty(occ, 'source', {
    value: { mesh, nTri, count, grid: { origin: grid.origin.slice(), h: grid.h, nx: grid.nx, ny: grid.ny, nz: grid.nz } },
    enumerable: false, writable: true, configurable: true,
  });
}

function sameGrid(a, b) {
  return a.h === b.h && a.nx === b.nx && a.ny === b.ny && a.nz === b.nz &&
    a.origin[0] === b.origin[0] && a.origin[1] === b.origin[1] && a.origin[2] === b.origin[2];
}

/** Voxelize a Manifold (uses getMesh()). */
export function voxelizeManifold(manifold, grid, opts) {
  const g = manifold.getMesh();
  const np = g.numProp;
  let positions = g.vertProperties;
  if (np !== 3) {
    const nv = (positions.length / np) | 0;
    const p = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      p[3 * v] = positions[np * v];
      p[3 * v + 1] = positions[np * v + 1];
      p[3 * v + 2] = positions[np * v + 2];
    }
    positions = p;
  }
  return voxelize({ positions, indices: g.triVerts }, grid, opts ?? { axes: 'z' });
}

function voxelizeVote(pos, idx, nTri, grid) {
  const votes = new Int8Array(grid.n);
  for (let c = 0; c < 3; c++) scanAxis(pos, idx, nTri, grid, c, null, votes);
  const occ = new Uint8Array(grid.n);
  for (let v = 0; v < grid.n; v++) occ[v] = votes[v] > 0 ? 1 : 0;
  return occ;
}

/**
 * Scan along axis c. Columns are indexed by the two other axes (a, b) = (c+1, c+2) mod 3
 * (cyclic, so the projected signed area equals the c-component of the face normal).
 * Writes 1s into `occ` (single-axis mode) or adds +1/-1 votes into `votes`.
 * Returns the number of unbalanced columns.
 */
function scanAxis(pos, idx, nTri, grid, c, occ, votes) {
  const a = (c + 1) % 3, b = (c + 2) % 3;
  const dims = [grid.nx, grid.ny, grid.nz];
  const strides = [1, grid.nx, grid.nx * grid.ny];
  const na = dims[a], nb = dims[b], nc = dims[c];
  const sA = strides[a], sB = strides[b], sC = strides[c];
  const h = grid.h, invH = 1 / h;
  const oA = grid.origin[a] + JIT_A * h; // jittered column centre origin
  const oB = grid.origin[b] + JIT_B * h;
  const oC = grid.origin[c];
  const nCol = na * nb;
  const counts = new Uint32Array(nCol + 1);

  let ts = null, sg = null, fillPos = null;
  for (let pass = 0; pass < 2; pass++) {
    const store = pass === 1;
    for (let t = 0; t < nTri; t++) {
      let v0, v1, v2;
      if (idx) { v0 = idx[3 * t]; v1 = idx[3 * t + 1]; v2 = idx[3 * t + 2]; }
      else { v0 = 3 * t; v1 = 3 * t + 1; v2 = 3 * t + 2; }
      const A0 = pos[3 * v0 + a], B0 = pos[3 * v0 + b];
      const A1 = pos[3 * v1 + a], B1 = pos[3 * v1 + b];
      const A2 = pos[3 * v2 + a], B2 = pos[3 * v2 + b];
      // column-index bounding box of the projected triangle
      let mn = A0 < A1 ? A0 : A1; if (A2 < mn) mn = A2;
      let mx = A0 > A1 ? A0 : A1; if (A2 > mx) mx = A2;
      let iaLo = Math.floor((mn - oA) * invH); if (iaLo < 0) iaLo = 0;
      let iaHi = Math.floor((mx - oA) * invH); if (iaHi > na - 1) iaHi = na - 1;
      if (iaLo > iaHi) continue;
      mn = B0 < B1 ? B0 : B1; if (B2 < mn) mn = B2;
      mx = B0 > B1 ? B0 : B1; if (B2 > mx) mx = B2;
      let ibLo = Math.floor((mn - oB) * invH); if (ibLo < 0) ibLo = 0;
      let ibHi = Math.floor((mx - oB) * invH); if (ibHi > nb - 1) ibHi = nb - 1;
      if (ibLo > ibHi) continue;
      const area2 = (A1 - A0) * (B2 - B0) - (B1 - B0) * (A2 - A0);
      if (area2 === 0) continue; // edge-on: contributes no crossings
      // normal_c < 0 => ray along +c enters the solid
      const s = area2 < 0 ? 1 : -1;
      // Canonical edge functions (endpoints ordered lexicographically) so that two
      // triangles sharing an edge evaluate bit-identical values there.
      let pa, pb, qa, qb;
      // edge 0: (v1, v2), opposite v0
      if (A1 < A2 || (A1 === A2 && B1 < B2)) { pa = A1; pb = B1; qa = A2; qb = B2; } else { pa = A2; pb = B2; qa = A1; qb = B1; }
      const e0a = pa, e0b = pb, e0da = qa - pa, e0db = qb - pb;
      // edge 1: (v2, v0), opposite v1
      if (A2 < A0 || (A2 === A0 && B2 < B0)) { pa = A2; pb = B2; qa = A0; qb = B0; } else { pa = A0; pb = B0; qa = A2; qb = B2; }
      const e1a = pa, e1b = pb, e1da = qa - pa, e1db = qb - pb;
      // edge 2: (v0, v1), opposite v2
      if (A0 < A1 || (A0 === A1 && B0 < B1)) { pa = A0; pb = B0; qa = A1; qb = B1; } else { pa = A1; pb = B1; qa = A0; qb = B0; }
      const e2a = pa, e2b = pb, e2da = qa - pa, e2db = qb - pb;
      const d0 = e0da * (B0 - e0b) - e0db * (A0 - e0a);
      const d1 = e1da * (B1 - e1b) - e1db * (A1 - e1a);
      const d2 = e2da * (B2 - e2b) - e2db * (A2 - e2a);
      if (d0 === 0 || d1 === 0 || d2 === 0) continue;
      // A point exactly on an edge belongs to the triangle whose opposite vertex lies on the
      // positive side of the canonical edge (=> counted once across a shared edge).
      const p0 = d0 > 0, p1 = d1 > 0, p2 = d2 > 0;
      let w0 = 0, w1 = 0, w2 = 0;
      if (store) {
        w0 = pos[3 * v0 + c] / d0; w1 = pos[3 * v1 + c] / d1; w2 = pos[3 * v2 + c] / d2;
      }
      for (let ib = ibLo; ib <= ibHi; ib++) {
        const PB = oB + ib * h;
        const r0 = PB - e0b, r1 = PB - e1b, r2 = PB - e2b;
        const rowBase = ib * na;
        for (let ia = iaLo; ia <= iaHi; ia++) {
          const PA = oA + ia * h;
          const f0 = e0da * r0 - e0db * (PA - e0a);
          if (p0 ? f0 < 0 : f0 >= 0) continue;
          const f1 = e1da * r1 - e1db * (PA - e1a);
          if (p1 ? f1 < 0 : f1 >= 0) continue;
          const f2 = e2da * r2 - e2db * (PA - e2a);
          if (p2 ? f2 < 0 : f2 >= 0) continue;
          const col = rowBase + ia;
          if (store) {
            const q = fillPos[col]++;
            ts[q] = f0 * w0 + f1 * w1 + f2 * w2;
            sg[q] = s;
          } else {
            counts[col]++;
          }
        }
      }
    }
    if (!store) {
      // exclusive prefix sum -> column offsets
      let acc = 0;
      for (let col = 0; col < nCol; col++) { const k = counts[col]; counts[col] = acc; acc += k; }
      counts[nCol] = acc;
      ts = new Float64Array(acc);
      sg = new Int8Array(acc);
      fillPos = counts.slice(0, nCol);
    }
  }

  // Per column: sort crossings, then fill intervals.
  let unbalanced = 0;
  const vote = votes !== null;
  for (let col = 0; col < nCol; col++) {
    const s0 = counts[col], s1 = counts[col + 1];
    const cnt = s1 - s0;
    const ia = col % na, ib = (col / na) | 0;
    const base = ia * sA + ib * sB;
    if (cnt === 0) {
      if (vote) for (let k = 0; k < nc; k++) votes[base + k * sC] -= 1;
      continue;
    }
    // insertion sort of (ts, sg) pairs — columns hold few crossings
    for (let q = s0 + 1; q < s1; q++) {
      const tq = ts[q], sq = sg[q];
      let r = q - 1;
      while (r >= s0 && ts[r] > tq) { ts[r + 1] = ts[r]; sg[r + 1] = sg[r]; r--; }
      ts[r + 1] = tq; sg[r + 1] = sq;
    }
    let tot = 0;
    for (let q = s0; q < s1; q++) tot += sg[q];
    const out = vote ? votes : occ;
    const add = vote ? 2 : 1;
    if (tot === 0) {
      if (vote) for (let k = 0; k < nc; k++) votes[base + k * sC] -= 1;
      // non-zero winding rule
      let w = 0, start = 0;
      for (let q = s0; q < s1; q++) {
        const prev = w;
        w += sg[q];
        if (prev === 0 && w !== 0) start = ts[q];
        else if (prev !== 0 && w === 0) fillSpan(out, add, vote, base, sC, nc, oC, invH, start, ts[q]);
      }
    } else {
      unbalanced++;
      if (vote) continue; // abstain: other axes decide
      const m = cnt & ~1; // parity, ignoring the last crossing when odd
      for (let q = s0; q < s0 + m; q += 2) fillSpan(out, add, vote, base, sC, nc, oC, invH, ts[q], ts[q + 1]);
    }
  }
  return unbalanced;
}

/** Mark voxel centres with t0 <= t < t1 along a column. */
function fillSpan(out, add, vote, base, sC, nc, oC, invH, t0, t1) {
  let k0 = Math.ceil((t0 - oC) * invH);
  let k1 = Math.ceil((t1 - oC) * invH) - 1;
  if (k0 < 0) k0 = 0;
  if (k1 > nc - 1) k1 = nc - 1;
  if (vote) for (let k = k0; k <= k1; k++) out[base + k * sC] += add;
  else for (let k = k0; k <= k1; k++) out[base + k * sC] = 1;
}

// ---------------------------------------------------------------------------------------
// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), separable.
// ---------------------------------------------------------------------------------------

/**
 * Signed distance field (mm, negative inside) from voxel occupancy.
 *
 * Occupancy-only estimate (always available): outside voxels get the distance to the
 * nearest inside voxel centre minus h/2, inside voxels -(distance to the nearest outside
 * voxel centre minus h/2) — error up to ~h/2.
 *
 * Exact-surface refinement (default when `occ` came straight from voxelize() /
 * voxelizeManifold() on this grid and was not modified): every boundary voxel gets its
 * exact closest point on the source mesh; closest points are propagated with an exact
 * Euclidean feature transform and phi = ±|p − closest point| (sub-voxel accurate near the
 * surface, second-order error far away). Pass {exact:false} to force the estimate.
 *
 * With no inside voxels at all phi = +1e6 everywhere (and -1e6 if the grid is full).
 */
export function signedDistance(occ, grid, { exact = true } = {}) {
  const n = grid.n, h = grid.h, hh = h / 2;
  let nIn = 0;
  for (let v = 0; v < n; v++) nIn += occ[v];
  if (nIn === 0) return new Float32Array(n).fill(FAR);
  if (nIn === n) return new Float32Array(n).fill(-FAR);
  const src = exact ? occ.source : null;
  if (src && src.count === nIn && sameGrid(src.grid, grid)) return signedDistanceExact(occ, grid, src.mesh, src.nTri);
  const phi = new Float32Array(n);
  const work = new Float32Array(n);
  edtSquared(occ, grid, 1, work); // distance to the nearest inside voxel
  for (let v = 0; v < n; v++) if (!occ[v]) phi[v] = Math.sqrt(work[v]) * h - hh;
  edtSquared(occ, grid, 0, work); // distance to the nearest outside voxel
  for (let v = 0; v < n; v++) if (occ[v]) phi[v] = hh - Math.sqrt(work[v]) * h;
  return phi;
}

/** Squared EDT in voxel units to the nearest voxel with occ === target, written to out. */
function edtSquared(occ, grid, target, out) {
  const { nx, ny, nz } = grid;
  // Pass X: 1-D distance of a binary row (two sweeps), contiguous memory.
  for (let row = 0, nRows = ny * nz; row < nRows; row++) {
    const base = row * nx;
    let last = -1;
    for (let i = 0; i < nx; i++) {
      if (occ[base + i] === target) { out[base + i] = 0; last = i; }
      else out[base + i] = last < 0 ? INF : (i - last) * (i - last);
    }
    last = -1;
    for (let i = nx - 1; i >= 0; i--) {
      if (occ[base + i] === target) last = i;
      else if (last >= 0) {
        const d = (last - i) * (last - i);
        if (d < out[base + i]) out[base + i] = d;
      }
    }
  }
  const maxN = Math.max(nx, ny, nz);
  const BLK = 16;
  const f = new Float64Array(maxN * BLK);
  const d = new Float64Array(maxN);
  const vIdx = new Int32Array(maxN);
  const zB = new Float64Array(maxN + 1);
  // Pass Y (stride nx) and pass Z (stride nx*ny): gather BLK x-adjacent lines at a time so
  // every cache line fetched is fully used.
  for (const [len, stride, outer, outerStride] of [
    [ny, nx, nz, nx * ny],
    [nz, nx * ny, ny, nx],
  ]) {
    for (let o = 0; o < outer; o++) {
      const ob = o * outerStride;
      for (let i0 = 0; i0 < nx; i0 += BLK) {
        const bw = Math.min(BLK, nx - i0);
        for (let t = 0; t < len; t++) {
          const src = ob + i0 + t * stride;
          for (let bi = 0; bi < bw; bi++) f[bi * len + t] = out[src + bi];
        }
        for (let bi = 0; bi < bw; bi++) {
          edt1d(f, bi * len, len, d, vIdx, zB);
          for (let t = 0; t < len; t++) out[ob + i0 + bi + t * stride] = d[t];
        }
      }
    }
  }
}

/** 1-D lower envelope of parabolas over f[off .. off+n), result in d[0..n). */
function edt1d(f, off, n, d, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    const fq = f[off + q];
    if (fq >= INF) continue; // no site here
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    const vq = fq + q * q;
    let s;
    for (;;) {
      const p = v[k];
      s = (vq - (f[off + p] + p * p)) / (2 * (q - p));
      if (s <= z[k]) { k--; if (k < 0) break; } else break;
    }
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  if (k < 0) { for (let q = 0; q < n; q++) d[q] = INF; return; }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[off + p];
  }
}

// ---------------------------------------------------------------------------------------
// Exact-surface signed distance: boundary voxels -> exact closest point on the mesh ->
// Euclidean feature transform -> phi = ±|p - closest point|.
// ---------------------------------------------------------------------------------------

const CP = new Float64Array(3); // scratch output of closestPointTri

/** Closest point on triangle abc to p (Ericson, RTCD 5.1.5); writes CP, returns squared distance. */
function closestPointTri(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den, w = vc * den;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  CP[0] = qx; CP[1] = qy; CP[2] = qz;
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz; // NaN for degenerate input -> never "closer"
}

function signedDistanceExact(occ, grid, mesh, nTri) {
  const { nx, ny, nz, h, n } = grid;
  const ox = grid.origin[0], oy = grid.origin[1], oz = grid.origin[2];
  const sy = nx, sz = nx * ny;
  const pos = mesh.positions, idx = mesh.indices;

  // 1. Boundary voxels (a 6-neighbour has the other occupancy). The surface crosses the
  //    segment to that neighbour, so its closest surface point is within h.
  const isB = new Uint8Array(n);
  for (let row = 0, nRows = ny * nz; row < nRows; row++) {
    const base = row * nx;
    for (let v = base, e = base + nx - 1; v < e; v++) if (occ[v] !== occ[v + 1]) { isB[v] = 1; isB[v + 1] = 1; }
  }
  for (let k = 0; k < nz; k++) {
    for (let v = k * sz, e = k * sz + sy * (ny - 1); v < e; v++) if (occ[v] !== occ[v + sy]) { isB[v] = 1; isB[v + sy] = 1; }
  }
  for (let v = 0, e = sz * (nz - 1); v < e; v++) if (occ[v] !== occ[v + sz]) { isB[v] = 1; isB[v + sz] = 1; }
  let nB = 0;
  for (let v = 0; v < n; v++) nB += isB[v];
  const bVox = new Int32Array(nB);
  const sid = new Int32Array(n).fill(-1);
  for (let v = 0, b = 0; v < n; v++) if (isB[v]) { bVox[b] = v; sid[v] = b++; }

  // 2./3. Exact closest point per boundary voxel, triangle-major: each triangle visits only
  //    the voxels of its bbox (+h) whose distance to its plane is <= ~h (the dominant normal
  //    axis is the inner loop, so the cost is proportional to the triangle's area / h^2).
  const lim = h * 1.01, lim2 = lim * lim;
  const best = new Float32Array(nB).fill(lim2);
  const cp = new Float32Array(nB * 3).fill(NaN);
  const O = [ox, oy, oz], S = [1, sy, sz], N = [nx, ny, nz];
  const inv = 1 / h;
  const P = new Float64Array(3);
  for (let t = 0; t < nTri; t++) {
    let i0, i1, i2;
    if (idx) { i0 = 3 * idx[3 * t]; i1 = 3 * idx[3 * t + 1]; i2 = 3 * idx[3 * t + 2]; }
    else { i0 = 9 * t; i1 = i0 + 3; i2 = i0 + 6; }
    const ax = pos[i0], ay = pos[i0 + 1], az = pos[i0 + 2];
    const bx = pos[i1], by = pos[i1 + 1], bz = pos[i1 + 2];
    const cx = pos[i2], cy = pos[i2 + 1], cz = pos[i2 + 2];
    let nX = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let nY = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nZ = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nX, nY, nZ);
    if (!(nl > 0)) continue; // degenerate: its neighbours cover the same surface
    nX /= nl; nY /= nl; nZ /= nl;
    const NN = [nX, nY, nZ];
    const AA = [ax, ay, az];
    const aX = Math.abs(nX), aY = Math.abs(nY), aZ = Math.abs(nZ);
    const D = aX >= aY && aX >= aZ ? 0 : aY >= aZ ? 1 : 2;
    const U = (D + 1) % 3, W = (D + 2) % 3;
    const mn = [Math.min(ax, bx, cx), Math.min(ay, by, cy), Math.min(az, bz, cz)];
    const mx = [Math.max(ax, bx, cx), Math.max(ay, by, cy), Math.max(az, bz, cz)];
    const lo = [0, 0, 0], hi = [0, 0, 0];
    let empty = false;
    for (let c = 0; c < 3; c++) {
      lo[c] = Math.max(0, Math.ceil((mn[c] - lim - O[c]) * inv));
      hi[c] = Math.min(N[c] - 1, Math.floor((mx[c] + lim - O[c]) * inv));
      if (lo[c] > hi[c]) empty = true;
    }
    if (empty) continue;
    const nD = NN[D], nU = NN[U], nW = NN[W];
    const halfW = lim / Math.abs(nD);
    const oD = O[D], oU = O[U], oW = O[W], sD = S[D], sU = S[U], sW = S[W];
    const aD = AA[D], aU = AA[U], aW = AA[W];
    for (let w = lo[W]; w <= hi[W]; w++) {
      const pW = oW + h * w;
      P[W] = pW;
      for (let u = lo[U]; u <= hi[U]; u++) {
        const pU = oU + h * u;
        P[U] = pU;
        const xc = aD - (nU * (pU - aU) + nW * (pW - aW)) / nD; // plane point on this line
        let d0 = Math.ceil((xc - halfW - oD) * inv), d1 = Math.floor((xc + halfW - oD) * inv);
        if (d0 < lo[D]) d0 = lo[D];
        if (d1 > hi[D]) d1 = hi[D];
        const rowBase = u * sU + w * sW;
        for (let d = d0; d <= d1; d++) {
          const b = sid[rowBase + d * sD];
          if (b < 0) continue;
          const pD = oD + h * d;
          const dpl = nD * (pD - aD) + nU * (pU - aU) + nW * (pW - aW);
          if (dpl * dpl >= best[b]) continue; // plane distance is a lower bound
          P[D] = pD;
          const d2 = closestPointTri(P[0], P[1], P[2], ax, ay, az, bx, by, bz, cx, cy, cz);
          if (d2 < best[b]) { best[b] = d2; cp[3 * b] = CP[0]; cp[3 * b + 1] = CP[1]; cp[3 * b + 2] = CP[2]; }
        }
      }
    }
  }
  // No surface within ~h: the occupancy does not match the mesh there (e.g. edited
  // occupancy) -> fall back to the midpoint towards the differing neighbour.
  for (let b = 0; b < nB; b++) {
    if (cp[3 * b] === cp[3 * b]) continue; // found (not NaN)
    const v = bVox[b];
    const i = v % nx, j = ((v / nx) | 0) % ny, k = (v / sz) | 0;
    const o = occ[v];
    let dx = 0, dy = 0, dz = 0;
    if (i > 0 && occ[v - 1] !== o) dx = -1; else if (i < nx - 1 && occ[v + 1] !== o) dx = 1;
    else if (j > 0 && occ[v - sy] !== o) dy = -1; else if (j < ny - 1 && occ[v + sy] !== o) dy = 1;
    else if (k > 0 && occ[v - sz] !== o) dz = -1; else dz = 1;
    cp[3 * b] = ox + h * (i + 0.5 * dx); cp[3 * b + 1] = oy + h * (j + 0.5 * dy); cp[3 * b + 2] = oz + h * (k + 0.5 * dz);
  }

  // 4. Feature transform: nearest boundary voxel (by centre distance) for every voxel.
  featureTransform(grid, isB, sid);

  // 5. phi = ±|p - closest point of the nearest boundary voxel|
  const phi = new Float32Array(n);
  for (let k = 0, v = 0; k < nz; k++) {
    const pz = oz + h * k;
    for (let j = 0; j < ny; j++) {
      const py = oy + h * j;
      for (let i = 0; i < nx; i++, v++) {
        const s = sid[v];
        if (s < 0) { phi[v] = occ[v] ? -FAR : FAR; continue; }
        const dx = ox + h * i - cp[3 * s], dy = py - cp[3 * s + 1], dz = pz - cp[3 * s + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        phi[v] = occ[v] ? -d : d;
      }
    }
  }
  return phi;
}

/**
 * Exact Euclidean feature transform over the grid: on return sid[v] = id of the nearest
 * site (isSite[v] = 1 and sid[v] preset to its id), or -1 if there are no sites.
 */
function featureTransform(grid, isSite, sid) {
  const { nx, ny, nz } = grid;
  const n = grid.n;
  const d2 = new Float32Array(n);
  // Pass X: two sweeps per row.
  for (let row = 0, nRows = ny * nz; row < nRows; row++) {
    const base = row * nx;
    let last = -1, lastId = -1;
    for (let i = 0; i < nx; i++) {
      const v = base + i;
      if (isSite[v]) { d2[v] = 0; last = i; lastId = sid[v]; }
      else if (last >= 0) { d2[v] = (i - last) * (i - last); sid[v] = lastId; }
      else { d2[v] = INF; sid[v] = -1; }
    }
    last = -1;
    for (let i = nx - 1; i >= 0; i--) {
      const v = base + i;
      if (isSite[v]) { last = i; lastId = sid[v]; }
      else if (last >= 0) {
        const d = (last - i) * (last - i);
        if (d < d2[v]) { d2[v] = d; sid[v] = lastId; }
      }
    }
  }
  const maxN = Math.max(nx, ny, nz);
  const BLK = 16;
  const f = new Float64Array(maxN * BLK);
  const ids = new Int32Array(maxN * BLK);
  const vIdx = new Int32Array(maxN);
  const zB = new Float64Array(maxN + 1);
  for (const [len, stride, outer, outerStride] of [
    [ny, nx, nz, nx * ny],
    [nz, nx * ny, ny, nx],
  ]) {
    for (let o = 0; o < outer; o++) {
      const ob = o * outerStride;
      for (let i0 = 0; i0 < nx; i0 += BLK) {
        const bw = Math.min(BLK, nx - i0);
        for (let t = 0; t < len; t++) {
          const src = ob + i0 + t * stride;
          for (let bi = 0; bi < bw; bi++) { f[bi * len + t] = d2[src + bi]; ids[bi * len + t] = sid[src + bi]; }
        }
        for (let bi = 0; bi < bw; bi++) {
          const off = bi * len;
          // lower envelope of parabolas (as edt1d), tracking the winning site
          let k = -1;
          for (let q = 0; q < len; q++) {
            const fq = f[off + q];
            if (fq >= INF) continue;
            if (k < 0) { k = 0; vIdx[0] = q; zB[0] = -Infinity; zB[1] = Infinity; continue; }
            const vq = fq + q * q;
            let s;
            for (;;) {
              const p = vIdx[k];
              s = (vq - (f[off + p] + p * p)) / (2 * (q - p));
              if (s <= zB[k]) { k--; if (k < 0) break; } else break;
            }
            if (k < 0) { k = 0; vIdx[0] = q; zB[0] = -Infinity; zB[1] = Infinity; continue; }
            k++;
            vIdx[k] = q; zB[k] = s; zB[k + 1] = Infinity;
          }
          const dst0 = ob + i0 + bi;
          if (k < 0) {
            for (let t = 0; t < len; t++) { d2[dst0 + t * stride] = INF; sid[dst0 + t * stride] = -1; }
            continue;
          }
          k = 0;
          for (let q = 0; q < len; q++) {
            while (zB[k + 1] < q) k++;
            const p = vIdx[k];
            d2[dst0 + q * stride] = (q - p) * (q - p) + f[off + p];
            sid[dst0 + q * stride] = ids[off + p];
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Field operations
// ---------------------------------------------------------------------------------------

/**
 * Running minimum along an axis (0=x, 1=y, 2=z).
 * dir = +1: out[t] = min(phi[0..t]) (prefix);  dir = -1: out[t] = min(phi[t..n-1]) (suffix).
 */
export function sweepMin(phi, grid, axis, dir) {
  const { nx, ny, nz } = grid;
  const out = new Float32Array(phi);
  const fwd = dir >= 0;
  if (axis === 0) {
    for (let row = 0, nRows = ny * nz; row < nRows; row++) {
      const base = row * nx;
      if (fwd) {
        let m = out[base];
        for (let i = 1; i < nx; i++) { const x = out[base + i]; if (x < m) m = x; else out[base + i] = m; }
      } else {
        let m = out[base + nx - 1];
        for (let i = nx - 2; i >= 0; i--) { const x = out[base + i]; if (x < m) m = x; else out[base + i] = m; }
      }
    }
  } else if (axis === 1) {
    for (let k = 0; k < nz; k++) {
      const slab = k * nx * ny;
      if (fwd) {
        for (let j = 1; j < ny; j++) {
          const cur = slab + j * nx, prev = cur - nx;
          for (let i = 0; i < nx; i++) if (out[prev + i] < out[cur + i]) out[cur + i] = out[prev + i];
        }
      } else {
        for (let j = ny - 2; j >= 0; j--) {
          const cur = slab + j * nx, prev = cur + nx;
          for (let i = 0; i < nx; i++) if (out[prev + i] < out[cur + i]) out[cur + i] = out[prev + i];
        }
      }
    }
  } else if (axis === 2) {
    const s = nx * ny;
    if (fwd) {
      for (let k = 1; k < nz; k++) {
        const cur = k * s, prev = cur - s;
        for (let i = 0; i < s; i++) if (out[prev + i] < out[cur + i]) out[cur + i] = out[prev + i];
      }
    } else {
      for (let k = nz - 2; k >= 0; k--) {
        const cur = k * s, prev = cur + s;
        for (let i = 0; i < s; i++) if (out[prev + i] < out[cur + i]) out[cur + i] = out[prev + i];
      }
    }
  } else {
    throw new Error(`sweepMin: invalid axis ${axis}`);
  }
  return out;
}

/** phi + delta (new array). */
export function addScalar(phi, delta) {
  const out = new Float32Array(phi.length);
  for (let v = 0; v < phi.length; v++) out[v] = phi[v] + delta;
  return out;
}

/** Pointwise min (union of the regions {phi < level}). */
export function minFields(a, b) {
  if (a.length !== b.length) throw new Error('minFields: size mismatch');
  const out = new Float32Array(a.length);
  for (let v = 0; v < a.length; v++) out[v] = a[v] < b[v] ? a[v] : b[v];
  return out;
}

/** Pointwise max (intersection of the regions {phi < level}). */
export function maxFields(a, b) {
  if (a.length !== b.length) throw new Error('maxFields: size mismatch');
  const out = new Float32Array(a.length);
  for (let v = 0; v < a.length; v++) out[v] = a[v] > b[v] ? a[v] : b[v];
  return out;
}

/**
 * Trilinear sampler p -> phi(p) (mm). Points outside the grid's voxel-centre box return 1e6.
 * Allocation-free; called millions of times by Manifold.levelSet.
 */
export function makeSampler(phi, grid) {
  const { nx, ny, nz, h } = grid;
  if (nx < 2 || ny < 2 || nz < 2) throw new Error('makeSampler: grid needs >= 2 voxels per axis');
  const ox = grid.origin[0], oy = grid.origin[1], oz = grid.origin[2];
  const inv = 1 / h;
  const sy = nx, sz = nx * ny;
  const EPS = 1e-6;
  const mxX = nx - 1 + EPS, mxY = ny - 1 + EPS, mxZ = nz - 1 + EPS;
  const lX = nx - 2, lY = ny - 2, lZ = nz - 2;
  return function sample(p) {
    const fx = (p[0] - ox) * inv, fy = (p[1] - oy) * inv, fz = (p[2] - oz) * inv;
    if (!(fx >= -EPS && fx <= mxX && fy >= -EPS && fy <= mxY && fz >= -EPS && fz <= mxZ)) return FAR;
    let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i > lX) i = lX; else if (i < 0) i = 0;
    if (j > lY) j = lY; else if (j < 0) j = 0;
    if (k > lZ) k = lZ; else if (k < 0) k = 0;
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const b = i + sy * j + sz * k;
    const c00 = phi[b] + (phi[b + 1] - phi[b]) * tx;
    const c10 = phi[b + sy] + (phi[b + sy + 1] - phi[b + sy]) * tx;
    const c01 = phi[b + sz] + (phi[b + sz + 1] - phi[b + sz]) * tx;
    const c11 = phi[b + sz + sy] + (phi[b + sz + sy + 1] - phi[b + sz + sy]) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  };
}

/**
 * Positive-inside SDF for Manifold.levelSet: level - trilinear(phi), clamped to
 * ±4·max(edge, h) (same zero set, no extreme interpolation ratios). Outside the grid it is
 * -(0.25 h + distance to the grid box) instead of a huge jump, which would create
 * near-coincident vertices (manifold-3d 3.5.3 can trap on those).
 */
function makeLevelSetSampler(phi, grid, level, edgeLength) {
  const { nx, ny, nz, h } = grid;
  if (nx < 2 || ny < 2 || nz < 2) throw new Error('levelSetSolid: grid needs >= 2 voxels per axis');
  const ox = grid.origin[0], oy = grid.origin[1], oz = grid.origin[2];
  const inv = 1 / h;
  const sy = nx, sz = nx * ny;
  const EPS = 1e-6;
  const mxX = nx - 1 + EPS, mxY = ny - 1 + EPS, mxZ = nz - 1 + EPS;
  const lX = nx - 2, lY = ny - 2, lZ = nz - 2;
  const C = 4 * Math.max(edgeLength, h);
  const gx1 = ox + h * (nx - 1), gy1 = oy + h * (ny - 1), gz1 = oz + h * (nz - 1);
  return function sdf(p) {
    const fx = (p[0] - ox) * inv, fy = (p[1] - oy) * inv, fz = (p[2] - oz) * inv;
    if (!(fx >= -EPS && fx <= mxX && fy >= -EPS && fy <= mxY && fz >= -EPS && fz <= mxZ)) {
      const dx = p[0] < ox ? ox - p[0] : p[0] > gx1 ? p[0] - gx1 : 0;
      const dy = p[1] < oy ? oy - p[1] : p[1] > gy1 ? p[1] - gy1 : 0;
      const dz = p[2] < oz ? oz - p[2] : p[2] > gz1 ? p[2] - gz1 : 0;
      const d = 0.25 * h + Math.sqrt(dx * dx + dy * dy + dz * dz);
      return d > C ? -C : -d;
    }
    let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i > lX) i = lX; else if (i < 0) i = 0;
    if (j > lY) j = lY; else if (j < 0) j = 0;
    if (k > lZ) k = lZ; else if (k < 0) k = 0;
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const b = i + sy * j + sz * k;
    const c00 = phi[b] + (phi[b + 1] - phi[b]) * tx;
    const c10 = phi[b + sy] + (phi[b + sy + 1] - phi[b + sy]) * tx;
    const c01 = phi[b + sz] + (phi[b + sz + 1] - phi[b + sz]) * tx;
    const c11 = phi[b + sz + sy] + (phi[b + sz + sy + 1] - phi[b + sz + sy]) * tx;
    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    const v = level - (c0 + (c1 - c0) * tz);
    return v > C ? C : v < -C ? -C : v;
  };
}

/**
 * Manifold of the region {phi < level} (surface = trilinear iso-surface).
 * When `bounds` is not given, the level-set box is the grid bounds tightened to the voxels
 * with phi < level (+2 voxels), which gives the same surface far faster. Bounds are clipped
 * to the grid (outside it phi counts as outside). Surfaces are closed at the bounds.
 * Returns null when the region is empty.
 *
 * Guards for manifold-3d 3.5.3, whose levelSet can trap ("memory access out of bounds",
 * which also corrupts the WASM heap): (1) no field jumps (see makeLevelSetSampler);
 * (2) its internal surface hash table must not overflow (the resize path is fragile): the
 * number of surface vertices is estimated from the voxel field and, if needed, the bounds
 * are enlarged along the cheapest axes until the table is big enough (the surface is
 * unchanged: outside the grid the field reads "outside").
 */
export function levelSetSolid(phi, grid, { level = 0, bounds, simplify } = {}) {
  // Pure-JS marching tetrahedra (src/core/mesher.js): Manifold.levelSet in the manifold-3d
  // 3.5.3 WASM build traps ("memory access out of bounds") on large outputs.
  return isoSurfaceSolid(phi, grid, { level, bounds, simplify });
}

/**
 * Conservative capacity (grid vertices) of manifold's LevelSet hash table for these bounds:
 * gridSize = floor(dim/e + 1), gridPow = floor(log2(gridSize + 2) + 1),
 * maxIndex = EncodeIndex(gridSize + 1, w = 1), tableSize = min(2 maxIndex, 10 maxIndex^0.667),
 * rounded up to a power of two and Full() at 50 %. The min over axis orders is taken.
 */
export function levelSetTableCapacity(bounds, edgeLength) {
  const G = [0, 0, 0], P = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    G[a] = Math.floor((bounds.max[a] - bounds.min[a]) / edgeLength + 1);
    P[a] = 2 ** Math.floor(Math.log2(G[a] + 2) + 1);
  }
  let minSize = Infinity;
  for (let top = 0; top < 3; top++) {
    const a = (top + 1) % 3, c = (top + 2) % 3;
    const maxIndex = 1 + 2 * (G[a] + 1) + 2 * P[a] * (G[c] + 1) + 2 * P[a] * P[c] * (G[top] + 1);
    const tableSize = Math.min(2 * maxIndex, 10 * maxIndex ** 0.667);
    minSize = Math.min(minSize, 2 ** Math.ceil(Math.log2(tableSize)));
  }
  return minSize / 2;
}

/** Estimated level-set surface vertices: crossings of {phi<level} inside `b` (+ closure faces). */
function estimateSurfaceVerts(phi, grid, level, b, e) {
  const { nx, ny, nz, h } = grid;
  const o = grid.origin;
  const clampI = (x, n) => Math.max(0, Math.min(n - 1, x));
  const i0 = clampI(Math.floor((b.min[0] - o[0]) / h), nx), i1 = clampI(Math.ceil((b.max[0] - o[0]) / h), nx);
  const j0 = clampI(Math.floor((b.min[1] - o[1]) / h), ny), j1 = clampI(Math.ceil((b.max[1] - o[1]) / h), ny);
  const k0 = clampI(Math.floor((b.min[2] - o[2]) / h), nz), k1 = clampI(Math.ceil((b.max[2] - o[2]) / h), nz);
  const sy = nx, sz = nx * ny;
  let cross = 0, closure = 0;
  for (let k = k0; k <= k1; k++) {
    for (let j = j0; j <= j1; j++) {
      let v = i0 + sy * j + sz * k;
      for (let i = i0; i <= i1; i++, v++) {
        const inside = phi[v] < level;
        if (i < i1 && inside !== (phi[v + 1] < level)) cross++;
        if (j < j1 && inside !== (phi[v + sy] < level)) cross++;
        if (k < k1 && inside !== (phi[v + sz] < level)) cross++;
        if (inside) {
          if (i === i0 || i === i1) closure++;
          if (j === j0 || j === j1) closure++;
          if (k === k0 || k === k1) closure++;
        }
      }
    }
  }
  // empirically ~2 manifold verts per (|n|_1-weighted area / e^2); 2.5 for margin
  return (2.5 * (cross + closure) * h * h) / (e * e);
}

/**
 * Bounds that levelSetSolid() will pass to Manifold.levelSet, with diagnostics:
 * {bounds, estVerts, capacity} or null when {phi < level} is empty.
 */
export function levelSetPlan(phi, grid, { level = 0, edgeLength = grid.h, bounds } = {}) {
  let b = bounds ?? tightBounds(phi, grid, level);
  if (!b) return null;
  // Outside the grid phi is unknown (= outside), so clip to the grid: same solid, and the
  // closure happens on the bounds instead of on a field discontinuity.
  const gb = grid.bounds();
  b = {
    min: [0, 1, 2].map((a) => Math.min(Math.max(b.min[a], gb.min[a]), gb.max[a])),
    max: [0, 1, 2].map((a) => Math.max(Math.min(b.max[a], gb.max[a]), gb.min[a])),
  };
  if (![0, 1, 2].every((a) => b.max[a] > b.min[a])) return null;
  const estVerts = estimateSurfaceVerts(phi, grid, level, b, edgeLength);
  const safe = BUMP_BOUNDS ? levelSetSafeBounds(b, edgeLength, estVerts) : b;
  return { bounds: safe, estVerts, capacity: levelSetTableCapacity(safe, edgeLength) };
}

function levelSetSafeBounds(b, e, est) {
  const cur = { min: b.min.slice(), max: b.max.slice() };
  for (let iter = 0; iter < 8; iter++) {
    if (est <= 0.8 * levelSetTableCapacity(cur, e)) return cur;
    // bump the axis whose gridSize is cheapest to raise to the next power of two (minus 2)
    let bestA = -1, bestF = Infinity;
    for (let a = 0; a < 3; a++) {
      const G = Math.floor((cur.max[a] - cur.min[a]) / e + 1);
      const P = 2 ** Math.floor(Math.log2(G + 2) + 1);
      const f = (P - 2) / G;
      if (f < bestF) { bestF = f; bestA = a; }
    }
    const G = Math.floor((cur.max[bestA] - cur.min[bestA]) / e + 1);
    const P = 2 ** Math.floor(Math.log2(G + 2) + 1);
    const dim = (P - 2 - 0.5) * e; // floor(dim/e + 1) = P - 2  =>  gridPow increases
    const c = 0.5 * (cur.min[bestA] + cur.max[bestA]);
    cur.min[bestA] = c - dim / 2;
    cur.max[bestA] = c + dim / 2;
  }
  return cur;
}

/** Grid-clipped box around the voxels with phi < level, padded by two voxels; null if none. */
function tightBounds(phi, grid, level) {
  const { nx, ny, nz, h } = grid;
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  let v = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      let rowHit = false;
      for (let i = 0; i < nx; i++, v++) {
        if (phi[v] < level) {
          rowHit = true;
          if (i < i0) i0 = i;
          if (i > i1) i1 = i;
        }
      }
      if (rowHit) {
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
        if (k < k0) k0 = k;
        if (k > k1) k1 = k;
      }
    }
  }
  if (i1 < 0) return null;
  const o = grid.origin;
  const lo = [Math.max(0, i0 - 2), Math.max(0, j0 - 2), Math.max(0, k0 - 2)];
  const hi = [Math.min(nx - 1, i1 + 2), Math.min(ny - 1, j1 + 2), Math.min(nz - 1, k1 + 2)];
  return {
    min: [o[0] + h * lo[0], o[1] + h * lo[1], o[2] + h * lo[2]],
    max: [o[0] + h * hi[0], o[1] + h * hi[1], o[2] + h * hi[2]],
  };
}

/** Volume (mm^3) of the inside voxels. */
export function occupancyVolume(occ, grid) {
  let c = 0;
  for (let v = 0; v < occ.length; v++) c += occ[v] ? 1 : 0;
  return c * grid.h * grid.h * grid.h;
}

/** Volume (mm^3) of voxels with phi < level. */
export function fieldVolume(phi, grid, level = 0) {
  let c = 0;
  for (let v = 0; v < phi.length; v++) if (phi[v] < level) c++;
  return c * grid.h * grid.h * grid.h;
}
