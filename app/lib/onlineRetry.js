// Auto-recover a failed screen when the connection comes back.
// QA #100 r2 root cause: the first version retried exactly ONCE, 800 ms after the 'online' event. Right after
// DevTools (or a real phone) goes back online the first request often still fails (the browser drops the old
// connection: ERR_NETWORK_CHANGED / "Failed to fetch"), the page set a fresh error, and because it was still in the
// error state the listener effect never re-armed: nothing ever tried again until Retry was tapped.
// Now, while a page is in its error state: 'online', 'focus' and the tab becoming visible each trigger a probe, AND a
// backoff timer keeps probing (5 s, 10 s, 20 s, then every 30 s) until the page leaves the error state or unmounts.
// Probes never overlap. The page's retry must be quiet (no switch to Loading), so the error state, and with it this
// loop, stays alive until a probe succeeds.
import { useEffect, useRef } from 'react';

export const ONLINE_RETRY_DELAY_MS = 800;
export const RECOVER_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000]; // last value repeats (cap)

// → stop(). retry: async () => any. Pure (inject window/document/timers) so it can be tested.
export function startRecovery(retry, {
  win = typeof window === 'undefined' ? null : window,
  doc = typeof document === 'undefined' ? null : document,
  schedule = RECOVER_BACKOFF_MS, eventDelayMs = ONLINE_RETRY_DELAY_MS,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let stopped = false, inflight = false, step = 0, timer = null, soon = null;
  const arm = () => {
    if (stopped) return;
    if (timer) clearTimer(timer);
    timer = setTimer(() => { timer = null; probe(); }, schedule[Math.min(step, schedule.length - 1)]);
    step++;
  };
  async function probe() {
    if (stopped || inflight) return;
    inflight = true;
    try { await retry(); } catch { /* still failing: keep going */ } finally { inflight = false; }
    arm(); // if the probe worked, the page leaves the error state and stop() cancels this
  }
  const nudge = () => { // online / focus / visible: probe shortly, without waiting for the backoff
    if (stopped) return;
    if (doc && doc.visibilityState && doc.visibilityState !== 'visible') return;
    if (soon) clearTimer(soon);
    soon = setTimer(() => { soon = null; step = 0; probe(); }, eventDelayMs); // connection likely back: restart the backoff at 5 s
  };
  win?.addEventListener?.('online', nudge); win?.addEventListener?.('focus', nudge); doc?.addEventListener?.('visibilitychange', nudge);
  arm();
  return () => {
    stopped = true;
    if (timer) clearTimer(timer); if (soon) clearTimer(soon);
    win?.removeEventListener?.('online', nudge); win?.removeEventListener?.('focus', nudge); doc?.removeEventListener?.('visibilitychange', nudge);
  };
}

// Kept for older callers/tests: just the 'online' part.
export function onReconnect(fn, { target = typeof window === 'undefined' ? null : window, delayMs = ONLINE_RETRY_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!target?.addEventListener) return () => {};
  let t = null;
  const on = () => { if (t) clearTimer(t); t = setTimer(() => { t = null; fn(); }, delayMs); };
  target.addEventListener('online', on);
  return () => { target.removeEventListener('online', on); if (t) clearTimer(t); };
}

// While `active` (the page's error state), keep trying to recover; stops when it clears or on unmount.
// The latest retry is read through a ref, so a re-render never leaves a stale closure behind.
export function useRetryWhenOnline(active, retry) {
  const ref = useRef(retry);
  ref.current = retry;
  useEffect(() => (active ? startRecovery(() => ref.current?.()) : undefined), [active]);
}

// Run a page's loader; if it ends in an error state, try once more automatically after a pause.
// load() → resolves to true when it ended in an error state.
export const AUTO_RETRY_MS = 1200;
export async function loadWithOneRetry(load, { delayMs = AUTO_RETRY_MS, wait = (ms) => new Promise((r) => setTimeout(r, ms)), isLive = () => true } = {}) {
  const failed = await load({ auto: false });
  if (!failed || !isLive()) return failed;
  await wait(delayMs);
  if (!isLive()) return failed;
  return load({ auto: true });
}

// A fetch that never answers (offline with a half-open socket) must end in the error state, not sit on Loading.
export const LOAD_TIMEOUT_MS = 20_000;
export function withTimeout(promise, ms = LOAD_TIMEOUT_MS, onTimeout = () => true, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let t;
  const timeout = new Promise((resolve) => { t = setTimer(() => resolve(onTimeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimer(t));
}
