import { serviceClient, packetAccess } from '../../../../lib/packetServer';
import { canManagePackets, isPendingStatus, unarchivedStatus } from '../../../../lib/packetStatus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });

// POST /api/packets/{id}/archive { archived: true|false }: owner/management only.
// Archived = status 'archived' (already allowed by the packets status check, so no migration).
// Unarchive restores the status implied by the packet's columns (sent_at → sent, processed → review/error).
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canManagePackets(a.role)) return json({ error: 'Only the owner or management can archive packets.' }, 403);
  const body = await req.json().catch(() => ({}));
  const archive = body?.archived !== false;
  const p = a.packet;
  if (archive && p.status === 'archived') return json({ ok: true, status: 'archived' });
  if (!archive && p.status !== 'archived') return json({ ok: true, status: p.status });
  if (archive && isPendingStatus(p.status)) return json({ error: 'Fields are still being found. Try again in a minute.' }, 409);
  const next = archive ? 'archived' : unarchivedStatus(p);
  // Only flip from the status we just read, so a send/processing update in between isn't overwritten.
  const { data, error } = await sb.from('packets').update({ status: next, updated_at: new Date().toISOString() }).eq('id', p.id).eq('status', p.status).select('id');
  if (error) { console.error('[packets] archive', error.code); return json({ error: 'Could not update the packet. Please try again.' }, 500); }
  if (!data?.length) return json({ error: 'This packet just changed. Refresh and try again.' }, 409);
  return json({ ok: true, status: next });
}
