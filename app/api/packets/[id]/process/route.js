import { serviceClient, packetAccess } from '../../../../lib/packetServer';
import { waitUntil } from '@vercel/functions';
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
  // ?background=1 (right after upload): answer at once and keep processing after the response, so a closed tab,
  // a navigation or a dropped slow request can't leave the packet sitting at 'Waiting to start' (QA D).
  if (new URL(req.url).searchParams.get('background') === '1') {
    const job = (deps?.process || processPacket)({ sb, packetId: a.packet.id, force }).catch((e) => { console.error('[packets] background process', e?.message); return { error: 'failed' }; });
    (deps?.waitUntil || waitUntil)(job);
    return json({ started: true }, 202);
  }
  const out = await (deps?.process || processPacket)({ sb, packetId: a.packet.id, force });
  return json(out, out?.setupNeeded ? 503 : 200);
}
