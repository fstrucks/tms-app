import { serviceClient, packetAccess } from '../../../lib/packetServer';
import { deletePacket } from '../../../lib/packetDelete';
import { canManagePackets } from '../../../lib/packetStatus';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });

// DELETE /api/packets/{id}: owner/management only. Removes the row (fields + send log cascade) and every
// storage file for the packet (original PDF, filled PDFs, signature images) with the service key.
export async function DELETE(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canManagePackets(a.role)) return json({ error: 'Only the owner or management can delete packets.' }, 403);
  const r = await deletePacket(sb, a.packet);
  if (r.error) return json({ error: r.error }, r.status);
  return json(r);
}
