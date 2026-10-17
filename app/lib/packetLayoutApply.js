// Carrier packet G: PURE helpers that turn a saved layout into packet_fields rows, and filled packet rows into
// a layout's `fields`. Server only (imports packetFingerprint → node:crypto). See docs/design/packet-layout-memory.md.
import { mapPages, layoutKey, normalizeMc, matchDomain } from './packetFingerprint.js';
import { validateNameKey } from './packetFieldNames.js';

export const LAYOUT_DPI = 200;
export const MAX_LAYOUT_FIELDS = 400;
export const MOVE_TOLERANCE_PX = 4;
export const BANK_KEYS = new Set(['bank_routing', 'bank_account']);
const KINDS = new Set(['text', 'checkbox', 'signature', 'date']);
// The ONLY keys a stored layout field may have. Values, ciphertext, last4, signature paths, signer names and
// confirmations are never copied.
export const LAYOUT_FIELD_KEYS = ['page', 'kind', 'label', 'box', 'dpi', 'page_w', 'page_h', 'profile_key'];

const r1 = (v) => Math.round(Number(v) * 10) / 10;
const ptToPx = (pt, dpi = LAYOUT_DPI) => (Number(pt) * dpi) / 72;
// Page size in raster px for a fingerprint page ({w,h} in points).
export const fpPagePx = (fp, dpi = LAYOUT_DPI) => (fp && fp.w && fp.h ? [ptToPx(fp.w, dpi), ptToPx(fp.h, dpi)] : null);

// Packet identity used by scoreLayout/pickLayout.
export function packetIdentity({ fingerprint, broker_mc, broker_email, page_count }) {
  const pages = fingerprint?.pages || [];
  return { fingerprint: { pages }, layout_key: pages.length ? layoutKey(pages) : null, page_count: page_count ?? pages.length,
    broker_mc: normalizeMc(broker_mc), broker_domain: matchDomain(broker_email) };
}

// Layout → packet_fields rows on the packet pages the template maps to (exact text hash, then simhash).
// Boxes are scaled when the packet page size differs slightly. Returns { rows, pages:Set(packet page numbers) }.
export function layoutRows({ layout, packetFingerprint, packetId, ownerId, pageSizes = null }) {
  const tp = layout?.fingerprint?.pages || [], pp = packetFingerprint?.pages || [];
  const { pairs } = mapPages(tp, pp);
  const toPacket = new Map(pairs.map((p) => [p.template + 1, p.packet + 1])); // 1-based pages
  const rows = [], pages = new Set();
  (Array.isArray(layout?.fields) ? layout.fields : []).forEach((f, i) => {
    const page = toPacket.get(Number(f?.page));
    if (!page || !Array.isArray(f.box) || f.box.length !== 4 || !KINDS.has(f.kind)) return;
    const size = pageSizes?.get?.(page) || fpPagePx(pp[page - 1]);
    const fw = Number(f.page_w) || fpPagePx(tp[f.page - 1])?.[0], fh = Number(f.page_h) || fpPagePx(tp[f.page - 1])?.[1];
    const sx = size && fw ? size[0] / fw : 1, sy = size && fh ? size[1] / fh : 1;
    const box = [f.box[0] * sx, f.box[1] * sy, f.box[2] * sx, f.box[3] * sy].map(r1);
    const key = validateNameKey(f.profile_key || null, f.kind).key ?? null;
    pages.add(page);
    rows.push({
      packet_id: packetId, owner_id: ownerId, field_key: `lay-p${page}-${i}`, page, kind: f.kind, label: f.label ? String(f.label).slice(0, 200) : null,
      box, dpi: LAYOUT_DPI, page_w: size ? r1(size[0]) : null, page_h: size ? r1(size[1]) : null,
      profile_key: key, confidence: 1, source: 'layout', needs_confirm: BANK_KEYS.has(key), // bank numbers are confirmed on every packet
    });
  });
  return { rows, pages };
}

// Filled packet rows (DB shape, may hold values) → layout `fields`. Whitelist copy: positions + names only.
export function layoutFieldsFromRows(rows = [], packetFingerprint = null) {
  const out = [];
  for (const r of rows) {
    if (out.length >= MAX_LAYOUT_FIELDS) break;
    if (!r || !KINDS.has(r.kind) || !Array.isArray(r.box) || r.box.length !== 4 || r.box.some((v) => !Number.isFinite(Number(v)))) continue;
    const page = Math.trunc(Number(r.page));
    if (!(page >= 1 && page <= 200)) continue;
    const nk = validateNameKey(r.profile_key || null, r.kind);
    const size = r.page_w && r.page_h ? [Number(r.page_w), Number(r.page_h)] : fpPagePx(packetFingerprint?.pages?.[page - 1]);
    out.push({
      page, kind: r.kind, label: r.label ? String(r.label).slice(0, 200) : null, box: r.box.map(r1), dpi: Number(r.dpi) || LAYOUT_DPI,
      page_w: size ? r1(size[0]) : null, page_h: size ? r1(size[1]) : null, profile_key: nk.error ? null : nk.key ?? null, // custom:/skip kept
    });
  }
  return out.sort((a, b) => a.page - b.page || a.box[1] - b.box[1] || a.box[0] - b.box[0]);
}

// True when the fields differ: added/removed, name/kind/label changed, or a box moved more than 4 px.
export function layoutChanged(oldFields = [], newFields = [], tol = MOVE_TOLERANCE_PX) {
  if (oldFields.length !== newFields.length) return true;
  const left = [...oldFields];
  for (const n of newFields) {
    const i = left.findIndex((o) => o.page === n.page && o.kind === n.kind && (o.profile_key || null) === (n.profile_key || null)
      && (o.label || null) === (n.label || null) && o.box.every((v, k) => Math.abs(v - n.box[k]) <= tol));
    if (i < 0) return true;
    left.splice(i, 1);
  }
  return false;
}

// What to do with the company's layouts after an editor fills a packet.
// target = the active layout for THIS packet's layout_key (so the same form always versions one group);
// a packet applied from a different (fuzzy) group gets a new group for its own key. The old group stays active.
// → { action: 'skip'|'create'|'version'|'touch', reason?, fields?, layout_key?, version?, broker_name? }
export function planLearn({ packet, rows, target = null, applied = null }) {
  const fp = packet?.fingerprint;
  if (!fp?.pages?.length) return { action: 'skip', reason: 'no_fingerprint' };
  if (!fp.pages.some((p) => p.has_text)) return { action: 'skip', reason: 'scanned' }; // scans: suggest-only v1, never learned
  const fields = layoutFieldsFromRows(rows, fp);
  if (!fields.length) return { action: 'skip', reason: 'no_fields' };
  const key = layoutKey(fp.pages);
  const mc = normalizeMc(packet.broker_mc), domain = matchDomain(packet.broker_email);
  const broker_name = target?.broker_name || applied?.broker_name || packet.broker_name || domain || (mc ? `MC ${mc}` : null);
  const common = { layout_key: key, fields, broker_name, broker_mc: mc || normalizeMc(target?.broker_mc) || null, broker_domain: domain || target?.broker_domain || null, page_count: fp.pages.length, fingerprint: { v: fp.v || 1, pages: fp.pages } };
  if (!target) return { action: 'create', version: 1, ...common };
  if (layoutChanged(target.fields || [], fields)) return { action: 'version', version: (target.version || 1) + 1, ...common };
  return { action: 'touch' };
}
