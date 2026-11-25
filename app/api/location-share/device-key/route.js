// POST { share_id }: the signed-in sharer asks for a share-only sending key for the phone app (background location).
// Only the person sharing, only while the share is live. Returns the key once; only its hash is stored. Never logged.
import { locationShareCtx, issueDeviceKey, json, SETUP } from '../../../lib/locationShareServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req, { deps } = {}) {
  const x = await locationShareCtx(req, deps); if (x.res) return x.res;
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const r = await issueDeviceKey(x.db, { userId: x.user.id, companyId: x.companyId }, body, x.now());
  if (r.setupNeeded) return json(SETUP, 409);
  if (r.error) return json({ error: r.error, code: r.code }, r.status || 400);
  return json({ ok: true, key: r.key, share_id: r.share_id, expires_at: r.expires_at });
}
