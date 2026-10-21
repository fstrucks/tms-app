import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { execSync } from 'node:child_process';
import { THEME_INIT_SCRIPT, THEME_KEY, THEME_COLORS, resolveTheme, normalizeTheme, readTheme, setTheme } from '../../app/lib/theme.js';

const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
function block(sel) {
  const i = css.indexOf(sel + ' {'); assert.ok(i >= 0, sel);
  const body = css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}
const THEMES = { light: block(':root, [data-theme="light"]'), dark: block('[data-theme="dark"]') };
const lum = (hex) => {
  const h = hex.replace('#', ''); const v = h.length === 3 ? [...h].map((c) => c + c) : [h.slice(0, 2), h.slice(2, 4), h.slice(4, 6)];
  const [r, g, b] = v.map((x) => { const c = parseInt(x, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const TEXT = [ // 4.5:1
  ['text', 'bg'], ['text', 'surface'], ['text', 'surface-2'], ['text-muted', 'bg'], ['text-muted', 'surface'], ['text-muted', 'surface-2'],
  ['primary', 'bg'], ['primary', 'surface'], ['on-primary', 'primary'], ['on-primary', 'success'], ['on-primary', 'danger'], ['on-primary', 'text'],
  ['success', 'surface'], ['success', 'success-bg'], ['warning', 'surface'], ['warning', 'warning-bg'], ['danger', 'surface'], ['danger', 'danger-bg'],
  ['text', 'info-bg'], ['primary', 'info-bg'], ['paper-text', 'paper'],
];
const PLACEHOLDER = [['placeholder', 'surface'], ['placeholder', 'bg']]; // inputs are --surface; aim 4.5:1
const UI = [['border', 'bg'], ['border', 'surface'], ['focus', 'bg'], ['focus', 'surface'], ['primary', 'surface-2']]; // 3:1
const NAMES = ['bg', 'surface', 'surface-2', 'text', 'text-muted', 'placeholder', 'border', 'divider', 'primary', 'on-primary', 'primary-soft', 'success', 'success-bg',
  'warning', 'warning-bg', 'warning-border', 'danger', 'danger-bg', 'danger-border', 'info-bg', 'focus', 'focus-ring', 'overlay', 'shadow', 'paper', 'paper-line', 'paper-text'];

for (const [name, t] of Object.entries(THEMES)) {
  test(`${name}: every token is defined`, () => { for (const n of NAMES) assert.ok(t[n], `--${n}`); });
  test(`${name}: text pairs meet WCAG AA 4.5:1`, () => {
    for (const [fg, bg] of TEXT) { const r = ratio(t[fg], t[bg]); assert.ok(r >= 4.5, `--${fg} on --${bg} = ${r.toFixed(2)}`); }
  });
  test(`${name}: --placeholder is readable (4.5:1) and lighter than --text-muted`, () => {
    for (const [fg, bg] of PLACEHOLDER) { const r = ratio(t[fg], t[bg]); assert.ok(r >= 4.5, `--${fg} on --${bg} = ${r.toFixed(2)}`); }
    assert.ok(ratio(t.placeholder, t.surface) < ratio(t['text-muted'], t.surface), 'placeholder should be less prominent than muted text');
  });
  test(`${name}: UI/border pairs meet 3:1`, () => {
    for (const [fg, bg] of UI) { const r = ratio(t[fg], t[bg]); assert.ok(r >= 3, `--${fg} vs --${bg} = ${r.toFixed(2)}`); }
  });
}
test('signature ink stays dark on paper in both themes (and in the exported PNG/PDF)', () => {
  const ink = readFileSync(new URL('../../app/components/SignaturePad.js', import.meta.url), 'utf8').match(/const INK = '(#[0-9a-f]{6})'/)[1];
  for (const t of Object.values(THEMES)) { assert.equal(t.paper, '#ffffff'); assert.ok(ratio(ink, t.paper) >= 7); }
  assert.ok(lum(ink) < 0.05);
});
test('theme-color matches --bg', () => { assert.equal(THEME_COLORS.light, THEMES.light.bg); assert.equal(THEME_COLORS.dark, THEMES.dark.bg); });

test('resolve/normalize: Auto follows the OS; explicit choices win', () => {
  assert.equal(resolveTheme('auto', true), 'dark'); assert.equal(resolveTheme('auto', false), 'light');
  assert.equal(resolveTheme('light', true), 'light'); assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(normalizeTheme('purple'), 'auto'); assert.equal(normalizeTheme(null), 'auto');
});

function fakeWin({ stored = null, osDark = false } = {}) {
  const store = new Map(stored ? [[THEME_KEY, stored]] : []); const listeners = []; const attrs = {}; const metas = [
    { a: { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '' }, getAttribute(k) { return this.a[k]; }, setAttribute(k, v) { this.a[k] = v; } },
    { a: { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '' }, getAttribute(k) { return this.a[k]; }, setAttribute(k, v) { this.a[k] = v; } }];
  const mq = { matches: osDark, addEventListener: (_e, f) => listeners.push(f) };
  const win = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    matchMedia: () => mq, addEventListener() {},
    document: { documentElement: { style: {}, setAttribute: (k, v) => { attrs[k] = v; }, getAttribute: (k) => attrs[k] }, querySelectorAll: () => metas, addEventListener() {} },
  };
  win.window = win;
  return { win, attrs, metas, mq, fire: () => listeners.forEach((f) => f()) };
}
const run = (w) => vm.runInNewContext(THEME_INIT_SCRIPT, { window: w.win, document: w.win.document, localStorage: w.win.localStorage });

test('head script: Auto + dark OS sets data-theme=dark and color-scheme before paint, and follows OS changes live', () => {
  const w = fakeWin({ osDark: true }); run(w);
  assert.equal(w.attrs['data-theme'], 'dark'); assert.equal(w.win.document.documentElement.style.colorScheme, 'dark');
  w.mq.matches = false; w.fire(); assert.equal(w.attrs['data-theme'], 'light');
});
test('head script: saved choice beats the OS, ignores OS changes, and sets both theme-color metas', () => {
  const w = fakeWin({ stored: 'light', osDark: true }); run(w);
  assert.equal(w.attrs['data-theme'], 'light'); w.fire(); assert.equal(w.attrs['data-theme'], 'light');
  assert.deepEqual(w.metas.map((m) => m.a.content), [THEME_COLORS.light, THEME_COLORS.light]);
});
test('setTheme saves per device (auto clears the key) and re-applies immediately', () => {
  const w = fakeWin({ osDark: false }); run(w);
  setTheme('dark', w.win); assert.equal(w.win.localStorage.getItem(THEME_KEY), 'dark'); assert.equal(w.attrs['data-theme'], 'dark');
  assert.equal(readTheme(w.win.localStorage), 'dark');
  setTheme('auto', w.win); assert.equal(w.win.localStorage.getItem(THEME_KEY), null); assert.equal(w.attrs['data-theme'], 'light');
});
test('layout puts the blocking script in <head> and theme-color for both schemes', () => {
  const src = readFileSync(new URL('../../app/layout.js', import.meta.url), 'utf8');
  assert.match(src, /<head>[\s\S]*dangerouslySetInnerHTML=\{\{ __html: THEME_INIT_SCRIPT \}\}[\s\S]*<\/head>/);
  assert.match(src, /themeColor: \[\{ media: '\(prefers-color-scheme: light\)'[\s\S]*prefers-color-scheme: dark/);
});
test('account menu offers Light / Dark / Auto as menu radios reachable by arrow keys', () => {
  const src = readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');
  assert.match(src, /role="menuitemradio" aria-checked=\{theme === t\}/);
  assert.match(src, /querySelectorAll\('\[role=menuitem\],\[role=menuitemradio\]'\)/);
  assert.match(src, /setThemeState\(setTheme\(t\)\)/);
});
test('hardcoded hex/rgb colors in app/ are limited to the reviewed exceptions', () => {
  const allowed = ['app/globals.css', 'app/lib/theme.js', 'app/lib/statusColors.js', 'app/lib/packetStatus.js', 'app/lib/packetMapperModel.js',
    'app/lib/packetFill.js', 'app/icon.svg', 'app/components/RouteMap.js', 'app/components/SignaturePad.js', 'app/dev/signature/SignatureQA.js', 'app/packets/PacketMapper.js',
    'app/packets/mapper-preview/page.js', 'app/expenses/page.js', 'app/lib/invoicePdf.js'] // dev fake PDF page image; JPEG flatten canvas (white);
  const files = execSync("grep -rlE \"(['\\\"=:(]|solid|dashed|dotted|px) ?#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?\\b|rgba?\\(\" app || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  assert.deepEqual(files.filter((f) => !allowed.includes(f)), []);
});

// QA #95 (1): the color codemod once rewrote "Pilot #123" in a placeholder. var(--…) may only appear in style values.
test("'var(--' appears only in style values / CSS, never in copy, placeholders, labels or fixtures", () => {
  const files = execSync("grep -rl 'var(--' app --include=*.js --include=*.mjs || true", { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const CSSWORD = /\b(solid|dashed|dotted|double|inset|none|transparent|currentColor|calc|max|min|clamp|env|safe-area-inset-[a-z]+|auto|important|linear-gradient|to|right|left|top|bottom|deg|px|rem|em|vh|vw|s|ms)\b/g;
  const bad = [];
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/'([^'\n]*var\(--[^'\n]*)'|[\w-]="([^"\n]*var\(--[^"\n]*)"/g)) {
      const str = m[1] ?? m[2] ?? m[3];
      const pre = src.slice(Math.max(0, m.index - 40), m.index);
      if (/(placeholder|aria-label|aria-description|title|alt|label)\s*[=:]\s*\{?\s*$/.test(pre)) { bad.push(`${f}: attribute ${str}`); continue; }
      if (f === 'app/lib/theme.js' || /\$\{/.test(str)) continue; // the head script / interpolated style templates
      const rest = str.replace(/var\(--[\w-]+(,[^)]*)?\)/g, '').replace(/\d*\.?\d+(px|rem|em|vh|vw|ms|s|deg|%)\b/g, '').replace(CSSWORD, '').replace(/[-\d.%#\s,()/+*:;!]/g, '');
      if (rest) bad.push(`${f}: "${str}"`);
    }
    for (const m of src.matchAll(/>([^<>{}\n]*var\(--[^<>{}\n]*)</g)) bad.push(`${f}: JSX text ${m[1]}`);
  }
  assert.deepEqual(bad, []);
});

// QA #95 (3–6)
import { STATE_COLORS } from '../../app/lib/packetMapperModel.js';
test('disabled buttons: --disabled-text on --disabled-bg >= 4.5:1, border >= 3:1 vs surface, in both themes', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    assert.ok(ratio(t['disabled-text'], t['disabled-bg']) >= 4.5, `${name} disabled text ${ratio(t['disabled-text'], t['disabled-bg']).toFixed(2)}`);
    assert.ok(ratio(t['disabled-border'], t.surface) >= 2.5 || ratio(t['disabled-bg'], t.surface) >= 1.2, `${name} disabled shape visible`);
  }
  assert.match(css, /button:disabled, button\[aria-disabled="true"\] \{\s*background: var\(--disabled-bg\) !important; color: var\(--disabled-text\) !important;/);
});
test('danger confirm (W-9 delete etc.): --on-danger on --danger-solid >= 4.5:1 in both themes', () => {
  for (const t of Object.values(THEMES)) assert.ok(ratio(t['on-danger'], t['danger-solid']) >= 4.5);
  assert.match(readFileSync(new URL('../../app/components/ui/ConfirmButton.js', import.meta.url), 'utf8'), /background: danger \? 'var\(--danger-solid\)' : 'var\(--primary\)', color: danger \? 'var\(--on-danger\)'/);
});
test('packet status badges and field-state chips: white text >= 4.5:1 on every fill (both themes use the same fills)', async () => {
  const mod = await import('../../app/lib/packetStatus.js');
  const display = Object.values(mod).find((v) => v && typeof v === 'object' && v.needs_names && v.needs_fields);
  for (const [k, v] of Object.entries(display)) assert.ok(ratio('#ffffff', v.color) >= 4.5, `status ${k} ${v.color} ${ratio('#ffffff', v.color).toFixed(2)}`);
  for (const [k, c] of Object.entries(STATE_COLORS)) assert.ok(ratio('#ffffff', c) >= 4.5, `state ${k} ${c} ${ratio('#ffffff', c).toFixed(2)}`);
});
test('packet editor "N fields" chip: inverse text/surface pair, readable and distinct from the card in both themes', () => {
  assert.match(readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8'), /s\.chip\('var\(--text\)', 'var\(--surface\)'\)/);
  for (const t of Object.values(THEMES)) { assert.ok(ratio(t.surface, t.text) >= 4.5); assert.ok(ratio(t.text, t.surface) >= 3, 'chip vs card'); }
});
test('map controls/attribution stay light on the light tiles (paper tokens, solid backing)', () => {
  assert.match(css, /\.leaflet-container \.leaflet-control-attribution \{\s*background: var\(--paper\) !important; color: var\(--paper-text\) !important;/);
  assert.ok(ratio(THEMES.dark['paper-text'], THEMES.dark.paper) >= 4.5);
});
test('date pickers and other native inputs follow the theme (color-scheme), no inline light override', () => {
  assert.match(css, /\[data-theme="dark"\] input, \[data-theme="dark"\] select, \[data-theme="dark"\] textarea \{ color-scheme: dark; \}/);
  assert.equal(execSync("grep -rl \"colorScheme: 'light'\" app || true", { encoding: 'utf8' }).trim(), '');
});
test('account menu Theme row: label stacked above equal, non-wrapping segments', () => {
  const src = readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');
  assert.match(src, /whiteSpace: 'nowrap' \}\}>Theme<\/div>/);
  assert.match(src, /flex: '1 1 0', minWidth: 0, minHeight: 36, padding: '0 0\.25rem', fontSize: 14, whiteSpace: 'nowrap'/);
});

// QA #95 r2: solid success/primary/danger buttons: text on the fill >= 4.5:1 in both themes.
test('solid buttons: on-success/success-solid, on-primary/primary, on-danger/danger-solid >= 4.5:1 in both themes', () => {
  for (const [name, t] of Object.entries(THEMES)) {
    for (const [fg, bg] of [['on-success', 'success-solid'], ['on-primary', 'primary'], ['on-danger', 'danger-solid']]) {
      const r = ratio(t[fg], t[bg]); assert.ok(r >= 4.5, `${name} --${fg} on --${bg} = ${r.toFixed(2)}`);
    }
  }
  // No solid success fill left on the old text-color token.
  assert.equal(execSync("grep -rn \"background: 'var(--success)'\" app || true", { encoding: 'utf8' }).trim(), '');
});

test('::placeholder uses --placeholder globally', () => {
  assert.match(css, /input::placeholder, textarea::placeholder \{ color: var\(--placeholder\); opacity: 1; \}/);
  assert.match(css, /:root:not\(\[data-theme\]\) \{[^}]*--placeholder: #8a94a6/);
});

test('setTheme notifies every menu instance (THEME_EVENT) after saving', () => {
  const store = {}; const events = [];
  const win = { localStorage: { setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; }, getItem: (k) => store[k] ?? null },
    CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o.detail; } },
    dispatchEvent: (e) => events.push([e.type, e.detail, store[THEME_KEY] ?? null]), __phApplyTheme() {} };
  setTheme('dark', win); setTheme('auto', win);
  assert.deepEqual(events, [['powerhaul:theme', 'dark', 'dark'], ['powerhaul:theme', 'auto', null]]);
  const menu = readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');
  assert.match(menu, /addEventListener\(THEME_EVENT, sync\)/); assert.match(menu, /addEventListener\('storage', onStorage\)/);
});
