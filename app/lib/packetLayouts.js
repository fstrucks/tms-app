// Carrier packet G: server I/O for remembered broker layouts (service-role client injected).
// Every function degrades when 20261017001900_packet_layouts.sql isn't applied yet: it logs once per call and
// returns { missing: true } so callers fall back to normal detection. Nothing here ever throws to a route.
import { extractPdf } from './packetPdfText.js';
import { fingerprintPacket, extractBrokerMc, pickLayout } from './packetFingerprint.js';
import { layoutRows, packetIdentity, planLearn, dropCovered } from './packetLayoutApply.js';
import { detectBrokerName } from './packetBrokerName.js';

export const LAYOUT_MIGRATION = '20261017001900_packet_layouts.sql';
export const LAYOUT_MISSING_MSG = 'Remembered layouts need a database update that hasn’t been applied yet. Fields are found as usual.';
// Undefined table/column (Postgres or PostgREST schema cache), or the packet_fields.source check not widened yet.
export function isLayoutSchemaMissing(e) {
  if (!e) return false;
  if (['42P01', '42703', 'PGRST204', 'PGRST205', 'PGRST200'].includes(e.code)) return true;
  if (e.code === '23514' && /source/i.test(`${e.message || ''} ${e.details || ''}`)) return true;
  return /column .* does not exist|relation .* does not exist|Could not find the .* (column|table)|packet_layouts/i.test(e.message || '');
}
const logMissing = (where, e) => console.error(`[packets] layouts unavailable (${where}): ${e?.code || ''} apply ${LAYOUT_MIGRATION}`);
// Packet rows are read with select('*'), so a missing column simply isn't a key on the row.
export const packetHasLayoutColumns = (p) => !!p && 'fingerprint' in p && 'layout_id' in p;

// Update the new packets columns. → { ok } | { missing } | { error }
export async function savePacketLayout(sb, packetId, patch) {
  try {
    const { error } = await sb.from('packets').update(patch).eq('id', packetId);
    if (!error) return { ok: true };
    if (isLayoutSchemaMissing(error)) { logMissing('packets update', error); return { missing: true }; }
    console.error('[packets] layout packet update', error.code); return { error: error.code || 'update failed' };
  } catch (e) { console.error('[packets] layout packet update', e?.message); return { error: 'update failed' }; }
}
export async function activeLayouts(sb, ownerId) {
  try {
    const { data, error } = await sb.from('packet_layouts').select('*').eq('owner_id', ownerId).eq('status', 'active').order('last_used_at', { ascending: false });
    if (error) { if (isLayoutSchemaMissing(error)) { logMissing('select', error); return { missing: true }; } console.error('[packets] layouts select', error.code); return { error: error.code || 'select failed' }; }
    return { layouts: Array.isArray(data) ? data : [] };
  } catch (e) { console.error('[packets] layouts select', e?.message); return { error: 'select failed' }; }
}
export async function getLayout(sb, id) {
  if (!id) return { layout: null };
  try {
    const { data, error } = await sb.from('packet_layouts').select('*').eq('id', id).maybeSingle();
    if (error) { if (isLayoutSchemaMissing(error)) { logMissing('get', error); return { missing: true }; } return { error: error.code || 'get failed' }; }
    return { layout: data || null };
  } catch (e) { return { error: e?.message || 'get failed' }; }
}
// Our own company (so our MC / name are never taken for the broker's). select('*'): tolerant of column drift.
export async function ownCompany(sb, ownerId) {
  try {
    const { data } = await sb.from('company_profiles').select('*').eq('owner_id', ownerId).maybeSingle();
    return { mc: data?.mc_number || null, names: [data?.legal_name, data?.dba_name].filter(Boolean) };
  } catch { return { mc: null, names: [] }; }
}
async function ownMc(sb, ownerId) { return (await ownCompany(sb, ownerId)).mc; }
// Fingerprints before v2 have no per-page `head` (needed to spot a revised form from the same broker).
export const needsRefingerprint = (fp) => !fp?.pages?.length || (fp.pages.some((p) => p?.has_text) && !fp.pages.some((p) => p?.head));
// Broker name from the packet text (QA B). Only fills an empty packets.broker_name; a name the user typed wins.
export function brokerNameFor(row, ex, own) {
  if (row?.broker_name && String(row.broker_name).trim()) return { name: String(row.broker_name).trim(), detected: false };
  const name = detectBrokerName(ex?.pages || [], { ownNames: own?.names || [] });
  return { name, detected: !!name };
}
async function packetRow(sb, packetId) {
  try { const { data } = await sb.from('packets').select('*').eq('id', packetId).maybeSingle(); return data || null; } catch { return null; }
}

