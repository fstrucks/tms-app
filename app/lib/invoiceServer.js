// Server side of invoicing. The caller's company role is resolved first (truckCtx → packet_role), then:
//   - invoice / broker / factor rows are read and written with the caller's OWN token (c.uc), so the RLS in
//     20261021000100 (office roles read, owner / management write) is the final guard;
//   - loads, stops and documents are read with the service client, always filtered to the company (user_id = ownerId),
//     same as the load paperwork routes (PR #110).
import { loadDocsCtx, json, UUID } from './loadDocsServer.js';
import { isMissing } from './truckServer.js';
import { canViewInvoices, canEditInvoices } from './invoice.js';

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
