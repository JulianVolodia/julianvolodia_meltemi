// Parameter defaults + schema. The UI panel is generated from PARAM_SCHEMA.
// All lengths in millimetres, densities in g/cm^3.

export const CAST_MATERIALS = {
  wax: { label: 'Candle wax (paraffin/soy)', density: 0.9 },
  resin: { label: 'Epoxy / PU resin', density: 1.1 },
  plaster: { label: 'Plaster / Jesmonite', density: 1.0 },
  soap: { label: 'Soap (melt & pour)', density: 1.06 },
  concrete: { label: 'Concrete', density: 2.3 },
  chocolate: { label: 'Chocolate', density: 1.3 },
};

export const PRINT_MATERIALS = {
  pla: { label: 'PLA (1.24 g/cm³, Tg ~58 °C)', density: 1.24, tg: 58 },
  petg: { label: 'PETG (1.27 g/cm³, Tg ~80 °C)', density: 1.27, tg: 80 },
  asa: { label: 'ASA/ABS (1.07 g/cm³, Tg ~100 °C)', density: 1.07, tg: 100 },
  pctg: { label: 'PCTG (1.23 g/cm³, Tg ~85 °C)', density: 1.23, tg: 85 },
};

export const PARAM_SCHEMA = [
  {
    group: 'Mode', items: [
      { key: 'mode', label: 'Generate', type: 'select', options: { moldbox: 'Mold box from master (positive)', support: 'Support for an existing silicone form' } },
      { key: 'quality', label: 'Quality', type: 'select', options: { draft: 'Draft (fast)', normal: 'Normal', fine: 'Fine (slow)' } },
    ],
  },
  {
    group: 'Parting & demold', items: [
      { key: 'partingOffset', label: 'Parting plane offset (Y)', type: 'number', step: 0.5, unit: 'mm', help: 'Offset of the parting plane from the masters\' bounding-box centre' },
      { key: 'demold', label: 'Shell demold', type: 'select', options: { straight: 'Straight pull (no rigid undercuts)', conformal: 'Conformal (least silicone)' } },
    ],
  },
  {
    group: 'Silicone & shell', items: [
      { key: 'siliconeThickness', label: 'Silicone thickness', type: 'number', min: 1, max: 30, step: 0.5, unit: 'mm' },
      { key: 'wallThickness', label: 'Shell wall', type: 'number', min: 0.8, max: 10, step: 0.2, unit: 'mm' },
      { key: 'topExtension', label: 'Silicone above master', type: 'number', min: 0, max: 30, step: 0.5, unit: 'mm' },
      { key: 'collar', label: 'Silicone collar at the pour end', type: 'boolean', help: 'A silicone lip over the shell rim (kołnierz): the skin hangs from it in the support, and it seals the pour face' },
      { key: 'collarHeight', label: 'Collar height', type: 'number', min: 2, max: 20, step: 0.5, unit: 'mm' },
      { key: 'collarOverhang', label: 'Collar beyond shell wall', type: 'number', min: 0, max: 15, step: 0.5, unit: 'mm', help: 'How far the lip reaches past the shell outer wall (the dam stands outside it)' },
      { key: 'endWallExtra', label: 'Extra end-wall thickness (±X)', type: 'number', min: 0, max: 10, step: 0.2, unit: 'mm', help: 'Added to the shell wall (and collar dam) at the left/right ends, where the end flanges, pins and clips load the mold' },
      { key: 'endWallBlend', label: 'End-wall blend length', type: 'number', min: 1, max: 60, step: 1, unit: 'mm', help: 'Over this distance from each end the extra thickness tapers in, so the side faces stay smooth' },
      { key: 'base', label: 'Base', type: 'select', options: { plinth: 'Flat printable plinth', none: 'Conformal bottom' } },
      { key: 'baseExtra', label: 'Extra floor', type: 'number', min: 0, max: 20, step: 0.5, unit: 'mm' },
      { key: 'cageClearance', label: 'Support clearance', type: 'number', min: 0, max: 3, step: 0.05, unit: 'mm', help: 'Gap between an existing form and its support (mode B / cage)' },
    ],
  },
  {
    group: 'Flanges, pins & clips', items: [
      { key: 'flangeWidth', label: 'Flange width', type: 'number', min: 6, max: 40, step: 0.5, unit: 'mm' },
      { key: 'flangeThickness', label: 'Flange thickness', type: 'number', min: 2, max: 10, step: 0.2, unit: 'mm' },
      { key: 'registration', label: 'Registration', type: 'select', options: { interlock: 'Interlocking pegs & sockets (no loose pins)', pins: 'Loose dowel pins' }, help: 'Interlock: tapered diamond pegs on shell A (and board B) key into sockets in shell B (and board A)' },
      { key: 'pinsPerSide', label: 'Registration points per side', type: 'number', min: 0, max: 8, step: 1 },
      { key: 'pegSize', label: 'Peg size (diagonal)', type: 'number', min: 3, max: 14, step: 0.5, unit: 'mm' },
      { key: 'pegHeight', label: 'Peg height', type: 'number', min: 1, max: 8, step: 0.5, unit: 'mm' },
      { key: 'pegClearance', label: 'Socket clearance', type: 'number', min: 0, max: 1, step: 0.05, unit: 'mm' },
      { key: 'pinDiameter', label: 'Pin diameter', type: 'number', min: 1.5, max: 8, step: 0.1, unit: 'mm' },
      { key: 'pinClearance', label: 'Pin hole clearance', type: 'number', min: 0, max: 1, step: 0.05, unit: 'mm' },
      { key: 'clipsPerSide', label: 'Clips per side', type: 'number', min: 0, max: 10, step: 1 },
      { key: 'clipsBottom', label: 'Clips on bottom', type: 'number', min: 0, max: 6, step: 1 },
      { key: 'clipWidth', label: 'Clip width', type: 'number', min: 4, max: 30, step: 0.5, unit: 'mm' },
      { key: 'clipWall', label: 'Clip wall', type: 'number', min: 1.5, max: 6, step: 0.1, unit: 'mm' },
      { key: 'clipJaw', label: 'Clip jaw depth', type: 'number', min: 2, max: 15, step: 0.5, unit: 'mm' },
      { key: 'clipInterference', label: 'Clip interference', type: 'number', min: -0.5, max: 1, step: 0.05, unit: 'mm', help: 'How much tighter than the sandwich the clip gap is' },
    ],
  },
  {
    group: 'Parting board & keys', items: [
      { key: 'boardStyle', label: 'Board', type: 'select', options: { double: 'Double-sided (one pour, print upright)', single: 'Two single-sided boards (print flat)', none: 'No board' } },
      { key: 'boardThickness', label: 'Board thickness', type: 'number', min: 2, max: 12, step: 0.2, unit: 'mm' },
      { key: 'boardTopExtra', label: 'Board handle above rim', type: 'number', min: 0, max: 30, step: 1, unit: 'mm' },
      { key: 'keys', label: 'Key ridge (tongue & groove)', type: 'boolean' },
      { key: 'keyOffset', label: 'Key offset from cavity', type: 'number', min: 0.5, max: 20, step: 0.25, unit: 'mm', help: 'Blank = max(2.5 mm, 50 % of silicone thickness)' },
      { key: 'keyWidth', label: 'Key width', type: 'number', min: 0.6, max: 6, step: 0.1, unit: 'mm' },
      { key: 'keyHeight', label: 'Key height', type: 'number', min: 0.4, max: 4, step: 0.1, unit: 'mm' },
      { key: 'keyClearance', label: 'Groove clearance', type: 'number', min: 0, max: 1, step: 0.05, unit: 'mm' },
    ],
  },
  {
    group: 'Pour, wick & vents', items: [
      { key: 'pourMode', label: 'Pour opening', type: 'select', options: { auto: 'Auto', extend: 'Extend flat top face', sprue: 'Funnel sprue at highest point' } },
      { key: 'sprueR1', label: 'Sprue radius at part', type: 'number', min: 1, max: 15, step: 0.5, unit: 'mm' },
      { key: 'sprueR2', label: 'Funnel radius at top', type: 'number', min: 1, max: 25, step: 0.5, unit: 'mm' },
      { key: 'wick', label: 'Wick channel (candles)', type: 'boolean' },
      { key: 'wickDiameter', label: 'Wick channel diameter', type: 'number', min: 0.8, max: 6, step: 0.1, unit: 'mm' },
      { key: 'vents', label: 'Auto air vents', type: 'boolean' },
      { key: 'ventDiameter', label: 'Vent diameter', type: 'number', min: 0.8, max: 5, step: 0.1, unit: 'mm' },
      { key: 'ventMinDepth', label: 'Ignore pockets shallower than', type: 'number', min: 0.2, max: 20, step: 0.1, unit: 'mm' },
    ],
  },
  {
    group: 'Supports (ribs, feet, cage)', items: [
      { key: 'ribs', label: 'Ribs / feet', type: 'boolean' },
      { key: 'ribThickness', label: 'Rib thickness', type: 'number', min: 1, max: 8, step: 0.2, unit: 'mm' },
      { key: 'ribSpacing', label: 'Max rib spacing', type: 'number', min: 8, max: 120, step: 1, unit: 'mm' },
      { key: 'ribTopInset', label: 'Rib top inset', type: 'number', min: 0, max: 50, step: 1, unit: 'mm' },
      { key: 'cage', label: 'Also make windowed support cage', type: 'boolean', help: 'Lighter mother mold for the casting stage' },
      { key: 'windowWidth', label: 'Window width', type: 'number', min: 3, max: 40, step: 0.5, unit: 'mm' },
      { key: 'windowHeight', label: 'Window height', type: 'number', min: 5, max: 80, step: 1, unit: 'mm' },
      { key: 'windowBar', label: 'Bar between windows', type: 'number', min: 2, max: 20, step: 0.5, unit: 'mm' },
    ],
  },
  {
    group: 'Materials', items: [
      { key: 'castMaterial', label: 'Casting material', type: 'select', options: Object.fromEntries(Object.entries(CAST_MATERIALS).map(([k, v]) => [k, v.label])) },
      { key: 'printMaterial', label: 'Print material', type: 'select', options: Object.fromEntries(Object.entries(PRINT_MATERIALS).map(([k, v]) => [k, v.label])), help: 'PLA softens at ~55-60 °C: use PETG/ASA for parts that see hot wax or exothermic resin' },
      { key: 'densitySilicone', label: 'Silicone density', type: 'number', min: 0.9, max: 1.6, step: 0.01, unit: 'g/cm³' },
      { key: 'siliconeMixRatio', label: 'Silicone mix A:B (by weight)', type: 'text', help: 'e.g. 1:1 or 10:1' },
    ],
  },
];

