import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCsv, detectMapping, buildRows, missingRequired, toInsertRows, parseDate, parseState, parseNum,
  mappingToNames, mappingFromNames, mappingFits, rowHash } from '../../app/lib/eldCsv.js';

const fx = (n) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), 'utf8');
const strip = (s) => s.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

test('sample HOS247-style CSV: auto-detects every column', () => {
  const { headers, rows } = parseCsv(fx('sample-ifta-miles-by-state.csv'));
  const m = detectMapping(headers);
  const name = (k) => headers[m[k]];
  assert.equal(name('date'), 'Date'); assert.equal(name('truck'), 'Vehicle'); assert.equal(name('state'), 'State');
  assert.equal(name('miles'), 'Miles'); assert.equal(name('start_odometer'), 'Start Odometer');
  assert.equal(name('end_odometer'), 'End Odometer'); assert.equal(name('fuel_gallons'), 'Fuel Gallons');
  assert.deepEqual(missingRequired(m), []);
  const built = buildRows(rows, m);
  assert.equal(built.length, rows.length);
  assert.ok(built.every((b) => b.errors.length === 0), JSON.stringify(built.filter((b) => b.errors.length)));
  assert.deepEqual(built[0].value, { entry_date: '2026-09-01', truck_label: 'Truck 101', jurisdiction: 'CA', miles: 312,
    start_odometer: 412850, end_odometer: 413162, fuel_gallons: 0, import_hash: built[0].value.import_hash });
  assert.equal(built[2].value.fuel_gallons, 118.4);
});

test('variant headers (semicolon, quoted, US dates, state names) map and validate', () => {
  const { headers, rows } = parseCsv(fx('eld-variant.csv'));
  const m = detectMapping(headers);
  assert.deepEqual(mappingToNames(m, headers), { date: 'Trip Date', truck: 'Unit #', state: 'Jurisdiction', miles: 'Distance (mi)',
    start_odometer: 'Odometer Begin', end_odometer: 'Odometer End', fuel_gallons: 'Gallons Purchased' });
  const b = buildRows(rows, m);
  assert.equal(b[0].value.jurisdiction, 'CA'); assert.equal(b[0].value.miles, 312);
  assert.equal(b[2].value.entry_date, '2026-09-02');
  assert.match(b[3].errors[0], /Bad date/);
  assert.match(b[4].errors[0], /Unknown state "ZZ"/);
  assert.ok(b[5].errors.includes('End odometer is less than start'));
  assert.equal(b[6].duplicate, true);
  // the same segment in both files hashes the same, despite different formatting
  const s = buildRows(parseCsv(fx('sample-ifta-miles-by-state.csv')).rows, detectMapping(parseCsv(fx('sample-ifta-miles-by-state.csv')).headers));
  assert.equal(b[0].value.import_hash.length, 16);
  assert.notEqual(b[0].value.import_hash, s[0].value.import_hash); // fuel 0 vs blank differs
  assert.equal(b[1].value.import_hash, rowHash({ ...s[1].value, fuel_gallons: null }));
});

