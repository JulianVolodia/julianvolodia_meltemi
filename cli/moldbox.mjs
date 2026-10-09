#!/usr/bin/env node
// Meltemi Mold Studio — command-line generator.
//
//   node cli/moldbox.mjs master.stl [more.stl ...] [options]
//   node cli/moldbox.mjs --demo candles --out out/candles
//
// Writes every printable part as a binary STL in its print orientation (NN_<id>[_xQTY].stl),
// non-printable previews (silicone, cast, masters) in preview/ (mold frame), report.json and
// README.txt with the step-by-step instructions. Exit code 1 on error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const core = (rel) => pathToFileURL(path.join(ROOT, 'src', rel)).href;

export const HELP = `Meltemi Mold Studio CLI — mold-box infrastructure & supports from 3D models

Usage:
  node cli/moldbox.mjs [input.stl ...] [options]

Inputs:
  input.stl ...              one or more masters (binary or ASCII STL, millimetres).
                             All inputs are molded together in one box.
  --demo NAME                use a built-in model instead: candles | cylinder | cone | h | box

Options:
  --out DIR                  output folder (default: out/run)
  --mode moldbox|support     moldbox: mold box from a master (positive)            [moldbox]
                             support: mother mold / cage for an existing silicone form
  --quality draft|normal|fine  voxel budget for the offset surfaces             [normal]
  --set key=value            override any parameter (repeatable), e.g.
                             --set siliconeThickness=6 --set wick=true --set boardStyle=single
  --auto-orient              rotate the masters to a good pour / parting orientation first
  --list-params              print every parameter with its default and exit
  --quiet                    only print errors and the output folder
  -h, --help                 show this help

Frame: Z up = pour direction (opening at the top). Parting plane y = y0 (bbox centre +
partingOffset); half A on y < y0, half B on y > y0. Masters are used in their file coordinates
unless --auto-orient is given.

Examples:
  npm run cli -- --demo candles --set wick=true --out out/candles
  node cli/moldbox.mjs vase.stl --auto-orient --quality draft
  node cli/moldbox.mjs form.stl --mode support --set cage=true --out out/support
`;

const DEMOS = ['candles', 'cylinder', 'cone', 'h', 'box'];

/** Parse a --set value: numbers, booleans, null, otherwise a string. */
export function coerceValue(v) {
  if (v === undefined) return true;
  const s = String(v).trim();
  if (/^(true|yes|on)$/i.test(s)) return true;
  if (/^(false|no|off)$/i.test(s)) return false;
  if (/^null$/i.test(s)) return null;
  if (s !== '' && /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number(s);
  return s;
}

/**
 * Parse argv (without node + script). Throws on malformed input.
 * @returns {{inputs: string[], demo: string|null, out: string, params: object, autoOrient: boolean,
 *            help: boolean, listParams: boolean, quiet: boolean}}
 */
export function parseArgs(argv) {
  const o = { inputs: [], demo: null, out: 'out/run', params: {}, autoOrient: false, help: false, listParams: false, quiet: false };
  const takesValue = new Set(['--out', '--mode', '--quality', '--set', '--demo', '-o']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let val;
    if (a.startsWith('--') && a.includes('=')) {
      val = a.slice(a.indexOf('=') + 1);
      a = a.slice(0, a.indexOf('='));
    }
    const next = () => {
      if (val !== undefined) return val;
      const v = argv[++i];
      if (v === undefined || (v.startsWith('--') && v.length > 2)) throw new Error(`${a} expects a value`);
      return v;
    };
    if (!a.startsWith('-') || a === '-') {
      o.inputs.push(a);
      continue;
    }
    if (!takesValue.has(a) && val !== undefined && !['--auto-orient'].includes(a)) throw new Error(`${a} does not take a value`);
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--list-params': o.listParams = true; break;
      case '--quiet': case '-q': o.quiet = true; break;
      case '--auto-orient': o.autoOrient = val === undefined ? true : coerceValue(val) !== false; break;
      case '--out': case '-o': o.out = next(); break;
      case '--demo': {
        const d = next().toLowerCase();
        if (!DEMOS.includes(d)) throw new Error(`unknown demo "${d}" (choose ${DEMOS.join(', ')})`);
        o.demo = d;
        break;
      }
      case '--mode': {
        const m = next();
        if (!['moldbox', 'support'].includes(m)) throw new Error(`--mode must be moldbox or support, got "${m}"`);
        o.params.mode = m;
        break;
      }
      case '--quality': {
        const q = next();
        if (!['draft', 'normal', 'fine'].includes(q)) throw new Error(`--quality must be draft, normal or fine, got "${q}"`);
        o.params.quality = q;
        break;
      }
      case '--set': {
        const kv = next();
        const eq = kv.indexOf('=');
        if (eq <= 0) throw new Error(`--set expects key=value, got "${kv}"`);
        o.params[kv.slice(0, eq).trim()] = coerceValue(kv.slice(eq + 1));
        break;
      }
      default:
        throw new Error(`unknown option ${a} (see --help)`);
    }
  }
  if (!o.help && !o.listParams) {
    if (o.demo && o.inputs.length) throw new Error('give either input STL files or --demo, not both');
    if (!o.demo && !o.inputs.length) throw new Error('no input: give one or more STL files or --demo candles (see --help)');
  }
  return o;
}

