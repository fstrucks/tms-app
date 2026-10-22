import { deleteDocument } from './documents.js';
import { isCompanyDocType } from './docTypes.js';

// Delete a load (pick 4A). Order:
//   1) unlink expenses and mileage (load_id = null). They are NEVER deleted, whatever the FK says.
//   2) linked documents: unlink (default) or, if opted in, delete row + storage file.
//   3) delete stops, 4) delete the load (0 rows = RLS/not found, reported as failure).
// Returns { ok, error, warnings }.
export async function deleteLoad(supabase, loadId, { docs = [], deleteDocs = false } = {}) {
  const warnings = [];
  // Check invoices first so nothing is unlinked or deleted when the load can't be removed.
  const { data: invs, error: iErr } = await supabase.from('invoices').select('id,status,invoice_number').eq('load_id', loadId);
  if (iErr) return { ok: false, error: `Couldn't check invoices: ${iErr.message}` };
  const blocking = (invs || []).filter((i) => !['draft', 'void'].includes(i.status));
  if (blocking.length) return { ok: false, error: `This load has invoice ${blocking.map((i) => i.invoice_number).filter(Boolean).join(', ') || 'records'}. Void it first, then delete the load.` };
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
export function loadDeletePrompt(n, deleteDocs, { expenses = 0, mileage = 0 } = {}, team = 0) {
  const kept = [];
  if (n && !deleteDocs) kept.push(plural(n + team, 'document', 'documents'));
  else if (team) kept.push(plural(team, 'team document', 'team documents'));
  if (expenses) kept.push(plural(expenses, 'expense', 'expenses'));
  if (mileage) kept.push(plural(mileage, 'mileage entry', 'mileage entries'));
  if (!n && team && !kept.some((k) => k.includes('team'))) kept.unshift(plural(team, 'team document', 'team documents'));
  const keptText = kept.length ? ` ${kept.length > 1 ? kept.slice(0, -1).join(', ') + ' and ' + kept.at(-1) : kept[0]} will be kept, unlinked.` : '';
  const head = n && deleteDocs ? `Delete this load, its stops and ${team ? 'your ' : ''}${plural(n, 'document', 'documents')}?` : 'Delete this load and its stops?';
  return head + keptText;
}
