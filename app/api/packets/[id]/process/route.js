import { serviceClient, packetAccess } from '../../../../lib/packetServer';
import { processPacket } from '../../../../lib/packetProcess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (b, s = 200) => Response.json(b, { status: s });

// Any member can start processing a received packet (drivers upload); only editors can force a re-run.
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  const force = new URL(req.url).searchParams.get('force') === '1';
  if (force && !a.canEdit) return json({ error: 'Only the owner, dispatcher or management can re-run detection.' }, 403);
  const out = await (deps?.process || processPacket)({ sb, packetId: a.packet.id, force });
  return json(out, out?.setupNeeded ? 503 : 200);
}
