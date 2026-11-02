// Facility rating prompts (plan + Sam's review): who is asked, 9 AM next-day reminder in the stop's zone, the card is
// shown once and stays only for the rest of that local day, mutes, 30-day recent-review window. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import { shouldPromptUser, remindAtFor, cardState, localDate, validTz, FALLBACK_TZ, RECENT_REVIEW_DAYS } from '../../app/lib/facilityRatingPrompts.js';
import * as STOP from '../../app/api/loads/[id]/stops/[stopId]/route.js';
import * as RP from '../../app/api/rating-prompts/route.js';
import { EXPORT_TABLES } from '../../app/lib/companyExport.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const OWNER = '00000000-0000-4000-8000-0000000000a1', DRIVER = '00000000-0000-4000-8000-0000000000a2', DISP = '00000000-0000-4000-8000-0000000000a5', OTHER = '00000000-0000-4000-8000-0000000000a9';
const L1 = '00000000-0000-4000-8000-0000000000b1', L2 = '00000000-0000-4000-8000-0000000000b2';
const S1 = '00000000-0000-4000-8000-0000000000d1', S2 = '00000000-0000-4000-8000-0000000000d2', S3 = '00000000-0000-4000-8000-0000000000d3';
const F1 = '00000000-0000-4000-8000-0000000000f1', F2 = '00000000-0000-4000-8000-0000000000f2';
const NOW = Date.parse('2026-11-02T20:00:00Z'); // Mon Nov 2, 2:00 PM CST

test('who is asked: the assigned driver, or the owner on his own load with no driver; never staff / dispatchers', () => {
  assert.equal(shouldPromptUser({ user_id: OWNER, assigned_driver_user_id: DRIVER }, DRIVER), true);
  assert.equal(shouldPromptUser({ user_id: OWNER, assigned_driver_user_id: DRIVER }, OWNER), false);
  assert.equal(shouldPromptUser({ user_id: OWNER, assigned_driver_user_id: DRIVER }, DISP), false);
  assert.equal(shouldPromptUser({ user_id: OWNER, assigned_driver_user_id: null }, OWNER), true);
  assert.equal(shouldPromptUser({ user_id: OWNER, assigned_driver_user_id: null }, DISP), false);
  assert.equal(shouldPromptUser(null, OWNER), false);
});

test('remind_at: 9 AM the next day in the stop zone (fallback Central), DST-safe', () => {
  assert.equal(remindAtFor(new Date('2026-11-02T20:00:00Z'), 'America/Chicago').toISOString(), '2026-11-03T15:00:00.000Z');
  assert.equal(remindAtFor(new Date('2026-11-02T20:00:00Z'), 'America/Los_Angeles').toISOString(), '2026-11-03T17:00:00.000Z');
  assert.equal(remindAtFor(new Date('2026-11-02T20:00:00Z'), 'Not/AZone').toISOString(), '2026-11-03T15:00:00.000Z');
  assert.equal(remindAtFor(new Date('2026-11-02T20:00:00Z'), null).toISOString(), '2026-11-03T15:00:00.000Z');
  // Late evening local = next UTC day: still "tomorrow" in the stop zone (Nov 2 11:30 PM CST → Nov 3 9 AM).
  assert.equal(remindAtFor(new Date('2026-11-03T05:30:00Z'), 'America/Chicago').toISOString(), '2026-11-03T15:00:00.000Z');
  // DST ends Sun Nov 1 2026: marked Sat Oct 31 (CDT) → Nov 1 9 AM CST.
  assert.equal(remindAtFor(new Date('2026-10-31T18:00:00Z'), 'America/Chicago').toISOString(), '2026-11-01T15:00:00.000Z');
  // DST starts Sun Mar 8 2026: marked Sat Mar 7 8 PM CST → Mar 8 9 AM CDT.
  assert.equal(remindAtFor(new Date('2026-03-08T02:00:00Z'), 'America/Chicago').toISOString(), '2026-03-08T14:00:00.000Z');
  assert.equal(FALLBACK_TZ, 'America/Chicago'); assert.equal(RECENT_REVIEW_DAYS, 30);
  assert.ok(validTz('America/Denver')); assert.ok(!validTz('nope'));
});

