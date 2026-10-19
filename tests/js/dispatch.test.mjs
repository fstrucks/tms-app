// Dispatch center (#94): lib helpers, the rate con route's role checks, and source-level guards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DISPATCH_ROLES, RATECON_ROLES, errorText, fetchDispatchContext, fetchDispatchLoads, loadToForm, formToPatch, notesMayShowPay,
  stopsToForm, formToStops, blankStop, moveStop, isoToLocal, localToIso, saveLoad, saveStops, rateConUrl, driverMap, STATUSES,
} from '../../app/lib/dispatch.js';
import { navTabs, DISPATCH_TAB } from '../../app/lib/dispatchNav.js';
import { GET } from '../../app/api/dispatch/loads/[id]/ratecon/route.js';

const LOAD = { id: 'L1', status: 'booked', broker_name: 'Demo Broker (FAKE)', broker_load_number: 'FAKE-1', rate: 1800, total_miles: 720, weight: 38500,
  commodity: null, equipment_type: 'Dry van', special_instructions: null, notes: 'Refs: PU# 1', assigned_driver_user_id: null, show_rate_to_driver: false,
  stops: [
    { id: 2, sequence: 2, stop_type: 'delivery', city: 'Phoenix', state: 'AZ', zip: '85043', appointment_start: '2026-10-20T15:00:00Z', timezone: 'America/Phoenix' },
    { id: 1, sequence: 1, stop_type: 'pickup', city: 'Ontario', state: 'CA', zip: '91761', appointment_start: '2026-10-19T15:00:00Z', timezone: 'America/Los_Angeles', pickup_number: 'PU-1' },
  ] };

test('roles: dispatch = management + dispatcher; rate con adds the owner; drivers never', () => {
  assert.deepEqual([...DISPATCH_ROLES], ['management', 'dispatcher']);
  assert.ok(RATECON_ROLES.has('owner') && RATECON_ROLES.has('dispatcher') && RATECON_ROLES.has('management') && !RATECON_ROLES.has('driver'));
  assert.deepEqual(STATUSES, ['booked', 'dispatched', 'in_transit', 'delivered', 'invoiced', 'paid', 'cancelled']);
});

test('formToPatch: only changed keys; trims; validates', () => {
  const f = loadToForm(LOAD);
  assert.deepEqual(formToPatch(f, LOAD).patch, {});
  const p = formToPatch({ ...f, notes: '  Refs: PU# 1  ', rate: '2,000', show_rate_to_driver: true, assigned_driver_user_id: 'd1', status: 'dispatched', total_miles: '' }, LOAD).patch;
  assert.deepEqual(p, { status: 'dispatched', rate: 2000, total_miles: null, assigned_driver_user_id: 'd1', show_rate_to_driver: true });
  assert.equal(formToPatch({ ...f, notes: '' }, LOAD).patch.notes, null);
  assert.ok(formToPatch({ ...f, rate: '' }, LOAD).errors.rate);
  assert.ok(formToPatch({ ...f, total_miles: '-3' }, LOAD).errors.total_miles);
  assert.ok(formToPatch({ ...f, status: 'lost' }, LOAD).errors.status);
});

test('pay-in-notes warning', () => {
  assert.equal(notesMayShowPay('Rate $1,800 all-in'), true);
  assert.equal(notesMayShowPay('Linehaul 1500'), true);
  assert.equal(notesMayShowPay('Refs: PU# 77310. Call 30 min out.'), false);
});

test('appointment times round-trip in the stop’s own zone (incl. DST fall-back)', () => {
  assert.equal(isoToLocal('2026-10-20T15:00:00Z', 'America/Phoenix'), '2026-10-20T08:00');
  assert.equal(localToIso('2026-10-20T08:00', 'America/Phoenix'), '2026-10-20T15:00:00.000Z');
  assert.equal(localToIso('2026-11-02T08:00', 'America/Chicago'), '2026-11-02T14:00:00.000Z');
  assert.equal(localToIso('', 'America/Chicago'), null);
  assert.equal(localToIso('nope', 'America/Chicago'), 'bad');
});

