// Phone app only: keeps location sharing going while PowerHaul is in the background (screen locked, another app open),
// using @capacitor-community/background-geolocation. In a browser every function here is a no-op (isNative() is false),
// so the website keeps its foreground-only sharing exactly as before.
//
// Flow: the signed-in page asks /api/location-share/device-key for a share-only key (kept in memory only), starts a
// background watcher, and uploads points with the native HTTP layer to /api/location-share/device-ping (X-Share-Key).
// Native HTTP matters on Android: requests from the web view are throttled after ~5 minutes in the background.
// Server answers: 409 ended → stop; 401 → ask for a new key while the page can (signed in, visible); 429 → wait.
import { isNative } from './native.js';
import { nextPingWaitMs, HEARTBEAT_MS } from './locationShare.js';

export const DEVICE_KEY_HEADER = 'X-Share-Key';
export const MAX_QUEUE = 50;              // matches the server's per-upload cap; older points are dropped first
export const RETRY_MS = 30_000;           // network failure: retry with the next location, at most this often

// DRAFT wording, pending Marc's approval (see powerhaul-docs/2026-11-25_native-app-wording_DRAFT.md). Shown only in the app.
export const NOTIFY_TITLE_DRAFT = 'PowerHaul is sharing your location';
export const NOTIFY_TEXT_DRAFT = 'Your company can see where you are until you tap Stop in the app.';
export const BAR_NATIVE_DRAFT = 'Updates keep going while the phone is locked or you’re in another app.';
export const CONSENT_NATIVE_DRAFT = 'In the PowerHaul app, location keeps being sent while the share is on, even when you switch apps or lock the phone. Your phone shows that location is in use. If the phone closes PowerHaul, updates stop until you open it again. The share stays on until you stop it or it expires.';

const defaultWin = () => (typeof window === 'undefined' ? undefined : window);
const defaultLoadCore = () => import('@capacitor/core');

let cachedPlugin = null;
async function loadPlugin(loadCore) {
  if (cachedPlugin) return cachedPlugin;
  const core = await loadCore();
  cachedPlugin = { BG: core.registerPlugin('BackgroundGeolocation'), Http: core.CapacitorHttp };
  return cachedPlugin;
}
export function _resetPluginCache() { cachedPlugin = null; }

// Plugin location → API point.
export function toPoint(loc) {
  if (!loc || !Number.isFinite(Number(loc.latitude)) || !Number.isFinite(Number(loc.longitude))) return null;
  return {
    lat: Number(loc.latitude), lng: Number(loc.longitude),
    accuracy_m: loc.accuracy ?? null, speed_mps: loc.speed ?? null, heading: loc.bearing ?? null,
    recorded_at: new Date(Number.isFinite(Number(loc.time)) ? Number(loc.time) : Date.now()).toISOString(),
  };
}

