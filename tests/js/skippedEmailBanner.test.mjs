// "Skipped from email" banners: owner / management / dispatcher of the active company only. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { canSeeSkipped, fetchSkipped } from '../../app/lib/rateconDrafts.js';

const A = '00000000-0000-4000-8000-0000000000a1', B = '00000000-0000-4000-8000-0000000000b1';
const now = Date.parse('2026-10-20T20:00:00Z');
const rows = () => ({ inbound_emails: [
  { id: 'e1', owner_id: A, kind: 'ratecon', subject: 'FAKE rate con 1', received_at: '2026-10-20T10:00:00Z', rejected_attachments: [{ name: 'x.zip', reason: 'type' }] },
  { id: 'e2', owner_id: B, kind: 'ratecon', subject: 'OTHER co', received_at: '2026-10-20T11:00:00Z', rejected_attachments: [{ name: 'y.zip', reason: 'type' }] },
  { id: 'e3', owner_id: A, kind: 'packet', subject: 'packet', received_at: '2026-10-20T12:00:00Z', rejected_attachments: [] },
] });

test('roles: drivers never see skipped-email notices', () => {
  for (const r of ['owner', 'management', 'dispatcher']) assert.ok(canSeeSkipped(r));
  for (const r of ['driver', null, undefined, 'viewer']) assert.ok(!canSeeSkipped(r));
});

test('fetchSkipped: driver gets nothing and runs no query; others get only their company', async () => {
  const sb = fakeSupabase({ tables: rows() });
  let queried = 0; const from = sb.from.bind(sb); sb.from = (t) => { queried++; const q = from(t); q.gte = () => q; return q; }; // fake: gte no-op (all seeded rows are recent)
  assert.deepEqual(await fetchSkipped(sb, { role: 'driver', ownerId: A, now }), []);
  assert.deepEqual(await fetchSkipped(sb, { role: 'owner', ownerId: null, now }), []);
  assert.equal(queried, 0);
  for (const role of ['owner', 'management', 'dispatcher']) {
    assert.deepEqual((await fetchSkipped(sb, { role, ownerId: A, now })).map((r) => r.id), ['e1'], role);
  }
});

test('documents page: banners gated by role and loaded through fetchSkipped', () => {
  const page = readFileSync(new URL('../../app/documents/page.js', import.meta.url), 'utf8');
  assert.ok(!/from\('inbound_emails'\)/.test(page));
  assert.match(page, /fetchSkipped\(supabase, skipScopeRef\.current\)/);
  assert.match(page, /!isDriver && skipped\.map/);
});