// During processing, right after extractPdf: fingerprint + broker identity → stored on the packet → best layout.
// → { available:false } | { available:true, fingerprint, identity, dismissed, pick:{layout,result}|null }
export async function prepareLayout(sb, { packetId, ownerId, ex }) {
  try {
    const row = await packetRow(sb, packetId);
    if (row && !packetHasLayoutColumns(row)) { console.error(`[packets] layouts unavailable (packets columns missing): apply ${LAYOUT_MIGRATION}`); return { available: false }; }
    const { fingerprint } = fingerprintPacket(ex);
    const own = await ownCompany(sb, ownerId);
    const broker_mc = extractBrokerMc(ex.pages || [], { ownMc: own.mc });
    const bn = brokerNameFor(row, ex, own);
    const saved = await savePacketLayout(sb, packetId, { fingerprint, broker_mc, layout_id: null, layout_score: null, layout_applied_at: null, ...(bn.detected ? { broker_name: bn.name } : {}) });
    if (!saved.ok) return { available: false };
    const identity = packetIdentity({ fingerprint, broker_mc, broker_email: row?.broker_email, broker_name: bn.name, page_count: ex.pageCount });
    const bnOut = { broker_name: bn.name || null, broker_detected: bn.detected };
    if (row?.layout_dismissed_at) return { available: true, fingerprint, identity, dismissed: true, pick: null, ...bnOut };
    const got = await activeLayouts(sb, ownerId);
    if (!got.layouts) return { available: false, ...bnOut };
    return { available: true, fingerprint, identity, dismissed: false, pick: pickLayout(identity, got.layouts), ...bnOut };
  } catch (e) { console.error('[packets] layout prepare', e?.message); return { available: false }; }
}

export async function bumpLayoutUse(sb, layout) {
  try { await sb.from('packet_layouts').update({ use_count: (layout.use_count || 0) + 1, updated_at: new Date().toISOString() }).eq('id', layout.id); } catch { /* best effort */ }
}

// Insert layout rows. → { ok, count } | { missing } | { error }
export async function insertLayoutRows(sb, rows) {
  if (!rows.length) return { ok: true, count: 0 };
  try {
    const { error } = await sb.from('packet_fields').upsert(rows, { onConflict: 'packet_id,field_key', ignoreDuplicates: true });
    if (!error) return { ok: true, count: rows.length };
    if (isLayoutSchemaMissing(error)) { logMissing('packet_fields insert', error); return { missing: true }; }
    console.error('[packets] layout rows insert', error.code); return { error: error.code || 'insert failed' };
  } catch (e) { return { error: e?.message || 'insert failed' }; }
}

// "Use layout" on a suggested layout (and the shared apply step): rows for matched pages replace the machine-found
// rows on those pages (user rows are kept). → { ok, count, pages } | { missing } | { error, status }
export async function applyLayoutToPacket(sb, { packet, layout, now = new Date().toISOString() }) {
  const lr = layoutRows({ layout, packetFingerprint: packet.fingerprint, packetId: packet.id, ownerId: packet.owner_id });
  const pages = lr.pages;
  if (!lr.rows.length) return { error: 'This saved layout doesn’t match any page of this packet.', status: 409 };
  const rows = dropCovered(lr.rows, await keptRows(sb, packet.id)); // never stack a layout field on a kept one
  const del = await sb.from('packet_fields').delete().eq('packet_id', packet.id).in('source', ['local', 'model', 'layout']).in('page', [...pages]);
  if (del?.error) { if (isLayoutSchemaMissing(del.error)) return { missing: true }; return { error: 'Could not update the fields.', status: 500 }; }
  const ins = await insertLayoutRows(sb, rows);
  if (!ins.ok) return ins.missing ? { missing: true } : { error: 'Could not place the saved layout.', status: 500 };
  const up = await savePacketLayout(sb, packet.id, { layout_id: layout.id, layout_applied_at: now, layout_dismissed_at: null });
  if (up.missing) return { missing: true };
  await bumpLayoutUse(sb, layout);
  return { ok: true, count: rows.length, pages: [...pages] };
}

// User-made or edited rows on a packet (kept across re-runs). [] on any error.
export async function keptRows(sb, packetId) {
  try {
    const { data, error } = await sb.from('packet_fields').select('*').eq('packet_id', packetId).eq('source', 'user');
    return error || !Array.isArray(data) ? [] : data;
  } catch { return []; }
}

