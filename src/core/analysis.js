// Shape analysis: air-trap detection (merge tree of the height function), automatic
// orientation of masters, slice-area profiles and pour-mode selection.
// Core module: no bare imports (manifold comes from wasm.js via frame.js helpers).
import { planeProject, mat4Identity, mat4Mul, mat4Translation, mat4AxisAngle } from './frame.js';

const OPEN = 0x3fffffff; // "infinite" birth layer for components connected to the opening

/**
 * Find air traps of a cast cavity filled from the bottom with liquid poured at the top.
 *
 * Merge tree / 0-th persistence of the height function (elder rule), swept top -> bottom
 * with a union-find over component nodes (only two voxel layers of labels are kept, so
 * memory is O(nx*ny + #components)).
 *
 * @param {Uint8Array} occ   1 = cast cavity voxel (liquid fills it); index i + nx*(j + ny*k)
 * @param {{origin:number[], h:number, nx:number, ny:number, nz:number}} grid  voxel centre = origin + h*[i,j,k]
 * @param {{zTop?:number, minDepth?:number, mergeDistance?:number}} [opts]
 *   zTop: pour opening height (components born at layer >= kTop-1 are open); default = highest occupied layer.
 *   minDepth: pockets shallower than this (birth z - merge z) are ignored (mm).
 *   mergeDistance: traps closer than this are merged, keeping the highest (default 3*h).
 * @returns {{p:number[], depth:number, i:number, j:number, k:number, closed:boolean}[]} sorted by z descending.
 *   p = voxel centre of the pocket's peak (centre of its ceiling voxels). closed = never connected to the opening.
 */
