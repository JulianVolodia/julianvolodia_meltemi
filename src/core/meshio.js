// Mesh I/O and MeshData <-> Manifold conversion (weld, merge, orientation fix, repair).
// MeshData = { positions: Float32Array (xyz), indices: Uint32Array (3 per triangle) }.
// No bare imports (Web Worker safe): the WASM module comes from mf().
import { mf } from './wasm.js';
import { gridForBox, voxelize, signedDistance, levelSetSolid } from './sdf.js';

function isManifold(x) {
  return x && typeof x.getMesh === 'function';
}

function triIndices(mesh) {
  if (mesh.indices && mesh.indices.length) return mesh.indices;
  const n = (mesh.positions.length / 3) | 0;
  const idx = new Uint32Array(n - (n % 3));
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return idx;
}

/** MeshData from a Manifold (positions = first 3 vertex properties). */
export function meshFromManifold(m) {
  const g = m.getMesh();
  const np = g.numProp;
  const vp = g.vertProperties;
  const nv = (vp.length / np) | 0;
  let positions;
  if (np === 3) positions = new Float32Array(vp);
  else {
    positions = new Float32Array(nv * 3);
    for (let v = 0; v < nv; v++) {
      positions[3 * v] = vp[np * v];
      positions[3 * v + 1] = vp[np * v + 1];
      positions[3 * v + 2] = vp[np * v + 2];
    }
  }
  return { positions, indices: new Uint32Array(g.triVerts) };
}

/**
 * Weld vertices on a quantised lattice of pitch `tol` and drop index-degenerate triangles.
 * @returns {{positions: Float32Array, indices: Uint32Array, droppedTris: number}}
 */
export function weldMesh(mesh, tol) {
  const pos = mesh.positions;
  const idx = triIndices(mesh);
  const nv = (pos.length / 3) | 0;
  const inv = 1 / tol;
  let cap = 16;
  while (cap < nv * 2) cap *= 2;
  const mask = cap - 1;
  const table = new Int32Array(cap).fill(-1);
  const keys = new Float64Array(nv * 3);
  const out = new Float32Array(nv * 3);
  const remap = new Uint32Array(nv);
  let nu = 0;
  for (let v = 0; v < nv; v++) {
    const x = pos[3 * v], y = pos[3 * v + 1], z = pos[3 * v + 2];
    const X = Math.round(x * inv), Y = Math.round(y * inv), Z = Math.round(z * inv);
    let hsh = (Math.imul(X | 0, 73856093) ^ Math.imul(Y | 0, 19349663) ^ Math.imul(Z | 0, 83492791)) & mask;
    for (;;) {
      const slot = table[hsh];
      if (slot === -1) {
        table[hsh] = nu;
        keys[3 * nu] = X; keys[3 * nu + 1] = Y; keys[3 * nu + 2] = Z;
        out[3 * nu] = x; out[3 * nu + 1] = y; out[3 * nu + 2] = z;
        remap[v] = nu++;
        break;
      }
      if (keys[3 * slot] === X && keys[3 * slot + 1] === Y && keys[3 * slot + 2] === Z) { remap[v] = slot; break; }
      hsh = (hsh + 1) & mask;
    }
  }
  const nt = (idx.length / 3) | 0;
  const tri = new Uint32Array(nt * 3);
  let m = 0;
  for (let t = 0; t < nt; t++) {
    const a = remap[idx[3 * t]], b = remap[idx[3 * t + 1]], c = remap[idx[3 * t + 2]];
    if (a === b || b === c || c === a) continue;
    tri[3 * m] = a; tri[3 * m + 1] = b; tri[3 * m + 2] = c;
    m++;
  }
  return { positions: out.slice(0, nu * 3), indices: tri.slice(0, m * 3), droppedTris: nt - m };
}

function flipWinding(indices) {
  const out = new Uint32Array(indices);
  for (let t = 0; t < out.length; t += 3) { const s = out[t + 1]; out[t + 1] = out[t + 2]; out[t + 2] = s; }
  return out;
}

function buildManifold(positions, indices) {
  const { Manifold, Mesh } = mf();
  const mesh = new Mesh({ numProp: 3, vertProperties: positions, triVerts: indices });
  mesh.merge();
  const man = new Manifold(mesh); // throws ManifoldError when not manifold
  const st = man.status();
  if (st !== 'NoError') throw new Error(st);
  return man;
}

