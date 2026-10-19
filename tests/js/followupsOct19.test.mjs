// Follow-up PR (Oct 19, after #94 / #96 / #97): HttpOnly dispatch cookie via a server route, dispatch retry, role state
// after sign-in, ?next after sign-out, Team row role, role-confirm reachability, disabled-button contrast, copy.
// All data here is fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { POST, DELETE } from '../../app/api/dispatch/session/route.js';
import { AUTH_COOKIE, AUTH_SESSION_URL, syncAuthCookie, resetAuthCookieSync, sameOrigin, isHttps } from '../../app/lib/authCookie.js';
import { isTransientError, rpcWithRetry, fetchDispatchContext, fetchDispatchLoads, DISPATCH_LOAD_ERROR } from '../../app/lib/dispatch.js';
import { nextAfterSignIn, rememberSignOutNext, SIGNOUT_NEXT_KEY, SIGNOUT_NEXT_TTL_MS, DEFAULT_NEXT } from '../../app/lib/safeNext.js';
import { dispatcherStatus, shouldRecheck, checkUntilDefinite, rememberRole, recallRole, forgetRole, ROLE_RETRY_MS } from '../../app/lib/roleRefresh.js';
import { applyRoleResult } from '../../app/lib/memberRoles.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-19T11:00:00-05:00');
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (claims) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.fakesig`; // never a real token
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

// ---------- 3. ph_dispatch_at: HttpOnly, set by the server after verifying the token ----------
const authClient = (result) => () => ({ auth: { getUser: async () => (typeof result === 'function' ? result() : result) } });
const sessReq = ({ token, method = 'POST', proto = 'https', origin, site } = {}) => new Request('http://app.test/api/dispatch/session', {
  method, headers: { host: 'app.test', 'x-forwarded-proto': proto, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(origin ? { origin } : {}), ...(site ? { 'sec-fetch-site': site } : {}) },
});

test('session route POST: verified token → HttpOnly; Secure; SameSite=Lax; Path=/api/dispatch cookie; token never echoed', async () => {
  const tok = fakeJwt({ sub: U1, exp: NOW / 1000 + 900, role: 'authenticated' });
  const r = await POST(sessReq({ token: tok, origin: 'https://app.test', site: 'same-origin' }), { deps: { mkUserClient: authClient({ data: { user: { id: U1 } }, error: null }), now: NOW } });
  assert.equal(r.status, 200);
  const c = r.headers.get('set-cookie');
  assert.equal(c, `${AUTH_COOKIE}=${encodeURIComponent(tok)}; Max-Age=900; Path=/api/dispatch; HttpOnly; SameSite=Lax; Secure`);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(!(await r.text()).includes(tok), 'body never carries the token');
});

test('session route POST: no token / rejected token → 401 + cleared cookie; Auth down → 503 and the cookie is left alone', async () => {
  const cleared = `${AUTH_COOKIE}=; Max-Age=0; Path=/api/dispatch; HttpOnly; SameSite=Lax; Secure`;
  const none = await POST(sessReq({}), { deps: { mkUserClient: authClient({ data: { user: { id: U1 } } }) } });
  assert.equal(none.status, 401); assert.equal(none.headers.get('set-cookie'), cleared);
  const bad = await POST(sessReq({ token: fakeJwt({ sub: U1, exp: NOW / 1000 + 60 }) }), { deps: { mkUserClient: authClient({ data: { user: null }, error: { status: 401, message: 'invalid JWT' } }) } });
  assert.equal(bad.status, 401); assert.equal(bad.headers.get('set-cookie'), cleared);
  const down = await POST(sessReq({ token: fakeJwt({ sub: U1, exp: NOW / 1000 + 60 }) }), { deps: { authRetryMs: 0, mkUserClient: authClient({ data: null, error: { status: 503, message: 'upstream unavailable' } }) } });
  assert.equal(down.status, 503); assert.equal(down.headers.get('set-cookie'), null);
  const other = await POST(sessReq({ token: fakeJwt({ sub: U2, exp: NOW / 1000 + 60 }) }), { deps: { mkUserClient: authClient({ data: { user: { id: U1 } } }), now: NOW } });
  assert.equal(other.status, 401, 'token subject must be the verified user');
  const expired = await POST(sessReq({ token: fakeJwt({ sub: U1, exp: NOW / 1000 - 5 }) }), { deps: { mkUserClient: authClient({ data: { user: { id: U1 } } }), now: NOW } });
  assert.equal(expired.status, 401); assert.equal(expired.headers.get('set-cookie'), cleared);
});

test('session route: cross-site calls refused; http dev drops Secure only; DELETE clears', async () => {
  const ok = authClient({ data: { user: { id: U1 } } });
  const tok = fakeJwt({ sub: U1, exp: NOW / 1000 + 60 });
  assert.equal((await POST(sessReq({ token: tok, origin: 'https://evil.test' }), { deps: { mkUserClient: ok, now: NOW } })).status, 403);
  assert.equal((await POST(sessReq({ token: tok, site: 'cross-site' }), { deps: { mkUserClient: ok, now: NOW } })).status, 403);
  const dev = await POST(sessReq({ token: tok, proto: 'http' }), { deps: { mkUserClient: ok, now: NOW } });
  assert.match(dev.headers.get('set-cookie'), /; HttpOnly; SameSite=Lax$/);
  const del = await DELETE(sessReq({ method: 'DELETE' }));
  assert.equal(del.status, 200); assert.equal(del.headers.get('set-cookie'), `${AUTH_COOKIE}=; Max-Age=0; Path=/api/dispatch; HttpOnly; SameSite=Lax; Secure`);
  assert.equal((await DELETE(sessReq({ method: 'DELETE', origin: 'https://evil.test' }))).status, 403);
  assert.equal(isHttps(new Request('https://x.test/a')), true);
  assert.equal(sameOrigin(new Request('https://x.test/a')), true, 'no Origin header (server-side caller) is allowed');
});

test('browser side: syncAuthCookie calls the server route (POST with Bearer / DELETE), once per token, in order; no document.cookie anywhere', async () => {
  const hadWindow = 'window' in globalThis; globalThis.window = globalThis.window || {};
  try {
    resetAuthCookieSync();
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push([url, init.method, init.headers?.authorization || null]); await new Promise((r) => setTimeout(r, init.method === 'POST' ? 5 : 0)); return { ok: true }; };
    const p1 = syncAuthCookie({ access_token: 'fake.a' }, { fetchImpl });
    const p2 = syncAuthCookie({ access_token: 'fake.a' }, { fetchImpl });
    const p3 = syncAuthCookie(null, { fetchImpl });
    await Promise.all([p1, p2, p3]);
    assert.deepEqual(calls, [[AUTH_SESSION_URL, 'POST', 'Bearer fake.a'], [AUTH_SESSION_URL, 'DELETE', null]], 'repeat token skipped; clear after set');
    const failing = async () => ({ ok: false });
    assert.equal(await syncAuthCookie({ access_token: 'fake.b' }, { fetchImpl: failing }), false);
    calls.length = 0;
    await syncAuthCookie({ access_token: 'fake.b' }, { fetchImpl });
    assert.equal(calls.length, 1, 'a failed set is retried on the next auth event');
  } finally { if (!hadWindow) delete globalThis.window; resetAuthCookieSync(); }
  const hits = execSync('grep -rn "document\\.cookie" app || true', { encoding: 'utf8' }).trim();
  assert.equal(hits, '', 'no client JS writes cookies');
  assert.match(read('app/components/AppNav.js'), /syncAuthCookie\(session\); \/\/ server sets \/ clears the HttpOnly cookie/);
  assert.match(read('app/api/dispatch/loads/[id]/ratecon/route.js'), /const token = bearer\(req\) \|\| cookieToken\(req\);/, 'rate con route still verifies the cookie token like a Bearer token');
});

// ---------- 10. /dispatch: one automatic retry on a dropped connection + Retry button ----------
const rpcSeq = (answers) => { const calls = []; return { calls, rpc: async (fn, args) => { calls.push([fn, args]); const a = answers[Math.min(calls.length - 1, answers.length - 1)]; if (a instanceof Error) throw a; return a; } }; };

test('isTransientError: connection-closed / network / 5xx yes; permissions, missing function, bad input no', () => {
  for (const e of [{ message: 'TypeError: fetch failed' }, { message: 'connection closed' }, { message: 'Connection terminated unexpectedly' }, { message: 'Failed to fetch' },
    { message: 'Load failed' }, { status: 503, message: 'x' }, { code: 'PGRST000', message: 'Could not connect' }, { code: '08006', message: 'x' }, { name: 'AbortError', message: 'The operation timed out' }]) assert.ok(isTransientError(e), JSON.stringify(e));
  for (const e of [null, { code: '42501', message: 'permission denied for function dispatch_context' }, { code: 'PGRST202', message: 'Could not find the function' }, { code: '22P02', message: 'invalid input syntax' }, { status: 401, message: 'JWT expired' }])
    assert.ok(!isTransientError(e), JSON.stringify(e));
});

test('dispatch reads retry once after a dropped connection, never more, and not on real errors', async () => {
  const ok = { data: [{ owner_id: U1, role: 'dispatcher', company_name: 'Fake Freight LLC' }], error: null };
  const a = rpcSeq([{ data: null, error: { message: 'connection closed' } }, ok]);
  assert.deepEqual(await fetchDispatchContext(a, { retryMs: 0 }), { companies: ok.data }); assert.equal(a.calls.length, 2);
  const b = rpcSeq([new TypeError('fetch failed'), { data: [], error: null }]);
  assert.deepEqual(await fetchDispatchLoads(b, null, { retryMs: 0 }), { loads: [] }); assert.equal(b.calls.length, 2, 'a thrown network error is retried too');
  const c = rpcSeq([{ data: null, error: { message: 'connection closed' } }]);
  assert.ok((await fetchDispatchContext(c, { retryMs: 0 })).error); assert.equal(c.calls.length, 2, 'one retry only');
  const d = rpcSeq([{ data: null, error: { code: '42501', message: 'permission denied' } }]);
  assert.ok((await fetchDispatchContext(d, { retryMs: 0 })).error); assert.equal(d.calls.length, 1);
  const e = rpcSeq([{ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }]);
  assert.deepEqual(await fetchDispatchLoads(e, 'L1', { retryMs: 0 }), { setup: true }); assert.deepEqual(e.calls[0], ['dispatch_loads', { p_load: 'L1' }]);
  assert.equal((await rpcWithRetry(rpcSeq([{ data: 1, error: null }]), 'x')).data, 1);
});

test('/dispatch error state says what to do and keeps the Retry button', () => {
  const page = read('app/dispatch/page.js');
  assert.match(DISPATCH_LOAD_ERROR, /Couldn’t load the dispatch center\. Check your connection and tap Retry\./);
  assert.match(page, /text: DISPATCH_LOAD_ERROR/);
  assert.match(page, /<LoadError message=\{state\.text\} onRetry=\{load\} \/>/);
  assert.match(read('app/components/DataState.js'), /onClick=\{onRetry\}[\s\S]*Retry/);
});

// ---------- 8. Role state after sign-in ----------
const sbFake = ({ sessionUser = U1, token = 'fake.t', rpc = async () => ({ data: [], error: null }) } = {}) => ({
  auth: { getSession: async () => ({ data: { session: sessionUser ? { access_token: token, user: { id: sessionUser } } : null } }) },
  rpc,
});

test('dispatcherStatus: only a call made with the signed-in user\'s session counts', async () => {
  assert.deepEqual(await dispatcherStatus(sbFake({ sessionUser: null }), U1), { definite: false, dispatcher: false }, 'no session yet → can\'t tell (not "not a dispatcher")');
  assert.deepEqual(await dispatcherStatus(sbFake({ sessionUser: U2 }), U1), { definite: false, dispatcher: false }, 'previous user\'s session');
  assert.deepEqual(await dispatcherStatus(sbFake({ rpc: async () => ({ data: [{ owner_id: U2, role: 'dispatcher' }], error: null }) }), U1), { definite: true, dispatcher: true });
  assert.deepEqual(await dispatcherStatus(sbFake(), U1), { definite: true, dispatcher: false });
  let n = 0;
  assert.deepEqual(await dispatcherStatus(sbFake({ rpc: async () => { n++; return { data: null, error: { message: 'connection closed' } }; } }), U1, { retryMs: 0 }), { definite: false, dispatcher: false });
  assert.equal(n, 2);
  assert.deepEqual(await dispatcherStatus(sbFake({ rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }) }), U1), { definite: true, dispatcher: false }, 'before the migration: definitely no Dispatch tab');
});

test('checkUntilDefinite retries "couldn\'t tell" on the schedule, stops at the first definite answer, and can be cancelled', async () => {
  const timers = [];
  const setTimer = (fn, ms) => { timers.push(ms); setImmediate(fn); return timers.length; };
  const answers = [{ definite: false }, { definite: false }, { definite: true, dispatcher: true }];
  const got = [];
  await new Promise((done) => checkUntilDefinite(async () => answers.shift(), (r) => { got.push(r); done(); }, { setTimer, clearTimer: () => {} }));
  assert.deepEqual(timers, ROLE_RETRY_MS.slice(0, 2)); assert.deepEqual(got, [{ definite: true, dispatcher: true }]);
  let calls = 0; const results = [];
  const cancel = checkUntilDefinite(async () => { calls++; return { definite: false }; }, (r) => results.push(r), { setTimer: (fn) => setTimeout(fn, 1), clearTimer: clearTimeout });
  await new Promise((r) => setTimeout(r, 0)); cancel(); await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls, 1); assert.deepEqual(results, []);
});

test('role re-checks on every auth change; per-tab memory is per user', () => {
  for (const e of ['INITIAL_SESSION', 'SIGNED_IN', 'SIGNED_OUT', 'USER_UPDATED']) assert.ok(shouldRecheck(e), e);
  assert.ok(shouldRecheck('TOKEN_REFRESHED', { userChanged: true }));
  assert.ok(shouldRecheck('TOKEN_REFRESHED', { lastDefinite: false }));
  assert.ok(!shouldRecheck('TOKEN_REFRESHED', { lastDefinite: true }));
  const st = memStore();
  rememberRole(U1, true, st); assert.equal(recallRole(U1, st), true); assert.equal(recallRole(U2, st), null, 'another user never inherits it');
  forgetRole(st); assert.equal(recallRole(U1, st), null);
  const nav = read('app/components/AppNav.js');
  assert.match(nav, /checkUntilDefinite\(\(\) => dispatcherStatus\(sb, u\.id\)/);
  assert.match(nav, /if \(shouldRecheck\(event, \{ userChanged, lastDefinite \}\)\)/);
  assert.match(nav, /if \(userChanged\) \{ const known = u \? recallRole\(u\.id\) : false; setDispatcher\(known === true\); \}/);
  const menu = read('app/components/ui/AccountMenu.js');
  assert.match(menu, /return checkUntilDefinite\(\(\) => companyOwnerStatus\(supabase, uid\)/, 'owner items retried too');
  assert.match(menu, /event === 'SIGNED_IN' \|\| event === 'USER_UPDATED'\) setAuthTick/);
});

// ---------- 7. ?next after sign-out belongs to the person who signed out ----------
test('nextAfterSignIn: the previous user\'s page is dropped for a different user, kept for the same user', () => {
  const st = memStore();
  rememberSignOutNext(U1, '/dispatch/abc', { store: st, now: NOW });
  assert.equal(nextAfterSignIn('/dispatch/abc', U2, { store: st, now: NOW + 60_000 }), DEFAULT_NEXT, 'someone else signs in');
  assert.equal(st.getItem(SIGNOUT_NEXT_KEY), null, 'one-shot');
  rememberSignOutNext(U1, '/dispatch/abc', { store: st, now: NOW });
  assert.equal(nextAfterSignIn('/dispatch/abc', U1, { store: st, now: NOW + 60_000 }), '/dispatch/abc', 'same person: back to their page');
  rememberSignOutNext(U1, '/account/invite', { store: st, now: NOW });
  assert.equal(nextAfterSignIn('/packets/xyz', U2, { store: st, now: NOW }), '/packets/xyz', 'a different ?next (e.g. a Sign in link) is kept');
  assert.equal(nextAfterSignIn('/loads', U2, { store: memStore(), now: NOW }), '/loads', 'no sign-out record: unchanged behaviour');
  rememberSignOutNext(U1, '/account/invite', { store: st, now: NOW });
  assert.equal(nextAfterSignIn('/account/invite', U1, { store: st, now: NOW + SIGNOUT_NEXT_TTL_MS + 1 }), DEFAULT_NEXT, 'stale record: not trusted');
  assert.equal(nextAfterSignIn('https://evil.test', U1, { store: memStore() }), DEFAULT_NEXT, 'still safeNext-validated');
  rememberSignOutNext(U1, '//evil.test', { store: st }); assert.equal(st.getItem(SIGNOUT_NEXT_KEY), null, 'unsafe next never stored');
  const menu = read('app/components/ui/AccountMenu.js');
  assert.match(menu, /rememberSignOutNext\(who, new URL\(dest, window\.location\.origin\)\.searchParams\.get\('next'\)\);/);
  assert.match(read('app/auth/callback/page.js'), /nextAfterSignIn\(q\.get\('next'\), data\.session\.user\?\.id \|\| null\)/, 'magic links too');
});

// ---------- 9. Team row shows the new role at once ----------
test('applyRoleResult: only the changed, linked member row gets the confirmed role', () => {
  const list = [{ id: U1, role: 'driver', linked: true, email: 'driver@example.test' }, { id: U2, role: 'driver', linked: false, email: 'pending@example.test' }];
  const out = applyRoleResult(list, U1, 'dispatcher');
  assert.deepEqual(out.map((r) => r.role), ['dispatcher', 'driver']); assert.equal(list[0].role, 'driver', 'no mutation');
  assert.deepEqual(applyRoleResult(list, U2, 'dispatcher').map((r) => r.role), ['driver', 'driver'], 'unlinked invite rows untouched');
  assert.equal(applyRoleResult(list, U1, 'owner'), list, 'never owner');
  const page = read('app/account/invite/page.js');
  assert.match(page, /setSt\(\(prev\) => \(prev\.invites \? \{ \.\.\.prev, invites: applyRoleResult\(prev\.invites, x\.id, r\.role\) \} : prev\)\);\s*setRoleEdit\(null\);/);
  assert.match(page, /load\(\{ expectRole: \{ id: x\.id, role: r\.role \} \}\)/);
});

// ---------- 1. Change-role confirm reachable at 390px ----------
test('role confirm scrolls clear of the tab bar and the Report a bug button; buttons wrap', () => {
  const page = read('app/account/invite/page.js'), css = read('app/globals.css');
  assert.match(page, /<div ref=\{confirmRef\} tabIndex=\{-1\} data-above-fab data-testid="role-confirm" role="alertdialog"/);
  assert.match(page, /el\.scrollIntoView\(\{ block: 'nearest', behavior: 'smooth' \}\)/);
  assert.match(page, /paddingBottom: 'calc\(1rem \+ var\(--fab-space\)\)'/);
  assert.match(page, /display: 'flex', gap: 8, flexWrap: 'wrap' \}\}>\s*<button type="button" data-testid="role-confirm-yes"/);
  assert.match(css, /:root \{ --fab-space: 64px; \}/);
  assert.match(css, /\[data-above-fab\] \{ scroll-margin-bottom: calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\) \+ var\(--fab-space\) \+ 8px\);/);
  assert.match(read('app/components/ReportBugButton.js'), /bottom: 'calc\(var\(--nav-h\) \+ env\(safe-area-inset-bottom\) \+ 12px\)'/, 'button height 40 + 12 gap < 64');
});

// ---------- 2. Disabled "Save driver settings" readable in dark mode ----------
test('Save driver settings: full-size text, disabled tokens with a visible border, and a reason', () => {
  const src = read('app/components/LoadDriverSettings.js');
  assert.match(src, /data-testid="driver-settings-save"[\s\S]*borderColor: dirty \? 'var\(--primary\)' : 'var\(--disabled-border\)'[\s\S]*fontSize: '1rem', fontWeight: 600/);
  assert.match(src, /No changes to save/);
  const css = read('app/globals.css');
  const dark = css.slice(css.indexOf('[data-theme="dark"] {'));
  assert.match(dark, /--disabled-text: #e5e7eb; --disabled-border: #9ca3af;/);
});

// ---------- 6. Gender-neutral copy ----------
test('user-facing copy is gender-neutral (no he / him / his / she / her in strings)', () => {
  assert.match(read('app/dispatch/[id]/page.js'), /remove any amounts you don’t want them to see\./);
  const hits = execSync(`grep -rnwiE "him|his|he|she|her|himself|herself" app --include=*.js || true`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const code = hits.map((l) => l.replace(/^[^:]+:\d+:/, '')).filter((c) => !/^\s*(\/\/|\*|\/\*)/.test(c)).map((c) => c.replace(/\s\/\/ .*$/, ''));
  const strings = code.filter((c) => /\b(him|his|he|she|her|himself|herself)\b/i.test(c));
  assert.deepEqual(strings, []);
});
