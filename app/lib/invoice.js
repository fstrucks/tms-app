// Invoicing: pure helpers shared by the server routes and the UI (no React, no Supabase). Unit-tested in
// tests/js/invoicing*.test.mjs. Mirrors migration 20261021000100_invoicing.sql:
//   read  = owner / management / dispatcher (office roles); write = owner / management; drivers see nothing.
export const VIEW_ROLES = ['owner', 'management', 'dispatcher'];
export const EDIT_ROLES = ['owner', 'management'];
export const canViewInvoices = (role) => VIEW_ROLES.includes(role);
export const canEditInvoices = (role) => EDIT_ROLES.includes(role);

export const DEFAULT_TERMS_DAYS = 30;
export const DEFAULT_PREFIX = 'INV-';
export const FIRST_NUMBER = 1001;
export const MAX_TERMS_DAYS = 120;
export const PACKET_FORMATS = [{ id: 'merged', label: 'One PDF (all documents merged)' }, { id: 'separate', label: 'Separate PDFs' }];

const EMAIL = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;
const str = (v, max = 500) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };
export const termsLabel = (days) => (Number(days) === 0 ? 'Due on receipt' : `Net ${Number(days)}`);

// "ap@x.com, billing@x.com" or an array → { list } | { error }
export function parseEmails(v) {
  const raw = Array.isArray(v) ? v : String(v ?? '').split(/[\s,;]+/);
  const list = [...new Set(raw.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))];
  const bad = list.find((e) => !EMAIL.test(e));
  if (bad) return { error: `“${bad}” isn’t a valid email address.` };
  if (list.length > 5) return { error: 'Up to 5 billing emails.' };
  return { list };
}

// terms: '' / null = use the company default (null); otherwise whole days 0–120.
export function parseTerms(v, { allowNull = true } = {}) {
  if (v === '' || v == null) return allowNull ? { value: null } : { error: 'Enter payment terms in days, like 30.' };
  const n = Number(String(v).replace(/^net\s*/i, ''));
  if (!Number.isInteger(n) || n < 0 || n > MAX_TERMS_DAYS) return { error: `Payment terms are 0 to ${MAX_TERMS_DAYS} days (Net 30 = 30).` };
  return { value: n };
}

// Broker form → { row } | { error }
export function validateBroker(b = {}) {
  const name = str(b.name, 120);
  if (!name) return { error: 'Broker name is required.' };
  const em = parseEmails(b.billing_emails);
  if (em.error) return { error: em.error };
  const t = parseTerms(b.terms_days);
  if (t.error) return { error: t.error };
  const mc = str(b.mc_number, 20);
  if (mc && !/^(MC-?)?\d{1,8}$/i.test(mc)) return { error: 'MC is digits only (MC- prefix optional).' };
  return { row: { name, mc_number: mc, address: str(b.address, 400), billing_emails: em.list, terms_days: t.value,
    quick_pay_terms: str(b.quick_pay_terms, 200), noa_on_file: b.noa_on_file === true, notes: str(b.notes, 1000) } };
}

// Factor form → { row } | { error }
export function validateFactor(f = {}) {
  const name = str(f.name, 120);
  if (!name) return { error: 'Factoring company name is required.' };
  const se = str(f.submission_email, 200);
  if (se && !EMAIL.test(se)) return { error: 'Submission email isn’t a valid email address.' };
  const url = str(f.portal_url, 300);
  if (url && !/^https:\/\/[^\s]+$/i.test(url)) return { error: 'Portal link must start with https://' };
  const fmt = f.packet_format == null || f.packet_format === '' ? 'merged' : f.packet_format;
  if (!PACKET_FORMATS.some((p) => p.id === fmt)) return { error: 'Pick one PDF or separate PDFs.' };
  return { row: { name, submission_email: se ? se.toLowerCase() : null, portal_url: url, remit_to: str(f.remit_to, 500),
    cutoff_time: str(f.cutoff_time, 40), packet_format: fmt, notes: str(f.notes, 1000) } };
}