/**
 * MeshData -> Manifold. Welds vertices (default tolerance 1e-4 x bbox diagonal, min 1e-6),
 * drops degenerate triangles, merges open edges, fixes inside-out meshes. If the mesh is still
 * not a valid manifold it is repaired by remeshing (voxel occupancy with 3-axis voting ->
 * SDF -> level set at 0, ~3 M voxels).
 * @returns {{manifold: any, repaired: boolean, warnings: string[]}}
 */
export function manifoldFromMesh(mesh, { weldTolerance } = {}) {
  const warnings = [];
  const bb = meshBBox(mesh);
  if (!(bb.max[0] >= bb.min[0])) throw new Error('manifoldFromMesh: empty mesh');
  const diag = Math.hypot(bb.max[0] - bb.min[0], bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]);
  const tol = weldTolerance ?? Math.max(1e-6, 1e-4 * diag);
  const w = weldMesh(mesh, tol);
  if (w.droppedTris > 0) warnings.push(`Dropped ${w.droppedTris} degenerate triangle(s) after welding`);

  let manifold = null;
  let failure = '';
  if (w.indices.length >= 12) {
    try {
      manifold = buildManifold(w.positions, w.indices);
    } catch (e) {
      failure = e && e.message ? e.message : String(e);
    }
  } else {
    failure = 'too few triangles';
  }
  if (manifold) {
    const vol = manifold.volume();
    if (vol < 0) {
      manifold = buildManifold(w.positions, flipWinding(w.indices));
      warnings.push('Mesh was inside-out (inverted normals); triangle winding flipped');
    }
    if (!manifold.isEmpty() && manifold.volume() > 0) return { manifold, repaired: false, warnings };
    failure = 'zero volume';
  }

  // Repair by remesh.
  warnings.push(`Mesh is not a closed manifold (${failure}); repaired by voxel remesh — fine detail may be softened`);
  const grid = gridForBox(bb.min, bb.max, 0, { maxVoxels: 3e6, minVoxel: Math.max(1e-3, Math.min(0.4, diag / 200)) });
  const occ = voxelize(w.indices.length ? w : mesh, grid, { axes: 'xyz' });
  const phi = signedDistance(occ, grid);
  manifold = levelSetSolid(phi, grid, { level: 0 });
  if (!manifold) throw new Error('manifoldFromMesh: repair failed (mesh encloses no volume)');
  return { manifold, repaired: true, warnings };
}

// ---------------------------------------------------------------------------------------
// STL
// ---------------------------------------------------------------------------------------

/** Parse binary or ASCII STL. Vertices are not welded (3 per triangle). */
export function parseSTL(data) {
  let u8;
  if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  else throw new Error('parseSTL: expected ArrayBuffer / Uint8Array');
  const len = u8.byteLength;
  let nBin = -1;
  if (len >= 84) nBin = new DataView(u8.buffer, u8.byteOffset, len).getUint32(80, true);
  if (nBin >= 0 && 84 + 50 * nBin === len) return parseBinarySTL(u8, nBin);
  // ASCII?
  let p = 0;
  while (p < len && (u8[p] === 32 || u8[p] === 9 || u8[p] === 10 || u8[p] === 13)) p++;
  const head = String.fromCharCode(...u8.subarray(p, Math.min(len, p + 5))).toLowerCase();
  if (head === 'solid') {
    const text = new TextDecoder().decode(u8);
    if (/facet/i.test(text) || /endsolid/i.test(text)) return parseAsciiSTL(text);
  }
  if (nBin >= 0 && 84 + 50 * nBin <= len) return parseBinarySTL(u8, nBin); // trailing bytes
  throw new Error('parseSTL: unrecognised STL data');
}

