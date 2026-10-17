// "Fill & download PDF" retry without a double fill (QA r2 D). The first tap can lose its connection while the
// server is still filling (cold start + slow request dropped on the way back). The client then retries once with
// ?retry=1, and the server reuses a fill it just finished, as long as no field was edited or signed since,
// instead of filling (and storing) the same PDF twice.
export const RECENT_FILL_MS = 2 * 60_000;
export const RETRY_WAIT_MS = 8_000;   // how long a retry waits for an in-flight first attempt to finish
export const RETRY_POLL_MS = 1_000;

const ms = (v) => { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
// Latest change to any field (edit, name copy, signature, clear) → ms or null.
export function lastFieldChange(rows = []) {
  let m = null;
  for (const r of rows || []) for (const k of ['updated_at', 'signed_at', 'created_at']) { const t = ms(r?.[k]); if (t != null && (m == null || t > m)) m = t; }
  return m;
}
// True when packet.filled_path is a fill from the last RECENT_FILL_MS that is newer than every field change.
export function fillReusable(packet, rows, now = Date.now(), windowMs = RECENT_FILL_MS) {
  const at = ms(packet?.filled_at);
  if (!packet?.filled_path || at == null || now - at > windowMs || at > now + 5_000) return false;
  const changed = lastFieldChange(rows);
  return changed == null || changed <= at;
}
// Server: wait briefly for an in-flight first attempt, then decide. → packet row to reuse, or null (fill normally).
export async function findReusableFill(sb, packet, rows, { now = () => Date.now(), sleep = (t) => new Promise((r) => setTimeout(r, t)), waitMs = RETRY_WAIT_MS, pollMs = RETRY_POLL_MS } = {}) {
  let p = packet;
  const until = now() + waitMs;
  for (;;) {
    if (fillReusable(p, rows, now())) return p;
    if (now() >= until) return null;
    await sleep(pollMs);
    try {
      const { data } = await sb.from('packets').select('*').eq('id', packet.id).maybeSingle();
      if (data) p = data;
    } catch { /* keep the last copy */ }
  }
}
// Client: one automatic retry, only when the request never got an answer (status 0 = network drop).
export async function fillWithRetry(call, { sleep = (t) => new Promise((r) => setTimeout(r, t)), delayMs = 1500 } = {}) {
  const first = await call(false);
  if (!first || first.status !== 0) return first;
  await sleep(delayMs);
  const second = await call(true);
  return second && second.status === 0 ? { ...second, error: 'Network problem while filling. Check your connection and tap Fill again.' } : second;
}