export const DEFAULTS = {
  mode: 'moldbox',
  quality: 'normal',
  partingOffset: 0,
  demold: 'straight',
  siliconeThickness: 6,
  wallThickness: 2.4,
  topExtension: 5, // riser: wax shrinks 10-15 % by volume
  base: 'plinth',
  baseExtra: 0,
  collar: true,
  collarHeight: 5,
  collarOverhang: 3,
  endWallExtra: 2.4, // end walls (±X) = 2 x wallThickness by default
  endWallBlend: 12,
  cageClearance: 0.5,
  flangeWidth: 14,
  flangeThickness: 4,
  pinsPerSide: 3,
  registration: 'interlock',
  pegSize: 7,
  pegHeight: 3,
  pegClearance: 0.25,
  pinDiameter: 4,
  pinClearance: 0.4, // FDM holes print undersize
  clipsPerSide: 4, // keep clip pitch <= ~50 mm against silicone head pressure
  clipsBottom: 1,
  clipWidth: 10,
  clipWall: 3.4,
  clipJaw: 5,
  clipInterference: 0.3,
  boardStyle: 'single', // flat-printable, support-free reliefs (expert advice)
  boardThickness: 5,
  boardTopExtra: 12,
  keys: true,
  keyOffset: null, // null -> max(2.5, 0.5 * siliconeThickness)
  keyWidth: 2.4,
  keyHeight: 1.5,
  keyClearance: 0.1,
  pourMode: 'auto',
  sprueR1: 3,
  sprueR2: 7,
  wick: false,
  wickDiameter: 1.6, // ~0.8 x wick diameter so the wick seals by interference
  vents: true,
  ventDiameter: 2,
  ventMinDepth: 1.5,
  ribs: true,
  ribThickness: 2.4,
  ribSpacing: 30,
  ribTopInset: 0,
  cage: false,
  windowWidth: 9,
  windowHeight: 28,
  windowBar: 5,
  castMaterial: 'wax',
  printMaterial: 'petg',
  densitySilicone: 1.1,
  siliconeMixRatio: '1:1',
};

