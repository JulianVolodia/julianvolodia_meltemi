// Shared test bootstrap: load manifold-3d WASM once and inject it into the core.
import Module from 'manifold-3d';
import { initManifold, mf } from '../src/core/wasm.js';

let ready = null;
export async function setup() {
  if (!ready) ready = initManifold(Module);
  await ready;
  return mf();
}

export function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}
