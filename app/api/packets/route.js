import { serviceClient, userClient, bearer } from '../../lib/packetServer';
import { listPackets } from '../../lib/packetList';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

// GET /api/packets?view=active|archived → { rows, ownerId, archivedCount, canManage }. Any company member.
// Server-Timing reports the two database rounds so slow refreshes can be diagnosed from the browser.
export async function GET(req, { deps } = {}) {
  const t0 = Date.now();
  const sb = deps?.sb || serviceClient();
  if (!sb) return Response.json({ error: 'Storage not configured' }, { status: 503 });
  const token = bearer(req);
  if (!token) return Response.json({ error: 'Sign in again.' }, { status: 401 });
  const view = new URL(req.url).searchParams.get('view') === 'archived' ? 'archived' : 'active';
  const timings = {};
  const r = await listPackets({ uc: (deps?.mkUserClient || userClient)(token), sb, view, timings });
  const headers = { 'Cache-Control': 'no-store', 'Server-Timing': `db1;dur=${timings.db1 ?? 0}, db2;dur=${timings.db2 ?? 0}, total;dur=${Date.now() - t0}` };
  if (r.error) return Response.json({ error: r.error }, { status: r.status, headers });
  return Response.json(r, { headers });
}
