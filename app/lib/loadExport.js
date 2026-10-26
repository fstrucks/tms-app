// Load export packet (Marc, Oct 25): on a delivered (or later) load, one PDF with or without an invoice page,
// followed by the load's rate confirmation, BOL and POD. Pure helpers (no Supabase / pdf-lib) so Node tests can
// import them. Download only in this PR; nothing here sends email.
import { canViewInvoices, draftFields, brokerForLoad, fileSafe } from './invoice.js';
import { canBundle } from './invoiceBundle.js';

// Delivered or later. Cancelled, booked, dispatched and in transit loads don't get the button.
export const EXPORT_STATUSES = ['delivered', 'invoiced', 'paid'];
export const canExportStatus = (status) => EXPORT_STATUSES.includes(status);
// Same people who can open invoices: owner, management, dispatcher (company-scoped on the server). Never drivers.
export const canExportRole = (role) => canViewInvoices(role);
export const showExport = (load) => !!load && canExportStatus(load.status) && canExportRole(load.viewer_role ?? 'owner'); // null = the owner's own load (see isLoadOwnerView); the server checks the real role

// Packet order (Marc, Oct 25, second update): invoice, rate con, other chosen docs (BOL, lumper, anything else),
// scale tickets, POD, load pictures, stop times, notes. Within one group, oldest upload first.
export const PHOTO_TYPES = ['load_photo', 'load_picture', 'photo']; // Load pictures upload ships separately; any of these counts
export const DOC_LABELS = { rate_confirmation: 'Rate confirmation', bol: 'BOL', pod: 'POD', lumper_receipt: 'Lumper receipt', scale_ticket: 'Scale ticket', load_photo: 'Load picture', load_picture: 'Load picture', photo: 'Load picture', other: 'Other document' };
export const PACKET_DOC_LABELS = DOC_LABELS;
const groupOf = (t) => (t === 'rate_confirmation' ? 1 : t === 'scale_ticket' ? 3 : t === 'pod' ? 4 : PHOTO_TYPES.includes(t) ? 5 : 2);
// Checked by default when on the load. BOL stays checked too: it was in the agreed packet; lumper and other docs are opt-in.
const DEFAULT_ON = new Set(['rate_confirmation', 'bol', 'scale_ticket', 'pod', ...PHOTO_TYPES]);
export const docLabel = (d) => d?.original_filename || DOC_LABELS[d?.doc_type] || 'Document';
export const hasStopTimes = (load) => (load?.stops || []).some((s) => s.arrived_at || s.completed_at || s.departed_at);
export const NOTE_MAX = 1000;

