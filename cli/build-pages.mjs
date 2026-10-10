#!/usr/bin/env node
// Stage the static web app for GitHub Pages (or any static host) into a folder.
// The app has no build step: we copy index.html, the ES modules under src/ and the
// README images. On any host other than localhost the page loads three.js, fflate and
// manifold-3d from jsDelivr (see src/ui/config.js), so node_modules is not needed.
//
//   node cli/build-pages.mjs [outDir=_site]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(root, process.argv[2] || '_site');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(path.join(root, 'index.html'), path.join(out, 'index.html'));
fs.cpSync(path.join(root, 'src'), path.join(out, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'docs', 'img'), path.join(out, 'docs', 'img'), { recursive: true });
fs.writeFileSync(path.join(out, '.nojekyll'), ''); // serve files as-is, no Jekyll processing

let files = 0, bytes = 0;
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else { files++; bytes += fs.statSync(p).size; }
  }
})(out);
console.log(`staged ${files} files (${(bytes / 1024).toFixed(0)} KiB) -> ${path.relative(root, out) || out}`);
