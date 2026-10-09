// Runtime configuration shared by the page and the geometry worker.
// No bare imports here: this module is also loaded inside a module Web Worker,
// where the page's import map does not apply.
//
// Local development (served from the repo root on localhost) loads three.js,
// fflate and manifold-3d from /node_modules; any other host (e.g. GitHub Pages)
// or ?cdn loads pinned versions from jsDelivr. ?local forces node_modules.

const loc = (typeof self !== 'undefined' && self.location) ? self.location : { hostname: '', search: '' };
const search = String(loc.search || '');
const host = String(loc.hostname || '');

export const VERSIONS = { three: '0.186.0', fflate: '0.8.2', manifold: '3.5.3' };

export const IS_LOCAL = /[?&]local\b/.test(search)
  || (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) && !/[?&]cdn\b/.test(search));

export const MANIFOLD_URL = IS_LOCAL
  ? '/node_modules/manifold-3d/manifold.js'
  : `https://cdn.jsdelivr.net/npm/manifold-3d@${VERSIONS.manifold}/manifold.js`;

export const APP_NAME = 'Meltemi Mold Studio';
export const STORAGE_KEY = 'meltemi.params.v1';
export const UI_STORAGE_KEY = 'meltemi.ui.v1';
