// Auto-start location (Marc, Oct 21). Fake data only; no real positions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readAutoLocation, markOptedIn, setAutoLocation, shouldAutoStart, showLocationButton, queryGeoPermission, deniedHelp, OPTIN_KEY, AUTO_KEY } from '../../app/lib/autoLocation.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };

test('flags: opt-in after a tap; auto-start on by default; turning it off stops auto-start', () => {
  const st = mem();
  assert.deepEqual(readAutoLocation(st), { optedIn: false, enabled: true });
  markOptedIn(st); assert.equal(st.m.get(OPTIN_KEY), '1');
  assert.deepEqual(readAutoLocation(st), { optedIn: true, enabled: true });
  setAutoLocation(st, false); assert.equal(st.m.get(AUTO_KEY), '0'); assert.equal(readAutoLocation(st).enabled, false);
  setAutoLocation(st, true); assert.equal(st.m.has(AUTO_KEY), false);
  assert.deepEqual(readAutoLocation(null), { optedIn: false, enabled: true }); // no storage (private mode)
  const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
  assert.doesNotThrow(() => { markOptedIn(broken); readAutoLocation(broken); });
  for (const v of st.m.values()) assert.ok(v === '1' || v === '0', 'only on/off flags, never a position');
});

test('auto-start rules per permission state', () => {
  assert.equal(shouldAutoStart('granted', { optedIn: false, enabled: true }), true);
  assert.equal(shouldAutoStart('granted', { optedIn: true, enabled: false }), false);
  assert.equal(shouldAutoStart('prompt', { optedIn: false, enabled: true }), false);
  assert.equal(shouldAutoStart('prompt', { optedIn: true, enabled: true }), true);
  assert.equal(shouldAutoStart('denied', { optedIn: true, enabled: true }), false);
  assert.equal(shouldAutoStart('unsupported', { optedIn: true, enabled: true }), false);
  assert.equal(showLocationButton('prompt', { optedIn: false, enabled: true }), true);
  assert.equal(showLocationButton('prompt', { optedIn: true, enabled: true }), false);
  assert.equal(showLocationButton('granted', { optedIn: true, enabled: false }), true, 'off → manual button');
  assert.equal(showLocationButton('denied', { optedIn: false, enabled: true }), false);
});

test('queryGeoPermission: real states, missing API and throwing API fall back to prompt', async () => {
  const geo = {};
  assert.equal((await queryGeoPermission({ geolocation: geo, permissions: { query: async () => ({ state: 'granted' }) } })).state, 'granted');
  assert.equal((await queryGeoPermission({ geolocation: geo, permissions: { query: async () => ({ state: 'denied' }) } })).state, 'denied');
  assert.equal((await queryGeoPermission({ geolocation: geo })).state, 'prompt');
  assert.equal((await queryGeoPermission({ geolocation: geo, permissions: { query: async () => { throw new TypeError('unsupported name'); } } })).state, 'prompt');
  assert.equal((await queryGeoPermission({})).state, 'unsupported');
});

test('denied help text per platform', () => {
  assert.match(deniedHelp('ios'), /Location Services → Safari Websites/);
  assert.match(deniedHelp('ios'), /aA/);
  assert.match(deniedHelp('android'), /Site settings → Location/);
  assert.match(deniedHelp('desktop'), /reload/);
});

test('wiring: map panel uses the rules; settings page + menu link exist', () => {
  const p = readFileSync(new URL('../../app/components/LoadMapPanel.js', import.meta.url), 'utf8');
  assert.match(p, /queryGeoPermission\(navigator\)/);
  assert.match(p, /markOptedIn\(/);
  assert.match(p, /showLocationButton\(perm, prefs\)/);
  assert.match(p, /deniedHelp\(platform\)/);
  assert.ok(!/localStorage\.setItem\([^)]*(lat|lng|coords)/.test(p), 'never stores a position');
  const set = readFileSync(new URL('../../app/account/settings/page.js', import.meta.url), 'utf8');
  assert.match(set, /Auto-start location/); assert.match(set, /setAutoLocation\(/);
  const menu = readFileSync(new URL('../../app/components/ui/AccountMenu.js', import.meta.url), 'utf8');
  assert.match(menu, /href="\/account\/settings"/);
});
