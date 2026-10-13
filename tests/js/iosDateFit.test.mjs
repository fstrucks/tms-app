import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
const mileage = readFileSync(new URL('../../app/lib/mileage.js', import.meta.url), 'utf8');
test('date input drops native appearance and fits its cell (iOS Safari overlap)', () => {
  const rule = css.match(/input\[type=date\]\s*\{([^}]*)\}/)?.[1] || '';
  for (const d of ['-webkit-appearance: none', 'appearance: none', 'display: block', 'width: 100%', 'min-width: 0', 'max-width: 100%', 'box-sizing: border-box'])
    assert.ok(rule.includes(d), d);
  assert.match(css, /::-webkit-date-and-time-value\s*\{\s*text-align: left/);
});
test('Date/Type row: two minmax(0,1fr) columns, stacks only under 340px', () => {
  assert.match(mileage, /gridTemplateColumns: 'minmax\(0, 1fr\) minmax\(0, 1fr\)'/);
  assert.match(mileage, /className="form-grid-2">\s*<label style=\{st\.cell\}><span style=\{st\.label\}>Date/);
  assert.match(css, /@media \(max-width: 339px\)\s*\{\s*\.form-grid-2/);
});
