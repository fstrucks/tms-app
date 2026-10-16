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
  const oldPath = field.signature_path;
  const path = signaturePath(a.packet.owner_id, a.packet.id, field.id, deps?.ts);
  const { error: upErr } = await sb.storage.from('documents').upload(path, sig.png, { contentType: 'image/png', upsert: false });
  if (upErr) { console.error('[packets] sign upload', upErr.message); return json({ error: 'Could not save the signature.' }, 500); }
  const { error: uErr } = await sb.from('packet_fields').update({ signature_path: path, signer_name: sig.signerName, signed_at: sig.signedAt, signed_by: a.user.id, updated_by: a.user.id, updated_at: new Date().toISOString() })
    .eq('id', field.id).eq('packet_id', a.packet.id);
  if (uErr) {
    await sb.storage.from('documents').remove([path]);
    return isMissingSchema(uErr) ? json(SETUP, 503) : json({ error: 'Could not save the signature.' }, 500);
  }
  if (oldPath && oldPath !== path) await sb.storage.from('documents').remove([oldPath]); // re-sign replaces the old PNG
  const date = formatPacketDate(sig.signedAt);
  for (const r of (rows || []).filter((r) => (r.kind === 'date' || r.profile_key === 'date') && !r.value_text)) {
    await sb.from('packet_fields').update({ value_text: date, updated_by: a.user.id }).eq('id', r.id).eq('packet_id', a.packet.id);
  }
  const { data: after } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id).order('page').order('field_key');
  return json({ ok: true, date, fields: (after || []).map(toClient) });
}

// Clear signature(s). Body: { fieldId } for one field, or {} for every signed field on the packet.
// Editors only. Removes the stored PNG(s) and the signer/name/date on the field(s).
export async function DELETE(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured.' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!canSign(a.role)) return json({ error: 'Only the owner, dispatcher or management can clear signatures.' }, 403);
  let body = {}; try { body = await req.json(); } catch { /* empty body = all */ }
  const { data: rows, error } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id);
  if (error) return json({ error: 'Could not load fields.' }, 500);
  const targets = (rows || []).filter((r) => r.signature_path && (!body?.fieldId || r.id === String(body.fieldId)));
  if (body?.fieldId && !targets.length) return json({ error: 'That field isn’t signed.' }, 404);
  const paths = targets.map((r) => r.signature_path);
  for (const r of targets) {
    const { error: uErr } = await sb.from('packet_fields').update({ signature_path: null, signer_name: null, signed_at: null, signed_by: null, updated_by: a.user.id, updated_at: new Date().toISOString() })
      .eq('id', r.id).eq('packet_id', a.packet.id);
    if (uErr) return isMissingSchema(uErr) ? json(SETUP, 503) : json({ error: 'Could not clear the signature.' }, 500);
  }
  if (paths.length) await sb.storage.from('documents').remove(paths);
  const { data: after } = await sb.from('packet_fields').select('*').eq('packet_id', a.packet.id).order('page').order('field_key');
  return json({ ok: true, cleared: targets.length, fields: (after || []).map(toClient) });
}
