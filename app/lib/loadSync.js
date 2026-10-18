// Tells an open load page that its data changed elsewhere (QA #82, RC-03: after a rate con re-run the load page
// kept showing "—" for Planned miles until a browser reload). Same tab, other tabs (BroadcastChannel, with a
// localStorage fallback) and back/forward-cache restores all lead to a re-fetch. No data travels here, only the load id.
const CHANNEL = 'powerhaul-load-changed';
const LS_KEY = 'ph:load-changed';

export function notifyLoadChanged(loadId, win = typeof window !== 'undefined' ? window : null) {
  if (!win || !loadId) return;
  const msg = { loadId: String(loadId), at: Date.now(), n: Math.random().toString(36).slice(2) };
  try { win.dispatchEvent(new win.CustomEvent(CHANNEL, { detail: msg })); } catch {}
  try { if (win.BroadcastChannel) { const bc = new win.BroadcastChannel(CHANNEL); bc.postMessage(msg); bc.close(); } } catch {}
  try { win.localStorage?.setItem(LS_KEY, JSON.stringify(msg)); } catch {}
}

// cb() runs when this load changed elsewhere, the page comes back from the bfcache, or the tab becomes visible
// again. Returns an unsubscribe function.
export function onLoadChanged(loadId, cb, win = typeof window !== 'undefined' ? window : null) {
  if (!win || !loadId) return () => {};
  const id = String(loadId);
  const seen = new Set(); // one message can arrive twice in the same tab (event + BroadcastChannel)
  const hit = (m) => {
    if (!m || (m.loadId !== id && m.loadId !== '*')) return;
    if (m.n) { if (seen.has(m.n)) return; seen.add(m.n); if (seen.size > 50) seen.clear(); }
    cb('changed');
  };
  const onLocal = (e) => hit(e.detail);
  const onStorage = (e) => { if (e.key === LS_KEY && e.newValue) { try { hit(JSON.parse(e.newValue)); } catch {} } };
  const onShow = (e) => { if (e.persisted) cb('pageshow'); };
  const onVis = () => { if (win.document?.visibilityState === 'visible') cb('visible'); };
  let bc = null;
  try { if (win.BroadcastChannel) { bc = new win.BroadcastChannel(CHANNEL); bc.onmessage = (e) => hit(e.data); } } catch {}
  win.addEventListener(CHANNEL, onLocal);
  win.addEventListener('storage', onStorage);
  win.addEventListener('pageshow', onShow);
  win.document?.addEventListener?.('visibilitychange', onVis);
  return () => {
    win.removeEventListener(CHANNEL, onLocal);
    win.removeEventListener('storage', onStorage);
    win.removeEventListener('pageshow', onShow);
    win.document?.removeEventListener?.('visibilitychange', onVis);
    try { bc?.close(); } catch {}
  };
}
