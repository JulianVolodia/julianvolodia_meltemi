// Silicone envelope and shell halves (DESIGN.md §4 steps 3-4).
//
//   phiM    = signed distance to Msdf (masters ∪ pour extensions ∪ vents), exact near the surface
//   phiS    = phiM - d1                       silicone envelope {phiS < 0}
//   phiCavA = prefixMin_y(phiS)               straight pull of half A (-Y): envelope swept to +Y
//   phiCavB = suffixMin_y(phiS)               half B (+Y): envelope swept to -Y
//             (demold 'conformal': phiCavA = phiCavB = phiS)
//   phiOutX = phiCavX - w, plinth: suffixMin_z(phiOutX) (flat printable floor)
//
// Surfaces come from levelSetSolid (pure-JS marching tetrahedra, simplified); cavities are
// extracted at level +0.3h so that after simplification the silicone is never thinner than d1.
// The level-set bounds are clipped to the relevant half (+2h) and z-range (+-2h); all mating
// planes (parting plane, rim, floor) are exact trimByPlane cuts.
// Core module: manifold comes from wasm.js (no bare imports).
import { gridForBox, voxelizeManifold, signedDistance, sweepMin, levelSetSolid } from '../sdf.js';
import { trimSide, trimZ } from '../frame.js';

/** Silicone/cavity extraction level offset (fraction of h), see header. */
export const CAV_LEVEL = 0.3;

/**
 * Voxel grid for the shell fields: box [min, max] (+ margin >= d1 + extra + w + baseExtra + 4h)
 * with the voxel budget of the quality preset P.q.
 * @param {number[]} min bbox min of the SDF source
 * @param {number[]} max bbox max
 * @param {object} P resolved params
 * @param {{d1?: number, extra?: number}} [opts] d1 = envelope offset (default siliconeThickness),
 *   extra = additional outward room (e.g. the cage clearance)
 */
export function shellGrid(min, max, P, { d1 = P.siliconeThickness, extra = 0 } = {}) {
  const q = P.q || { maxVoxels: 4e6, minVoxel: 0.4 };
  const base = d1 + extra + P.wallThickness + (P.baseExtra || 0);
  let h = q.minVoxel;
  let grid = null;
  for (let it = 0; it < 6; it++) {
    grid = gridForBox(min, max, base + 4 * h + 0.5, q);
    if (base + 4 * grid.h + 0.5 <= base + 4 * h + 0.5 + 1e-9) break;
    h = grid.h * 1.02;
  }
  return grid;
}

/**
 * Distance fields of the cavities (silicone outer envelope incl. straight-pull sweep) and of
 * the outer shell surfaces.
 * @param {*} Msdf Manifold whose offset is the silicone envelope
 * @param {object} P resolved params
 * @param {number} y0 parting plane
 * @param {{grid?: object, d1?: number, zFloor?: number, extra?: number}} [opts]
 * @returns {{grid, phiCavA: Float32Array, phiCavB: Float32Array, phiOutA: Float32Array, phiOutB: Float32Array, d1: number}}
 */
export function buildShellFields(Msdf, P, y0, opts = {}) {
  const d1 = opts.d1 ?? P.siliconeThickness;
  const w = P.wallThickness;
  let grid = opts.grid;
  if (!grid) {
    const bb = Msdf.boundingBox();
    grid = shellGrid([...bb.min], [...bb.max], P, { d1, extra: opts.extra || 0 });
  }
  const h = grid.h;
  const gb = grid.bounds();
  if (opts.zFloor !== undefined && !(opts.zFloor >= gb.min[2] + 2 * h)) {
    throw new Error(`shell grid too small: floor z=${opts.zFloor.toFixed(2)} is not 2 voxels inside the grid (min z ${gb.min[2].toFixed(2)})`);
  }
  if (!(y0 >= gb.min[1] + 2 * h && y0 <= gb.max[1] - 2 * h)) {
    throw new Error(`parting plane y0=${y0.toFixed(2)} lies outside the mold region [${gb.min[1].toFixed(1)}, ${gb.max[1].toFixed(1)}] — reduce partingOffset`);
  }
  let occ = voxelizeManifold(Msdf, grid);
  const phi = signedDistance(occ, grid);
  occ = null;
  for (let v = 0; v < phi.length; v++) phi[v] -= d1; // phiS
  let phiCavA, phiCavB;
  if (P.demold === 'conformal') {
    phiCavA = phi;
    phiCavB = phi;
  } else {
    phiCavA = sweepMin(phi, grid, 1, +1);
    phiCavB = sweepMin(phi, grid, 1, -1);
  }
  const outer = (cav) => {
    const out = new Float32Array(cav.length);
    for (let v = 0; v < cav.length; v++) out[v] = cav[v] - w;
    if (P.base !== 'none') zSuffixMinInPlace(out, grid);
    return out;
  };
  const phiOutA = outer(phiCavA);
  const phiOutB = phiCavB === phiCavA ? phiOutA : outer(phiCavB);
  return { grid, phiCavA, phiCavB, phiOutA, phiOutB, d1 };
}