test('stops form: sorted, round-trips unchanged, payload keeps ids and order', () => {
  const list = stopsToForm(LOAD.stops);
  assert.deepEqual(list.map((x) => x.id), [1, 2]);
  const { errors, payload } = formToStops(list);
  assert.deepEqual(errors, {});
  assert.equal(payload[0].id, '1'); assert.equal(payload[0].appointment_start, '2026-10-19T15:00:00.000Z'); assert.equal(payload[0].pickup_number, 'PU-1');
  assert.equal(payload[1].pickup_number, null, 'deliveries never carry a pickup #');
  const three = [...list, { ...blankStop('delivery', 'America/Phoenix'), city: 'Tucson', state: 'az' }];
  const out = formToStops(moveStop(three, 2, -1)).payload;
  assert.deepEqual(out.map((x) => x.city), ['Ontario', 'Tucson', 'Phoenix']);
  assert.equal(out[1].id, undefined); assert.equal(out[1].state, 'AZ');
});

test('stops form: validation', () => {
  const list = stopsToForm(LOAD.stops);
  assert.match(formToStops([list[0]]).errors._list, /at least one pickup and one delivery/);
  assert.match(formToStops([list[0], { ...list[1], stop_type: 'pickup' }]).errors._list, /delivery/);
  const bad = formToStops([{ ...list[0], city: ' ', state: 'Cal', zip: '9' }, list[1]]);
  assert.ok(bad.errors[list[0].key].city && bad.errors[list[0].key].state && bad.errors[list[0].key].zip);
  const win = formToStops([{ ...list[0], appointment_end: '2026-10-19T07:00' }, list[1]]);
  assert.match(win.errors[list[0].key].appointment_end, /ends before/);
});

const sb = (handlers) => ({ rpc: async (n, a) => handlers[n](a) });
test('RPC wrappers: names, args, missing migration, error text', async () => {
  const missing = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
  assert.deepEqual(await fetchDispatchContext(sb({ dispatch_context: missing })), { setup: true });
  assert.deepEqual(await fetchDispatchLoads(sb({ dispatch_loads: (a) => (assert.deepEqual(a, { p_load: 'L1' }), { data: [{ id: 'L1' }], error: null }) }), 'L1'), { loads: [{ id: 'L1' }] });
  const r = await saveLoad(sb({ dispatch_update_load: (a) => (assert.deepEqual(a, { p_load: 'L1', p_patch: { notes: null } }), { data: null, error: { message: 'not_allowed' } }) }), 'L1', { notes: null });
  assert.equal(r.ok, false); assert.match(r.error, /Only management and dispatchers/);
  const st = await saveStops(sb({ dispatch_save_stops: () => ({ data: null, error: { message: 'missing_delivery' } }) }), 'L1', []);
  assert.equal(st.error, 'A load needs at least one delivery.');
  assert.equal(errorText({ message: 'weird' }), 'Couldn’t save. Please try again.');
  assert.deepEqual(driverMap([{ user_id: 'u', email: 'driver@example.com' }]), { u: 'driver@example.com' });
});

test('rateConUrl calls the server route with the bearer token', async () => {
  const supa = { auth: { getSession: async () => ({ data: { session: { access_token: 'tok' } } }) } };
  const r = await rateConUrl(supa, 'L1', async (url, o) => { assert.equal(url, '/api/dispatch/loads/L1/ratecon'); assert.equal(o.headers.Authorization, 'Bearer tok'); return { ok: true, json: async () => ({ url: 'https://signed.example/x' }) }; });
  assert.deepEqual(r, { url: 'https://signed.example/x' });
  const none = await rateConUrl({ auth: { getSession: async () => ({ data: {} }) } }, 'L1');
  assert.match(none.error, /session/);
});

test('nav: dispatchers get Dispatch in the Loads slot; others unchanged', () => {
  const tabs = [{ href: '/' }, { href: '/loads' }, { href: '/truck' }];
  assert.deepEqual(navTabs(tabs).map((t) => t.href), ['/', '/loads', '/truck']);
  assert.deepEqual(navTabs(tabs, { dispatcher: true }).map((t) => t.href), ['/', '/dispatch', '/truck']);
  assert.ok(DISPATCH_TAB.match('/dispatch/abc'));
});

