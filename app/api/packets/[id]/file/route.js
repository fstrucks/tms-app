import { serviceClient, packetAccess } from '../../../../lib/packetServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s });

// Short-lived signed URL for the packet PDF (inbound files live under the owner's path, so members need this).
export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  const { data, error } = await sb.storage.from('documents').createSignedUrl(a.packet.file_path, 300);
  if (error || !data?.signedUrl) return json({ error: 'Could not open the PDF.' }, 500);
  return json({ url: data.signedUrl });
}