/** In-place running minimum along -Z: out[k] = min(out[k..nz-1]) (plinth sweep). */
function zSuffixMinInPlace(a, grid) {
  const s = grid.nx * grid.ny;
  for (let k = grid.nz - 2; k >= 0; k--) {
    const cur = k * s, prev = cur + s;
    for (let i = 0; i < s; i++) if (a[prev + i] < a[cur + i]) a[cur + i] = a[prev + i];
  }
}

/** Level-set bounds for half `side`: grid box, y clipped at the plane (+2h), z to [zLo, zHi]. */
export function halfBounds(grid, side, y0, zLo, zHi) {
  const gb = grid.bounds();
  const h = grid.h;
  const min = gb.min.slice(), max = gb.max.slice();
  if (side === 'A') max[1] = Math.min(max[1], y0 + 2 * h);
  else min[1] = Math.max(min[1], y0 - 2 * h);
  if (zLo !== undefined && zLo !== null) min[2] = Math.max(min[2], zLo);
  if (zHi !== undefined && zHi !== null) max[2] = Math.min(max[2], zHi);
  return { min, max };
}

/**
 * Cavity / outer solids and trimmed shells of both halves.
 * @param {object} fields buildShellFields() output
 * @param {object} P resolved params
 * @param {number} y0
 * @param {number} zTop rim height
 * @param {number} zFloor floor height
 * @param {{Mp?: *, warnings?: string[], extra?: number, label?: string}} [opts]
 *   extra: additional offset of both surfaces (e.g. cageClearance for a cage around the silicone);
 *   Mp: cast cavity — subtracted from the shells as a safety net (warns on thin features).
 * @returns {{cavA, cavB, outerA, outerB, shellA, shellB}}
 */
export function buildShells(fields, P, y0, zTop, zFloor, opts = {}) {
  const { grid } = fields;
  const h = grid.h;
  const level = CAV_LEVEL * h + (opts.extra || 0);
  const warnings = opts.warnings || [];
  const label = opts.label || 'shell';
  const out = {};
  for (const side of ['A', 'B']) {
    const phiCav = side === 'A' ? fields.phiCavA : fields.phiCavB;
    const phiOut = side === 'A' ? fields.phiOutA : fields.phiOutB;
    const cav = levelSetSolid(phiCav, grid, { level, bounds: halfBounds(grid, side, y0, zFloor - 2 * h, zTop + 2 * h) });
    const outer = levelSetSolid(phiOut, grid, { level, bounds: halfBounds(grid, side, y0, zFloor - 2 * h, zTop + 2 * h) });
    if (!cav || !outer) throw new Error(`${label} ${side}: empty level set (masters too small for the voxel size?)`);
    let shell = trimZ(trimSide(outer, side, y0), zFloor, zTop).subtract(cav);
    if (opts.Mp) {
      const v0 = shell.volume();
      const s2 = shell.subtract(opts.Mp);
      const removed = v0 - s2.volume();
      if (removed > 1) {
        warnings.push(`${label} ${side}: ${removed.toFixed(1)} mm³ of the shell reached into the cast cavity (feature thinner than the voxel size ${h.toFixed(2)} mm?) and was cut away — check the silicone around thin features.`);
      }
      shell = s2;
    }
    if (shell.isEmpty()) throw new Error(`${label} ${side} is empty`);
    out[`cav${side}`] = cav;
    out[`outer${side}`] = outer;
    out[`shell${side}`] = shell;
  }
  return out;
}

/**
 * Voxel count of the silicone (or any) region: voxels with phiCavA < level on the A side
 * (y <= y0), phiCavB < level on the B side, zFloor <= z <= zTop, and not inside `occMp`.
 * @returns {{countA:number, countB:number, volA:number, volB:number, occ: Uint8Array}} occ = region occupancy
 */
export function regionBetween(fields, y0, zFloor, zTop, occMp, level) {
  const { grid, phiCavA, phiCavB } = fields;
  const { nx, ny, nz, h } = grid;
  const o = grid.origin;
  const occ = new Uint8Array(grid.n);
  let countA = 0, countB = 0;
  const k0 = Math.max(0, Math.ceil((zFloor - o[2]) / h - 1e-9));
  const k1 = Math.min(nz - 1, Math.floor((zTop - o[2]) / h + 1e-9));
  for (let k = k0; k <= k1; k++) {
    for (let j = 0; j < ny; j++) {
      const y = o[1] + j * h;
      const isA = y <= y0;
      const phi = isA ? phiCavA : phiCavB;
      let v = nx * (j + ny * k);
      for (let i = 0; i < nx; i++, v++) {
        if (phi[v] < level && !(occMp && occMp[v])) {
          occ[v] = 1;
          if (isA) countA++; else countB++;
        }
      }
    }
  }
  const h3 = h * h * h;
  return { countA, countB, volA: countA * h3, volB: countB * h3, occ };
}
