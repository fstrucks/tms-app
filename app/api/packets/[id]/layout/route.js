import { serviceClient, packetAccess } from '../../../../lib/packetServer';
import { toClient } from '../../../../lib/packetFieldEdits';
import { processPacket } from '../../../../lib/packetProcess';
import { scoreLayout } from '../../../../lib/packetFingerprint';
import { packetIdentity, nameSuggestions, BANK_KEYS } from '../../../../lib/packetLayoutApply';
import { getLayout, savePacketLayout, applyLayoutToPacket, packetHasLayoutColumns, isLayoutSchemaMissing, LAYOUT_MIGRATION, LAYOUT_MISSING_MSG } from '../../../../lib/packetLayouts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const json = (b, s = 200) => Response.json(b, { status: s, headers: { 'Cache-Control': 'no-store' } });
const unavailable = { available: false, migration: LAYOUT_MIGRATION };
const publicLayout = (l) => l && ({ id: l.id, broker_name: l.broker_name || null, version: l.version, status: l.status, last_used_at: l.last_used_at || null,
  field_count: Array.isArray(l.fields) ? l.fields.length : 0, page_count: l.page_count }); // positions/names stay server-side here

// Banner state for this packet: 'applied' | 'suggested' | 'changed' | 'dismissed' | null.
export function layoutState(packet, layout) {
  if (packet.layout_dismissed_at) return 'dismissed';
  if (!layout || !packet.layout_id) return null;
  if (packet.layout_applied_at) return 'applied';
  const d = scoreLayout(packetIdentity(packet), layout).decision;
  return d === 'changed' ? 'changed' : d === 'suggest' || d === 'apply' ? 'suggested' : null;
}

// GET: any company member (drivers see a view-only banner). Never 500s: no migration → { available:false }.
export async function GET(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!packetHasLayoutColumns(a.packet)) return json(unavailable);
  const got = await getLayout(sb, a.packet.layout_id);
  if (got.missing) return json(unavailable);
  const broker_name = a.packet.broker_name || null;
  if (got.error) return json({ available: true, state: null, broker_name, canEdit: a.canEdit });
  const state = layoutState(a.packet, got.layout);
  // Changed form: how many fresh fields have a label the old layout named (offered as "Use N names from last time").
  const names = state === 'changed' ? nameSuggestions(await rawFields(sb, a.packet.id), got.layout).length : 0;
  return json({ available: true, state, score: a.packet.layout_score ?? null, layout: publicLayout(got.layout), broker_name, names, canEdit: a.canEdit });
}

async function rawFields(sb, packetId) {
  try { const { data } = await sb.from('packet_fields').select('*').eq('packet_id', packetId); return Array.isArray(data) ? data : []; } catch { return []; }
}

async function fieldsOf(sb, packetId) {
  const { data } = await sb.from('packet_fields').select('*').eq('packet_id', packetId).order('page').order('field_key');
  return (data || []).map(toClient);
}

// POST { action: 'dismiss' | 'apply' | 'names' }: owner, dispatcher or management only.
//   names:   (changed form) copy last time's names onto fresh fields whose labels match.
//   dismiss: remove the layout-placed fields (user rows kept), set layout_dismissed_at, re-run detection.
//   apply:   place a suggested layout on the pages it matches.
export async function POST(req, { params, deps } = {}) {
  const sb = deps?.sb || serviceClient();
  if (!sb) return json({ error: 'Storage not configured' }, 503);
  const a = await packetAccess(req, params?.id, { sb, ...(deps || {}) });
  if (a.error) return json({ error: a.error }, a.status);
  if (!a.canEdit) return json({ error: 'Only the owner, dispatcher or management can change the saved layout.' }, 403);
  const body = await req.json().catch(() => ({}));
  const action = body?.action;
  if (action !== 'dismiss' && action !== 'apply' && action !== 'names') return json({ error: 'Unknown action' }, 400);
  const p = a.packet;
  if (!packetHasLayoutColumns(p)) return json({ ...unavailable, error: LAYOUT_MISSING_MSG, setupNeeded: true }, 503);
  if (p.status === 'processing') return json({ error: 'Fields are still being found. Try again in a minute.' }, 409);
  const now = new Date().toISOString();

  if (action === 'dismiss') {
    const del = await sb.from('packet_fields').delete().eq('packet_id', p.id).eq('source', 'layout');
    if (del?.error && !isLayoutSchemaMissing(del.error)) { console.error('[packets] layout dismiss', del.error.code); return json({ error: 'Could not remove the layout fields. Please try again.' }, 500); }
    const up = await savePacketLayout(sb, p.id, { layout_dismissed_at: now, layout_applied_at: null });
    if (up.missing) return json({ ...unavailable, error: LAYOUT_MISSING_MSG, setupNeeded: true }, 503);
    if (up.error) return json({ error: 'Could not update the packet. Please try again.' }, 500);
    const out = await (deps?.process || processPacket)({ sb, packetId: p.id, force: true });
    return json({ ok: true, state: 'dismissed', redetected: !!out && !out.skipped && !out.error, fields: await fieldsOf(sb, p.id) });
  }

  if (!p.layout_id) return json({ error: 'There’s no saved layout to use for this packet.' }, 409);
  if (action === 'names') {
    const got = await getLayout(sb, p.layout_id);
    if (got.missing) return json({ ...unavailable, error: LAYOUT_MISSING_MSG, setupNeeded: true }, 503);
    if (!got.layout || got.layout.owner_id !== p.owner_id) return json({ error: 'That saved layout is no longer available.' }, 409);
    const sug = nameSuggestions(await rawFields(sb, p.id), got.layout);
    let named = 0;
    for (const x of sug) {
      const { error } = await sb.from('packet_fields').update({ profile_key: x.profile_key, updated_at: now, ...(BANK_KEYS.has(x.profile_key) ? { needs_confirm: true } : {}) }).eq('packet_id', p.id).eq('field_key', x.field_key);
      if (error) { console.error('[packets] layout names', error.code); return json({ error: 'Could not copy the names. Please try again.', named, fields: await fieldsOf(sb, p.id) }, 500); }
      named++;
    }
    return json({ ok: true, state: 'changed', named, names: 0, fields: await fieldsOf(sb, p.id) });
  }
  if (p.layout_applied_at) return json({ ok: true, state: 'applied', fields: await fieldsOf(sb, p.id) });
  const got = await getLayout(sb, p.layout_id);
  if (got.missing) return json({ ...unavailable, error: LAYOUT_MISSING_MSG, setupNeeded: true }, 503);
  if (!got.layout || got.layout.owner_id !== p.owner_id || got.layout.status === 'retired') return json({ error: 'That saved layout is no longer available.' }, 409);
  if (!p.fingerprint?.pages?.length) return json({ error: 'Re-run detection on this packet first, then try again.' }, 409);
  const r = await applyLayoutToPacket(sb, { packet: p, layout: got.layout, now });
  if (r.missing) return json({ ...unavailable, error: LAYOUT_MISSING_MSG, setupNeeded: true }, 503);
  if (r.error) return json({ error: r.error }, r.status || 500);
  return json({ ok: true, state: 'applied', placed: r.count, fields: await fieldsOf(sb, p.id) });
}