test('miles-only file, mismatched miles vs odometer, missing required', () => {
  const { headers, rows } = parseCsv('Day,Truck,ST,Total Miles\n2026-09-05,7,TX,"1,204.6"\n2026-09-05,7,TX,0\n');
  const m = detectMapping(headers);
  assert.deepEqual(missingRequired(m), []);
  const b = buildRows(rows, m);
  assert.equal(b[0].value.miles, 1205); assert.equal(b[0].value.start_odometer, null);
  assert.match(b[1].errors[0], /greater than 0/);
  const mm = buildRows([['2026-09-01', 'CA', '10', '100', '200']], { date: 0, state: 1, miles: 2, start_odometer: 3, end_odometer: 4, truck: -1, fuel_gallons: -1 });
  assert.match(mm[0].errors[0], /don't match odometer/);
  assert.deepEqual(missingRequired({ date: 0, state: -1, miles: -1, start_odometer: 2, end_odometer: -1 }), ['State / jurisdiction', 'Miles (or both odometers)']);
});

test('parsers', () => {
  assert.equal(parseDate('2026-02-30'), null); assert.equal(parseDate('12/31/2026'), '2026-12-31');
  assert.equal(parseDate('2026-09-01T08:00:00Z'), '2026-09-01');
  assert.equal(parseState('new mexico'), 'NM'); assert.equal(parseState('on'), 'ON'); assert.equal(parseState('XX'), null);
  assert.equal(parseNum(''), null); assert.ok(Number.isNaN(parseNum('abc'))); assert.equal(parseNum('1,000 mi'), 1000);
  const p = parseCsv('\uFEFFa,"b ""q"", c"\r\n1,2\r\n\r\n');
  assert.deepEqual(p, { headers: ['a', 'b "q", c'], rows: [['1', '2']] });
});

test('saved mappings are stored by header name and reapplied after column reorder', () => {
  const names = { date: 'Date', state: 'State', miles: 'Miles', truck: null, start_odometer: null, end_odometer: null, fuel_gallons: null };
  const h2 = ['Miles', 'Extra', 'state', 'Date'];
  assert.ok(mappingFits(names, h2));
  assert.deepEqual(mappingFromNames(names, h2), { date: 3, truck: -1, state: 2, miles: 0, start_odometer: -1, end_odometer: -1, fuel_gallons: -1 });
  assert.equal(mappingFits(names, ['Date', 'Miles']), false);
});

test('insert rows: only valid, tagged with hash + source', () => {
  const { headers, rows } = parseCsv(fx('eld-variant.csv'));
  const out = toInsertRows(buildRows(rows, detectMapping(headers)), { userId: 'u1', sourceName: 'HOS247' });
  assert.equal(out.length, 3);
  assert.deepEqual(Object.keys(out[0]).sort(), ['end_odometer', 'entry_date', 'fuel_gallons', 'import_hash', 'import_source', 'jurisdiction', 'miles', 'notes', 'source', 'start_odometer', 'truck_label', 'user_id']);
  assert.equal(out[0].source, 'eld'); assert.equal(out[0].import_source, 'HOS247');
});

test('import UI: iOS-safe file input + upsert ignoring duplicates', () => {
  const ui = strip(readFileSync(new URL('../../app/mileage/import/EldImport.js', import.meta.url), 'utf8'));
  assert.match(ui, /<input id=\{fileId\} type="file"[^>]*style=\{VISUALLY_HIDDEN\}/);
  assert.match(ui, /<label htmlFor=\{fileId\}/);
  assert.doesNotMatch(ui, /\.click\(\)/); assert.doesNotMatch(ui, /display:\s*'none'/); assert.doesNotMatch(ui, /<input[^>]*\shidden[\s/>]/);
  assert.match(ui, /onConflict: 'user_id,import_hash', ignoreDuplicates: true/);
  const sql = readFileSync(new URL('../../supabase/migrations/20261014001100_eld_csv_import.sql', import.meta.url), 'utf8');
  assert.match(sql, /unique index if not exists mileage_entries_user_import_hash_key\s+on public\.mileage_entries \(user_id, import_hash\);/);
  assert.match(sql, /eld_import_mappings[\s\S]*enable row level security/);
});

test('post-import redirect URL + banner message', async () => {
  const { importedUrl, importedMessage } = await import('../../app/lib/eldCsv.js');
  assert.equal(importedUrl(14), '/mileage?imported=14');
  assert.equal(importedUrl(14, 2), '/mileage?imported=14&skipped=2');
  assert.equal(importedMessage('?imported=14'), 'Imported 14 rows.');
  assert.equal(importedMessage('?imported=1&skipped=3'), 'Imported 1 row. 3 skipped as already imported.');
  assert.equal(importedMessage('?imported=0&skipped=5'), 'Imported 0 rows. 5 skipped as already imported.');
  assert.equal(importedMessage(''), null);
  assert.equal(importedMessage('?imported=abc'), null);
  assert.equal(importedMessage('?imported=-1'), null);
});

test('import -> router.replace to Mileage; banner is dismissible and params are cleared', () => {
  const ui = strip(readFileSync(new URL('../../app/mileage/import/EldImport.js', import.meta.url), 'utf8'));
  assert.match(ui, /router\.replace\(importedUrl\(n, skipped\)\)/);
  // Mileage moved inside Stats (PR #69): /mileage redirects to /dashboard?view=mileage keeping ?imported=….
  const redirectPage = strip(readFileSync(new URL('../../app/mileage/page.js', import.meta.url), 'utf8'));
  assert.match(redirectPage, /redirect\(mileageRedirectUrl\(searchParams\)\)/);
  const page = strip(readFileSync(new URL('../../app/dashboard/MileagePanel.js', import.meta.url), 'utf8'));
  assert.match(page, /importedMessage\(window\.location\.search\)/);
  assert.match(page, /router\.replace\(MILEAGE_VIEW_URL, \{ scroll: false \}\)/);
  assert.match(page, /aria-label="Dismiss" onClick=\{\(\) => setImportNote\(null\)\}/);
});
