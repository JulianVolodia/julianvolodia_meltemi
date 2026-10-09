// Export: binary STL per printable part (in print orientation via printMatrix) zipped
// together with README.txt (instructions + stats + part list) and params.json.
import { zipSync, strToU8 } from 'fflate';
import { APP_NAME } from './config.js';

const ROLE_ORDER = { shell: 0, board: 1, cage: 2, clip: 3, pin: 4, master: 5, silicone: 6, cast: 7 };

/** Apply a column-major Mat4 to MeshData (flips winding for mirroring matrices). */
export function transformMeshData(mesh, m) {
  const src = mesh.positions;
  const out = new Float32Array(src.length);
  if (!m) { out.set(src); return { positions: out, indices: mesh.indices }; }
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const det = m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
  let indices = mesh.indices;
  if (det < 0 && indices) {
    indices = new Uint32Array(indices);
    for (let i = 0; i < indices.length; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  }
  return { positions: out, indices };
}

/** Binary STL (little endian) from MeshData (indexed or not). */
export function meshToSTL(mesh, name = APP_NAME) {
  const P = mesh.positions;
  const I = mesh.indices && mesh.indices.length ? mesh.indices : null;
  const nTri = I ? I.length / 3 : P.length / 9;
  const buf = new ArrayBuffer(84 + 50 * nTri);
  const u8 = new Uint8Array(buf);
  const header = strToU8(String(name).slice(0, 79));
  u8.set(header.subarray(0, 80), 0);
  const dv = new DataView(buf);
  dv.setUint32(80, nTri, true);
  let o = 84;
  for (let t = 0; t < nTri; t++) {
    const a = I ? I[3 * t] : 3 * t, b = I ? I[3 * t + 1] : 3 * t + 1, c = I ? I[3 * t + 2] : 3 * t + 2;
    const ax = P[3 * a], ay = P[3 * a + 1], az = P[3 * a + 2];
    const bx = P[3 * b], by = P[3 * b + 1], bz = P[3 * b + 2];
    const cx = P[3 * c], cy = P[3 * c + 1], cz = P[3 * c + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    dv.setFloat32(o + 12, ax, true); dv.setFloat32(o + 16, ay, true); dv.setFloat32(o + 20, az, true);
    dv.setFloat32(o + 24, bx, true); dv.setFloat32(o + 28, by, true); dv.setFloat32(o + 32, bz, true);
    dv.setFloat32(o + 36, cx, true); dv.setFloat32(o + 40, cy, true); dv.setFloat32(o + 44, cz, true);
    dv.setUint16(o + 48, 0, true);
    o += 50;
  }
  return u8;
}

export function slug(s) {
  return String(s || 'part').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'part';
}

export function fmtMass(g) {
  if (!Number.isFinite(g)) return '–';
  if (g >= 1000) return `${(g / 1000).toFixed(2)} kg`;
  if (g >= 10) return `${Math.round(g)} g`;
  return `${g.toFixed(1)} g`;
}

export function sortedParts(parts) {
  return [...(parts || [])].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9));
}

/** File name of a part: '01_shellA.stl', '05_clip_cast_x6.stl'. */
export function partFileName(part, index) {
  const q = part.quantity > 1 ? `_x${part.quantity}` : '';
  const n = index !== undefined ? `${String(index + 1).padStart(2, '0')}_` : '';
  return `${n}${slug(part.id || part.name)}${q}.stl`;
}

/** STL bytes of one part. Printable parts use printMatrix, previews the first stage pose. */
export function partSTL(part, { preview = false } = {}) {
  let m = part.printMatrix;
  if (preview || !part.printable) {
    const st = part.stages || {};
    m = (st.silicone && st.silicone[0]) || (st.cast && st.cast[0]) || null;
  }
  return meshToSTL(transformMeshData(part.mesh, m), `${APP_NAME} - ${part.name || part.id}`);
}

