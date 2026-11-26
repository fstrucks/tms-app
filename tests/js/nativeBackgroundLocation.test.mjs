// Phone app background sharing (client side). Fake plugin and fake native HTTP; no device, no network, fake data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createBackgroundSharer, toPoint, _resetPluginCache, DEVICE_KEY_HEADER, MAX_QUEUE, RETRY_MS,
  NOTIFY_TITLE_DRAFT, NOTIFY_TEXT_DRAFT, BAR_NATIVE_DRAFT, CONSENT_NATIVE_DRAFT,
} from '../../app/lib/nativeBackgroundLocation.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const SID = '00000000-0000-4000-8000-0000000000a1';
const T0 = Date.parse('2026-11-25T18:00:00Z');
const KEY = 'phsk_' + 'A'.repeat(43);
const webWin = { location: { origin: 'https://tms.example' } };
const nativeWin = { Capacitor: { isNativePlatform: () => true }, location: { origin: 'https://tms.example' } };
const neverLoad = () => { throw new Error('plugin must not load on the web'); };

function fakeCore({ responses = [], addWatcherThrows = false } = {}) {
  const calls = { added: [], removed: [], http: [] };
  let cb = null;
  const core = {
    registerPlugin: (name) => {
      assert.equal(name, 'BackgroundGeolocation');
      return {
        addWatcher: async (opts, fn) => { if (addWatcherThrows) throw new Error('no plugin'); calls.added.push(opts); cb = fn; return 'w1'; },
        removeWatcher: async ({ id }) => { calls.removed.push(id); },
      };
    },
    CapacitorHttp: {
      request: async (req) => {
        calls.http.push(req);
        const r = responses.length ? responses.shift() : { status: 200, data: { ok: true } };
        if (r === 'throw') throw new Error('offline');
        return r;
      },
    },
  };
  return { load: async () => core, calls, emit: (loc, err) => cb(loc, err) };
}
const loc = (lat, lng, t, extra = {}) => ({ latitude: lat, longitude: lng, accuracy: 10, speed: 25, bearing: 90, time: t, ...extra });
const settle = () => new Promise((r) => setTimeout(r, 0));

test('browser: start() is a no-op, never loads the plugin or asks for a key', async () => {
  _resetPluginCache();
  let asked = false;
  const s = createBackgroundSharer({ win: webWin, loadCore: neverLoad, issueKey: async () => { asked = true; return { key: KEY }; } });
  assert.equal(await s.start(SID), false);
  assert.equal(asked, false);
});

test('app: start asks for a key, adds a background watcher with the notification text, uploads with native HTTP and the key header', async () => {
  _resetPluginCache();
  const f = fakeCore();
  let now = T0;
  const states = [];
  const s = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async (id) => { assert.equal(id, SID); return { key: KEY }; }, onState: (x) => states.push(x), now: () => now });
  assert.equal(await s.start(SID), true);
  assert.equal(f.calls.added.length, 1);
  assert.equal(f.calls.added[0].backgroundTitle, NOTIFY_TITLE_DRAFT);
  assert.equal(f.calls.added[0].backgroundMessage, NOTIFY_TEXT_DRAFT, 'backgroundMessage set → updates continue in the background');
  assert.equal(f.calls.added[0].requestPermissions, true);
  f.emit(loc(41.8, -87.6, now));
  await settle();
  assert.equal(f.calls.http.length, 1);
  const req = f.calls.http[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://tms.example/api/location-share/device-ping');
  assert.equal(req.headers[DEVICE_KEY_HEADER], KEY);
  assert.equal(req.data.points.length, 1);
  assert.equal(req.data.points[0].lat, 41.8);
  assert.equal(req.data.points[0].recorded_at, new Date(T0).toISOString());
  assert.equal(JSON.stringify(req.data).includes(KEY), false, 'key goes in the header only');
  assert.ok(states.includes('on'));
});

