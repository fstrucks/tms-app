import { deleteDocument } from './documents.js';
import { isCompanyDocType } from './docTypes.js';
import { MARK_LOAD_EMAIL_RATECONS_RPC } from './handledRatecons.js';

// Delete a load (pick 4A). Order:
//   1) stamp email rate cons on this load (handled_at) while load_id still points here.
//      The function does not delete a file or edit the load. Other documents are not stamped.
//      This is before any unlink, so a missing function does not change expenses or documents.
//   2) unlink expenses and mileage (load_id = null). They are NEVER deleted, whatever the FK says.
//   3) linked documents: unlink (default) or, if opted in, delete row + storage file.
//   4) delete stops, 5) delete the load (0 rows = RLS/not found, reported as failure).
// The stamp runs before the load row is deleted. Clearing load_id first would miss the rows.
// Returns { ok, error, warnings }.
export async function deleteLoad(supabase, loadId, { docs = [], deleteDocs = false } = {}) {
  const warnings = [];
  // Check invoices first so nothing is unlinked or deleted when the load can't be removed.
  const { data: invs, error: iErr } = await supabase.from('invoices').select('id,status,invoice_number').eq('load_id', loadId);
  if (iErr) return { ok: false, error: `Couldn't check invoices: ${iErr.message}` };
  const blocking = (invs || []).filter((i) => !['draft', 'void'].includes(i.status));
  if (blocking.length) return { ok: false, error: `This load has invoice ${blocking.map((i) => i.invoice_number).filter(Boolean).join(', ') || 'records'}. Void it first, then delete the load.` };
  const marked = await supabase.rpc(MARK_LOAD_EMAIL_RATECONS_RPC, { p_load: loadId });
  if (marked?.error) return { ok: false, error: `Couldn't update documents: ${marked.error.message}` };
  for (const table of ['expenses', 'mileage_entries']) {
    const { error } = await supabase.from(table).update({ load_id: null }).eq('load_id', loadId);
    if (error) return { ok: false, error: `Couldn't unlink ${table === 'expenses' ? 'expenses' : 'mileage'}: ${error.message}` };
  }
  if (deleteDocs) {
    // PR #84: company documents (W-9, COI, MC Authority, NOA) are never deleted with a load, only unlinked.
    const company = docs.filter((d) => isCompanyDocType(d.doc_type));
    for (const d of company) {
      const { error } = await supabase.from('documents').update({ load_id: null }).eq('id', d.id);
      if (error) return { ok: false, error: `Couldn't unlink documents: ${error.message}` };
    }
    for (const d of docs.filter((x) => !isCompanyDocType(x.doc_type))) {
      const r = await deleteDocument(supabase, d, 'documents', { missingOk: true });
      if (!r.ok) return { ok: false, error: r.error };
      if (r.fileError) warnings.push(r.fileError);
    }
  } else {
    const { error } = await supabase.from('documents').update({ load_id: null }).eq('load_id', loadId);
    if (error) return { ok: false, error: `Couldn't unlink documents: ${error.message}` };
  }
  const { error: sErr } = await supabase.from('stops').delete().eq('load_id', loadId);
  if (sErr) return { ok: false, error: `Couldn't delete stops: ${sErr.message}` };
  const { data, error } = await supabase.from('loads').delete().eq('id', loadId).select('id');
  if (error) return { ok: false, error: /invoice_locked/.test(error.message || '') ? 'This load still has a finalized invoice. Void it first, then delete the load.' : `Couldn't delete the load: ${error.message}` };
  if (!data || data.length === 0) return { ok: false, error: "Couldn't delete the load (not found or not permitted)." };
  return { ok: true, warnings };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// n = the caller's own documents on this load (the only ones a load delete can delete); team = documents uploaded by
// team members (never deleted here, only unlinked: their rows aren't the owner's, and loads.id → documents.load_id
// is ON DELETE SET NULL). PR #110 QA (c): the prompt says which is which.
// n = your linked documents (incl. company docs: W-9, insurance... which are unlinked, never deleted with a load),
// team = teammates' documents, company = how many of the n are company docs. The confirm text and the "Also delete"
// box use the same numbers (QA Oct 22: the prompt said all n were deleted).
export function loadDeletePrompt(n, deleteDocs, { expenses = 0, mileage = 0 } = {}, team = 0, company = 0) {
  const del = deleteDocs ? Math.max(0, n - company) : 0;
  const kept = [];
  if (n && !deleteDocs) kept.push(plural(n + team, 'document', 'documents'));
  else {
    if (team) kept.push(plural(team, 'team document', 'team documents'));
    if (n && company) kept.push(plural(company, 'company document', 'company documents'));
  }
  if (expenses) kept.push(plural(expenses, 'expense', 'expenses'));
  if (mileage) kept.push(plural(mileage, 'mileage entry', 'mileage entries'));
  const keptText = kept.length ? ` ${kept.length > 1 ? kept.slice(0, -1).join(', ') + ' and ' + kept.at(-1) : kept[0]} will be kept, unlinked.` : '';
  const head = del ? `Delete this load, its stops and ${team ? 'your ' : ''}${plural(del, 'document', 'documents')}?` : 'Delete this load and its stops?';
  return head + keptText;
}
// Text next to the "Also delete" checkbox; null when nothing can be deleted (company docs only).
export function loadDeleteDocsLabel(n, team = 0, company = 0) {
  const del = Math.max(0, n - company);
  if (!del) return null;
  const unlinked = [team && plural(team, 'team document', 'team documents'), company && plural(company, 'company document', 'company documents')].filter(Boolean);
  return `Also delete ${team ? 'your ' : ''}${del} linked document${del === 1 ? '' : 's'}${unlinked.length ? `; ${unlinked.join(' and ')} will be unlinked, not deleted` : ''}`;
}