test('card: first show, same-day reload still shown, next day gone (stop zone)', () => {
  const row = { status: 'pending', timezone: 'America/Chicago', remind_at: '2026-11-03T15:00:00Z', reminded_at: null };
  assert.equal(cardState(row, new Date('2026-11-03T14:59:00Z')), null, 'not due before 9 AM');
  assert.equal(cardState(row, new Date('2026-11-03T15:00:00Z')), 'first');
  assert.equal(cardState({ ...row, status: 'skipped' }, new Date('2026-11-03T16:00:00Z')), 'first', 'Skip on the first prompt still gets the reminder');
  const shown = { ...row, status: 'reminded', reminded_at: '2026-11-03T15:05:00Z' };
  assert.equal(cardState(shown, new Date('2026-11-03T18:00:00Z')), 'again', 'reload same afternoon');
  assert.equal(cardState(shown, new Date('2026-11-04T05:59:00Z')), 'again', '11:59 PM CST is still the same day');
  assert.equal(cardState(shown, new Date('2026-11-04T06:00:00Z')), null, 'midnight CST: gone');
  assert.equal(cardState(shown, new Date('2026-11-05T15:00:00Z')), null, 'never returns');
  assert.equal(cardState({ ...shown, timezone: 'America/New_York' }, new Date('2026-11-04T05:30:00Z')), null, '"today" is the row zone, not Central');
  assert.equal(cardState({ ...shown, timezone: 'Bad/Zone' }, new Date('2026-11-04T05:30:00Z')), 'again', 'bad zone → Central');
  for (const status of ['rated', 'dismissed']) assert.equal(cardState({ ...shown, status }, new Date('2026-11-03T18:00:00Z')), null);
  assert.equal(cardState({ ...row, reminded_at: '2026-11-03T15:05:00Z' }, new Date('2026-11-03T18:00:00Z')), null, 'pending with reminded_at is never re-shown');
});

test('card DST edge: shown on the 25-hour fall-back day stays until local midnight, then gone', () => {
  const shown = { status: 'reminded', timezone: 'America/Chicago', remind_at: '2026-11-01T05:00:00Z', reminded_at: '2026-11-01T05:30:00Z' }; // 12:30 AM CDT Nov 1
  assert.equal(localDate('2026-11-01T05:30:00Z', 'America/Chicago'), '2026-11-01');
  assert.equal(cardState(shown, new Date('2026-11-02T05:30:00Z')), 'again', '11:30 PM CST Nov 1 (24h later, same local day)');
  assert.equal(cardState(shown, new Date('2026-11-02T06:00:00Z')), null, 'Nov 2 12:00 AM CST');
  const spring = { ...shown, remind_at: '2026-03-08T14:00:00Z', reminded_at: '2026-03-08T14:00:00Z' }; // 9 AM CDT Mar 8
  assert.equal(cardState(spring, new Date('2026-03-09T04:59:00Z')), 'again', '11:59 PM CDT');
  assert.equal(cardState(spring, new Date('2026-03-09T05:00:00Z')), null, 'Mar 9 midnight CDT');
});

// ---- stop check-off route ----
const stop = (id, seq, type, extra = {}) => ({ id, load_id: L1, sequence: seq, stop_type: type, completed_at: null, completion: null, completed_by: null, facility_id: F1, timezone: 'America/Chicago', ...extra });
function scopeRole(uc, role) { const rpc = uc.rpc.bind(uc); uc.rpc = (fn, a) => (fn === 'packet_role' ? Promise.resolve({ data: a?.p_owner === OWNER ? role : null, error: null }) : rpc(fn, a)); }
function ctx(role, userId, { driver = DRIVER, tables = {}, missing = [] } = {}) {
  const st = [stop(S1, 1, 'pickup'), stop(S2, 2, 'delivery', { facility_id: F2, timezone: 'America/Los_Angeles' })];
  const svc = fakeSupabase({ missing, tables: {
    loads: [{ id: L1, user_id: OWNER, status: 'dispatched', assigned_driver_user_id: driver }], stops: st,
    facilities: [{ id: F1, name: 'Fake Cold Storage' }, { id: F2, name: 'Fake DC 9' }],
    facility_reviews: [], facility_rating_prompts: [], facility_rating_mutes: [], ...tables } });
  const from = svc.from.bind(svc);
  svc.from = (t) => {
    const q = from(t);
    if (t === 'loads') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data) r.data = { ...r.data, stops: svc.db.stops.filter((s) => s.load_id === r.data.id) }; return r; }; }
    return q;
  };
  const uc = fakeSupabase({ tables: { company_profiles: [{ id: 'p1', owner_id: OWNER }] }, user: { id: userId }, role });
  scopeRole(uc, role);
  return { svc, deps: { mkUserClient: () => uc, sb: svc, now: () => NOW } };
}
const hdr = { authorization: 'Bearer t', 'content-type': 'application/json' };
const mark = async (c, stopId, action = 'done') => { const r = await STOP.POST(new Request('http://x', { method: 'POST', headers: hdr, body: JSON.stringify({ action }) }), { params: { id: L1, stopId }, deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('mark done: assigned driver gets the prompt and a reminder row (stop zone, 9 AM next day)', async () => {
  const c = ctx('driver', DRIVER);
  const r = await mark(c, S1);
  assert.equal(r.status, 200); assert.equal(r.j.ratingPrompt, true);
  const rows = c.svc.db.facility_rating_prompts;
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0], id: undefined, created_at: undefined }, { id: undefined, created_at: undefined, user_id: DRIVER, load_id: L1, stop_id: S1, facility_id: F1, kind: 'pickup', status: 'pending', timezone: 'America/Chicago', remind_at: '2026-11-03T15:00:00.000Z' });
  await mark(c, S2);
  assert.equal(c.svc.db.facility_rating_prompts.find((x) => x.stop_id === S2).remind_at, '2026-11-03T17:00:00.000Z', 'LA stop → 9 AM Pacific');
});