// Company billing settings form → { patch } | { error }. The prefix is fixed at INV- for now (Marc's pick);
// the next number is read-only (only finalize moves it).
export function validateBillingSettings(b = {}, factorIds = []) {
  const patch = {};
  if ('default_terms_days' in b) { const t = parseTerms(b.default_terms_days, { allowNull: false }); if (t.error) return { error: t.error }; patch.default_terms_days = t.value; }
  if ('default_factor_id' in b) {
    const id = b.default_factor_id || null;
    if (id && !factorIds.includes(id)) return { error: 'Pick a factoring company from your list.' };
    patch.default_factor_id = id;
  }
  if ('remit_to' in b) patch.remit_to = str(b.remit_to, 500);
  if ('invoice_prefix' in b) { const p = parsePrefix(b.invoice_prefix); if (p.error) return { error: p.error }; patch.invoice_prefix = p.value; }
  return { patch };
}

// Invoice number prefix (Taylor QA #4): letters, digits, - _ / and up to 10 characters; '' → INV-.
export function parsePrefix(v) {
  const t = String(v ?? '').trim();
  if (!t) return { value: DEFAULT_PREFIX };
  if (!/^[A-Za-z0-9_/-]{1,10}$/.test(t)) return { error: 'Prefix: up to 10 letters, numbers, - _ or /, like INV-.' };
  return { value: t };
}

// Billing settings the client sees.
export function publicBilling(p) {
  if (!p) return null;
  return { invoice_prefix: p.invoice_prefix || DEFAULT_PREFIX, invoice_next_number: p.invoice_next_number ?? FIRST_NUMBER,
    default_terms_days: p.default_terms_days ?? DEFAULT_TERMS_DAYS, default_factor_id: p.default_factor_id || null,
    remit_to: p.remit_to || null, has_logo: !!p.logo_path };
}

// Logo upload: PNG or JPEG (the invoice PDF can embed both), up to 1 MB.
export const LOGO_MAX_BYTES = 1024 * 1024;
export function checkLogo({ type, size } = {}) {
  const t = String(type || '').toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/jpg'].includes(t)) return { error: 'Logo must be a PNG or JPG image.' };
  if (!(size > 0)) return { error: 'That file is empty.' };
  if (size > LOGO_MAX_BYTES) return { error: 'Logo must be 1 MB or smaller.' };
  return { ext: t === 'image/png' ? 'png' : 'jpg', contentType: t === 'image/jpg' ? 'image/jpeg' : t };
}

// Postgres error → plain message (P0001 codes raised by the migration's functions / triggers).
const DB_ERRORS = {
  not_allowed: 'Only the owner or Management can do that.', billing_not_allowed: 'Only the owner or Management can change billing settings.',
  not_found: 'Invoice not found.', not_draft: 'This invoice is already finalized.', no_lines: 'Add at least one charge before finalizing.',
  no_company_profile: 'Fill in your company profile first (Account menu → Company).', invoice_locked: 'This invoice is finalized. Void it to make changes.',
  invoice_number_locked: 'Invoice numbers can’t be changed.', invoice_number_reserved: 'Invoice numbers are given when you finalize.',
  invoice_void: 'This invoice was voided.', load_not_in_company: 'Load not found.', broker_not_in_company: 'Pick a broker from your list.',
  factor_not_in_company: 'Pick a factoring company from your list.',
};
export function dbErrorText(e, fallback = 'That didn’t save. Please try again.') {
  if (!e) return null;
  if (e.code === '23505') return /broker/i.test(e.message || '') ? 'You already have a broker with that name.' : /factor/i.test(e.message || '') ? 'You already have a factoring company with that name.' : /load/i.test(e.message || '') ? 'This load already has an invoice.' : 'That name is already in your list.';
  const key = Object.keys(DB_ERRORS).find((k) => String(e.message || '').includes(k));
  return key ? DB_ERRORS[key] : fallback;
}

