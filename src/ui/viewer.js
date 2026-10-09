// three.js viewport: Z-up scene in millimetres, infinite-looking grid on z=0, masters with
// move/rotate gizmo, live parting plane with extraction arrows, result parts per assembly
// stage (silicone pour / casting / print layout), explode, section, wireframe, axis gizmo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

export const MASTER_COLOR = 0xd9a441;
const SELECT_EMISSIVE = 0x4a2e00;
const HOVER_EMISSIVE = 0x241800;
const A_COLOR = 0x38bdf8;
const B_COLOR = 0xf59e0b;
const DEG = Math.PI / 180;

export const STAGES = [
  { id: 'setup', label: 'Setup' },
  { id: 'silicone', label: 'Silicone pour' },
  { id: 'cast', label: 'Casting' },
  { id: 'print', label: 'Print layout' },
];

/** BufferGeometry for display from MeshData (creased normals: smooth curves, crisp edges). */
export function geometryFromMeshData(md, creaseDeg = 35) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(md.positions, 3));
  const hasIdx = md.indices && md.indices.length;
  if (hasIdx) g.setIndex(new THREE.BufferAttribute(md.indices, 1));
  const tris = hasIdx ? md.indices.length / 3 : md.positions.length / 9;
  let out;
  if (tris > 2.5e6) {
    out = hasIdx ? g.toNonIndexed() : g;
    out.computeVertexNormals();
  } else {
    out = toCreasedNormals(g, creaseDeg * DEG);
  }
  if (out !== g) g.dispose();
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

function makeGridMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: {
      uColor: { value: new THREE.Color(0x8b95a8) },
      uCenter: { value: new THREE.Vector3() },
      uFade: { value: 800 },
      uMinor: { value: 10 },
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor;
      uniform vec3 uCenter;
      uniform float uFade;
      uniform float uMinor;
      varying vec3 vW;
      float gridLine(vec2 p, float s, float w) {
        vec2 c = p / s;
        vec2 g = abs(fract(c - 0.5) - 0.5) / (fwidth(c) * w);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float d = length(vW.xy - uCenter.xy);
        float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
        float minor = gridLine(vW.xy, uMinor, 1.0);
        float major = gridLine(vW.xy, uMinor * 10.0, 1.4);
        float a = max(minor * 0.16, major * 0.42);
        vec3 col = uColor;
        vec2 fw = fwidth(vW.xy);
        float ax = 1.0 - min(abs(vW.y) / (fw.y * 1.6), 1.0);
        float ay = 1.0 - min(abs(vW.x) / (fw.x * 1.6), 1.0);
        col = mix(col, vec3(0.93, 0.33, 0.36), ax);
        a = max(a, ax * 0.75);
        col = mix(col, vec3(0.38, 0.82, 0.45), ay * (1.0 - ax));
        a = max(a, ay * 0.75);
        a *= fade;
        if (a < 0.004) discard;
        gl_FragColor = vec4(col, a);
      }`,
  });
}

/** Solid arrow along +Y of unit length (shaft + cone), scaled by setArrow(). */
function makeArrow(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 16), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 24), mat);
  shaft.renderOrder = head.renderOrder = 5;
  g.add(shaft, head);
  g.userData = { shaft, head };
  return g;
}

/** Place arrow: origin, direction sign (+1 = +Y, -1 = -Y), length, thickness. */
function setArrow(a, origin, sign, len, r) {
  const { shaft, head } = a.userData;
  const hl = Math.min(len * 0.38, r * 7);
  a.position.copy(origin);
  a.rotation.set(0, 0, sign < 0 ? Math.PI : 0);
  shaft.scale.set(r, len - hl, r);
  shaft.position.set(0, (len - hl) / 2, 0);
  head.scale.set(r * 2.6, hl, r * 2.6);
  head.position.set(0, len - hl / 2, 0);
}

function labelEl(text, cls) {
  const d = document.createElement('div');
  d.className = `vlabel ${cls || ''}`;
  d.textContent = text;
  return d;
}

export class Viewer {
  /**
   * @param {HTMLElement} container
   * @param {{onSelect?:Function, onTransform?:Function, onHover?:Function}} opts
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.stage = 'setup';
    this.overlays = { plane: true, grid: true, axes: true, labels: true };
    this.wireframe = false;
    this.section = { on: false, axis: 'x', value: 0, flip: false };
    this.explode = 0;
    this.partingOffset = 0;
    this.hidden = new Set();
    this.result = null;
    this.entries = [];
    this.selected = null;
    this._dirty = true;
    this._tween = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'gl';
    renderer.domElement.setAttribute('aria-label', '3D viewport');
    renderer.domElement.setAttribute('role', 'img');
    renderer.domElement.tabIndex = 0;
    container.append(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.className = 'labels';
    container.append(labels.domElement);
    this.labelRenderer = labels;

    const scene = new THREE.Scene();
    this.scene = scene;
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.55;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xe3ebff, 0x1d1712, 0.85));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(-160, -260, 340);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0x9ec5ff, 0.55);
    fill.position.set(220, 300, 120);
    scene.add(fill);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 20000);
    camera.up.set(0, 0, 1);
    camera.position.set(230, -330, 230);
    this.camera = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0, 50);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.maxDistance = 8000;
    controls.update();
    this.controls = controls;

    // Grid
    this.grid = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), makeGridMaterial());
    this.grid.scale.set(20000, 20000, 1);
    this.grid.renderOrder = -1;
    this.grid.frustumCulled = false;
    scene.add(this.grid);

    // Groups
    this.mastersGroup = new THREE.Group();
    this.mastersGroup.name = 'masters';
    scene.add(this.mastersGroup);
    this.overlayGroup = new THREE.Group();
    scene.add(this.overlayGroup);
    this.stageGroups = { silicone: new THREE.Group(), cast: new THREE.Group(), print: new THREE.Group() };
    for (const g of Object.values(this.stageGroups)) { g.visible = false; scene.add(g); }

    // Section plane (shared by all clippable materials)
    this.clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
    this.clipPlanes = [this.clipPlane];

    this._buildPartingOverlay();

    // Transform gizmo
    const tc = new TransformControls(camera, renderer.domElement);
    tc.setSize(0.85);
    tc.setSpace('world');
    tc.addEventListener('dragging-changed', (e) => {
      controls.enabled = !e.value;
      if (e.value) this._tcDragged = true;
      if (!e.value && this.selected) {
        this.updatePartingPlane();
        this.opts.onTransform && this.opts.onTransform(this.selected, true);
      }
    });
    tc.addEventListener('objectChange', () => {
      this.updatePartingPlane();
      this.opts.onTransform && this.opts.onTransform(this.selected, false);
    });
    tc.addEventListener('change', () => this.requestRender());
    scene.add(tc.getHelper());
    this.tc = tc;

    this._initPicking();
    this._initAxisGizmo();

    controls.addEventListener('change', () => this.requestRender());
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this.resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  // ------------------------------------------------------------------ basics
  requestRender() { this._dirty = true; }

  resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  _loop(t) {
    requestAnimationFrame(this._loop);
    if (this._tween) {
      const tw = this._tween;
      const k = Math.min(1, (t - tw.t0) / tw.dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.camera.position.lerpVectors(tw.p0, tw.p1, e);
      this.controls.target.lerpVectors(tw.c0, tw.c1, e);
      if (k >= 1) this._tween = null;
      this._dirty = true;
    }
    const moved = this.controls.update();
    if (!moved && !this._dirty) return;
    this._dirty = false;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const u = this.grid.material.uniforms;
    u.uCenter.value.copy(this.controls.target);
    u.uFade.value = Math.max(300, dist * 3.2);
    u.uMinor.value = Math.min(100, Math.max(1, Math.pow(10, Math.floor(Math.log10(dist / 18)))));
    this.grid.position.x = this.controls.target.x;
    this.grid.position.y = this.controls.target.y;
    this.camera.near = Math.max(0.05, dist / 400);
    this.camera.far = Math.max(5000, dist * 60);
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    this._updateAxisGizmo();
  }

  // ------------------------------------------------------------------ masters
  /** Add a master mesh (display geometry in local coords). Returns the THREE.Mesh. */
  addMaster(geometry, name) {
    const mat = new THREE.MeshStandardMaterial({
      color: MASTER_COLOR, metalness: 0.5, roughness: 0.32, envMapIntensity: 1.1,
      side: THREE.DoubleSide, wireframe: this.wireframe,
    });
    this._applyClip(mat);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = name || 'master';
    mesh.userData.isMaster = true;
    this.mastersGroup.add(mesh);
    this.updatePartingPlane();
    this.requestRender();
    return mesh;
  }

  removeMaster(mesh) {
    if (this.selected === mesh) this.select(null);
    this.mastersGroup.remove(mesh);
    mesh.material.dispose();
    if (!this.mastersGroup.children.some((m) => m.geometry === mesh.geometry)) mesh.geometry.dispose();
    this.updatePartingPlane();
    this.requestRender();
  }

  get masters() { return this.mastersGroup.children; }

  select(mesh) {
    if (this.selected && this.selected.material) this.selected.material.emissive.setHex(0x000000);
    this.selected = mesh || null;
    if (this.selected) {
      this.selected.material.emissive.setHex(SELECT_EMISSIVE);
      if (this.stage === 'setup') this.tc.attach(this.selected);
    } else {
      this.tc.detach();
    }
    this.opts.onSelect && this.opts.onSelect(this.selected);
    this.requestRender();
  }

  setGizmoMode(mode) {
    this.tc.setMode(mode === 'rotate' ? 'rotate' : 'translate');
    this.requestRender();
  }

  setSnap(on) {
    this.tc.setTranslationSnap(on ? 1 : null);
    this.tc.setRotationSnap(on ? 15 * DEG : null);
  }

  /** World bounding box of all masters (precise). */
  mastersBox() {
    const box = new THREE.Box3();
    this.mastersGroup.updateMatrixWorld(true);
    for (const m of this.mastersGroup.children) box.union(new THREE.Box3().setFromObject(m, true));
    return box;
  }

  objectBox(obj) {
    obj.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(obj, true);
  }

  // ------------------------------------------------------------------ parting plane
  _buildPartingOverlay() {
    const g = this.overlayGroup;
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      color: 0xff3b3b, transparent: true, opacity: 0.17, side: THREE.DoubleSide, depthWrite: false,
    }));
    plane.rotation.x = Math.PI / 2; // XY plane -> XZ plane (normal along Y)
    plane.renderOrder = 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: 0xff5a5a, transparent: true, opacity: 0.8 }));
    plane.add(edges);
    g.add(plane);
    this.plane = plane;
    this.arrowA = makeArrow(A_COLOR);
    this.arrowB = makeArrow(B_COLOR);
    g.add(this.arrowA, this.arrowB);
    this.labelA = new CSS2DObject(labelEl('A extraction −Y', 'vlabel-a'));
    this.labelB = new CSS2DObject(labelEl('B extraction +Y', 'vlabel-b'));
    this.labelPlane = new CSS2DObject(labelEl('Parting plane', 'vlabel-plane'));
    g.add(this.labelA, this.labelB, this.labelPlane);
    g.visible = false;
  }

  setPartingOffset(v) {
    this.partingOffset = Number(v) || 0;
    this.updatePartingPlane();
  }

  /**
   * Recompute plane from the masters bbox (+ offset) in setup, or from the generated mold
   * (frame.y0) in the silicone stage. Returns {y0, box} or null.
   */
  updatePartingPlane() {
    const g = this.overlayGroup;
    if (!this.mastersGroup.children.length && !this.entries.length) { g.visible = false; this.planeInfo = null; this.requestRender(); return null; }
    const useMold = this.stage !== 'setup' && this.moldBox && !this.moldBox.isEmpty();
    const box = useMold ? this.moldBox.clone() : this.mastersBox();
    if (box.isEmpty()) { g.visible = false; return null; }
    const size = box.getSize(new THREE.Vector3());
    const fy0 = this.result && this.result.frame && Number.isFinite(this.result.frame.y0) ? this.result.frame.y0 : (box.min.y + box.max.y) / 2;
    const y0 = useMold ? fy0 : (box.min.y + box.max.y) / 2 + this.partingOffset;
    const margin = Math.max(8, 0.12 * Math.max(size.x, size.z));
    const x0 = box.min.x - margin, x1 = box.max.x + margin;
    const z0 = Math.max(box.min.z - margin * 0.5, box.min.z - 6), z1 = box.max.z + margin;
    this.plane.position.set((x0 + x1) / 2, y0, (z0 + z1) / 2);
    this.plane.scale.set(x1 - x0, z1 - z0, 1);
    const L = Math.max(22, Math.min(70, size.y * 0.5 + 18));
    const zA = z1 + margin * 0.35;
    const cx = (x0 + x1) / 2;
    const r = Math.max(0.6, Math.min(2.2, L * 0.035));
    const o = new THREE.Vector3(cx, y0, zA);
    setArrow(this.arrowA, o, -1, L, r);
    setArrow(this.arrowB, o, +1, L, r);
    this.labelA.position.set(cx, y0 - L - 3, zA + r * 4);
    this.labelB.position.set(cx, y0 + L + 3, zA + r * 4);
    this.labelPlane.position.set(x1, y0, z0);
    this.labelPlane.element.textContent = `Parting plane  y = ${(Math.abs(y0) < 0.05 ? 0 : y0).toFixed(1)} mm`;
    this.planeInfo = { y0, box };
    this._applyOverlayVisibility();
    this.requestRender();
    return this.planeInfo;
  }

  _applyOverlayVisibility() {
    const hasMasters = this.mastersGroup.children.length > 0;
    const showPlane = this.overlays.plane && hasMasters && (this.stage === 'setup' || this.stage === 'silicone');
    this.overlayGroup.visible = showPlane;
    const lab = this.overlays.labels && showPlane;
    for (const l of [this.labelA, this.labelB, this.labelPlane]) {
      l.visible = lab;
      l.element.style.display = lab ? '' : 'none';
    }
    this.arrowA.visible = this.arrowB.visible = this.overlays.labels;
    this.grid.visible = this.overlays.grid;
    if (this._axisSvg) this._axisSvg.style.display = this.overlays.axes ? '' : 'none';
  }

  setOverlay(name, on) {
    this.overlays[name] = !!on;
    this._applyOverlayVisibility();
    this.requestRender();
  }

  // ------------------------------------------------------------------ result
  clearResult() {
    for (const e of this.entries) {
      e.geometry.dispose();
      e.material.dispose();
      e.capMaterial.dispose();
      if (e.printGeometry) e.printGeometry.dispose();
    }
    this.entries = [];
    for (const g of Object.values(this.stageGroups)) {
      g.traverse((o) => { if (o.isLine) { o.geometry.dispose(); o.material.dispose(); } if (o.isCSS2DObject) o.element.remove(); });
      g.clear();
    }
    this.stageGroups.print.position.set(0, 0, 0);
    this.result = null;
    this.moldBox = null;
    this.requestRender();
  }

  /** Show a pipeline Result. */
  setResult(result) {
    this.clearResult();
    this.result = result;
    const frame = result.frame || {};
    const parts = result.parts || [];
    const moldBox = new THREE.Box3();
    const tmpBox = new THREE.Box3();
    const m4 = new THREE.Matrix4();

    for (const part of parts) {
      if (!part.mesh || !part.mesh.positions || !part.mesh.positions.length) continue;
      const geometry = geometryFromMeshData(part.mesh);
      const color = new THREE.Color(part.color || '#9aa4b2');
      const role = part.role || 'shell';
      const material = new THREE.MeshStandardMaterial({
        color,
        metalness: role === 'master' ? 0.5 : role === 'pin' || role === 'clip' ? 0.15 : 0.04,
        roughness: role === 'silicone' ? 0.7 : role === 'master' ? 0.32 : 0.52,
        side: THREE.DoubleSide,
        wireframe: this.wireframe,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const capMaterial = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(0.55), side: THREE.BackSide });
      capMaterial.visible = this.section.on;
      this._applyClip(material);
      this._applyClip(capMaterial);
      const entry = { part, geometry, material, capMaterial, instances: { silicone: [], cast: [], print: [] } };
      for (const st of ['silicone', 'cast']) {
        const poses = (part.stages && part.stages[st]) || [];
        for (const pose of poses) {
          const base = new THREE.Matrix4();
          if (pose && pose.length === 16) base.fromArray(pose);
          const inst = this._instance(entry, base);
          this.stageGroups[st].add(inst);
          entry.instances[st].push(inst);
          tmpBox.copy(geometry.boundingBox).applyMatrix4(base);
          moldBox.union(tmpBox);
        }
      }
      this.entries.push(entry);
    }

    // Explode directions, from each instance's centre relative to the parting plane.
    const y0 = Number.isFinite(frame.y0) ? frame.y0 : moldBox.isEmpty() ? 0 : (moldBox.min.y + moldBox.max.y) / 2;
    const c0 = moldBox.isEmpty() ? new THREE.Vector3() : moldBox.getCenter(new THREE.Vector3());
    const msize = moldBox.isEmpty() ? new THREE.Vector3(100, 100, 100) : moldBox.getSize(new THREE.Vector3());
    this.moldBox = moldBox;
    this.explodeScale = 0.55 * Math.max(msize.x, msize.y, msize.z) + 20;
    const MULT = { shell: 1, cage: 1, silicone: 0.45, clip: 1.5, pin: 1.25, board: 0, master: 0, cast: 0 };
    for (const e of this.entries) {
      for (const st of ['silicone', 'cast']) {
        for (const inst of e.instances[st]) {
          const b = tmpBox.copy(e.geometry.boundingBox).applyMatrix4(inst.userData.base);
          const c = b.getCenter(new THREE.Vector3());
          const dy = c.y - y0;
          const half = (b.max.y - b.min.y) / 2;
          const mult = MULT[e.part.role] ?? 1;
          let dir;
          if (Math.abs(dy) > Math.max(0.75, half * 0.25)) dir = new THREE.Vector3(0, Math.sign(dy), 0);
          else {
            // straddles the plane (clips, pins): move outward along the dominant axis
            const ex = (c.x - c0.x) / Math.max(1, msize.x / 2), ez = (c.z - c0.z) / Math.max(1, msize.z / 2);
            if (Math.abs(ex) >= Math.abs(ez) && Math.abs(ex) > 1e-3) dir = new THREE.Vector3(Math.sign(ex), 0, 0);
            else if (Math.abs(ez) > 1e-3) dir = new THREE.Vector3(0, 0, Math.sign(ez));
            else dir = new THREE.Vector3(0, 0, 1);
          }
          inst.userData.explode = dir.multiplyScalar(mult);
        }
      }
    }

    this._layoutPrint(m4);
    this.setExplode(this.explode);
    this.updatePartingPlane();
    this._updateSectionRange();
    this.requestRender();
  }

  _instance(entry, base) {
    const mesh = new THREE.Mesh(entry.geometry, entry.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(base);
    mesh.userData.base = base;
    mesh.userData.partId = entry.part.id;
    const cap = new THREE.Mesh(entry.geometry, entry.capMaterial);
    cap.matrixAutoUpdate = false;
    cap.renderOrder = -0.5;
    mesh.add(cap);
    mesh.visible = !this.hidden.has(entry.part.id);
    return mesh;
  }

  /** Lay printable parts out on the bed (z=0), side by side in X, shelf-packed rows. */
  _layoutPrint() {
    const items = [];
    for (const e of this.entries) {
      if (!e.part.printable) continue;
      const pm = new THREE.Matrix4();
      if (e.part.printMatrix && e.part.printMatrix.length === 16) pm.fromArray(e.part.printMatrix);
      const g = e.geometry.clone().applyMatrix4(pm);
      g.computeBoundingBox();
      e.printGeometry = g;
      const q = Math.max(1, Math.round(e.part.quantity || 1));
      for (let i = 0; i < q; i++) items.push({ e, box: g.boundingBox });
    }
    if (!items.length) return;
    const gap = 8;
    const totalArea = items.reduce((s, it) => s + (it.box.max.x - it.box.min.x + gap) * (it.box.max.y - it.box.min.y + gap), 0);
    const widest = Math.max(...items.map((it) => it.box.max.x - it.box.min.x));
    const rowW = Math.max(widest, Math.sqrt(totalArea) * 1.5, 160);
    let x = 0, y = 0, rowH = 0;
    for (const it of items) {
      const w = it.box.max.x - it.box.min.x, d = it.box.max.y - it.box.min.y;
      if (x > 0 && x + w > rowW) { x = 0; y += rowH + gap; rowH = 0; }
      const mesh = new THREE.Mesh(it.e.printGeometry, it.e.material);
      const cap = new THREE.Mesh(it.e.printGeometry, it.e.capMaterial);
      mesh.add(cap);
      mesh.position.set(x - it.box.min.x, y - it.box.min.y, -it.box.min.z);
      mesh.userData.partId = it.e.part.id;
      mesh.visible = !this.hidden.has(it.e.part.id);
      this.stageGroups.print.add(mesh);
      it.e.instances.print.push(mesh);
      x += w + gap;
      rowH = Math.max(rowH, d);
    }
    // centre the layout on the origin
    const b = new THREE.Box3().setFromObject(this.stageGroups.print);
    const c = b.getCenter(new THREE.Vector3());
    this.stageGroups.print.position.set(-c.x, -c.y, 0);
    // outline of the used bed area + size label (helps to check the printer's build plate)
    const pad = 4;
    const x0 = b.min.x - pad, x1 = b.max.x + pad, y0 = b.min.y - pad, y1 = b.max.y + pad;
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x0, y0, 0.05), new THREE.Vector3(x1, y0, 0.05), new THREE.Vector3(x1, y1, 0.05), new THREE.Vector3(x0, y1, 0.05),
    ]), new THREE.LineDashedMaterial({ color: 0xe8ae45, dashSize: 4, gapSize: 3, transparent: true, opacity: 0.8 }));
    outline.computeLineDistances();
    this.stageGroups.print.add(outline);
    const maxH = b.max.z - b.min.z;
    const lab = new CSS2DObject(labelEl(`Layout ${Math.round(b.max.x - b.min.x)} × ${Math.round(b.max.y - b.min.y)} mm · tallest ${Math.round(maxH)} mm`, 'vlabel-bed'));
    lab.position.set(x1, y0, 0);
    this.stageGroups.print.add(lab);
  }

  /** Size (x, y, z mm) of a part in print orientation, or null. */
  printSize(id) {
    const e = this.entries.find((x) => x.part.id === id);
    if (!e || !e.printGeometry) return null;
    const s = e.printGeometry.boundingBox.getSize(new THREE.Vector3());
    return [s.x, s.y, s.z];
  }

  /** Which stages have content. */
  availableStages() {
    const has = { setup: true, silicone: false, cast: false, print: false };
    for (const e of this.entries) {
      for (const st of ['silicone', 'cast', 'print']) if (e.instances[st].length) has[st] = true;
    }
    return has;
  }

  /** Parts visible in a stage (for the legend). */
  partsInStage(stage = this.stage) {
    if (stage === 'setup') return [];
    return this.entries.filter((e) => e.instances[stage] && e.instances[stage].length).map((e) => ({
      part: e.part, count: e.instances[stage].length, visible: !this.hidden.has(e.part.id),
    }));
  }

  setStage(stage) {
    this.stage = stage;
    const setup = stage === 'setup';
    for (const [k, g] of Object.entries(this.stageGroups)) g.visible = k === stage;
    // In assembly stages show the loaded masters only if the result carries no master/cast part.
    const assembly = stage === 'silicone' || stage === 'cast';
    const hasPositive = this.entries.some((e) => (e.part.role === 'master' || e.part.role === 'cast') && e.instances[stage] && e.instances[stage].length);
    this.mastersGroup.visible = setup || (assembly && !hasPositive);
    if (setup && this.selected) this.tc.attach(this.selected); else this.tc.detach();
    this.tc.enabled = setup;
    // Mold stands on its floor; print layout and setup on z=0.
    const zf = this.result && this.result.frame && Number.isFinite(this.result.frame.zFloor) ? this.result.frame.zFloor : 0;
    this.grid.position.z = (stage === 'silicone' || stage === 'cast') ? Math.min(0, zf) - 0.02 : -0.02;
    this.updatePartingPlane();
    this._applyOverlayVisibility();
    this._updateSectionRange();
    this.requestRender();
  }

  setExplode(t) {
    this.explode = Math.max(0, Math.min(1, Number(t) || 0));
    const D = this.explode * (this.explodeScale || 60);
    const off = new THREE.Matrix4();
    for (const e of this.entries) {
      for (const st of ['silicone', 'cast']) {
        for (const inst of e.instances[st]) {
          const d = inst.userData.explode;
          off.makeTranslation(d ? d.x * D : 0, d ? d.y * D : 0, d ? d.z * D : 0);
          inst.matrix.multiplyMatrices(off, inst.userData.base);
          inst.matrixWorldNeedsUpdate = true;
        }
      }
    }
    this.requestRender();
  }

  setPartVisible(id, on) {
    if (on) this.hidden.delete(id); else this.hidden.add(id);
    for (const e of this.entries) {
      if (e.part.id !== id) continue;
      for (const st of ['silicone', 'cast', 'print']) for (const m of e.instances[st]) m.visible = !!on;
    }
    this.requestRender();
  }

  setWireframe(on) {
    this.wireframe = !!on;
    for (const m of this.mastersGroup.children) m.material.wireframe = this.wireframe;
    for (const e of this.entries) e.material.wireframe = this.wireframe;
    this.requestRender();
  }

  // ------------------------------------------------------------------ section view
  _applyClip(mat) {
    mat.clippingPlanes = this.section.on ? this.clipPlanes : null;
    mat.needsUpdate = true;
  }

  /** Range of the section slider for the current content. */
  sectionRange() {
    const ax = this.section.axis;
    const box = this.stage === 'setup' || !this.entries.length ? this.mastersBox()
      : this.objectBox(this.stageGroups[this.stage] || this.mastersGroup);
    if (box.isEmpty()) return { min: -50, max: 50 };
    return { min: box.min[ax] - 1, max: box.max[ax] + 1 };
  }

  _updateSectionRange() {
    const r = this.sectionRange();
    this.section.range = r;
    if (!(this.section.value >= r.min && this.section.value <= r.max)) this.section.value = (r.min + r.max) / 2;
    this._applySectionPlane();
  }

  setSection(on, value, axis) {
    const wasOn = this.section.on;
    this.section.on = !!on;
    if (axis && axis !== this.section.axis) { this.section.axis = axis; this.section.value = NaN; this._updateSectionRange(); }
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) this.section.value = Number(value);
    if (wasOn !== this.section.on) {
      for (const m of this.mastersGroup.children) this._applyClip(m.material);
      for (const e of this.entries) {
        this._applyClip(e.material);
        this._applyClip(e.capMaterial);
        e.capMaterial.visible = this.section.on;
      }
    }
    this._applySectionPlane();
    this.requestRender();
    return this.section;
  }

  _applySectionPlane() {
    const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[this.section.axis] || [-1, 0, 0];
    let v = this.section.value;
    // The print layout group is offset; convert the slider value (world) to clip plane (world) - same frame.
    this.clipPlane.normal.set(n[0], n[1], n[2]);
    this.clipPlane.constant = Number.isFinite(v) ? v : 0;
    if (this.section.flip) { this.clipPlane.normal.negate(); this.clipPlane.constant = -this.clipPlane.constant; }
  }

  // ------------------------------------------------------------------ camera
  /** Fit camera to the visible content (or a given Box3). */
  fit(box, { animate = true, dir } = {}) {
    let b = box;
    if (!b) {
      if (this.stage === 'setup' || !this.entries.length) {
        b = this.mastersBox();
        // include the parting plane + extraction arrows when shown
        if (!b.isEmpty() && this.overlayGroup.visible) {
          const p = this.plane;
          b.union(new THREE.Box3().setFromCenterAndSize(p.position, new THREE.Vector3(p.scale.x, 1, p.scale.y)));
          if (this.arrowA.visible) {
            b.expandByPoint(this.labelA.position);
            b.expandByPoint(this.labelB.position);
          }
        }
      } else b = this.objectBox(this.stageGroups[this.stage]);
    }
    if (!b || b.isEmpty()) b = new THREE.Box3(new THREE.Vector3(-60, -60, 0), new THREE.Vector3(60, 60, 80));
    const sphere = b.getBoundingSphere(new THREE.Sphere());
    const vfov = this.camera.fov * DEG;
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const fov = Math.min(vfov, hfov);
    const dist = (sphere.radius / Math.sin(fov / 2)) * 1.08;
    const d = dir ? dir.clone().normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    const p1 = sphere.center.clone().addScaledVector(d, dist);
    if (animate) {
      this._tween = { t0: performance.now(), dur: 380, p0: this.camera.position.clone(), p1, c0: this.controls.target.clone(), c1: sphere.center.clone() };
    } else {
      this.camera.position.copy(p1);
      this.controls.target.copy(sphere.center);
    }
    this.requestRender();
  }

  /** View along an axis: 'x','-x','y','-y','z','-z','iso'. */
  view(name) {
    const dirs = {
      x: [1, 0, 0], '-x': [-1, 0, 0], y: [0, 1, 0], '-y': [0, -1, 0], z: [0, 0.0001, 1], '-z': [0, 0.0001, -1],
      iso: [0.55, -0.8, 0.55], front: [0, -1, 0.0001],
    };
    const d = dirs[name] || dirs.iso;
    this.fit(null, { dir: new THREE.Vector3(...d) });
  }

  // ------------------------------------------------------------------ picking
  _initPicking() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    const pick = (ev) => {
      const r = el.getBoundingClientRect();
      ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hits = ray.intersectObjects(this.mastersGroup.children, false);
      return hits.length ? hits[0].object : null;
    };
    el.addEventListener('pointerdown', (ev) => { down = { x: ev.clientX, y: ev.clientY }; this._tcDragged = false; });
    el.addEventListener('pointerup', (ev) => {
      if (!down) return;
      const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 5;
      down = null;
      if (moved || this._tcDragged || this.stage !== 'setup') return;
      if (this.tc.axis) return; // clicked the gizmo
      this.select(pick(ev));
    });
    let hoverRaf = 0;
    el.addEventListener('pointermove', (ev) => {
      if (this.stage !== 'setup' || down || hoverRaf) return;
      hoverRaf = requestAnimationFrame(() => {
        hoverRaf = 0;
        const h = pick(ev);
        if (h !== this._hover) {
          if (this._hover && this._hover !== this.selected) this._hover.material.emissive.setHex(0);
          this._hover = h;
          if (h && h !== this.selected) h.material.emissive.setHex(HOVER_EMISSIVE);
          el.style.cursor = h ? 'pointer' : '';
          this.requestRender();
        }
      });
    });
  }

  // ------------------------------------------------------------------ axis gizmo (SVG)
  _initAxisGizmo() {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'axis-gizmo');
    svg.setAttribute('viewBox', '-50 -50 100 100');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', 'View orientation: click an axis to look along it');
    const bg = document.createElementNS(NS, 'circle');
    bg.setAttribute('r', '46');
    bg.setAttribute('class', 'ag-bg');
    svg.append(bg);
    const axes = [
      { n: 'x', c: '#f05d6a', v: new THREE.Vector3(1, 0, 0) },
      { n: 'y', c: '#62d26f', v: new THREE.Vector3(0, 1, 0) },
      { n: 'z', c: '#5aa7ff', v: new THREE.Vector3(0, 0, 1) },
    ];
    this._axisItems = [];
    for (const a of axes) {
      for (const neg of [false, true]) {
        const g = document.createElementNS(NS, 'g');
        g.setAttribute('class', `ag-axis${neg ? ' neg' : ''}`);
        g.setAttribute('tabindex', '0');
        g.setAttribute('role', 'button');
        g.setAttribute('aria-label', `View from ${neg ? '-' : '+'}${a.n.toUpperCase()}`);
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('stroke', a.c);
        line.setAttribute('stroke-width', neg ? '0' : '3');
        line.setAttribute('stroke-linecap', 'round');
        const circ = document.createElementNS(NS, 'circle');
        circ.setAttribute('r', neg ? '5' : '8.5');
        circ.setAttribute('fill', neg ? 'transparent' : a.c);
        circ.setAttribute('stroke', a.c);
        circ.setAttribute('stroke-width', neg ? '1.6' : '0');
        const txt = document.createElementNS(NS, 'text');
        txt.textContent = neg ? '' : a.n.toUpperCase();
        txt.setAttribute('text-anchor', 'middle');
        txt.setAttribute('dominant-baseline', 'central');
        g.append(line, circ, txt);
        const go = () => this.view(neg ? `-${a.n}` : a.n);
        g.addEventListener('click', go);
        g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        svg.append(g);
        this._axisItems.push({ g, line, circ, txt, v: a.v.clone().multiplyScalar(neg ? -1 : 1) });
      }
    }
    this.container.append(svg);
    this._axisSvg = svg;
    this._qInv = new THREE.Quaternion();
  }

  _updateAxisGizmo() {
    if (!this._axisItems || !this.overlays.axes) return;
    this._qInv.copy(this.camera.quaternion).invert();
    const R = 32;
    const items = this._axisItems.map((it) => {
      const v = it.v.clone().applyQuaternion(this._qInv);
      return { it, x: v.x * R, y: -v.y * R, z: v.z };
    }).sort((a, b) => a.z - b.z);
    for (const { it, x, y, z } of items) {
      it.line.setAttribute('x1', '0'); it.line.setAttribute('y1', '0');
      it.line.setAttribute('x2', String(x * 0.78)); it.line.setAttribute('y2', String(y * 0.78));
      it.circ.setAttribute('cx', String(x)); it.circ.setAttribute('cy', String(y));
      it.txt.setAttribute('x', String(x)); it.txt.setAttribute('y', String(y + 0.5));
      it.g.style.opacity = String(0.55 + 0.45 * Math.max(0, z + 0.2));
      it.g.parentNode.appendChild(it.g); // z-order
    }
  }

  dispose() {
    this._ro.disconnect();
    this.renderer.dispose();
  }
}
