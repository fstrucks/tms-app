// Upload a scanned PDF through the normal document path: same bucket, same `{uid}/{ts}-{name}`
// path scheme, and a documents row (doc_type from lib/docTypes.js, optional load_id). If the row insert
// fails, the storage object is removed. Returns an error message, or null on success.
export const SCAN_MAX_BYTES = 10 * 1024 * 1024;

export async function uploadScan(supabase, userId, { file, docType, loadId }) {
  if (!userId) return 'Please sign in again.';
  if (file.size > SCAN_MAX_BYTES) return 'The PDF is larger than 10 MB.';
  const path = `${userId}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const { error: upErr } = await supabase.storage.from('documents').upload(path, file, { contentType: 'application/pdf' });
  if (upErr) { console.error('[scan] upload', upErr); return 'Upload failed: ' + upErr.message; }
  const { error: dbErr } = await supabase.from('documents').insert({
    user_id: userId, doc_type: docType, file_path: path, original_filename: file.name, load_id: loadId || null, truck_id: null,
  });
  if (dbErr) {
    await supabase.storage.from('documents').remove([path]);
    console.error('[scan] insert', dbErr);
    return 'Saving record failed: ' + dbErr.message;
  }
  return null;
}
