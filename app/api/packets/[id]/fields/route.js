import { serviceClient, packetAccess } from '../../../../lib/packetServer';
import { applyEdit, toClient, MAX_FIELDS } from '../../../../lib/packetFieldEdits';
import { encryptField, loadKey, PacketKeyError } from '../../../../lib/packetCrypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s });
const COLS = 'id,field_key,page,kind,label,box,dpi,profile_key,confidence,source,needs_confirm,confirmed_at,value_text,value_ciphertext,value_last4,page_w,page_h';

async function list(sb, packetId) {
  const { data } = await sb.from('packet_fields').select(COLS).eq('packet_id', packetId).order('page').order('field_key');
  return data || [];
}
const pkt = (p) => ({ id: p.id, status: p.status, subject: p.subject, original_filename: p.original_filename, source: p.source, page_count: p.page_count, has_text_layer: p.has_text_layer, manual_reason: p.manual_reason, process_error: p.process_error, created_at: p.created_at });

export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  return json({ packet: pkt(a.packet), role: a.role, canEdit: a.canEdit, fields: (await list(sb, a.packet.id)).map(toClient) });
}

// Body: { upserts: [edit], deletes: [id] }. Editors only. Bank values encrypted here; confirmation enforced.
export async function PATCH(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!a.canEdit) return json({ error: 'Drivers can view packets but not edit fields.' }, 403);
  let body; try { body = await req.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const upserts = Array.isArray(body?.upserts) ? body.upserts : [], deletes = Array.isArray(body?.deletes) ? body.deletes.map(String) : [];
  const existing = await list(sb, a.packet.id);
  const byId = new Map(existing.map((r) => [r.id, r]));
  if (existing.length - deletes.length + upserts.filter((u) => !u.id).length > MAX_FIELDS) return json({ error: 'Too many fields' }, 400);
  let key = null;
  const encrypt = (v) => encryptField(v, key || (key = deps?.key || loadKey()));
  const errors = [];
  try {
    for (const [i, e] of upserts.entries()) {
      const ex = e.id ? byId.get(String(e.id)) : null;
      if (e.id && !ex) { errors.push({ i, error: 'Field not found' }); continue; }
      const r = applyEdit(e, ex, { userId: a.user.id, encrypt, page: e.page_w ? { w: Number(e.page_w), h: Number(e.page_h) } : null });
      if (r.error) { errors.push({ i, id: e.id, error: r.error }); continue; }
      const q = ex ? sb.from('packet_fields').update(r.row).eq('id', ex.id).eq('packet_id', a.packet.id)
        : sb.from('packet_fields').insert({ ...r.row, packet_id: a.packet.id, owner_id: a.packet.owner_id, dpi: 200, confidence: 1 });
      const { error } = await q;
      if (error) errors.push({ i, id: e.id, error: 'Save failed' });
    }
  } catch (e) {
    if (e instanceof PacketKeyError) return json({ error: 'Bank numbers cannot be saved until the encryption key is configured.' }, 503);
    throw e;
  }
  const del = deletes.filter((d) => byId.has(d));
  if (del.length) await sb.from('packet_fields').delete().in('id', del).eq('packet_id', a.packet.id);
  return json({ ok: errors.length === 0, errors, fields: (await list(sb, a.packet.id)).map(toClient) }, errors.length && errors.length === upserts.length && !del.length ? 400 : 200);
}
