import { deleteDocument } from './documents.js';

// Delete a load (pick 4A). Order:
//   1) unlink expenses and mileage (load_id = null). They are NEVER deleted, whatever the FK says.
//   2) linked documents: unlink (default) or, if opted in, delete row + storage file.
//   3) delete stops, 4) delete the load (0 rows = RLS/not found, reported as failure).
// Returns { ok, error, warnings }.
export async function deleteLoad(supabase, loadId, { docs = [], deleteDocs = false } = {}) {
  const warnings = [];
  for (const table of ['expenses', 'mileage_entries']) {
    const { error } = await supabase.from(table).update({ load_id: null }).eq('load_id', loadId);
    if (error) return { ok: false, error: `Couldn't unlink ${table === 'expenses' ? 'expenses' : 'mileage'}: ${error.message}` };
  }
  if (deleteDocs) {
    for (const d of docs) {
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
  if (error) return { ok: false, error: `Couldn't delete the load: ${error.message}` };
  if (!data || data.length === 0) return { ok: false, error: "Couldn't delete the load (not found or not permitted)." };
  return { ok: true, warnings };
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function loadDeletePrompt(n, deleteDocs, { expenses = 0, mileage = 0 } = {}) {
  const kept = [];
  if (n && !deleteDocs) kept.push(plural(n, 'document', 'documents'));
  if (expenses) kept.push(plural(expenses, 'expense', 'expenses'));
  if (mileage) kept.push(plural(mileage, 'mileage entry', 'mileage entries'));
  const keptText = kept.length ? ` ${kept.length > 1 ? kept.slice(0, -1).join(', ') + ' and ' + kept.at(-1) : kept[0]} will be kept, unlinked.` : '';
  const head = n && deleteDocs ? `Delete this load, its stops and ${plural(n, 'document', 'documents')}?` : 'Delete this load and its stops?';
  return head + keptText;
}
