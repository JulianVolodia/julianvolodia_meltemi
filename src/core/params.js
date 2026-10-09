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
      { key: 'base', label: 'Base', type: 'select', options: { plinth: 'Flat printable plinth', none: 'Conformal bottom' } },
      { key: 'baseExtra', label: 'Extra floor', type: 'number', min: 0, max: 20, step: 0.5, unit: 'mm' },
      { key: 'cageClearance', label: 'Support clearance', type: 'number', min: 0, max: 3, step: 0.05, unit: 'mm', help: 'Gap between an existing form and its support (mode B / cage)' },
    ],
  },
  {
    group: 'Flanges, pins & clips', items: [
      { key: 'flangeWidth', label: 'Flange width', type: 'number', min: 6, max: 40, step: 0.5, unit: 'mm' },
      { key: 'flangeThickness', label: 'Flange thickness', type: 'number', min: 2, max: 10, step: 0.2, unit: 'mm' },
      { key: 'pinsPerSide', label: 'Pins per side', type: 'number', min: 0, max: 8, step: 1 },
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
      { key: 'keyOffset', label: 'Key offset from cavity', type: 'number', min: 0.5, max: 20, step: 0.25, unit: 'mm', help: 'Blank = 45 % of silicone thickness' },
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
      { key: 'densityPrint', label: 'Print density (PLA 1.24)', type: 'number', min: 0.5, max: 3, step: 0.01, unit: 'g/cm³' },
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
  siliconeThickness: 5,
  wallThickness: 2.4,
  topExtension: 2,
  base: 'plinth',
  baseExtra: 0,
  cageClearance: 0.3,
  flangeWidth: 14,
  flangeThickness: 4,
  pinsPerSide: 3,
  pinDiameter: 3,
  pinClearance: 0.25,
  clipsPerSide: 3,
  clipsBottom: 1,
  clipWidth: 10,
  clipWall: 2.8,
  clipJaw: 5,
  clipInterference: 0.15,
  boardStyle: 'double',
  boardThickness: 4,
  boardTopExtra: 6,
  keys: true,
  keyOffset: null, // null -> 0.45 * siliconeThickness
  keyWidth: 1.8,
  keyHeight: 1.4,
  keyClearance: 0.2,
  pourMode: 'auto',
  sprueR1: 3,
  sprueR2: 7,
  wick: false,
  wickDiameter: 2.2,
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
  densityPrint: 1.24,
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
  if (out.keyOffset === null || out.keyOffset === '' || Number.isNaN(out.keyOffset)) out.keyOffset = 0.45 * out.siliconeThickness;
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
