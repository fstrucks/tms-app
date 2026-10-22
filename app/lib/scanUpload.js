// Upload a scanned PDF through the normal document path: same bucket, same `{uid}/{ts}-{name}`
// path scheme, and a documents row (doc_type from lib/docTypes.js, optional load_id). If the row insert
// fails, the storage object is removed. Returns an error message, or null on success.
export const SCAN_MAX_BYTES = 10 * 1024 * 1024;

// PR #110: the row is saved without a load, then linked through /api/documents/:id/load, which also works for
// team members (documents RLS only lets the uploader link to their OWN loads, so a driver's BOL never linked).
export async function uploadScan(supabase, userId, { file, docType, loadId }, { fetchImpl = (...a) => fetch(...a) } = {}) {
  if (!userId) return 'Please sign in again.';
  if (file.size > SCAN_MAX_BYTES) return 'The PDF is larger than 10 MB.';
  const path = `${userId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file, { contentType: 'application/pdf' });
  if (upErr) { console.error('[scan] upload', upErr); return 'Upload failed: ' + upErr.message; }
  const { data: row, error: dbErr } = await supabase.from('documents').insert({
    user_id: userId, doc_type: docType, file_path: path, original_filename: file.name, load_id: null, truck_id: null,
  }).select('id').single();
  if (dbErr) {
    await supabase.storage.from('documents').remove([path]);
    console.error('[scan] insert', dbErr);
    return 'Saving record failed: ' + dbErr.message;
  }
  // Server check (real PDF, within 10 MB). A failed check removes the file; nothing is linked.
  if (row?.id) {
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetchImpl(`/api/documents/${row.id}/check-pdf`, { method: 'POST', cache: 'no-store', headers: { Authorization: `Bearer ${data?.session?.access_token || ''}` } });
      if (res.status === 422) return (await res.json().catch(() => ({}))).error || 'That file isn’t a PDF.';
    } catch { /* network blip: the file is saved; the bucket and the client check already passed */ }
  }
  if (loadId && row?.id) {
    let msg = null;
    try {
      const { data } = await supabase.auth.getSession();
      const res = await fetchImpl(`/api/documents/${row.id}/load`, { method: 'PATCH', cache: 'no-store', headers: { Authorization: `Bearer ${data?.session?.access_token || ''}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ loadId }) });
      if (!res.ok) msg = (await res.json().catch(() => ({}))).error || 'Couldn’t link it to the load.';
    } catch { msg = 'Couldn’t reach the server to link it to the load.'; }
    // Saved but not linked: say so (it shows on the Documents tab with a "Link to load" picker). Not a failure.
    if (msg) return { saved: true, warning: `Saved, but not linked: ${msg} Link it from the Documents tab.` };
  }
  return null;
}