test('mark done: staff / dispatcher on a driver load are not asked; owner with no driver is', async () => {
  for (const [role, uid] of [['owner', OWNER], ['dispatcher', DISP]]) {
    const c = ctx(role, uid);
    const r = await mark(c, S1);
    assert.equal(r.status, 200); assert.equal(r.j.ratingPrompt, undefined, role); assert.equal(c.svc.db.facility_rating_prompts.length, 0);
  }
  const c = ctx('owner', OWNER, { driver: null });
  assert.equal((await mark(c, S1)).j.ratingPrompt, true); assert.equal(c.svc.db.facility_rating_prompts[0].user_id, OWNER);
  const d = ctx('dispatcher', DISP, { driver: null });
  assert.equal((await mark(d, S1)).j.ratingPrompt, undefined, 'dispatcher on an owner-run load');
});

test('mark done: muted facility or a rating in the last 30 days → no prompt; older review → prompt', async () => {
  const m = ctx('driver', DRIVER, { tables: { facility_rating_mutes: [{ user_id: DRIVER, facility_id: F1 }] } });
  assert.equal((await mark(m, S1)).j.ratingPrompt, undefined); assert.equal(m.svc.db.facility_rating_prompts.length, 0);
  const recent = ctx('driver', DRIVER, { tables: { facility_reviews: [{ id: 'r1', author_id: DRIVER, facility_id: F1, stars: 3, updated_at: new Date(NOW - 29 * 864e5).toISOString() }] } });
  assert.equal((await mark(recent, S1)).j.ratingPrompt, undefined);
  const old = ctx('driver', DRIVER, { tables: { facility_reviews: [{ id: 'r1', author_id: DRIVER, facility_id: F1, stars: 3, updated_at: new Date(NOW - 31 * 864e5).toISOString() }] } });
  assert.equal((await mark(old, S1)).j.ratingPrompt, true);
  const other = ctx('driver', DRIVER, { tables: { facility_reviews: [{ id: 'r1', author_id: OTHER, facility_id: F1, stars: 3, updated_at: new Date(NOW).toISOString() }] } });
  assert.equal((await mark(other, S1)).j.ratingPrompt, true, 'someone else’s review does not count');
});

test('mark done: no facility → prompt (explains how to add one) but no reminder row; tables missing → check-off still OK', async () => {
  const c = ctx('driver', DRIVER, { tables: { stops: [stop(S1, 1, 'pickup', { facility_id: null })] } });
  assert.equal((await mark(c, S1)).j.ratingPrompt, true); assert.equal(c.svc.db.facility_rating_prompts.length, 0);
  const pre = ctx('driver', DRIVER, { missing: ['facility_rating_prompts', 'facility_rating_mutes'] });
  const r = await mark(pre, S1); assert.equal(r.status, 200); assert.equal(r.j.ok, true);
});

test('undo removes the open prompt; marking again starts fresh', async () => {
  const c = ctx('driver', DRIVER);
  await mark(c, S1); assert.equal(c.svc.db.facility_rating_prompts.length, 1);
  assert.equal((await mark(c, S1, 'undo')).status, 200); assert.equal(c.svc.db.facility_rating_prompts.length, 0);
  await mark(c, S1); assert.equal(c.svc.db.facility_rating_prompts.length, 1);
});

