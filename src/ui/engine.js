// Geometry job engine. Runs jobs in a module Web Worker when possible and falls back to
// the main thread (same code path: loadCore + runJob) when a worker cannot be created or
// initialised. Cancel = terminate the worker (main-thread jobs can only be abandoned).
//
// Jobs:
//   { type: 'generate',   masters: MeshData[], params }  -> pipeline Result
//   { type: 'autoOrient', mesh: MeshData }               -> { matrix: Mat4, info }
//
// This module has no bare imports so worker.js can import it too.
import { MANIFOLD_URL } from './config.js';

export class CancelledError extends Error {
  constructor(msg = 'Cancelled') { super(msg); this.name = 'CancelledError'; }
}

// ---------------------------------------------------------------------------------------
// Shared job code (runs in the worker or on the main thread)
// ---------------------------------------------------------------------------------------

function errInfo(e) {
  return e ? (e.message || String(e)) : 'unknown error';
}

/**
 * Load manifold-3d WASM and the core modules. Each core module is imported independently so
 * that e.g. auto-orient still works while the pipeline module is missing or broken.
 */
export async function loadCore(manifoldUrl = MANIFOLD_URL) {
  const t0 = now();
  const core = { errors: {}, mode: typeof window === 'undefined' ? 'worker' : 'main' };
  const wasmMod = await import(/* @vite-ignore */ manifoldUrl);
  const { initManifold } = await import('../core/wasm.js');
  await initManifold(wasmMod.default || wasmMod);
  core.wasmMs = now() - t0;
  const tryImport = async (key, path) => {
    try { core[key] = await import(path); } catch (e) { core.errors[key] = `Could not load ${path.replace('../', 'src/')}: ${errInfo(e)}`; }
  };
  await tryImport('pipeline', '../core/pipeline.js');
  await tryImport('analysis', '../core/analysis.js');
  await tryImport('meshio', '../core/meshio.js');
  return core;
}

/** Run one job against a loaded core. onProgress(step, frac). */
export async function runJob(core, job, onProgress = () => {}) {
  if (job.type === 'generate') {
    const p = core.pipeline;
    if (!p) throw new Error(core.errors.pipeline || 'Geometry pipeline not available');
    const mode = job.params && job.params.mode;
    let fn = p.generate;
    if (typeof fn !== 'function') fn = mode === 'support' ? (p.generateSupport || p.generateMoldBox) : p.generateMoldBox;
    if (typeof fn !== 'function') throw new Error('src/core/pipeline.js exports neither generate() nor generateMoldBox()');
    let lastStep = '';
    const res = await fn(job.masters, job.params, (step, frac) => {
      if (step) lastStep = step;
      try { onProgress(step || lastStep, typeof frac === 'number' ? frac : NaN); } catch { /* ignore */ }
    });
    return toCloneable(res);
  }
  if (job.type === 'autoOrient') {
    if (!core.analysis || typeof core.analysis.autoOrient !== 'function') throw new Error(core.errors.analysis || 'autoOrient() not available in src/core/analysis.js');
    if (!core.meshio || typeof core.meshio.manifoldFromMesh !== 'function') throw new Error(core.errors.meshio || 'manifoldFromMesh() not available in src/core/meshio.js');
    onProgress('Analysing orientation', 0.1);
    const conv = core.meshio.manifoldFromMesh(job.mesh);
    const manifold = conv && conv.manifold ? conv.manifold : conv;
    try {
      const r = core.analysis.autoOrient(manifold);
      onProgress('Analysing orientation', 1);
      return toCloneable({ matrix: Array.from(r.matrix || r), info: r.info || null, warnings: (conv && conv.warnings) || [] });
    } finally {
      try { if (manifold && typeof manifold.delete === 'function') manifold.delete(); } catch { /* ignore */ }
    }
  }
  throw new Error(`Unknown job type: ${job.type}`);
}

