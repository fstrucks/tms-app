import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, detectMapping, buildRows, missingRequired, mappingToNames, parseDate } from '../../app/lib/eldCsv.js';

const load = (n) => parseCsv(readFileSync(new URL(`../fixtures/eld/${n}`, import.meta.url), 'utf8'));
const cases = {
  'hos247-ifta-miles-by-state.csv': { date: 'Date', truck: 'Truck', state: 'State', miles: 'Distance (mi)', start_odometer: 'Odometer Start', end_odometer: 'Odometer End', fuel_gallons: 'Fuel (gal)', rows: 5, total: 1172 },
  'motive-ifta-trips.csv': { date: 'date', truck: 'vehicle_number', state: 'jurisdiction', miles: 'distance', start_odometer: 'start_odometer', end_odometer: 'end_odometer', fuel_gallons: null, rows: 4, total: 775 },
  'samsara-ifta-vehicle-report.csv': { date: 'Month', truck: 'Vehicle', state: 'Jurisdiction', miles: 'Total Distance (mi)', start_odometer: null, end_odometer: null, fuel_gallons: 'Tax Paid Gallons', rows: 4, total: 3828 },
};

for (const [file, exp] of Object.entries(cases)) {
  test(`vendor fixture ${file}: auto-maps and parses`, () => {
    const { headers, rows } = load(file);
    const m = detectMapping(headers);
    const { rows: n, total, ...names } = exp;
    assert.deepEqual(mappingToNames(m, headers), names);
    assert.deepEqual(missingRequired(m), []);
    const built = buildRows(rows, m);
    assert.equal(built.length, n);
    assert.deepEqual(built.filter((b) => b.errors.length).map((b) => [b.line, b.errors]), []);
    assert.equal(built.reduce((t, b) => t + b.value.miles, 0), total);
    assert.ok(built.every((b) => /^TEST-|^FAKE-|^DEMO-/.test(b.value.truck_label)));
  });
}

test('month-only dates map to the 1st', () => {
  assert.equal(parseDate('2026-09'), '2026-09-01');
  assert.equal(parseDate('Sep 2026'), '2026-09-01');
  assert.equal(parseDate('September 2026'), '2026-09-01');
  assert.equal(parseDate('2026-13'), null);
});
