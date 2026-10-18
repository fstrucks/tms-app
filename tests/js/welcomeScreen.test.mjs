import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiBusy, whenUiIdle, BUSY_UI_SELECTOR, WELCOME_CARDS, WELCOME_KEY, OPEN_WELCOME_EVENT, shouldShowWelcome, hasSeenWelcome, markWelcomeSeen, openWelcome } from '../../app/lib/welcome.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }; };
const U = { id: 'u1', email: 't@example.test', user_metadata: {} };
const now = () => new Date('2026-10-18T02:00:00Z');

test('welcome: 4 cards cover product, Add to Home Screen (iPhone + Android), fake data, Report a bug', () => {
  assert.deepEqual(WELCOME_CARDS.map((c) => c.id), ['what', 'home', 'fake', 'bugs']);
  const home = WELCOME_CARDS[1].steps.map((s) => s.label).join(' ');
  assert.match(home, /iPhone \(Safari\)/); assert.match(home, /Android \(Chrome\)/);
  assert.match(JSON.stringify(WELCOME_CARDS[1]), /Add to Home Screen/);
  assert.match(WELCOME_CARDS[2].lines.join(' '), /real/i);
  assert.match(WELCOME_CARDS[3].lines.join(' '), /Report a bug/);
});

test('welcome: shows once for a signed-in user, never signed out or on sign-in/password pages', () => {
  const s = mem();
  assert.equal(shouldShowWelcome({ user: U, pathname: '/dashboard', storage: s }), true);
  assert.equal(shouldShowWelcome({ user: null, pathname: '/dashboard', storage: s }), false);
  for (const p of ['/login', '/auth/callback', '/forgot-password', '/account/password']) assert.equal(shouldShowWelcome({ user: U, pathname: p, storage: s }), false, p);
  assert.equal(shouldShowWelcome({ user: U, pathname: '/loginx', storage: s }), true);
  assert.equal(shouldShowWelcome({ user: { ...U, user_metadata: { welcome_seen_at: '2026-10-01T00:00:00Z' } }, pathname: '/', storage: s }), false);
});

test('welcome: dismiss saves to user_metadata via auth.updateUser and localStorage', async () => {
  const s = mem(); const calls = [];
  const supabase = { auth: { updateUser: async (a) => { calls.push(a); return { data: {}, error: null }; } } };
  const r = await markWelcomeSeen({ supabase, user: U, storage: s, now });
  assert.equal(r.saved, 'metadata');
  assert.deepEqual(calls, [{ data: { welcome_seen_at: '2026-10-18T02:00:00.000Z' } }]);
  assert.equal(s.getItem(`${WELCOME_KEY}:u1`), '2026-10-18T02:00:00.000Z');
  assert.equal(hasSeenWelcome(U, s), true);
  assert.equal(shouldShowWelcome({ user: U, pathname: '/', storage: s }), false);
  assert.equal(hasSeenWelcome({ ...U, id: 'u2' }, s), false, 'flag is per user');
});

test('welcome: falls back to localStorage when updateUser errors or throws, never throws', async () => {
  for (const updateUser of [async () => ({ error: { message: 'network' } }), async () => { throw new Error('offline'); }]) {
    const s = mem();
    const r = await markWelcomeSeen({ supabase: { auth: { updateUser } }, user: U, storage: s, now });
    assert.equal(r.saved, 'local'); assert.ok(r.error);
    assert.equal(hasSeenWelcome(U, s), true);
  }
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(hasSeenWelcome(U, broken), false);
  assert.equal((await markWelcomeSeen({ supabase: null, user: U, storage: broken, now })).saved, 'none');
});

test('welcome: no second updateUser when metadata already set', async () => {
  let n = 0; const supabase = { auth: { updateUser: async () => { n++; return {}; } } };
  await markWelcomeSeen({ supabase, user: { ...U, user_metadata: { welcome_seen_at: 'x' } }, storage: mem(), now });
  assert.equal(n, 0);
});

