import { serviceClient, packetAccess } from '../../../lib/packetServer';
import { deletePacket } from '../../../lib/packetDelete';
import { canManagePackets } from '../../../lib/packetStatus';
import { rematchLayout } from '../../../lib/packetLayouts';

export const BROKER_NAME_MAX = 120;
// '  Acme Test Logistics ' → 'Acme Test Logistics'; '' → null. → { value } | { error }
export function cleanBrokerName(v) {
  if (v == null) return { value: null };
  if (typeof v !== 'string') return { error: 'Broker name must be text.' };
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > BROKER_NAME_MAX) return { error: `Broker name is too long (${BROKER_NAME_MAX} characters max).` };
  return { value: t || null };
}

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

// PATCH /api/packets/{id} { broker_name }: owner, dispatcher or management. The Broker field on the packet page
// (pre-filled from the PDF text when it could be found). A new name re-checks remembered layouts (suggest only).
export async function PATCH(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!a.canEdit) return json({ error: 'Only the owner, dispatcher or management can change the broker.' }, 403);
  const body = await req.json().catch(() => null);
  if (!body || !('broker_name' in body)) return json({ error: 'Nothing to change.' }, 400);
  const c = cleanBrokerName(body.broker_name);
  if (c.error) return json({ error: c.error }, 400);
  const now = new Date().toISOString();
  const { error } = await sb.from('packets').update({ broker_name: c.value, updated_at: now }).eq('id', a.packet.id);
  if (error) { console.error('[packets] broker name', error.code); return json({ error: 'Could not save the broker. Please try again.' }, 500); }
  const packet = { ...a.packet, broker_name: c.value };
  const rematch = c.value !== (a.packet.broker_name || null) ? await (deps?.rematch || rematchLayout)(sb, packet) : null;
  return json({ ok: true, broker_name: c.value, layout: rematch });
}