/** Built-in demo masters (MeshData[] in the mold frame). */
export async function demoMasters(name) {
  const S = await import(core('demo/shapes.js'));
  switch (name) {
    case 'candles': {
      const C = await import(core('demo/candles.js'));
      return C.demoCandles();
    }
    case 'cylinder': return [S.makeCylinder({ r: 15, h: 40 })];
    case 'cone': return [S.makeCone({ r1: 18, r2: 6, h: 45 })];
    case 'h': return [S.makeHShape()];
    case 'box': return [S.makeBox({ size: [30, 20, 25] })];
    default: throw new Error(`unknown demo ${name}`);
  }
}

/** Part file name: NN_<id>[_xQTY].stl */
export function partFileName(index, part) {
  const id = String(part.id || part.name || 'part').replace(/[^A-Za-z0-9_-]+/g, '_');
  const q = part.quantity > 1 ? `_x${part.quantity}` : '';
  return `${String(index).padStart(2, '0')}_${id}${q}.stl`;
}

const fmt = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

function makeProgress(quiet) {
  const t0 = performance.now();
  const tty = process.stdout.isTTY && !quiet;
  let last = '';
  let lastPrint = 0;
  const fn = (label, fraction) => {
    if (quiet) return;
    const el = (performance.now() - t0) / 1000;
    const pct = Number.isFinite(fraction) ? `${String(Math.round(fraction * 100)).padStart(3)}%` : '    ';
    const line = `  ${el.toFixed(1).padStart(6)}s  ${pct}  ${label}`;
    if (tty) {
      if (label !== last && last) process.stdout.write('\n');
      process.stdout.write(`\r${line}\x1b[K`);
    } else if (label !== last || el - lastPrint > 5) {
      console.log(line);
      lastPrint = el;
    }
    last = label;
  };
  fn.done = () => { if (tty && last) process.stdout.write('\n'); };
  fn.elapsed = () => (performance.now() - t0) / 1000;
  return fn;
}

async function importOrExplain(rel, what) {
  const file = path.join(ROOT, 'src', rel);
  if (!fs.existsSync(file)) throw new Error(`${path.relative(ROOT, file)} is missing — ${what}`);
  return import(pathToFileURL(file).href);
}

async function readInput(file, meshio) {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  let res;
  try {
    res = meshio.parseSTL(ab);
  } catch (e) {
    res = meshio.parseSTL(new Uint8Array(ab)); // tolerate either signature
  }
  const mesh = res && res.positions ? res : res && res.mesh;
  if (!mesh || !mesh.positions || !mesh.indices || mesh.indices.length < 12) throw new Error(`${file}: no triangles found`);
  return mesh;
}