export function findAirTraps(occ, grid, { zTop, minDepth = 1.5, mergeDistance } = {}) {
  const { nx, ny, nz, h } = grid;
  const o = grid.origin;
  const nxy = nx * ny;
  if (mergeDistance === undefined || mergeDistance === null) mergeDistance = 3 * h;
  if (!(nx > 0 && ny > 0 && nz > 0)) return [];

  let kTop;
  if (zTop === undefined || zTop === null || !Number.isFinite(zTop)) {
    kTop = -1;
    for (let k = nz - 1; k >= 0 && kTop < 0; k--) {
      const base = k * nxy;
      for (let t = 0; t < nxy; t++) if (occ[base + t]) { kTop = k; break; }
    }
    if (kTop < 0) return [];
  } else {
    kTop = Math.min(nz - 1, Math.round((zTop - o[2]) / h));
    if (kTop < 0) return []; // opening below the whole grid: everything is open
  }
  const kOpen = kTop - 1;

  // ---- growable component-node arrays ----
  let cap = 1024;
  let parent = new Int32Array(cap);
  let birth = new Int32Array(cap);
  let low = new Int32Array(cap);
  let peak = new Int32Array(cap);
  let sumI = new Float64Array(cap);
  let sumJ = new Float64Array(cap);
  let cnt = new Int32Array(cap);
  let best = new Float64Array(cap);
  let nNodes = 0;

  const grow = () => {
    const c2 = cap * 2;
    const g32 = (a) => { const b = new Int32Array(c2); b.set(a); return b; };
    const g64 = (a) => { const b = new Float64Array(c2); b.set(a); return b; };
    parent = g32(parent); birth = g32(birth); low = g32(low); peak = g32(peak); cnt = g32(cnt);
    sumI = g64(sumI); sumJ = g64(sumJ); best = g64(best);
    cap = c2;
  };
  const newNode = (b, k) => {
    if (nNodes === cap) grow();
    const id = nNodes++;
    parent[id] = id; birth[id] = b; low[id] = k; peak[id] = -1;
    sumI[id] = 0; sumJ[id] = 0; cnt[id] = 0; best[id] = Infinity;
    return id;
  };
  const find = (a) => {
    while (parent[a] !== a) {
      const g = parent[parent[a]];
      parent[a] = g;
      a = g;
    }
    return a;
  };

  const raw = []; // {node, depth, closed}
  const union = (a, b, k) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return ra;
    let old, young;
    if (birth[ra] >= birth[rb]) { old = ra; young = rb; } else { old = rb; young = ra; }
    const by = birth[young];
    if (by !== OPEN && by > k) {
      const depth = (by - k) * h;
      if (depth >= minDepth - 1e-9) raw.push({ node: young, depth, closed: false });
    }
    parent[young] = old;
    if (low[young] < low[old]) low[old] = low[young];
    return old;
  };

  let prev = new Int32Array(nxy).fill(-1); // labels of layer k+1
  let cur = new Int32Array(nxy).fill(-1); // labels of layer k

  for (let k = nz - 1; k >= 0; k--) {
    const base = k * nxy;
    const bornHere = k >= kOpen ? OPEN : k;
    let births = 0;
    for (let j = 0, t = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, t++) {
        if (!occ[base + t]) { cur[t] = -1; continue; }
        let lab = prev[t];
        if (i > 0) {
          const l = cur[t - 1];
          if (l >= 0) lab = lab < 0 ? l : union(lab, l, k);
        }
        if (j > 0) {
          const l = cur[t - nx];
          if (l >= 0) lab = lab < 0 ? l : union(lab, l, k);
        }
        if (lab < 0) { lab = newNode(bornHere, k); births++; }
        cur[t] = lab;
      }
    }
    // post-pass: compress labels to roots, record lowest layer, accumulate ceiling stats
    for (let j = 0, t = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, t++) {
        const l = cur[t];
        if (l < 0) continue;
        const r = find(l);
        cur[t] = r;
        low[r] = k;
        if (births > 0 && birth[r] === k) { sumI[r] += i; sumJ[r] += j; cnt[r]++; }
      }
    }
    if (births > 0) {
      // peak voxel = ceiling voxel closest to the ceiling's mean (stays inside non-convex ceilings)
      for (let j = 0, t = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++, t++) {
          const r = cur[t];
          if (r < 0 || birth[r] !== k) continue;
          const di = i - sumI[r] / cnt[r], dj = j - sumJ[r] / cnt[r];
          const d = di * di + dj * dj;
          if (d < best[r]) { best[r] = d; peak[r] = base + t; }
        }
      }
    }
    const tmp = prev; prev = cur; cur = tmp;
  }

  // components never connected to the opening: they cannot fill at all
  for (let r = 0; r < nNodes; r++) {
    if (parent[r] !== r || birth[r] === OPEN) continue;
    const depth = (birth[r] - low[r]) * h;
    if (depth + h >= minDepth - 1e-9) raw.push({ node: r, depth, closed: true }); // skip voxel specks
  }

  const traps = [];
  for (const { node, depth, closed } of raw) {
    const v = peak[node];
    if (v < 0) continue;
    const k = Math.floor(v / nxy), rem = v - k * nxy, j = Math.floor(rem / nx), i = rem - j * nx;
    traps.push({ p: [o[0] + h * i, o[1] + h * j, o[2] + h * k], depth, i, j, k, closed });
  }
  traps.sort((a, b) => b.p[2] - a.p[2] || b.depth - a.depth);

  const kept = [];
  const md2 = mergeDistance * mergeDistance;
  for (const t of traps) {
    let merged = false;
    for (const q of kept) {
      const dx = t.p[0] - q.p[0], dy = t.p[1] - q.p[1], dz = t.p[2] - q.p[2];
      if (dx * dx + dy * dy + dz * dz < md2) {
        if (t.depth > q.depth) q.depth = t.depth;
        merged = true;
        break;
      }
    }
    if (!merged) kept.push(t);
  }
  return kept;
}

// ---------------------------------------------------------------------------------------
// Auto orientation

/** Eigen-decomposition of a symmetric 3x3 matrix (Jacobi). Returns {values, vectors} (vectors[i] unit). */
function eigSym3(A) {
  const a = [[A[0][0], A[0][1], A[0][2]], [A[1][0], A[1][1], A[1][2]], [A[2][0], A[2][1], A[2][2]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // columns are eigenvectors
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    const scale = Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) || 1;
    if (off < 1e-15 * scale) break;
    for (let p = 0; p < 2; p++)
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) { // A = A * J
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) { // A = J^T * A
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = V[k][p], vkq = V[k][q];
          V[k][p] = c * vkp - s * vkq;
          V[k][q] = s * vkp + c * vkq;
        }
      }
  }
  const values = [a[0][0], a[1][1], a[2][2]];
  const vectors = [0, 1, 2].map((c) => {
    const v = [V[0][c], V[1][c], V[2][c]];
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  });
  return { values, vectors };
}