test('cadence: follows the browser rules (moving ~1.5 min) and sends a heartbeat every ~2.5 min while parked', async () => {
  _resetPluginCache();
  const f = fakeCore();
  let now = T0;
  const s = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async () => ({ key: KEY }), now: () => now });
  await s.start(SID);
  f.emit(loc(41.8, -87.6, now)); await settle();
  now += 10_000; f.emit(loc(41.8001, -87.6, now, { speed: 0 })); await settle();
  assert.equal(f.calls.http.length, 1, 'no upload 10 s later while parked');
  now += 160_000; f.emit(loc(41.8001, -87.6, now, { speed: 0 })); await settle();
  assert.equal(f.calls.http.length, 2);
  assert.equal(f.calls.http[1].data.heartbeat, true);
  assert.equal(f.calls.http[1].data.points, undefined);
});

test('409 ended → watcher removed and onEnded; 401 → key dropped, re-issued only when the page can; 429 → waits', async () => {
  _resetPluginCache();
  const f = fakeCore({ responses: [{ status: 401, data: { code: 'bad_key' } }, { status: 200, data: {} }, { status: 429, data: { code: 'slow_down', retry_after_s: 7 } }, { status: 409, data: { code: 'ended' } }] });
  let now = T0, visible = false, issued = 0, ended = 0;
  const s = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async () => { issued += 1; return { key: KEY }; }, canReissue: () => visible, onEnded: () => { ended += 1; }, now: () => now });
  await s.start(SID);
  assert.equal(issued, 1);
  f.emit(loc(41.8, -87.6, now)); await settle();             // 401
  assert.equal(s._state().key, null);
  assert.equal(s._state().queue.length, 1, 'point kept for later');
  now += 100_000; f.emit(loc(42.0, -87.6, now)); await settle();
  assert.equal(f.calls.http.length, 1, 'no key and page hidden → nothing sent, nothing re-issued');
  assert.equal(issued, 1);
  visible = true; await s.resume(); await settle();          // re-issue + 200
  assert.equal(issued, 2);
  assert.equal(f.calls.http.length, 2);
  assert.equal(f.calls.http[1].data.points.length, 2, 'queued points go together');
  assert.equal(s._state().queue.length, 0);
  now += 100_000; f.emit(loc(42.2, -87.6, now)); await settle();   // 429
  assert.equal(s._state().retryAt, now + 7000);
  now += 3000; await s.resume(); await settle();
  assert.equal(f.calls.http.length, 3, 'waits out Retry-After');
  now += 5000; await s.resume(); await settle();             // 409
  assert.equal(ended, 1);
  assert.deepEqual(f.calls.removed, ['w1']);
  assert.equal(s._state().stopped, true);
});

test('offline: points are kept (newest 50) and retried; a thrown request never breaks the watcher', async () => {
  _resetPluginCache();
  const f = fakeCore({ responses: Array(80).fill('throw') });
  let now = T0;
  const s = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async () => ({ key: KEY }), now: () => now });
  await s.start(SID);
  for (let i = 0; i < 60; i++) { now += RETRY_MS + 100_000; f.emit(loc(41 + i * 0.01, -87.6, now)); await settle(); }
  assert.equal(s._state().queue.length, MAX_QUEUE);
  assert.equal(s._state().queue[MAX_QUEUE - 1].lat, 41 + 59 * 0.01);
});

test('no key (database update not applied, or share ended) → start returns false so the foreground loop keeps working', async () => {
  _resetPluginCache();
  const f = fakeCore();
  let ended = 0;
  const a = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async () => ({ error: true, setupNeeded: true }) });
  assert.equal(await a.start(SID), false);
  const b = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async () => ({ ended: true }), onEnded: () => { ended += 1; } });
  assert.equal(await b.start(SID), false);
  assert.equal(ended, 1);
  assert.equal(f.calls.added.length, 0);
  _resetPluginCache();
  const g = fakeCore({ addWatcherThrows: true });
  const c = createBackgroundSharer({ win: nativeWin, loadCore: g.load, issueKey: async () => ({ key: KEY }) });
  assert.equal(await c.start(SID), false, 'plugin missing in an older app build');
});

