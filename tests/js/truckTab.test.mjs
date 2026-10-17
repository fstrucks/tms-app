import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { EXTRA_KEYS } from '../../app/lib/packetFieldNames.js';
import { TRUCK_FIELD_MAP, TRUCK_FIELD_KEYS, fieldValuesFromRows, columnsFromFieldValues, latestWeight, expiryBadge } from '../../app/lib/truckFields.js';

test('field keys are exactly the PR #67 packet names (driver/truck/trailer subset)', () => {
  assert.deepEqual(TRUCK_FIELD_KEYS, ['driver_name', 'truck_number', 'trailer_number', 'truck_plate', 'truck_plate_state', 'trailer_plate', 'trailer_plate_state']);
  for (const k of TRUCK_FIELD_KEYS) assert.ok(EXTRA_KEYS.includes(k), `${k} is a packet field name`);
});

test('keys map to existing columns (no renames)', () => {
  assert.deepEqual(TRUCK_FIELD_MAP.truck_number, { table: 'trucks', column: 'unit_number' });
  assert.deepEqual(TRUCK_FIELD_MAP.truck_plate, { table: 'trucks', column: 'license_plate' });
  assert.deepEqual(TRUCK_FIELD_MAP.truck_plate_state, { table: 'trucks', column: 'license_state' });
  assert.deepEqual(TRUCK_FIELD_MAP.trailer_number, { table: 'trailers', column: 'unit_number' });
  assert.deepEqual(TRUCK_FIELD_MAP.trailer_plate, { table: 'trailers', column: 'license_plate' });
  assert.deepEqual(TRUCK_FIELD_MAP.trailer_plate_state, { table: 'trailers', column: 'license_state' });
  assert.deepEqual(TRUCK_FIELD_MAP.driver_name, { table: 'drivers', column: 'name' });
});

test('rows → field values; missing rows give empty strings', () => {
  const v = fieldValuesFromRows({ truck: { unit_number: 104, license_plate: 'TEST104', license_state: 'CA' }, driver: { name: 'Pat' } });
  assert.deepEqual(v, { driver_name: 'Pat', truck_number: '104', trailer_number: '', truck_plate: 'TEST104', truck_plate_state: 'CA', trailer_plate: '', trailer_plate_state: '' });
  assert.equal(fieldValuesFromRows().truck_number, '');
});

test('field values → per-table column patch (trim, state upper-case, other tables ignored)', () => {
  const vals = { truck_number: ' 104 ', truck_plate_state: 'ca', trailer_plate: 'X1', driver_name: 'Pat', bogus: 'x', truck_plate: '' };
  assert.deepEqual(columnsFromFieldValues('trucks', vals), { unit_number: '104', license_state: 'CA', license_plate: null });
  assert.deepEqual(columnsFromFieldValues('trailers', vals), { license_plate: 'X1' });
  assert.deepEqual(columnsFromFieldValues('drivers', vals), { name: 'Pat' });
});

test('latest weight and expiry badges (30-day nudge, no grace for expiries)', () => {
  assert.equal(latestWeight([{ ticket_date: '2026-10-02', gross_weight_lb: 1 }, { ticket_date: '2026-10-16', gross_weight_lb: 2 }]).gross_weight_lb, 2);
  assert.equal(latestWeight([]), null);
  const t = '2026-10-17';
  assert.equal(expiryBadge('2027-03-01', t).stage, 'ok');
  assert.equal(expiryBadge('2026-11-16', t).stage, 'soon');
  assert.equal(expiryBadge('2026-11-02', t).label, 'Expires in 16 days');
  assert.equal(expiryBadge('2026-10-18', t).label, 'Expires tomorrow');
  assert.equal(expiryBadge('2026-10-17', t).stage, 'today');
  assert.equal(expiryBadge('2026-10-16', t).label, 'EXPIRED 1 day');
  assert.equal(expiryBadge('2026-02-30', t).stage, 'none');
});

test('/dev/truck-wireframe is gated off in production and makes no DB calls', () => {
  const src = readFileSync(new URL('../../app/dev/truck-wireframe/page.js', import.meta.url), 'utf8');
  assert.match(src, /if \(process\.env\.VERCEL_ENV === 'production'\) notFound\(\);/);
  assert.doesNotMatch(src, /^'use client'/);
  assert.doesNotMatch(src, /supabase|fetch\(|\/api\//);
  assert.match(src, /href="\/company"/);
});

test('truck tab migration is additive, extends trucks/trailers and uses own-row RLS', () => {
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const f = readdirSync(dir).find((n) => n.endsWith('_truck_tab.sql'));
  assert.equal(f, '20261017002100_truck_tab.sql');
  const sql = readFileSync(new URL(f, dir), 'utf8');
  assert.match(sql, /NEEDS SAM\/MARC OK/);
  assert.doesNotMatch(sql, /create table (if not exists )?public\.(trucks|trailers)\b/);
  assert.doesNotMatch(sql, /\b(drop table|drop column|rename)\b/i);
  assert.match(sql, /alter table public\.trucks\s+add column if not exists empty_weight_lb/);
  assert.match(sql, /user_id = \(select auth\.uid\(\)\)/);
});
