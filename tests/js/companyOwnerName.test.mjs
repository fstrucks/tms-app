// feat/profile-owner-name: Owner name saved on the company profile and used by the packet fill. FAKE data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRow, PROFILE_FIELDS } from '../../app/lib/companyProfile.js';
import { saveProfileGraceful, missingColumn } from '../../app/lib/companyProfileSave.js';
import { resolveFillValues } from '../../app/lib/packetFillValues.js';
import { nameOptions, nameGroup, validateNameKey, isFillableKey } from '../../app/lib/packetFieldNames.js';
import { KEY_LABELS } from '../../app/lib/packetMapperModel.js';

test('migration: idempotent nullable text column on public.company_profiles, nothing else', () => {
  const sql = readFileSync('supabase/migrations/20261018000200_company_owner_name.sql', 'utf8');
  const stmts = sql.split('\n').filter((l) => l.trim() && !l.trim().startsWith('--'));
  assert.deepEqual(stmts, ['alter table public.company_profiles add column if not exists owner_name text;']);
  assert.match(readFileSync('supabase/migrations/20261015001200_company_profiles.sql', 'utf8'), /create table if not exists public\.company_profiles/);
});

test('profile: Owner name is a profile field, trimmed, blank → null', () => {
  assert.ok(PROFILE_FIELDS.some(([k, l]) => k === 'owner_name' && l === 'Owner name'));
  assert.deepEqual(buildRow({ legal_name: 'FST Fake Trucking LLC', owner_name: '  Pat Fake Owner ' }), { legal_name: 'FST Fake Trucking LLC', owner_name: 'Pat Fake Owner' });
  assert.equal(buildRow({ owner_name: '   ' }).owner_name, null);
});

// saveProfile → update(row).eq().select().single(); fake fails while the column "doesn't exist".
function fakeSb({ hasColumn }) {
  const calls = [];
  return { calls, from: () => ({ update(row) { calls.push(row); return { eq: () => ({ select: () => ({ single: async () => (
    !hasColumn && 'owner_name' in row ? { data: null, error: { code: 'PGRST204', message: "Could not find the 'owner_name' column of 'company_profiles' in the schema cache" } }
      : { data: { id: 'p1', owner_id: 'u1', ...row }, error: null }) }) }) }; } }) };
}
const ctx = (sb) => ({ sb, user: { id: 'u1' }, profile: { id: 'p1', owner_id: 'u1' } });

test('graceful save: column missing → retried without owner_name, everything else saves (no 500)', async () => {
  const sb = fakeSb({ hasColumn: false });
  const r = await saveProfileGraceful(ctx(sb), { legal_name: 'FST Fake Trucking LLC', owner_name: 'Pat Fake Owner' });
  assert.equal(r.error, null); assert.deepEqual(r.dropped, ['owner_name']);
  assert.deepEqual(sb.calls, [{ legal_name: 'FST Fake Trucking LLC', owner_name: 'Pat Fake Owner' }, { legal_name: 'FST Fake Trucking LLC' }]);
  const ok = fakeSb({ hasColumn: true });
  const r2 = await saveProfileGraceful(ctx(ok), { legal_name: 'X', owner_name: 'Pat Fake Owner' });
  assert.deepEqual(r2.dropped, []); assert.equal(r2.data.owner_name, 'Pat Fake Owner'); assert.equal(ok.calls.length, 1);
  assert.equal(missingColumn({ code: '42703', message: 'column "owner_name" of relation "company_profiles" does not exist' }, 'owner_name'), true);
  assert.equal(missingColumn({ code: '42703', message: 'column "other" does not exist' }, 'owner_name'), false); // other errors are not swallowed
  assert.equal(missingColumn({ code: '42501', message: 'owner_name' }, 'owner_name'), false);
});

test('route: GET/PUT report whether the column exists; notice only when a typed owner name couldn’t be saved', () => {
  const src = readFileSync('app/api/company-profile/route.js', 'utf8');
  assert.match(src, /saveProfileGraceful\(c, row\)/);
  assert.match(src, /columns: columnsOf\(c\.profile\)/); assert.match(src, /owner_name: p \? 'owner_name' in p : null/);
  assert.match(src, /dropped\.includes\('owner_name'\) && row\.owner_name \? \{ notice: OWNER_NAME_PENDING \}/);
  const page = readFileSync('app/company/page.js', 'utf8');
  assert.match(page, /setMsg\(j\.notice \|\| 'Company profile saved\.'\)/);
  assert.match(page, /state\.columns\?\.owner_name === false/);
});

test('packet fill: owner_name fills from the profile; a typed value still wins; no column/blank → left blank as before', () => {
  const rows = [{ id: 'a', page: 1, kind: 'text', box: [0, 0, 10, 10], profile_key: 'owner_name' }];
  const fill = (profile, r = rows) => resolveFillValues(r, profile, { decrypt: () => '' }).fields[0].value;
  assert.equal(fill({ owner_name: 'Pat Fake Owner' }), 'Pat Fake Owner');
  assert.equal(fill({ owner_name: 'Pat Fake Owner' }, [{ ...rows[0], value_text: 'Typed Fake Name' }]), 'Typed Fake Name');
  assert.equal(fill({ legal_name: 'FST Fake Trucking LLC' }), undefined); // column not there yet → same as before
  assert.equal(fill({ owner_name: null }), undefined);
});

test('picker: Owner name is listed under Company profile (fills from the profile), not "you type the value"', () => {
  const groups = nameOptions(KEY_LABELS, 'text');
  assert.ok(groups[0].options.some((o) => o.value === 'owner_name' && o.label === 'Owner name'));
  assert.ok(!groups[1].options.some((o) => o.value === 'owner_name'));
  assert.equal(nameGroup(KEY_LABELS, 'text', 'owner_name'), 'Company profile');
  assert.deepEqual(validateNameKey('owner_name', 'text'), { key: 'owner_name' }); assert.equal(isFillableKey('owner_name'), true);
});
