// Facility keep + autolink (migration 20261022230000). Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canLinkStop, reviewState, facilityStopName, facilityLooseKey } from '../../app/lib/facilityReviews.js';

const SQL = readFileSync(new URL('../../supabase/migrations/20261022230000_facility_keep_and_autolink.sql', import.meta.url), 'utf8');
const done = (o) => ({ stop_type: 'pickup', completion: 'done', facility_id: null, ...o });

test('address_line1 without digits is used as the name when company_name is empty', () => {
  assert.equal(facilityStopName({ company_name: null, address_line1: 'Acme Dock' }), 'Acme Dock');
  assert.equal(facilityStopName({ company_name: '', address_line1: '100 Main St' }), null);
  assert.equal(facilityStopName({ company_name: 'TEST Dock A', address_line1: 'Acme Dock' }), 'TEST Dock A');
  assert.equal(facilityLooseKey({ address_line1: 'Acme Dock', city: 'Portland', state: 'OR', zip: '97201' }), 'acme dock||portland|or|97201');
  assert.equal(facilityLooseKey({ company_name: 'Acme Dock', city: '', zip: '' }), null);
});

test('TEST-4701-shaped stop (name only in address_line1) can now be linked; street-only stop still missing', () => {
  const s = done({ company_name: null, address_line1: 'Acme Dock', city: 'Portland', state: 'OR', zip: '97201' });
  assert.equal(canLinkStop(s), true); assert.equal(reviewState(s), 'link');
  assert.equal(reviewState(done({ company_name: '', address_line1: '100 Main St', city: 'Boise' })), 'missing');
  assert.equal(reviewState(done({ company_name: 'X', city: '', zip: '' })), 'missing');
  assert.equal(reviewState(done({ facility_id: 'f' })), 'review');
});

test('migration: reviews survive deletion, loose fallback, dedupe, backfill, grants', () => {
  assert.match(SQL, /alter column stop_id drop not null/);
  assert.match(SQL, /drop constraint if exists facility_reviews_stop_id_fkey/);
  assert.match(SQL, /references public\.stops\(id\) on delete set null/);
  assert.doesNotMatch(SQL, /on delete cascade/);
  assert.doesNotMatch(SQL, /delete from/i);
  assert.match(SQL, /coalesce\(p_line1, ''\) !~ '\[0-9\]'/);
  // strict key first, then existing loose facility (fill address), then insert
  const r = SQL.slice(SQL.indexOf('function public.facility_resolve'));
  assert.ok(r.indexOf('f.key = v_strict') < r.indexOf('f.key = v_loose'));
  assert.match(r, /set address_line1 = v_street where id = v_id and address_line1 is null/);
  assert.match(SQL, /new\.facility_id := public\.facility_resolve/);
  assert.match(SQL, /v_id := public\.facility_resolve\(s\.company_name/);
  assert.match(SQL, /where s\.facility_id is null and s\.stop_type in \('pickup', 'delivery'\)/);
  assert.match(SQL, /revoke all on function public\.facility_resolve\(text, text, text, text, text\) from public/);
  assert.match(SQL, /grant execute on function public\.facility_link_stop\(uuid\) to service_role/);
  assert.doesNotMatch(SQL, /grant execute on function public\.facility_resolve[^;]*to (anon|authenticated)/);
  assert.match(SQL, /^begin;/m); assert.match(SQL, /^commit;/m);
});