/** Area-weighted surface covariance of a mesh (exact second moments of each triangle). */
function surfaceCovariance(manifold) {
  const mesh = manifold.getMesh();
  const P = mesh.vertProperties, np = mesh.numProp, T = mesh.triVerts;
  let A = 0;
  const m1 = [0, 0, 0];
  const m2 = new Float64Array(9);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * np, b = T[t + 1] * np, c = T[t + 2] * np;
    const ax = P[a], ay = P[a + 1], az = P[a + 2];
    const bx = P[b], by = P[b + 1], bz = P[b + 2];
    const cx = P[c], cy = P[c + 1], cz = P[c + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const area = 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (!(area > 0)) continue;
    A += area;
    const sx = ax + bx + cx, sy = ay + by + cy, sz = az + bz + cz;
    m1[0] += (area * sx) / 3; m1[1] += (area * sy) / 3; m1[2] += (area * sz) / 3;
    // integral of p p^T over the triangle = area/12 * (sum v v^T + s s^T)
    const f = area / 12;
    const vs = [[ax, ay, az], [bx, by, bz], [cx, cy, cz]];
    const s = [sx, sy, sz];
    for (let r = 0; r < 3; r++)
      for (let q = r; q < 3; q++) {
        const val = f * (vs[0][r] * vs[0][q] + vs[1][r] * vs[1][q] + vs[2][r] * vs[2][q] + s[r] * s[q]);
        m2[r * 3 + q] += val;
      }
  }
  if (!(A > 0)) return null;
  const mu = [m1[0] / A, m1[1] / A, m1[2] / A];
  const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let r = 0; r < 3; r++)
    for (let q = r; q < 3; q++) {
      C[r][q] = C[q][r] = m2[r * 3 + q] / A - mu[r] * mu[q];
    }
  return { C, mu, area: A };
}

function sliceAreaSafe(manifold, z) {
  try {
    return manifold.slice(z).area();
  } catch {
    return 0;
  }
}

/** Matrix whose rows are r0, r1, r2 (column-major Mat4). */
function rowsToMat4(r0, r1, r2) {
  return [r0[0], r1[0], r2[0], 0, r0[1], r1[1], r2[1], 0, r0[2], r1[2], r2[2], 0, 0, 0, 0, 1];
}

const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Automatic orientation of the master(s) in the mold frame.
 * (a) principal axis of largest surface variance -> +Z; (b) end with the larger slice area
 * (3 % of the height inside each end) goes up (pour side); (c) rotation about Z that maximises
 * the silhouette projected on the XZ (parting) plane; (d) centre x,y on 0, min z = 0.
 * @param {*} manifold
 * @param {{angleStep?:number}} [opts]
 * @returns {{matrix:number[], info:{longAxis:number[], pourEnd:'+'|'-', partingAngleDeg:number,
 *   silhouetteArea:number, topArea:number, bottomArea:number, eigenvalues:number[]}}}
 *   longAxis = PCA long axis in the input frame (unit); pourEnd = which end of longAxis ends up at +Z.
 */
