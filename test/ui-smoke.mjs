#!/usr/bin/env node
// UI smoke test: serve the repo, open the app in headless Chromium (playwright-core), load the
// demo, generate a draft mold box, switch stages, export, check a phone layout, and fail on
// uncaught page errors. Screenshots go to out/ui-*.png.
//
//   npm run test:ui            (CHROME_PATH=/path/to/chrome to override the browser)
//   UI_SMOKE_SKIP_GENERATE=1   only test load / panel / demo
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'out');
const PORT = Number(process.env.UI_PORT) || 8765;
const BASE = `http://localhost:${PORT}/`;
const GEN_TIMEOUT = Number(process.env.UI_GEN_TIMEOUT) || 180000;
fs.mkdirSync(OUT, { recursive: true });

const exists = (p) => fs.existsSync(path.join(ROOT, p));
const HAS_PIPELINE = exists('src/core/pipeline.js');
const HAS_DEMO = exists('src/demo/candles.js');

const log = (...a) => console.log('[ui-smoke]', ...a);
const failures = [];
const notes = [];

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const base = '/opt/pw-browsers';
  if (fs.existsSync(base)) {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(base, d, rel);
        if (fs.existsSync(p)) return p;
      }
    }
    const hs = fs.readdirSync(base).filter((d) => d.startsWith('chromium_headless_shell-'));
    for (const d of hs) {
      const p = path.join(base, d, 'chrome-linux', 'headless_shell');
      if (fs.existsSync(p)) return p;
    }
  }
  return undefined; // let playwright try its default
}

// ---------------------------------------------------------------------------- server
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.stl': 'model/stl', '.md': 'text/markdown; charset=utf-8',
};
function inlineServer() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    let f = path.join(ROOT, path.normalize(u).replace(/^([.][.][/\\])+/, ''));
    if (!f.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    try { if (fs.statSync(f).isDirectory()) f = path.join(f, 'index.html'); } catch { /* 404 below */ }
    fs.readFile(f, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve({ stop: () => srv.close() })));
}

