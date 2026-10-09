#!/usr/bin/env node
// Zero-dependency static file server for the repo root (the web app needs http:// for ES
// modules + WASM). Usage: node cli/serve.mjs   (PORT=8080 HOST=127.0.0.1 by default)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '127.0.0.1';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.3mf': 'model/3mf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.woff2': 'font/woff2',
};

/** Resolve a URL path inside ROOT; returns null on traversal attempts. */
export function resolveInside(root, urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + p.replace(/\\/g, '/')));
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function send(res, code, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

export function createServer(root = ROOT) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let file = resolveInside(root, req.url || '/');
    if (!file) return send(res, 403, 'Forbidden');
    let st;
    try {
      st = fs.statSync(file);
      if (st.isDirectory()) {
        if (!req.url.split('?')[0].endsWith('/')) {
          res.writeHead(301, { Location: req.url.split('?')[0] + '/', 'Cache-Control': 'no-store' });
          return res.end();
        }
        file = path.join(file, 'index.html');
        st = fs.statSync(file);
      }
    } catch {
      return send(res, 404, `Not found: ${req.url}`);
    }
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = createServer(ROOT);
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is in use — try PORT=8081 npm run serve` : e.message);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const host = HOST === '0.0.0.0' ? 'localhost' : HOST;
    const page = ['index.html', 'src/ui/index.html'].find((f) => fs.existsSync(path.join(ROOT, f))) || '';
    const url = `http://${host}:${PORT}/${page === 'index.html' ? '' : page}`;
    console.log(`Meltemi Mold Studio — serving ${ROOT}`);
    console.log(`  open  ${url}   (Ctrl+C to stop)`);
  });
}
