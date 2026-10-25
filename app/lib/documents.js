import { isHandledDoc } from './rateconDrafts';

// Load documents list: the uploader can delete an emailed rate con after its load was deleted
// (handled_at set). Needs attention no longer lists that file. Other people's rows stay put.
export function canDeleteHandledEmailRatecon(doc, viewerId) {
  if (!doc || !viewerId) return false;
  if (doc.user_id !== viewerId) return false;
  if (doc.source !== 'email') return false;
  if (doc.doc_type !== 'rate_confirmation') return false;
  return isHandledDoc(doc);
}

// Same delete as the Docs tab. Never passes missingOk: zero rows is an error, not success.
export async function deleteHandledEmailRatecon(supabase, doc, viewerId) {
  if (!canDeleteHandledEmailRatecon(doc, viewerId)) {
    return { ok: false, error: "Couldn't delete the document (not found or not permitted)." };
  }
  return deleteDocument(supabase, doc, 'documents');
}

// Delete a document: the documents row first, then its storage file.
// Row first so a failed storage remove leaves only an invisible orphan file, never a row pointing at a missing file.
// A linked load is never touched. Returns { ok, error, fileError }.
// opts.missingOk: 0 rows counts as already deleted (used by load delete retries); storage remove is still attempted.
export async function deleteDocument(supabase, doc, bucket = 'documents', { missingOk = false } = {}) {
  const { data, error } = await supabase.from('documents').delete().eq('id', doc.id).select('id');
  if (error) return { ok: false, error: `Couldn't delete the document: ${error.message}` };
  // RLS without a DELETE policy deletes 0 rows and returns no error, so check the count.
  if ((!data || data.length === 0) && !missingOk) return { ok: false, error: "Couldn't delete the document (not found or not permitted)." };
  if (doc.file_path) {
    const { error: sErr } = await supabase.storage.from(bucket).remove([doc.file_path]);
    if (sErr) return { ok: true, fileError: `Document removed, but its file couldn't be deleted from storage: ${sErr.message}` };
  }
  return { ok: true };
}

export function deletePrompt(doc) {
  return doc?.load_id ? 'Delete this document? The linked load is kept.' : 'Delete this document?';
}