/**
 * Deep copy into a structured-clone-safe value: drops functions and WASM handles (objects
 * with a delete() method), copies typed arrays that are views into a larger buffer (e.g.
 * the WASM heap) so they can be transferred without detaching anything else.
 */
export function toCloneable(v, depth = 0) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') return v;
  if (t === 'bigint') return Number(v);
  if (t === 'function' || t === 'symbol') return undefined;
  if (depth > 12) return undefined;
  if (ArrayBuffer.isView(v)) {
    if (v instanceof DataView) return undefined;
    const whole = v.byteOffset === 0 && v.buffer.byteLength === v.byteLength && !(typeof SharedArrayBuffer !== 'undefined' && v.buffer instanceof SharedArrayBuffer);
    return whole ? v : v.slice();
  }
  if (v instanceof ArrayBuffer) return v;
  if (Array.isArray(v)) return v.map((x) => toCloneable(x, depth + 1));
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), toCloneable(x, depth + 1)]));
  if (v instanceof Error) return { message: v.message };
  if (t === 'object') {
    if (typeof v.delete === 'function' && typeof v.isEmpty === 'function') return undefined; // WASM object
    const o = {};
    for (const k of Object.keys(v)) {
      const x = toCloneable(v[k], depth + 1);
      if (x !== undefined) o[k] = x;
    }
    return o;
  }
  return undefined;
}

/** All distinct ArrayBuffers reachable through typed arrays (transfer list). */
export function collectTransfers(v, out = new Set(), depth = 0) {
  if (!v || typeof v !== 'object' || depth > 12) return [...out];
  if (ArrayBuffer.isView(v)) {
    if (v.buffer instanceof ArrayBuffer) out.add(v.buffer);
    return [...out];
  }
  for (const k of Object.keys(v)) collectTransfers(v[k], out, depth + 1);
  return [...out];
}

function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

// ---------------------------------------------------------------------------------------
// Engine (main thread)
// ---------------------------------------------------------------------------------------

export class Engine {
  /**
   * @param {{preferWorker?: boolean, manifoldUrl?: string, initTimeoutMs?: number, onModeChange?: Function}} opts
   */
  constructor(opts = {}) {
    this.preferWorker = opts.preferWorker !== false;
    this.manifoldUrl = opts.manifoldUrl || MANIFOLD_URL;
    this.initTimeoutMs = opts.initTimeoutMs || 120000;
    this.onModeChange = opts.onModeChange || (() => {});
    this.mode = null; // 'worker' | 'main'
    this.worker = null;
    this._workerReady = null;
    this._mainCore = null;
    this._job = null; // { id, resolve, reject, onProgress }
    this._seq = 0;
    this.lastInitError = null;
  }

  get busy() { return !!this._ticket; }

  /** Ensure a backend is ready; returns 'worker' or 'main'. */
  async ready() {
    if (this.preferWorker && this.mode !== 'main') {
      try {
        await this._ensureWorker();
        this._setMode('worker');
        return 'worker';
      } catch (e) {
        this.lastInitError = errInfo(e);
        console.warn('[engine] worker unavailable, falling back to main thread:', this.lastInitError);
        this._killWorker();
        this.preferWorker = false;
      }
    }
    await this._ensureMain();
    this._setMode('main');
    return 'main';
  }

  _setMode(m) {
    if (this.mode !== m) { this.mode = m; try { this.onModeChange(m); } catch { /* ignore */ } }
  }