export function autoOrient(manifold, { angleStep = 15 } = {}) {
  const cov = surfaceCovariance(manifold);
  if (!cov) {
    return { matrix: mat4Identity(), info: { longAxis: [0, 0, 1], pourEnd: '+', partingAngleDeg: 0, silhouetteArea: 0, topArea: 0, bottomArea: 0, eigenvalues: [0, 0, 0] } };
  }
  const { values, vectors } = eigSym3(cov.C);
  const order = [0, 1, 2].sort((p, q) => values[q] - values[p]);
  const eLong = vectors[order[0]], eMid = vectors[order[1]];
  // deterministic sign: long axis toward the input's +Z-ish direction, mid toward +X-ish
  const signOf = (v) => {
    for (const c of [2, 0, 1]) if (Math.abs(v[c]) > 1e-9) return Math.sign(v[c]);
    return 1;
  };
  const sl = signOf(eLong), sm = Math.abs(eMid[0]) > 1e-9 ? Math.sign(eMid[0]) : signOf(eMid);
  const r2 = eLong.map((x) => x * sl);
  const r0 = eMid.map((x) => x * sm);
  const r1 = cross3(r2, r0);
  const R1 = rowsToMat4(r0, r1, r2);
  const m1 = manifold.transform(R1);

  // (b) pour end
  const b1 = m1.boundingBox();
  const H = b1.max[2] - b1.min[2];
  const topArea = sliceAreaSafe(m1, b1.max[2] - 0.03 * H);
  const bottomArea = sliceAreaSafe(m1, b1.min[2] + 0.03 * H);
  const flip = bottomArea > topArea * (1 + 1e-6) + 1e-9;
  const F = flip ? [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1] : mat4Identity();
  const RF = mat4Mul(F, R1);
  const m2 = flip ? m1.transform(F) : m1;

  // (c) parting angle about Z maximising the XZ silhouette
  const step = angleStep > 0 ? angleStep : 15;
  // Score = silhouette area / pull depth (Y extent). Pure silhouette area would favour the
  // diagonal of box-like parts (a rotated rectangle projects wider); dividing by the depth keeps
  // the widest section in the parting plane while preferring the shallowest pull.
  let bestScore = -1, bestA = 0, bestDeg = 0;
  for (let deg = 0; deg < 180 - 1e-9; deg += step) {
    const Rz = mat4AxisAngle([0, 0, 1], (deg * Math.PI) / 180);
    const mt = m2.transform(Rz);
    const area = planeProject(mt).area();
    const bb = mt.boundingBox();
    const score = area / Math.max(bb.max[1] - bb.min[1], 1e-6);
    if (score > bestScore * (1 + 1e-6)) { bestScore = score; bestA = area; bestDeg = deg; }
  }
  const Rz = mat4AxisAngle([0, 0, 1], (bestDeg * Math.PI) / 180);
  const R = mat4Mul(Rz, RF);

  // (d) centre
  const b3 = manifold.transform(R).boundingBox();
  const Tm = mat4Translation(-(b3.min[0] + b3.max[0]) / 2, -(b3.min[1] + b3.max[1]) / 2, -b3.min[2]);
  const matrix = mat4Mul(Tm, R);
  return {
    matrix,
    info: {
      longAxis: r2,
      pourEnd: flip ? '-' : '+',
      partingAngleDeg: bestDeg,
      silhouetteArea: bestA,
      topArea: flip ? bottomArea : topArea,
      bottomArea: flip ? topArea : bottomArea,
      eigenvalues: order.map((i) => values[i]),
    },
  };
}

/**
 * Horizontal slice areas at n evenly spaced heights (cell centres) over the bbox.
 * @returns {{z:number, area:number}[]}
 */
export function sliceAreaProfile(manifold, n = 24) {
  const b = manifold.boundingBox();
  const z0 = b.min[2], H = b.max[2] - b.min[2];
  const out = [];
  if (!(H > 0) || !(n > 0)) return out;
  for (let i = 0; i < n; i++) {
    const z = z0 + ((i + 0.5) * H) / n;
    out.push({ z, area: sliceAreaSafe(manifold, z) });
  }
  return out;
}

/**
 * Pour opening mode for one connected component: 'extend' if its top face is broad
 * (slice 0.25 mm below the top >= 25 % of the max slice area), else 'sprue'.
 */
export function pourModeFor(component) {
  const b = component.boundingBox();
  const H = b.max[2] - b.min[2];
  if (!(H > 0)) return 'sprue';
  const zt = b.max[2] - Math.min(0.25, H / 2);
  const topA = sliceAreaSafe(component, zt);
  let maxA = topA;
  for (const { area } of sliceAreaProfile(component, 24)) if (area > maxA) maxA = area;
  return maxA > 0 && topA >= 0.25 * maxA ? 'extend' : 'sprue';
}
