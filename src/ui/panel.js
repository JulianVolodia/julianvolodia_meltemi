// Parameter panel generated from PARAM_SCHEMA (src/core/params.js).
// Collapsible groups, number inputs with units + help tooltips, selects (segmented for
// short option sets), switches, text inputs. Params persist in localStorage.
import { PARAM_SCHEMA, DEFAULTS } from '../core/params.js';
import { STORAGE_KEY, UI_STORAGE_KEY } from './config.js';

// Short labels for options rendered as segmented controls.
const SEGMENTED = {
  mode: { moldbox: 'Mold box', support: 'Support' },
  quality: { draft: 'Draft', normal: 'Normal', fine: 'Fine' },
};

const GROUP_HINTS = {
  'Mode': 'What to generate and how finely',
  'Parting & demold': 'Where the mold splits into halves A and B',
  'Silicone & shell': 'Silicone skin and printed shell walls',
  'Flanges, pins & clips': 'Registration and clamping hardware',
  'Parting board & keys': 'Board with master-half reliefs and key ridge',
  'Pour, wick & vents': 'Pour opening, wick channel, air vents',
  'Supports (ribs, feet, cage)': 'Stiffeners, feet and windowed cage',
  'Materials': 'Densities for weight estimates',
};

const DEFAULT_OPEN = new Set(['Mode', 'Parting & demold', 'Silicone & shell']);

// Conditional visibility: key -> (params) => boolean
const VISIBLE_IF = {
  siliconeThickness: (p) => p.mode !== 'support',
  topExtension: (p) => p.mode !== 'support',
  cageClearance: (p) => p.mode === 'support' || p.cage,
  sprueR1: (p) => p.pourMode !== 'extend',
  sprueR2: (p) => p.pourMode !== 'extend',
  wickDiameter: (p) => !!p.wick,
  ventDiameter: (p) => !!p.vents,
  ventMinDepth: (p) => !!p.vents,
  boardThickness: (p) => p.boardStyle !== 'none',
  boardTopExtra: (p) => p.boardStyle !== 'none',
  keys: (p) => p.boardStyle !== 'none',
  keyOffset: (p) => p.boardStyle !== 'none' && !!p.keys,
  keyWidth: (p) => p.boardStyle !== 'none' && !!p.keys,
  keyHeight: (p) => p.boardStyle !== 'none' && !!p.keys,
  keyClearance: (p) => p.boardStyle !== 'none' && !!p.keys,
  ribThickness: (p) => !!p.ribs,
  ribSpacing: (p) => !!p.ribs,
  ribTopInset: (p) => !!p.ribs,
  windowWidth: (p) => p.mode === 'support' || !!p.cage,
  windowHeight: (p) => p.mode === 'support' || !!p.cage,
  windowBar: (p) => p.mode === 'support' || !!p.cage,
  densitySilicone: (p) => p.mode !== 'support',
  siliconeMixRatio: (p) => p.mode !== 'support',
};

// Groups hidden in 'support' mode (no board, no channels).
const HIDDEN_IN_SUPPORT = (group) => /board|pour/i.test(group);

function safeGet(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
}
function safeSet(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* private mode / blocked */ }
}

let uid = 0;
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c) e.append(c);
  return e;
};

/**
 * Build the panel.
 * @param {HTMLElement} container
 * @param {{onChange?: (params, key) => void, schema?: any[]}} opts
 */
