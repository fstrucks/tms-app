// Facility page v2: wait times, facility notes, stop ratings, Open in Maps. Fake TEST data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { cleanFacilityNote, shapeWaitStats, fmtMinutes, ratingText, mapsUrl, facilityAddress, canAddFacilityNote, publicNote, PUBLIC_NOTE_FIELDS, hourLabel } from '../../app/lib/facilityPage.js';
import * as FAC from '../../app/api/facilities/[id]/route.js';
import * as NOTES from '../../app/api/facilities/[id]/notes/route.js';
import * as NREPORT from '../../app/api/facility-notes/[id]/report/route.js';

const SQL = readFileSync(new URL('../../supabase/migrations/20261022240000_facility_page_v2.sql', import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', OTHER = '00000000-0000-4000-8000-0000000000a9';
const F1 = '00000000-0000-4000-8000-0000000000f1', N1 = '00000000-0000-4000-8000-0000000000c1';

function ctx(role, userId, { notes = [], waitRows = [], missing = false } = {}) {
  const svc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }], facilities: [{ id: F1, name: 'TEST Dock A', address_line1: '100 Main St', city: 'Dallas', state: 'TX', zip: '75201' }],
    facility_reviews: [], facility_notes: notes, facility_note_reports: [] }, unique: { facility_note_reports: [{ cols: ['note_id', 'reporter_id'] }] } });
  svc.rpc = async (fn, a) => {
    if (missing && ['facility_wait_stats', 'facility_public_notes'].includes(fn)) return { data: null, error: { code: 'PGRST202' } };
    if (fn === 'facility_summaries') return { data: [{ facility_id: F1, name: 'TEST Dock A', city: 'Dallas', state: 'TX', avg_stars: null, review_count: 0 }], error: null };
    if (fn === 'facility_public_reviews') return { data: [], error: null };
    if (fn === 'facility_wait_stats') return { data: waitRows, error: null };
    if (fn === 'facility_public_notes') return { data: svc.db.facility_notes.filter((n) => n.facility_id === a.p_facility && !n.hidden).map(({ id, body, created_at }) => ({ id, body, created_at })), error: null };
    return { data: null, error: null };
  };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  const urpc = uc.rpc.bind(uc); uc.rpc = (fn, x) => (fn === 'packet_role' ? Promise.resolve({ data: x?.p_owner === OWNER ? role : null, error: null }) : urpc(fn, x));
  return { svc, deps: { mkUserClient: () => uc, sb: svc } };
}
const rq = (method, body) => new Request('http://x', { method, headers: { authorization: 'Bearer t', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const call = async (mod, m, c, params, body) => { const r = await mod[m](rq(m, body), { params, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('note filter: 300 chars, no phone / email / link / profanity; every role can add', () => {
  assert.deepEqual(cleanFacilityNote({ body: '  Lumper   available ' }).row, { body: 'Lumper available' });
  assert.match(cleanFacilityNote({ body: '' }).error, /Write a note/);
  assert.match(cleanFacilityNote({ body: 'x'.repeat(301) }).error, /300/);
  assert.match(cleanFacilityNote({ body: 'call 312-555-0199' }).error, /phone/);
  assert.match(cleanFacilityNote({ body: 'a@b.com' }).error, /email/);
  assert.match(cleanFacilityNote({ body: 'www.x.com' }).error, /link/);
  assert.match(cleanFacilityNote({ body: 'shit dock' }).error, /clean/);
  for (const r of ['owner', 'management', 'dispatcher', 'driver']) assert.ok(canAddFacilityNote(r));
  assert.ok(!canAddFacilityNote(null));
  assert.deepEqual(Object.keys(publicNote({ id: 'n', body: 'b', created_at: 'd', author_id: 'x', company_id: 'y' })), PUBLIC_NOTE_FIELDS);
});

test('wait stats: hides small buckets and the overall average under 3 visits', () => {
  const w = shapeWaitStats([{ kind: 'all', bucket: 0, samples: 7, avg_minutes: 95 }, { kind: 'hour', bucket: 14, samples: 4, avg_minutes: 80 },
    { kind: 'hour', bucket: 6, samples: 3, avg_minutes: 120 }, { kind: 'hour', bucket: 9, samples: 2, avg_minutes: 30 }, { kind: 'dow', bucket: 1, samples: 5, avg_minutes: 90 }]);
  assert.equal(w.avg, 95); assert.equal(w.samples, 7);
  assert.deepEqual(w.hourly.map((b) => b.label), ['6a', '2p']); assert.deepEqual(w.daily.map((b) => b.label), ['Mon']);
  assert.equal(shapeWaitStats([{ kind: 'all', bucket: 0, samples: 2, avg_minutes: null }]).avg, null);
  assert.equal(shapeWaitStats([]).avg, null);
  assert.equal(fmtMinutes(45), '45 min'); assert.equal(fmtMinutes(95), '1 hr 35 min'); assert.equal(fmtMinutes(120), '2 hr');
  assert.equal(hourLabel(0), '12a'); assert.equal(hourLabel(12), '12p');
});

test('stop rating text and Maps link', () => {
  assert.equal(ratingText({ avg: 3.24, count: 5 }), '3.2★ · 5 reviews');
  assert.equal(ratingText({ avg: 4, count: 1 }), '4.0★ · 1 review');
  assert.equal(ratingText({ avg: null, count: 0 }), null);
  const f = { name: 'TEST Dock A', address_line1: '100 Main St', city: 'Dallas', state: 'TX', zip: '75201' };
  assert.equal(facilityAddress(f), '100 Main St, Dallas, TX 75201');
  assert.equal(mapsUrl(f), 'https://www.google.com/maps/search/?api=1&query=TEST%20Dock%20A%2C%20100%20Main%20St%2C%20Dallas%2C%20TX%2075201');
  assert.match(mapsUrl({ name: 'TEST Warehouse', city: 'Boise', state: 'ID' }), /TEST%20Warehouse%2C%20Boise%2C%20ID$/);
});

test('facility GET: wait + notes (anonymous), and still works before the migration', async () => {
  const notes = [{ id: N1, facility_id: F1, author_id: OWNER, company_id: 'p1', body: 'Lumper available', hidden: false, created_at: '2026-10-22T18:00:00Z' }];
  let r = await call(FAC, 'GET', ctx('driver', OTHER, { notes, waitRows: [{ kind: 'all', bucket: 0, samples: 3, avg_minutes: 60 }] }), { id: F1 });
  assert.equal(r.status, 200); assert.equal(r.j.wait.avg, 60); assert.deepEqual(r.j.notes, [{ id: N1, body: 'Lumper available', created_at: '2026-10-22T18:00:00Z' }]);
  assert.equal(r.j.canAddNote, true); assert.ok(!JSON.stringify(r.j).includes(OWNER));
  r = await call(FAC, 'GET', ctx('driver', OTHER, { missing: true }), { id: F1 });
  assert.equal(r.status, 200); assert.equal(r.j.wait, null); assert.equal(r.j.notesSetupNeeded, true);
});

test('notes POST: saves anonymously, filter on server, unknown facility 404; report once', async () => {
  const c = ctx('driver', OTHER);
  let r = await call(NOTES, 'POST', c, { id: F1 }, { body: 'Check in at guard shack' });
  assert.equal(r.status, 200); assert.deepEqual(Object.keys(r.j.note), ['id', 'body', 'created_at']);
  assert.equal(c.svc.db.facility_notes[0].author_id, OTHER);
  r = await call(NOTES, 'POST', c, { id: F1 }, { body: 'call 312-555-0199' }); assert.equal(r.status, 400); assert.equal(r.j.reason, 'phone');
  r = await call(NOTES, 'POST', c, { id: '00000000-0000-4000-8000-0000000000ff' }, { body: 'ok' }); assert.equal(r.status, 404);
  const id = c.svc.db.facility_notes[0].id;
  r = await call(NREPORT, 'POST', c, { id }, { reason: 'TEST' }); assert.equal(r.status, 200);
  r = await call(NREPORT, 'POST', c, { id }, {}); assert.equal(r.status, 200);
  assert.equal(c.svc.db.facility_note_reports.length, 1);
});

test('migration: idempotent, aggregate-only, privacy floor, no client table grants, no data changes', () => {
  assert.match(SQL, /create table if not exists public\.facility_notes/);
  assert.match(SQL, /create or replace function public\.facility_wait_stats\(p_facility uuid\)\s*returns table \(kind text, bucket integer, samples integer, avg_minutes numeric\)/);
  assert.match(SQL, /count\(\*\) >= 3/); assert.match(SQL, /interval '24 hours'/); assert.match(SQL, /s\.completed_at >= s\.arrived_at/);
  assert.match(SQL, /coalesce\(nullif\(s\.timezone, ''\), public\.us_state_tz\(f\.state\), 'UTC'\)/);
  assert.match(SQL, /check \(length\(btrim\(body\)\) between 1 and 300\)/);
  assert.match(SQL, /revoke all on public\.facility_notes from authenticated/);
  assert.ok(!/grant (select|insert|update|delete)[^;]*facility_note/i.test(SQL));
  assert.ok(!/^\s*(insert|update|delete)\s/im.test(SQL.replace(/--.*$/gm, '')));
  assert.ok(!/returns table \([^)]*(stop_id|load_id|company_id|author_id)/.test(SQL));
});
