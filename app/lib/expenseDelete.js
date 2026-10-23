import { deleteDocument } from './documents.js';

// Delete an expense (QA Oct 22): its receipt (documents row + storage file) goes too when no other expense uses it.
// Only receipts are removed: a rate con / BOL picked as the "receipt" stays. Receipt cleanup failures don't undo the
// expense delete; they come back as a warning. Returns { ok, error?, warning? }.
export async function deleteExpense(supabase, expense, bucket = 'documents') {
  const { error } = await supabase.from('expenses').delete().eq('id', expense.id);
  if (error) return { ok: false, error };
  if (!expense.document_id) return { ok: true };
  const { data: others, error: oErr } = await supabase.from('expenses').select('id').eq('document_id', expense.document_id).limit(1);
  if (oErr) return { ok: true, warning: `Couldn't check the receipt: ${oErr.message}` };
  if (others?.length) return { ok: true };
  const { data: doc, error: dErr } = await supabase.from('documents').select('id, doc_type, file_path').eq('id', expense.document_id).maybeSingle();
  if (dErr) return { ok: true, warning: `Couldn't check the receipt: ${dErr.message}` };
  if (!doc || doc.doc_type !== 'receipt') return { ok: true };
  const r = await deleteDocument(supabase, doc, bucket, { missingOk: true });
  if (!r.ok) return { ok: true, warning: r.error };
  return r.fileError ? { ok: true, warning: r.fileError } : { ok: true };
}
