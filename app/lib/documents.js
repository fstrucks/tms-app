// Delete a document: the documents row first, then its storage file.
// Row first so a failed storage remove leaves only an invisible orphan file, never a row pointing at a missing file.
// A linked load is never touched. Returns { ok, error, fileError }.
export async function deleteDocument(supabase, doc, bucket = 'documents') {
  const { data, error } = await supabase.from('documents').delete().eq('id', doc.id).select('id');
  if (error) return { ok: false, error: `Couldn't delete the document: ${error.message}` };
  // RLS without a DELETE policy deletes 0 rows and returns no error, so check the count.
  if (!data || data.length === 0) return { ok: false, error: "Couldn't delete the document (not found or not permitted)." };
  if (doc.file_path) {
    const { error: sErr } = await supabase.storage.from(bucket).remove([doc.file_path]);
    if (sErr) return { ok: true, fileError: `Document removed, but its file couldn't be deleted from storage: ${sErr.message}` };
  }
  return { ok: true };
}

export function deletePrompt(doc) {
  return doc?.load_id ? 'Delete this document? The linked load is kept.' : 'Delete this document?';
}
