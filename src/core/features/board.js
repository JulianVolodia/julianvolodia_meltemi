// Parting board(s) and key ring (DESIGN.md §4 step 7).
//
// The parting board is the printed plate the silicone halves are poured against. It carries
// the master-half reliefs (exact booleans on the cast cavity Mp — never re-meshed), a key
// ridge (tongue) on one face and the matching groove on the other, and pin holes that line
// up with the flange pin holes. Styles:
//   'double' — one board of thickness T between the halves (shell A at -T/2, shell B at +T/2),
//              relief A on face y0-T/2, relief B on face y0+T/2: both silicone halves are
//              poured at once; printed upright.
//   'single' — two boards (A: slab [y0, y0+T] + relief A + ridge; B: slab [y0-T, y0] + relief
//              B + groove), two separate pours; each printed flat with the relief facing up.
//   'none'   — no board.
//
// Key convention: board A carries a ridge (kw x kh) -> silicone A gets a groove kw x kh; board B
// carries a groove (kw + 2c) x (kh + c) -> silicone B gets a tongue of that size. The clearance
// c compensates FDM tolerances (printed ridges come out wide, printed grooves narrow), so the
// two silicone keys meet nominally with a slight squeeze, which helps the seal.
import { mf } from '../wasm.js';
import {
  planeExtrude, planeSlice, trimZ, rect2, rod,
  mat4Identity, mat4Translation, mat4AxisAngle, mat4Mul,
} from '../frame.js';

const E = 0.01; // overlap so unions of touching parts never rely on coincident faces
const BIG = 1e5;

/**
 * Key ring on the parting plane, in plane coords (x, z): a band at distance keyOffset (centre
 * line) around the cavity opening S = planeSlice(Mp, y0), keyWidth wide, kept inside the
 * silicone face (shrunk by keyWidth), above zFloor and below zTop - max(2 kw, 0.6 d1) so the
 * U is open towards the pour side.
 * @param {object} ctx pipeline context (P, y0, zTop, zFloor, Mp, cavA, cavB)
 * @returns {import('manifold-3d').CrossSection|null}
 */
export function keyRing2D(ctx) {
  const P = ctx.P;
  if (!P.keys || !ctx.Mp) return null;
  const y0 = ctx.y0;
  const S = planeSlice(ctx.Mp, y0);
  if (S.isEmpty()) return null;
  const k = P.keyOffset, kw = P.keyWidth;
  if (!(kw > 0) || !(k > 0)) return null;
  const outer = S.offset(k + kw / 2, 'Round');
  const inner = S.offset(Math.max(k - kw / 2, 0.2), 'Round');
  let ring = outer.subtract(inner);
  // silicone face on the plane (both halves' envelopes), shrunk by kw from its outer edge
  let face = null;
  for (const cav of [ctx.cavA, ctx.cavB]) {
    if (!cav) continue;
    const sl = planeSlice(cav, y0);
    face = face ? face.add(sl) : sl;
  }
  if (face) ring = ring.intersect(face.offset(-kw, 'Round')).subtract(S);
  const zCap = ctx.zTop - Math.max(2 * kw, P.siliconeThickness * 0.6);
  ring = ring.intersect(rect2(-BIG, ctx.zFloor, BIG, zCap));
  if (ring.isEmpty() || ring.area() < 1e-3) return null;
  return ring;
}

/**
 * Board outline in plane coords: flange outline F extended boardTopExtra above zTop as a
 * handle with rounded top corners, plus a 12 mm finger hole when the handle is tall enough.
 * @param {object} ctx
 * @returns {import('manifold-3d').CrossSection}
 */
export function boardOutline2D(ctx) {
  const { CrossSection } = mf();
  const P = ctx.P;
  const F = ctx.flange2D;
  const extra = Number(P.boardTopExtra) || 0;
  if (!(extra > 0)) return F;
  const bF = F.bounds();
  // x-range of the flange outline at its top edge (fall back to the full width)
  const band = F.intersect(rect2(bF.min[0] - 1, ctx.zTop - 1, bF.max[0] + 1, ctx.zTop + 1));
  let xa = bF.min[0], xb = bF.max[0];
  if (!band.isEmpty()) {
    const b = band.bounds();
    xa = b.min[0]; xb = b.max[0];
  }
  if (!(xb - xa > 1)) return F;
  const r = Math.max(0.05, Math.min(extra * 0.9, 10, (xb - xa) / 2 - 0.5));
  const rounded = CrossSection.square([xb - xa - 2 * r, extra + 1])
    .translate([xa + r, ctx.zTop - r - 1])
    .offset(r, 'Round', 2, 48);
  const handle = rounded.intersect(rect2(xa, ctx.zTop - E, xb, ctx.zTop + extra));
  let Fb = F.add(handle);
  if (extra >= 14) {
    const zc = Math.max(ctx.zTop + 7, ctx.zTop + extra - 8);
    Fb = Fb.subtract(CrossSection.circle(6, 48).translate([(xa + xb) / 2, zc]));
  }
  return Fb;
}

/** Union of Y-axis pin holes through [yA, yB] at ctx.pinSites. */
function pinHoles(ctx, yA, yB) {
  const { Manifold } = mf();
  const P = ctx.P;
  const r = (P.pinDiameter + P.pinClearance) / 2;
  const holes = (ctx.pinSites || []).map(([x, z]) => rod([x, yA, z], [x, yB, z], r, 32));
  if (!holes.length) return null;
  return holes.length === 1 ? holes[0] : Manifold.union(holes);
}