export function createPanel(container, opts = {}) {
  const schema = opts.schema || PARAM_SCHEMA;
  const onChange = opts.onChange || (() => {});
  const stored = safeGet(STORAGE_KEY) || {};
  const uiState = safeGet(UI_STORAGE_KEY) || {};
  const openGroups = new Set(uiState.openGroups || [...DEFAULT_OPEN]);

  const known = new Set(schema.flatMap((g) => g.items.map((i) => i.key)));
  let params = { ...DEFAULTS };
  for (const [k, v] of Object.entries(stored)) if (known.has(k)) params[k] = v;

  const fields = new Map(); // key -> {item, row, read(), write(v)}
  const groups = [];
  container.textContent = '';
  container.classList.add('param-panel');

  for (const g of schema) {
    const details = el('details', { class: 'param-group', 'data-group': g.group });
    if (openGroups.has(g.group)) details.open = true;
    const summary = el('summary', {},
      el('span', { class: 'chev', 'aria-hidden': 'true' }),
      el('span', { class: 'g-title', text: g.group }),
      GROUP_HINTS[g.group] ? el('span', { class: 'g-hint', text: GROUP_HINTS[g.group] }) : null);
    details.append(summary);
    details.addEventListener('toggle', () => {
      if (details.open) openGroups.add(g.group); else openGroups.delete(g.group);
      safeSet(UI_STORAGE_KEY, { ...(safeGet(UI_STORAGE_KEY) || {}), openGroups: [...openGroups] });
    });
    const body = el('div', { class: 'g-body' });
    for (const it of g.items) {
      const f = buildField(it);
      fields.set(it.key, f);
      body.append(f.row);
    }
    details.append(body);
    container.append(details);
    groups.push({ group: g.group, details });
  }

  const footer = el('div', { class: 'panel-footer' },
    el('button', { class: 'btn btn-ghost btn-sm', type: 'button', id: 'btn-reset-params', text: 'Reset defaults', onclick: () => reset() }));
  container.append(footer);

  function buildField(it) {
    const id = `p-${it.key}-${++uid}`;
    const helpId = it.help ? `${id}-help` : null;
    const tip = it.help ? el('span', { class: 'tip', tabindex: '0', role: 'note', 'aria-label': it.help, 'data-tip': it.help, title: it.help }, '?') : null;
    if (it.help) tip.id = helpId;
    let row, read, write;

    if (it.type === 'select' && SEGMENTED[it.key]) {
      const labels = SEGMENTED[it.key];
      const seg = el('div', { class: 'seg', role: 'radiogroup', 'aria-label': it.label, 'data-param': it.key });
      const btns = Object.keys(it.options).map((val) => {
        const b = el('button', {
          type: 'button', class: 'seg-btn', role: 'radio', 'data-value': val, title: it.options[val],
          onclick: () => { write(val); commit(it.key, val); },
        }, labels[val] || it.options[val]);
        seg.append(b);
        return b;
      });
      row = el('div', { class: 'field field-seg', 'data-key': it.key }, el('span', { class: 'f-label' }, it.label, tip), seg);
      read = () => (btns.find((b) => b.getAttribute('aria-checked') === 'true') || btns[0]).dataset.value;
      write = (v) => btns.forEach((b) => {
        const on = b.dataset.value === v;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      seg.addEventListener('keydown', (e) => {
        if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const i = btns.findIndex((b) => b.dataset.value === read());
        const n = btns[(i + (e.key === 'ArrowRight' ? 1 : btns.length - 1)) % btns.length];
        write(n.dataset.value); n.focus(); commit(it.key, n.dataset.value);
        e.preventDefault();
      });
    } else if (it.type === 'select') {
      const sel = el('select', { id, 'data-param': it.key, 'aria-describedby': helpId });
      for (const [val, lab] of Object.entries(it.options)) sel.append(el('option', { value: val }, lab));
      sel.addEventListener('change', () => commit(it.key, sel.value));
      row = el('div', { class: 'field', 'data-key': it.key }, el('label', { for: id, class: 'f-label' }, it.label, tip), el('div', { class: 'control' }, sel));
      read = () => sel.value;
      write = (v) => { sel.value = v; };
    } else if (it.type === 'boolean') {
      const cb = el('input', { id, type: 'checkbox', role: 'switch', 'data-param': it.key, 'aria-describedby': helpId });
      cb.addEventListener('change', () => commit(it.key, cb.checked));
      row = el('div', { class: 'field field-bool', 'data-key': it.key },
        el('label', { for: id, class: 'f-label' }, it.label, tip),
        el('label', { class: 'switch' }, cb, el('span', { class: 'track', 'aria-hidden': 'true' })));
      read = () => cb.checked;
      write = (v) => { cb.checked = !!v; };
    } else if (it.type === 'number') {
      const inp = el('input', {
        id, type: 'number', inputmode: 'decimal', 'data-param': it.key, 'aria-describedby': helpId,
        min: it.min, max: it.max, step: it.step ?? 'any',
        placeholder: it.key === 'keyOffset' ? 'auto' : undefined,
      });
      const parse = () => {
        const s = inp.value.trim();
        if (s === '') return it.key === 'keyOffset' ? null : DEFAULTS[it.key];
        const v = Number(s);
        return Number.isFinite(v) ? v : DEFAULTS[it.key];
      };
      const validate = () => {
        const s = inp.value.trim();
        const v = Number(s);
        const bad = s !== '' && (!Number.isFinite(v) || (it.min !== undefined && v < it.min) || (it.max !== undefined && v > it.max));
        inp.setAttribute('aria-invalid', bad ? 'true' : 'false');
        return !bad;
      };
      let t = null;
      inp.addEventListener('input', () => {
        validate();
        clearTimeout(t);
        t = setTimeout(() => { if (validate()) commit(it.key, parse()); }, 250);
      });
      inp.addEventListener('change', () => {
        clearTimeout(t);
        let v = parse();
        if (v !== null) {
          if (it.min !== undefined) v = Math.max(it.min, v);
          if (it.max !== undefined) v = Math.min(it.max, v);
          write(v);
        }
        validate();
        commit(it.key, v);
      });
      row = el('div', { class: 'field', 'data-key': it.key },
        el('label', { for: id, class: 'f-label' }, it.label, tip),
        el('div', { class: 'control num' }, inp, it.unit ? el('span', { class: 'unit', 'aria-hidden': 'true' }, it.unit) : null));
      read = parse;
      write = (v) => { inp.value = v === null || v === undefined ? '' : String(+Number(v).toFixed(4)); };
    } else {
      const inp = el('input', { id, type: 'text', 'data-param': it.key, 'aria-describedby': helpId, spellcheck: 'false', autocomplete: 'off' });
      inp.addEventListener('change', () => commit(it.key, inp.value.trim()));
      row = el('div', { class: 'field', 'data-key': it.key }, el('label', { for: id, class: 'f-label' }, it.label, tip), el('div', { class: 'control' }, inp));
      read = () => inp.value.trim();
      write = (v) => { inp.value = v ?? ''; };
    }
    return { item: it, row, read, write };
  }

  function commit(key, value) {
    if (params[key] === value) return;
    params = { ...params, [key]: value };
    persist();
    applyVisibility();
    onChange(get(), key);
  }

  function persist() {
    const diff = {};
    for (const k of known) if (params[k] !== DEFAULTS[k]) diff[k] = params[k];
    safeSet(STORAGE_KEY, diff);
  }

  function applyVisibility() {
    const support = params.mode === 'support';
    for (const { group, details } of groups) details.hidden = support && HIDDEN_IN_SUPPORT(group);
    for (const [k, f] of fields) {
      const fn = VISIBLE_IF[k];
      f.row.hidden = fn ? !fn(params) : false;
    }
  }

  function writeAll() {
    for (const [k, f] of fields) f.write(params[k]);
    applyVisibility();
  }

  function get() { return { ...params }; }

  function set(p, { silent = false } = {}) {
    for (const [k, v] of Object.entries(p || {})) if (known.has(k)) params[k] = v;
    writeAll();
    persist();
    if (!silent) onChange(get(), null);
  }

  function reset() {
    params = { ...DEFAULTS };
    writeAll();
    persist();
    onChange(get(), null);
  }

  writeAll();
  return { get, set, reset, el: container };
}