  _ensureWorker() {
    if (this._workerReady) return this._workerReady;
    this._workerReady = new Promise((resolve, reject) => {
      let w;
      try {
        const url = new URL('./worker.js', import.meta.url);
        if (typeof location !== 'undefined' && location.search) url.search = location.search;
        w = new Worker(url, { type: 'module', name: 'meltemi-geometry' });
      } catch (e) {
        reject(e);
        return;
      }
      this.worker = w;
      const timer = setTimeout(() => reject(new Error('worker init timeout')), this.initTimeoutMs);
      const onInitMsg = (ev) => {
        const m = ev.data || {};
        if (m.type === 'ready') {
          clearTimeout(timer);
          w.removeEventListener('message', onInitMsg);
          this.coreErrors = m.errors || {};
          w.addEventListener('message', (e2) => this._onWorkerMessage(e2.data));
          resolve(w);
        } else if (m.type === 'init-error') {
          clearTimeout(timer);
          reject(new Error(m.message || 'worker init failed'));
        }
      };
      w.addEventListener('message', onInitMsg);
      w.addEventListener('error', (ev) => {
        // Before ready: init failure (e.g. module script failed to load). After: job crash.
        const msg = (ev && ev.message) || 'worker script error';
        if (this._job) {
          const j = this._job; this._job = null;
          j.reject(new Error(`Geometry worker crashed: ${msg}`));
          this._killWorker();
        } else {
          clearTimeout(timer);
          reject(new Error(msg));
        }
      });
      w.postMessage({ type: 'init', manifoldUrl: this.manifoldUrl });
    });
    // A failed init must not be cached forever (cancel() also resets it).
    this._workerReady.catch(() => { this._workerReady = null; });
    return this._workerReady;
  }

  _onWorkerMessage(m) {
    const j = this._job;
    if (!j || m.id !== j.id) return;
    if (m.type === 'progress') j.onProgress(m.step, m.frac);
    else if (m.type === 'result') { this._job = null; j.resolve(m.result); }
    else if (m.type === 'error') {
      this._job = null;
      const e = new Error(m.message || 'Job failed');
      if (m.stack) e.workerStack = m.stack;
      j.reject(e);
    }
  }

  async _ensureMain() {
    if (!this._mainCore) {
      this._mainCore = loadCore(this.manifoldUrl);
      this._mainCore.catch(() => { this._mainCore = null; });
    }
    return this._mainCore;
  }

  _killWorker() {
    if (this.worker) { try { this.worker.terminate(); } catch { /* ignore */ } }
    this.worker = null;
    this._workerReady = null;
  }

  /**
   * Run a job. Typed arrays inside `job` are transferred to the worker (callers must pass
   * copies they no longer need). Resolves with the job result; rejects with CancelledError
   * immediately when cancel() is called.
   */
  async run(job, onProgress = () => {}) {
    if (this._ticket) throw new Error('Engine busy');
    const ticket = { id: ++this._seq, cancelled: false };
    let cancelReject;
    const cancelled = new Promise((_, rej) => { cancelReject = rej; });
    cancelled.catch(() => {});
    ticket.cancel = () => { ticket.cancelled = true; cancelReject(new CancelledError()); };
    this._ticket = ticket;
    try {
      return await Promise.race([this._run(job, onProgress, ticket), cancelled]);
    } finally {
      if (this._ticket === ticket) this._ticket = null;
    }
  }

  async _run(job, onProgress, ticket) {
    const progress = (s, f) => { if (!ticket.cancelled) onProgress(s, f); };
    progress('Loading geometry engine', 0);
    const mode = await this.ready();
    if (ticket.cancelled) throw new CancelledError();
    const id = ticket.id;
    if (mode === 'worker') {
      return new Promise((resolve, reject) => {
        this._job = { id, resolve, reject, onProgress: progress };
        try {
          this.worker.postMessage({ type: 'job', id, job }, collectTransfers(job));
        } catch (e) {
          this._job = null;
          reject(e);
        }
      });
    }
    // Main thread: same code path (UI may freeze during synchronous WASM steps).
    const core = await this._ensureMain();
    if (ticket.cancelled) throw new CancelledError();
    const res = await runJob(core, job, progress);
    if (ticket.cancelled) throw new CancelledError();
    return res;
  }

  /** Cancel the running job (terminates the worker; it is re-created on the next job). */
  cancel() {
    const t = this._ticket;
    this._ticket = null;
    this._job = null;
    if (this.worker) this._killWorker();
    if (t) t.cancel();
  }
}
