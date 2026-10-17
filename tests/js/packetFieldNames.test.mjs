// Taylor's #67 gap: detected fields like Contact name / Truck number / Trailer number could never be named,
// so packets stayed stuck at "Name N fields". Extra names, "Custom (type a name)" and "Leave blank / skip".
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EXTRA_KEYS, EXTRA_KEY_LABELS, SKIP_KEY, CUSTOM_OPTION, CUSTOM_LABEL, SKIP_LABEL, validateNameKey, nameOptions, selectValue, keyFromSelect, customKey, customName, isUnnamedKey } from '../../app/lib/packetFieldNames.js';
import { KEY_LABELS, fieldName, fieldState, summarize, updateField } from '../../app/lib/packetMapperModel.js';
import { applyEdit } from '../../app/lib/packetFieldEdits.js';
import { resolveFillValues } from '../../app/lib/packetFillValues.js';
import { packetDisplayStatus, fieldSummary } from '../../app/lib/packetStatus.js';
import { PROFILE_KEYS } from '../../app/lib/packetReader.js';
import { checkValue } from '../../app/lib/packetValues.js';

const enc = (v) => `enc(${v})`;
const BOX = [10, 10, 200, 40];

test('extra names: exact keys + labels, offered in the editor, not sent to the reader model', () => {
  assert.deepEqual(EXTRA_KEYS, ['contact_name', 'contact_phone', 'contact_email', 'driver_name', 'truck_number', 'trailer_number', 'truck_plate', 'truck_plate_state', 'trailer_plate', 'trailer_plate_state']);
  assert.equal(EXTRA_KEY_LABELS.contact_name, 'Contact name');
  assert.equal(EXTRA_KEY_LABELS.driver_name, 'Driver name');
  for (const k of EXTRA_KEYS) { assert.ok(KEY_LABELS[k]); assert.ok(!PROFILE_KEYS.includes(k)); }
  const opts = nameOptions(KEY_LABELS, 'text').flatMap((g) => g.options);
  for (const k of [...EXTRA_KEYS, 'legal_name', 'signature', SKIP_KEY, CUSTOM_OPTION]) assert.ok(opts.some((o) => o.value === k), k);
  assert.ok(!opts.some((o) => o.value === 'unknown'));
  assert.equal(opts.find((o) => o.value === CUSTOM_OPTION).label, 'Custom (type a name)');
  assert.equal(opts.find((o) => o.value === SKIP_KEY).label, 'Leave blank / skip');
  assert.equal(CUSTOM_LABEL, 'Custom (type a name)'); assert.equal(SKIP_LABEL, 'Leave blank / skip');
  // A signature box can't be skipped.
  assert.ok(!nameOptions(KEY_LABELS, 'signature').flatMap((g) => g.options).some((o) => o.value === SKIP_KEY));
});

test('server: extra / custom / skip names save (profile_key is free text, no SQL); junk still rejected', () => {
  for (const k of EXTRA_KEYS) assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: k }, null, { userId: 'u', encrypt: enc }).row.profile_key, k);
  assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'custom:  Dispatcher\n name ' }, null, { userId: 'u', encrypt: enc }).row.profile_key, 'custom:Dispatcher name');
  assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'custom:' + 'x'.repeat(200) }, null, { userId: 'u', encrypt: enc }).row.profile_key.length, 7 + 60);
  assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'custom:   ' }, null, { userId: 'u', encrypt: enc }).error, 'Type a name for the custom field.');
  assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'skip' }, null, { userId: 'u', encrypt: enc }).row.profile_key, 'skip');
  assert.match(applyEdit({ page: 1, kind: 'signature', box: BOX, profile_key: 'skip' }, null, { userId: 'u', encrypt: enc }).error, /signature box can’t be skipped/);
  assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'hack' }, null, { userId: 'u', encrypt: enc }).error, 'Unknown field name');
  assert.equal(applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'unknown' }, null, { userId: 'u', encrypt: enc }).error, 'Unknown field name');
  assert.deepEqual(validateNameKey(null, 'text'), { key: null });
  // Skipping clears any saved value (incl. a secret).
  const ex = { id: 'f1', page: 1, kind: 'text', box: BOX, profile_key: 'ein', value_ciphertext: 'c', value_last4: '6789', source: 'model' };
  const r = applyEdit({ id: 'f1', profile_key: 'skip' }, ex, { userId: 'u', encrypt: enc }).row;
  assert.deepEqual([r.profile_key, r.value_text, r.value_ciphertext, r.value_last4], ['skip', null, null, null]);
  // Typed values on extra/custom fields are stored as plain text (not secrets).
  const t = applyEdit({ page: 1, kind: 'text', box: BOX, profile_key: 'truck_number', value: ' 104 ' }, null, { userId: 'u', encrypt: enc }).row;
  assert.deepEqual([t.value_text, t.value_ciphertext], ['104', null]);
  assert.match(readFileSync(new URL('../../supabase/migrations/20261015001400_packet_fields.sql', import.meta.url), 'utf8'), /profile_key text,/);
});

