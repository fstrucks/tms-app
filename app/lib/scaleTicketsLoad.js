// Client loader for the load page's Scale tickets card (kept JSX-free so it can be tested in Node).
// Waits for the signed-in session (up to ~4 s) instead of sending an empty token: right after the New load redirect
// the card mounts at once with the handed-off load, in the same burst as the page's own session check (PROD smoke
// after #86). Resolves to the access token or null.
export function waitForToken(supabase, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve) => {
    let done = false, sub = null, timer = null;
    const finish = (t) => { if (done) return; done = true; clearTimeout(timer); try { sub?.unsubscribe(); } catch { /* ignore */ } resolve(t || null); };
    try { sub = supabase.auth.onAuthStateChange((_e, session) => { if (session?.access_token) finish(session.access_token); })?.data?.subscription || null; } catch { /* ignore */ }
    timer = setTimeout(() => finish(null), timeoutMs);
    Promise.resolve(supabase.auth.getSession()).then((r) => { const t = r?.data?.session?.access_token; if (t) finish(t); }).catch(() => {});
  });
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
// One fetch of the card. → { ok, j, quiet } where quiet = worth one silent retry (sign-in check hiccup, 5xx, network).
async function fetchOnce(supabase, loadId) {
  const t = await waitForToken(supabase);
  if (!t) return { ok: false, quiet: true, j: { error: 'Your session is still loading. Reload the page if this stays.' } };
  try {
    const res = await fetch(`/api/loads/${loadId}/scale-tickets`, { cache: 'no-store', headers: { Authorization: `Bearer ${t}` } });
    const j = await res.json().catch(() => ({}));
    return { ok: res.ok, j, quiet: !res.ok && (res.status === 401 || res.status >= 500) };
  } catch { return { ok: false, quiet: true, j: {} }; }
}

// → { state: 'ready', ...json } | { state: 'error', error }. One quiet retry after a short pause; the error shows only
// if that fails too.
export async function loadScaleTickets(supabase, loadId, { retryMs = 800 } = {}) {
  let r = await fetchOnce(supabase, loadId);
  if (!r.ok && r.quiet) { await pause(retryMs); r = await fetchOnce(supabase, loadId); }
  return r.ok ? { state: 'ready', ...r.j } : { state: 'error', error: r.j.error || 'Couldn’t load scale tickets.' };
}