// ---- /api/rating-prompts ----
const row = (extra) => ({ id: `p-${extra.stop_id}`, user_id: DRIVER, load_id: L1, facility_id: F1, kind: 'pickup', status: 'pending', timezone: 'America/Chicago', remind_at: '2026-11-03T15:00:00.000Z', reminded_at: null, ...extra });
const at = (c, iso) => { c.deps.now = () => Date.parse(iso); return c; };
const list = async (c, q = '') => (await (await RP.GET(new Request(`http://x/api/rating-prompts${q}`, { headers: hdr }), { deps: c.deps })).json()).cards;
const act = async (c, stopId, action) => { const r = await RP.POST(new Request('http://x', { method: 'POST', headers: hdr, body: JSON.stringify({ stopId, action }) }), { deps: c.deps }); return { status: r.status, j: await r.json() }; };

test('reminder flow: due at 9 AM, shown → reminded, same-day reload still shown, next day gone', async () => {
  const c = ctx('driver', DRIVER, { tables: { facility_rating_prompts: [row({ stop_id: S1 }), row({ stop_id: S3, user_id: OTHER })] } });
  assert.deepEqual(await list(at(c, '2026-11-03T14:00:00Z')), [], 'before 9 AM');
  const first = await list(at(c, '2026-11-03T15:10:00Z'));
  assert.equal(first.length, 1, 'only my rows'); assert.equal(first[0].state, 'first'); assert.equal(first[0].facilityName, 'Fake Cold Storage');
  assert.equal((await act(c, S1, 'shown')).j.ok, true);
  const r = c.svc.db.facility_rating_prompts.find((x) => x.stop_id === S1);
  assert.equal(r.status, 'reminded'); assert.equal(r.reminded_at, '2026-11-03T15:10:00.000Z');
  await act(at(c, '2026-11-03T16:00:00Z'), S1, 'shown'); assert.equal(r.reminded_at, '2026-11-03T15:10:00.000Z', 'second shown keeps the first time');
  assert.equal((await list(at(c, '2026-11-03T22:00:00Z')))[0]?.state, 'again', 'reload same day');
  assert.deepEqual(await list(at(c, '2026-11-04T06:01:00Z')), [], 'next day (Central midnight) gone');
  assert.deepEqual(await list(at(c, '2026-11-09T15:00:00Z')), [], 'never returns');
  assert.equal(c.svc.db.facility_rating_prompts.find((x) => x.user_id === OTHER).status, 'pending', 'other user untouched');
});

test('reminder: loadId filter, Skip on the first prompt keeps the reminder, Skip on the reminder closes it', async () => {
  const c = ctx('driver', DRIVER, { tables: { facility_rating_prompts: [row({ stop_id: S1 }), row({ stop_id: S2, load_id: L2 })] } });
  at(c, '2026-11-03T15:30:00Z');
  assert.equal((await list(c, `?loadId=${L2}`)).length, 1);
  assert.equal((await act(c, S1, 'skip')).j.ok, true);
  assert.equal(c.svc.db.facility_rating_prompts.find((x) => x.stop_id === S1).status, 'skipped');
  assert.equal((await list(c)).length, 2, 'skipped is still due');
  await act(c, S1, 'dismiss');
  assert.equal(c.svc.db.facility_rating_prompts.find((x) => x.stop_id === S1).status, 'dismissed');
  assert.equal((await list(c)).length, 1);
  assert.equal((await act(c, S1, 'nope')).status, 400); assert.equal((await act(c, 'bad', 'skip')).status, 400);
});