// ---- Invoice drafts (PR 2) ----
// Billable extras (Marc's pick 6), each its own line after the linehaul.
export const EXTRA_TYPES = [
  { id: 'lumper', label: 'Lumper reimbursement', receipt: 'lumper_receipt' },
  { id: 'detention', label: 'Detention' },
  { id: 'layover', label: 'Layover' },
  { id: 'tonu', label: 'TONU (truck ordered, not used)' },
  { id: 'extra_stop', label: 'Extra stop' },
  { id: 'scale', label: 'Scale fee', receipt: 'scale_ticket' },
];
const LINE_TYPES = new Set(['linehaul', ...EXTRA_TYPES.map((t) => t.id)]);
export const lineLabel = (type) => (type === 'linehaul' ? 'Linehaul' : EXTRA_TYPES.find((t) => t.id === type)?.label || 'Charge');
export const INVOICE_STATUSES = { draft: 'Draft', ready: 'Ready to send', sent: 'Sent', paid: 'Paid', short_paid: 'Short-paid', void: 'Void' };
export const statusLabel = (s) => INVOICE_STATUSES[s] || s || '—';
export const AUTO_DRAFT_STATUSES = ['delivered', 'invoiced', 'paid'];

const cents = (n) => Math.round(Number(n) * 100);
export const money2 = (n) => cents(n) / 100;
export const totalOf = (lines) => (lines || []).reduce((a, l) => a + cents(l.amount || 0), 0) / 100;

// Client line items → { lines } | { error }. Amounts are dollars, 0.01–999,999.99; up to 20 lines.
export function cleanLines(input) {
  if (!Array.isArray(input)) return { error: 'Bad request.' };
  if (input.length > 20) return { error: 'Up to 20 charges per invoice.' };
  const lines = [];
  for (const l of input) {
    const type = String(l?.type || '');
    if (!LINE_TYPES.has(type)) return { error: 'Pick a charge type from the list.' };
    const amt = typeof l.amount === 'string' ? Number(l.amount.replace(/[$,\s]/g, '')) : Number(l.amount);
    if (!isFinite(amt) || amt <= 0 || amt >= 1e6) return { error: `Enter an amount for ${lineLabel(type)}, like 150.00.` };
    if (Math.abs(amt * 100 - Math.round(amt * 100)) > 1e-6) return { error: 'Amounts can have at most 2 decimals.' };
    lines.push({ type, label: lineLabel(type), amount: money2(amt), note: str(l.note, 200) });
  }
  return { lines };
}

// Factoring switch: the load's own on/off, else on when the company has a default factoring company.
export const isFactored = (load, company) => (typeof load?.factored === 'boolean' ? load.factored : !!company?.default_factor_id);
export const termsFor = (broker, company) => (broker?.terms_days ?? company?.default_terms_days ?? DEFAULT_TERMS_DAYS);