async function waitForServer(ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const ok = await new Promise((r) => {
      const req = http.get(`http://127.0.0.1:${PORT}/index.html`, (res) => { res.resume(); r(res.statusCode === 200); });
      req.on('error', () => r(false));
      req.setTimeout(1000, () => { req.destroy(); r(false); });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

async function startServer() {
  if (await waitForServer(300)) { log(`reusing server already on :${PORT}`); return { stop() {} }; }
  if (exists('cli/serve.mjs')) {
    const child = spawn(process.execPath, ['cli/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));
    if (await waitForServer(10000)) return { stop: () => child.kill() };
    child.kill();
    log('cli/serve.mjs did not come up, using inline server');
  }
  const s = await inlineServer();
  if (!(await waitForServer(5000))) throw new Error('static server failed to start');
  return s;
}

// ---------------------------------------------------------------------------- test
async function main() {
  const { chromium } = await import('playwright-core');
  const server = await startServer();
  const executablePath = findChrome();
  log('chromium:', executablePath || '(playwright default)');
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  let page;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, acceptDownloads: true });
    page = await ctx.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text());
      if (process.env.UI_SMOKE_VERBOSE) log(`console.${m.type()}:`, m.text());
    });
    page.on('pageerror', (e) => pageErrors.push(String(e && (e.stack || e.message) || e)));
    page.on('worker', (w) => log('worker started:', w.url().replace(BASE, '/')));

    log('open', BASE);
    await page.goto(BASE, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ready === '1' || !document.getElementById('gl-error').hidden, null, { timeout: 30000 });
    const glErr = await page.$eval('#gl-error', (e) => (e.hidden ? '' : e.textContent));
    if (glErr) failures.push(`viewer did not start: ${glErr}`);
    const groups = await page.$$eval('.param-group', (els) => els.length);
    const inputs = await page.$$eval('#params [data-param]', (els) => els.length);
    log(`panel: ${groups} groups, ${inputs} controls`);
    if (groups < 5 || inputs < 20) failures.push(`parameter panel incomplete (${groups} groups, ${inputs} controls)`);
    await page.screenshot({ path: path.join(OUT, 'ui-empty.png') });

    // How-it-works dialog
    await page.click('#btn-how');
    await page.waitForSelector('#dlg-how[open]', { timeout: 3000 });
    await page.screenshot({ path: path.join(OUT, 'ui-how.png') });
    await page.keyboard.press('Escape');

    // quality -> draft through the UI
    await page.click('[data-param="quality"] [data-value="draft"]');
    const q = await page.evaluate(() => window.__meltemi.panel.get().quality);
    if (q !== 'draft') failures.push(`quality switch failed (${q})`);

    if (HAS_DEMO) {
      await page.click('#btn-demo');
      await page.waitForFunction(() => document.querySelectorAll('#master-list .master-row').length >= 1, null, { timeout: 20000 });
      const n = await page.$$eval('#master-list .master-row', (els) => els.length);
      log(`demo loaded: ${n} masters`);
      if (n !== 3) failures.push(`expected 3 demo masters, got ${n}`);
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, 'ui-demo.png') });
      // select a master to show the gizmo + selection bar
      await page.click('#master-list .master-row:nth-child(2)');
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, 'ui-demo-selected.png') });
      await page.keyboard.press('Escape');
    } else {
      notes.push('src/demo/candles.js missing: demo not tested');
    }

    let generated = false;
    if (HAS_DEMO && !process.env.UI_SMOKE_SKIP_GENERATE) {
      log('generate (draft)…');
      const t0 = Date.now();
      await page.click('#btn-generate');
      await page.waitForFunction(() => ['done', 'error', 'cancelled'].includes(document.body.dataset.genState), null, { timeout: GEN_TIMEOUT, polling: 500 })
        .catch(() => failures.push(`generation did not finish within ${GEN_TIMEOUT / 1000} s`));
      const st = await page.evaluate(() => ({ state: document.body.dataset.genState, err: document.body.dataset.genError || '' }));
      log(`generation: ${st.state} in ${((Date.now() - t0) / 1000).toFixed(1)} s ${st.err}`);
      await page.screenshot({ path: path.join(OUT, 'ui-generated.png') });
      if (st.state === 'done') {
        generated = true;
        const stats = await page.$eval('#stats', (e) => e.textContent.replace(/\s+/g, ' ').trim());
        log('stats bar:', stats);
        if (!/Mold/.test(stats) && !/Casting/.test(stats)) failures.push(`stats bar missing values: ${stats}`);
        const parts = await page.evaluate(() => window.__meltemi.state.result.parts.map((p) => `${p.id}(${p.role}${p.quantity > 1 ? ' x' + p.quantity : ''})`).join(', '));
        log('parts:', parts);
        for (const [stage, file] of [['silicone', 'ui-stage-silicone.png'], ['cast', 'ui-stage-cast.png'], ['print', 'ui-stage-print.png']]) {
          const enabled = await page.$eval(`#stage-seg [data-stage="${stage}"]`, (b) => !b.disabled);
          if (!enabled) { notes.push(`stage ${stage} has no content`); continue; }
          await page.click(`#stage-seg [data-stage="${stage}"]`);
          await page.evaluate(() => window.__meltemi.viewer.fit(null, { animate: false }));
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(OUT, file) });
        }
        // exploded + section
        const sil = await page.$eval('#stage-seg [data-stage="silicone"]', (b) => !b.disabled);
        if (sil) {
          await page.click('#stage-seg [data-stage="silicone"]');
          await page.$eval('#explode', (e) => { e.value = '0.7'; e.dispatchEvent(new Event('input', { bubbles: true })); });
          await page.evaluate(() => window.__meltemi.viewer.fit(null, { animate: false }));
          await page.waitForTimeout(400);
          await page.screenshot({ path: path.join(OUT, 'ui-explode.png') });
          await page.$eval('#explode', (e) => { e.value = '0'; e.dispatchEvent(new Event('input', { bubbles: true })); });
          await page.click('#btn-section');
          await page.evaluate(() => { const v = window.__meltemi.viewer; v.view('x'); });
          await page.waitForTimeout(600);
          await page.screenshot({ path: path.join(OUT, 'ui-section.png') });
          await page.click('#btn-section');
        }
        // result tab
        await page.click('#tab-result');
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(OUT, 'ui-result-tab.png') });
        const notesUI = await page.evaluate(() => ({
          warnings: document.querySelectorAll('#warnings .warn-item').length,
          steps: document.querySelectorAll('#instructions li:not(.muted)').length,
        }));
        log(`result tab: ${notesUI.warnings} warnings, ${notesUI.steps} instruction steps`);
        if (!notesUI.steps) failures.push('no assembly instructions rendered');
        await page.evaluate(() => { const el = document.querySelector('#instructions'); if (el) el.scrollIntoView({ block: 'center' }); });
        await page.waitForTimeout(150);
        await page.screenshot({ path: path.join(OUT, 'ui-result-notes.png') });
        // export zip
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#btn-export')]);
        const zipPath = path.join(OUT, 'ui-export.zip');
        await dl.saveAs(zipPath);
        const { unzipSync } = await import('fflate');
        const files = Object.keys(unzipSync(new Uint8Array(fs.readFileSync(zipPath))));
        log(`export: ${dl.suggestedFilename()} -> ${files.length} files: ${files.join(', ')}`);
        if (!files.includes('README.txt') || !files.some((f) => f.endsWith('.stl'))) failures.push('export zip missing README.txt or STLs');
      } else if (st.state === 'error') {
        if (HAS_PIPELINE) failures.push(`generation error: ${st.err}`);
        else notes.push(`pipeline missing (expected): ${st.err}`);
      }
    }

    // phone layout
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    const hscroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (hscroll) failures.push('horizontal scroll at phone width');
    await page.screenshot({ path: path.join(OUT, 'ui-mobile.png') });
    await page.click('#btn-panel');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'ui-mobile-panel.png') });
    await page.click('#btn-sheet-close');

    // errors
    const benign = (t) => (!HAS_PIPELINE && /pipeline/i.test(t)) || /favicon/i.test(t) || (!HAS_PIPELINE && /404|Failed to load resource/i.test(t));
    const realConsole = consoleErrors.filter((t) => !benign(t));
    const realPage = pageErrors.filter((t) => !benign(t));
    for (const e of realPage) failures.push(`page error: ${e}`);
    for (const e of realConsole) failures.push(`console error: ${e}`);
    log(`console errors: ${consoleErrors.length} (${realConsole.length} unexpected), page errors: ${pageErrors.length}`);
    log(`generated: ${generated}`);
  } finally {
    await browser.close();
    server.stop();
  }
  for (const n of notes) log('note:', n);
  if (failures.length) {
    for (const f of failures) console.error('[ui-smoke] FAIL:', f);
    process.exit(1);
  }
  log('OK — screenshots in out/ui-*.png');
}

main().catch((e) => {
  console.error('[ui-smoke] crashed:', e);
  process.exit(1);
});
