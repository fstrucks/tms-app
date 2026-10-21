// Invoice bundle (invoicing PR 3): what goes with the invoice, in what order, checks before it goes out, and the
// email text to paste. Pure helpers (no Supabase / pdf-lib). Order and names follow Avery's reference
// (powerhaul-knowledge/carrier-invoicing-and-factoring.md §2-§3, §6): invoice, rate con, BOL/POD, receipts.
// v1 sends nothing by email: the user downloads / prints the bundle and marks the invoice as sent.
import { invoiceFileName, termsLabel as fmtTerms } from './invoice.js';
import { MAX_SEND_RAW_BYTES, fmtSize } from './companyDocs.js';

export const BUNDLE_ORDER = ['invoice', 'rate_confirmation', 'bol', 'pod', 'lumper_receipt', 'scale_ticket', 'other', 'noa'];
const kindOf = (docType) => (BUNDLE_ORDER.includes(docType) ? docType : String(docType || '').startsWith('other') ? 'other' : null);
export const isBundleDoc = (d) => !!kindOf(d?.doc_type) && d.doc_type !== 'invoice';
export const isImage = (p) => /\.(jpe?g|png)$/i.test(String(p || ''));
export const isPdf = (p) => /\.pdf$/i.test(String(p || ''));
export const canBundle = (d) => isImage(d?.file_path) || isPdf(d?.file_path);

// docs: load documents [{ id, doc_type, file_path, original_filename, size? }] → ordered file list, invoice first.
export function bundleFiles(invoice, docs = []) {
  const files = [{ kind: 'invoice', docId: null, name: invoiceFileName(invoice, 'invoice'), label: 'Invoice' }];
  const counts = {};
  const sorted = docs.filter(isBundleDoc).sort((a, b) => BUNDLE_ORDER.indexOf(kindOf(a.doc_type)) - BUNDLE_ORDER.indexOf(kindOf(b.doc_type)) || String(a.created_at || '').localeCompare(String(b.created_at || '')));
  const totals = {}; for (const d of sorted) totals[kindOf(d.doc_type)] = (totals[kindOf(d.doc_type)] || 0) + 1;
  for (const d of sorted) {
    const k = kindOf(d.doc_type); counts[k] = (counts[k] || 0) + 1;
    files.push({ kind: k, docId: d.id, name: invoiceFileName(invoice, k, totals[k] > 1 ? counts[k] : 0), label: d.original_filename || k,
      size: d.size ?? null, supported: canBundle(d) });
  }
  return files;
}

// Other invoices on the same load that were actually sent: not this one, not void (Taylor QA retest note a).
export function otherSentNumbers(rows = [], currentId) {
  return (rows || []).filter((i) => i.id !== currentId && i.status !== 'void' && i.invoice_number && i.sent_at).map((i) => i.invoice_number);
}

// Checks before sending (reference §6). level: 'bad' (missing paperwork) | 'warn'. Nothing blocks download.
export function bundleChecks(invoice, docs = [], { otherSent = [] } = {}) {
  const has = (t) => docs.some((d) => d.doc_type === t);
  const lines = invoice?.line_items || [];
  const out = [];
  if (!has('rate_confirmation')) out.push({ level: 'bad', text: 'No rate confirmation on this load.' });
  if (!has('pod') && !has('bol')) out.push({ level: 'bad', text: 'No signed BOL/POD on this load. Most brokers and factors won’t pay without it.' });
  if (lines.some((l) => l.type === 'lumper') && !has('lumper_receipt')) out.push({ level: 'bad', text: 'Lumper is billed but there’s no lumper receipt.' });
  if (lines.some((l) => l.type === 'scale') && !has('scale_ticket')) out.push({ level: 'bad', text: 'Scale fee is billed but there’s no scale ticket.' });
  if (lines.some((l) => l.type === 'detention')) out.push({ level: 'warn', text: 'Detention is billed: make sure the BOL shows in/out times, or attach the broker’s approval.' });
  const linehaul = lines.find((l) => l.type === 'linehaul');
  if (invoice?.load_rate != null && linehaul && Math.round(linehaul.amount * 100) !== Math.round(Number(invoice.load_rate) * 100)) out.push({ level: 'warn', text: 'Linehaul doesn’t match the load’s rate. If the rate changed, attach the broker’s written update.' });
  if (otherSent.length) out.push({ level: 'warn', text: `This load was already invoiced as ${otherSent.join(', ')}. Sending it twice can cause double payment.` });
  if (docs.some((d) => isBundleDoc(d) && !canBundle(d))) out.push({ level: 'warn', text: 'Some files aren’t PDF, JPG or PNG and are left out of the bundle.' });
  return out;
}

export function sizeCheck(files) {
  const raw = files.reduce((a, f) => a + (Number(f.size) || 0), 0);
  return raw > MAX_SEND_RAW_BYTES ? { ok: false, raw, text: `The files add up to ${fmtSize(raw)}, more than most email inboxes take (7.5 MB). Use separate files or the factor’s portal.` } : { ok: true, raw };
}

