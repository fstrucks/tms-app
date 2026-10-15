import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { encryptField, decryptField, loadKey, PacketKeyError, normalizeEin, maskEin } from '../../app/lib/packetCrypto.js';
import { canEdit, canSign, canView, canUpload, roleFor, ROLES } from '../../app/lib/companyRoles.js';
import { buildRow, validateProfile, publicProfile } from '../../app/lib/companyProfile.js';

const KEY = randomBytes(32);
const FAKE_EIN = '000000001'; // fake test value only

test('encrypt/decrypt round-trip, random IV, no plaintext in ciphertext', () => {
  const a = encryptField(FAKE_EIN, KEY), b = encryptField(FAKE_EIN, KEY);
  assert.notEqual(a, b);
  assert.match(a, /^v1:/);
  assert.ok(!a.includes(FAKE_EIN));
  assert.equal(decryptField(a, KEY), FAKE_EIN);
  assert.equal(encryptField('', KEY), null);
  assert.equal(decryptField(null, KEY), null);
});
test('decrypt fails with wrong key or tampered data', () => {
  const c = encryptField(FAKE_EIN, KEY);
  assert.throws(() => decryptField(c, randomBytes(32)));
  const p = c.split(':'); p[3] = Buffer.from('999999999').toString('base64');
  assert.throws(() => decryptField(p.join(':'), KEY));
  assert.throws(() => decryptField('v0:x:y:z', KEY), /format/);
});
test('loadKey fails clearly when missing or wrong length', () => {
  assert.throws(() => loadKey(undefined), (e) => e instanceof PacketKeyError && /PACKET_ENCRYPTION_KEY is not set/.test(e.message));
  assert.throws(() => loadKey('  '), PacketKeyError);
  assert.throws(() => loadKey(randomBytes(16).toString('base64')), /32 bytes/);
  assert.equal(loadKey(KEY.toString('base64')).length, 32);
  assert.equal(loadKey(KEY.toString('hex')).length, 32);
});
test('encryptField without a key arg uses env and fails clearly when unset', () => {
  const old = process.env.PACKET_ENCRYPTION_KEY; delete process.env.PACKET_ENCRYPTION_KEY;
  try { assert.throws(() => encryptField(FAKE_EIN), /PACKET_ENCRYPTION_KEY/); }
  finally { if (old !== undefined) process.env.PACKET_ENCRYPTION_KEY = old; }
});
test('EIN normalize and mask', () => {
  assert.equal(normalizeEin('00-0000001'), FAKE_EIN);
  assert.equal(normalizeEin(''), null);
  assert.throws(() => normalizeEin('12-345'), /9 digits/);
  assert.equal(maskEin('0001'), '•••••0001');
});
test('roles: owner/dispatcher/management edit+sign; driver view/upload only', () => {
  for (const r of ['owner', 'dispatcher', 'management']) { assert.ok(canEdit(r)); assert.ok(canSign(r)); }
  assert.equal(canEdit('driver'), false); assert.equal(canSign('driver'), false);
  assert.ok(canView('driver')); assert.ok(canUpload('driver'));
  for (const r of [null, undefined, 'admin', '']) { assert.equal(canSign(r), false); assert.equal(canView(r), false); }
  assert.deepEqual(ROLES, ['owner', 'dispatcher', 'management', 'driver']);
});
test('roleFor: owner_id wins, member role otherwise, stranger null', () => {
  const p = { id: 'p1', owner_id: 'u-owner' };
  const m = [{ profile_id: 'p1', user_id: 'u-drv', role: 'driver' }, { profile_id: 'p2', user_id: 'u-x', role: 'owner' }];
  assert.equal(roleFor('u-owner', p, m), 'owner');
  assert.equal(roleFor('u-drv', p, m), 'driver');
  assert.equal(roleFor('u-x', p, m), null);
  assert.equal(roleFor(null, p, m), null);
});
test('buildRow encrypts EIN, keeps last4, drops unknown fields, never touches owner_id', () => {
  const row = buildRow({ legal_name: ' Test Freight LLC ', state: 'ca', ein: '00-0000001', owner_id: 'evil', is_admin: true }, KEY);
  assert.equal(row.legal_name, 'Test Freight LLC'); assert.equal(row.state, 'CA');
  assert.equal(row.ein_last4, '0001'); assert.equal(decryptField(row.ein_ciphertext, KEY), FAKE_EIN);
  assert.ok(!('owner_id' in row) && !('is_admin' in row) && !('ein' in row));
  assert.ok(!('ein_ciphertext' in buildRow({ legal_name: 'X' }, KEY)));
});
test('validateProfile and publicProfile hide ciphertext', () => {
  assert.ok(validateProfile({}).legal_name);
  assert.ok(validateProfile({ legal_name: 'X', ein: '123' }).ein);
  assert.deepEqual(validateProfile({ legal_name: 'Test Freight LLC', state: 'CA', postal_code: '90001', dot_number: '1234567', mc_number: 'MC-123456', email: 'test@example.com', ein: '00-0000001' }), {});
  const pub = publicProfile({ id: 'p', ein_ciphertext: 'v1:a:b:c', ein_last4: '0001', enc_key_version: 1 });
  assert.equal(pub.has_ein, true); assert.ok(!('ein_ciphertext' in pub));
});
test('migration is additive and has RLS + can-sign helpers', () => {
  const sql = readFileSync(new URL('../../supabase/migrations/20261015001200_company_profiles.sql', import.meta.url), 'utf8').toLowerCase();
  assert.ok(!/\b(drop table|drop column|alter table [^;]* drop|truncate|delete from|update public\.)/.test(sql));
  for (const s of ['enable row level security', 'company_can_sign', 'company_can_edit', "'owner', 'dispatcher', 'management', 'driver'", 'owner_id uuid not null', 'company_id uuid null'])
    assert.ok(sql.includes(s), s);
  assert.ok(!sql.includes('ein text'), 'no plaintext EIN column');
});
test('crypto module is not imported by client code', () => {
  const route = readFileSync(new URL('../../app/api/company-profile/route.js', import.meta.url), 'utf8');
  assert.match(route, /runtime = 'nodejs'/);
  assert.ok(!/NEXT_PUBLIC_PACKET/.test(route));
});
test('route gates signing on canSign and pins signature path to the signer', () => {
  const route = readFileSync(new URL('../../app/api/company-profile/route.js', import.meta.url), 'utf8');
  assert.match(route, /if \(!canSign\(c\.role\)\)/);
  assert.match(route, /if \(!canEdit\(c\.role\)\)/);
  assert.match(route, /startsWith\(`\$\{c\.user\.id\}\/company\/`\)/);
});