export function statsLines(result, params = {}) {
  const s = (result && result.stats) || {};
  const L = [];
  const cm = params.castMaterial || 'cast';
  if (Number.isFinite(s.moldMass)) L.push(`Mold (printed shells): ${fmtMass(s.moldMass)}${Number.isFinite(s.moldMassA) ? ` (A ${fmtMass(s.moldMassA)}, B ${fmtMass(s.moldMassB)})` : ''}`);
  if (Number.isFinite(s.boardMass) && s.boardMass > 0) L.push(`Parting board: ${fmtMass(s.boardMass)}`);
  if (Number.isFinite(s.clipsMass) && s.clipsMass > 0) L.push(`Clips: ${fmtMass(s.clipsMass)}`);
  if (Number.isFinite(s.pinsMass) && s.pinsMass > 0) L.push(`Pins: ${fmtMass(s.pinsMass)}`);
  if (Number.isFinite(s.siliconeMass) && s.siliconeMass > 0) {
    const mix = s.siliconeMix ? ` mix ${s.siliconeMix.a}:${s.siliconeMix.b}` : '';
    L.push(`Silicone: ${fmtMass(s.siliconeMass)} (${(s.siliconeVolume / 1000).toFixed(1)} cm³)${mix} -> part A ${fmtMass(s.siliconeMassA)} + part B ${fmtMass(s.siliconeMassB)} (add ~10 % for losses)`);
  }
  if (Number.isFinite(s.castMass) && s.castMass > 0) L.push(`Casting (${cm}): ${fmtMass(s.castMass)} (${(s.castVolume / 1000).toFixed(1)} cm³)`);
  if (Number.isFinite(s.voxelSize)) L.push(`Voxel size: ${s.voxelSize.toFixed(2)} mm`);
  return L;
}

export function buildReadme(result, params = {}, files = []) {
  const now = new Date();
  const L = [];
  L.push(`${APP_NAME} - mold box export`);
  L.push(`Generated ${now.toISOString().replace('T', ' ').slice(0, 19)} UTC · mode: ${params.mode || 'moldbox'} · quality: ${params.quality || 'normal'}`);
  L.push('Units: millimetres. STL files are in print orientation (Z up = build direction).');
  L.push('');
  L.push('STATS');
  for (const s of statsLines(result, params)) L.push(`  ${s}`);
  L.push('');
  L.push('FILES');
  for (const f of files) L.push(`  ${f.file.padEnd(34)} ${f.part.name || f.part.id}${f.part.quantity > 1 ? `  (print ${f.part.quantity}x)` : ''}${Number.isFinite(f.part.mass) ? `  ~${fmtMass(f.part.mass * (f.part.quantity || 1))}` : ''}`);
  L.push('');
  const ins = (result && result.instructions) || [];
  if (ins.length) {
    L.push('INSTRUCTIONS');
    ins.forEach((s, i) => L.push(`  ${i + 1}. ${s}`));
    L.push('');
  }
  const w = (result && result.warnings) || [];
  if (w.length) {
    L.push('WARNINGS');
    for (const s of w) L.push(`  ! ${s}`);
    L.push('');
  }
  L.push('Print tips: PLA/PETG, 3 perimeters, 15-20 % infill for shells and board, 100 % for clips and pins.');
  L.push('Seal the parting board and inner shell faces (release agent / sealer) before pouring silicone.');
  return L.join('\n');
}

/**
 * Build the export ZIP. Returns { bytes: Uint8Array, files: string[] }.
 * includePreview: also add silicone, cast and master previews (mold frame) under preview/.
 */
export function buildZip(result, params = {}, { includePreview = false } = {}) {
  const parts = sortedParts(result.parts);
  const entries = {};
  const fileList = [];
  let i = 0;
  for (const p of parts) {
    if (!p.printable || !p.mesh) continue;
    const file = partFileName(p, i++);
    entries[file] = partSTL(p);
    fileList.push({ file, part: p });
  }
  if (includePreview) {
    for (const p of parts) {
      if (p.printable || !p.mesh) continue;
      const file = `preview/${partFileName(p)}`;
      entries[file] = partSTL(p, { preview: true });
      fileList.push({ file, part: p });
    }
  }
  entries['README.txt'] = strToU8(buildReadme(result, params, fileList));
  entries['params.json'] = strToU8(JSON.stringify({ app: APP_NAME, params, stats: result.stats || {}, frame: result.frame || {} }, null, 2));
  const bytes = zipSync(entries, { level: 6 });
  return { bytes, files: Object.keys(entries) };
}

/** Trigger a browser download of bytes. */
export function downloadBytes(bytes, filename, mime = 'application/octet-stream') {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function zipName(params = {}) {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  return `meltemi-${params.mode === 'support' ? 'support' : 'moldbox'}-${stamp}.zip`;
}
