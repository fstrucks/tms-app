import { serviceClient, packetAccess } from '../../../../lib/packetServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });

// Short-lived signed URLs for this packet's saved signature PNGs (owner folder), for the in-app preview.
// Any company member who can view the packet may see them (same check as the file route).
export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  const { data: rows, error } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id);
  if (error) return json({ error: 'Could not load signatures.' }, 500);
  const urls = {};
  for (const r of (rows || []).filter((r) => r.signature_path)) {
    if (!r.signature_path.startsWith(`${a.packet.owner_id}/packets/signatures/`)) continue; // never sign paths outside the owner's folder
    const { data } = await sb.storage.from('documents').createSignedUrl(r.signature_path, 600);
    if (data?.signedUrl) urls[r.id] = data.signedUrl;
  }
  return json({ urls });
}
