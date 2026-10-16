import { serviceClient, packetAccess, isMissingSchema } from '../../../../lib/packetServer';
import { parseSignature, signaturePath, formatPacketDate, SIGN_MIGRATION } from '../../../../lib/packetSign';
import { toClient } from '../../../../lib/packetFieldEdits';
import { canSign } from '../../../../lib/companyRoles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });

const SETUP = { error: 'Signing needs a database update that hasn’t been applied yet.', migration: SIGN_MIGRATION };

// Body: { fieldId, dataUrl, signerName, signedAt, method } (SignaturePad onDone + the field).
// Owner/dispatcher/management only. PNG goes to the OWNER's folder via the service key; empty Date fields
// on the packet are filled with the signing date.
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canSign(a.role)) return json({ error: 'Only the owner, dispatcher or management can sign packets.' }, 403);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request.' }, 400); }
  const sig = parseSignature(body);
  if (sig.error) return json({ error: sig.error }, 422);
  const { data: rows, error: lErr } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id);
  if (lErr) return json({ error: 'Could not load fields.' }, 500);
  const field = (rows || []).find((r) => r.id === String(body.fieldId || ''));
  if (!field) return json({ error: 'Field not found.' }, 404);
  if (field.kind !== 'signature' && field.profile_key !== 'signature') return json({ error: 'That field is not a signature field.' }, 400);
  const path = signaturePath(a.packet.owner_id, a.packet.id, field.id, deps?.ts);
  const { error: upErr } = await sb.storage.from('documents').upload(path, sig.png, { contentType: 'image/png', upsert: false });
  if (upErr) { console.error('[packets] sign upload', upErr.message); return json({ error: 'Could not save the signature.' }, 500); }
  const { error: uErr } = await sb.from('packet_fields').update({ signature_path: path, signer_name: sig.signerName, signed_at: sig.signedAt, signed_by: a.user.id, updated_by: a.user.id, updated_at: new Date().toISOString() })
    .eq('id', field.id).eq('packet_id', a.packet.id);
  if (uErr) {
    await sb.storage.from('documents').remove([path]);
    return isMissingSchema(uErr) ? json(SETUP, 503) : json({ error: 'Could not save the signature.' }, 500);
  }
  const date = formatPacketDate(sig.signedAt);
  for (const r of (rows || []).filter((r) => (r.kind === 'date' || r.profile_key === 'date') && !r.value_text)) {
    await sb.from('packet_fields').update({ value_text: date, updated_by: a.user.id }).eq('id', r.id).eq('packet_id', a.packet.id);
  }
  const { data: after } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id).order('page').order('field_key');
  return json({ ok: true, date, fields: (after || []).map(toClient) });
}
