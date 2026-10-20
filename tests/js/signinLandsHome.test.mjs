// Fresh sign-in lands on Home (/) (Oct 20 2026); an explicit safe same-origin ?next still wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_NEXT, safeNext, nextAfterSignIn, magicLinkRedirect, rememberSignOutNext } from '../../app/lib/safeNext.js';
import { callbackDestination } from '../../app/lib/passwordSetup.js';
import manifest from '../../app/manifest.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const pw = { user_metadata: { password_set: true } };

test('default is Home', () => {
  assert.equal(DEFAULT_NEXT, '/');
  assert.equal(safeNext(null), '/'); assert.equal(safeNext(''), '/');
  assert.equal(nextAfterSignIn(null, 'u1', { store: mem() }), '/');
  assert.equal(callbackDestination({ type: 'magiclink', next: null, user: pw }), '/');
  assert.equal(callbackDestination({ type: null, next: null, user: { user_metadata: {} } }), '/account/password?mode=setup&next=%2F');
});

test('explicit safe deep links still win; unsafe ones fall back to Home', () => {
  assert.equal(nextAfterSignIn('/loads/abc?tab=x', 'u1', { store: mem() }), '/loads/abc?tab=x');
  assert.equal(callbackDestination({ type: 'magiclink', next: '/dispatch/9', user: pw }), '/dispatch/9');
  assert.equal(callbackDestination({ type: 'invite', next: '/account/password', user: { user_metadata: {} } }), '/account/password?mode=setup&next=%2F');
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', '/login', '/%2F%2Fevil.com']) assert.equal(nextAfterSignIn(bad, 'u1', { store: mem() }), '/', bad);
});

test("sign-out next: same person returns to their page, someone else lands on Home", () => {
  const s = mem(); rememberSignOutNext('u1', '/team', { store: s, now: 1 });
  assert.equal(nextAfterSignIn('/team', 'u2', { store: s, now: 2 }), '/');
  const s2 = mem(); rememberSignOutNext('u1', '/team', { store: s2, now: 1 });
  assert.equal(nextAfterSignIn('/team', 'u1', { store: s2, now: 2 }), '/team');
});

test('magic link carries ?next only when explicit', () => {
  assert.equal(magicLinkRedirect('https://x.test', null), 'https://x.test/auth/callback');
  assert.equal(magicLinkRedirect('https://x.test', '//evil.com'), 'https://x.test/auth/callback');
  assert.equal(magicLinkRedirect('https://x.test', '/loads/1'), 'https://x.test/auth/callback?next=%2Floads%2F1');
});

test('manifest: home screen icon starts on Home', () => {
  const m = manifest();
  assert.equal(m.start_url, '/'); assert.equal(m.scope, '/'); assert.equal(m.display, 'browser');
});

test('no page hard-codes /documents as the sign-in landing', () => {
  for (const f of ['app/auth/callback/page.js', 'app/account/password/page.js', 'app/lib/passwordSetup.js', 'app/login/page.js']) {
    assert.doesNotMatch(readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8'), /'\/documents'/, f);
  }
});
