// Server side of invoicing. The caller's company role is resolved first (truckCtx → packet_role), then:
//   - invoice / broker / factor rows are read and written with the caller's OWN token (c.uc), so the RLS in
//     20261021000100 (office roles read, owner / management write) is the final guard;
//   - loads, stops and documents are read with the service client, always filtered to the company (user_id = ownerId),
//     same as the load paperwork routes (PR #110).
import { loadDocsCtx, json, UUID } from './loadDocsServer.js';
import { isMissing } from './truckServer.js';
import { canViewInvoices, canEditInvoices, draftFields, brokerForLoad, AUTO_DRAFT_STATUSES, publicBilling, loadStatusAfter, remitToFor } from './invoice.js';

export { json, UUID, isMissing };
export const SETUP = { error: 'Invoicing needs a database update that hasn’t been applied yet.', setupNeeded: true };
export const NO_VIEW = { error: 'Invoices are for the owner, Management and Dispatchers.' };
export const NO_EDIT = { error: 'Only the owner or Management can change invoices.' };
export const PROFILE_COLS = 'id,owner_id,legal_name,dba_name,mc_number,dot_number,address_line1,address_line2,city,state,postal_code,phone,email,invoice_prefix,invoice_next_number,default_terms_days,default_factor_id,remit_to,logo_path';

// → { c, svc, db, canEdit } | { res }. edit: true → owner / management only.
export async function billingCtx(req, deps = {}, { edit = false } = {}) {
  const x = await loadDocsCtx(req, deps);
  if (x.res) return x;
  const { c, svc } = x;
  if (!canViewInvoices(c.role)) return { res: json(NO_VIEW, 403) };
  if (edit && !canEditInvoices(c.role)) return { res: json(NO_EDIT, 403) };
  return { c, svc, db: c.uc || svc, canEdit: canEditInvoices(c.role) };
}

export async function readBody(req) { try { const b = await req.json(); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; } }

export async function companyProfile(svc, ownerId) {
  const { data, error } = await svc.from('company_profiles').select(PROFILE_COLS).eq('owner_id', ownerId).maybeSingle();
  return { profile: data || null, error };
}

// ---- PR 2: one load's invoice ----

export async function companyLoadFull(svc, ownerId, loadId) {
  if (!UUID.test(loadId || '')) return { load: null };
  const { data, error } = await svc.from('loads').select('*, stops(*)').eq('id', loadId).eq('user_id', ownerId).maybeSingle();
  return { load: data || null, error };
}

export async function activeInvoice(db, ownerId, loadId) {
  const { data, error } = await db.from('invoices').select('*').eq('owner_id', ownerId).eq('load_id', loadId).order('created_at', { ascending: false });
  if (error) return { error };
  return { invoice: (data || []).find((i) => i.status !== 'void') || null, voided: (data || []).filter((i) => i.status === 'void') };
}

// Everything the Invoice tab needs. Makes the draft when the load is delivered and none exists yet (loads delivered
// before the auto-draft trigger, or when the trigger skipped), but only for owner / management.
export async function invoiceContext(x, loadId, { autoDraft = true } = {}) {
  const { c, svc, db, canEdit } = x;
  const { load, error: lErr } = await companyLoadFull(svc, c.ownerId, loadId);
  if (lErr) return { res: json({ error: 'Couldn’t load this load.' }, 500) };
  if (!load) return { res: json({ error: 'Load not found.' }, 404) };
  const [{ profile, error: pErr }, b, f, inv] = await Promise.all([
    companyProfile(svc, c.ownerId),
    db.from('brokers').select('*').eq('owner_id', c.ownerId).order('name'),
    db.from('factors').select('*').eq('owner_id', c.ownerId).order('name'),
    activeInvoice(db, c.ownerId, load.id),
  ]);
  if ([pErr, b.error, f.error, inv.error].some(isMissing)) return { res: json(SETUP, 409) };
  if (pErr || b.error || f.error || inv.error) return { res: json({ error: 'Couldn’t load the invoice.' }, 500) };
  const brokers = b.data || [], factors = f.data || [];
  const ctx = { load, profile, brokers, factors, invoice: inv.invoice, voided: inv.voided };
  if (!ctx.invoice && autoDraft && canEdit && AUTO_DRAFT_STATUSES.includes(load.status)) {
    const d = await saveDraft(x, ctx, {});
    if (d.res) return d;
    ctx.invoice = d.invoice;
  } else if (ctx.invoice?.status === 'draft' && canEdit) {
    // A saved broker now matches (or the load's broker changed): refresh the draft so its bill-to and terms are the
    // ones that finalize will use (Taylor QA #5: the auto-draft showed Net 30, then finalize switched to Net 15).
    const { broker } = pieces(ctx);
    if ((broker?.id || null) !== (ctx.invoice.broker_id || null)) { const d = await saveDraft(x, ctx, {}); if (!d.res) ctx.invoice = d.invoice; }
  }
  return ctx;
}

