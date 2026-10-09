// Meltemi Mold Studio — application glue: file loading, masters list, toolbar, generation,
// results (stats, parts, instructions, legend), export and keyboard shortcuts.
import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { Viewer, geometryFromMeshData } from './viewer.js';
import { createPanel } from './panel.js';
import { Engine, CancelledError } from './engine.js';
import { buildZip, downloadBytes, zipName, partSTL, partFileName, fmtMass, sortedParts } from './export.js';
import { IS_LOCAL, VERSIONS, UI_STORAGE_KEY, APP_NAME } from './config.js';
import { CAST_MATERIALS, mixFractions } from '../core/params.js';

// ------------------------------------------------------------------------------ icons
const ICON_PATHS = {
  open: '<path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
  candle: '<rect x="8.5" y="10" width="7" height="11" rx="1.2"/><path d="M12 2.5c1.6 1.7 2.2 2.8 2.2 3.8a2.2 2.2 0 0 1-4.4 0c0-1 .6-2.1 2.2-3.8z"/><path d="M12 8.5V10"/>',
  move: '<path d="M12 2v20M2 12h20M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
  wand: '<path d="m15 4 1 2 2 1-2 1-1 2-1-2-2-1 2-1z"/><path d="M4 20 14 10"/><path d="m19 13 .6 1.4L21 15l-1.4.6L19 17l-.6-1.4L17 15l1.4-.6z"/>',
  drop: '<path d="M12 3v12M7 10l5 5 5-5M4 20h16"/>',
  layers: '<path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="m2 13 10 5 10-5"/>',
  fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  keyboard: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  array: '<rect x="2" y="6" width="5" height="12" rx="1"/><rect x="9.5" y="6" width="5" height="12" rx="1"/><rect x="17" y="6" width="5" height="12" rx="1"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeoff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.4"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  warn: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  chev: '<path d="m6 9 6 6 6-6"/>',
};
const icon = (name) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((i) => {
    const s = document.createElement('span');
    s.innerHTML = icon(i.dataset.icon);
    const svg = s.firstChild;
    if (i.className) svg.classList.add(...i.className.split(/\s+/).filter(Boolean));
    i.replaceWith(svg);
  });
}

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
};
const fmt = (v, d = 1) => (Number.isFinite(v) ? (+v.toFixed(d)).toString() : '–');
const safeGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } };

// ------------------------------------------------------------------------------ state
const state = {
  masters: [], // {id, name, mesh: THREE.Mesh, data: MeshData (local), tris, volume}
  result: null,
  resultParams: null,
  stale: false,
  busy: false,
  stage: 'setup',
  seq: 0,
};

let viewer = null;
let panel = null;
// ?noworker forces the main-thread engine (debugging / browsers without module workers).
const engine = new Engine({
  preferWorker: !/[?&]noworker\b/.test(location.search),
  onModeChange: (m) => updateEngineHint(m),
});