/** Half of the cast cavity for a board relief: Mp on side A/B (+E across the plane), zFloor..zTop. */
function reliefHalf(ctx, side) {
  const { Mp, y0 } = ctx;
  const half = side === 'A' ? Mp.trimByPlane([0, -1, 0], -(y0 + E)) : Mp.trimByPlane([0, 1, 0], y0 - E);
  return trimZ(half, ctx.zFloor, ctx.zTop + 0.01);
}

function subtractAll(base, cutters) {
  const { Manifold } = mf();
  const c = cutters.filter((m) => m && !m.isEmpty());
  if (!c.length) return base;
  return base.subtract(c.length === 1 ? c[0] : Manifold.union(c));
}

function unionAll(list) {
  const { Manifold } = mf();
  const l = list.filter((m) => m && !m.isEmpty());
  return l.length === 1 ? l[0] : Manifold.union(l);
}

/** Matrix = translate(min z -> 0) * R, for solid placed by rotation R. */
function dropToBed(solid, R) {
  const bb = solid.transform(R).boundingBox();
  return mat4Mul(mat4Translation(0, 0, -bb.min[2]), R);
}

function check(solid, name) {
  const st = solid.status();
  if (st !== 'NoError') throw new Error(`board: ${name} is not a valid manifold (${st})`);
  if (solid.isEmpty()) throw new Error(`board: ${name} is empty`);
  return solid;
}

/**
 * Build the parting board(s).
 * @param {object} ctx pipeline context (P, y0, zTop, zFloor, Mp, cavA, cavB, flange2D, pinSites)
 * @returns {{boards: {id:string, name:string, solid:any, poseSilicone:number[], printMatrix:number[]}[],
 *            shellOffsetY: {A:number, B:number}, warnings: string[]}}
 */
export function buildBoards(ctx) {
  const P = ctx.P;
  const style = P.boardStyle || 'double';
  const warnings = [];
  const done = (boards, A, B) => {
    if (Array.isArray(ctx.warnings)) ctx.warnings.push(...warnings);
    return { boards, shellOffsetY: { A, B }, warnings };
  };
  if (style === 'none' || !ctx.flange2D || !ctx.Mp) return done([], 0, 0);

  const T = P.boardThickness, y0 = ctx.y0;
  const Fb = boardOutline2D(ctx);

  // keys: groove depth kh + c must leave >= 0.8 mm of board behind it
  const ring = keyRing2D(ctx);
  let kh = P.keyHeight;
  const kc = Math.max(0, P.keyClearance || 0);
  let gDepth = kh + kc;
  let keys = !!ring;
  if (keys && gDepth > T - 0.8) {
    gDepth = T - 0.8;
    kh = gDepth - kc;
    if (kh < 0.3) {
      keys = false;
      warnings.push(`Board ${T} mm is too thin for a key groove (needs > ${(P.keyHeight + kc + 0.8).toFixed(2)} mm); keys disabled.`);
    } else {
      warnings.push(`Key height clamped to ${kh.toFixed(2)} mm so the groove leaves 0.8 mm of a ${T} mm board.`);
    }
  }
  if (P.keys && !ring) warnings.push('Key ring could not be placed (silicone face too narrow); no keys.');
  const grooveRing = keys ? (kc > 0 ? ring.offset(kc, 'Round') : ring) : null;

  const reliefA = reliefHalf(ctx, 'A');
  const reliefB = reliefHalf(ctx, 'B');
  const ident = mat4Identity();

  if (style === 'single') {
    const holes = pinHoles(ctx, y0 - T - 1, y0 + T + 1);
    // board A: slab behind the plane on the B side, relief A protrudes into y < y0, ridge on face y0
    const slabA = subtractAll(planeExtrude(Fb, y0, y0 + T), [holes]);
    const ridgeA = keys ? planeExtrude(ring, y0 - kh, y0 + E) : null;
    const boardA = check(unionAll([slabA, reliefA, ridgeA]), 'board A');
    // board B: slab on the A side, relief B protrudes into y > y0, groove in face y0
    const grooveB = keys ? planeExtrude(grooveRing, y0 - gDepth, y0 + E) : null;
    const slabB = subtractAll(planeExtrude(Fb, y0 - T, y0), [holes, grooveB]);
    const boardB = check(unionAll([slabB, reliefB]), 'board B');
    const RA = mat4AxisAngle([1, 0, 0], -Math.PI / 2); // -Y -> +Z (relief A up)
    const RB = mat4AxisAngle([1, 0, 0], Math.PI / 2); //  +Y -> +Z (relief B up)
    return done([
      { id: 'boardA', name: 'Parting board A', solid: boardA, poseSilicone: ident, printMatrix: dropToBed(boardA, RA) },
      { id: 'boardB', name: 'Parting board B', solid: boardB, poseSilicone: ident.slice(), printMatrix: dropToBed(boardB, RB) },
    ], 0, 0);
  }

  // 'double' (default)
  const yFa = y0 - T / 2, yFb = y0 + T / 2;
  const holes = pinHoles(ctx, yFa - 1, yFb + 1);
  const groove = keys ? planeExtrude(grooveRing, yFb - gDepth, yFb + E) : null;
  const slab = subtractAll(planeExtrude(Fb, yFa, yFb), [holes, groove]);
  const ridge = keys ? planeExtrude(ring, yFa - kh, yFa + E) : null;
  const board = check(unionAll([
    slab,
    reliefA.translate([0, -T / 2, 0]),
    reliefB.translate([0, T / 2, 0]),
    ridge,
  ]), 'board');
  const printMatrix = mat4Translation(0, 0, -board.boundingBox().min[2]);
  return done([
    { id: 'board', name: 'Parting board (double-sided)', solid: board, poseSilicone: ident, printMatrix },
  ], -T / 2, T / 2);
}