// The checklist for the Export screen. docs: every company document on the load (invoice-type docs excluded).
export function exportOptions({ load, docs = [] }) {
  const list = (docs || []).filter((d) => d && d.doc_type !== 'invoice')
    .sort((a, b) => groupOf(a.doc_type) - groupOf(b.doc_type) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  return {
    invoice: true,
    docs: list.map((d) => ({ id: d.id, type: d.doc_type, label: DOC_LABELS[d.doc_type] || 'Document', name: d.original_filename || null,
      group: groupOf(d.doc_type), supported: canBundle(d), checked: canBundle(d) && DEFAULT_ON.has(d.doc_type) })),
    stopTimes: { available: (load?.stops || []).length > 0, checked: hasStopTimes(load) },
    loadNotes: { available: !!String(load?.notes || '').trim(), checked: false },
    missing: ['rate_confirmation', 'pod'].filter((t) => !list.some((d) => d.doc_type === t)),
  };
}

// sel: { invoice, docIds:[...], stopTimes, loadNotes, note } → ordered items [{ kind, label, doc? }] and what was refused.
export function planPacket({ load, docs = [], sel = {} }) {
  const opts = exportOptions({ load, docs });
  const want = new Set(sel.docIds || []);
  const byId = new Map((docs || []).map((d) => [d.id, d]));
  const items = [], unsupported = [];
  if (sel.invoice) items.push({ kind: 'invoice', label: 'Invoice' });
  for (const o of opts.docs) {
    if (!want.has(o.id)) continue;
    if (!o.supported) { unsupported.push(o.name || o.label); continue; }
    items.push({ kind: 'doc', label: o.name ? `${o.label}: ${o.name}` : o.label, doc: byId.get(o.id) });
  }
  if (sel.stopTimes && opts.stopTimes.available) items.push({ kind: 'stopTimes', label: 'Stop times' });
  const note = String(sel.note || '').trim().slice(0, NOTE_MAX);
  const loadNotes = sel.loadNotes && opts.loadNotes.available ? String(load.notes).trim() : '';
  if (note || loadNotes) items.push({ kind: 'notes', label: 'Notes', note, loadNotes });
  return { items, unsupported };
}

// Kept for the plain rate con / BOL / POD summary.
export const PACKET_DOC_TYPES = ['rate_confirmation', 'bol', 'pod'];
export function packetDocs(docs = []) {
  const files = [], unreadable = [], missing = [];
  for (const t of PACKET_DOC_TYPES) {
    const mine = (docs || []).filter((d) => d?.doc_type === t).sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    if (!mine.length) { missing.push(t); continue; }
    for (const d of mine) (canBundle(d) ? files : unreadable).push(d);
  }
  return { files, missing, unreadable };
}

export function missingText(missing = []) {
  if (!missing.length) return '';
  const names = missing.map((t) => PACKET_DOC_LABELS[t] || t);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `No ${list} on this load, so ${names.length === 1 ? 'it is' : 'they are'} not in the packet.`;
}

// The invoice page. Reuses the load's own invoice when it has one (its number, lines and terms, exactly as the
// Invoice tab shows it). Otherwise a preview built the same way the auto-draft is (linehaul = load rate, no extras),
// with no number: numbers are only given when an invoice is finalized, so the page prints "DRAFT".
// → an invoices-row-shaped object for invoicePdf().
export function exportInvoice({ load, invoice = null, profile = null, brokers = [], factors = [] }) {
  if (invoice && invoice.status !== 'void') return invoice;
  const broker = brokerForLoad(load, brokers);
  const factor = factors.find((f) => f.id === profile?.default_factor_id) || null;
  return { ...draftFields({ load, broker, factor, company: profile }), id: null, load_id: load?.id || null, status: 'draft', invoice_number: null, invoice_date: null };
}

// {LOAD}_Packet.pdf / {LOAD}_Packet-NoInvoice.pdf (same naming as the invoice bundle).
export function packetFileName(load, withInvoice) {
  const base = fileSafe(load?.broker_load_number) || 'Load';
  return `${base}_Packet${withInvoice ? '' : '-NoInvoice'}.pdf`;
}

// ---- Email (Send step on the Export screen; log in load_packet_sends) ----
// Marc's rule: PODs and invoices go to the broker contact only, never to accounting / AP / billing inboxes.
const ACCOUNTING = /^(accounting|accounts?|ap|ar|billing|invoices?|invoicing|payables?|receivables?|remit|remittance)([._+-]|\d|$)/i;
export const looksLikeAccounting = (email) => ACCOUNTING.test(String(email || '').trim().split('@')[0] || '');
// The first candidate that isn't an accounting address, else ''.
export function prefillRecipient(candidates = []) {
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (const c of candidates || []) { const e = String(c || '').trim().toLowerCase(); if (EMAIL.test(e) && !looksLikeAccounting(e)) return e; }
  return '';
}

// The preview the Export screen (and the email Send step) shows, from exportOptions() output and the checklist.
// Same order as planPacket on the server.
export function previewList(opts, sel = {}) {
  if (!opts) return [];
  const want = new Set(sel.docIds || []);
  const out = [];
  if (sel.invoice) out.push('Invoice');
  for (const o of opts.docs || []) if (want.has(o.id) && o.supported) out.push(o.name ? `${o.label}: ${o.name}` : o.label);
  if (sel.stopTimes && opts.stopTimes?.available) out.push('Stop times');
  if (String(sel.note || '').trim() || (sel.loadNotes && opts.loadNotes?.available)) out.push('Notes');
  return out;
}
export const defaultSelection = (opts) => ({ invoice: true, docIds: (opts?.docs || []).filter((d) => d.checked).map((d) => d.id),
  stopTimes: !!opts?.stopTimes?.checked, loadNotes: false, note: '' });
// Selection → query string for GET ?download=1 (the note rides along; capped at NOTE_MAX).
export const selectionQuery = (sel, tz = '') => new URLSearchParams({ download: '1', invoice: sel.invoice ? '1' : '0', docs: (sel.docIds || []).join(','),
  stopTimes: sel.stopTimes ? '1' : '0', loadNotes: sel.loadNotes ? '1' : '0', note: String(sel.note || '').slice(0, NOTE_MAX), tz }).toString();

// Postmark refuses a message over 10 MB including base64 (≈ 4/3 growth), so the PDF is capped at 7.5 MB raw,
// the same limit the packet Send uses. The PDF is built on the server, so Vercel's 4.5 MB body limit never applies.
export const SEND_MAX_BYTES = 7_500_000;
export const SEND_MIGRATION = '20261025000200_load_packet_sends.sql';
export const accountingRecipients = (list = []) => (list || []).filter(looksLikeAccounting);
export const formatBytes = (n) => (!Number.isFinite(n) ? '' : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`);
// Email text. Plain and short; the note is the user's own words.
export function sendEmailText({ load, companyName, note = '', withInvoice }) {
  const co = String(companyName || '').trim() || 'our company';
  const ref = String(load?.broker_load_number || '').trim();
  const subject = `${ref ? `Load ${ref}` : 'Load'} paperwork${withInvoice ? ' and invoice' : ''} – ${co}`.slice(0, 200);
  const n = String(note || '').trim();
  const body = `Hello,\n\nAttached is the paperwork${withInvoice ? ' and invoice' : ''} for ${ref ? `load ${ref}` : 'this load'}.${n ? `\n\n${n}` : ''}\n\nThank you,\n${co}`;
  return { subject, body };
}
