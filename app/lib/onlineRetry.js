// Auto-recover a failed screen when the connection comes back (QA #100: /loads showed Retry but stayed on the error
// after going back online). Pages call useRetryWhenOnline(isError, retry): while the page is in its error state, the
// window 'online' event re-runs the fetch once (after a short pause so the network is really up).
import { useEffect, useRef } from 'react';

export const ONLINE_RETRY_DELAY_MS = 800;

// → cleanup. target: anything with add/removeEventListener (window in the browser).
export function onReconnect(fn, { target = typeof window === 'undefined' ? null : window, delayMs = ONLINE_RETRY_DELAY_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!target?.addEventListener) return () => {};
  let t = null;
  const on = () => { if (t) clearTimer(t); t = setTimer(() => { t = null; fn(); }, delayMs); };
  target.addEventListener('online', on);
  return () => { target.removeEventListener('online', on); if (t) clearTimer(t); };
}

export function useRetryWhenOnline(active, retry) {
  const ref = useRef(retry);
  ref.current = retry;
  useEffect(() => (active ? onReconnect(() => ref.current?.()) : undefined), [active]);
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
