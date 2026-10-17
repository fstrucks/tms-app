// Carrier packet G: PURE helpers that turn a saved layout into packet_fields rows, and filled packet rows into
// a layout's `fields`. Server only (imports packetFingerprint → node:crypto). See docs/design/packet-layout-memory.md.
import { mapPages, layoutKey, normalizeMc, matchDomain, normalizeText } from './packetFingerprint.js';
import { validateNameKey } from './packetFieldNames.js';
import { canonicalLabel, labelSimilarity, FUZZY_LABEL, ruleKeyFor } from './packetLabelRules.js';

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
export function packetIdentity({ fingerprint, broker_mc, broker_email, broker_name, page_count }) {
  const pages = fingerprint?.pages || [];
  return { fingerprint: { pages }, layout_key: pages.length ? layoutKey(pages) : null, page_count: page_count ?? pages.length,
    broker_mc: normalizeMc(broker_mc), broker_domain: matchDomain(broker_email), broker_name: broker_name ? String(broker_name).trim() || null : null };
}

// ---------- spots already covered by a kept field (QA C) ----------
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
export function boxOverlap(a, b) {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy, ua = area(a) + area(b) - inter, small = Math.min(area(a), area(b));
  return { iou: ua > 0 ? inter / ua : 0, cover: small > 0 ? inter / small : 0 };
}
export const IOU_COVERED = 0.3, COVER_COVERED = 0.6;
// Kept box in the candidate's pixel space (rows may come from a different render size).
function inSpace(box, from, to) {
  const fw = Number(from?.page_w), fh = Number(from?.page_h), tw = Number(to?.page_w), th = Number(to?.page_h);
  if (!(fw > 0 && fh > 0 && tw > 0 && th > 0)) return box.map(Number);
  return [box[0] * tw / fw, box[1] * th / fh, box[2] * tw / fw, box[3] * th / fh];
}
// True when `row` sits on a spot one of `kept` already covers (same page; IoU ≥ 0.3, or ≥ 60% of the smaller box).
export function isCovered(row, kept = [], { iou = IOU_COVERED, cover = COVER_COVERED } = {}) {
  if (!Array.isArray(row?.box) || row.box.length !== 4) return false;
  return kept.some((k) => k && Number(k.page) === Number(row.page) && Array.isArray(k.box) && k.box.length === 4 && (() => {
    const o = boxOverlap(row.box.map(Number), inSpace(k.box, k, row));
    return o.iou >= iou || o.cover >= cover;
  })());
}
// Fresh detection / layout rows minus every spot a kept (user-made or edited, incl. "Left blank") field covers.
export const dropCovered = (rows = [], kept = [], opts) => (kept.length ? rows.filter((r) => !isCovered(r, kept, opts)) : rows);

// ---------- names from last time (QA A, r3) ----------
// "Carrier name:" → "carrier name". Labels that normalize to nothing never match.
export const labelKey = (s) => normalizeText(s) || null;
// Match the fresh fields of a changed form to the old layout's named fields, in three passes:
//   1. same label after normalizing (case, punctuation, trailing colon, "#"/"No."/"Number", plurals, E-mail/Tel.);
//   2. fuzzy label (word overlap / near-identical spelling ≥ 0.6, one clear best match);
//   3. meaning: the label clearly means a name the old layout used ("Truck unit #" → truck_number).
// Same field kind only; an old label used for two different names is ambiguous and skipped; each old field is used
// once. User-made/edited rows are never touched. → { matched:[{ id, field_key, label, profile_key, current, how }], toCopy }
export function labelMatches(fields = [], layout = null) {
  const old = [];
  const byCanon = new Map();
  for (const f of Array.isArray(layout?.fields) ? layout.fields : []) {
    const nk = f?.profile_key ? validateNameKey(f.profile_key, f.kind) : null;
    if (!nk || nk.error || !nk.key) continue;
    const c = canonicalLabel(f.label);
    const o = { kind: f.kind, label: f.label || '', canon: c, key: nk.key };
    old.push(o);
    if (c) { const k = `${f.kind}|${c}`; byCanon.set(k, byCanon.has(k) && byCanon.get(k) !== nk.key ? null : nk.key); }
  }
  const usable = old.filter((o) => !o.canon || byCanon.get(`${o.kind}|${o.canon}`) !== null);
  const fresh = (fields || []).filter((r) => r && r.source !== 'user' && r.source !== 'layout');
  const used = new Set(), done = new Set(), matched = [];
  const take = (r, o, how) => { used.add(o); done.add(r); matched.push({ id: r.id, field_key: r.field_key, label: r.label, profile_key: o.key, current: r.profile_key || null, how }); };
  for (const r of fresh) { // 1. exact (normalized)
    const c = canonicalLabel(r.label); if (!c) continue;
    const o = usable.find((x) => !used.has(x) && x.kind === r.kind && x.canon === c);
    if (o) take(r, o, 'label');
  }
  for (const r of fresh) { // 2. fuzzy, one clear best
    if (done.has(r) || !canonicalLabel(r.label)) continue;
    const sc = usable.filter((x) => !used.has(x) && x.kind === r.kind && x.canon).map((x) => ({ x, s: labelSimilarity(r.label, x.label) })).filter((y) => y.s >= FUZZY_LABEL).sort((a, b) => b.s - a.s);
    if (sc.length && (sc.length === 1 || sc[0].s - sc[1].s >= 0.15)) take(r, sc[0].x, 'fuzzy');
  }
  for (const r of fresh) { // 3. meaning
    if (done.has(r)) continue;
    const k = ruleKeyFor(r.label); if (!k) continue;
    const os = usable.filter((x) => !used.has(x) && x.kind === r.kind && x.key === k);
    if (os.length >= 1) take(r, os[0], 'meaning');
  }
  return { matched, toCopy: matched.filter((m) => m.profile_key !== m.current) };
}
// Back-compat: just the fields whose name would change.
export const nameSuggestions = (fields = [], layout = null) => labelMatches(fields, layout).toCopy;

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
  // The packet's Broker field (detected or typed by the user) wins over what an older layout version said.
  const pname = packet.broker_name && String(packet.broker_name).trim() ? String(packet.broker_name).trim().slice(0, 120) : null;
  const broker_name = pname || target?.broker_name || applied?.broker_name || domain || (mc ? `MC ${mc}` : null);
  const common = { layout_key: key, fields, broker_name, broker_mc: mc || normalizeMc(target?.broker_mc) || null, broker_domain: domain || target?.broker_domain || null, page_count: fp.pages.length, fingerprint: { v: fp.v || 1, pages: fp.pages } };
  if (!target) return { action: 'create', version: 1, ...common };
  if (layoutChanged(target.fields || [], fields)) return { action: 'version', version: (target.version || 1) + 1, ...common };
  return { action: 'touch' };
}
