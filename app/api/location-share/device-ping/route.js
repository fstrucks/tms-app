// POST from the phone app's background location (no sign-in token): X-Share-Key header from /device-key.
// Body { points: [...] } or one point. Writes only to that key's live share, with the share's company. Rate-limited;
// never logs coordinates or keys. 401 bad_key/key_expired → the app asks for a new key next time it is open;
// 409 ended → the app stops tracking.
import { recordDevicePings, json, SETUP } from '../../../lib/locationShareServer';
import { serviceClient } from '../../../lib/packetServer';
import { readDeviceKey } from '../../../lib/locationShareDevice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps = {} } = {}) {
  const key = readDeviceKey(req);
  if (!key) return json({ error: 'Sign in again on this phone.', code: 'bad_key' }, 401);
  const db = deps.sb || (deps.mkService ? deps.mkService() : serviceClient());
  if (!db) return json({ error: 'Location sharing isn’t set up on this server yet.' }, 503);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const now = deps.now ? deps.now() : Date.now();
  const r = await recordDevicePings(db, key, body, now);
  if (r.setupNeeded) return json(SETUP, 409);
  if (r.error) {
    const res = json({ error: r.error, code: r.code, retry_after_s: r.retry_after_s }, r.status || 400);
    if (r.retry_after_s) res.headers.set('Retry-After', String(r.retry_after_s));
    return res;
  }
  return json({ ok: true, saved: r.saved, skipped: r.skipped, rejected: r.rejected, heartbeat: !!r.heartbeat, recorded_at: r.recorded_at || null });
}