export const QUALITY = {
  draft: { maxVoxels: 1.2e6, minVoxel: 0.6 },
  normal: { maxVoxels: 4e6, minVoxel: 0.4 },
  fine: { maxVoxels: 10e6, minVoxel: 0.3 },
};

/** Merge user params over defaults, coerce numbers, fill derived values. */
export function resolveParams(p = {}) {
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(p || {})) {
    if (v === undefined) continue;
    out[k] = v;
  }
  for (const group of PARAM_SCHEMA)
    for (const it of group.items) {
      if (it.type === 'number' && out[it.key] !== null && out[it.key] !== '') out[it.key] = Number(out[it.key]);
      if (it.type === 'boolean') out[it.key] = Boolean(out[it.key]);
    }
  if (out.keyOffset === null || out.keyOffset === '' || Number.isNaN(out.keyOffset)) out.keyOffset = Math.max(2.5, 0.5 * out.siliconeThickness);
  const pm = PRINT_MATERIALS[out.printMaterial] || PRINT_MATERIALS.pla;
  if (!(Number(p?.densityPrint) > 0)) out.densityPrint = pm.density;
  out.printMaterialTg = pm.tg;
  out.densityCast = (CAST_MATERIALS[out.castMaterial] || CAST_MATERIALS.wax).density;
  out.q = QUALITY[out.quality] || QUALITY.normal;
  return out;
}

/** Parse "A:B" mix ratio into weight fractions [fa, fb]. */
export function mixFractions(ratio) {
  const m = String(ratio || '1:1').split(':').map(Number);
  const a = m[0] > 0 ? m[0] : 1, b = m[1] > 0 ? m[1] : 1;
  return [a / (a + b), b / (a + b)];
}