export function companyAddress(c) {
  if (!c) return '';
  const cityLine = [c.city, [c.state, c.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [c.address_line1, c.address_line2, cityLine].filter(Boolean).join('\n');
}
export function billToFrom(broker, load) {
  if (broker) return { name: broker.name, mc_number: broker.mc_number || null, address: broker.address || null, emails: broker.billing_emails || [] };
  return { name: load?.broker_name || null, mc_number: null, address: null, emails: [] };
}
export function remitToFor({ factored, factor, company }) {
  if (factored && factor) return [factor.name, factor.remit_to].filter(Boolean).join('\n');
  return company?.remit_to || [company?.legal_name || company?.dba_name, companyAddress(company)].filter(Boolean).join('\n') || null;
}
const stopDate = (s) => (s?.completed_at || s?.appointment_start || null);
export function loadRefFrom(load) {
  const stops = [...(load?.stops || [])].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
  return {
    load_number: load?.broker_load_number || null,
    pickup_numbers: [...new Set(stops.map((s) => s.pickup_number).filter(Boolean))],
    lane: stops.map((s) => ({ type: s.stop_type || 'stop', name: s.company_name || null,
      place: [s.address_line1, [s.city, s.state].filter(Boolean).join(', ')].filter(Boolean).join(', ') || null,
      date: stopDate(s) ? String(stopDate(s)).slice(0, 10) : null })),
    commodity: load?.commodity || null, weight: load?.weight ?? null,
  };
}

// Fields a draft gets from the load + records. Keeps the user's existing extras (and edited linehaul) when refreshing.
export function draftFields({ load, broker, factor, company, existing = null }) {
  const factored = isFactored(load, company);
  const keep = Array.isArray(existing?.line_items) ? existing.line_items : null;
  const lines = keep && keep.length ? keep : (Number(load?.rate) > 0 ? [{ type: 'linehaul', label: 'Linehaul', amount: money2(load.rate), note: null }] : []);
  return {
    broker_id: broker?.id || null, bill_to: billToFrom(broker, load), factored, factor_id: factored ? factor?.id || null : null,
    remit_to: remitToFor({ factored, factor, company }), terms_days: termsFor(broker, company), load_ref: loadRefFrom(load),
    line_items: lines, total: totalOf(lines),
  };
}

// Which broker record a load uses: its broker_id, else a saved broker with the same name (case-insensitive).
export function brokerForLoad(load, brokers = []) {
  if (load?.broker_id) { const b = brokers.find((x) => x.id === load.broker_id); if (b) return b; }
  const n = String(load?.broker_name || '').trim().toLowerCase();
  return n ? brokers.find((x) => String(x.name || '').trim().toLowerCase() === n) || null : null;
}

// Due date (YYYY-MM-DD) for a YYYY-MM-DD invoice date + terms.
export function dueDate(invoiceDate, termsDays) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(invoiceDate || ''))) return null;
  const d = new Date(`${invoiceDate}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + Number(termsDays || 0));
  return d.toISOString().slice(0, 10);
}

// File names (Avery's reference §3): {LOAD}_{Doc}.pdf, e.g. TEST-1001_Invoice.pdf. Safe characters only.
export const DOC_FILE_LABELS = { invoice: 'Invoice', rate_confirmation: 'RateCon', bol: 'BOL', pod: 'POD', lumper_receipt: 'Lumper', scale_ticket: 'Scale', noa: 'NOA', packet: 'Packet', other: 'Other' };
export const fileSafe = (v) => String(v || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
export function invoiceFileName(inv, kind = 'invoice', n = 0) {
  const base = fileSafe(inv?.load_ref?.load_number) || fileSafe(inv?.invoice_number) || 'Invoice';
  const label = DOC_FILE_LABELS[kind] || DOC_FILE_LABELS.other;
  return `${base}_${label}${n > 0 ? `-${n}` : ''}.pdf`;
}

// Load status after invoice steps (Taylor QA #1). An invoice means the work is done, so finalize moves any open load
// (booked / dispatched / in transit / delivered) to Invoiced, and a payment moves it to Paid. Cancelled loads (TONU)
// and loads already further along are left alone. → the new status, or null for "no change".
const LOAD_RANK = { booked: 0, dispatched: 1, in_transit: 2, delivered: 3, invoiced: 4, paid: 5 };
export function loadStatusAfter(step, current) {
  const target = step === 'paid' ? 'paid' : step === 'finalize' ? 'invoiced' : null;
  if (!target || current === 'cancelled' || !(current in LOAD_RANK)) return null;
  return LOAD_RANK[current] < LOAD_RANK[target] ? target : null;
}
const LOAD_LABEL = { invoiced: 'Invoiced', paid: 'Paid' };
// Message tail that only claims what the database confirmed.
export function loadStatusNote(before, after) {
  return after && after !== before && LOAD_LABEL[after] ? ` The load is now ${LOAD_LABEL[after]}.` : '';
}