test('names count as named: skip → "Left blank", custom needs a typed name; status no longer stuck', () => {
  assert.equal(fieldState({ kind: 'text', profile_key: 'skip' }), 'skip');
  assert.equal(fieldState({ kind: 'text', profile_key: 'truck_number' }), 'ok');
  assert.equal(fieldState({ kind: 'text', profile_key: 'custom:Dispatcher' }), 'ok');
  assert.equal(fieldState({ kind: 'text', profile_key: 'custom:' }), 'unmapped');
  assert.ok(isUnnamedKey('custom:  ') && isUnnamedKey(null) && !isUnnamedKey('skip'));
  const stuck = [{ profile_key: 'legal_name' }, { profile_key: null, label: 'Contact name' }, { profile_key: null, label: 'Truck number' }, { profile_key: null, label: 'Trailer number' }];
  assert.equal(packetDisplayStatus({ status: 'review' }, fieldSummary(stuck)).label, 'Name 3 fields');
  const fixed = [stuck[0], { profile_key: 'contact_name' }, { profile_key: 'custom:Truck #' }, { profile_key: 'skip' }];
  assert.equal(packetDisplayStatus({ status: 'review' }, fieldSummary(fixed)).key, 'ready');
  assert.deepEqual(summarize(fixed.map((f) => ({ kind: 'text', ...f }))), { total: 4, unmapped: 0, confirm: 0, check: 0, ok: 3, sign: 0, skip: 1 });
  assert.equal(fieldName('trailer_plate_state'), 'Trailer plate state');
  assert.equal(fieldName('custom:Dispatcher'), 'Dispatcher');
  assert.equal(fieldName('skip'), 'Leave blank / skip');
});

test('editor picker: Custom starts from the form label; skip drops the typed value', () => {
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: ' Dispatcher  name ', profile_key: null }), 'custom:Dispatcher name');
  assert.equal(keyFromSelect(CUSTOM_OPTION, { label: 'x', profile_key: 'custom:Kept' }), 'custom:Kept');
  assert.equal(keyFromSelect('', {}), null);
  assert.equal(keyFromSelect('driver_name', {}), 'driver_name');
  assert.equal(selectValue('custom:Anything'), CUSTOM_OPTION);
  assert.equal(selectValue(null), '');
  assert.equal(customName(customKey('  Dock  phone ')), 'Dock phone');
  const f = updateField({ id: 'a', kind: 'text', profile_key: 'truck_number', value: '104' }, { profile_key: 'skip' });
  assert.deepEqual([f.value, f.valueDirty, f.dirty], ['', true, true]);
  // Contact phone / email values get the same format checks as the company ones.
  assert.equal(checkValue('contact_phone', '555').ok, false);
  assert.equal(checkValue('contact_email', 'a@b.co').ok, true);
});

test('fill: extra / custom fields fill only what was typed (no profile mapping yet); skipped fields are never drawn', () => {
  const profile = { signer_name: 'Marc Brooks', phone: '5551234567', email: 'marc@fstrucks.com', legal_name: 'FS Trucks' };
  const rows = [
    { id: 'a', page: 1, kind: 'text', box: BOX, profile_key: 'contact_name' },
    { id: 'b', page: 1, kind: 'text', box: BOX, profile_key: 'contact_phone' },
    { id: 'c', page: 1, kind: 'text', box: BOX, profile_key: 'truck_number', value_text: '104' },
    { id: 'd', page: 1, kind: 'text', box: BOX, profile_key: 'custom:Dispatcher', value_text: 'Sam' },
    { id: 'e', page: 1, kind: 'date', box: BOX, profile_key: 'skip', value_text: 'old' },
    { id: 'f', page: 1, kind: 'text', box: BOX, profile_key: 'legal_name' },
  ];
  const { fields, missing } = resolveFillValues(rows, profile, { decrypt: (x) => x, today: new Date('2026-10-17T17:00:00Z') });
  const by = Object.fromEntries(fields.map((f) => [f.id, f.value]));
  assert.deepEqual(Object.keys(by), ['a', 'b', 'c', 'd', 'f']); // 'e' (skip) not drawn
  assert.deepEqual([by.a, by.b, by.c, by.d, by.f], [undefined, undefined, '104', 'Sam', 'FS Trucks']);
  assert.deepEqual(missing, []);
});

test('editor UI: grouped picker, custom name input, skip note, and clear Done vs Save changes wording', () => {
  const m = readFileSync(new URL('../../app/packets/PacketMapper.js', import.meta.url), 'utf8');
    assert.match(m, /nameSelectRows\(KEY_LABELS, f\.kind\)/);
  assert.match(m, /id="pf-custom"/);
  assert.match(m, /left blank on the filled PDF/);
  assert.match(m, /Tap Save changes at the bottom to keep/);
  assert.match(m, /Type a name for the custom field \(or pick another name\) before saving/);
  assert.doesNotMatch(m, /PROFILE_KEYS/);
});