// deps: issueKey(shareId) → { key } | { ended } | { setupNeeded } | { error }; canReissue() → bool (page visible + signed in);
// onEnded(), onDenied(), onState(state); win, loadCore, now.
export function createBackgroundSharer({
  issueKey, canReissue = () => false, onEnded = () => {}, onDenied = () => {}, onState = () => {},
  win = defaultWin(), loadCore = defaultLoadCore, now = () => Date.now(),
} = {}) {
  let shareId = null, key = null, watcherId = null, plugin = null;
  let queue = [], sending = false, retryAt = 0, stopped = true;
  const last = { at: null, fix: null, hbAt: null };

  const origin = () => win?.location?.origin || '';

  async function getKey() {
    const r = await issueKey(shareId);
    if (r?.key) { key = r.key; return 'ok'; }
    if (r?.ended) return 'ended';
    return 'fail';
  }

  async function flush() {
    if (sending || stopped || !queue.length || !plugin) return;
    if (now() < retryAt) return;
    if (!key) {
      if (!canReissue()) return;
      const g = await getKey();
      if (g === 'ended') { await end(); return; }
      if (g !== 'ok') { retryAt = now() + RETRY_MS; return; }
    }
    sending = true;
    const batch = queue.slice(0, MAX_QUEUE);
    const heartbeatOnly = batch.length === 1 && batch[0].heartbeat;
    const body = heartbeatOnly ? { ...batch[0] } : { points: batch.map(({ heartbeat, ...p }) => p) };
    let res;
    try {
      res = await plugin.Http.request({
        method: 'POST', url: `${origin()}/api/location-share/device-ping`,
        headers: { 'Content-Type': 'application/json', [DEVICE_KEY_HEADER]: key },
        data: body, connectTimeout: 15_000, readTimeout: 15_000,
      });
    } catch {
      res = null;
    }
    sending = false;
    const status = res?.status || 0;
    if (status === 200) { queue = queue.slice(batch.length); return; }
    if (status === 409 && (res?.data?.code === 'ended' || !res?.data?.setupNeeded)) { await end(); return; }
    if (status === 401) { key = null; return; }                      // ask for a new key next time the page can
    if (status === 429) { retryAt = now() + (Number(res?.data?.retry_after_s) || 10) * 1000; return; }
    if (status === 403) { await end(); return; }                      // no longer allowed (left the company)
    if (status === 413 || status === 422 || status === 400) { queue = queue.slice(batch.length); return; }
    retryAt = now() + RETRY_MS;                                      // offline / server error: keep the points
  }

  function onLocation(loc, err) {
    if (stopped) return;
    if (err) {
      if (err.code === 'NOT_AUTHORIZED') { onDenied(); onState('denied'); }
      return;
    }
    const p = toPoint(loc);
    if (!p) return;
    const fix = { lat: p.lat, lng: p.lng, accuracy_m: p.accuracy_m, speed_mps: p.speed_mps, heading: p.heading };
    const t = now();
    const wait = nextPingWaitMs({ lastAt: last.at, prev: last.fix, next: fix, now: t });
    if (wait === 0) { last.at = t; last.hbAt = t; last.fix = fix; queue.push(p); }
    else if (t - (last.hbAt || 0) >= HEARTBEAT_MS) { last.hbAt = t; queue.push({ ...p, heartbeat: true }); }
    else return;
    if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    flush();
  }

  async function end() {
    await stop();
    onEnded();
  }

  // → true when the background watcher is running (the caller then skips its foreground loop), false to fall back.
  async function start(id) {
    if (!isNative(win) || !id || typeof issueKey !== 'function') return false;
    if (!stopped && shareId === id) return true;
    await stop();
    shareId = id; stopped = false; queue = []; retryAt = 0; key = null;
    last.at = null; last.fix = null; last.hbAt = null;
    const g = await getKey();
    if (g !== 'ok') { stopped = true; shareId = null; if (g === 'ended') onEnded(); return false; }
    try {
      plugin = await loadPlugin(loadCore);
      watcherId = await plugin.BG.addWatcher({
        backgroundTitle: NOTIFY_TITLE_DRAFT,
        backgroundMessage: NOTIFY_TEXT_DRAFT,
        requestPermissions: true,
        stale: false,
        distanceFilter: 0,
      }, onLocation);
    } catch {
      stopped = true; shareId = null; key = null; watcherId = null;
      return false;
    }
    if (stopped) { // stopped while the watcher was being added
      try { await plugin.BG.removeWatcher({ id: watcherId }); } catch { /* already gone */ }
      watcherId = null;
      return false;
    }
    onState('on');
    return true;
  }

  async function stop() {
    const id = watcherId;
    stopped = true; watcherId = null; key = null; queue = []; shareId = null;
    if (id && plugin) { try { await plugin.BG.removeWatcher({ id }); } catch { /* already gone */ } }
    onState('off');
  }

  // Page came back to the foreground: send anything queued (and get a new key if the old one ran out).
  const resume = () => flush();

  return { start, stop, resume, _state: () => ({ shareId, key, watcherId, queue: [...queue], stopped, retryAt }) };
}