// After the Broker field is edited: if no layout is linked (and none was dismissed/applied), look again with the
// new name. Only ever suggests or flags 'changed'; never places fields. → { layout_id, decision } | null
export async function rematchLayout(sb, packet) {
  try {
    if (!packetHasLayoutColumns(packet) || packet.layout_dismissed_at || packet.layout_applied_at || !packet.fingerprint?.pages?.length) return null;
    const got = await activeLayouts(sb, packet.owner_id);
    if (!got.layouts) return null;
    const pick = pickLayout(packetIdentity(packet), got.layouts);
    const layout_id = pick && pick.result.decision !== 'none' ? pick.layout.id : null;
    if ((packet.layout_id || null) === layout_id) return layout_id ? { layout_id, decision: pick.result.decision } : null;
    await savePacketLayout(sb, packet.id, { layout_id, layout_score: pick ? pick.result.score : null });
    return layout_id ? { layout_id, decision: pick.result.decision } : null;
  } catch (e) { console.error('[packets] rematch', e?.message); return null; }
}

// After a successful /fill by an editor: create or version the layout for this packet's form. Never throws.
// pdfBytes lets a packet processed before the migration get its fingerprint now.
export async function learnFromFill(sb, { packet, rows, userId, pdfBytes = null, extract = extractPdf, now = new Date().toISOString() }) {
  try {
    if (!packetHasLayoutColumns(packet)) return { action: 'skip', reason: 'migration_missing' };
    let p = packet;
    if (needsRefingerprint(p.fingerprint) && pdfBytes) { // no fingerprint yet, or a v1 one without page heads
      try {
        const ex = await extract(pdfBytes, { deadline: Date.now() + 8000 });
        const { fingerprint } = fingerprintPacket(ex);
        const own = await ownCompany(sb, p.owner_id);
        const broker_mc = p.broker_mc || extractBrokerMc(ex.pages || [], { ownMc: own.mc });
        const bn = brokerNameFor(p, ex, own);
        p = { ...p, fingerprint, broker_mc, broker_name: bn.name || p.broker_name || null };
        await savePacketLayout(sb, p.id, { fingerprint, broker_mc, ...(bn.detected ? { broker_name: bn.name } : {}) });
      } catch (e) { console.error('[packets] learn fingerprint', e?.message); }
    }
    const got = await activeLayouts(sb, p.owner_id);
    if (got.missing) return { action: 'skip', reason: 'migration_missing' };
    if (!got.layouts) return { action: 'skip', reason: 'error' };
    const key = p.fingerprint?.pages?.length ? packetIdentity(p).layout_key : null;
    const target = key ? got.layouts.find((l) => l.layout_key === key) || null : null;
    const applied = p.layout_id ? got.layouts.find((l) => l.id === p.layout_id) || null : null;
    const plan = planLearn({ packet: p, rows, target, applied });
    if (plan.action === 'skip') return plan;
    if (plan.action === 'touch') {
      // Same fields: refresh use time, and bring an older layout up to date (v2 page heads, the broker's name).
      const patch = { last_used_at: now, updated_at: now };
      if (needsRefingerprint(target.fingerprint) && !needsRefingerprint(p.fingerprint)) patch.fingerprint = { v: p.fingerprint.v || 2, pages: p.fingerprint.pages };
      const bname = p.broker_name && String(p.broker_name).trim();
      if (bname && bname !== target.broker_name) patch.broker_name = bname.slice(0, 120);
      await sb.from('packet_layouts').update(patch).eq('id', target.id);
      return { action: 'touch', layout_id: target.id, version: target.version };
    }
    const row = { owner_id: p.owner_id, layout_key: plan.layout_key, version: plan.version, status: 'active', broker_name: plan.broker_name,
      broker_mc: plan.broker_mc, broker_domain: plan.broker_domain, page_count: plan.page_count, fingerprint: plan.fingerprint, fields: plan.fields,
      source_packet_id: p.id, created_by: userId || null, use_count: target?.use_count || 0, last_used_at: now, created_at: now, updated_at: now };
    if (target) { // one active version per form: supersede first, restore it if the insert fails
      const { error: sErr } = await sb.from('packet_layouts').update({ status: 'superseded', updated_at: now }).eq('id', target.id).eq('status', 'active');
      if (sErr) { console.error('[packets] layout supersede', sErr.code); return { action: 'skip', reason: 'error' }; }
    }
    const { data, error } = await sb.from('packet_layouts').insert(row).select('id,version').single();
    if (error) {
      if (target) await sb.from('packet_layouts').update({ status: 'active' }).eq('id', target.id);
      if (isLayoutSchemaMissing(error)) { logMissing('insert', error); return { action: 'skip', reason: 'migration_missing' }; }
      console.error('[packets] layout insert', error.code); return { action: 'skip', reason: 'error' };
    }
    return { action: plan.action, layout_id: data?.id || null, version: data?.version || plan.version, fields: plan.fields.length };
  } catch (e) { console.error('[packets] learn', e?.message); return { action: 'skip', reason: 'error' }; }
}
