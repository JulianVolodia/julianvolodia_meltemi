// Manifold WASM module injection. Core modules never import 'manifold-3d' directly so
// the same code runs in Node (tests/CLI), a Web Worker and the browser main thread.
let _wasm = null;

export function setManifoldModule(wasm) {
  _wasm = wasm;
}

/** @returns {{Manifold: any, CrossSection: any, Mesh: any}} */
export function mf() {
  if (!_wasm) throw new Error('Manifold module not initialised: call setManifoldModule() first');
  return _wasm;
}

/** Node / bundler helper: dynamically import a manifold-3d module factory and initialise it. */
export async function initManifold(factory) {
  const wasm = await factory();
  wasm.setup();
  setManifoldModule(wasm);
  return wasm;
}