function parseBinarySTL(u8, n) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const positions = new Float32Array(n * 9);
  let o = 84;
  for (let t = 0; t < n; t++, o += 50) {
    for (let k = 0; k < 9; k++) positions[9 * t + k] = dv.getFloat32(o + 12 + 4 * k, true);
  }
  const indices = new Uint32Array(n * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

function parseAsciiSTL(text) {
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/gi;
  const vals = [];
  let m;
  while ((m = re.exec(text)) !== null) vals.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
  const nTri = Math.floor(vals.length / 9);
  const positions = new Float32Array(vals.slice(0, nTri * 9));
  const indices = new Uint32Array(nTri * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  return { positions, indices };
}

/** Binary STL (facet normals computed) from MeshData or a Manifold. */
export function writeSTL(meshOrManifold, name = 'part') {
  const mesh = isManifold(meshOrManifold) ? meshFromManifold(meshOrManifold) : meshOrManifold;
  const pos = mesh.positions;
  const idx = triIndices(mesh);
  const n = (idx.length / 3) | 0;
  const buf = new ArrayBuffer(84 + 50 * n);
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  // header must not start with "solid" (some readers would treat the file as ASCII)
  const header = `Meltemi Mold Studio binary STL: ${name}`.slice(0, 80);
  for (let i = 0; i < header.length; i++) u8[i] = header.charCodeAt(i) & 0x7f;
  dv.setUint32(80, n, true);
  let o = 84;
  for (let t = 0; t < n; t++, o += 50) {
    const a = idx[3 * t] * 3, b = idx[3 * t + 1] * 3, c = idx[3 * t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = ny = nz = 0; }
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, pos[a], true); dv.setFloat32(o + 16, pos[a + 1], true); dv.setFloat32(o + 20, pos[a + 2], true);
    dv.setFloat32(o + 24, pos[b], true); dv.setFloat32(o + 28, pos[b + 1], true); dv.setFloat32(o + 32, pos[b + 2], true);
    dv.setFloat32(o + 36, pos[c], true); dv.setFloat32(o + 40, pos[c + 1], true); dv.setFloat32(o + 44, pos[c + 2], true);
    dv.setUint16(o + 48, 0, true);
  }
  return u8;
}

// ---------------------------------------------------------------------------------------
// MeshData utilities
// ---------------------------------------------------------------------------------------

/** Apply a column-major 4x4 affine matrix. Mirroring transforms (det < 0) flip the winding. */
export function transformMesh(mesh, m) {
  const pos = mesh.positions;
  const out = new Float32Array(pos.length);
  for (let v = 0; v < pos.length; v += 3) {
    const x = pos[v], y = pos[v + 1], z = pos[v + 2];
    out[v] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[v + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[v + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const det =
    m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
  const idx = triIndices(mesh);
  return { positions: out, indices: det < 0 ? flipWinding(idx) : new Uint32Array(idx) };
}

/** Concatenate several MeshData (null / undefined entries are skipped). */
export function concatMeshes(list) {
  const items = list.filter(Boolean).map((m) => (isManifold(m) ? meshFromManifold(m) : m));
  let nv = 0, ni = 0;
  const idxs = items.map(triIndices);
  for (let i = 0; i < items.length; i++) { nv += items[i].positions.length; ni += idxs[i].length; }
  const positions = new Float32Array(nv);
  const indices = new Uint32Array(ni);
  let pv = 0, pi = 0;
  for (let i = 0; i < items.length; i++) {
    const p = items[i].positions, ix = idxs[i];
    positions.set(p, pv);
    const base = pv / 3;
    for (let k = 0; k < ix.length; k++) indices[pi + k] = ix[k] + base;
    pv += p.length;
    pi += ix.length;
  }
  return { positions, indices };
}

/** Axis-aligned bounds of the vertex positions ({min:[+Inf..], max:[-Inf..]} if empty). */
export function meshBBox(mesh) {
  const p = mesh.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < p.length; v += 3) {
    const x = p[v], y = p[v + 1], z = p[v + 2];
    if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
    if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
    if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
  }
  return { min, max };
}

/** Signed volume (divergence theorem); positive for closed outward-oriented meshes. */
export function meshVolume(mesh) {
  const p = mesh.positions;
  const idx = triIndices(mesh);
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t], b = 3 * idx[t + 1], c = 3 * idx[t + 2];
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const bx = p[b], by = p[b + 1], bz = p[b + 2];
    const cx = p[c], cy = p[c + 1], cz = p[c + 2];
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return vol / 6;
}
