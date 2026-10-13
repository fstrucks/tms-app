import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS_COLORS, UNKNOWN, statusColors, statusLabel, contrast } from '../../app/lib/statusColors.js';
const STATUSES = ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled']; // app/lib/loads.js (has JSX)

test('contrast: known WCAG values', () => {
  assert.equal(contrast('#000000', '#ffffff').toFixed(1), '21.0');
  assert.equal(contrast('#ffffff', '#ffffff'), 1);
});
test('every status (and unknown) is >= 4.5:1 in light and dark mode', () => {
  for (const [k, c] of [...Object.entries(STATUS_COLORS), ['unknown', UNKNOWN]])
    for (const mode of ['light', 'dark']) {
      const r = contrast(c[mode][0], c[mode][1]);
      assert.ok(r >= 4.5, `${k} ${mode}: ${r.toFixed(2)}`);
    }
});
test('every app status has its own entry; groups per pick 5A', () => {
  for (const st of STATUSES) assert.ok(STATUS_COLORS[st], st);
  const exact = { booked: ['#fef9c3', '#854d0e'], dispatched: ['#e0e7ff', '#3730a3'], in_transit: ['#dbeafe', '#1e40af'],
    delivered: ['#dcfce7', '#166534'], invoiced: ['#ccfbf1', '#115e59'], paid: ['#15803d', '#ffffff'], cancelled: ['#fee2e2', '#991b1b'] };
  for (const [k, v] of Object.entries(exact)) assert.deepEqual(STATUS_COLORS[k].light, v, k);
  for (const mode of ['light', 'dark']) {
    const bgs = STATUSES.map((k) => STATUS_COLORS[k][mode][0]);
    assert.equal(new Set(bgs).size, STATUSES.length, `${mode}: each status distinct`);
  }
});
test('unknown status -> gray fallback; labels are text', () => {
  assert.equal(statusColors('weird'), UNKNOWN);
  assert.equal(statusColors(null), UNKNOWN);
  assert.equal(statusColors('In Transit'), STATUS_COLORS.in_transit);
  assert.equal(statusLabel('in_transit'), 'In transit');
  assert.equal(statusLabel('tonu'), 'TONU');
  assert.equal(statusLabel('canceled'), 'Cancelled');
  assert.equal(statusLabel('paid'), 'Paid');
  assert.equal(statusLabel(''), 'Unknown');
  assert.equal(statusLabel('on_hold'), 'On hold');
});
