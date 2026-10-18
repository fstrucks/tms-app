// QA #83 r2: (1) never "Finding the truck route…" next to an error; (2) no ERR_CONNECTION_CLOSED: hard per-call
// timeouts, the handler always answers before maxDuration, and the browser retries a dropped POST once. Fake data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { callMap, cardPhase, NET_RETRY_DELAY_MS, REACH_MSG } from '../../app/lib/mapClient.js';
import { withDeadline, fetchRoute, geocodeStop, MAX_DURATION_S, STEP_BUDGET_MS, ORS_ROUTE_TIMEOUT_MS, ORS_GEOCODE_TIMEOUT_MS, HANDLER_DEADLINE_MS } from '../../app/lib/loadRouteServer.js';
import * as MAP from '../../app/api/loads/[id]/map/route.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const L1 = '00000000-0000-4000-8000-0000000000e1';
const ok = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
const neverSettles = () => new Promise(() => {}); // a hung connection that ignores abort

// ---------- (1) loading vs message ----------
test('cardPhase: loading only while a step is to come; failed / retry-later ends it; never both', () => {
  assert.deepEqual(cardPhase({ stale: true, next: 'route', canEdit: true, message: 'The map service didn’t answer.' }), { computing: true, message: null }, 'old error hidden while retrying');
  assert.deepEqual(cardPhase({ stale: false, next: null, canEdit: true, state: 'error', message: 'The map service didn’t answer.', retryInMs: 600000 }), { computing: false, message: 'The map service didn’t answer.' });
  assert.deepEqual(cardPhase({ state: 'failed', message: REACH_MSG }), { computing: false, message: REACH_MSG });
  assert.deepEqual(cardPhase({ stale: true, next: 'geocode', canEdit: true, retryInMs: 1000, message: 'busy' }), { computing: false, message: 'busy' });
  assert.equal(cardPhase({ stale: true, next: 'route', canEdit: false }).computing, false, 'drivers never step');
  assert.equal(cardPhase({ stale: true, next: 'route', canEdit: true }, { steps: 8, max: 8 }).computing, false, 'step cap');
  assert.deepEqual(cardPhase({ stale: false, state: 'ready', calculated_miles: 650 }), { computing: false, message: null });
  for (const j of [{ stale: true, next: 'route', canEdit: true, message: 'x' }, { state: 'failed', message: 'x' }, { retryInMs: 5, message: 'x', stale: true, next: 'route', canEdit: true }]) {
    const p = cardPhase(j); assert.ok(!(p.computing && p.message), 'never both');
  }
  const card = read('app/components/LoadRouteCard.js');
  assert.match(card, /\{!st\.computing && st\.message && <p role="status" data-testid="route-message"/);
  assert.match(card, /setSt\(\{ \.\.\.j, \.\.\.cardPhase\(j\) \}\)/);
});

// ---------- (2a) browser retries ----------
test('callMap: a dropped connection is retried once after a pause, then a calm message', async () => {
  const sleeps = []; let n = 0;
  const flaky = async () => { n += 1; if (n === 1) throw new TypeError('Failed to fetch'); return ok({ state: 'ready', stale: false }); };
  const j = await callMap({ url: '/api/loads/x/map', method: 'POST', fetchImpl: flaky, getToken: async () => 't', sleep: async (ms) => sleeps.push(ms) });
  assert.equal(j.state, 'ready'); assert.equal(n, 2); assert.deepEqual(sleeps, [NET_RETRY_DELAY_MS]);
  let m = 0;
  const down = async () => { m += 1; throw new TypeError('Failed to fetch'); };
  const k = await callMap({ url: 'u', method: 'POST', fetchImpl: down, getToken: async () => 't', sleep: async () => {} });
  assert.equal(m, 2, 'only one retry'); assert.deepEqual(k, { state: 'failed', message: REACH_MSG });
});

test('callMap: non-JSON 5xx (platform error page) retried once; 401 refreshes the token once; JSON errors pass through', async () => {
  let n = 0;
  const html5xx = async () => { n += 1; return n === 1 ? { ok: false, status: 504, json: async () => { throw new SyntaxError('html'); } } : ok({ state: 'ready' }); };
  assert.equal((await callMap({ url: 'u', method: 'POST', fetchImpl: html5xx, getToken: async () => 't', sleep: async () => {} })).state, 'ready');
  const fresh = []; let a = 0;
  const auth = async () => { a += 1; return a === 1 ? ok({ error: 'expired' }, 401) : ok({ state: 'ready' }); };
  assert.equal((await callMap({ url: 'u', method: 'GET', fetchImpl: auth, getToken: async (f) => { fresh.push(f); return 't'; } })).state, 'ready');
  assert.deepEqual(fresh, [false, true]);
  const late = await callMap({ url: 'u', method: 'POST', fetchImpl: async () => ok({ error: 'The map service didn’t answer.', state: 'failed', retry: true }, 503), getToken: async () => 't', sleep: async () => {} });
  assert.deepEqual(late, { state: 'failed', message: 'The map service didn’t answer.' });
});

// ---------- (2b) server time limits ----------
test('limits: 12 s route call inside a 15 s step; handler answers by 20 s < maxDuration 30', () => {
  assert.equal(ORS_ROUTE_TIMEOUT_MS, 12_000); assert.equal(STEP_BUDGET_MS, 15_000);
  assert.ok(2 * ORS_GEOCODE_TIMEOUT_MS < STEP_BUDGET_MS);
  assert.ok(STEP_BUDGET_MS < HANDLER_DEADLINE_MS && HANDLER_DEADLINE_MS + 5_000 <= MAX_DURATION_S * 1000);
  const src = read('app/lib/loadRouteServer.js');
  assert.match(src, /new AbortController\(\)/); assert.ok(!/AbortSignal\.timeout/.test(src), 'own timer, also covers a stalled body');
});

test('ORS calls settle on time even when the connection hangs and ignores abort', async () => {
  let t0 = Date.now();
  assert.deepEqual(await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: 'k', fetchImpl: neverSettles, take: () => true, timeoutMs: 600 }), { error: 'timeout' });
  assert.ok(Date.now() - t0 < 1_200);
  // Body read stalls after headers.
  t0 = Date.now();
  const stalledBody = async () => ({ ok: true, status: 200, json: neverSettles });
  assert.deepEqual(await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: 'k', fetchImpl: stalledBody, take: () => true, timeoutMs: 600 }), { error: 'timeout' });
  assert.ok(Date.now() - t0 < 1_200);
  // Abort is passed through to fetch.
  let sig, called = 0;
  await fetchRoute([{ lat: 1, lng: 1 }, { lat: 2, lng: 2 }], { key: 'k', fetchImpl: (u, i) => { called += 1; sig = i.signal; return neverSettles(); }, take: () => true, timeoutMs: 600 });
  assert.equal(called, 1); assert.equal(sig.aborted, true);
  // Geocoding: two hung calls are both capped by the step deadline.
  t0 = Date.now();
  const g = await geocodeStop({ address_line1: '1 Test St', city: 'Testville', state: 'TX', zip: '75000' }, { key: 'k', fetchImpl: neverSettles, take: () => true, timeoutMs: 5_000, deadline: Date.now() + 2_300 });
  assert.deepEqual(g, { error: 'timeout' }); assert.ok(Date.now() - t0 < 2_300);
});

