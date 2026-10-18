// PROD smoke after #86 (Taylor): right after "+ New load" → Create, the Scale tickets card showed red
// "Couldn't check your sign-in just now. Try again." Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fakeSupabase } from './fakeSupabase.mjs';
import * as LT from '../../app/api/loads/[id]/scale-tickets/route.js';
import { loadScaleTickets, waitForToken } from '../../app/lib/scaleTicketsLoad.js';

const OWNER = '00000000-0000-4000-8000-00000000aaaa';
const L1 = '00000000-0000-4000-8000-0000000000c1';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (claims) => `${b64({ alg: 'HS256' })}.${b64(claims)}.sig`;
const GOOD = jwt({ sub: OWNER, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
const req = (t) => new Request(`http://x/api/loads/${L1}/scale-tickets`, { headers: { authorization: `Bearer ${t}` } });
const tables = () => ({ loads: [{ id: L1, user_id: OWNER, weight: 38500 }], scale_tickets: [], trucks: [], trailers: [] });
// Supabase Auth answering with a non-auth error (rate limit / 5xx / network) for the first `fails` calls.
function flakyAuth(fails, { rpcError = null } = {}) {
  const db = fakeSupabase({ tables: tables(), user: { id: OWNER }, role: 'owner' });
  let n = 0; const orig = db.auth.getUser.bind(db.auth);
  db.auth.getUser = async (t) => (n++ < fails ? { data: { user: null }, error: { status: 429, message: 'Request rate limit reached' } } : orig(t));
  if (rpcError) db.rpc = async () => ({ data: null, error: rpcError });
  return { db, calls: () => n };
}

test('server: one Auth hiccup is retried quietly (truckCtx uses the shared checkUser)', async () => {
  const { db, calls } = flakyAuth(1);
  const r = await LT.GET(req(GOOD), { params: { id: L1 }, deps: { mkUserClient: () => db, authRetryMs: 1 } });
  assert.equal(r.status, 200); assert.equal(calls(), 2);
  assert.deepEqual((await r.json()).tickets, []);
});

test('server: when Auth stays down, the token is verified by the database instead of a red 503', async () => {
  const { db } = flakyAuth(99);
  const r = await LT.GET(req(GOOD), { params: { id: L1 }, deps: { mkUserClient: () => db, authRetryMs: 1 } });
  assert.equal(r.status, 200); assert.equal((await r.json()).loadWeight, 38500);
});

test('server: the fallback still rejects expired, non-user, unreadable or database-rejected tokens', async () => {
  const run = async (t, o) => { const { db } = flakyAuth(99, o); return LT.GET(req(t), { params: { id: L1 }, deps: { mkUserClient: () => db, authRetryMs: 1 } }); };
  assert.equal((await run(jwt({ sub: OWNER, role: 'authenticated', exp: 1 }))).status, 401);
  assert.equal((await run(jwt({ sub: OWNER, role: 'anon', exp: 9999999999 }))).status, 401);
  const garbage = await run('not-a-jwt'); assert.equal(garbage.status, 503); assert.equal((await garbage.json()).retry, true);
  assert.equal((await run(GOOD, { rpcError: { code: 'PGRST301', message: 'JWSInvalidSignature' } })).status, 401);
  assert.equal((await run(GOOD, { rpcError: { code: '57014', message: 'timeout' } })).status, 503);
  // a real rejection from Auth is still a 401, with no fallback
  const db = fakeSupabase({ tables: tables(), user: { id: OWNER } });
  db.auth.getUser = async () => ({ data: { user: null }, error: { status: 401, message: 'invalid JWT' } });
  assert.equal((await LT.GET(req(GOOD), { params: { id: L1 }, deps: { mkUserClient: () => db, authRetryMs: 1 } })).status, 401);
});

// --- client card ---
function fakeAuth({ session = null, later = null, laterMs = 20 } = {}) {
  const subs = new Set();
  return { auth: {
    getSession: async () => ({ data: { session } }),
    onAuthStateChange: (cb) => { subs.add(cb); if (later) setTimeout(() => cb('SIGNED_IN', later), laterMs); return { data: { subscription: { unsubscribe: () => subs.delete(cb) } } }; },
  }, subs };
}
async function withFetch(responses, fn) {
  const orig = globalThis.fetch; const seen = [];
  globalThis.fetch = async (url, init) => { seen.push(init.headers.Authorization); const r = responses.shift(); if (r instanceof Error) throw r; return new Response(JSON.stringify(r.body), { status: r.status }); };
  try { return { out: await fn(), seen }; } finally { globalThis.fetch = orig; }
}

test('card: waits for the session instead of fetching with an empty token', async () => {
  const sb = fakeAuth({ later: { access_token: 'tok-late' } });
  assert.equal(await waitForToken(sb, { timeoutMs: 500 }), 'tok-late');
  assert.equal(sb.subs.size, 0); // listener cleaned up
  const { out, seen } = await withFetch([{ status: 200, body: { tickets: [], loadWeight: null, canEdit: true } }], () => loadScaleTickets(fakeAuth({ later: { access_token: 'tok-late' } }), L1, { retryMs: 1 }));
  assert.equal(out.state, 'ready'); assert.deepEqual(seen, ['Bearer tok-late']);
});

test('card: one quiet retry on a sign-in hiccup / 5xx / network error; the red text only if the retry fails too', async () => {
  const sb = () => fakeAuth({ session: { access_token: 'tok' } });
  let r = await withFetch([{ status: 503, body: { error: 'Couldn’t check your sign-in just now. Try again.', retry: true } }, { status: 200, body: { tickets: [] } }], () => loadScaleTickets(sb(), L1, { retryMs: 1 }));
  assert.equal(r.out.state, 'ready'); assert.equal(r.seen.length, 2);
  r = await withFetch([new Error('network'), { status: 200, body: { tickets: [] } }], () => loadScaleTickets(sb(), L1, { retryMs: 1 }));
  assert.equal(r.out.state, 'ready');
  r = await withFetch([{ status: 503, body: { error: 'Couldn’t check your sign-in just now. Try again.' } }, { status: 503, body: { error: 'Couldn’t check your sign-in just now. Try again.' } }], () => loadScaleTickets(sb(), L1, { retryMs: 1 }));
  assert.equal(r.out.state, 'error'); assert.equal(r.seen.length, 2); // exactly one retry, no loop
  r = await withFetch([{ status: 404, body: { error: 'Load not found.' } }], () => loadScaleTickets(sb(), L1, { retryMs: 1 }));
  assert.equal(r.out.state, 'error'); assert.equal(r.seen.length, 1); // real answers aren't retried
});

test('wiring: the card uses the wait + retry loader; truckCtx uses checkUser + database fallback', () => {
  const comp = readFileSync(new URL('../../app/components/LoadScaleTickets.js', import.meta.url), 'utf8');
  assert.match(comp, /loadScaleTickets\(supabase, loadId\)\.then/);
  assert.doesNotMatch(comp, /Bearer \$\{t \|\| ''\}/);
  const srv = readFileSync(new URL('../../app/lib/truckServer.js', import.meta.url), 'utf8');
  assert.match(srv, /await checkUser\(uc, token/); assert.match(srv, /verified: 'database'/);
});
