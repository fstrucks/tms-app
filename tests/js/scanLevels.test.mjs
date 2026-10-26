// JPEG scans came out solid black (Taylor's retest of #153 at 5cd4b8e). Root cause: levelsLut stretched between the
// 2nd and 98th percentile grey. On a white page where ink is < 2% of pixels both percentiles are 255, so lo=255,
// hi=256 and paper (255) mapped to 0 (black). A flat photo (all ~140) did the same. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { levelsLut, LEVELS_MIN_RANGE } from '../../app/lib/scan.js';

// Grey buffer like the decoded fake POD: white page with ~1% black "text" and a little JPEG noise near white.
function page({ w = 300, h = 400, ink = 0.01, paper = 255 } = {}) {
  const g = new Uint8Array(w * h).fill(paper);
  let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < g.length; i++) { const r = rnd(); if (r < ink) g[i] = Math.floor(rnd() * 30); else if (r < ink + 0.01) g[i] = paper - 1 - Math.floor(rnd() * 3); }
  return g;
}
const apply = (g, lut) => { let s = 0, dark = 0; for (const v of g) { s += lut[v]; if (lut[v] < 64) dark++; } return { mean: s / g.length, dark: dark / g.length }; };

for (const mode of ['bw', 'color']) {
  test(`${mode}: white page with sparse dark text stays white, text stays dark`, () => {
    const g = page(); const lut = levelsLut(g, mode); const r = apply(g, lut);
    assert.ok(r.mean > 240, `mean luminance ${r.mean.toFixed(1)} (was ~1 before the fix)`);
    assert.equal(lut[255], 255); assert.ok(lut[10] < 40, 'ink dark');
    assert.ok(r.dark > 0.005 && r.dark < 0.05, `dark share ${r.dark}`);
  });
  test(`${mode}: flat grey photo (all 140) is not turned black`, () => {
    const g = new Uint8Array(640 * 480).fill(140); g[0] = 139; g[1] = 141;
    const r = apply(g, levelsLut(g, mode));
    assert.ok(r.mean > 200, `mean ${r.mean}`);
  });
  test(`${mode}: off-white paper (235) with text still reads white`, () => {
    const r = apply(page({ paper: 235 }), levelsLut(page({ paper: 235 }), mode));
    assert.ok(r.mean > 230, `mean ${r.mean}`);
  });
}

test('levels range is never narrower than LEVELS_MIN_RANGE and stays monotonic', () => {
  for (const paper of [255, 200, 140, 64]) {
    const lut = levelsLut(new Uint8Array(1000).fill(paper), 'bw');
    for (let i = 1; i < 256; i++) assert.ok(lut[i] >= lut[i - 1]);
    assert.ok(lut[paper] >= 250, `uniform ${paper} → ${lut[paper]}`);
  }
  assert.equal(LEVELS_MIN_RANGE, 64);
});