// ------------------------------------------------------------------------------ toasts
const toasts = () => $('#toasts');
function toast(msg, { type = 'info', timeout = 4200 } = {}) {
  const ico = { info: 'info', ok: 'check', warn: 'warn', error: 'warn' }[type] || 'info';
  const el = h('div', { class: `toast ${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 't-ico', html: icon(ico) }),
    h('span', { class: 't-msg', text: msg }),
    h('button', { type: 'button', class: 'icon-btn t-close', 'aria-label': 'Dismiss', html: icon('x'), onclick: () => el.remove() }));
  toasts().append(el);
  if (timeout) setTimeout(() => el.remove(), type === 'error' ? Math.max(timeout, 12000) : timeout);
  return el;
}

/** Progress toast: step label + elapsed seconds + optional bar + Cancel. */
function progressToast(initial, onCancel) {
  const t0 = performance.now();
  const step = h('span', { class: 't-step', text: initial });
  const time = h('span', { class: 't-time', text: '0.0 s' });
  const bar = h('div', { class: 't-bar indet' }, h('i'));
  const cancel = onCancel ? h('button', { type: 'button', class: 'btn btn-sm btn-ghost', id: 'btn-cancel', text: 'Cancel', onclick: onCancel }) : null;
  const el = h('div', { class: 'toast progress', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 't-line' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), step, time, cancel), bar);
  toasts().prepend(el);
  const timer = setInterval(() => { time.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 100);
  const steps = [];
  let cur = null;
  return {
    el,
    update(label, frac) {
      if (label && label !== cur) {
        const now = performance.now();
        if (cur) steps.push({ step: cur, ms: now - (steps.t || t0) });
        steps.t = now;
        cur = label;
        step.textContent = label;
      }
      if (Number.isFinite(frac) && frac > 0) {
        bar.classList.remove('indet');
        bar.firstChild.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
      }
    },
    elapsed: () => (performance.now() - t0) / 1000,
    close() { clearInterval(timer); el.remove(); },
  };
}

// ------------------------------------------------------------------------------ geometry helpers
/** Weld + merge a list of {geometry, matrix} into MeshData (indexed). */
function meshDataFromGeometries(list) {
  const parts = [];
  for (const { geometry, matrix } of list) {
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', geometry.getAttribute('position').clone());
    if (geometry.index) g.setIndex(geometry.index.clone());
    if (matrix) g.applyMatrix4(matrix);
    if (g.index) g = g.toNonIndexed();
    parts.push(g.getAttribute('position').array);
  }
  const total = parts.reduce((s, a) => s + a.length, 0);
  const all = new Float32Array(total);
  let o = 0;
  for (const a of parts) { all.set(a, o); o += a.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(all, 3));
  const welded = mergeVertices(g, 1e-4);
  const positions = new Float32Array(welded.getAttribute('position').array);
  const idx = welded.index ? welded.index.array : null;
  const indices = idx ? Uint32Array.from(idx) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  // drop degenerate triangles (collapsed by welding)
  let n = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (a === b || b === c || a === c) continue;
    indices[n++] = a; indices[n++] = b; indices[n++] = c;
  }
  return { positions, indices: indices.slice(0, n) };
}

function meshBounds(md) {
  const p = md.positions;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) { const v = p[i + k]; if (v < min[k]) min[k] = v; if (v > max[k]) max[k] = v; }
  }
  return { min, max };
}

function meshVolume(md) {
  const p = md.positions, I = md.indices;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return Math.abs(v / 6);
}

/** Bake a master's world transform into a fresh MeshData (mold frame = scene frame). */
function bakeWorld(m) {
  m.mesh.updateMatrixWorld(true);
  const e = m.mesh.matrixWorld.elements;
  const src = m.data.positions;
  const pos = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i], y = src[i + 1], z = src[i + 2];
    pos[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    pos[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    pos[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const idx = new Uint32Array(m.data.indices);
  if (m.mesh.matrixWorld.determinant() < 0) {
    for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
  }
  return { positions: pos, indices: idx };
}

// ------------------------------------------------------------------------------ masters
function addMaster(md, name, { keepPosition = false } = {}) {
  if (!md || !md.positions || md.positions.length < 9) throw new Error(`${name}: no triangles found`);
  if (!md.indices) md = { positions: md.positions, indices: Uint32Array.from({ length: md.positions.length / 3 }, (_, i) => i) };
  const b = meshBounds(md);
  // Local frame: pivot at the bbox centre (gizmo sits in the middle of the part).
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, cz = (b.min[2] + b.max[2]) / 2;
  const local = new Float32Array(md.positions.length);
  for (let i = 0; i < local.length; i += 3) {
    local[i] = md.positions[i] - cx;
    local[i + 1] = md.positions[i + 1] - cy;
    local[i + 2] = md.positions[i + 2] - cz;
  }
  const data = { positions: local, indices: md.indices instanceof Uint32Array ? md.indices : Uint32Array.from(md.indices) };
  const geometry = geometryFromMeshData({ positions: new Float32Array(local), indices: data.indices });
  const mesh = viewer.addMaster(geometry, name);
  if (keepPosition) mesh.position.set(cx, cy, cz);
  else placeBesideOthers(mesh, b.max[0] - b.min[0], (b.max[2] - b.min[2]) / 2);
  const m = { id: `m${++state.seq}`, name, mesh, data, tris: data.indices.length / 3, volume: meshVolume(data) };
  mesh.userData.masterId = m.id;
  state.masters.push(m);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const maxDim = Math.max(...size);
  if (maxDim < 3) toast(`${name} is only ${fmt(maxDim, 2)} mm — was it exported in metres or inches? Use Scale in the selection bar.`, { type: 'warn', timeout: 9000 });
  if (maxDim > 1500) toast(`${name} is ${fmt(maxDim, 0)} mm large — check the units.`, { type: 'warn', timeout: 9000 });
  return m;
}

function placeBesideOthers(mesh, width, halfHeight) {
  const others = state.masters.filter((m) => m.mesh !== mesh);
  if (!others.length) { mesh.position.set(0, 0, halfHeight); return; }
  const box = new THREE.Box3();
  for (const o of others) box.union(new THREE.Box3().setFromObject(o.mesh, true));
  mesh.position.set(box.max.x + 8 + width / 2, (box.min.y + box.max.y) / 2, halfHeight);
}

function findMaster(mesh) { return state.masters.find((m) => m.mesh === mesh) || null; }
function selectedMaster() { return viewer && viewer.selected ? findMaster(viewer.selected) : null; }

function removeMaster(m) {
  viewer.removeMaster(m.mesh);
  state.masters = state.masters.filter((x) => x !== m);
  markStale();
  refreshMasters();
}

function duplicateMaster(m, dx) {
  const box = new THREE.Box3().setFromObject(m.mesh, true);
  const w = box.max.x - box.min.x;
  const mesh = viewer.addMaster(m.mesh.geometry, `${m.name} copy`);
  mesh.position.copy(m.mesh.position);
  mesh.quaternion.copy(m.mesh.quaternion);
  mesh.scale.copy(m.mesh.scale);
  mesh.position.x += dx !== undefined ? dx : w + 6;
  const c = { id: `m${++state.seq}`, name: `${m.name.replace(/ copy( \d+)?$/, '')} copy`, mesh, data: m.data, tris: m.tris, volume: m.volume };
  mesh.name = c.name;
  mesh.userData.masterId = c.id;
  state.masters.push(c);
  return c;
}

function clearMasters() {
  viewer.select(null);
  for (const m of [...state.masters]) viewer.removeMaster(m.mesh);
  state.masters = [];
}

function worldBox(m) { return new THREE.Box3().setFromObject(m.mesh, true); }

function dropToBed(list) {
  for (const m of list) {
    const b = worldBox(m);
    m.mesh.position.z -= b.min.z;
  }
  viewer.updatePartingPlane();
  markStale();
  refreshMasters();
}

function rotateMaster(m, axis) {
  const before = worldBox(m).getCenter(new THREE.Vector3());
  const ax = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[axis];
  m.mesh.rotateOnWorldAxis(ax, Math.PI / 2);
  m.mesh.updateMatrixWorld(true);
  const after = worldBox(m);
  const c = after.getCenter(new THREE.Vector3());
  m.mesh.position.x += before.x - c.x;
  m.mesh.position.y += before.y - c.y;
  m.mesh.position.z -= after.min.z;
  viewer.updatePartingPlane();
  markStale();
  refreshMasters();
}

function totalMastersBox() {
  const box = new THREE.Box3();
  for (const m of state.masters) box.union(worldBox(m));
  return box;
}

// ------------------------------------------------------------------------------ file loading
async function parseFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const buf = await file.arrayBuffer();
  if (ext === 'stl') {
    const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
    const g = new STLLoader().parse(buf);
    return meshDataFromGeometries([{ geometry: g }]);
  }
  if (ext === 'ply') {
    const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
    const g = new PLYLoader().parse(buf);
    return meshDataFromGeometries([{ geometry: g }]);
  }
  let root;
  if (ext === 'obj') {
    const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
    root = new OBJLoader().parse(new TextDecoder().decode(buf));
  } else if (ext === '3mf') {
    const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
    root = new ThreeMFLoader().parse(buf);
  } else {
    throw new Error(`Unsupported file type .${ext} (use STL, OBJ, 3MF or PLY)`);
  }
  root.updateMatrixWorld(true);
  const list = [];
  root.traverse((o) => { if (o.isMesh && o.geometry && o.geometry.getAttribute('position')) list.push({ geometry: o.geometry, matrix: o.matrixWorld }); });
  if (!list.length) throw new Error(`${file.name}: no meshes found`);
  return meshDataFromGeometries(list);
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const t = files.length > 1 || files[0].size > 4e6 ? progressToast(`Loading ${files[0].name}…`) : null;
  let added = 0;
  for (const f of files) {
    try {
      t && t.update(`Loading ${f.name}…`);
      await new Promise((r) => setTimeout(r, 0));
      const md = await parseFile(f);
      addMaster(md, f.name.replace(/\.[^.]+$/, ''));
      added++;
    } catch (e) {
      console.warn(e);
      toast(`Could not load ${f.name}: ${e.message || e}`, { type: 'error' });
    }
  }
  t && t.close();
  if (added) {
    markStale();
    refreshMasters();
    setStage('setup');
    viewer.select(state.masters[state.masters.length - 1].mesh);
    viewer.fit();
    toast(`Loaded ${added} master${added > 1 ? 's' : ''}`, { type: 'ok', timeout: 2200 });
  }
}

async function loadDemo() {
  let mod;
  try {
    mod = await import('../demo/candles.js');
  } catch (e) {
    console.warn(e);
    toast(`Demo not available: ${e.message || e}`, { type: 'error' });
    return;
  }
  try {
    // demoCandles() is the shared UI/CLI preset; makeCandleRow() the generic builder.
    let list;
    if (typeof mod.demoCandles === 'function') list = await mod.demoCandles();
    else if (typeof mod.makeCandleRow === 'function') list = await mod.makeCandleRow({ count: 3, spacing: 26 });
    else throw new Error('src/demo/candles.js exports neither demoCandles() nor makeCandleRow()');
    if (list && list.positions) list = [list];
    if (!Array.isArray(list) || !list.length) throw new Error('makeCandleRow() returned no meshes');
    clearMasters();
    clearResult();
    list.forEach((md, i) => addMaster(md, `Taper candle ${i + 1}`, { keepPosition: true }));
    markStale();
    refreshMasters();
    setStage('setup');
    viewer.select(null);
    viewer.view('iso');
    toast('Loaded demo: 3 taper candles', { type: 'ok', timeout: 2500 });
  } catch (e) {
    console.warn(e);
    toast(`Demo failed: ${e.message || e}`, { type: 'error' });
  }
}

// ------------------------------------------------------------------------------ UI: masters
function refreshMasters() {
  const list = $('#master-list');
  list.textContent = '';
  const sel = viewer.selected;
  for (const m of state.masters) {
    const b = worldBox(m);
    const s = b.getSize(new THREE.Vector3());
    const row = h('li', {
      class: 'master-row', 'aria-selected': m.mesh === sel ? 'true' : 'false', tabindex: '0',
      onclick: () => { setStage('setup'); viewer.select(m.mesh); },
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setStage('setup'); viewer.select(m.mesh); } },
    },
    h('span', { class: 'sw', 'aria-hidden': 'true' }),
    h('div', { class: 'mr-main' },
      h('div', { class: 'mr-name', text: m.name, title: m.name }),
      h('div', { class: 'mr-meta', text: `${fmt(s.x, 1)} × ${fmt(s.y, 1)} × ${fmt(s.z, 1)} mm · ${m.tris.toLocaleString()} tris` })),
    h('div', { class: 'mr-act' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Duplicate', 'aria-label': `Duplicate ${m.name}`, html: icon('copy'), onclick: (e) => { e.stopPropagation(); const c = duplicateMaster(m); markStale(); refreshMasters(); viewer.select(c.mesh); } }),
      h('button', { type: 'button', class: 'icon-btn danger', title: 'Delete', 'aria-label': `Delete ${m.name}`, html: icon('trash'), onclick: (e) => { e.stopPropagation(); removeMaster(m); } })));
    list.append(row);
  }
  const n = state.masters.length;
  $('#masters-count').textContent = n ? `${n} loaded` : 'none';
  $('#master-empty').hidden = n > 0;
  $('#array-tool').hidden = !sel;
  $('#empty-state').hidden = n > 0;
  $('#btn-generate').disabled = n === 0 || state.busy;
  for (const id of ['#btn-orient', '#btn-drop']) $(id).disabled = n === 0 || state.busy;
  updateSelectionBar();
  renderStats();
}

function updateSelectionBar() {
  const m = selectedMaster();
  const bar = $('#selection-bar');
  bar.hidden = !m || state.stage !== 'setup';
  if (!m) return;
  const s = worldBox(m).getSize(new THREE.Vector3());
  $('#sel-name').textContent = m.name;
  $('#sel-dims').textContent = `${fmt(s.x)} × ${fmt(s.y)} × ${fmt(s.z)} mm`;
  const inp = $('#sel-scale');
  if (document.activeElement !== inp) inp.value = String(Math.round(m.mesh.scale.x * 1000) / 10);
}

// ------------------------------------------------------------------------------ stage / result UI
function setStage(stage) {
  const has = viewer.availableStages();
  if (!has[stage]) stage = 'setup';
  state.stage = stage;
  viewer.setStage(stage);
  $$('#stage-seg [role="tab"]').forEach((b) => {
    const on = b.dataset.stage === stage;
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
    b.disabled = !has[b.dataset.stage];
  });
  $('#explode').disabled = !(stage === 'silicone' || stage === 'cast');
  if (viewer.section.on) syncSectionUI();
  updateSelectionBar();
  renderLegend();
  document.body.dataset.stage = stage;
}

function clearResult() {
  viewer.clearResult();
  state.result = null;
  state.resultParams = null;
  state.stale = false;
  $('#stale-chip').hidden = true;
  $('#btn-generate').classList.remove('pulse');
  $('#result-body').hidden = true;
  $('#result-empty').hidden = false;
  $('#result-badge').hidden = true;
  $('#legend').hidden = true;
  setExportEnabled(false);
  setStage('setup');
  renderStats();
}

function markStale() {
  if (!state.result || state.stale) return;
  state.stale = true;
  $('#stale-chip').hidden = false;
  $('#btn-generate').classList.add('pulse');
}

function setExportEnabled(on) {
  for (const id of ['#btn-export', '#btn-export-more', '#btn-export-top']) $(id).disabled = !on;
}

function stat(cls, label, value, sub) {
  return h('span', { class: `stat ${cls || ''}` }, h('span', { class: 'sl', text: label }), h('span', { class: 'sv', text: value }), sub ? h('span', { class: 'ss', text: sub }) : null);
}

function renderStats() {
  const el = $('#stats');
  el.textContent = '';
  const params = panel ? panel.get() : {};
  const castMat = CAST_MATERIALS[params.castMaterial] || CAST_MATERIALS.wax;
  const r = state.result;
  if (!r) {
    if (!state.masters.length) {
      el.append(h('span', { class: 'muted', text: 'No mold yet — load a master and press Generate.' }));
      return;
    }
    const b = totalMastersBox();
    const s = b.getSize(new THREE.Vector3());
    const vol = state.masters.reduce((acc, m) => acc + m.volume * Math.abs(m.mesh.scale.x * m.mesh.scale.y * m.mesh.scale.z), 0);
    el.append(
      stat('', 'Masters', String(state.masters.length)),
      stat('', 'Size', `${fmt(s.x, 0)} × ${fmt(s.y, 0)} × ${fmt(s.z, 0)} mm`),
      stat('', 'Casting ≈', fmtMass((vol / 1000) * castMat.density), `${fmt(vol / 1000, 1)} cm³ ${params.castMaterial || 'wax'}`),
      h('span', { class: 'stat muted', text: 'Press Generate to build the mold box' }));
    return;
  }
  const s = r.stats || {};
  const parts = r.parts || [];
  const count = (role) => parts.filter((p) => p.role === role).reduce((a, p) => a + (p.quantity || 1), 0);
  if (Number.isFinite(s.moldMass)) {
    el.append(stat('mold', 'Mold', fmtMass(s.moldMass), Number.isFinite(s.moldMassA) ? `(A ${fmtMass(s.moldMassA)}, B ${fmtMass(s.moldMassB)})` : ''));
  }
  if (s.boardMass > 0) el.append(stat('', 'Board', fmtMass(s.boardMass)));
  const nc = count('clip');
  if (nc) el.append(stat('', 'Clips', `×${nc}`, Number.isFinite(s.clipsMass) ? fmtMass(s.clipsMass) : ''));
  const np = count('pin');
  if (np) el.append(stat('', 'Pins', `×${np}`, Number.isFinite(s.pinsMass) ? fmtMass(s.pinsMass) : ''));
  if (s.siliconeMass > 0) {
    let mix = '';
    if (Number.isFinite(s.siliconeMassA)) mix = `(A ${fmtMass(s.siliconeMassA)} + B ${fmtMass(s.siliconeMassB)})`;
    else {
      const [fa, fb] = mixFractions((state.resultParams || params).siliconeMixRatio);
      mix = `(A ${fmtMass(s.siliconeMass * fa)} + B ${fmtMass(s.siliconeMass * fb)})`;
    }
    el.append(stat('', 'Silicone', fmtMass(s.siliconeMass), mix));
  }
  if (s.castMass > 0) {
    const rp = state.resultParams || params;
    el.append(stat('', 'Casting', fmtMass(s.castMass), (CAST_MATERIALS[rp.castMaterial] || castMat).label.split(' (')[0].toLowerCase()));
  }
}

function renderResultPane() {
  const r = state.result;
  $('#result-empty').hidden = !!r;
  $('#result-body').hidden = !r;
  if (!r) return;
  const s = r.stats || {};
  const sum = $('#result-summary');
  sum.textContent = '';
  const kv = (k, v) => h('div', {}, h('div', { class: 'k', text: k }), h('div', { class: 'v', text: v }));
  const parts = r.parts || [];
  const printable = parts.filter((p) => p.printable);
  const printMass = printable.reduce((a, p) => a + (p.mass || 0) * (p.quantity || 1), 0);
  sum.append(
    kv('Mode', (state.resultParams && state.resultParams.mode) === 'support' ? 'Support' : 'Mold box'),
    kv('Generated in', `${fmt(state.genSeconds, 1)} s`),
    kv('Printed parts', `${printable.reduce((a, p) => a + (p.quantity || 1), 0)} pcs · ${fmtMass(printMass)}`),
    kv('Voxel size', Number.isFinite(s.voxelSize) ? `${fmt(s.voxelSize, 2)} mm` : '–'));

  const w = $('#warnings');
  w.textContent = '';
  for (const msg of r.warnings || []) w.append(h('div', { class: 'warn-item' }, h('span', { html: icon('warn') }), h('span', { text: msg })));

  const list = $('#part-list');
  list.textContent = '';
  const sorted = sortedParts(parts);
  let idx = 0;
  for (const p of sorted) {
    const visible = !viewer.hidden.has(p.id);
    const fileIdx = p.printable ? idx++ : undefined;
    const ps = p.printable ? viewer.printSize(p.id) : null;
    const meta = [p.role, Number.isFinite(p.mass) ? `${fmtMass(p.mass)}${p.quantity > 1 ? ' each' : ''}` : null,
      ps ? `${fmt(ps[0], 0)}×${fmt(ps[1], 0)}×${fmt(ps[2], 0)} mm` : null, p.printable ? null : 'preview only'].filter(Boolean).join(' · ');
    const eyeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-pressed': visible ? 'true' : 'false', 'aria-label': `${visible ? 'Hide' : 'Show'} ${p.name}`, title: visible ? 'Hide' : 'Show', html: icon(visible ? 'eye' : 'eyeoff') });
    eyeBtn.addEventListener('click', () => togglePart(p.id));
    const row = h('li', { class: `part-row${visible ? '' : ' off'}`, 'data-part': p.id },
      h('span', { class: 'sw', style: `background:${p.color || '#888'}` }),
      h('div', { class: 'pr-main' }, h('div', { class: 'pr-name', text: p.name || p.id }), h('div', { class: 'pr-meta', text: meta })),
      p.quantity > 1 ? h('span', { class: 'qty', text: `×${p.quantity}` }) : null,
      eyeBtn,
      h('button', {
        type: 'button', class: 'icon-btn', title: `Download ${p.printable ? 'STL' : 'preview STL'}`, 'aria-label': `Download ${p.name} STL`, html: icon('download'),
        onclick: () => { downloadBytes(partSTL(p), partFileName(p, fileIdx), 'model/stl'); },
      }));
    list.append(row);
  }
  $('#parts-count').textContent = `${parts.length} parts`;

  // step timings (stats.timings: {step: ms} or [{step, ms}])
  const tm = s.timings;
  const rows = Array.isArray(tm) ? tm.map((t) => [t.step || t.name, t.ms ?? t.time]) : tm && typeof tm === 'object' ? Object.entries(tm) : [];
  const old = $('#timings');
  if (old) old.remove();
  if (rows.length) {
    const det = h('details', { class: 'timings', id: 'timings' }, h('summary', { text: `Step timings (${rows.length})` }));
    const dl = h('dl');
    for (const [k, v] of rows) dl.append(h('dt', { text: String(k) }), h('dd', { text: Number.isFinite(Number(v)) ? `${(Number(v) / 1000).toFixed(2)} s` : String(v) }));
    det.append(dl);
    sum.after(det);
  }

  const ol = $('#instructions');
  ol.textContent = '';
  for (const s2 of r.instructions || []) ol.append(h('li', { text: s2 }));
  if (!(r.instructions || []).length) ol.append(h('li', { class: 'muted', text: 'No instructions returned.' }));
}

function togglePart(id) {
  const on = viewer.hidden.has(id);
  viewer.setPartVisible(id, on);
  renderLegend();
  renderResultPane();
}

function renderLegend() {
  const lg = $('#legend');
  const items = viewer ? viewer.partsInStage(state.stage) : [];
  lg.hidden = !items.length;
  if (!items.length) return;
  const st = { silicone: 'Silicone pour', cast: 'Casting', print: 'Print layout' }[state.stage] || 'Parts';
  $('#legend-title').textContent = st;
  const ul = $('#legend-list');
  ul.textContent = '';
  for (const it of items) {
    const p = it.part;
    const li = h('li', { class: it.visible ? '' : 'off', role: 'button', tabindex: '0', 'aria-pressed': it.visible ? 'true' : 'false', title: `${it.visible ? 'Hide' : 'Show'} ${p.name}` },
      h('span', { class: 'sw', style: `background:${p.color || '#888'}` }),
      h('span', { class: 'ln', text: p.name || p.id }),
      it.count > 1 ? h('span', { class: 'lq', text: `×${it.count}` }) : null,
      h('span', { class: 'icon-btn', html: icon(it.visible ? 'eye' : 'eyeoff'), 'aria-hidden': 'true' }));
    li.addEventListener('click', () => togglePart(p.id));
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePart(p.id); } });
    ul.append(li);
  }
}

function showTab(which) {
  const setup = which === 'setup';
  $('#tab-setup').setAttribute('aria-selected', setup ? 'true' : 'false');
  $('#tab-result').setAttribute('aria-selected', setup ? 'false' : 'true');
  $('#tab-setup').tabIndex = setup ? 0 : -1;
  $('#tab-result').tabIndex = setup ? -1 : 0;
  $('#pane-setup').hidden = !setup;
  $('#pane-result').hidden = setup;
  if (!setup) $('#result-badge').hidden = true;
}

function updateEngineHint(mode) {
  const src = IS_LOCAL ? 'local' : 'CDN';
  const where = mode === 'worker' ? 'Web Worker' : mode === 'main' ? 'main thread' : 'loads on first run';
  $('#engine-hint').textContent = `Engine: manifold-3d ${VERSIONS.manifold} WASM · ${src} · ${where}`;
}

// ------------------------------------------------------------------------------ jobs
function setBusy(b) {
  state.busy = b;
  document.body.classList.toggle('busy', b);
  $('#btn-generate').disabled = b || !state.masters.length;
  for (const id of ['#btn-orient', '#btn-drop']) $(id).disabled = b || !state.masters.length;
}

async function generate() {
  if (state.busy) return;
  if (!state.masters.length) { toast('Load a master first (Open file or demo).', { type: 'warn' }); return; }
  const params = panel.get();
  const masters = state.masters.map(bakeWorld);
  setBusy(true);
  document.body.dataset.genState = 'running';
  const label = params.mode === 'support' ? 'support' : 'mold box';
  const prog = progressToast(`Generating ${label}…`, () => engine.cancel());
  try {
    const res = await engine.run({ type: 'generate', masters, params }, (step, frac) => prog.update(step, frac));
    state.genSeconds = prog.elapsed();
    prog.close();
    if (!res || !Array.isArray(res.parts)) throw new Error('Pipeline returned no parts');
    state.result = res;
    state.resultParams = params;
    state.stale = false;
    $('#stale-chip').hidden = true;
    $('#btn-generate').classList.remove('pulse');
    viewer.setResult(res);
    const has = viewer.availableStages();
    setStage(has.silicone ? 'silicone' : has.cast ? 'cast' : has.print ? 'print' : 'setup');
    viewer.fit();
    renderStats();
    renderResultPane();
    renderLegend();
    setExportEnabled(res.parts.some((p) => p.printable));
    const nw = (res.warnings || []).length;
    const badge = $('#result-badge');
    badge.hidden = $('#tab-result').getAttribute('aria-selected') === 'true';
    badge.classList.toggle('warn', nw > 0);
    toast(`Generated ${res.parts.length} parts in ${fmt(state.genSeconds, 1)} s${nw ? ` · ${nw} warning${nw > 1 ? 's' : ''}` : ''}`, { type: nw ? 'warn' : 'ok', timeout: 5000 });
    document.body.dataset.genState = 'done';
  } catch (e) {
    prog.close();
    if (e instanceof CancelledError || (e && e.name === 'CancelledError')) {
      toast('Generation cancelled', { type: 'info', timeout: 2500 });
      document.body.dataset.genState = 'cancelled';
    } else {
      console.warn('[generate]', e, e && e.workerStack);
      toast(`Generation failed: ${(e && e.message) || e}`, { type: 'error' });
      document.body.dataset.genState = 'error';
      document.body.dataset.genError = String((e && e.message) || e);
    }
  } finally {
    setBusy(false);
  }
}

async function autoOrient() {
  if (state.busy) return;
  let m = selectedMaster();
  if (!m && state.masters.length === 1) m = state.masters[0];
  if (!m) { toast('Select a master to auto-orient.', { type: 'warn' }); return; }
  setBusy(true);
  const prog = progressToast('Auto-orienting…', () => engine.cancel());
  try {
    const before = worldBox(m).getCenter(new THREE.Vector3());
    const r = await engine.run({ type: 'autoOrient', mesh: bakeWorld(m) }, (s, f) => prog.update(s, f));
    prog.close();
    const M = new THREE.Matrix4().fromArray(r.matrix);
    m.mesh.updateMatrixWorld(true);
    const world = new THREE.Matrix4().multiplyMatrices(M, m.mesh.matrixWorld);
    world.decompose(m.mesh.position, m.mesh.quaternion, m.mesh.scale);
    m.mesh.updateMatrixWorld(true);
    const after = worldBox(m);
    const c = after.getCenter(new THREE.Vector3());
    m.mesh.position.x += before.x - c.x;
    m.mesh.position.y += before.y - c.y;
    m.mesh.position.z -= after.min.z;
    viewer.updatePartingPlane();
    markStale();
    refreshMasters();
    const inf = r.info || {};
    const info = Number.isFinite(inf.partingAngleDeg) ? `pour end ${inf.pourEnd === '-' ? 'flipped up' : 'up'}, parting rotated ${fmt(inf.partingAngleDeg, 0)}°` : '';
    toast(`Auto-oriented ${m.name}${info ? ` — ${info}` : ''}`, { type: 'ok', timeout: 3500 });
  } catch (e) {
    prog.close();
    if (!(e instanceof CancelledError)) toast(`Auto-orient failed: ${(e && e.message) || e}`, { type: 'error' });
  } finally {
    setBusy(false);
  }
}

function doExport(kind = 'zip') {
  const r = state.result;
  if (!r) { toast('Generate first.', { type: 'warn' }); return; }
  const params = state.resultParams || panel.get();
  if (kind === 'params') {
    downloadBytes(new TextEncoder().encode(JSON.stringify(params, null, 2)), 'params.json', 'application/json');
    return;
  }
  try {
    const { bytes, files } = buildZip(r, params, { includePreview: kind === 'all' });
    downloadBytes(bytes, zipName(params), 'application/zip');
    toast(`Exported ${files.length} files · ${fmt(bytes.length / 1024 / 1024, 2)} MB`, { type: 'ok', timeout: 3500 });
  } catch (e) {
    console.warn(e);
    toast(`Export failed: ${e.message || e}`, { type: 'error' });
  }
}

// ------------------------------------------------------------------------------ menus
function bindMenu(btnSel, menuSel) {
  const btn = $(btnSel), menu = $(menuSel);
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.hidden;
    closeMenus();
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) { const f = menu.querySelector('input, button'); f && f.focus({ preventScroll: true }); }
  });
  menu.addEventListener('click', (e) => e.stopPropagation());
  openMenus.push(close);
  return close;
}
const openMenus = [];
function closeMenus() { openMenus.forEach((f) => f()); }

function syncSectionUI() {
  const on = viewer.section.on;
  $('#btn-section').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#chk-section').checked = on;
  $('#section-wrap').hidden = !on;
  if (on) {
    const r = viewer.sectionRange();
    const inp = $('#section-range');
    inp.min = String(r.min); inp.max = String(r.max);
    const v = viewer.section.value;
    inp.value = String(Number.isFinite(v) && v >= r.min && v <= r.max ? v : (r.min + r.max) / 2);
    viewer.setSection(true, Number(inp.value));
  }
}

function toggleSection(force) {
  const on = force !== undefined ? force : !viewer.section.on;
  viewer.setSection(on);
  syncSectionUI();
}

function setWireframe(on) {
  viewer.setWireframe(on);
  $('#chk-wire').checked = on;
}

function setGizmo(mode) {
  viewer.setGizmoMode(mode);
  $('#btn-move').setAttribute('aria-pressed', mode === 'translate' ? 'true' : 'false');
  $('#btn-rotate').setAttribute('aria-pressed', mode === 'rotate' ? 'true' : 'false');
}

function openSheet(open) {
  const sb = $('#sidebar');
  sb.classList.toggle('open', open);
  $('#btn-panel').setAttribute('aria-expanded', open ? 'true' : 'false');
}

// ------------------------------------------------------------------------------ init
function init() {
  hydrateIcons();
  updateEngineHint(null);

  try {
    viewer = new Viewer($('#viewport'), {
      onSelect: (mesh) => {
        refreshMastersSelection(mesh);
      },
      onTransform: (mesh, final) => {
        if (final) { markStale(); refreshMasters(); } else updateSelectionBar();
      },
    });
  } catch (e) {
    console.warn(e);
    const ge = $('#gl-error');
    ge.hidden = false;
    ge.textContent = `3D view unavailable (WebGL could not start): ${e.message || e}. You can still use the CLI: npm run cli -- model.stl`;
    return;
  }

  panel = createPanel($('#params'), {
    onChange: (p, key) => {
      if (key === 'partingOffset' || key === null) viewer.setPartingOffset(p.partingOffset);
      if (key === 'mode' || key === null) $('#gen-label').textContent = p.mode === 'support' ? 'Generate support' : 'Generate mold box';
      markStale();
      renderStats();
    },
  });
  const p0 = panel.get();
  viewer.setPartingOffset(p0.partingOffset);
  $('#gen-label').textContent = p0.mode === 'support' ? 'Generate support' : 'Generate mold box';

  // overlays persisted
  const ui = safeGet(UI_STORAGE_KEY) || {};
  const ov = ui.overlays || {};
  $$('#menu-overlay [data-overlay]').forEach((cb) => {
    const k = cb.dataset.overlay;
    if (typeof ov[k] === 'boolean') cb.checked = ov[k];
    viewer.setOverlay(k, cb.checked);
    cb.addEventListener('change', () => {
      viewer.setOverlay(k, cb.checked);
      const cur = safeGet(UI_STORAGE_KEY) || {};
      safeSet(UI_STORAGE_KEY, { ...cur, overlays: { ...(cur.overlays || {}), [k]: cb.checked } });
    });
  });
  $('#chk-wire').addEventListener('change', (e) => setWireframe(e.target.checked));
  $('#chk-section').addEventListener('change', (e) => toggleSection(e.target.checked));
  $$('#menu-overlay [data-view]').forEach((b) => b.addEventListener('click', () => viewer.view(b.dataset.view)));

  bindMenu('#btn-overlay', '#menu-overlay');
  bindMenu('#btn-keys', '#menu-keys');
  bindMenu('#btn-export-more', '#menu-export');
  document.addEventListener('click', () => closeMenus());

  // file loading
  const fileInput = $('#file-input');
  const openPicker = () => fileInput.click();
  for (const id of ['#btn-open', '#btn-open-side', '#btn-open-empty']) $(id).addEventListener('click', openPicker);
  fileInput.addEventListener('change', () => { loadFiles(fileInput.files); fileInput.value = ''; });
  for (const id of ['#btn-demo', '#btn-demo-top', '#btn-demo-side']) $(id).addEventListener('click', () => loadDemo());

  // drag & drop anywhere
  let dragDepth = 0;
  const overlay = $('#drop-overlay');
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    loadFiles(e.dataTransfer.files);
  });

  // toolbar
  $('#btn-move').addEventListener('click', () => { setStage('setup'); setGizmo('translate'); });
  $('#btn-rotate').addEventListener('click', () => { setStage('setup'); setGizmo('rotate'); });
  $('#btn-orient').addEventListener('click', () => autoOrient());
  $('#btn-drop').addEventListener('click', () => {
    const m = selectedMaster();
    dropToBed(m ? [m] : state.masters);
    toast(m ? `Dropped ${m.name} to the bed` : 'Dropped all masters to the bed', { type: 'ok', timeout: 1800 });
  });
  $('#btn-fit').addEventListener('click', () => viewer.fit());
  $('#btn-how').addEventListener('click', () => $('#dlg-how').showModal());
  $('#btn-how-empty').addEventListener('click', () => $('#dlg-how').showModal());
  $('#btn-panel').addEventListener('click', () => openSheet(!$('#sidebar').classList.contains('open')));
  $('#btn-sheet-close').addEventListener('click', () => openSheet(false));

  // tabs
  $('#tab-setup').addEventListener('click', () => showTab('setup'));
  $('#tab-result').addEventListener('click', () => showTab('result'));
  $('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = $('#tab-setup').getAttribute('aria-selected') === 'true' ? 'result' : 'setup';
    showTab(next);
    $(`#tab-${next}`).focus();
  });

  // generate / export
  $('#btn-generate').addEventListener('click', () => { openSheet(false); generate(); });
  $('#btn-export').addEventListener('click', () => doExport('zip'));
  $('#btn-export-top').addEventListener('click', () => doExport('zip'));
  $$('#menu-export [data-export]').forEach((b) => b.addEventListener('click', () => { closeMenus(); doExport(b.dataset.export); }));

  // masters array tool + selection bar
  $('#array-tool').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = selectedMaster();
    if (!m) return;
    const n = Math.max(2, Math.min(20, Math.round(Number($('#array-n').value) || 2)));
    const gap = Math.max(0, Number($('#array-gap').value) || 0);
    const w = worldBox(m).getSize(new THREE.Vector3()).x;
    for (let i = 1; i < n; i++) duplicateMaster(m, i * (w + gap));
    markStale();
    refreshMasters();
    viewer.fit();
    toast(`Array: ${n} × ${m.name}, ${fmt(gap)} mm gap`, { type: 'ok', timeout: 2000 });
  });
  $$('#selection-bar [data-rot]').forEach((b) => b.addEventListener('click', () => { const m = selectedMaster(); if (m) rotateMaster(m, b.dataset.rot); }));
  $('#sel-dup').addEventListener('click', () => { const m = selectedMaster(); if (m) { const c = duplicateMaster(m); markStale(); refreshMasters(); viewer.select(c.mesh); } });
  $('#sel-del').addEventListener('click', () => { const m = selectedMaster(); if (m) removeMaster(m); });
  $('#sel-scale').addEventListener('change', (e) => {
    const m = selectedMaster();
    const v = Number(e.target.value);
    if (!m || !(v > 0)) return;
    const k = v / 100;
    m.mesh.scale.set(k, k, k);
    m.mesh.updateMatrixWorld(true);
    m.mesh.position.z -= worldBox(m).min.z;
    viewer.updatePartingPlane();
    markStale();
    refreshMasters();
  });

  // stage bar
  $$('#stage-seg [role="tab"]').forEach((b) => b.addEventListener('click', () => { setStage(b.dataset.stage); }));
  $('#stage-seg').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const tabs = $$('#stage-seg [role="tab"]').filter((b) => !b.disabled);
    const i = tabs.findIndex((b) => b.dataset.stage === state.stage);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setStage(n.dataset.stage); n.focus();
  });
  $('#explode').addEventListener('input', (e) => viewer.setExplode(Number(e.target.value)));
  $('#btn-section').addEventListener('click', () => toggleSection());
  $('#section-range').addEventListener('input', (e) => viewer.setSection(true, Number(e.target.value)));
  $('#section-axis').addEventListener('change', (e) => { viewer.setSection(true, null, e.target.value); syncSectionUI(); });
  $('#legend-toggle').addEventListener('click', (e) => {
    const b = e.currentTarget;
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', open ? 'true' : 'false');
    $('#legend-list').hidden = !open;
  });

  // keyboard
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', (e) => { if (e.key === 'Shift') viewer.setSnap(false); });
  window.addEventListener('blur', () => viewer.setSnap(false));

  if (window.matchMedia && window.matchMedia('(max-width: 820px)').matches) {
    $('#legend-toggle').setAttribute('aria-expanded', 'false');
    $('#legend-list').hidden = true;
  }
  setStage('setup');
  refreshMasters();
  viewer.fit(null, { animate: false });
  document.body.dataset.ready = '1';

  // debug / test hook
  window.__meltemi = { state, viewer, panel, engine, generate, loadDemo, loadFiles, doExport, setStage };
}

