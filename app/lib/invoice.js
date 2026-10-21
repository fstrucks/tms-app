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

// Company billing settings form → { patch, nextNumber? } | { error }. The next number is not part of the
// row patch: it goes through set_invoice_next_number() (the counter guard ignores direct updates).
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
  if ('invoice_next_number' in b && b.invoice_next_number !== '' && b.invoice_next_number != null) {
    const n = parseNextNumber(b.invoice_next_number); if (n.error) return { error: n.error };
    return { patch, nextNumber: n.value };
  }
  return { patch };
}

// Next invoice number typed on the Billing card → { value } | { error }. Whole number, 1–99,999,999.
// The database also refuses anything below the highest number already used + 1.
export function parseNextNumber(v) {
  const t = String(v ?? '').trim();
  if (!/^\d{1,8}$/.test(t) || Number(t) < 1) return { error: 'Next invoice number: a whole number like 1001.' };
  return { value: Number(t) };
}

// set_invoice_next_number errors → { status, error, pending? }.
export function nextNumberError(e, prefix = DEFAULT_PREFIX) {
  const m = String(e?.message || '');
  if (e?.code === 'PGRST202' || e?.code === '42883' || /could not find the function|function .*set_invoice_next_number.* does not exist/i.test(m))
    return { status: 409, pending: true, error: 'Changing the next invoice number needs a database update that isn’t applied yet. Your other billing settings saved; the next number is unchanged.' };
  const low = m.match(/next_number_too_low:(\d+)/);
  if (low) return { status: 422, error: `Next invoice number must be at least ${prefix}${low[1]} (numbers already used can’t be reused).` };
  if (/not_allowed/.test(m)) return { status: 403, error: 'Only the owner or Management can change the next invoice number.' };
  if (/next_number_invalid/.test(m)) return { status: 422, error: 'Next invoice number: a whole number like 1001.' };
  return { status: 500, error: 'Couldn’t change the next invoice number. Please try again.' };
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