// ---------- Rate con route ----------
const OWNER = '00000000-0000-4000-8000-00000000000a';
const LID = 'aaaaaaaa-0000-4000-8000-000000000001';
function svc({ load = { id: LID, user_id: OWNER }, docs = [{ file_path: `${OWNER}/rc.pdf` }], calls = [] } = {}) {
  const q = (table) => {
    const filters = [];
    const api = { select() { return api; }, eq(k, v) { filters.push([k, v]); return api; }, order() { return api; },
      limit() { calls.push([table, filters]); return Promise.resolve({ data: docs, error: null }); },
      maybeSingle() { calls.push([table, filters]); return Promise.resolve({ data: load, error: null }); } };
    return api;
  };
  return { from: q, storage: { from: () => ({ createSignedUrl: async (p, ttl) => { calls.push(['sign', p, ttl]); return { data: { signedUrl: `https://signed.example/${p}` }, error: null }; } }) } };
}
const req = (token = 'tok') => new Request(`http://x/api/dispatch/loads/${LID}/ratecon`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const uc = (role, error = null) => () => ({ rpc: async (n, a) => { assert.equal(n, 'packet_role'); assert.deepEqual(a, { p_owner: OWNER }); return { data: role, error }; } });

test('rate con route: dispatcher / management / owner get a 5-minute signed link from the owner folder', async () => {
  for (const role of ['dispatcher', 'management', 'owner']) {
    const calls = [];
    const r = await GET(req(), { params: { id: LID }, deps: { sb: svc({ calls }), mkUserClient: uc(role) } });
    assert.equal(r.status, 200, role);
    assert.deepEqual(await r.json(), { url: `https://signed.example/${OWNER}/rc.pdf` });
    const docQ = calls.find((c) => c[0] === 'documents');
    assert.deepEqual(docQ[1], [['load_id', LID], ['user_id', OWNER], ['doc_type', 'rate_confirmation']]);
    assert.deepEqual(calls.find((c) => c[0] === 'sign'), ['sign', `${OWNER}/rc.pdf`, 300]);
  }
});

test('rate con route: driver 403, outsider 404, no token 401, bad id 404, expired 401, no doc 404, foreign path 404', async () => {
  const run = (o) => GET(o.req || req(), { params: { id: o.id || LID }, deps: { sb: svc(o.svc), mkUserClient: o.uc || uc('dispatcher') } });
  assert.equal((await run({ uc: uc('driver') })).status, 403);
  assert.equal((await run({ uc: uc(null) })).status, 404);
  assert.equal((await run({ req: req(null) })).status, 401);
  assert.equal((await run({ id: 'not-a-uuid' })).status, 404);
  assert.equal((await run({ uc: uc(null, { code: 'PGRST301', message: 'JWT expired' }) })).status, 401);
  assert.equal((await run({ svc: { load: null } })).status, 404);
  assert.equal((await run({ svc: { docs: [] } })).status, 404);
  assert.equal((await run({ svc: { docs: [{ file_path: 'someone-else/rc.pdf' }] } })).status, 404);
});

// ---------- Source guards ----------
const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const list = read('app/dispatch/page.js');
const page = read('app/dispatch/[id]/page.js') + read('app/components/StopsEditor.js'); // stops editor extracted (load boards)
const lib = read('app/lib/dispatch.js');
const mig = read('supabase/migrations/20261018000700_dispatch_center.sql');

test('pages never touch the loads / stops tables directly (RPCs only)', () => {
  for (const src of [list, page, lib]) assert.doesNotMatch(src, /from\('(loads|stops)'\)/);
  assert.match(lib, /rpc\('dispatch_update_load'/); assert.match(lib, /rpc\('dispatch_save_stops'/); assert.match(lib, /rpcWithRetry\(supabase, 'dispatch_loads'/);
});

test('load page: notes editable with a pay warning, driver + flag, stops editor, rate con via the route', () => {
  assert.match(page, /Notes \(the assigned driver sees these\)/);
  assert.match(page, /notesMayShowPay\(form\.notes\) && !form\.show_rate_to_driver/);
  assert.match(page, /Show rate to driver/);
  assert.match(page, /\+ Add pickup/); assert.match(page, /\+ Add delivery/); assert.match(page, /Move stop/);
  assert.match(page, /load\.has_rate_con && <button/);
  assert.match(page, /rateConUrl\(supabase, id\)/);
});

test('migration: additive, own-row RLS untouched, every function role-checked and closed to anon', () => {
  assert.doesNotMatch(mig, /create policy|drop policy|alter table|drop table|grant (select|insert|update|delete)/i);
  assert.match(mig, /load_viewer_role\(l\.user_id\) in \('management', 'dispatcher'\)/);
  assert.equal((mig.match(/v_role not in \('owner', 'management', 'dispatcher'\)/g) || []).length, 2);
  for (const f of ['dispatch_context()', 'dispatch_loads(uuid)', 'dispatch_update_load(uuid, jsonb)', 'dispatch_save_stops(uuid, jsonb)'])
    assert.ok(mig.includes(`revoke execute on function public.${f} from public, anon;`), f);
  assert.match(mig, /security definer set search_path = public/);
  assert.match(mig, /where k = any \(allowed\) or k = 'id'/, 'stops: only allowed keys are written');
});

// ---------- #94 QA: Driver card fixes ----------
import { driverRateHelp, driverOptions, RATE_ON_TEXT, RATE_OFF_TEXT, FORMER_DRIVER_LABEL } from '../../app/lib/loadDriver.js';

test('Driver card helper text follows the switch (and says when it is not saved yet)', () => {
  assert.equal(driverRateHelp(false, false), RATE_OFF_TEXT);
  assert.equal(driverRateHelp(true, true), RATE_ON_TEXT);
  assert.equal(driverRateHelp(true, false), `${RATE_ON_TEXT} Not saved yet.`);
  assert.equal(driverRateHelp(false, true), `${RATE_OFF_TEXT} Not saved yet.`);
  assert.equal(driverRateHelp(true), RATE_ON_TEXT, 'new load form: no saved state');
  assert.match(RATE_ON_TEXT, /^On: the assigned driver sees the rate/);
});

test('Driver picker: loading until the list arrives; "no longer on the company" only after', () => {
  const D = [{ user_id: 'd1', email: 'driver.pat@example.com' }];
  assert.deepEqual(driverOptions([], 'd1', false), { loading: true, options: [] });
  assert.deepEqual(driverOptions(D, 'd1', true), { loading: false, options: D });
  assert.deepEqual(driverOptions(D, 'gone', true).options.at(-1), { user_id: 'gone', email: FORMER_DRIVER_LABEL });
  assert.deepEqual(driverOptions(D, '', true).options, D);
});

test('both Driver cards use the shared helpers; no hard-coded Off text or early "no longer" option', () => {
  const owner = read('app/components/LoadDriverSettings.js');
  const newLoad = read('app/loads/new/page.js');
  for (const src of [owner, page]) {
    assert.match(src, /driverOptions\(/); assert.match(src, /\.loading \? \(\s*<select disabled aria-busy="true" data-testid="driver-picker-loading"/);
    assert.match(src, /driverRateHelp\(/);
    assert.doesNotMatch(src, /Current driver \(no longer on the company\)/);
  }
  for (const src of [owner, page, newLoad]) assert.doesNotMatch(src, />Off: the assigned driver never sees/);
  assert.match(owner, /setChoices\(r\.choices \|\| \[\]\); setLoaded\(true\)/);
  assert.match(page, /setDrivers\(drv\.choices \|\| \[\]\);\s*setDriversLoaded\(true\)/);
});

// ---------- Taylor's driver QA (Oct 18): cookie session on the rate con route, role-appropriate /dispatch copy ----------
import { AUTH_COOKIE, authCookieString, cookieToken } from '../../app/lib/authCookie.js';
import { notMemberCopy } from '../../app/lib/dispatch.js';
import { linkBaseFor } from '../../app/lib/homeCurrentLoad.js';

const cookieReq = (cookie) => new Request(`http://x/api/dispatch/loads/${LID}/ratecon`, { headers: cookie ? { cookie } : {} });
const tokenSeen = (role) => { const seen = []; return { seen, mk: (t) => { seen.push(t); return uc(role)(); } }; };

test('rate con route opened directly in a tab (cookie only): driver 403, outsider 404, manager 200, signed out 401', async () => {
  const run = async (role, cookie) => { const u = tokenSeen(role); const r = await GET(cookieReq(cookie), { params: { id: LID }, deps: { sb: svc(), mkUserClient: u.mk } }); return { status: r.status, seen: u.seen }; };
  const c = `other=1; ${AUTH_COOKIE}=${encodeURIComponent('cookie.jwt.tok')}; x=y`;
  const d = await run('driver', c); assert.equal(d.status, 403); assert.deepEqual(d.seen, ['cookie.jwt.tok'], 'cookie token verified via the caller client');
  assert.equal((await run(null, c)).status, 404);
  assert.equal((await run('management', c)).status, 200);
  assert.equal((await run('driver', null)).status, 401, 'signed out: no header, no cookie');
  assert.equal((await run('driver', 'other=1')).status, 401, 'unrelated cookies only');
  assert.equal((await run('driver', `${AUTH_COOKIE}=`)).status, 401, 'cleared cookie');
});

test('rate con route: an expired cookie token is 401; a Bearer header wins over the cookie', async () => {
  const r = await GET(cookieReq(`${AUTH_COOKIE}=old`), { params: { id: LID }, deps: { sb: svc(), mkUserClient: uc(null, { code: 'PGRST301', message: 'JWT expired' }) } });
  assert.equal(r.status, 401);
  const u = tokenSeen('dispatcher');
  const both = new Request(`http://x/api/dispatch/loads/${LID}/ratecon`, { headers: { authorization: 'Bearer hdr', cookie: `${AUTH_COOKIE}=ck` } });
  await GET(both, { params: { id: LID }, deps: { sb: svc(), mkUserClient: u.mk } });
  assert.deepEqual(u.seen, ['hdr']);
});

test('auth cookie: scoped to /api/dispatch, HttpOnly, Lax, Secure on https, expires with the token, cleared on sign-out', () => {
  const now = Date.parse('2026-10-18T22:00:00-05:00');
  const set = authCookieString({ access_token: 'a.b.c', expires_at: now / 1000 + 600 }, { now });
  assert.equal(set, `${AUTH_COOKIE}=a.b.c; Max-Age=600; Path=/api/dispatch; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(authCookieString(null, { now }), `${AUTH_COOKIE}=; Max-Age=0; Path=/api/dispatch; HttpOnly; SameSite=Lax; Secure`);
  assert.match(authCookieString({ access_token: 'a', expires_at: now / 1000 - 5 }, { now }), /Max-Age=0/, 'expired token clears');
  assert.doesNotMatch(authCookieString({ access_token: 'a', expires_at: now / 1000 + 60 }, { now, https: false }), /Secure/);
  assert.equal(cookieToken(cookieReq(`${AUTH_COOKIE}=${encodeURIComponent('x.y.z')}`)), 'x.y.z');
  const nav = read('app/components/AppNav.js');
  assert.match(nav, /onAuthStateChange\(\(event, session\) => \{\s*syncAuthCookie\(session\);/, 'synced on every auth event (incl. refresh and sign-out)');
  assert.match(read('app/api/dispatch/loads/[id]/ratecon/route.js'), /const token = bearer\(req\) \|\| cookieToken\(req\);/);
});

test('/dispatch copy is role-appropriate (drivers are pointed to Home, not to Loads)', () => {
  assert.deepEqual(notMemberCopy(['driver']), { text: 'Your dispatcher manages loads. Your current load is on', href: '/', linkText: 'Home' });
  assert.equal(notMemberCopy(['owner']).href, '/loads');
  assert.equal(notMemberCopy(['owner', 'driver']).href, '/loads', 'owns a company: their own Loads');
  assert.equal(notMemberCopy([]).href, '/');
  for (const src of [list, page]) {
    assert.doesNotMatch(src, /Owners manage loads/);
    assert.match(src, /notMemberCopy\(acc\.roles\)/);
    assert.match(src, /data-testid="dispatch-not-member">\{state\.copy\.text\} <Link href=\{state\.copy\.href\}/);
  }
});

test('home card: no member ever gets a /loads/<id> link (per-load viewer_role decides, rows included)', () => {
  for (const audience of ['owner', 'member']) {
    assert.equal(linkBaseFor(audience, { viewer_role: 'driver' }), null);
    assert.equal(linkBaseFor(audience, { viewer_role: 'dispatcher' }), '/dispatch');
    assert.equal(linkBaseFor(audience, { viewer_role: 'management' }), '/dispatch');
  }
  assert.equal(linkBaseFor('member', {}), null, 'no viewer_role: members never link');
  assert.equal(linkBaseFor('owner', {}), '/loads', 'owner fallback select');
  const card = read('app/components/HomeCurrentLoad.js');
  const hrefs = card.match(/href=\{`[^`]*`\}|href="[^"]*"/g) || [];
  for (const h of hrefs) assert.ok(!/\/loads\//.test(h) || h === 'href="/loads/new"', `unexpected link ${h}`);
  assert.match(card, /const rowBase = linkBaseFor\(audience, l\);/, 'Up next rows decide per load');
  assert.match(card, /\{owner && \(\s*<div[^]*?href="\/loads\/new"/, '+ New load is owner-only');
  assert.match(card, /owner && base === '\/loads' && docPath/, 'owner Rate con only on the owner’s own load');
});