test('welcome: re-open from account menu via event; shared-file edits are one import + one line', () => {
  const seen = []; openWelcome({ dispatchEvent: (e) => seen.push(e.type) });
  assert.deepEqual(seen, [OPEN_WELCOME_EVENT]);
  const menu = readFileSync('app/components/ui/AccountMenu.js', 'utf8');
  assert.match(menu, /import \{ openWelcome \} from '..\/..\/lib\/welcome'/);
  assert.match(menu, /openWelcome\(\); \}\}[^>]*>Welcome tour<\/button>/);
  const layout = readFileSync('app/layout.js', 'utf8');
  assert.match(layout, /import WelcomeScreen from '.\/components\/WelcomeScreen'/);
  assert.match(layout, /<WelcomeScreen \/>/);
  const comp = readFileSync('app/components/WelcomeScreen.js', 'utf8');
  assert.match(comp, /window\.addEventListener\(OPEN_WELCOME_EVENT/);
  assert.match(comp, /role="dialog"/); assert.match(comp, /Escape/);
});

test('welcome: sets body marker while open (cleared on close/unmount) and sits above floating UI', () => {
  const comp = readFileSync('app/components/WelcomeScreen.js', 'utf8');
  assert.match(comp, /document\.body\.dataset\.welcomeOpen = '1'/);
  assert.match(comp, /return \(\) => \{[^}]*delete document\.body\.dataset\.welcomeOpen; \}/);
  assert.match(comp, /export const WELCOME_Z = 10000/); assert.match(comp, /zIndex: WELCOME_Z/);
});

test('welcome: uiBusy spots an open menu / other modal, not the welcome sheet itself', () => {
  const doc = (hit) => ({ querySelector: (sel) => { assert.equal(sel, BUSY_UI_SELECTOR); return hit ? {} : null; } });
  assert.equal(uiBusy(doc(true)), true); assert.equal(uiBusy(doc(false)), false); assert.equal(uiBusy(null), false);
  assert.match(BUSY_UI_SELECTOR, /\[role="menu"\]/); assert.match(BUSY_UI_SELECTOR, /\[aria-haspopup\]\[aria-expanded="true"\]/);
  assert.match(BUSY_UI_SELECTOR, /:not\(\[data-testid="welcome-screen"\]\)/);
});

test('welcome: auto-open waits for an open menu to close (MutationObserver, no polling), and can be cancelled', () => {
  let busy = true, mo = null; const body = {};
  const doc = { body, querySelector: () => (busy ? {} : null) };
  class MO { constructor(cb) { this.cb = cb; mo = this; } observe(t, o) { this.t = t; this.o = o; } disconnect() { this.off = true; } }
  let opened = 0;
  whenUiIdle(() => opened++, doc, MO);
  assert.equal(opened, 0, 'not while the menu is open');
  assert.equal(mo.t, body); assert.equal(mo.o.subtree, true); assert.deepEqual(mo.o.attributeFilter, ['aria-expanded', 'role', 'aria-modal']);
  mo.cb(); assert.equal(opened, 0);
  busy = false; mo.cb(); mo.cb();
  assert.equal(opened, 1, 'opens once when the menu closes'); assert.equal(mo.off, true);
  busy = true; let n = 0; const cancel = whenUiIdle(() => n++, doc, MO); cancel(); busy = false; mo.cb();
  assert.equal(n, 0, 'cancelled on unmount / route change'); assert.equal(mo.off, true);
  busy = false; let now = 0; whenUiIdle(() => now++, doc, MO); assert.equal(now, 1, 'opens right away when nothing is open');
});

test('welcome: component defers auto-open, never steals focus from a menu, traps Tab, keeps Esc + marker', () => {
  const comp = readFileSync('app/components/WelcomeScreen.js', 'utf8');
  assert.match(comp, /return whenUiIdle\(\(\) => \{ if \(shouldShowWelcome\(/);
  assert.match(comp, /if \(!uiBusy\(\)\) closeRef\.current\?\.focus\(\)/);
  assert.match(comp, /e\.key !== 'Tab'/); assert.match(comp, /e\.key === 'Escape'/);
  assert.match(comp, /document\.body\.dataset\.welcomeOpen = '1'/);
  assert.match(comp, /const onOpen = \(\) => \{ if \(userRef\.current\) setOpen\(true\); \}/, 'Welcome tour re-open is explicit, not deferred');
});