// Subject + body to paste into an email or portal (reference §3: "Invoice INV-1001 / Load 123456 / Carrier Name").
export function emailText(invoice, company, files = []) {
  const carrier = company?.legal_name || company?.dba_name || '';
  const load = invoice?.load_ref?.load_number || '';
  const subject = [`Invoice ${invoice?.invoice_number || ''}`.trim(), load ? `Load ${load}` : null, carrier || null].filter(Boolean).join(' / ');
  const total = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(invoice?.total) || 0);
  const body = [
    'Hello,', '',
    `Attached is invoice ${invoice?.invoice_number || ''} for load ${load || '(see invoice)'}, total ${total}, ${fmtTerms(invoice?.terms_days)}.`,
    invoice?.factored ? 'Payment for this invoice has been assigned. Please pay only to the remit-to on the invoice.' : null,
    '', 'Attached:', ...files.map((f) => `- ${f.name}`), '',
    'Thank you,', carrier,
    [company?.phone, company?.email].filter(Boolean).join(' | ') || null,
  ].filter((l) => l !== null).join('\n');
  return { subject, body };
}

// Who it's for: the factor's submission email when factored, else the broker's billing emails.
export function recipientFor(invoice, factor) {
  if (invoice?.factored) return factor?.submission_email || (factor?.portal_url ? `Portal: ${factor.portal_url}` : '');
  return (invoice?.bill_to?.emails || []).join(', ');
}

// Status changes after finalize. → { patch, event } | { error }
export function statusChange(invoice, action, body = {}, today = new Date().toISOString().slice(0, 10)) {
  const s = invoice?.status;
  if (!invoice) return { error: 'Invoice not found.' };
  if (s === 'void') return { error: 'This invoice was voided.' };
  if (s === 'draft' && action !== 'void') return { error: 'Finalize the invoice first.' };
  const note = String(body.note ?? '').trim().slice(0, 500) || null;
  if (action === 'mark_sent') {
    const to = String(body.sent_to ?? '').trim().slice(0, 300);
    if (!to) return { error: 'Who did you send it to? Enter the email or portal.' };
    return { patch: { status: ['paid', 'short_paid'].includes(s) ? s : 'sent', sent_at: new Date().toISOString(), sent_to: to }, event: { kind: 'marked_sent', sent_to: to, note, files: Array.isArray(body.files) ? body.files.map(String).slice(0, 20) : [] } };
  }
  if (action === 'paid') {
    const amt = body.paid_amount === '' || body.paid_amount == null ? Number(invoice.total) : Number(String(body.paid_amount).replace(/[$,\s]/g, ''));
    if (!isFinite(amt) || amt < 0 || amt > 1e7) return { error: 'Enter the amount received, like 2,400.00.' };
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.paid_at || '')) ? body.paid_at : today;
    const short = Math.round(amt * 100) < Math.round(Number(invoice.total) * 100);
    return { patch: { status: short ? 'short_paid' : 'paid', paid_amount: Math.round(amt * 100) / 100, paid_at: date }, event: { kind: short ? 'short_paid' : 'paid', note }, loadStatus: 'paid' };
  }
  if (action === 'void') {
    // Short-paid can be voided (e.g. a test invoice, or re-billing the balance); fully paid ones can't.
    if (s === 'paid') return { error: 'Paid invoices can’t be voided.' };
    const reason = String(body.reason ?? '').trim().slice(0, 300);
    if (!reason) return { error: 'Say why it’s being voided (for your records).' };
    return { patch: { status: 'void', void_reason: reason }, event: { kind: 'void', note: reason } };
  }
  if (action === 'log' && ['download', 'print'].includes(body.kind)) return { patch: null, event: { kind: body.kind, files: Array.isArray(body.files) ? body.files.map(String).slice(0, 20) : [] } };
  return { error: 'Bad request.' };
}

// Invoices list tabs (QA #6). Unpaid includes short-paid; the unpaid total is what's still owed.
export const LIST_TABS = [['all', 'All'], ['draft', 'Drafts'], ['unpaid', 'Unpaid'], ['paid', 'Paid'], ['short_paid', 'Short-paid'], ['void', 'Void']];
export const UNPAID_STATUSES = ['ready', 'sent', 'short_paid'];
export function inTab(inv, tab) {
  if (tab === 'all') return true;
  if (tab === 'unpaid') return UNPAID_STATUSES.includes(inv.status);
  return inv.status === tab;
}
export const balanceDue = (inv) => Math.max(0, Math.round((Number(inv.total) || 0) * 100 - (inv.status === 'short_paid' ? Math.round((Number(inv.paid_amount) || 0) * 100) : 0)) / 100);
export function invoiceCounts(list = []) {
  const counts = Object.fromEntries(LIST_TABS.map(([k]) => [k, list.filter((i) => inTab(i, k)).length]));
  const unpaidTotal = list.filter((i) => inTab(i, 'unpaid')).reduce((a, i) => a + Math.round(balanceDue(i) * 100), 0) / 100;
  return { counts, unpaidTotal };
}
