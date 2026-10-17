import { serviceClient, packetAccess, isMissingSchema, MISSING_MSG, MIGRATION } from '../../../../lib/packetServer';
import { applyEdit, toClient, MAX_FIELDS } from '../../../../lib/packetFieldEdits';
import { encryptField, loadKey, PacketKeyError } from '../../../../lib/packetCrypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const json = (b, s = 200) => Response.json(b, { status: s });
// '*' so signature columns (20261016001600) show up once applied without breaking the page before then; toClient strips secrets.
const COLS = '*';

async function list(sb, packetId) {
  const { data, error } = await sb.from('packet_fields').select(COLS).eq('packet_id', packetId).order('page').order('field_key');
  if (error) { const e = new Error(error.message); e.db = error; throw e; }
  return data || [];
}
export const pkt = (p) => ({ id: p.id, status: p.status, subject: p.subject, original_filename: p.original_filename, source: p.source, page_count: p.page_count ?? null, has_text_layer: p.has_text_layer ?? null, manual_reason: p.manual_reason ?? null, process_error: p.process_error ?? null, created_at: p.created_at, filled_at: p.filled_at ?? null, sent_at: p.sent_at ?? null,
  // Broker field + remembered-layout banner refresh (carrier packet G). Optional columns read as null when absent.
  broker_name: p.broker_name ?? null, processed_at: p.processed_at ?? null, layout_id: p.layout_id ?? null,
  layout_applied_at: p.layout_applied_at ?? null, layout_dismissed_at: p.layout_dismissed_at ?? null });

// Never lets an unexpected error escape as an HTML 500: the page always gets JSON it can show.
export async function GET(req, ctx = {}) {
  try { return await getFields(req, ctx); } catch (e) {
    console.error('[packets] fields GET', String(e?.message || e).slice(0, 200));
    return json({ error: 'Couldn’t load this packet’s fields. Try again.', retry: true }, 500);
  }
}
async function getFields(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  let rows;
  try { rows = await list(sb, a.packet.id); } catch (e) {
    if (isMissingSchema(e.db)) return json({ packet: pkt(a.packet), role: a.role, canEdit: false, fields: [], setupNeeded: true, error: MISSING_MSG, migration: MIGRATION }, 200);
    console.error('[packets] fields', e.db?.code); return json({ error: 'Could not load fields.' }, 500);
  }
  return json({ packet: pkt(a.packet), role: a.role, canEdit: a.canEdit, fields: rows.map(toClient) });
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
  let existing;
  try { existing = await list(sb, a.packet.id); } catch (e) {
    return isMissingSchema(e.db) ? json({ error: MISSING_MSG, migration: MIGRATION }, 503) : json({ error: 'Could not load fields.' }, 500);
  }
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