/** Run the CLI. Returns the output directory. */
export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP);
    return null;
  }
  const P = await importOrExplain('core/params.js', 'reinstall the repository');
  if (opts.listParams) {
    for (const g of P.PARAM_SCHEMA) {
      console.log(`\n${g.group}`);
      for (const it of g.items) {
        const def = JSON.stringify(P.DEFAULTS[it.key]);
        const opt = it.options ? `  {${Object.keys(it.options).join('|')}}` : '';
        console.log(`  ${it.key.padEnd(20)} ${String(def).padEnd(10)} ${it.unit ? `[${it.unit}] ` : ''}${it.label}${opt}`);
      }
    }
    return null;
  }
  const log = (...a) => { if (!opts.quiet) console.log(...a); };
  for (const k of Object.keys(opts.params))
    if (!(k in P.DEFAULTS)) console.warn(`warning: unknown parameter "${k}" (passed through; see --list-params)`);

  // ---- WASM + core ----------------------------------------------------------------------------
  let Module;
  try {
    Module = (await import('manifold-3d')).default;
  } catch (e) {
    throw new Error(`cannot load manifold-3d (${e.message}) — run "npm install" in ${ROOT}`);
  }
  const { initManifold } = await import(core('core/wasm.js'));
  const wasm = await initManifold(Module);
  const meshio = await importOrExplain('core/meshio.js', 'the mesh I/O module has not been built yet');
  // MELTEMI_PIPELINE=/path/to/module.js swaps in another pipeline implementation (testing).
  const pipeline = process.env.MELTEMI_PIPELINE
    ? await import(pathToFileURL(path.resolve(process.env.MELTEMI_PIPELINE)).href)
    : await importOrExplain('core/pipeline.js', 'the geometry pipeline has not been built yet (src/core/pipeline.js)');

  // ---- masters --------------------------------------------------------------------------------
  let masters;
  let inputNames;
  if (opts.demo) {
    masters = await demoMasters(opts.demo);
    inputNames = [`demo:${opts.demo}`];
    if (opts.demo === 'candles' && opts.params.wick === undefined) opts.params.wick = true;
  } else {
    masters = [];
    for (const f of opts.inputs) {
      if (!fs.existsSync(f)) throw new Error(`input not found: ${f}`);
      masters.push(await readInput(f, meshio));
    }
    inputNames = opts.inputs.map((f) => path.basename(f));
  }
  const nTri = masters.reduce((s, m) => s + m.indices.length / 3, 0);
  log(`Meltemi Mold Studio — ${opts.params.mode || 'moldbox'} for ${inputNames.join(', ')} (${masters.length} mesh, ${nTri} triangles)`);

  if (opts.autoOrient) {
    const analysis = await importOrExplain('core/analysis.js', 'the analysis module has not been built yet');
    const parts = masters.map((m) => meshio.manifoldFromMesh(m).manifold);
    const union = parts.length === 1 ? parts[0] : wasm.Manifold.union(parts);
    const { matrix, info } = analysis.autoOrient(union);
    masters = masters.map((m) => meshio.transformMesh(m, matrix));
    log(`  auto-orient: long axis ${info.longAxis.map((x) => fmt(x, 2)).join(',')} -> Z, pour end ${info.pourEnd}, parting rotation ${info.partingAngleDeg}°`);
  }

  // ---- generate -------------------------------------------------------------------------------
  const progress = makeProgress(opts.quiet);
  const params = { ...opts.params };
  let gen = pipeline.generate;
  if (typeof gen !== 'function') {
    gen = params.mode === 'support' ? pipeline.generateSupport || pipeline.generateMoldBox : pipeline.generateMoldBox;
    if (params.mode === 'support' && pipeline.generateSupport) {
      const f = gen;
      gen = (m, p, cb) => f(m.length === 1 ? m[0] : m, p, cb);
    }
  }
  if (typeof gen !== 'function') throw new Error('src/core/pipeline.js exports neither generate() nor generateMoldBox()');
  let result;
  try {
    result = await gen(masters, params, progress);
  } finally {
    progress.done();
  }
  const total = progress.elapsed();
  if (!result || !Array.isArray(result.parts)) throw new Error('pipeline returned no parts');

  // ---- write ----------------------------------------------------------------------------------
  const outDir = path.resolve(opts.out);
  const prevDir = path.join(outDir, 'preview');
  fs.mkdirSync(prevDir, { recursive: true });
  for (const dir of [outDir, prevDir]) // remove our own stale outputs from an earlier run
    for (const f of fs.readdirSync(dir)) if (/^\d\d_.*\.stl$/i.test(f)) fs.rmSync(path.join(dir, f));

  const written = [];
  let iPrint = 0, iPrev = 0;
  for (const part of result.parts) {
    if (!part || !part.mesh || !part.mesh.indices || part.mesh.indices.length === 0) continue;
    const printable = part.printable !== false && !['silicone', 'cast', 'master'].includes(part.role);
    let file, mesh;
    if (printable) {
      file = partFileName(++iPrint, part);
      mesh = part.printMatrix ? meshio.transformMesh(part.mesh, part.printMatrix) : part.mesh;
    } else {
      file = path.join('preview', partFileName(++iPrev, part));
      mesh = part.mesh;
    }
    fs.writeFileSync(path.join(outDir, file), meshio.writeSTL(mesh, `${part.name || part.id}`));
    written.push({
      file, id: part.id, name: part.name, role: part.role, printable, quantity: part.quantity || 1,
      triangles: mesh.indices.length / 3, volume: part.volume, mass: part.mass,
    });
  }
  if (!result.parts.some((p) => p && p.role === 'master')) {
    const S = await import(core('demo/shapes.js'));
    const file = path.join('preview', '00_masters.stl');
    fs.writeFileSync(path.join(outDir, file), meshio.writeSTL(S.mergeMeshes(masters), 'masters'));
    written.push({ file, id: 'masters', name: 'Masters (input, mold frame)', role: 'master', printable: false, quantity: 1, triangles: nTri });
  }

  const resolved = P.resolveParams(params);
  delete resolved.q;
  const stats = result.stats || {};
  const report = {
    generator: 'Meltemi Mold Studio CLI',
    version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version,
    date: new Date().toISOString(),
    inputs: inputNames,
    autoOrient: opts.autoOrient,
    elapsedSeconds: +total.toFixed(2),
    params: resolved,
    stats,
    timings: stats.timings || null,
    frame: result.frame || null,
    warnings: result.warnings || [],
    parts: written,
    instructions: result.instructions || [],
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : v), 2));
  fs.writeFileSync(path.join(outDir, 'README.txt'), readmeText(report));

  // ---- summary --------------------------------------------------------------------------------
  log(`\nDone in ${fmt(total)} s -> ${outDir}`);
  if (!opts.quiet) {
    console.log('  file                                   qty   mass g   triangles');
    for (const w of written)
      console.log(`  ${w.file.padEnd(38)} ${String(w.quantity).padStart(3)}  ${fmt(w.mass).padStart(7)}  ${String(w.triangles).padStart(10)}`);
    if (stats.moldMass !== undefined) console.log(`  mold ${fmt(stats.moldMass, 0)} g (A ${fmt(stats.moldMassA, 0)} g, B ${fmt(stats.moldMassB, 0)} g)`);
    if (stats.siliconeMass !== undefined) console.log(`  silicone ${fmt(stats.siliconeMass, 0)} g (A ${fmt(stats.siliconeMassA, 0)} g + B ${fmt(stats.siliconeMassB, 0)} g)`);
    if (stats.castMass !== undefined) console.log(`  casting ${fmt(stats.castMass, 0)} g`);
    for (const w of report.warnings) console.log(`  warning: ${w}`);
  } else {
    console.log(outDir);
  }
  return outDir;
}