export function pieces(ctx) {
  const broker = brokerForLoad(ctx.load, ctx.brokers);
  const factorId = ctx.profile?.default_factor_id || null;
  const factor = ctx.factors.find((f) => f.id === (ctx.invoice?.factor_id || factorId)) || ctx.factors.find((f) => f.id === factorId) || null;
  return { broker, factor };
}

// Create or refresh the draft. patch: { lines?, notes?, terms_days? }. Returns { invoice } | { res }.
export async function saveDraft(x, ctx, patch) {
  const { c, db } = x;
  const { broker, factor } = pieces(ctx);
  const existing = ctx.invoice ? { ...ctx.invoice, ...(patch.lines ? { line_items: patch.lines } : {}) } : (patch.lines ? { line_items: patch.lines } : null);
  const fields = draftFields({ load: ctx.load, broker, factor, company: ctx.profile, existing });
  // Terms (Taylor QA #5): what the draft shows is what gets used. An explicit value wins; otherwise keep the draft's terms
  // unless the broker changed (then the new broker's / company terms). Finalize always keeps the draft's terms.
  if (patch.terms_days != null) fields.terms_days = patch.terms_days;
  else if (ctx.invoice && (patch.keepTerms || (fields.broker_id || null) === (ctx.invoice.broker_id || null))) fields.terms_days = ctx.invoice.terms_days;
  if ('notes' in patch) fields.notes = patch.notes;
  if (ctx.invoice) {
    if (ctx.invoice.status !== 'draft') return { res: json({ error: 'This invoice is finalized. Void it to make changes.' }, 409) };
    const { data, error } = await db.from('invoices').update(fields).eq('id', ctx.invoice.id).eq('owner_id', c.ownerId).select('*').maybeSingle();
    if (error) return { res: isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t save the invoice.' }, 500) };
    if (!data) return { res: json({ error: 'That didn’t save. Please try again.' }, 500) };
    return { invoice: data };
  }
  const { data, error } = await db.from('invoices').insert({ ...fields, owner_id: c.ownerId, load_id: ctx.load.id, status: 'draft', auto_drafted: !patch.lines, created_by: c.user.id }).select('*').single();
  if (error) {
    if (error.code === '23505') { const again = await activeInvoice(db, c.ownerId, ctx.load.id); if (again.invoice) return { invoice: again.invoice }; }
    return { res: isMissing(error) ? json(SETUP, 409) : json({ error: 'Couldn’t start the invoice.' }, 500) };
  }
  await db.from('invoice_events').insert({ invoice_id: data.id, owner_id: c.ownerId, kind: 'drafted', created_by: c.user.id });
  return { invoice: data };
}

export function invoiceResponse(x, ctx) {
  const { broker } = pieces(ctx);
  return {
    canEdit: x.canEdit, invoice: ctx.invoice, voidedCount: ctx.voided?.length || 0,
    load: { id: ctx.load.id, status: ctx.load.status, rate: ctx.load.rate, broker_name: ctx.load.broker_name, broker_load_number: ctx.load.broker_load_number,
      broker_id: ctx.load.broker_id ?? null, factored: typeof ctx.load.factored === 'boolean' ? ctx.load.factored : null },
    matchedBrokerId: broker?.id || null,
    brokers: ctx.brokers.map((b) => ({ id: b.id, name: b.name, billing_emails: b.billing_emails, terms_days: b.terms_days, noa_on_file: b.noa_on_file })),
    factors: ctx.factors.map((f) => ({ id: f.id, name: f.name, submission_email: f.submission_email, portal_url: f.portal_url, packet_format: f.packet_format, remit_to: f.remit_to })),
    settings: publicBilling(ctx.profile), hasProfile: !!ctx.profile,
    remitTo: { own: remitToFor({ factored: false, company: ctx.profile }), factor: remitToFor({ factored: true, factor: ctx.factors.find((f) => f.id === ctx.profile?.default_factor_id) || null, company: ctx.profile }) },
  };
}

// Move the load per loadStatusAfter() with the service client (company-filtered), then read it back.
// → the load's status as saved (unchanged when the rule says so or the write didn't land).
export async function applyLoadStatus(svc, ownerId, load, step) {
  const next = loadStatusAfter(step, load?.status);
  if (!load?.id || !next) return load?.status ?? null;
  const { error } = await svc.from('loads').update({ status: next }).eq('id', load.id).eq('user_id', ownerId).eq('status', load.status);
  if (error) console.error('[invoices] load status', error.code);
  const { data } = await svc.from('loads').select('status').eq('id', load.id).eq('user_id', ownerId).maybeSingle();
  return data?.status ?? load.status;
}

// Company logo bytes for the PDF (null when none or unreadable).
export async function loadLogo(svc, path) {
  if (!path) return null;
  try {
    const { data } = await svc.storage.from('documents').download(path);
    return data ? { bytes: new Uint8Array(await data.arrayBuffer()), type: /\.png$/i.test(path) ? 'image/png' : 'image/jpeg' } : null;
  } catch { return null; }
}
