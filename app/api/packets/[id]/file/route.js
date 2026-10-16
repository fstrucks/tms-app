import { serviceClient, packetAccess } from '../../../../lib/packetServer';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const NO_STORE = { 'Cache-Control': 'no-store' };
const json = (b, s = 200) => Response.json(b, { status: s, headers: NO_STORE });
// Vercel caps function responses at ~4.5 MB; bigger PDFs only go through the signed URL.
export const RAW_MAX_BYTES = 4 * 1024 * 1024;

// Packet PDFs live under the OWNER's storage folder; storage RLS only lets a user read their own folder,
// so company members (drivers, dispatchers) can't sign or read them in the browser. Access is checked here
// (packet owner or a company_members row on the owner's company, via packet_role), then the service client
// signs the URL. ?raw=1 streams the bytes instead (fallback when the signed URL can't be fetched).
export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  const path = a.packet.file_path;
  if (!path) return json({ error: 'This packet has no PDF file.' }, 404);
  const raw = new URL(req.url).searchParams.get('raw') === '1';
  if (raw) {
    const { data, error } = await sb.storage.from('documents').download(path);
    if (error || !data) { console.error('[packets] download', error?.message); return json({ error: 'Could not open the PDF (file missing in storage).' }, 404); }
    if (data.size > RAW_MAX_BYTES) return json({ error: 'The PDF is too large to open this way.' }, 413);
    return new Response(data, { headers: { ...NO_STORE, 'Content-Type': 'application/pdf' } });
  }
  const { data, error } = await sb.storage.from('documents').createSignedUrl(path, 300);
  if (error || !data?.signedUrl) { console.error('[packets] sign', error?.message); return json({ error: 'Could not open the PDF.' }, 500); }
  return json({ url: data.signedUrl });
}