export function readmeText(r) {
  const s = r.stats || {};
  const L = [];
  L.push('MELTEMI MOLD STUDIO — mold kit', '='.repeat(30), '');
  L.push(`Generated ${r.date} from ${r.inputs.join(', ')} (mode: ${r.params.mode}, quality: ${r.params.quality}).`, '');
  L.push('PRINT THESE (already in print orientation):');
  for (const p of r.parts.filter((x) => x.printable))
    L.push(`  ${p.file.padEnd(36)} x${p.quantity}  ${p.name || p.id}${Number.isFinite(p.mass) ? `  (~${p.mass.toFixed(0)} g)` : ''}`);
  L.push('', 'Previews (mold frame, not for printing): preview/*.stl', '');
  L.push('Suggested print settings: PLA or PETG, 0.2 mm layers, 4-6 perimeters, 15-25 % infill;');
  L.push('print shells upright (as exported) and clips/pins flat. Coat every surface that touches');
  L.push('silicone with a release agent (e.g. Ease Release 200, or a thin film of vaseline).', '');
  if (s.siliconeVolume !== undefined) {
    L.push('MATERIALS');
    L.push(`  Silicone: ${(s.siliconeVolume / 1000).toFixed(1)} cm3 = ${(s.siliconeMass || 0).toFixed(0)} g` +
      (s.siliconeMassA !== undefined ? ` -> part A ${s.siliconeMassA.toFixed(0)} g + part B ${s.siliconeMassB.toFixed(0)} g (ratio ${r.params.siliconeMixRatio})` : '') +
      '. Mix ~10 % extra.');
    if (s.castMass !== undefined) L.push(`  Casting (${r.params.castMaterial}): ${(s.castVolume / 1000).toFixed(1)} cm3 = ${s.castMass.toFixed(0)} g`);
    if (s.moldMass !== undefined) L.push(`  Printed mold: ${s.moldMass.toFixed(0)} g filament (A ${(s.moldMassA || 0).toFixed(0)} g, B ${(s.moldMassB || 0).toFixed(0)} g)`);
    L.push('');
  }
  if (r.instructions.length) {
    L.push('STEP BY STEP');
    r.instructions.forEach((t, i) => L.push(`  ${String(i + 1).padStart(2)}. ${t}`));
    L.push('');
  }
  if (r.warnings.length) {
    L.push('WARNINGS');
    for (const w of r.warnings) L.push(`  - ${w}`);
    L.push('');
  }
  L.push('Full parameters, statistics and timings: report.json');
  L.push('Workflow guide: docs/WORKFLOW.md in the Meltemi Mold Studio repository.');
  return L.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`\nerror: ${e && e.message ? e.message : e}`);
    if (process.env.DEBUG && e && e.stack) console.error(e.stack);
    process.exit(1);
  });
}
