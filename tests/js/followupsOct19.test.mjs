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

// =================== QA of #100 (Oct 19): 503 on the session route, owner gate, offline Retry ===================
import { checkUser, isAuthRejection, isAuthUnavailable, authErrInfo } from '../../app/lib/packetServer.js';
import { resolveDispatchAccess, fetchMyRolesStatus, notMemberCopy, BOARDS_LOAD_ERROR } from '../../app/lib/dispatch.js';
import { onReconnect, loadWithOneRetry, withTimeout, ONLINE_RETRY_DELAY_MS } from '../../app/lib/onlineRetry.js';

// Shapes copied from @supabase/auth-js 2.117: what getUser(jwt) returns for each real situation.
const E = {
  sessionMissing: { name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!', __isAuthError: true },
  badJwt: { name: 'AuthApiError', status: 403, code: 'bad_jwt', message: 'invalid JWT: unable to parse or verify signature' },
  gone: { name: 'AuthApiError', status: 404, code: 'user_not_found', message: 'User from sub claim in JWT does not exist' },
  retryable: { name: 'AuthRetryableFetchError', status: 0, message: 'fetch failed' },
  gateway: { name: 'AuthRetryableFetchError', status: 502, message: 'Bad Gateway' },
  unknown: { name: 'AuthUnknownError', message: 'Unexpected token < in JSON' },
  rate: { name: 'AuthApiError', status: 429, code: 'over_request_rate_limit', message: 'Request rate limit reached' },
};

test('503 root cause: "Auth session missing!" (status 400) was not recognised as a rejection → every call looked like "Auth unavailable"', async () => {
  assert.ok(isAuthRejection(E.sessionMissing), 'AuthSessionMissingError is a rejection');
  for (const e of [E.sessionMissing, E.badJwt, E.gone]) { assert.ok(!isAuthUnavailable(e), e.name + e.status); assert.equal((await checkUser({ auth: { getUser: async () => ({ data: { user: null }, error: e }) } }, 'fake.t.k', { retryMs: 0 })).rejected, true); }
  for (const e of [E.retryable, E.gateway, E.unknown, E.rate, new TypeError('fetch failed'), Object.assign(new Error('x'), { cause: { code: 'ECONNRESET' } })]) assert.ok(isAuthUnavailable(e), e.name || e.message);
  let n = 0;
  const r = await checkUser({ auth: { getUser: async () => { n++; return { data: { user: null }, error: E.gateway }; } } }, 'fake.t.k', { retryMs: 0 });
  assert.equal(r.unavailable, true); assert.equal(n, 2, 'one retry on a real 5xx');
  assert.equal(authErrInfo(E.gateway), 'AuthRetryableFetchError 502  Bad Gateway');
});

test('session route: a session-missing token → 401 + cleared cookie (not 503); a real 5xx → 503 and the log has no token', async () => {
  const tok = fakeJwt({ sub: U1, exp: NOW / 1000 + 600 });
  const r = await POST(sessReq({ token: tok }), { deps: { mkUserClient: authClient({ data: { user: null }, error: E.sessionMissing }), now: NOW } });
  assert.equal(r.status, 401); assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
  const logs = []; const orig = console.error; console.error = (...a) => logs.push(a.join(' '));
  try {
    const d = await POST(sessReq({ token: tok }), { deps: { authRetryMs: 0, mkUserClient: authClient({ data: { user: null }, error: E.gateway }) } });
    assert.equal(d.status, 503);
  } finally { console.error = orig; }
  assert.ok(logs.some((l) => l.includes('[dispatch session] auth check unavailable AuthRetryableFetchError 502')));
  assert.ok(!logs.join('\n').includes(tok), 'token never logged');
});

test('invites route: !who.user (Auth really unavailable) logs name/status/message only', () => {
  assert.match(read('app/api/account/invites/route.js'), /console\.error\('\[invites\] auth check unavailable', authErrInfo\(who\.error\)\)/);
});

// ---------- 2. owner's /dispatch: unknown ≠ not a manager ----------
const sbRoles = ({ uid = U1, ctx = { data: [], error: null }, members = { data: [{ role: 'owner' }], error: null } } = {}) => ({
  auth: { getSession: async () => ({ data: { session: uid ? { access_token: 'fake.t', user: { id: uid } } : null } }) },
  rpc: async () => (ctx instanceof Error ? Promise.reject(ctx) : ctx),
  from: () => ({ select: () => ({ eq: async () => members }) }),
});

test('resolveDispatchAccess: only definite answers; unknown stays loading / Retry, an owner is never downgraded', async () => {
  const o = { retryMs: 0 };
  assert.equal((await resolveDispatchAccess(sbRoles({ uid: null }), o)).status, 'unknown', 'no session yet');
  assert.equal((await resolveDispatchAccess(sbRoles({ ctx: { data: null, error: { message: 'connection closed' } } }), o)).status, 'unknown', 'context failed');
  assert.equal((await resolveDispatchAccess(sbRoles({ members: { data: null, error: { message: 'connection closed' } } }), o)).status, 'unknown', 'owner lookup failed: NOT "not a member"');
  assert.equal((await resolveDispatchAccess(sbRoles({ members: { data: null, error: { code: 'PGRST301', message: 'JWT expired' } } }), o)).status, 'unknown');
  const owner = await resolveDispatchAccess(sbRoles(), o);
  assert.deepEqual(owner, { status: 'not-member', roles: ['owner'] });
  assert.equal(notMemberCopy(owner.roles).href, '/loads');
  assert.doesNotMatch(notMemberCopy(['owner']).text, /management and dispatchers/, 'owner copy no longer reads as "you are not a manager"');
  assert.equal((await resolveDispatchAccess(sbRoles({ ctx: { data: [{ owner_id: U2, role: 'dispatcher', company_name: 'Fake' }], error: null } }), o)).status, 'member');
  assert.equal((await resolveDispatchAccess(sbRoles({ ctx: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } }), o)).status, 'setup');
  assert.deepEqual(await fetchMyRolesStatus(sbRoles({ uid: null })), { roles: [], definite: false });
  for (const f of ['app/dispatch/page.js', 'app/dispatch/[id]/page.js']) {
    const src = read(f);
    assert.match(src, /acc\.status === 'unknown'[\s\S]*fail\(/, f); assert.match(src, /notMemberCopy\(acc\.roles\)/, f);
    assert.doesNotMatch(src, /fetchMyRoles\(supabase\)/, f);
  }
});

// ---------- 3. offline: error + Retry + one auto-retry everywhere; back online → retry ----------
test('loadWithOneRetry: one automatic retry after an error, none after success, none when the page is gone', async () => {
  let n = 0; const waits = [];
  const wait = async (ms) => { waits.push(ms); };
  assert.equal(await loadWithOneRetry(async ({ auto }) => { n++; return !auto; }, { wait }), false); assert.equal(n, 2); assert.deepEqual(waits, [1200]);
  n = 0; assert.equal(await loadWithOneRetry(async () => { n++; return false; }, { wait }), false); assert.equal(n, 1);
  n = 0; assert.equal(await loadWithOneRetry(async () => { n++; return true; }, { wait }), true); assert.equal(n, 2, 'never more than one retry');
  n = 0; assert.equal(await loadWithOneRetry(async () => { n++; return true; }, { wait, isLive: () => false }), true); assert.equal(n, 1);
});

test('withTimeout: a fetch that never answers ends in the error state instead of "Loading…" forever', async () => {
  const never = new Promise(() => {});
  assert.equal(await withTimeout(never, 5, () => true), true);
  assert.equal(await withTimeout(Promise.resolve(false), 50, () => true), false);
});

test('onReconnect: the window "online" event triggers one retry after a short pause; cleanup removes it', () => {
  const handlers = {}; const target = { addEventListener: (e, f) => { handlers[e] = f; }, removeEventListener: (e) => { delete handlers[e]; } };
  const timers = []; const setTimer = (fn, ms) => { timers.push([fn, ms]); return timers.length; };
  let ran = 0;
  const off = onReconnect(() => { ran++; }, { target, setTimer, clearTimer: () => {} });
  assert.equal(typeof handlers.online, 'function');
  handlers.online(); assert.equal(timers[0][1], ONLINE_RETRY_DELAY_MS); timers[0][0](); assert.equal(ran, 1);
  off(); assert.equal(handlers.online, undefined);
});

test('pages: boards has error + Retry + auto-retry + timeout; /loads, /dispatch, /dispatch/[id], boards retry on "online"; boards never downgrades on a failed check', () => {
  const boards = read('app/dispatch/boards/page.js');
  assert.match(boards, /<LoadError message=\{state\.text\} onRetry=\{\(\) => load\(\)\} \/>/);
  assert.match(boards, /loadWithOneRetry\(run, /); assert.match(boards, /withTimeout\(loadOnce\(u, o\)/);
  assert.match(boards, /if \(!own\.definite\) return fail\(\);/); assert.match(boards, /if \(ctx\.error\) return fail\(\);/);
  assert.match(boards, /useRetryWhenOnline\(state\.status === 'error', \(\) => \(userRef\.current \? withTimeout\(loadOnce\(userRef\.current, \{ auto: true \}\)/);
  assert.match(BOARDS_LOAD_ERROR, /tap Retry/);
  assert.match(read('app/dispatch/page.js'), /useRetryWhenOnline\(state\.status === 'error', \(\) => withTimeout\(loadOnce\(\{ auto: true \}\)/, 'quiet probe (no Loading flip)');
  assert.match(read('app/dispatch/[id]/page.js'), /useRetryWhenOnline\(state\.status === 'error', \(\) => withTimeout\(fetchLoadOnce\(\{ auto: true \}\)/);
  assert.match(read('app/loads/LoadsData.js'), /useRetryWhenOnline\(!!error, loadLoads\)/);
  for (const f of ['app/dispatch/page.js', 'app/dispatch/[id]/page.js']) assert.match(read(f), /withTimeout\(/, f);
});

// =================== QA #100 r2: auto-recover keeps trying (online / focus / visible + 5-10-20-30 s backoff) ===================
import { startRecovery, RECOVER_BACKOFF_MS } from '../../app/lib/onlineRetry.js';

const fakeEnv = () => {
  const ev = {}; const add = (o) => ({ addEventListener: (e, f) => { (ev[`${o}:${e}`] ||= new Set()).add(f); }, removeEventListener: (e, f) => ev[`${o}:${e}`]?.delete(f) });
  const doc = { ...add('doc'), visibilityState: 'visible' };
  let now = 0; const timers = new Map(); let id = 0;
  const setTimer = (fn, ms) => { timers.set(++id, { fn, at: now + ms, ms }); return id; };
  const clearTimer = (i) => timers.delete(i);
  const fire = (key) => [...(ev[key] || [])].forEach((f) => f());
  const advance = async (ms) => { const end = now + ms; for (;;) { const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > end) break; timers.delete(next[0]); now = next[1].at; next[1].fn(); await new Promise((r) => setImmediate(r)); } now = end; };
  return { win: add('win'), doc, setTimer, clearTimer, fire, advance, ev, timers };
};

test('r2 root cause: error → back online → the first probe still fails → it keeps probing and the reload succeeds (no Retry tap)', async () => {
  const env = fakeEnv();
  // Simulates LoadsProvider: error state while offline; reload() fails until the network is really back.
  let online = false, error = true, reloads = 0;
  const reload = async () => { reloads++; if (online && reloads >= 2) error = false; };
  const stop = startRecovery(reload, { win: env.win, doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  online = true; env.fire('win:online');           // DevTools: Offline → No throttling
  await env.advance(800); assert.equal(reloads, 1); assert.equal(error, true, 'first probe right after reconnect fails (old version stopped here)');
  await env.advance(5_000); assert.equal(reloads, 2); assert.equal(error, false, 'backoff probe reloads the list within ~6 s');
  stop(); // page left the error state → hook cleanup
  assert.equal(env.timers.size, 0, 'no timers left'); assert.equal(env.ev['win:online'].size, 0, 'listeners removed');
});

test('r2: backoff 5 s, 10 s, 20 s, then every 30 s; focus / visible probe early; hidden tab does not; probes never overlap', async () => {
  assert.deepEqual(RECOVER_BACKOFF_MS, [5_000, 10_000, 20_000, 30_000]);
  const env = fakeEnv(); const at = []; let t = 0;
  const origAdvance = env.advance; env.advance = async (ms) => { await origAdvance(ms); t += ms; };
  const stop = startRecovery(async () => { at.push(t); }, { win: env.win, doc: env.doc, setTimer: env.setTimer, clearTimer: env.clearTimer });
  for (const step of [5_000, 10_000, 20_000, 30_000, 30_000]) await env.advance(step);
  assert.equal(at.length, 5, 'one probe per backoff step, capped at 30 s');
  env.fire('win:focus'); await env.advance(800); assert.equal(at.length, 6, 'focus probes early');
  env.doc.visibilityState = 'hidden'; env.fire('doc:visibilitychange'); await env.advance(800); assert.equal(at.length, 6, 'hidden tab: no probe');
  env.doc.visibilityState = 'visible'; env.fire('doc:visibilitychange'); await env.advance(800); assert.equal(at.length, 7, 'visible again: probe');
  stop();
  let inflight = 0, max = 0; let release;
  const env2 = fakeEnv();
  const stop2 = startRecovery(() => { inflight++; max = Math.max(max, inflight); return new Promise((r) => { release = () => { inflight--; r(); }; }); }, { win: env2.win, doc: env2.doc, setTimer: env2.setTimer, clearTimer: env2.clearTimer });
  env2.fire('win:online'); await env2.advance(800); env2.fire('win:online'); await env2.advance(800); await env2.advance(5_000);
  assert.equal(max, 1, 'no overlapping probes'); release(); stop2();
});

test('r2: every page keeps the error state during probes (quiet retry), so the loop is not cancelled by a Loading flip', () => {
  assert.match(read('app/loads/LoadsData.js'), /useRetryWhenOnline\(!!error, loadLoads\)/);
  assert.doesNotMatch(read('app/loads/LoadsData.js').match(/async function loadLoads\(\) \{[\s\S]*?\n  \}/)[0], /setError\(null\);\s*const \{ data/, 'loadLoads does not clear the error before fetching');
  const hook = read('app/lib/onlineRetry.js');
  assert.match(hook, /useEffect\(\(\) => \(active \? startRecovery\(\(\) => ref\.current\?\.\(\)\) : undefined\), \[active\]\);/, 'latest retry via ref; stops when active clears / on unmount');
});
