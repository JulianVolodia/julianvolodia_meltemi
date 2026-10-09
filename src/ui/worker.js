// Module Web Worker running the geometry core (manifold-3d WASM + src/core/pipeline.js).
// Protocol (main -> worker):  {type:'init', manifoldUrl}  |  {type:'job', id, job}
//           (worker -> main):  {type:'ready', errors} | {type:'init-error', message}
//                              {type:'progress', id, step, frac}
//                              {type:'result', id, result}  (typed arrays transferred)
//                              {type:'error', id, message, stack}
// Only relative imports: import maps do not apply inside workers.
import { loadCore, runJob, collectTransfers } from './engine.js';
import { MANIFOLD_URL } from './config.js';

let corePromise = null;

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  if (msg.type === 'init') {
    try {
      corePromise = loadCore(msg.manifoldUrl || MANIFOLD_URL);
      const core = await corePromise;
      self.postMessage({ type: 'ready', errors: core.errors, wasmMs: core.wasmMs });
    } catch (e) {
      corePromise = null;
      self.postMessage({ type: 'init-error', message: (e && e.message) || String(e) });
    }
    return;
  }
  if (msg.type === 'job') {
    const { id, job } = msg;
    try {
      if (!corePromise) corePromise = loadCore(MANIFOLD_URL);
      const core = await corePromise;
      const result = await runJob(core, job, (step, frac) => {
        self.postMessage({ type: 'progress', id, step, frac });
      });
      self.postMessage({ type: 'result', id, result }, collectTransfers(result));
    } catch (e) {
      self.postMessage({ type: 'error', id, message: (e && e.message) || String(e), stack: e && e.stack });
    }
  }
};