test('withDeadline: falls back on time, otherwise passes the result through', async () => {
  assert.equal(await withDeadline(neverSettles(), 50, () => 'late'), 'late');
  assert.equal(await withDeadline(Promise.resolve('done'), 1_000, () => 'late'), 'done');
});

test('handler always answers JSON before its deadline, even when auth/DB hang', async () => {
  const hung = { auth: { getUser: neverSettles }, from: () => ({ select: () => ({ limit: neverSettles }) }), rpc: neverSettles };
  const req = (m) => new Request(`http://x/api/loads/${L1}/map`, { method: m, headers: { authorization: 'Bearer t' } });
  for (const [fn, m] of [[MAP.POST, 'POST'], [MAP.GET, 'GET']]) {
    const t0 = Date.now();
    const r = await fn(req(m), { params: { id: L1 }, deps: { mkUserClient: () => hung, deadlineMs: 150 } });
    assert.ok(Date.now() - t0 < 1_000);
    assert.equal(r.status, 503); const j = await r.json();
    assert.equal(j.state, 'failed'); assert.equal(j.retry, true); assert.match(j.error, /didn’t answer/);
  }
  assert.match(read('app/api/loads/[id]/map/route.js'), /withDeadline\(\(async \(\) => \{[\s\S]*deadlineOf\(deps\), late\)/);
});