test('Don’t ask about this facility again: mute + close every open prompt there; also hides the first prompt', async () => {
  const c = ctx('driver', DRIVER, { tables: { facility_rating_prompts: [row({ stop_id: S1 }), row({ stop_id: S3, load_id: L2 }), row({ stop_id: S2, facility_id: F2 })] } });
  assert.equal((await act(c, S1, 'dismiss_facility')).j.ok, true);
  assert.deepEqual(c.svc.db.facility_rating_mutes.map((m) => [m.user_id, m.facility_id]), [[DRIVER, F1]]);
  assert.deepEqual(c.svc.db.facility_rating_prompts.map((x) => x.status), ['dismissed', 'dismissed', 'pending']);
  assert.equal((await act(c, S1, 'dismiss_facility')).j.ok, true, 'idempotent');
  assert.equal(c.svc.db.facility_rating_mutes.length, 1);
  // No prompt row (first prompt): facility from the stop, only on a load the caller is asked on.
  const d = ctx('driver', DRIVER);
  const fs = d.svc.from.bind(d.svc);
  d.svc.from = (t) => { const q = fs(t); if (t === 'stops') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data) r.data = { ...r.data, loads: d.svc.db.loads.find((l) => l.id === r.data.load_id) }; return r; }; } return q; };
  assert.equal((await act(d, S2, 'dismiss_facility')).j.ok, true);
  assert.deepEqual(d.svc.db.facility_rating_mutes.map((m) => m.facility_id), [F2]);
  // dispatcher: never asked → nothing muted
  const e2 = ctx('dispatcher', DISP); const fe = e2.svc.from.bind(e2.svc);
  e2.svc.from = (t) => { const q = fe(t); if (t === 'stops') { const ms = q.maybeSingle.bind(q); q.maybeSingle = async () => { const r = await ms(); if (r.data) r.data = { ...r.data, loads: e2.svc.db.loads[0] }; return r; }; } return q; };
  assert.equal((await act(e2, S2, 'dismiss_facility')).status, 404); assert.equal(e2.svc.db.facility_rating_mutes.length, 0);
});

test('before the migration: GET → no cards, POST → ok:false (no error UI)', async () => {
  const c = ctx('driver', DRIVER, { missing: ['facility_rating_prompts'] });
  assert.deepEqual(await list(c), []);
  assert.deepEqual((await act(c, S1, 'skip')).j, { ok: false });
});

test('wiring: review save marks rated; UI asks only when the server says so; reminder on Home and load page; export list', () => {
  const rv = read('../../app/api/loads/[id]/stops/[stopId]/review/route.js');
  assert.match(rv, /if \(res\.data\.stars != null\) await markRated\(x\.svc, x\.c\.user\.id, x\.stop\.id\);/);
  const sa = read('../../app/components/StopActions.js');
  assert.match(sa, /r\.ratingPrompt/); assert.match(sa, /mode=\{reviewAuto \? 'auto' : undefined\}/);
  const fr = read('../../app/components/FacilityReview.js');
  assert.match(fr, /Don’t ask about this facility again/); assert.match(fr, /'dismiss_facility'/); assert.match(fr, /matchMedia\('\(max-width: 640px\)'\)/);
  assert.match(fr, /mode === 'auto' \? 'skip' : 'dismiss'/);
  const rem = read('../../app/components/FacilityRatingReminders.js');
  assert.match(rem, /action: 'shown'/); assert.match(rem, /c\.state === 'first'/);
  assert.match(read('../../app/page.js'), /<FacilityRatingReminders \/>/);
  assert.match(read('../../app/loads/[id]/page.js'), /<FacilityRatingReminders loadId=\{load\.id\} \/>/);
  for (const f of [fr, rem]) { assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(f), 'theme vars only'); assert.ok(!/\b(bot|AI)\b/.test(f.replace(/\/\/.*$/gm, '')), 'no bot / AI wording'); }
  const ex = EXPORT_TABLES.filter((t) => /^facility_rating_/.test(t.table)).map((t) => [t.table, t.scope, t.key]);
  assert.deepEqual(ex, [['facility_rating_prompts', 'members', 'user_id'], ['facility_rating_mutes', 'members', 'user_id']]);
});

test('SQL: additive, own-row read only, no functions / definer, writes by service role only', () => {
  const sql = read('../../supabase/migrations/20261102000100_facility_rating_prompts.sql');
  const code = sql.replace(/--.*$/gm, '');
  assert.ok(!/security definer|create (or replace )?function|alter table public\.(?!facility_rating_)|drop table|drop column|delete from|update public|insert into/i.test(code));
  assert.match(code, /grant select on public\.facility_rating_prompts to authenticated/);
  assert.ok(!/grant (insert|update|delete|all|execute)[^;]*to authenticated/i.test(code));
  assert.match(code, /using \(user_id = auth\.uid\(\)\)/);
  assert.match(code, /status in \('pending', 'skipped', 'reminded', 'rated', 'dismissed'\)/);
  assert.match(code, /timezone text not null default 'America\/Chicago'/);
  assert.match(code, /unique \(user_id, stop_id, kind\)/);
});