function refreshMastersSelection(mesh) {
  $$('#master-list .master-row').forEach((row, i) => {
    const m = state.masters[i];
    row.setAttribute('aria-selected', m && m.mesh === mesh ? 'true' : 'false');
  });
  $('#array-tool').hidden = !mesh;
  updateSelectionBar();
}

function onKey(e) {
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (e.key === 'Shift') viewer.setSnap(true);
  if (e.key === 'Escape') {
    closeMenus();
    if ($('#sidebar').classList.contains('open')) openSheet(false);
    else if (!typing) viewer.select(null);
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key === 'Enter') { e.preventDefault(); generate(); return; }
  if (mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); doExport('zip'); return; }
  if (typing) return;
  if (mod && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault();
    const m = selectedMaster();
    if (m) { const c = duplicateMaster(m); markStale(); refreshMasters(); viewer.select(c.mesh); }
    return;
  }
  if (mod || e.altKey) return;
  switch (e.key) {
    case 'g': case 'G': setStage('setup'); setGizmo('translate'); break;
    case 'r': case 'R': setStage('setup'); setGizmo('rotate'); break;
    case 'Delete': case 'Backspace': { const m = selectedMaster(); if (m && state.stage === 'setup') { e.preventDefault(); removeMaster(m); } break; }
    case 'f': case 'F': viewer.fit(); break;
    case '1': setStage('setup'); break;
    case '2': setStage('silicone'); break;
    case '3': setStage('cast'); break;
    case '4': setStage('print'); break;
    case 'e': case 'E': {
      const ex = $('#explode');
      if (ex.disabled) break;
      ex.value = Number(ex.value) > 0.01 ? '0' : '0.6';
      viewer.setExplode(Number(ex.value));
      break;
    }
    case 'x': case 'X': toggleSection(); break;
    case 'w': case 'W': setWireframe(!viewer.wireframe); break;
    case 'o': case 'O': $('#file-input').click(); break;
    case '?': $('#btn-keys').click(); break;
    default: break;
  }
}

try {
  init();
} catch (e) {
  console.error(`${APP_NAME} failed to start`, e);
  const ge = document.getElementById('gl-error');
  if (ge) { ge.hidden = false; ge.textContent = `Startup error: ${e.message || e}`; }
}
