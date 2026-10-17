// Taylor's three low #67 nits: Custom pre-fill trailing colon, skipped rows losing their label, picker headings not showing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { labelToName, keyFromSelect, CUSTOM_OPTION, SKIP_KEY, nameSelectRows, nameGroup, isHeadingValue, nameOptions, validateNameKey } from '../../app/lib/packetFieldNames.js';
import { KEY_LABELS, rowName, fieldState } from '../../app/lib/packetMapperModel.js';

test('Custom pre-fill strips trailing colons and whitespace from the form label', () => {
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: 'Contact name:', profile_key: null }), 'custom:Contact name');
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: '  Trailer #  :  ', profile_key: null }), 'custom:Trailer #');
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: 'Dispatcher::\n', profile_key: null }), 'custom:Dispatcher');
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: 'Name：', profile_key: null }), 'custom:Name'); // full-width colon
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: 'Time: 10:30', profile_key: null }), 'custom:Time: 10:30'); // inner colons kept
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: ':', profile_key: null }), 'custom:'); // nothing left → still unnamed
  assert.equal(labelToName(null), '');
  // An already-typed custom name is kept.
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: 'Contact name:', profile_key: 'custom:Mine' }), 'custom:Mine');
  assert.deepEqual(validateNameKey(keyFromSelect(CUSTOM_OPTION, { label: 'Contact name:' }), 'text'), { key: 'custom:Contact name' });
});

test('a skipped row keeps the field’s original label next to the grey Left blank chip', () => {
  const f = { profile_key: SKIP_KEY, label: 'Trailer number:', kind: 'text' };
  assert.equal(rowName(f), 'Trailer number');
  assert.equal(fieldState(f), 'skip');
  assert.equal(rowName({ profile_key: SKIP_KEY, label: '' }), 'Unnamed field');
  assert.notEqual(rowName(f), 'Leave blank / skip');
  // Other rows unchanged: the picked name wins, then the label, then "Unnamed field".
  assert.equal(rowName({ profile_key: 'truck_number', label: 'Truck #:' }), 'Truck number');
  assert.equal(rowName({ profile_key: 'custom:Dispatcher', label: 'x' }), 'Dispatcher');
  assert.equal(rowName({ profile_key: null, label: 'Contact name:' }), 'Contact name');
  assert.equal(rowName({ profile_key: null, label: '' }), 'Unnamed field');
  const m = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
  assert.match(m, /\{rowName\(f\)\}/);
  assert.match(m, /aria-label=\{`\$\{rowName\(f\)\}: \$\{STATE_TEXT\[st\]\}`\}/);
  assert.match(m, /skip: 'Left blank'/);
});

test('picker headings are visible disabled rows (work in iOS Safari), one per group, never selectable', () => {
  const rows = nameSelectRows(KEY_LABELS, 'text');
  const heads = rows.filter((r) => r.heading);
  assert.deepEqual(heads.map((h) => h.label), nameOptions(KEY_LABELS, 'text').map((g) => `— ${g.group} —`));
  assert.equal(heads.length, 3);
  assert.ok(heads.every((h) => h.disabled && isHeadingValue(h.value)));
  assert.equal(rows[0].heading, true); // a heading comes before the first option
  // Every real option is still there, in order, after its heading.
  assert.deepEqual(rows.filter((r) => !r.heading).map((r) => r.value), nameOptions(KEY_LABELS, 'text').flatMap((g) => g.options.map((o) => o.value)));
  // Picking a heading (if a browser ever let you) never changes the name; headings never validate.
  assert.equal(keyFromSelect(heads[0].value, { profile_key: 'phone' }), 'phone');
  assert.equal(keyFromSelect(heads[0].value, {}), null);
  assert.equal(validateNameKey(heads[0].value, 'text').error, 'Unknown field name');
  // Visible group line under the picker.
  assert.equal(nameGroup(KEY_LABELS, 'text', 'legal_name'), 'Company profile');
  assert.equal(nameGroup(KEY_LABELS, 'text', 'truck_number'), 'Contact, driver & equipment (you type the value)');
  assert.equal(nameGroup(KEY_LABELS, 'text', 'custom:X'), 'Other');
  assert.equal(nameGroup(KEY_LABELS, 'text', null), '');
  const m = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
  assert.match(m, /disabled data-heading="1"/);
  assert.match(m, /data-testid="name-group"/);
  assert.doesNotMatch(m, /<optgroup/);
});