test('permission refused → onDenied; stop removes the watcher and forgets the key', async () => {
  _resetPluginCache();
  const f = fakeCore();
  let denied = 0;
  const s = createBackgroundSharer({ win: nativeWin, loadCore: f.load, issueKey: async () => ({ key: KEY }), onDenied: () => { denied += 1; } });
  await s.start(SID);
  f.emit(undefined, Object.assign(new Error('no'), { code: 'NOT_AUTHORIZED' }));
  assert.equal(denied, 1);
  await s.stop();
  assert.deepEqual(f.calls.removed, ['w1']);
  assert.equal(s._state().key, null);
  f.emit(loc(41.8, -87.6, T0)); await settle();
  assert.equal(f.calls.http.length, 0, 'nothing sent after stop');
});

test('toPoint maps plugin fields and rejects bad input', () => {
  assert.deepEqual(toPoint(loc(41.5, -87.5, T0)), { lat: 41.5, lng: -87.5, accuracy_m: 10, speed_mps: 25, heading: 90, recorded_at: new Date(T0).toISOString() });
  assert.equal(toPoint({ latitude: 'x', longitude: 1 }), null);
  assert.equal(toPoint(null), null);
});

test('web unchanged: the bar only starts the native sharer inside the app, and keeps its web text and foreground loop otherwise', () => {
  const bar = read('app/components/LocationShareBar.js');
  assert.match(bar, /if \(!share\?\.id \|\| !isNative\(\)\) return undefined;/);
  assert.match(bar, /useState\(\(\) => \(isNative\(\) \? 'pending' : 'off'\)\)/);
  assert.match(bar, /if \(!share\?\.id \|\| nativeMode !== 'off'\) return undefined;/);
  assert.match(bar, /Updates pause if you close the app or lock the phone\./);
  assert.match(bar, /\/api\/location-share\/ping/);
  const page = read('app/location/page.js');
  assert.match(page, /useEffect\(\(\) => \{ setInApp\(isNative\(\)\); \}, \[\]\)/);
  assert.match(page, /inApp \? CONSENT_NATIVE_DRAFT : CONSENT_FOREGROUND/);
});

test('draft wording is marked as draft and never mentions how the app is built', () => {
  const src = read('app/lib/nativeBackgroundLocation.js');
  assert.match(src, /DRAFT wording, pending Marc's approval/);
  for (const t of [NOTIFY_TITLE_DRAFT, NOTIFY_TEXT_DRAFT, BAR_NATIVE_DRAFT, CONSENT_NATIVE_DRAFT]) {
    assert.equal(/\bbots?\b|\bAI\b|agent|Grok|Capacitor|plugin/i.test(t), false, t);
  }
});

test('native config: iOS background location mode + Always text; Android legacy bridge; GPS optional; no background-location permission', () => {
  const plist = read('ios/App/App/Info.plist');
  assert.match(plist, /<key>UIBackgroundModes<\/key>\s*<array>\s*<string>location<\/string>/);
  assert.match(plist, /NSLocationAlwaysAndWhenInUseUsageDescription/);
  assert.equal(/sent only while the app is open/.test(plist), false, 'old foreground-only promise removed');
  assert.match(read('capacitor.config.js'), /useLegacyBridge: true/);
  const man = read('android/app/src/main/AndroidManifest.xml');
  assert.match(man, /android\.hardware\.location\.gps" android:required="false" tools:replace="android:required"/);
  assert.equal(/<uses-permission[^>]+ACCESS_BACKGROUND_LOCATION/.test(man), false);
  assert.match(read('ios/App/CapApp-SPM/Package.swift'), /@capacitor-community\/background-geolocation/);
  assert.match(read('android/capacitor.settings.gradle'), /capacitor-community-background-geolocation/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.dependencies['@capacitor-community/background-geolocation'], '1.3.2');
});
